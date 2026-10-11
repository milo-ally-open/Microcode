import {
  BACKGROUND_CONTEXT,
  generateSummary,
  shouldCompact,
  DEFAULT_COMPACTION_SETTINGS,
  type CompactionSettings,
  type AgentMessage,
} from '@earendil-works/pi-agent-core'
import type { Model, Models } from '@earendil-works/pi-ai'
import { estimateMessagesTokens } from './TokenEstimator.ts'
import { getCompactUserSummaryMessage } from './compactPrompt.ts'
import { TOOL_NAME as BASH_TOOL_NAME } from '../tools/BashTool/BashTool.ts'
import { TOOL_NAME as READ_TOOL_NAME } from '../tools/FileReadTool/FileReadTool.ts'
import { TOOL_NAME as WRITE_TOOL_NAME } from '../tools/FileWriteTool/FileWriteTool.ts'
import { TOOL_NAME as EDIT_TOOL_NAME } from '../tools/FileEditTool/FileEditTool.ts'
import { TOOL_NAME as VISION_TOOL_NAME } from '../tools/VisionTool/VisionTool.ts'

export interface CompactionProgress {
  phase:
    | 'microcompact'
    | 'analyzing'
    | 'summarizing'
    | 'validating'
    | 'persisting'
    | 'committing'
    | 'done'
  message: string
  tokensBefore?: number
  tokensAfter?: number
  progress?: number
  elapsedMs?: number
  processedUnits?: number
  totalUnits?: number
}

export interface ContextCompactionResult {
  summary: string
  messages: AgentMessage[]
  tokensBefore: number
  tokensAfter: number
  keptMessageCount: number
  automatic: boolean
}

const CLEARED_MESSAGE = '[Old tool result content cleared]'

// Tool names whose results are eligible for microcompact (must match registered names in tools/*/index.ts)
const COMPACTABLE_TOOL_NAMES = new Set([
  BASH_TOOL_NAME,
  READ_TOOL_NAME,
  WRITE_TOOL_NAME,
  EDIT_TOOL_NAME,
  VISION_TOOL_NAME,
])

// Keep the last N tool results of each type
const KEEP_RECENT_TOOLS = 3
const RECENT_CONTEXT_RATIO = 0.1
const RECENT_HISTORY_RATIO = 0.2

interface ConversationUnit {
  messages: AgentMessage[]
  tokens: number
  safeToRetain: boolean
}

function getToolCallIds(message: AgentMessage): string[] {
  if (message.role !== 'assistant') return []
  return message.content
    .filter((block) => block.type === 'toolCall')
    .map((block) => block.id)
}

function stringifyMalformedUnit(messages: readonly AgentMessage[]): string {
  return messages.map((message) => {
    if (message.role === 'toolResult') {
      const content = message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
      return `Tool result ${message.toolName} (${message.toolCallId}): ${content}`
    }
    if (message.role === 'assistant') {
      const calls = message.content
        .filter((block) => block.type === 'toolCall')
        .map((block) => `${block.name}(${JSON.stringify(block.arguments)})`)
      return `Assistant requested tools: ${calls.join(', ')}`
    }
    return `${message.role}: ${JSON.stringify(message)}`
  }).join('\n')
}

export function buildConversationUnits(
  messages: readonly AgentMessage[],
): ConversationUnit[] {
  const units: ConversationUnit[] = []
  for (let index = 0; index < messages.length;) {
    const message = messages[index]!
    const toolCallIds = getToolCallIds(message)
    if (toolCallIds.length === 0) {
      units.push({
        messages: [message],
        tokens: estimateMessagesTokens([message]),
        safeToRetain: message.role !== 'toolResult',
      })
      index++
      continue
    }

    const unitMessages: AgentMessage[] = [message]
    const resultIds = new Set<string>()
    let cursor = index + 1
    while (cursor < messages.length && messages[cursor]!.role === 'toolResult') {
      const result = messages[cursor]!
      if (result.role !== 'toolResult') break
      unitMessages.push(result)
      resultIds.add(result.toolCallId)
      cursor++
    }
    const expectedIds = new Set(toolCallIds)
    units.push({
      messages: unitMessages,
      tokens: estimateMessagesTokens(unitMessages),
      safeToRetain:
        unitMessages.length - 1 === expectedIds.size &&
        resultIds.size === expectedIds.size &&
        [...resultIds].every((id) => expectedIds.has(id)),
    })
    index = cursor
  }
  return units
}

function normalizeSummaryMessages(units: readonly ConversationUnit[]): AgentMessage[] {
  return units.flatMap((unit) => {
    if (unit.safeToRetain) return unit.messages
    return [{
      role: 'user' as const,
      content:
        '[Malformed tool interaction preserved as text for summarization]\n' +
        stringifyMalformedUnit(unit.messages),
      timestamp: unit.messages[0]?.timestamp ?? Date.now(),
    }]
  })
}

function selectCompactionRanges(
  units: readonly ConversationUnit[],
  contextWindow: number,
  tokensBefore: number,
): { summaryUnits: ConversationUnit[]; recentUnits: ConversationUnit[] } {
  const recentBudget = Math.max(
    1,
    Math.min(
      Math.floor(contextWindow * RECENT_CONTEXT_RATIO),
      Math.floor(tokensBefore * RECENT_HISTORY_RATIO),
    ),
  )
  let recentTokens = 0
  let start = units.length
  for (let index = units.length - 1; index >= 0; index--) {
    const unit = units[index]!
    if (!unit.safeToRetain) break
    if (start < units.length && recentTokens + unit.tokens > recentBudget) break
    if (index === 0 && units.length > 1) break
    start = index
    recentTokens += unit.tokens
  }
  return {
    summaryUnits: units.slice(0, start),
    recentUnits: units.slice(start),
  }
}

/** Rebuild the active context for sessions compacted before checkpoints existed. */
export function restoreLegacyCompactionContext(
  messages: readonly AgentMessage[],
  contextWindow: number,
  tokensBefore: number,
  summary: string,
  timestamp: number,
): AgentMessage[] {
  const { recentUnits } = selectCompactionRanges(
    buildConversationUnits(messages),
    contextWindow,
    tokensBefore,
  )
  return [
    {
      role: 'user',
      content: getCompactUserSummaryMessage(summary),
      timestamp,
    },
    ...recentUnits.flatMap((unit) => unit.messages),
  ]
}

export function validateToolMessagePairs(
  messages: readonly AgentMessage[],
): { valid: true } | { valid: false; error: string } {
  const units = buildConversationUnits(messages)
  const invalidIndex = units.findIndex((unit) => !unit.safeToRetain)
  return invalidIndex < 0
    ? { valid: true }
    : {
        valid: false,
        error: `Invalid tool-call/result pairing in conversation unit ${invalidIndex + 1}.`,
      }
}

/**
 * Manages context compression in three layers:
 * 1. Microcompact: Clear old tool results (cheap, no LLM call)
 * 2. Auto-compact: LLM-powered summary when context window fills
 * 3. Manual /compact: User-triggered compaction
 */
export class CompactionManager {
  private model: Model<any>
  private models: Models
  private apiKey: string
  private settings: CompactionSettings
  private onProgress?: (progress: CompactionProgress) => void
  private compacting = false
  private systemPromptTokens = 0
  private generateSummaryFn: typeof generateSummary
  private progressStartedAt = 0

  constructor(options: {
    model: Model<any>
    models: Models
    apiKey: string
    settings?: Partial<CompactionSettings>
    onProgress?: (progress: CompactionProgress) => void
    generateSummaryFn?: typeof generateSummary
  }) {
    this.model = options.model
    this.models = options.models
    this.apiKey = options.apiKey
    this.settings = { ...DEFAULT_COMPACTION_SETTINGS, ...options.settings }
    this.onProgress = options.onProgress
    this.generateSummaryFn = options.generateSummaryFn ?? generateSummary
  }

  reportProgress(progress: CompactionProgress): void {
    this.onProgress?.({
      ...progress,
      elapsedMs:
        progress.elapsedMs ?? Math.max(0, Date.now() - this.progressStartedAt),
    })
  }

  private emitProgress(
    progress: Omit<CompactionProgress, 'elapsedMs'>,
  ): void {
    this.onProgress?.({
      ...progress,
      elapsedMs: Math.max(0, Date.now() - this.progressStartedAt),
    })
  }

  /**
   * Update system prompt token estimate (called when prompt changes).
   */
  setSystemPrompt(prompt: string): void {
    this.systemPromptTokens = Math.ceil(prompt.length / 4)
  }

  /**
   * Check if compaction is needed based on current token usage.
   * Previously compacted contexts may grow again and are eligible for another
   * compaction once they cross the threshold.
   */
  isCompactionNeeded(messages: AgentMessage[]): boolean {
    const messageTokens = estimateMessagesTokens(messages)
    const tokens = messageTokens + this.systemPromptTokens
    return shouldCompact(tokens, this.model.contextWindow, this.settings)
  }

  /**
   * Get context usage stats for display.
   * Uses local character-based estimation for reliability (not dependent on API usage data).
   */
  getContextUsage(messages: AgentMessage[]): {
    tokens: number
    messageTokens: number
    systemPromptTokens: number
    contextWindow: number
    percentUsed: number
    percentRemaining: number
  } {
    const messageTokens = estimateMessagesTokens(messages)
    const tokens = messageTokens + this.systemPromptTokens
    const contextWindow = this.model.contextWindow
    const percentUsed = Math.round((tokens / contextWindow) * 100)
    return {
      tokens,
      messageTokens,
      systemPromptTokens: this.systemPromptTokens,
      contextWindow,
      percentUsed,
      percentRemaining: Math.max(0, 100 - percentUsed),
    }
  }

  /**
   * Layer 1: Microcompact — clear old tool results in-place.
   * No LLM call, cheap and fast.
   */
  microcompact(messages: AgentMessage[]): {
    messages: AgentMessage[]
    cleared: number
  } {
    // Collect tool result message indices grouped by tool name
    const toolResultIndices = new Map<string, number[]>()
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]
      if (msg.role === 'toolResult') {
        const toolName = msg.toolName ?? 'unknown'
        if (COMPACTABLE_TOOL_NAMES.has(toolName)) {
          const indices = toolResultIndices.get(toolName) ?? []
          indices.push(i)
          toolResultIndices.set(toolName, indices)
        }
      }
    }

    // Determine which indices to clear (keep last N per tool type)
    const clearIndices = new Set<number>()
    for (const [, indices] of toolResultIndices) {
      const toClear = indices.slice(0, Math.max(0, indices.length - KEEP_RECENT_TOOLS))
      for (const idx of toClear) {
        clearIndices.add(idx)
      }
    }

    if (clearIndices.size === 0) {
      return { messages, cleared: 0 }
    }

    // Create new messages array with cleared tool results
    const newMessages = messages.map((msg, i) => {
      if (!clearIndices.has(i)) return msg
      if (msg.role !== 'toolResult') return msg

      // Replace content with cleared marker
      return {
        ...msg,
        content: [{ type: 'text' as const, text: CLEARED_MESSAGE }],
      }
    })

    return { messages: newMessages, cleared: clearIndices.size }
  }

  /** Shared implementation for automatic and manual compaction. */
  async compact(
    messages: AgentMessage[],
    customInstructions: string | undefined,
    automatic: boolean,
  ): Promise<ContextCompactionResult> {
    if (this.compacting) {
      throw new Error('Compaction already in progress')
    }
    this.compacting = true
    this.progressStartedAt = Date.now()
    const tokensBefore = estimateMessagesTokens(messages)

    try {
      this.emitProgress({
        phase: 'analyzing',
        message: 'Analyzing conversation structure...',
        tokensBefore,
        progress: 5,
      })

      const units = buildConversationUnits(messages)
      const { summaryUnits, recentUnits } = selectCompactionRanges(
        units,
        this.model.contextWindow,
        tokensBefore,
      )
      const messagesToSummarize = normalizeSummaryMessages(
        summaryUnits.length > 0 ? summaryUnits : units,
      )
      const recentMessages = recentUnits.flatMap((unit) => unit.messages)

      this.emitProgress({
        phase: 'analyzing',
        message:
          `Summarizing ${summaryUnits.length} units; ` +
          `keeping ${recentUnits.length} recent units verbatim.`,
        tokensBefore,
        progress: 15,
        processedUnits: units.length,
        totalUnits: units.length,
      })

      let summaryProgress = 20
      const summaryMessage = automatic
        ? 'Auto-compacting earlier history...'
        : 'Summarizing earlier history...'
      this.emitProgress({
        phase: 'summarizing',
        message: summaryMessage,
        tokensBefore,
        progress: summaryProgress,
        processedUnits: summaryUnits.length,
        totalUnits: units.length,
      })
      const progressTimer = setInterval(() => {
        summaryProgress = Math.min(84, summaryProgress + 1)
        this.emitProgress({
          phase: 'summarizing',
          message: summaryMessage,
          tokensBefore,
          progress: summaryProgress,
          processedUnits: summaryUnits.length,
          totalUnits: units.length,
        })
      }, 250)

      let result
      try {
        result = await this.generateSummaryFn(
          messagesToSummarize,
          this.models,
          this.model,
          this.settings.reserveTokens,
          customInstructions,
          undefined,
          undefined,
          undefined,
          undefined,
          BACKGROUND_CONTEXT,
        )
      } finally {
        clearInterval(progressTimer)
      }

      if (!result.ok) {
        throw new Error(`Summarization failed: ${result.error.message}`)
      }

      const summary = result.value
      if (!summary || summary.trim().length === 0) {
        throw new Error('Summarization returned empty summary')
      }

      // Build the summary message
      const summaryUserMessage: AgentMessage = {
        role: 'user',
        content: getCompactUserSummaryMessage(summary),
        timestamp: Date.now(),
      }

      const newMessages = [summaryUserMessage, ...recentMessages]
      this.emitProgress({
        phase: 'validating',
        message: 'Validating compacted tool-call boundaries...',
        tokensBefore,
        progress: 88,
        processedUnits: units.length,
        totalUnits: units.length,
      })
      const validation = validateToolMessagePairs(newMessages)
      if (!validation.valid) {
        throw new Error(`Compaction produced invalid context: ${validation.error}`)
      }
      const tokensAfter = estimateMessagesTokens(newMessages)

      this.emitProgress({
        phase: 'validating',
        message: 'Compacted context is ready to commit.',
        tokensBefore,
        tokensAfter,
        progress: 90,
        processedUnits: units.length,
        totalUnits: units.length,
      })

      return {
        summary,
        messages: newMessages,
        tokensBefore,
        tokensAfter,
        keptMessageCount: recentMessages.length,
        automatic,
      }
    } catch (error) {
      this.emitProgress({
        phase: 'done',
        message: `Compaction failed: ${error instanceof Error ? error.message : String(error)}`,
        progress: 100,
      })
      throw error
    } finally {
      this.compacting = false
    }
  }

  /**
   * Check if currently compacting.
   */
  isCompacting(): boolean {
    return this.compacting
  }

  /**
   * Update model (e.g., after /model switch).
   */
  setModel(model: Model<any>): void {
    this.model = model
  }

  /**
   * Update API key.
   */
  setApiKey(apiKey: string): void {
    this.apiKey = apiKey
  }
}

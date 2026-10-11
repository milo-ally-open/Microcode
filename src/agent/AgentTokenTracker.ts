import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { Api, AssistantMessage, Model, Usage } from '@earendil-works/pi-ai'
import { estimateMessagesTokens } from '../session/TokenEstimator.ts'

export interface ContextTokenUsage {
  readonly systemPromptTokens: number
  readonly messageTokens: number
  readonly usedTokens: number
  readonly remainingTokens: number
  readonly contextWindow: number
  readonly percentUsed: number
  readonly percentRemaining: number
}

export interface ApiTokenUsage {
  readonly requests: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly totalTokens: number
  readonly totalCost: number
}

export interface ModelTokenUsage extends ApiTokenUsage {
  readonly key: string
  readonly modelId: string
  readonly provider: string
  readonly api: Api
}

export interface AgentTokenSnapshot {
  readonly context: Readonly<ContextTokenUsage>
  readonly session: Readonly<ApiTokenUsage>
  readonly currentModel: Readonly<ModelTokenUsage>
  readonly byModel: Readonly<Record<string, Readonly<ModelTokenUsage>>>
}

interface UsageEntry {
  key: string
  modelId: string
  provider: string
  api: Api
  usage: Usage
}

function emptyUsage(): ApiTokenUsage {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    totalCost: 0,
  }
}

function addUsage(target: ApiTokenUsage, usage: Usage): ApiTokenUsage {
  return {
    requests: target.requests + 1,
    inputTokens: target.inputTokens + usage.input,
    outputTokens: target.outputTokens + usage.output,
    cacheReadTokens: target.cacheReadTokens + usage.cacheRead,
    cacheWriteTokens: target.cacheWriteTokens + usage.cacheWrite,
    totalTokens: target.totalTokens + usage.totalTokens,
    totalCost: target.totalCost + usage.cost.total,
  }
}

function modelKey(provider: string, api: Api, modelId: string): string {
  return `${provider}:${api}:${modelId}`
}

function requestKey(message: AssistantMessage): string {
  if (message.responseId) {
    return `${message.provider}:${message.api}:${message.responseId}`
  }
  return [
    message.provider,
    message.api,
    message.model,
    message.timestamp,
    message.usage.input,
    message.usage.output,
    message.usage.totalTokens,
  ].join(':')
}

function freezeApiUsage(usage: ApiTokenUsage): Readonly<ApiTokenUsage> {
  return Object.freeze({ ...usage })
}

function freezeModelUsage(usage: ModelTokenUsage): Readonly<ModelTokenUsage> {
  return Object.freeze({ ...usage })
}

export class AgentTokenTracker {
  private readonly entries = new Map<string, UsageEntry>()

  recordMessage(message: AgentMessage): void {
    if (message.role !== 'assistant') return
    const key = requestKey(message)
    if (this.entries.has(key)) return
    this.entries.set(key, {
      key,
      modelId: message.model,
      provider: String(message.provider),
      api: message.api,
      usage: message.usage,
    })
  }

  recordMessages(messages: readonly AgentMessage[]): void {
    for (const message of messages) {
      this.recordMessage(message)
    }
  }

  rebuild(messages: readonly AgentMessage[]): void {
    this.entries.clear()
    this.recordMessages(messages)
  }

  reset(): void {
    this.entries.clear()
  }

  getSnapshot(options: {
    systemPrompt: string
    messages: readonly AgentMessage[]
    model: Model<Api>
  }): Readonly<AgentTokenSnapshot> {
    this.recordMessages(options.messages)

    const systemPromptTokens = Math.ceil(options.systemPrompt.length / 4)
    const messageTokens = estimateMessagesTokens([...options.messages])
    const usedTokens = systemPromptTokens + messageTokens
    const contextWindow = options.model.contextWindow
    const remainingTokens = Math.max(0, contextWindow - usedTokens)
    const percentUsed = contextWindow > 0
      ? Math.round((usedTokens / contextWindow) * 100)
      : 0
    const context = Object.freeze({
      systemPromptTokens,
      messageTokens,
      usedTokens,
      remainingTokens,
      contextWindow,
      percentUsed,
      percentRemaining: Math.max(0, 100 - percentUsed),
    })

    let session = emptyUsage()
    const grouped = new Map<string, ModelTokenUsage>()
    for (const entry of this.entries.values()) {
      session = addUsage(session, entry.usage)
      const key = modelKey(entry.provider, entry.api, entry.modelId)
      const previous = grouped.get(key)
      const totals = addUsage(previous ?? emptyUsage(), entry.usage)
      grouped.set(key, {
        key,
        modelId: entry.modelId,
        provider: entry.provider,
        api: entry.api,
        ...totals,
      })
    }

    const currentKey = modelKey(
      String(options.model.provider),
      options.model.api,
      options.model.id,
    )
    const currentModel = grouped.get(currentKey) ?? {
      key: currentKey,
      modelId: options.model.id,
      provider: String(options.model.provider),
      api: options.model.api,
      ...emptyUsage(),
    }

    const byModel = Object.fromEntries(
      [...grouped.entries()].map(([key, usage]) => [key, freezeModelUsage(usage)]),
    )

    return Object.freeze({
      context,
      session: freezeApiUsage(session),
      currentModel: freezeModelUsage(currentModel),
      byModel: Object.freeze(byModel),
    })
  }
}

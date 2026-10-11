import {
  Agent,
  type AgentMessage,
  type AgentTool,
  type ThinkingLevel,
} from '@earendil-works/pi-agent-core'
import {
  type Api,
  type ImageContent,
  type Message,
  type Model,
} from '@earendil-works/pi-ai'
import { getModelConfig, getModels, resolveApiKey } from '../models/index.ts'
import {
  getDeferredToolNames,
  TOOL_SEARCH_TOOL_NAME,
} from '../tools/index.ts'
import { getSystemPrompt } from '../prompt/prompts.ts'
import { CompactionManager } from '../session/CompactionManager.ts'
import type { ProjectInstructions } from '../instructions/projectInstructions.ts'
import type { McpServerState } from '../mcp/types.ts'
import type { McpClientManager } from '../mcp/client.ts'
import { AgentTokenTracker, type AgentTokenSnapshot } from './AgentTokenTracker.ts'
import {
  AgentModelManager,
  resolveAgentModelConfig,
  type AgentModelSnapshot,
} from './AgentModelManager.ts'
import { AgentToolManager, type AgentToolSnapshot } from './AgentToolManager.ts'
import { AgentSkillManager, type AgentSkillSnapshot } from './AgentSkillManager.ts'
import {
  PermissionManager,
  type PermissionBehavior,
  type EffectivePolicy,
  type PermissionDecision,
  type PermissionMode,
  type PermissionRule,
  type PermissionRuleValue,
  type PermissionSnapshot,
} from '../permissions/index.ts'
import type {
  AgentCompactionResult,
  AgentPermissionConfig,
  AgentPermissionRequest,
  AgentStateChangeReason,
  AgentIdentity,
  CompactAgentOptions,
  CreateMicrocodeAgentOptions,
  MessageUsageResetMode,
  MicrocodeAgentEvent,
  MicrocodeAgentEventListener,
  MicrocodeAgentSnapshot,
} from './types.ts'
import type {
  AgentCompactionRecord,
  AgentSessionPersistence,
} from './persistence.ts'

function createAgentId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `assistant-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function normalizeIdentity(options: CreateMicrocodeAgentOptions): Readonly<AgentIdentity> {
  return Object.freeze({
    id: options.identity?.id ?? createAgentId(),
    name: options.identity?.name,
    role: options.identity?.role,
  })
}

/**
 * High-level runtime boundary for one Microcode agent instance.
 *
 * The underlying pi-agent-core Agent stays private. All runtime mutations and
 * lifecycle observations go through this instance boundary.
 */
export class MicrocodeAgent {
  private readonly core: Agent
  private readonly identity: Readonly<AgentIdentity>
  private readonly cwd: string
  private readonly compactionManager: CompactionManager
  private readonly permissionManager: PermissionManager
  private readonly tokenTracker = new AgentTokenTracker()
  private readonly modelManager: AgentModelManager
  private readonly toolManager: AgentToolManager
  private readonly skillManager: AgentSkillManager
  private baseSystemPrompt: string
  private projectInstructions?: ProjectInstructions
  private mcpServers?: McpServerState[]
  private persistence?: AgentSessionPersistence
  private readonly listeners = new Set<MicrocodeAgentEventListener>()
  private readonly eventController = new AbortController()
  private permissionRequestHandler?: AgentPermissionConfig['onPermissionRequest']
  private askUserQuestionHandler?: AgentPermissionConfig['onAskUserQuestion']
  constructor(options: CreateMicrocodeAgentOptions = {}) {
    this.cwd = options.cwd ?? process.cwd()
    this.projectInstructions = options.projectInstructions
    this.persistence = options.persistence
    this.identity = normalizeIdentity(options)
    this.permissionRequestHandler = options.permission?.onPermissionRequest
    this.askUserQuestionHandler = options.permission?.onAskUserQuestion
    this.permissionManager = new PermissionManager({
      mode: options.permission?.mode,
      allowedTools: options.permission?.allow,
      deniedTools: options.permission?.deny,
      askTools: options.permission?.ask,
      onPermissionRequest: this.permissionRequestHandler
        ? (toolName, input, description) =>
            this.handlePermissionRequest('tool', toolName, input, description)
        : undefined,
      onAskUserQuestion: this.askUserQuestionHandler
        ? (toolName, input) => this.handleQuestionRequest(toolName, input)
        : undefined,
    })

    const resolveModelConfig = options.resolveModelConfig ?? resolveAgentModelConfig
    const modelConfig = options.initialModelConfig
      ?? (options.modelId
        ? resolveModelConfig(options.modelId, options.api as Api | undefined)
        : getModelConfig())
    this.modelManager = new AgentModelManager({
      model: modelConfig.model,
      apiKey: modelConfig.apiKey,
      thinkingLevel: options.thinkingLevel,
      resolveModelConfig,
      resolveApiKey: options.resolveModelApiKey,
    })
    this.mcpServers = options.mcpServers ? [...options.mcpServers] : undefined
    this.skillManager = new AgentSkillManager({
      cwd: this.cwd,
      skillPaths: options.skillPaths ?? [],
      includeDefaults: true,
      pluginSkills: options.pluginSkills,
      pluginDiagnostics: options.pluginDiagnostics,
    })
    this.toolManager = new AgentToolManager({
      cwd: this.cwd,
      getSkills: () => this.skillManager.getSkills(),
      model: modelConfig.model,
      getPersistence: () => this.persistence,
    })

    const deferredToolNames = getDeferredToolNames()
    const systemPrompt = getSystemPrompt({
      cwd: this.cwd,
      modelId: `${modelConfig.model.provider}/${modelConfig.model.id}`,
      mcpServers: this.mcpServers,
      skills: [...this.skillManager.getSkills()],
      deferredToolNames: deferredToolNames.length > 0 ? deferredToolNames : undefined,
      projectInstructions: this.projectInstructions,
    }).join('\n\n')

    this.baseSystemPrompt = systemPrompt
    this.compactionManager = new CompactionManager({
      model: modelConfig.model,
      apiKey: modelConfig.apiKey,
      onProgress: (progress) => {
        options.onCompactionProgress?.(progress)
        this.emitDetached({
          type: 'compaction_changed',
          agentId: this.identity.id,
          progress: Object.freeze({ ...progress }),
        })
      },
      generateSummaryFn: options.generateSummaryFn,
      models: options.models ?? getModels(),
      settings: options.compactionSettings,
    })
    this.compactionManager.setSystemPrompt(this.baseSystemPrompt)

    this.core = new Agent({
      initialState: {
        systemPrompt: this.baseSystemPrompt,
        model: modelConfig.model,
        tools: this.toolManager.getTools(),
      },
      beforeToolCall: async (context) =>
        this.permissionManager.checkPermissionWithPrompt(context),
      afterToolCall: async (context) => {
        if (context.toolCall.name !== TOOL_SEARCH_TOOL_NAME) {
          return undefined
        }
        const discoveredTools = this.toolManager.commitPendingDiscoveredTools()
        if (discoveredTools.length === 0) return undefined
        const tools = this.toolManager.getTools()
        this.core.state.tools = tools
        context.context.tools = tools
        return undefined
      },
      streamFn: options.streamFn ?? ((model, context, streamOptions) =>
        (options.models ?? getModels()).streamSimple(model, context, streamOptions)),
      convertToLlm: createConvertToLlm(() => this.core.state.model),
      // prepareRequest can replace the loop's current context. transformContext
      // only projects a one-request copy, so compaction there leaves subsequent
      // tool/model turns running on the original oversized transcript.
      prepareRequest: async ({ context }) => ({
        context: {
          ...context,
          messages: await this.prepareModelContext(context.messages),
        },
      }),
    })

    if (options.thinkingLevel) {
      this.core.state.thinkingLevel = options.thinkingLevel
    }
    this.modelManager.setThinkingLevel(this.core.state.thinkingLevel)

    this.permissionManager.setGetTool((name: string) =>
      this.toolManager.findTool(name),
    )
    this.core.subscribe(async (event, signal) => {
      if (event.type === 'message_end') {
        this.tokenTracker.recordMessage(event.message)
      }
      await this.emit({ ...event, agentId: this.identity.id }, signal)
      if (event.type === 'tool_execution_start') {
        await this.emit({
          type: 'tool_started',
          agentId: this.identity.id,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        }, signal)
      } else if (event.type === 'tool_execution_end') {
        await this.emit({
          type: 'tool_finished',
          agentId: this.identity.id,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.isError,
        }, signal)
      }
      if (event.type === 'message_end') {
        await this.emitTokenUsage(signal)
      }
      if (
        event.type === 'agent_start' ||
        event.type === 'agent_end' ||
        event.type === 'turn_end' ||
        event.type === 'message_end' ||
        event.type === 'tool_execution_start' ||
        event.type === 'tool_execution_end'
      ) {
        await this.emitStateChanged('core_event', signal)
      }
    })
  }

  getId(): string {
    return this.identity.id
  }

  getIdentity(): Readonly<AgentIdentity> {
    return this.identity
  }

  getSnapshot(): Readonly<MicrocodeAgentSnapshot> {
    const state = this.core.state
    return Object.freeze({
      identity: this.identity,
      cwd: this.cwd,
      model: Object.freeze({ ...state.model }),
      modelConfig: this.modelManager.getSnapshot(),
      thinkingLevel: state.thinkingLevel,
      systemPrompt: state.systemPrompt,
      messageCount: state.messages.length,
      toolNames: Object.freeze(state.tools.map((tool) => tool.name)),
      tools: this.toolManager.getSnapshot(),
      skills: this.skillManager.getSnapshot(),
      isStreaming: state.isStreaming,
      pendingToolCallCount: state.pendingToolCalls.size,
      permission: this.permissionManager.getSnapshot(),
      effectivePolicy: this.permissionManager.getEffectivePolicy(),
      tokens: this.getTokenStats(),
      errorMessage: state.errorMessage,
    })
  }

  getMessages(): readonly AgentMessage[] {
    return [...this.core.state.messages]
  }

  isBusy(): boolean {
    return this.core.state.isStreaming || this.core.state.pendingToolCalls.size > 0
  }

  getCurrentModel(): Readonly<Model<Api>> {
    return this.modelManager.getSnapshot().model
  }

  getThinkingLevel(): ThinkingLevel {
    return this.modelManager.getThinkingLevel()
  }

  replaceMessages(
    messages: readonly AgentMessage[],
    usageMode: MessageUsageResetMode = 'rebuild',
  ): void {
    this.core.state.messages = [...messages]
    if (usageMode === 'rebuild') {
      this.tokenTracker.rebuild(messages)
    } else {
      this.tokenTracker.recordMessages(messages)
    }
    this.emitTokenAndState('messages_replaced')
  }

  clearMessages(): void {
    this.core.state.messages = []
    this.tokenTracker.reset()
    this.emitTokenAndState('messages_cleared')
  }

  getTokenStats(): Readonly<AgentTokenSnapshot> {
    return this.tokenTracker.getSnapshot({
      systemPrompt: this.core.state.systemPrompt,
      messages: this.core.state.messages,
      model: this.core.state.model,
    })
  }

  prompt(message: AgentMessage | AgentMessage[]): Promise<void>
  prompt(input: string, images?: ImageContent[]): Promise<void>
  async prompt(
    input: string | AgentMessage | AgentMessage[],
    images?: ImageContent[],
  ): Promise<void> {
    this.refreshSkillCatalog()
    if (!this.isBusy()) await this.compactIfNeeded()
    if (typeof input === 'string') {
      await this.core.prompt(input, images)
    } else {
      await this.core.prompt(input)
    }
    await this.compactAfterPrompt()
  }

  async promptReadOnly(input: string): Promise<void> {
    if (this.isBusy()) throw new Error('Cannot change the available tools while the agent is busy.')

    await this.compactIfNeeded()
    this.toolManager.setPromptReadOnly(true)
    this.core.state.tools = this.toolManager.getTools()
    this.emitStateChangedDetached('tools_changed')
    try {
      await this.core.prompt(input)
    } finally {
      this.toolManager.setPromptReadOnly(false)
      this.core.state.tools = this.toolManager.getTools()
      this.emitStateChangedDetached('tools_changed')
    }
    await this.compactAfterPrompt()
  }

  abort(): void {
    this.core.abort()
  }

  followUp(message: AgentMessage): void {
    this.core.followUp(message)
  }

  steer(message: AgentMessage): void {
    this.core.steer(message)
  }

  waitForIdle(): Promise<void> {
    return this.core.waitForIdle()
  }

  subscribe(listener: MicrocodeAgentEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  setThinkingLevel(level: ThinkingLevel): void {
    this.modelManager.setThinkingLevel(level)
    this.core.state.thinkingLevel = level
    this.emitStateChangedDetached('thinking_changed')
  }

  getModelSnapshot(): Readonly<AgentModelSnapshot> {
    return this.modelManager.getSnapshot()
  }

  getApiKey(): string {
    return this.modelManager.getApiKey()
  }

  switchModel(modelId: string, api?: Api, provider?: string): Readonly<AgentModelSnapshot> {
    const nextConfig = this.modelManager.resolve(modelId, api, provider)
    const nextCoreTools = this.toolManager.previewCoreTools(nextConfig.model)
    const nextBasePrompt = this.buildBaseSystemPrompt(nextConfig.model)
    const nextPrompt = this.appendLoadedSkills(nextBasePrompt)

    const previousConfig = {
      model: this.modelManager.getModel(),
      apiKey: this.modelManager.getApiKey(),
    }
    const previousModel = this.core.state.model
    const previousCoreTools = this.toolManager.getCoreTools()
    const previousPrompt = this.core.state.systemPrompt
    const previousBasePrompt = this.baseSystemPrompt

    try {
      this.modelManager.commit(nextConfig)
      this.core.state.model = nextConfig.model
      this.toolManager.replaceCoreTools(nextCoreTools)
      this.core.state.tools = this.toolManager.getTools()
      this.baseSystemPrompt = nextBasePrompt
      this.updateSystemPrompt(nextPrompt)
      this.compactionManager.setModel(nextConfig.model)
      this.compactionManager.setApiKey(nextConfig.apiKey)
      this.compactionManager.setSystemPrompt(nextPrompt)
      const snapshot = this.modelManager.getSnapshot()
      this.emitDetached({
        type: 'model_changed',
        agentId: this.identity.id,
        previous: Object.freeze({ ...previousModel }),
        current: Object.freeze({ ...snapshot.model }),
      })
      this.emitTokenAndState('model_changed')
      return snapshot
    } catch (error) {
      this.modelManager.commit(previousConfig)
      this.core.state.model = previousModel
      this.toolManager.replaceCoreTools(previousCoreTools)
      this.core.state.tools = this.toolManager.getTools()
      this.baseSystemPrompt = previousBasePrompt
      this.updateSystemPrompt(previousPrompt)
      this.compactionManager.setModel(previousModel)
      this.compactionManager.setApiKey(previousConfig.apiKey)
      this.compactionManager.setSystemPrompt(previousPrompt)
      throw error
    }
  }

  updateMcpServers(servers?: McpServerState[]): void {
    this.mcpServers = servers ? [...servers] : undefined
    this.baseSystemPrompt = this.buildBaseSystemPrompt(this.core.state.model)
    const prompt = this.appendLoadedSkills(this.baseSystemPrompt)
    this.updateSystemPrompt(prompt)
    this.compactionManager.setSystemPrompt(prompt)
    this.emitTokenAndState('system_prompt_changed')
  }

  refreshSystemPrompt(): void {
    const prompt = this.appendLoadedSkills(this.baseSystemPrompt)
    this.updateSystemPrompt(prompt)
    this.compactionManager.setSystemPrompt(prompt)
    this.emitTokenAndState('system_prompt_changed')
  }

  getPermissionMode(): PermissionMode {
    return this.permissionManager.getMode()
  }

  setPermissionMode(mode: PermissionMode): void {
    this.permissionManager.setMode(mode)
    this.emitStateChangedDetached('permission_changed')
  }

  getEffectivePolicy(): Readonly<EffectivePolicy> {
    return this.permissionManager.getEffectivePolicy()
  }

  getPermissionSnapshot(): Readonly<PermissionSnapshot> {
    return this.permissionManager.getSnapshot()
  }

  checkPermission(
    toolName: string,
    input: Record<string, unknown>,
  ): PermissionDecision {
    return this.permissionManager.checkPermission(toolName, input)
  }

  requestToolPermission(
    toolName: string,
    input: Record<string, unknown>,
    description: string,
  ): Promise<boolean> {
    return this.handlePermissionRequest('tool', toolName, input, description)
  }

  addPermissionRule(rule: PermissionRule): void {
    this.permissionManager.addRule(rule)
    this.emitStateChangedDetached('permission_changed')
  }

  removePermissionRule(
    rule: PermissionRuleValue,
    behavior: PermissionBehavior,
  ): void {
    this.permissionManager.removeRule(rule, behavior)
    this.emitStateChangedDetached('permission_changed')
  }

  addSessionPermission(toolName: string, ruleContent?: string): void {
    this.permissionManager.addSessionRule(toolName, ruleContent)
    this.emitStateChangedDetached('permission_changed')
  }

  /** Replace all rules from a parent snapshot (permission inheritance). */
  inheritPermissions(
    snapshot: Readonly<PermissionSnapshot>,
    extraDeny: PermissionRuleValue[] = [],
    updateMode = true,
  ): void {
    this.permissionManager.inheritFrom(snapshot, extraDeny, updateMode)
  }

  setPermissionRequestHandler(
    handler: Parameters<PermissionManager['setOnPermissionRequest']>[0],
  ): void {
    this.permissionRequestHandler = handler
    this.permissionManager.setOnPermissionRequest((toolName, input, description) =>
      this.handlePermissionRequest('tool', toolName, input, description),
    )
  }

  setAskUserQuestionHandler(
    handler: Parameters<PermissionManager['setOnAskUserQuestion']>[0],
  ): void {
    this.askUserQuestionHandler = handler
    this.permissionManager.setOnAskUserQuestion((toolName, input) =>
      this.handleQuestionRequest(toolName, input),
    )
  }

  setPersistence(persistence?: AgentSessionPersistence): void {
    this.persistence = persistence
  }

  async persistMessages(): Promise<void> {
    await this.persistence?.saveMessages(this.core.state.messages)
  }

  async compact(options: CompactAgentOptions = {}): Promise<Readonly<AgentCompactionResult>> {
    if (this.core.state.isStreaming) {
      throw new Error('Cannot manually compact while the agent is running.')
    }
    const messages = [...this.core.state.messages]
    if (messages.length === 0) {
      throw new Error('No messages to compact.')
    }
    const result = await this.compactionManager.compact(
      messages,
      options.instructions,
      false,
    )
    await this.commitCompaction(result, options.persistToSession !== false)
    return Object.freeze({
      ...result,
      messages: Object.freeze([...result.messages]),
    })
  }

  async compactIfNeeded(
    messages: readonly AgentMessage[] = this.core.state.messages,
  ): Promise<AgentMessage[]> {
    const originalUsage = this.compactionManager.getContextUsage([...messages])
    const contextWindowExceeded = originalUsage.tokens > originalUsage.contextWindow
    const { messages: microcompacted } = this.compactionManager.microcompact([...messages])
    if (
      !contextWindowExceeded &&
      !this.compactionManager.isCompactionNeeded(microcompacted)
    ) {
      return microcompacted
    }
    try {
      const result = await this.compactionManager.compact(
        microcompacted,
        undefined,
        true,
      )
      await this.commitCompaction(result, true)
      return result.messages
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Automatic context compaction failed: ${message}`, { cause: error })
    }
  }

  private async compactAfterPrompt(): Promise<void> {
    // A failed pre-request compaction already ended the core run with a visible error.
    // Do not immediately retry the same failing summary request after that run settles.
    if (this.core.state.errorMessage?.startsWith('Automatic context compaction failed:')) return
    await this.compactIfNeeded()
  }

  private async prepareModelContext(
    messages: readonly AgentMessage[],
  ): Promise<AgentMessage[]> {
    // The prepared context is carried into the next request by the Agent loop.
    // Replace, rather than accumulate, the transient reminder each time.
    const withoutPreviousReminder = messages.filter((message) =>
      !(message.role === 'custom' && message.customType === 'task-reminder'),
    )
    const compacted = await this.compactIfNeeded(withoutPreviousReminder)
    const reminder = await this.getTaskReminder()
    if (!reminder) return compacted

    return [
      ...compacted,
      {
        role: 'custom',
        customType: 'task-reminder',
        content: reminder,
        display: false,
        timestamp: Date.now(),
      },
    ]
  }

  private async getTaskReminder(): Promise<string | undefined> {
    try {
      return await this.persistence?.getTaskReminder?.()
    } catch {
      // A reminder must never prevent the agent from continuing.
      return undefined
    }
  }

  getSkillSnapshot(): Readonly<AgentSkillSnapshot> {
    this.refreshSkillCatalog()
    return this.skillManager.getSnapshot()
  }

  getSkills() {
    this.refreshSkillCatalog()
    return this.skillManager.getSkills()
  }

  isSkillLoaded(skillName: string): boolean {
    this.refreshSkillCatalog()
    return this.skillManager.isLoaded(skillName)
  }

  getLoadedSkillNames(): readonly string[] {
    return this.skillManager.getLoadedNames()
  }

  loadSkill(skillName: string): void {
    this.refreshSkillCatalog()
    this.skillManager.load(skillName)
    this.rebuildSystemPrompt()
    this.emitStateChangedDetached('skills_changed')
  }

  unloadSkill(skillName: string): void {
    this.refreshSkillCatalog()
    if (!this.skillManager.unload(skillName)) return
    this.rebuildSystemPrompt()
    this.emitStateChangedDetached('skills_changed')
  }

  setPluginSkills(skills: readonly import('../skill.ts').Skill[], diagnostics: readonly string[] = []): void {
    if (!this.skillManager.setPluginSkills(skills, diagnostics)) return
    this.baseSystemPrompt = this.buildBaseSystemPrompt(this.core.state.model)
    this.rebuildSystemPrompt()
    this.emitStateChangedDetached('skills_changed')
  }

  getToolSnapshot(): Readonly<AgentToolSnapshot> {
    return this.toolManager.getSnapshot()
  }

  addTools(tools: readonly AgentTool<any, any>[]): void {
    this.toolManager.addTools(tools)
    this.core.state.tools = this.toolManager.getTools()
    this.emitStateChangedDetached('tools_changed')
  }

  configureMcpTools(client: McpClientManager): void {
    this.toolManager.configureMcpTools(client)
    this.core.state.tools = this.toolManager.getTools()
    this.emitStateChangedDetached('tools_changed')
  }

  removeTools(names: readonly string[]): void {
    this.toolManager.removeTools(names)
    this.core.state.tools = this.toolManager.getTools()
    this.emitStateChangedDetached('tools_changed')
  }

  hasTool(name: string): boolean {
    return this.toolManager.findTool(name) !== undefined
  }

  private rebuildSystemPrompt(): void {
    const prompt = this.appendLoadedSkills(this.baseSystemPrompt)
    this.updateSystemPrompt(prompt)
    this.compactionManager.setSystemPrompt(prompt)
  }

  private refreshSkillCatalog(): void {
    if (!this.skillManager.refresh()) return
    this.baseSystemPrompt = this.buildBaseSystemPrompt(this.core.state.model)
    this.rebuildSystemPrompt()
    this.emitStateChangedDetached('skills_changed')
  }

  private updateSystemPrompt(prompt: string): void {
    const messages = [...this.core.state.messages]
    const systemIndex = messages.findIndex((message) => message.role === 'system')
    const systemMessage = { role: 'system' as const, content: prompt, timestamp: Date.now() }
    if (systemIndex >= 0) messages[systemIndex] = systemMessage
    else messages.unshift(systemMessage)
    this.core.state.messages = messages
  }

  updateProjectInstructions(instructions: ProjectInstructions): void {
    this.projectInstructions = instructions
    this.baseSystemPrompt = this.buildBaseSystemPrompt(this.core.state.model)
    this.rebuildSystemPrompt()
    this.emitTokenAndState('system_prompt_changed')
  }

  getProjectInstructions(): ProjectInstructions | undefined {
    return this.projectInstructions
  }

  private buildBaseSystemPrompt(model: Model<Api>): string {
    const deferredToolNames = getDeferredToolNames()
    const prompt = getSystemPrompt({
      cwd: this.cwd,
      modelId: `${model.provider}/${model.id}`,
      mcpServers: this.mcpServers,
      skills: [...this.skillManager.getSkills()],
      deferredToolNames: deferredToolNames.length > 0 ? deferredToolNames : undefined,
      projectInstructions: this.projectInstructions,
    }).join('\n\n')
    return prompt
  }

  private appendLoadedSkills(basePrompt: string): string {
    return this.skillManager.appendLoadedSkills(basePrompt)
  }

  private async commitCompaction(
    result: {
      summary: string
      messages: AgentMessage[]
      tokensBefore: number
      tokensAfter: number
      keptMessageCount: number
      automatic: boolean
    },
    persist: boolean,
  ): Promise<void> {
    try {
      if (persist && this.persistence) {
        this.compactionManager.reportProgress({
          phase: 'persisting',
          message: 'Persisting compacted session...',
          progress: 94,
          tokensBefore: result.tokensBefore,
          tokensAfter: result.tokensAfter,
        })
        await this.persistence.saveMessages(this.core.state.messages)
        const record: AgentCompactionRecord = {
          summary: result.summary,
          messages: result.messages,
          tokensBefore: result.tokensBefore,
          tokensAfter: result.tokensAfter,
          keptMessageCount: result.keptMessageCount,
          compactedMessageCount: result.messages.length,
          automatic: result.automatic,
          model: {
            provider: String(this.core.state.model.provider),
            modelId: this.core.state.model.id,
            contextWindow: this.core.state.model.contextWindow,
          },
        }
        await this.persistence.recordCompaction(record)
      }
      this.compactionManager.reportProgress({
        phase: 'committing',
        message: 'Replacing active context...',
        progress: 98,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
      })
      this.replaceMessages(result.messages, 'preserve')
      this.emitStateChangedDetached('compaction_completed')
      this.compactionManager.reportProgress({
        phase: 'done',
        message: `Compacted: ${result.tokensBefore} → ${result.tokensAfter} tokens`,
        progress: 100,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
      })
    } catch (error) {
      this.compactionManager.reportProgress({
        phase: 'done',
        message:
          `Compaction failed: ${error instanceof Error ? error.message : String(error)}`,
        progress: 100,
        tokensBefore: result.tokensBefore,
      })
      throw error
    }
  }

  private async handlePermissionRequest(
    kind: 'tool',
    toolName: string,
    input: Record<string, unknown>,
    description: string,
  ): Promise<boolean> {
    const request = this.createPermissionRequest(kind, toolName, input, description)
    await this.emit({
      type: 'permission_requested',
      agentId: this.identity.id,
      request,
    })
    const allowed = this.permissionRequestHandler
      ? await this.permissionRequestHandler(toolName, input, description)
      : false
    await this.emit({
      type: 'permission_resolved',
      agentId: this.identity.id,
      request,
      allowed,
    })
    return allowed
  }

  private async handleQuestionRequest(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ answers?: Record<string, string>; block?: boolean }> {
    const request = this.createPermissionRequest('question', toolName, input)
    await this.emit({
      type: 'permission_requested',
      agentId: this.identity.id,
      request,
    })
    const result = this.askUserQuestionHandler
      ? await this.askUserQuestionHandler(toolName, input)
      : { block: true }
    await this.emit({
      type: 'permission_resolved',
      agentId: this.identity.id,
      request,
      allowed: !result.block,
    })
    return result
  }

  private createPermissionRequest(
    kind: AgentPermissionRequest['kind'],
    toolName: string,
    input: Record<string, unknown>,
    description?: string,
  ): Readonly<AgentPermissionRequest> {
    return Object.freeze({
      kind,
      toolName,
      input: Object.freeze({ ...input }),
      description,
    })
  }

  private async emit(
    event: MicrocodeAgentEvent,
    signal: AbortSignal = this.eventController.signal,
  ): Promise<void> {
    for (const listener of [...this.listeners]) {
      await listener(event, signal)
    }
  }

  private emitDetached(event: MicrocodeAgentEvent): void {
    void this.emit(event).catch(() => {})
  }

  private async emitTokenUsage(signal?: AbortSignal): Promise<void> {
    await this.emit({
      type: 'token_usage',
      agentId: this.identity.id,
      usage: this.getTokenStats(),
    }, signal)
  }

  private async emitStateChanged(
    reason: AgentStateChangeReason,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.emit({
      type: 'state_changed',
      agentId: this.identity.id,
      reason,
      snapshot: this.getSnapshot(),
    }, signal)
  }

  private emitStateChangedDetached(
    reason: AgentStateChangeReason,
  ): void {
    this.emitDetached({
      type: 'state_changed',
      agentId: this.identity.id,
      reason,
      snapshot: this.getSnapshot(),
    })
  }

  private emitTokenAndState(reason: AgentStateChangeReason): void {
    this.emitDetached({
      type: 'token_usage',
      agentId: this.identity.id,
      usage: this.getTokenStats(),
    })
    this.emitStateChangedDetached(reason)
  }
}

export function createConvertToLlm(getModel: () => Model<Api>) {
  return (messages: AgentMessage[]): Message[] => {
    const model = getModel()
    const compat = model.compat as any
    const requiresReasoningContent =
      compat?.requiresReasoningContentOnAssistantMessages && model.reasoning

    return messages.flatMap((message) => {
      switch (message.role) {
        case 'system':
          // pi-agent-core stores the active system prompt and tool loadout
          // changes in system messages. Dropping them makes models appear
          // tool-less even though the tools are registered in Agent.state.
          return [message as Message]

        case 'user':
        case 'toolResult':
          return [message as Message]

        case 'assistant': {
          if (model.api === 'openai-completions') {
            const thinkingText = message.content
              .filter((content: any) => content.type === 'thinking')
              .map((content: any) => content.thinking)
              .join('\n')
            const filtered = message.content.filter((content: any) => content.type !== 'thinking')
            const result: any = { ...message, content: filtered }
            if (requiresReasoningContent) {
              result.reasoning_content = thinkingText || ''
            }
            return [result as Message]
          }
          return [message as Message]
        }

        case 'bashExecution':
          return [{
            role: 'user' as const,
            content: `Command: ${message.command}\nOutput: ${message.output}`,
            timestamp: message.timestamp,
          }] as Message[]

        case 'compactionSummary':
          return [{
            role: 'user' as const,
            content: `[Previous conversation summary]\n${message.summary}`,
            timestamp: message.timestamp,
          }] as Message[]

        case 'branchSummary':
          return [{
            role: 'user' as const,
            content: `[Branch summary]\n${message.summary}`,
            timestamp: message.timestamp,
          }] as Message[]

        case 'custom':
          if (typeof message.content === 'string') {
            return [{
              role: 'user' as const,
              content: message.content,
              timestamp: message.timestamp,
            }] as Message[]
          }
          return []

        default:
          return []
      }
    })
  }
}

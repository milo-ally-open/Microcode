import type { AgentMessage, ThinkingLevel } from '@earendil-works/pi-agent-core'
import type { Api, ImageContent, Model } from '@earendil-works/pi-ai'
import type { MicrocodeAgent } from '../agent/MicrocodeAgent.ts'
import type {
  CompactAgentOptions,
  MicrocodeAgentEvent,
  MicrocodeAgentEventListener,
  MicrocodeAgentSnapshot,
  MessageUsageResetMode,
} from '../agent/types.ts'
import type { AgentTokenSnapshot } from '../agent/AgentTokenTracker.ts'
import type { AgentModelSnapshot } from '../agent/AgentModelManager.ts'
import type { AgentSkillSnapshot } from '../agent/AgentSkillManager.ts'
import type { PermissionDecision, PermissionMode } from '../permissions/types.ts'
import type { JsonlSessionMetadata } from '@earendil-works/pi-agent-core'
import type { SessionListItem, SessionManager } from '../session/SessionManager.ts'
import type { McpClientManager } from '../mcp/client.ts'
import type { McpServerState } from '../mcp/types.ts'
import type { PluginManager } from '../plugins/PluginManager.ts'
import type { PluginRecord, PluginScope, PluginSnapshot } from '../plugins/types.ts'
import type { ProjectInstructions } from '../instructions/projectInstructions.ts'
import { ApplicationRuntime } from './ApplicationRuntime.ts'
import type { RuntimeCommand, RuntimeCommandResponse, RuntimeEvent } from './protocol.ts'

type AgentClientBase = Pick<MicrocodeAgent,
  | 'getSnapshot' | 'getMessages' | 'isBusy' | 'getCurrentModel' | 'getThinkingLevel'
  | 'replaceMessages' | 'clearMessages' | 'getTokenStats' | 'prompt' | 'promptReadOnly'
  | 'abort' | 'subscribe' | 'setThinkingLevel' | 'switchModel' | 'updateMcpServers'
  | 'refreshSystemPrompt' | 'getPermissionMode' | 'setPermissionMode' | 'checkPermission'
  | 'requestToolPermission' | 'addSessionPermission' | 'persistMessages' | 'compact'
  | 'getSkillSnapshot' | 'getSkills' | 'isSkillLoaded' | 'loadSkill' | 'unloadSkill'
  | 'updateProjectInstructions' | 'getProjectInstructions' | 'configureMcpTools'
  | 'setPermissionRequestHandler' | 'setAskUserQuestionHandler' | 'setPersistence'
>
type AgentClient = Omit<AgentClientBase, 'switchModel' | 'configureMcpTools'> & {
  switchModel(modelId: string, api?: Api, provider?: string): Promise<Readonly<AgentModelSnapshot>>
  configureMcpTools(client?: McpClientManager | TuiMcpClient): void
}

export type TuiSessionManager = Pick<SessionManager,
  | 'beginDraft' | 'ensureCreated' | 'getMetadata' | 'getSessionId' | 'getTitle'
  | 'listTaskLists' | 'listWithTitles' | 'remindTask' | 'setTitle' | 'switchToSession'
>

export type TuiMcpClient = Pick<McpClientManager, 'getServerStates' | 'getConnectedServers' | 'getServer' | 'removeServer'> & {
  refreshCapabilities(): ReturnType<ApplicationRuntime['refreshCapabilities']>
}

export type TuiPluginManager = Pick<PluginManager, 'getSnapshot' | 'getPlugins' | 'findPlugin' | 'refresh' | 'setEnabledMany'>

type PermissionPrompt = (toolName: string, input: Record<string, unknown>, description: string) => Promise<boolean>
type QuestionPrompt = (toolName: string, input: Record<string, unknown>) => Promise<{ answers?: Record<string, string>; block?: boolean }>

/** Local TUI adapter. Its views use runtime queries and every mutation is a runtime command. */
export class TuiAdapter {
  readonly agent: AgentClient
  readonly sessions: TuiSessionManager
  readonly mcp: TuiMcpClient
  readonly plugins?: TuiPluginManager
  private readonly unsubscribe: () => void
  private commandNumber = 0
  private permissionPrompt?: PermissionPrompt
  private questionPrompt?: QuestionPrompt
  private readonly queuedPermissionEvents: RuntimeEvent[] = []

  constructor(readonly runtime: ApplicationRuntime) {
    this.agent = this.createAgentClient()
    this.sessions = this.createSessionClient()
    this.mcp = this.createMcpClient()
    this.plugins = runtime.getPluginSnapshotForTui() ? this.createPluginClient() : undefined
    this.unsubscribe = runtime.subscribe((event) => this.onRuntimeEvent(event))
  }

  bindPermissionHandlers(permissionPrompt: PermissionPrompt, questionPrompt: QuestionPrompt): void {
    this.permissionPrompt = permissionPrompt
    this.questionPrompt = questionPrompt
    for (const event of this.queuedPermissionEvents.splice(0)) this.onRuntimeEvent(event)
  }

  async refreshCapabilities(): ReturnType<ApplicationRuntime['refreshCapabilities']> {
    return this.runtime.refreshCapabilities()
  }

  dispose(): void {
    this.unsubscribe()
  }

  private async command<T>(command: RuntimeCommand): Promise<T> {
    const response = await this.runtime.dispatch({ commandId: `tui-${++this.commandNumber}`, command }) as RuntimeCommandResponse<T>
    if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
    return response.result
  }

  private createAgentClient(): AgentClient {
    const runtime = this.runtime
    const adapter = this
    const client = {
      getSnapshot: () => runtime.getSnapshot().agent,
      getMessages: () => runtime.query({ type: 'agent.messages' }) as readonly AgentMessage[],
      isBusy: () => runtime.query({ type: 'agent.is_busy' }) as boolean,
      getCurrentModel: () => runtime.query({ type: 'agent.current_model' }) as Readonly<Model<Api>>,
      getThinkingLevel: () => runtime.getSnapshot().agent.thinkingLevel,
      replaceMessages: (messages: readonly AgentMessage[], usageMode: MessageUsageResetMode = 'rebuild') => { void adapter.command<void>({ type: 'agent.replace_messages', messages, usageMode }) },
      clearMessages: () => { void adapter.command<void>({ type: 'agent.clear_messages' }) },
      getTokenStats: () => runtime.getSnapshot().agent.tokens as Readonly<AgentTokenSnapshot>,
      prompt: (input: string | AgentMessage | AgentMessage[], images?: ImageContent[]) =>
        adapter.command<void>({ type: 'agent.prompt', prompt: input, images }),
      promptReadOnly: (prompt: string) => adapter.command<void>({ type: 'agent.prompt_read_only', prompt }),
      abort: () => { void adapter.command<void>({ type: 'agent.cancel' }) },
      subscribe: (listener: MicrocodeAgentEventListener) => {
        const controller = new AbortController()
        const unsubscribe = runtime.subscribe((event) => {
          if (event.type === 'agent.event') {
            void Promise.resolve(listener(event.event, controller.signal)).catch(() => undefined)
          }
        })
        return () => { controller.abort(); unsubscribe() }
      },
      setThinkingLevel: (level: ThinkingLevel) => { void adapter.command<void>({ type: 'agent.set_thinking_level', level }) },
      switchModel: (modelId: string, api?: Api, provider?: string) => {
        if (runtime.query({ type: 'agent.is_busy' })) throw new Error('Agent is busy; wait for the current turn to finish before switching models.')
        // The UI callback is async at the adapter boundary; App's command handler awaits this result.
        return adapter.command<Readonly<AgentModelSnapshot>>({ type: 'model.switch', modelId, api, provider })
      },
      updateMcpServers: () => { void adapter.command<void>({ type: 'mcp.sync' }) },
      refreshSystemPrompt: () => { void adapter.command<void>({ type: 'agent.refresh_system_prompt' }) },
      getPermissionMode: () => runtime.getSnapshot().agent.permission.mode,
      setPermissionMode: (mode: PermissionMode) => { void adapter.command<void>({ type: 'permission.set_mode', mode }) },
      checkPermission: (toolName: string, input: Record<string, unknown>) => runtime.query({ type: 'permission.check', toolName, input }) as PermissionDecision,
      requestToolPermission: (toolName: string, input: Record<string, unknown>, description: string) =>
        adapter.command<boolean>({ type: 'permission.request', toolName, input, description }),
      addSessionPermission: (toolName: string, ruleContent?: string) => { void adapter.command<void>({ type: 'permission.add_session_rule', toolName, ruleContent }) },
      persistMessages: () => adapter.command<void>({ type: 'agent.persist' }),
      compact: (options?: CompactAgentOptions) => adapter.command<ReturnType<MicrocodeAgent['compact']> extends Promise<infer T> ? T : never>({ type: 'agent.compact', options }),
      getSkillSnapshot: () => runtime.query({ type: 'agent.skills' }) as Readonly<AgentSkillSnapshot>,
      getSkills: () => runtime.query({ type: 'agent.skill_list' }) as ReturnType<MicrocodeAgent['getSkills']>,
      isSkillLoaded: (name: string) => runtime.query({ type: 'agent.skill_loaded', name }) as boolean,
      loadSkill: (name: string) => { void adapter.command<void>({ type: 'skill.load', name }) },
      unloadSkill: (name: string) => { void adapter.command<void>({ type: 'skill.unload', name }) },
      updateProjectInstructions: (instructions: ProjectInstructions) => { void adapter.command<void>({ type: 'project.instructions.update', instructions }) },
      getProjectInstructions: () => runtime.query({ type: 'agent.project_instructions' }) as ProjectInstructions | undefined,
      configureMcpTools: (_client?: McpClientManager | TuiMcpClient) => { void adapter.command<void>({ type: 'mcp.sync' }) },
      setPermissionRequestHandler: (handler: PermissionPrompt) => { adapter.permissionPrompt = handler },
      setAskUserQuestionHandler: (handler: QuestionPrompt) => { adapter.questionPrompt = handler },
      setPersistence: () => { /* Persistence is attached to the Agent by ApplicationRuntime's composition root. */ },
    }
    return client as AgentClient
  }

  private createSessionClient(): TuiSessionManager {
    const runtime = this.runtime
    const adapter = this
    return {
      beginDraft(cwd: string) { void adapter.command<void>({ type: 'session.begin_draft', cwd }) },
      ensureCreated(cwd?: string) { return adapter.command<string>({ type: 'session.ensure_created', cwd }) },
      getMetadata() { return runtime.query({ type: 'session.metadata' }) as ReturnType<SessionManager['getMetadata']> },
      getSessionId() { return runtime.query({ type: 'session.id' }) as string | null },
      getTitle(sessionId: string) { return runtime.query({ type: 'session.title', sessionId }) as string | undefined },
      listTaskLists() { return adapter.command<Awaited<ReturnType<SessionManager['listTaskLists']>>>({ type: 'session.list_tasks' }) },
      listWithTitles(cwd?: string) { return adapter.command<SessionListItem[]>({ type: 'session.list', cwd: cwd ?? runtime.projectDirectory, withTitles: true }) },
      remindTask(listId: string, taskId: string, reminder?: boolean) { return adapter.command<Awaited<ReturnType<SessionManager['remindTask']>>>({ type: 'session.remind_task', listId, taskId, reminder }) },
      setTitle(sessionId: string, title: string) { void adapter.command<void>({ type: 'session.set_title', sessionId, title }) },
      async switchToSession(meta: JsonlSessionMetadata) { return adapter.command<AgentMessage[]>({ type: 'session.select', sessionId: meta.id }) },
    } as TuiSessionManager
  }

  private createMcpClient(): TuiMcpClient {
    const runtime = this.runtime
    const adapter = this
    return {
      getServerStates: () => runtime.getMcpStatesForTui(),
      getConnectedServers: () => runtime.getMcpStatesForTui().filter((server) => server.status === 'connected'),
      getServer: (name: string) => runtime.getMcpStatesForTui().find((server) => server.name === name),
      removeServer: (name: string) => adapter.command<boolean>({ type: 'mcp.remove', name }),
      refreshCapabilities: () => runtime.refreshCapabilities(),
    } as TuiMcpClient
  }

  private createPluginClient(): TuiPluginManager {
    const runtime = this.runtime
    const adapter = this
    const requireManager = () => {
      const manager = runtime.getPluginSnapshotForTui()
      if (!manager) throw new Error('Plugin management is unavailable in this session.')
    }
    return {
      getSnapshot: () => runtime.getPluginSnapshotForTui()!,
      getPlugins: () => runtime.getPluginSnapshotForTui()?.plugins ?? [],
      findPlugin: (name: string) => runtime.getPluginSnapshotForTui()?.plugins.find((plugin) => plugin.name === name),
      refresh: async (version?: string) => {
        requireManager()
        await adapter.command<void>({ type: 'plugin.refresh' })
        return runtime.getPluginSnapshotForTui()!
      },
      setEnabledMany: async (scope: PluginScope, states: ReadonlyMap<string, boolean>) => {
        requireManager()
        await adapter.command<void>({ type: 'plugin.set_enabled_many', scope, states: Object.fromEntries(states) })
        return runtime.getPluginSnapshotForTui()!
      },
    } as TuiPluginManager
  }

  private onRuntimeEvent(event: RuntimeEvent): void {
    if (event.type !== 'permission.requested') return
    if (event.request.kind === 'tool' && !this.permissionPrompt || event.request.kind === 'question' && !this.questionPrompt) {
      this.queuedPermissionEvents.push(event)
      return
    }
    void this.resolvePermissionEvent(event)
  }

  private async resolvePermissionEvent(event: Extract<RuntimeEvent, { type: 'permission.requested' }>): Promise<void> {
    const { request } = event
    let decision: 'allow' | 'deny' = 'deny'
    let answers: Readonly<Record<string, string>> | undefined
    let block = false
    try {
      if (request.kind === 'question') {
        const result = await this.questionPrompt?.(request.toolName, { ...request.input })
        answers = result?.answers
        block = Boolean(result?.block)
        decision = block ? 'deny' : 'allow'
      } else {
        const allowed = await this.permissionPrompt?.(request.toolName, { ...request.input }, request.description ?? request.toolName)
        decision = allowed ? 'allow' : 'deny'
      }
    } catch {
      decision = 'deny'
      block = true
    }
    await this.command<void>({ type: 'permission.respond', requestId: request.requestId, decision, answers, block })
  }
}

export type { AgentClient as TuiAgentClient }

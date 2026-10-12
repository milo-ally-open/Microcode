import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { MicrocodeAgent } from '../agent/MicrocodeAgent.ts'
import type { MicrocodeAgentEvent, MicrocodeAgentSnapshot, MessageUsageResetMode } from '../agent/types.ts'
import type { PermissionMode } from '../permissions/types.ts'
import type { SessionManager, SessionListItem } from '../session/SessionManager.ts'
import type { McpClientManager } from '../mcp/client.ts'
import type { McpServerConfig, McpServerState } from '../mcp/types.ts'
import { discoverMcpCapabilities } from '../mcp/capabilities.ts'
import type { PluginManager } from '../plugins/PluginManager.ts'
import type { PluginRecord, PluginScope, PluginSnapshot } from '../plugins/types.ts'
import { RUNTIME_PROTOCOL_VERSION } from './protocol.ts'
import type {
  RuntimeCommand,
  RuntimeCommandEnvelope,
  RuntimeCommandResponse,
  RuntimeConnection,
  RuntimeEvent,
  RuntimeEventListener,
  RuntimePermissionRequest,
  RuntimeEventInput,
  RuntimeErrorCode,
  RuntimeMcpServerSnapshot,
  RuntimePluginSnapshot,
  RuntimeQuery,
  RuntimeSnapshot,
  RuntimeSessionSnapshot,
} from './protocol.ts'

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

interface PendingPermission {
  request: RuntimePermissionRequest
  deferred: Deferred<{ allowed: boolean; answers?: Readonly<Record<string, string>>; block?: boolean }>
}

class RuntimeCommandError extends Error {
  constructor(readonly code: 'agent_busy' | 'session_not_found' | 'session_project_mismatch', message: string) {
    super(message)
    this.name = 'RuntimeCommandError'
  }
}

export interface ApplicationRuntimeOptions {
  readonly cwd: string
  readonly agent: MicrocodeAgent
  readonly sessions: SessionManager
  readonly mcp?: McpClientManager
  readonly plugins?: PluginManager
  readonly onClosed?: (sessionId: string | null) => void | Promise<void>
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isPermissionEvent(event: MicrocodeAgentEvent): boolean {
  return event.type === 'permission_requested' || event.type === 'permission_resolved'
}

/**
 * Application-level owner for one project context. It coordinates the existing
 * MicrocodeAgent, session repository, MCP manager, and plugin manager.
 */
export class ApplicationRuntime {
  private readonly listeners = new Set<RuntimeEventListener>()
  private readonly pendingPermissions = new Map<string, PendingPermission>()
  private readonly unsubscribeAgent: () => void
  private nextSequence = 0
  private nextPermissionId = 0
  private lifecycle: RuntimeSnapshot['lifecycle'] = 'ready'
  private promptActive = false
  private promptAborted = false
  private closePromise?: Promise<void>
  private readonly activeMcpNames = new Set<string>()
  private standaloneMcpConfigs: Record<string, McpServerConfig> = {}
  private pendingMcpSync = false
  private lastPluginSnapshot?: PluginSnapshot

  constructor(private readonly options: ApplicationRuntimeOptions) {
    this.lastPluginSnapshot = options.plugins?.getSnapshot()
    this.unsubscribeAgent = options.agent.subscribe((event) => this.onAgentEvent(event))
    options.agent.setPermissionRequestHandler((toolName, input, description) =>
      this.waitForPermission('tool', toolName, input, description),
    )
    options.agent.setAskUserQuestionHandler((toolName, input) =>
      this.waitForQuestion(toolName, input),
    )
  }

  get projectDirectory(): string {
    return this.options.cwd
  }

  get sequence(): number {
    return this.nextSequence
  }

  get isClosed(): boolean {
    return this.lifecycle === 'closed'
  }

  subscribe(listener: RuntimeEventListener, options: { sessionId?: string } = {}): () => void {
    this.assertOpen()
    const sessionId = options.sessionId
    const filtered = sessionId
      ? (event: RuntimeEvent) => { if (event.sessionId === sessionId) listener(event) }
      : listener
    this.listeners.add(filtered)
    return () => { this.listeners.delete(filtered) }
  }

  subscribeWithSnapshot(listener: RuntimeEventListener, options: { sessionId?: string } = {}): RuntimeConnection {
    // Both operations are synchronous on the runtime's event loop. Subscribing
    // first and capturing the snapshot second makes any intervening event
    // detectable by comparing its sequence with the returned snapshot.
    const unsubscribe = this.subscribe(listener, options)
    return Object.freeze({ snapshot: this.getSnapshot(), unsubscribe })
  }

  getSnapshot(): RuntimeSnapshot {
    const metadata = this.options.sessions.getMetadata()
    const session: RuntimeSessionSnapshot = Object.freeze({
      id: this.options.sessions.getSessionId(),
      metadata: metadata ? Object.freeze({ ...metadata }) : null,
      title: metadata ? this.options.sessions.getTitle(metadata.id) : undefined,
      draft: this.options.sessions.isDraft(),
    })
    return Object.freeze({
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      sequence: this.nextSequence,
      lifecycle: this.lifecycle,
      project: Object.freeze({ cwd: this.options.cwd }),
      session,
      agent: this.options.agent.getSnapshot(),
      messages: Object.freeze([...this.options.agent.getMessages()]),
      mcpServers: Object.freeze(this.safeMcpStates()),
      plugins: this.safePluginSnapshot(this.lastPluginSnapshot),
    })
  }

  query(query: RuntimeQuery): unknown {
    this.assertOpen()
    const { agent, sessions, mcp, plugins } = this.options
    switch (query.type) {
      case 'snapshot': return this.getSnapshot()
      case 'agent.messages': return Object.freeze([...agent.getMessages()])
      case 'agent.current_model': return agent.getCurrentModel()
      case 'agent.skills': return agent.getSkillSnapshot()
      case 'agent.skill_list': return agent.getSkills()
      case 'agent.skill_loaded': return agent.isSkillLoaded(query.name)
      case 'agent.project_instructions': return agent.getProjectInstructions()
      case 'agent.is_busy': return agent.isBusy() || this.promptActive
      case 'permission.check': return agent.checkPermission(query.toolName, { ...query.input })
      case 'session.metadata': return sessions.getMetadata()
      case 'session.id': return sessions.getSessionId()
      case 'session.title': return sessions.getTitle(query.sessionId)
      case 'sessions.list_tasks': return sessions.listTaskLists()
      case 'mcp.servers': return Object.freeze(this.safeMcpStates())
      case 'plugins.snapshot': return this.safePluginSnapshot(plugins?.getSnapshot() ?? this.lastPluginSnapshot)
      case 'plugins.list': return Object.freeze((plugins?.getPlugins() ?? []).map((plugin) => this.safePluginRecord(plugin)))
    }
  }

  async dispatch(envelope: RuntimeCommandEnvelope): Promise<RuntimeCommandResponse> {
    if (envelope.protocolVersion !== undefined && envelope.protocolVersion !== RUNTIME_PROTOCOL_VERSION) {
      return this.failure(envelope.commandId, 'protocol_version_mismatch', `Runtime protocol version ${RUNTIME_PROTOCOL_VERSION} is required.`)
    }
    if (this.lifecycle !== 'ready' && envelope.command.type !== 'runtime.close') {
      return this.failure(envelope.commandId, 'runtime_closed', 'Runtime is closing or closed.')
    }
    try {
      const result = await this.execute(envelope.command)
      return { protocolVersion: RUNTIME_PROTOCOL_VERSION, commandId: envelope.commandId, ok: true, result }
    } catch (error) {
      const code = error instanceof RuntimeCommandError
        ? error.code
        : this.lifecycle === 'ready' ? 'command_failed' : 'runtime_closed'
      return this.failure(envelope.commandId, code, errorMessage(error))
    }
  }

  async configureMcpServers(configs: Readonly<Record<string, McpServerConfig>>): Promise<void> {
    this.assertOpen()
    this.standaloneMcpConfigs = { ...configs }
    await this.reconcileMcpServers()
  }

  async refreshCapabilities(): Promise<{ diagnostics: readonly string[]; servers: readonly RuntimeMcpServerSnapshot[] }> {
    this.assertOpen()
    const discovered = await discoverMcpCapabilities(this.options.cwd)
    this.standaloneMcpConfigs = { ...discovered.configs }
    await this.reconcileMcpServers()
    const diagnostics = [...discovered.diagnostics]
    for (const name of Object.keys(this.lastPluginSnapshot?.mcpServers ?? {})) {
      if (Object.hasOwn(discovered.configs, name)) diagnostics.push(`Plugin MCP server "${name}" conflicts with a configured MCP server; plugin server skipped.`)
    }
    return { diagnostics: Object.freeze(diagnostics), servers: Object.freeze(this.safeMcpStates()) }
  }

  async refreshPlugins(): Promise<PluginSnapshot | undefined> {
    this.assertOpen()
    const manager = this.options.plugins
    if (!manager) return undefined
    const snapshot = await manager.refresh()
    await this.applyPluginSnapshot(snapshot)
    return snapshot
  }

  async setPluginsEnabled(scope: PluginScope, states: Readonly<Record<string, boolean>>): Promise<PluginSnapshot | undefined> {
    this.assertOpen()
    const manager = this.options.plugins
    if (!manager) return undefined
    if (this.options.agent.isBusy()) throw new RuntimeCommandError('agent_busy', 'Agent is busy; the requested operation cannot run yet.')
    const snapshot = await manager.setEnabledMany(scope, new Map(Object.entries(states)))
    await this.applyPluginSnapshot(snapshot)
    return snapshot
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    if (this.lifecycle === 'closed') return
    this.lifecycle = 'closing'
    this.closePromise = Promise.resolve().then(() => this.closeResources())
    this.publish({ type: 'runtime.lifecycle', state: 'closing' })
    return this.closePromise
  }

  private async execute(command: RuntimeCommand): Promise<unknown> {
    const { agent, sessions, mcp, plugins } = this.options
    switch (command.type) {
      case 'session.begin_draft': {
        this.assertNotBusy()
        sessions.beginDraft(command.cwd ?? this.options.cwd)
        agent.clearMessages()
        this.publish({ type: 'session.changed', session: this.getSnapshot().session })
        return this.getSnapshot().session
      }
      case 'session.ensure_created': {
        const id = await sessions.ensureCreated(command.cwd)
        this.publish({ type: 'session.changed', session: this.getSnapshot().session })
        return id
      }
      case 'session.select': {
        this.assertNotBusy()
        const candidates = await sessions.list()
        const target = candidates.find((item) => item.id === command.sessionId)
        if (!target) throw new RuntimeCommandError('session_not_found', `Session not found: ${command.sessionId}`)
        if (target.cwd !== this.options.cwd) throw new RuntimeCommandError('session_project_mismatch', `Session belongs to a different project: ${target.cwd}`)
        await agent.persistMessages()
        const messages = await sessions.switchToSession(target)
        agent.replaceMessages(messages, 'rebuild')
        this.publish({ type: 'session.changed', session: this.getSnapshot().session })
        return Object.freeze([...messages])
      }
      case 'session.resume': {
        this.assertNotBusy()
        const candidates = await sessions.list(command.cwd ?? this.options.cwd)
        const target = command.sessionId
          ? candidates.find((item) => item.id === command.sessionId || item.id.startsWith(command.sessionId!))
          : candidates[0]
        if (!target) {
          if (command.sessionId) throw new RuntimeCommandError('session_not_found', `Session not found: ${command.sessionId}`)
          return null
        }
        if (target.cwd !== this.options.cwd) throw new RuntimeCommandError('session_project_mismatch', `Session belongs to a different project: ${target.cwd}`)
        const messages = await sessions.open(target)
        agent.replaceMessages(messages, 'rebuild')
        this.publish({ type: 'session.changed', session: this.getSnapshot().session })
        return Object.freeze({ session: this.getSnapshot().session, messages: Object.freeze([...messages]) })
      }
      case 'session.list': return command.withTitles ? sessions.listWithTitles(command.cwd) : sessions.list(command.cwd)
      case 'session.set_title':
        sessions.setTitle(command.sessionId, command.title)
        if (sessions.getSessionId() === command.sessionId) this.publish({ type: 'session.changed', session: this.getSnapshot().session })
        return undefined
      case 'session.list_tasks': return sessions.listTaskLists()
      case 'session.remind_task': return sessions.remindTask(command.listId, command.taskId, command.reminder)
      case 'agent.prompt': {
        this.assertNotBusy()
        await sessions.ensureCreated(this.options.cwd)
        this.promptActive = true
        this.promptAborted = false
        this.publish({ type: 'prompt.started' })
        let failed: unknown
        try {
          if (typeof command.prompt === 'string') await agent.prompt(command.prompt, command.images ? [...command.images] : undefined)
          else await agent.prompt(command.prompt as AgentMessage | AgentMessage[])
        } catch (error) {
          failed = error
          throw error
        } finally {
          this.promptActive = false
          this.publish({ type: 'prompt.completed', aborted: this.promptAborted })
          await this.applyQueuedMcpSync()
        }
        return failed === undefined ? agent.getSnapshot() : undefined
      }
      case 'agent.prompt_read_only':
        this.assertNotBusy()
        await sessions.ensureCreated(this.options.cwd)
        this.promptActive = true
        this.promptAborted = false
        this.publish({ type: 'prompt.started' })
        try { await agent.promptReadOnly(command.prompt) }
        finally {
          this.promptActive = false
          this.publish({ type: 'prompt.completed', aborted: this.promptAborted })
          await this.applyQueuedMcpSync()
        }
        return agent.getSnapshot()
      case 'agent.cancel':
        this.promptAborted = this.promptActive
        agent.abort()
        return undefined
      case 'agent.persist': return agent.persistMessages()
      case 'agent.clear_messages': agent.clearMessages(); return undefined
      case 'agent.replace_messages': agent.replaceMessages(command.messages, command.usageMode as MessageUsageResetMode | undefined); return undefined
      case 'agent.compact': return agent.compact(command.options)
      case 'agent.set_thinking_level': agent.setThinkingLevel(command.level); return undefined
      case 'agent.refresh_system_prompt': agent.refreshSystemPrompt(); return undefined
      case 'model.switch': return agent.switchModel(command.modelId, command.api, command.provider)
      case 'permission.respond': return this.respondToPermission(command.requestId, command.decision, command.answers, command.block)
      case 'permission.set_mode': agent.setPermissionMode(command.mode); return undefined
      case 'permission.add_session_rule': agent.addSessionPermission(command.toolName, command.ruleContent); return undefined
      case 'permission.request': return this.waitForPermission('tool', command.toolName, command.input, command.description)
      case 'skill.load': agent.loadSkill(command.name); return undefined
      case 'skill.unload': agent.unloadSkill(command.name); return undefined
      case 'project.instructions.update': agent.updateProjectInstructions(command.instructions); return undefined
      case 'mcp.sync': this.syncAgentMcpState(); return undefined
      case 'mcp.remove': {
        const removed = await mcp?.removeServer(command.name) ?? false
        this.syncAgentMcpState()
        return removed
      }
      case 'plugin.refresh': {
        const snapshot = await this.refreshPlugins()
        return this.safePluginSnapshot(snapshot)
      }
      case 'plugin.set_enabled_many': {
        const snapshot = await this.setPluginsEnabled(command.scope, command.states)
        return this.safePluginSnapshot(snapshot)
      }
      case 'runtime.close': await this.close(); return undefined
    }
  }

  private async onAgentEvent(event: MicrocodeAgentEvent): Promise<void> {
    if (isPermissionEvent(event)) return
    this.publish({ type: 'agent.event', event })
    if (event.type === 'turn_end') {
      try { await this.options.agent.persistMessages() } catch { /* The TUI has historically kept the active turn on save errors. */ }
    }
    if (event.type === 'agent_end' || event.type === 'turn_end') void this.applyQueuedMcpSync()
  }

  private waitForPermission(
    kind: 'tool',
    toolName: string,
    input: Record<string, unknown>,
    description: string,
  ): Promise<boolean> {
    return this.createPendingPermission(kind, toolName, input, description).then((result) => result.allowed)
  }

  private waitForQuestion(toolName: string, input: Record<string, unknown>): Promise<{ answers?: Record<string, string>; block?: boolean }> {
    return this.createPendingPermission('question', toolName, input).then((result) => ({ answers: result.answers as Record<string, string> | undefined, block: result.block }))
  }

  private async createPendingPermission(
    kind: 'tool' | 'question',
    toolName: string,
    input: Readonly<Record<string, unknown>>,
    description?: string,
  ): Promise<{ allowed: boolean; answers?: Readonly<Record<string, string>>; block?: boolean }> {
    const requestId = `permission-${++this.nextPermissionId}`
    const request: RuntimePermissionRequest = Object.freeze({
      requestId,
      sessionId: this.options.sessions.getSessionId(),
      kind,
      toolName,
      input: Object.freeze({ ...input }),
      description,
    })
    const pending = { request, deferred: deferred<{ allowed: boolean; answers?: Readonly<Record<string, string>>; block?: boolean }>() }
    this.pendingPermissions.set(requestId, pending)
    this.publish({ type: 'permission.requested', request })
    return pending.deferred.promise.finally(() => this.pendingPermissions.delete(requestId))
  }

  private respondToPermission(
    requestId: string,
    decision: 'allow' | 'allow_session' | 'deny',
    answers?: Readonly<Record<string, string>>,
    block?: boolean,
  ): { requestId: string; accepted: boolean } {
    const pending = this.pendingPermissions.get(requestId)
    if (!pending) return { requestId, accepted: false }
    if (decision === 'allow_session') {
      this.options.agent.addSessionPermission(pending.request.toolName)
    }
    const allowed = pending.request.kind === 'question' ? !(block ?? decision === 'deny') : decision !== 'deny'
    pending.deferred.resolve({ allowed, answers, block: block ?? !allowed })
    this.publish({ type: 'permission.resolved', requestId, allowed, answers })
    return { requestId, accepted: true }
  }

  private async applyPluginSnapshot(snapshot: PluginSnapshot): Promise<void> {
    this.lastPluginSnapshot = snapshot
    this.options.agent.setPluginSkills(
      [...snapshot.skills],
      [...snapshot.diagnostics, ...snapshot.plugins.flatMap((plugin) => plugin.diagnostics.map((diagnostic) => `${plugin.name}: ${diagnostic}`))],
    )
    const discovered = await discoverMcpCapabilities(this.options.cwd)
    this.standaloneMcpConfigs = { ...discovered.configs }
    await this.reconcileMcpServers()
    this.publish({ type: 'plugins.changed', plugins: this.safePluginSnapshot(snapshot)! })
  }

  private async reconcileMcpServers(): Promise<void> {
    const { mcp, plugins } = this.options
    if (!mcp) return
    const pluginSnapshot = this.lastPluginSnapshot ?? plugins?.getSnapshot()
    const desired = { ...this.standaloneMcpConfigs }
    for (const [name, config] of Object.entries(pluginSnapshot?.mcpServers ?? {})) {
      if (!Object.hasOwn(desired, name)) desired[name] = config
    }
    for (const name of this.activeMcpNames) {
      if (!Object.hasOwn(desired, name)) {
        await mcp.removeServer(name)
        this.activeMcpNames.delete(name)
      }
    }
    const toConnect: Array<[string, McpServerConfig]> = []
    for (const [name, config] of Object.entries(desired)) {
      const current = mcp.getServer(name)
      if (current && JSON.stringify(current.config) === JSON.stringify(config) && current.status !== 'disconnected' && current.status !== 'disabled') {
        this.activeMcpNames.add(name)
      } else {
        toConnect.push([name, config])
      }
    }
    await Promise.allSettled(toConnect.map(async ([name, config]) => {
      await mcp.connectServer(name, config)
      this.activeMcpNames.add(name)
    }))
    this.syncAgentMcpState()
  }

  private syncAgentMcpState(): void {
    if (this.options.agent.isBusy() || this.promptActive) {
      this.pendingMcpSync = true
      return
    }
    this.pendingMcpSync = false
    if (this.options.mcp) this.options.agent.configureMcpTools(this.options.mcp)
    this.options.agent.updateMcpServers(this.options.mcp?.getServerStates())
    this.publish({ type: 'mcp.changed', servers: Object.freeze(this.safeMcpStates()) })
  }

  private async applyQueuedMcpSync(): Promise<void> {
    if (!this.pendingMcpSync || this.options.agent.isBusy() || this.promptActive) return
    this.syncAgentMcpState()
  }

  getMcpStatesForTui(): McpServerState[] {
    return [...(this.options.mcp?.getServerStates() ?? [])]
  }

  getPluginSnapshotForTui(): PluginSnapshot | undefined {
    return this.options.plugins?.getSnapshot() ?? this.lastPluginSnapshot
  }

  private safeMcpStates(): RuntimeMcpServerSnapshot[] {
    return (this.options.mcp?.getServerStates() ?? []).map((server) => Object.freeze({
      name: server.name,
      status: server.status,
      error: server.status === 'failed' ? 'Connection failed. Inspect the local server configuration and logs.' : undefined,
      tools: Object.freeze(server.tools.map((tool) => Object.freeze({ ...tool }))),
      resources: Object.freeze(server.resources.map((resource) => Object.freeze({ ...resource }))),
      instructions: server.instructions,
      // Server config may contain bearer tokens and environment secrets.
    }))
  }

  private safePluginRecord(plugin: PluginRecord): RuntimePluginSnapshot['plugins'][number] {
    return Object.freeze({
      ...plugin,
      skills: Object.freeze(plugin.skills.map((skill) => ({ name: skill.name, description: skill.description }))),
      servers: Object.freeze(plugin.servers.map(({ pluginName, scope, sourcePath, name, qualifiedName, transport, safeCommandSummary }) => ({ pluginName, scope, sourcePath, name, qualifiedName, transport, safeCommandSummary }))),
      diagnostics: Object.freeze([...plugin.diagnostics]),
    })
  }

  private safePluginSnapshot(snapshot?: PluginSnapshot): RuntimePluginSnapshot | null {
    if (!snapshot) return null
    return Object.freeze({
      plugins: Object.freeze(snapshot.plugins.map((plugin) => this.safePluginRecord(plugin))),
      skills: Object.freeze(snapshot.skills.map((skill) => ({ name: skill.name, description: skill.description }))),
      diagnostics: Object.freeze([...snapshot.diagnostics]),
    })
  }

  private publish(event: RuntimeEventInput): void {
    const runtimeEvent = Object.freeze({
      ...event,
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      sequence: ++this.nextSequence,
      emittedAt: Date.now(),
      sessionId: this.options.sessions.getSessionId(),
    }) as RuntimeEvent
    for (const listener of [...this.listeners]) {
      try { listener(runtimeEvent) } catch { /* One adapter cannot break runtime work. */ }
    }
  }

  private async closeResources(): Promise<void> {
    const errors: string[] = []
    const sessionId = this.options.sessions.getSessionId()
    this.promptAborted = this.promptActive
    this.options.agent.abort()
    for (const [requestId, pending] of this.pendingPermissions) {
      pending.deferred.resolve({ allowed: false, block: true })
      this.publish({ type: 'permission.resolved', requestId, allowed: false })
    }
    try { await this.options.agent.waitForIdle() } catch (error) { errors.push(errorMessage(error)) }
    try { await this.options.agent.persistMessages() } catch (error) { errors.push(errorMessage(error)) }
    try { await this.options.mcp?.disconnectAll() } catch (error) { errors.push(errorMessage(error)) }
    try { await this.options.sessions.close() } catch (error) { errors.push(errorMessage(error)) }
    try { await this.options.onClosed?.(sessionId) } catch (error) { errors.push(errorMessage(error)) }
    this.unsubscribeAgent()
    this.lifecycle = 'closed'
    this.publish({ type: 'runtime.lifecycle', state: 'closed' })
    if (errors.length > 0) throw new Error(`Runtime closed with cleanup errors: ${errors.join('; ')}`)
  }

  private assertOpen(): void {
    if (this.lifecycle !== 'ready') throw new Error('Runtime is closing or closed.')
  }

  private assertNotBusy(): void {
    this.assertOpen()
    if (this.options.agent.isBusy() || this.promptActive) throw new RuntimeCommandError('agent_busy', 'Agent is busy; the requested operation cannot run yet.')
  }

  private failure(commandId: string, code: RuntimeErrorCode, message: string): RuntimeCommandResponse {
    return { protocolVersion: RUNTIME_PROTOCOL_VERSION, commandId, ok: false, error: { code, message } }
  }
}

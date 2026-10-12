import * as acp from '@agentclientprotocol/sdk'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { ImageContent as PiImageContent, TextContent as PiTextContent } from '@earendil-works/pi-ai'
import { isAbsolute, resolve } from 'node:path'
import type { ApplicationRuntime } from '../runtime/ApplicationRuntime.ts'
import type { RuntimeCommand, RuntimeEvent, RuntimePermissionRequest } from '../runtime/protocol.ts'
import type { McpServerConfig } from '../mcp/types.ts'

export interface AcpRuntimeBundle {
  readonly runtime: ApplicationRuntime
  readonly mcpServers: Readonly<Record<string, McpServerConfig>>
}

export interface AcpAgentOptions {
  readonly version: string
  readonly createRuntime: (cwd: string) => Promise<AcpRuntimeBundle>
  readonly permissionTimeoutMs?: number
}

interface SessionBinding {
  readonly externalSessionId: string
  readonly internalSessionId: string
  readonly project: ProjectRuntime
  readonly mcpServers: Readonly<Record<string, McpServerConfig>>
}

interface ActivePrompt {
  readonly binding: SessionBinding
  readonly client: acp.AgentContext
  readonly emitter: PromptEmitter
  readonly requestSignal: AbortSignal
  readonly toolCallIds: Set<string>
  messageId: string
  cancelled: boolean
}

interface PendingPermission {
  readonly sessionId: string
  readonly controller: AbortController
}

interface ProjectRuntime extends AcpRuntimeBundle {
  readonly cwd: string
  unsubscribe: () => void
  readonly sessions: Map<string, SessionBinding>
  readonly pendingPermissions: Map<string, PendingPermission>
  activePrompt?: ActivePrompt
}

class PromptEmitter {
  private queue: Promise<void> = Promise.resolve()
  private firstFailure: unknown

  constructor(private readonly client: acp.AgentContext) {}

  send<T>(operation: () => Promise<T> | T): Promise<T> {
    const pending = this.queue.then(() => {
      if (this.firstFailure !== undefined) throw this.firstFailure
      return operation()
    })
    this.queue = pending.then(
      () => undefined,
      (error) => {
        this.firstFailure ??= error
      },
    )
    return pending
  }

  sendRequest<T>(operation: () => Promise<T>): Promise<T> {
    let response: Promise<T> | undefined
    const scheduled = this.queue.then(() => {
      if (this.firstFailure !== undefined) throw this.firstFailure
      response = operation()
    })
    this.queue = scheduled.then(
      () => undefined,
      (error) => {
        this.firstFailure ??= error
      },
    )
    return scheduled.then(() => {
      if (!response) throw new Error('ACP request was not sent.')
      return response
    })
  }

  update(sessionId: string, update: acp.SessionUpdate): Promise<void> {
    return this.send(() => this.client.notify('session/update', { sessionId, update }))
  }

  async flush(): Promise<void> {
    await this.queue
    if (this.firstFailure !== undefined) throw this.firstFailure
  }
}

export class AcpAgentAdapter {
  readonly app: acp.AgentApp
  private readonly projects = new Map<string, ProjectRuntime>()
  private readonly pendingProjects = new Map<string, Promise<ProjectRuntime>>()
  private readonly sessions = new Map<string, SessionBinding>()
  private initialized = false
  private closed = false
  private commandNumber = 0

  constructor(private readonly options: AcpAgentOptions) {
    this.app = acp.agent({ name: 'microcode' })
      .onRequest('initialize', ({ params }) => {
        this.initialized = true
        return {
          // ACP negotiates by having the agent return its newest supported major version.
          protocolVersion: acp.PROTOCOL_VERSION,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: true },
            mcpCapabilities: { http: true, sse: true },
          },
          agentInfo: {
            name: 'microcode',
            title: 'Microcode',
            version: this.options.version,
          },
        } satisfies acp.InitializeResponse
      })
      .onRequest('session/new', async ({ params }) => this.newSession(params))
      .onRequest('session/load', async ({ params, client }) => this.loadSession(params, client))
      .onRequest('session/prompt', async ({ params, client, signal }) => this.prompt(params, client, signal))
      .onNotification('session/cancel', async ({ params }) => this.cancel(params.sessionId))
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await Promise.allSettled([...this.pendingProjects.values()])
    await Promise.allSettled([...this.projects.values()].map(async (project) => {
      project.activePrompt && this.abortPendingPermissions(project, project.activePrompt.binding.internalSessionId)
      project.unsubscribe()
      await project.runtime.close()
    }))
    this.projects.clear()
    this.sessions.clear()
  }

  private assertInitialized(): void {
    if (!this.initialized) throw acp.RequestError.invalidRequest(undefined, 'Call initialize before creating an ACP session.')
    if (this.closed) throw acp.RequestError.internalError(undefined, 'The ACP agent is shutting down.')
  }

  private validateCwd(cwd: string): string {
    if (!isAbsolute(cwd)) throw acp.RequestError.invalidParams(undefined, 'The ACP session cwd must be an absolute path.')
    return resolve(cwd)
  }

  private rejectAdditionalDirectories(paths: readonly string[] | undefined): void {
    if (paths && paths.length > 0) {
      throw acp.RequestError.invalidParams(undefined, 'Microcode ACP sessions do not support additionalDirectories.')
    }
  }

  private async project(cwd: string): Promise<ProjectRuntime> {
    const existing = this.projects.get(cwd)
    if (existing) return existing
    const pending = this.pendingProjects.get(cwd)
    if (pending) return pending
    if (this.closed) throw acp.RequestError.internalError(undefined, 'The ACP agent is shutting down.')

    const create = this.options.createRuntime(cwd).then(async (bundle) => {
      if (this.closed) {
        await bundle.runtime.close()
        throw acp.RequestError.internalError(undefined, 'The ACP agent is shutting down.')
      }
      const project = {
        ...bundle,
        cwd,
        sessions: new Map<string, SessionBinding>(),
        pendingPermissions: new Map<string, PendingPermission>(),
        unsubscribe: () => undefined,
      } as ProjectRuntime
      project.unsubscribe = bundle.runtime.subscribe((event) => this.onRuntimeEvent(project, event))
      this.projects.set(cwd, project)
      return project
    }).finally(() => this.pendingProjects.delete(cwd))
    this.pendingProjects.set(cwd, create)
    return create
  }

  private async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    this.assertInitialized()
    this.rejectAdditionalDirectories(params.additionalDirectories)
    const cwd = this.validateCwd(params.cwd)
    const project = await this.project(cwd)
    const mcpServers = convertMcpServers(params.mcpServers, cwd)
    this.checkMcpNameConflicts(project, mcpServers)

    const currentSessionId = project.runtime.getSnapshot().session.id
    if (currentSessionId !== null) {
      if (project.runtime.query({ type: 'agent.is_busy' })) {
        throw new acp.RequestError(-32000, 'Microcode is already processing a prompt for this project.')
      }
      await this.dispatch(project, { type: 'agent.persist' })
      await this.dispatch(project, { type: 'session.begin_draft', cwd })
    }
    const internalSessionId = await this.dispatch<string>(project, { type: 'session.ensure_created', cwd })
    const binding: SessionBinding = {
      externalSessionId: internalSessionId,
      internalSessionId,
      project,
      mcpServers,
    }
    this.registerSession(binding)
    await this.activateMcpServers(binding)
    return { sessionId: binding.externalSessionId }
  }

  private async loadSession(params: acp.LoadSessionRequest, client: acp.AgentContext): Promise<acp.LoadSessionResponse> {
    this.assertInitialized()
    this.rejectAdditionalDirectories(params.additionalDirectories)
    const cwd = this.validateCwd(params.cwd)
    const current = this.sessions.get(params.sessionId)
    if (current && current.project.cwd !== cwd) {
      throw acp.RequestError.invalidParams(undefined, 'The session cwd does not match the stored Microcode session.')
    }
    const project = current?.project ?? await this.project(cwd)
    const mcpServers = convertMcpServers(params.mcpServers, cwd)
    this.checkMcpNameConflicts(project, mcpServers)

    if (project.runtime.getSnapshot().session.id !== params.sessionId) {
      await this.dispatch(project, { type: 'session.select', sessionId: params.sessionId })
    }
    const session = project.runtime.getSnapshot().session
    if (session.id !== params.sessionId) {
      throw acp.RequestError.resourceNotFound(params.sessionId)
    }
    const binding: SessionBinding = {
      externalSessionId: params.sessionId,
      internalSessionId: params.sessionId,
      project,
      mcpServers,
    }
    this.registerSession(binding)
    await this.activateMcpServers(binding)

    const emitter = new PromptEmitter(client)
    await this.replayHistory(binding, project.runtime.getSnapshot().messages, emitter)
    await emitter.flush()
    return {}
  }

  private async prompt(params: acp.PromptRequest, client: acp.AgentContext, signal: AbortSignal): Promise<acp.PromptResponse> {
    this.assertInitialized()
    const binding = this.sessions.get(params.sessionId)
    if (!binding) throw acp.RequestError.resourceNotFound(params.sessionId)
    const message = promptToUserMessage(params.prompt)
    await this.activate(binding)
    if (signal.aborted) throw acp.RequestError.requestCancelled()

    const active: ActivePrompt = {
      binding,
      client,
      emitter: new PromptEmitter(client),
      requestSignal: signal,
      toolCallIds: new Set(),
      messageId: crypto.randomUUID(),
      cancelled: false,
    }
    const unsubscribe = binding.project.runtime.subscribe(
      (event) => { void this.onPromptEvent(active, event).catch(() => undefined) },
      { sessionId: binding.internalSessionId },
    )
    binding.project.activePrompt = active
    const onAbort = () => { void this.cancelActive(active) }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      await this.dispatch(binding.project, { type: 'agent.prompt', prompt: message })
      await active.emitter.flush()
      const lastAssistant = [...binding.project.runtime.getSnapshot().messages].reverse().find((item) =>
        'role' in item && item.role === 'assistant',
      )
      if (active.cancelled || (lastAssistant && lastAssistant.role === 'assistant' && lastAssistant.stopReason === 'aborted')) {
        return { stopReason: 'cancelled' }
      }
      if (lastAssistant && lastAssistant.role === 'assistant' && lastAssistant.stopReason === 'length') {
        return { stopReason: 'max_tokens' }
      }
      if (lastAssistant && lastAssistant.role === 'assistant' && lastAssistant.stopReason === 'error') {
        throw new acp.RequestError(-32000, 'Microcode failed to complete the prompt.')
      }
      return { stopReason: 'end_turn' }
    } finally {
      signal.removeEventListener('abort', onAbort)
      unsubscribe()
      if (binding.project.activePrompt === active) binding.project.activePrompt = undefined
    }
  }

  private async activate(binding: SessionBinding): Promise<void> {
    const { project, internalSessionId } = binding
    if (project.runtime.query({ type: 'agent.is_busy' })) {
      throw new acp.RequestError(-32000, 'Microcode is already processing a prompt for this project.')
    }
    if (project.runtime.getSnapshot().session.id !== internalSessionId) {
      await this.dispatch(project, { type: 'session.select', sessionId: internalSessionId })
    }
    await this.activateMcpServers(binding)
  }

  private async activateMcpServers(binding: SessionBinding): Promise<void> {
    const merged: Record<string, McpServerConfig> = { ...binding.project.mcpServers, ...binding.mcpServers }
    await binding.project.runtime.configureMcpServers(merged)
  }

  private checkMcpNameConflicts(project: ProjectRuntime, incoming: Readonly<Record<string, McpServerConfig>>): void {
    for (const name of Object.keys(incoming)) {
      if (Object.hasOwn(project.mcpServers, name)) {
        throw acp.RequestError.invalidParams(undefined, `The ACP MCP server name "${name}" conflicts with a Microcode configured server.`)
      }
    }
  }

  private registerSession(binding: SessionBinding): void {
    const previous = this.sessions.get(binding.externalSessionId)
    if (previous && previous.project !== binding.project) {
      throw acp.RequestError.invalidParams(undefined, 'The ACP session ID is already mapped to another project.')
    }
    this.sessions.set(binding.externalSessionId, binding)
    binding.project.sessions.set(binding.externalSessionId, binding)
  }

  private async cancel(sessionId: string): Promise<void> {
    const binding = this.sessions.get(sessionId)
    if (!binding) return
    const active = binding.project.activePrompt
    if (!active || active.binding.internalSessionId !== binding.internalSessionId) return
    await this.cancelActive(active)
  }

  private async cancelActive(active: ActivePrompt): Promise<void> {
    if (active.cancelled) return
    active.cancelled = true
    this.abortPendingPermissions(active.binding.project, active.binding.internalSessionId)
    await this.dispatch(active.binding.project, { type: 'agent.cancel' }).catch(() => undefined)
  }

  private abortPendingPermissions(project: ProjectRuntime, sessionId: string): void {
    for (const pending of project.pendingPermissions.values()) {
      if (pending.sessionId === sessionId) pending.controller.abort(new Error('ACP prompt cancelled.'))
    }
  }

  private onRuntimeEvent(project: ProjectRuntime, event: RuntimeEvent): void {
    if (event.type !== 'permission.requested') return
    const active = project.activePrompt
    if (!active || event.sessionId !== active.binding.internalSessionId || event.request.kind !== 'tool') {
      void this.respondToPermission(project, event.request, 'deny', undefined, true)
      return
    }
    void this.requestPermission(active, event.request).catch(() => {
      void this.respondToPermission(project, event.request, 'deny', undefined, true)
    })
  }

  private async requestPermission(active: ActivePrompt, request: RuntimePermissionRequest): Promise<void> {
    const project = active.binding.project
    const controller = new AbortController()
    const pending: PendingPermission = { sessionId: active.binding.internalSessionId, controller }
    project.pendingPermissions.set(request.requestId, pending)
    const timeout = setTimeout(
      () => controller.abort(new Error('ACP permission request timed out.')),
      Math.max(1, this.options.permissionTimeoutMs ?? 120_000),
    )
    let onAbort!: () => void
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(controller.signal.reason ?? new Error('ACP permission request was cancelled.'))
      controller.signal.addEventListener('abort', onAbort, { once: true })
      if (controller.signal.aborted) onAbort()
    })

    try {
      const response = await Promise.race([
        active.emitter.sendRequest(() => {
          if (controller.signal.aborted) throw controller.signal.reason
          return active.client.request('session/request_permission', {
            sessionId: active.binding.externalSessionId,
            toolCall: {
              toolCallId: request.requestId,
              title: request.description ?? request.toolName,
              name: request.toolName,
              kind: toolKind(request.toolName),
              status: 'pending',
              rawInput: { ...request.input },
            },
            options: [
              { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'allow_always', name: 'Allow for this session', kind: 'allow_always' },
              { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
            ],
          }, { cancellationSignal: controller.signal })
        }),
        aborted,
      ])
      const selected = response.outcome.outcome === 'selected' ? response.outcome.optionId : undefined
      const decision = selected === 'allow_once' ? 'allow'
        : selected === 'allow_always' ? 'allow_session'
          : 'deny'
      await this.respondToPermission(project, request, decision)
    } catch {
      await this.respondToPermission(project, request, 'deny', undefined, true)
    } finally {
      clearTimeout(timeout)
      controller.signal.removeEventListener('abort', onAbort)
      project.pendingPermissions.delete(request.requestId)
    }
  }

  private async respondToPermission(
    project: ProjectRuntime,
    request: RuntimePermissionRequest,
    decision: 'allow' | 'allow_session' | 'deny',
    answers?: Readonly<Record<string, string>>,
    block?: boolean,
  ): Promise<void> {
    await this.dispatch(project, {
      type: 'permission.respond',
      requestId: request.requestId,
      decision,
      answers,
      block,
    }).catch(() => undefined)
  }

  private async onPromptEvent(active: ActivePrompt, event: RuntimeEvent): Promise<void> {
    if (event.type !== 'agent.event') return
    const agentEvent = event.event
    if (agentEvent.type === 'message_start') {
      if ('role' in agentEvent.message && agentEvent.message.role === 'assistant') {
        active.messageId = crypto.randomUUID()
      }
      return
    }
    if (agentEvent.type === 'message_update') {
      const streamed = agentEvent.assistantMessageEvent
      if (streamed.type === 'text_delta' && streamed.delta.length > 0) {
        await active.emitter.update(active.binding.externalSessionId, {
          sessionUpdate: 'agent_message_chunk',
          messageId: active.messageId,
          content: { type: 'text', text: streamed.delta },
        })
      } else if (streamed.type === 'toolcall_end') {
        const toolCall = streamed.toolCall
        active.toolCallIds.add(toolCall.id)
        await active.emitter.update(active.binding.externalSessionId, {
          sessionUpdate: 'tool_call',
          toolCallId: toolCall.id,
          title: toolCall.name,
          name: toolCall.name,
          kind: toolKind(toolCall.name),
          status: 'pending',
          rawInput: toolCall.arguments,
        })
      }
      return
    }
    if (agentEvent.type === 'tool_execution_start') {
      const alreadyReported = active.toolCallIds.has(agentEvent.toolCallId)
      active.toolCallIds.add(agentEvent.toolCallId)
      if (alreadyReported) {
        await active.emitter.update(active.binding.externalSessionId, {
          sessionUpdate: 'tool_call_update',
          toolCallId: agentEvent.toolCallId,
          status: 'in_progress',
        })
      } else {
        await active.emitter.update(active.binding.externalSessionId, {
          sessionUpdate: 'tool_call',
          toolCallId: agentEvent.toolCallId,
          title: agentEvent.toolName,
          name: agentEvent.toolName,
          kind: toolKind(agentEvent.toolName),
          status: 'in_progress',
          rawInput: agentEvent.args,
        })
      }
      return
    }
    if (agentEvent.type === 'tool_execution_update') {
      const content = toolContent(agentEvent.partialResult)
      await active.emitter.update(active.binding.externalSessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: agentEvent.toolCallId,
        status: 'in_progress',
        ...(content.length ? { content } : {}),
      })
      return
    }
    if (agentEvent.type === 'tool_execution_end') {
      active.toolCallIds.add(agentEvent.toolCallId)
      const content = toolContent(agentEvent.result)
      await active.emitter.update(active.binding.externalSessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: agentEvent.toolCallId,
        status: agentEvent.isError ? 'failed' : 'completed',
        ...(content.length ? { content } : {}),
      })
      return
    }
    if (agentEvent.type === 'message_end' && 'role' in agentEvent.message && agentEvent.message.role === 'assistant') {
      active.messageId = crypto.randomUUID()
    }
  }

  private async replayHistory(
    binding: SessionBinding,
    messages: readonly AgentMessage[],
    emitter: PromptEmitter,
  ): Promise<void> {
    const reportedToolCalls = new Set<string>()
    for (const message of messages) {
      if (!('role' in message)) continue
      if (message.role === 'user') {
        const content = typeof message.content === 'string'
          ? [{ type: 'text', text: message.content } satisfies acp.ContentBlock]
          : message.content.flatMap((block) => piContentToAcp(block))
        const messageId = crypto.randomUUID()
        for (const block of content) {
          await emitter.update(binding.externalSessionId, { sessionUpdate: 'user_message_chunk', messageId, content: block })
        }
      } else if (message.role === 'assistant') {
        const messageId = crypto.randomUUID()
        for (const block of message.content) {
          if (block.type === 'text' && block.text) {
            await emitter.update(binding.externalSessionId, {
              sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text: block.text },
            })
          } else if (block.type === 'toolCall') {
            reportedToolCalls.add(block.id)
            await emitter.update(binding.externalSessionId, {
              sessionUpdate: 'tool_call',
              toolCallId: block.id,
              title: block.name,
              name: block.name,
              kind: toolKind(block.name),
              status: 'pending',
              rawInput: block.arguments,
            })
          }
        }
      } else if (message.role === 'toolResult') {
        const content = piContentToToolContent(message.content)
        if (reportedToolCalls.has(message.toolCallId)) {
          await emitter.update(binding.externalSessionId, {
            sessionUpdate: 'tool_call_update',
            toolCallId: message.toolCallId,
            status: message.isError ? 'failed' : 'completed',
            ...(content.length ? { content } : {}),
          })
        } else {
          await emitter.update(binding.externalSessionId, {
            sessionUpdate: 'tool_call',
            toolCallId: message.toolCallId,
            title: message.toolName,
            name: message.toolName,
            kind: toolKind(message.toolName),
            status: message.isError ? 'failed' : 'completed',
            ...(content.length ? { content } : {}),
          })
        }
      }
    }
  }

  private async dispatch<T = unknown>(project: ProjectRuntime, command: RuntimeCommand): Promise<T> {
    const response = await project.runtime.dispatch({
      commandId: `acp-${++this.commandNumber}`,
      command,
    })
    if (response.ok === false) {
      throw new acp.RequestError(-32000, response.error.message, { code: response.error.code })
    }
    return response.result as T
  }
}

function promptToUserMessage(prompt: readonly acp.ContentBlock[]): AgentMessage {
  if (prompt.length === 0) throw acp.RequestError.invalidParams(undefined, 'The ACP prompt must contain at least one content block.')
  const content: Array<PiTextContent | PiImageContent> = []
  for (const block of prompt) {
    if (block.type === 'text') {
      content.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      content.push({ type: 'image', data: block.data, mimeType: block.mimeType })
    } else if (block.type === 'resource_link') {
      const title = block.title ?? block.name
      content.push({ type: 'text', text: `[Referenced resource: ${title}]\nURI: ${block.uri}${block.description ? `\n${block.description}` : ''}` })
    } else {
      throw acp.RequestError.invalidParams(undefined, `Microcode ACP does not support ${block.type} prompt content.`)
    }
  }
  return { role: 'user', content, timestamp: Date.now() }
}

function convertMcpServers(servers: readonly acp.McpServer[], cwd: string): Readonly<Record<string, McpServerConfig>> {
  const result: Record<string, McpServerConfig> = {}
  for (const server of servers) {
    if (Object.hasOwn(result, server.name)) {
      throw acp.RequestError.invalidParams(undefined, `Duplicate ACP MCP server name "${server.name}".`)
    }
    if (!('type' in server)) {
      result[server.name] = {
        type: 'stdio',
        command: server.command,
        args: [...server.args],
        env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])),
        cwd,
      }
    } else if (server.type === 'http' || server.type === 'sse') {
      result[server.name] = {
        type: server.type,
        url: server.url,
        headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])),
      }
    } else {
      throw acp.RequestError.invalidParams(undefined, `Microcode ACP does not support MCP transport "${server.type}".`)
    }
  }
  return Object.freeze(result)
}

function toolKind(name: string): acp.ToolKind {
  const normalized = name.toLowerCase()
  if (/bash|terminal|command|exec/.test(normalized)) return 'execute'
  if (/edit|write|delete|move|patch/.test(normalized)) return 'edit'
  if (/read|list|file/.test(normalized)) return 'read'
  if (/search|grep|glob|find/.test(normalized)) return 'search'
  if (/fetch|web/.test(normalized)) return 'fetch'
  if (/question|think|plan/.test(normalized)) return 'think'
  return 'other'
}

function piContentToAcp(block: PiTextContent | PiImageContent): acp.ContentBlock[] {
  if (block.type === 'text') return [{ type: 'text', text: block.text }]
  if (block.type === 'image') return [{ type: 'image', data: block.data, mimeType: block.mimeType }]
  return []
}

function piContentToToolContent(content: readonly (PiTextContent | PiImageContent)[]): acp.ToolCallContent[] {
  return content.flatMap((block) => piContentToAcp(block).map((item) => ({ type: 'content' as const, content: item })))
}

function toolContent(value: unknown): acp.ToolCallContent[] {
  if (!value || typeof value !== 'object' || !('content' in value) || !Array.isArray(value.content)) return []
  const content: acp.ToolCallContent[] = []
  for (const block of value.content) {
    if (!block || typeof block !== 'object' || !('type' in block)) continue
    if (block.type === 'text' && 'text' in block && typeof block.text === 'string') {
      content.push({ type: 'content', content: { type: 'text', text: block.text } })
    } else if (block.type === 'image' && 'data' in block && 'mimeType' in block &&
      typeof block.data === 'string' && typeof block.mimeType === 'string') {
      content.push({ type: 'content', content: { type: 'image', data: block.data, mimeType: block.mimeType } })
    }
  }
  return content
}

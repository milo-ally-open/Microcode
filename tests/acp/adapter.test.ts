import { afterEach, describe, expect, test } from 'bun:test'
import * as acp from '@agentclientprotocol/sdk'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { resolve } from 'node:path'
import { AcpAgentAdapter } from '../../src/acp/adapter.ts'
import type { ApplicationRuntime } from '../../src/runtime/ApplicationRuntime.ts'
import type { RuntimeCommand, RuntimeCommandEnvelope, RuntimeCommandResponse, RuntimeEvent, RuntimeEventListener, RuntimeQuery, RuntimeSnapshot } from '../../src/runtime/protocol.ts'

const adapters: AcpAgentAdapter[] = []
const clients: acp.ClientConnection[] = []
const agents: acp.AgentConnection[] = []

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map(async (connection) => connection.close()))
  await Promise.allSettled(agents.splice(0).map(async (connection) => connection.close()))
  await Promise.allSettled(adapters.splice(0).map((adapter) => adapter.close()))
})

describe('ACP v1 Agent adapter', () => {
  test('negotiates v1, creates a session, streams a prompt, and replays session history over SDK stdio streams', async () => {
    const runtime = new StubRuntime()
    const updates: acp.SessionUpdate[] = []
    const { client } = connect(runtime, {
      onUpdate: (update) => updates.push(update),
    })

    const initialized = await client.agent.request('initialize', {
      protocolVersion: 2,
      clientCapabilities: {},
      clientInfo: { name: 'contract-test', version: '1' },
    })
    expect(initialized.protocolVersion).toBe(1)
    expect(initialized.agentCapabilities).toEqual({
      loadSession: true,
      promptCapabilities: { image: true },
      mcpCapabilities: { http: true, sse: true },
    })
    expect(initialized.agentInfo).toMatchObject({ name: 'microcode', title: 'Microcode', version: 'test' })

    const created = await client.agent.request('session/new', { cwd: '/workspace/project', mcpServers: [] })
    const prompted = await client.agent.request('session/prompt', {
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'Say hello.' }],
    })
    expect(prompted.stopReason).toBe('end_turn')
    expect(updates).toContainEqual(expect.objectContaining({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Runtime response.' },
    }))
    expect(runtime.lastPrompt).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'Say hello.' }],
    })

    const beforeReplay = updates.length
    await client.agent.request('session/load', {
      sessionId: created.sessionId,
      cwd: '/workspace/project',
      mcpServers: [],
    })
    expect(updates.slice(beforeReplay).some((update) => update.sessionUpdate === 'user_message_chunk')).toBe(true)
    expect(updates.slice(beforeReplay).some((update) => update.sessionUpdate === 'agent_message_chunk')).toBe(true)
  })

  test('maps ACP stdio, HTTP, and SSE MCP servers into the shared runtime configuration', async () => {
    const runtime = new StubRuntime()
    const { client } = connect(runtime)
    await client.agent.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
    await client.agent.request('session/new', {
      cwd: '/workspace/project',
      mcpServers: [
        { name: 'stdio-tools', command: '/usr/bin/mcp-tools', args: ['--quiet'], env: [{ name: 'MODE', value: 'test' }] },
        { name: 'http-tools', type: 'http', url: 'http://127.0.0.1:43100/mcp', headers: [{ name: 'X-Test', value: 'test' }] },
        { name: 'sse-tools', type: 'sse', url: 'http://127.0.0.1:43101/sse', headers: [] },
      ],
    })

    expect(runtime.configuredMcpServers).toEqual({
      'stdio-tools': { type: 'stdio', command: '/usr/bin/mcp-tools', args: ['--quiet'], env: { MODE: 'test' }, cwd: resolve('/workspace/project') },
      'http-tools': { type: 'http', url: 'http://127.0.0.1:43100/mcp', headers: { 'X-Test': 'test' } },
      'sse-tools': { type: 'sse', url: 'http://127.0.0.1:43101/sse', headers: {} },
    })
  })

  test('returns the runtime permission decision and denies when the client rejects', async () => {
    const runtime = new StubRuntime({ permissionOnPrompt: true })
    const { client } = connect(runtime, {
      requestPermission: async () => ({ outcome: { outcome: 'selected', optionId: 'reject_once' } }),
    })
    await initializeAndCreate(client)
    const result = await client.agent.request('session/prompt', {
      sessionId: runtime.currentSessionId!,
      prompt: [{ type: 'text', text: 'Use a protected tool.' }],
    })
    expect(result.stopReason).toBe('end_turn')
    expect(runtime.permissionDecisions).toEqual(['deny'])
  })

  test('maps ACP approval choices to one-time and session permissions', async () => {
    const oneTimeRuntime = new StubRuntime({ permissionOnPrompt: true })
    const { client: oneTimeClient } = connect(oneTimeRuntime, {
      requestPermission: async () => ({ outcome: { outcome: 'selected', optionId: 'allow_once' } }),
    })
    await initializeAndCreate(oneTimeClient)
    await oneTimeClient.agent.request('session/prompt', {
      sessionId: oneTimeRuntime.currentSessionId!,
      prompt: [{ type: 'text', text: 'Run the approved tool once.' }],
    })
    expect(oneTimeRuntime.permissionDecisions).toEqual(['allow'])

    const sessionRuntime = new StubRuntime({ permissionOnPrompt: true })
    const { client: sessionClient } = connect(sessionRuntime, {
      requestPermission: async () => ({ outcome: { outcome: 'selected', optionId: 'allow_always' } }),
    })
    await initializeAndCreate(sessionClient)
    await sessionClient.agent.request('session/prompt', {
      sessionId: sessionRuntime.currentSessionId!,
      prompt: [{ type: 'text', text: 'Run the approved tool for this session.' }],
    })
    expect(sessionRuntime.permissionDecisions).toEqual(['allow_session'])
  })

  test('denies permissions on timeout and cancellation', async () => {
    const timeoutRuntime = new StubRuntime({ permissionOnPrompt: true })
    const { client: timeoutClient } = connect(timeoutRuntime, {
      permissionTimeoutMs: 20,
      requestPermission: () => new Promise<acp.RequestPermissionResponse>(() => undefined),
    })
    await initializeAndCreate(timeoutClient)
    const timeoutResult = await timeoutClient.agent.request('session/prompt', {
      sessionId: timeoutRuntime.currentSessionId!,
      prompt: [{ type: 'text', text: 'Wait for approval.' }],
    })
    expect(timeoutResult.stopReason).toBe('end_turn')
    expect(timeoutRuntime.permissionDecisions).toEqual(['deny'])

    const cancelRuntime = new StubRuntime({ permissionOnPrompt: true })
    const requestStarted = deferred<void>()
    const { client: cancelClient } = connect(cancelRuntime, {
      permissionTimeoutMs: 5_000,
      requestPermission: async () => {
        requestStarted.resolve()
        return new Promise<acp.RequestPermissionResponse>(() => undefined)
      },
    })
    await initializeAndCreate(cancelClient)
    const prompt = cancelClient.agent.request('session/prompt', {
      sessionId: cancelRuntime.currentSessionId!,
      prompt: [{ type: 'text', text: 'Cancel while approval is pending.' }],
    })
    await requestStarted.promise
    await cancelClient.agent.notify('session/cancel', { sessionId: cancelRuntime.currentSessionId! })
    expect((await prompt).stopReason).toBe('cancelled')
    expect(cancelRuntime.permissionDecisions).toEqual(['deny'])
  })

  test('denies a pending permission when the ACP transport disconnects', async () => {
    const runtime = new StubRuntime({ permissionOnPrompt: true })
    const requestStarted = deferred<void>()
    const { client, closeAgentConnection } = connect(runtime, {
      permissionTimeoutMs: 5_000,
      requestPermission: () => {
        requestStarted.resolve()
        return new Promise<acp.RequestPermissionResponse>(() => undefined)
      },
    })
    await initializeAndCreate(client)
    const prompt = client.agent.request('session/prompt', {
      sessionId: runtime.currentSessionId!,
      prompt: [{ type: 'text', text: 'Disconnect while waiting for approval.' }],
    }).catch(() => undefined)
    await requestStarted.promise

    closeAgentConnection()

    const disconnectResult = await Promise.race([
      runtime.firstPermissionDecision,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 100)),
    ])
    expect(disconnectResult).toBe('deny')
    expect(runtime.permissionDecisions).toEqual(['deny'])
  })
})

function connect(
  runtime: StubRuntime,
  options: {
    onUpdate?: (update: acp.SessionUpdate) => void
    requestPermission?: (params: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionResponse>
    permissionTimeoutMs?: number
  } = {},
): { client: acp.ClientConnection; closeAgentConnection: () => void } {
  const adapter = new AcpAgentAdapter({
    version: 'test',
    permissionTimeoutMs: options.permissionTimeoutMs,
    createRuntime: async () => ({ runtime: runtime as unknown as ApplicationRuntime, mcpServers: {} }),
  })
  adapters.push(adapter)
  const fromAgent = new TransformStream<Uint8Array, Uint8Array>()
  const fromClient = new TransformStream<Uint8Array, Uint8Array>()
  const agent = adapter.app.connect(acp.ndJsonStream(fromAgent.writable, fromClient.readable))
  const clientApp = acp.client({ name: 'contract-client' })
    .onRequest('session/request_permission', async ({ params }) => options.requestPermission
      ? options.requestPermission(params)
      : { outcome: { outcome: 'selected', optionId: 'allow_once' } })
    .onNotification('session/update', ({ params }) => options.onUpdate?.(params.update))
  const client = clientApp.connect(acp.ndJsonStream(fromClient.writable, fromAgent.readable))
  agents.push(agent)
  clients.push(client)
  return { client, closeAgentConnection: () => agent.close(new Error('ACP transport disconnected')) }
}

async function initializeAndCreate(client: acp.ClientConnection): Promise<void> {
  await client.agent.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
  await client.agent.request('session/new', { cwd: '/workspace/project', mcpServers: [] })
}

class StubRuntime {
  private readonly listeners = new Set<{ listener: RuntimeEventListener; sessionId?: string }>()
  private readonly persisted = new Map<string, AgentMessage[]>()
  private readonly permissionWaiters = new Map<string, (decision: string) => void>()
  private sequence = 0
  private nextSessionId = 0
  private busy = false
  private cancelled = false
  private closed = false
  currentSessionId: string | null = null
  messages: AgentMessage[] = []
  lastPrompt?: AgentMessage
  readonly permissionDecisions: string[] = []
  configuredMcpServers: Readonly<Record<string, unknown>> = {}
  private readonly firstPermission = deferred<string>()
  readonly firstPermissionDecision = this.firstPermission.promise

  constructor(private readonly behavior: { permissionOnPrompt?: boolean } = {}) {}

  getSnapshot(): RuntimeSnapshot {
    return {
      protocolVersion: 1,
      sequence: this.sequence,
      lifecycle: this.closed ? 'closed' : 'ready',
      project: { cwd: '/workspace/project' },
      session: { id: this.currentSessionId, metadata: null, draft: this.currentSessionId === null },
      agent: { errorMessage: this.cancelled ? 'Prompt aborted.' : undefined },
      messages: [...this.messages],
      mcpServers: [],
      plugins: null,
    } as unknown as RuntimeSnapshot
  }

  query(query: RuntimeQuery): unknown {
    return query.type === 'agent.is_busy' ? this.busy : undefined
  }

  subscribe(listener: RuntimeEventListener, options: { sessionId?: string } = {}): () => void {
    const entry = { listener, sessionId: options.sessionId }
    this.listeners.add(entry)
    return () => this.listeners.delete(entry)
  }

  async configureMcpServers(servers: Readonly<Record<string, unknown>>): Promise<void> {
    this.configuredMcpServers = { ...servers }
  }

  async close(): Promise<void> {
    this.closed = true
    this.publish({ type: 'runtime.lifecycle', state: 'closed' })
  }

  async dispatch(envelope: RuntimeCommandEnvelope): Promise<RuntimeCommandResponse> {
    const command = envelope.command
    let result: unknown
    if (command.type === 'session.begin_draft') {
      this.currentSessionId = null
      this.messages = []
    } else if (command.type === 'session.ensure_created') {
      if (!this.currentSessionId) {
        this.currentSessionId = `test-session-${++this.nextSessionId}`
        this.persisted.set(this.currentSessionId, [])
      }
      result = this.currentSessionId
      this.publish({ type: 'session.changed', session: this.getSnapshot().session })
    } else if (command.type === 'session.select') {
      const saved = this.persisted.get(command.sessionId)
      if (!saved) return this.failure(envelope, 'session_not_found', `Session not found: ${command.sessionId}`)
      this.currentSessionId = command.sessionId
      this.messages = [...saved]
    } else if (command.type === 'agent.persist') {
      this.persistCurrent()
    } else if (command.type === 'agent.prompt') {
      this.busy = true
      this.cancelled = false
      this.lastPrompt = command.prompt as AgentMessage
      this.messages.push(this.lastPrompt)
      this.publish({ type: 'prompt.started' })
      if (this.behavior.permissionOnPrompt) {
        const requestId = 'permission-test-1'
        this.publish({
          type: 'permission.requested',
          request: {
            requestId,
            sessionId: this.currentSessionId,
            kind: 'tool',
            toolName: 'file_write',
            input: { path: '/workspace/project/file.txt' },
            description: 'Write file.txt',
          },
        })
        await new Promise<void>((resolve) => this.permissionWaiters.set(requestId, () => resolve()))
      }
      const assistant = {
        role: 'assistant',
        content: [{ type: 'text', text: 'Runtime response.' }],
        api: 'openai-codex-responses',
        provider: 'openai-codex',
        model: 'test-model',
        usage: {},
        stopReason: 'stop',
        timestamp: Date.now(),
      } as unknown as AgentMessage
      this.messages.push(assistant)
      this.publish({ type: 'agent.event', event: { type: 'message_start', message: assistant } } as never)
      this.publish({ type: 'agent.event', event: {
        type: 'message_update',
        message: assistant,
        assistantMessageEvent: { type: 'text_delta', delta: 'Runtime response.' },
      } } as never)
      this.publish({ type: 'prompt.completed', aborted: this.cancelled })
      this.busy = false
      this.persistCurrent()
      result = this.getSnapshot().agent
    } else if (command.type === 'agent.cancel') {
      this.cancelled = true
    } else if (command.type === 'permission.respond') {
      const waiter = this.permissionWaiters.get(command.requestId)
      this.permissionWaiters.delete(command.requestId)
      if (waiter) {
        this.permissionDecisions.push(command.decision)
        this.firstPermission.resolve(command.decision)
        waiter(command.decision)
      }
      result = { requestId: command.requestId, accepted: Boolean(waiter) }
    } else if (command.type === 'runtime.close') {
      await this.close()
    }
    return { protocolVersion: 1, commandId: envelope.commandId, ok: true, result }
  }

  private persistCurrent(): void {
    if (this.currentSessionId) this.persisted.set(this.currentSessionId, [...this.messages])
  }

  private failure(envelope: RuntimeCommandEnvelope, code: 'session_not_found', message: string): RuntimeCommandResponse {
    return { protocolVersion: 1, commandId: envelope.commandId, ok: false, error: { code, message } }
  }

  private publish(event: Record<string, unknown>): void {
    const runtimeEvent = {
      ...event,
      protocolVersion: 1,
      sequence: ++this.sequence,
      emittedAt: Date.now(),
      sessionId: this.currentSessionId,
    } as unknown as RuntimeEvent
    for (const entry of this.listeners) {
      if (!entry.sessionId || entry.sessionId === runtimeEvent.sessionId) entry.listener(runtimeEvent)
    }
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => { resolve = complete })
  return { promise, resolve }
}

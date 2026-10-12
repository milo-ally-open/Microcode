import { describe, expect, test } from 'bun:test'
import { mkdir, rm } from 'fs/promises'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import { MicrocodeAgent } from '../../src/agent/MicrocodeAgent.ts'
import { resolveAgentModelConfig } from '../../src/agent/AgentModelManager.ts'
import { SessionManager } from '../../src/session/SessionManager.ts'
import type { McpClientManager } from '../../src/mcp/client.ts'
import { ApplicationRuntime } from '../../src/runtime/ApplicationRuntime.ts'
import { ensureBootstrapMacro } from '../../src/macro.ts'

function createTestAgent(cwd: string, sessions: SessionManager): MicrocodeAgent {
  const modelConfig = resolveAgentModelConfig('gpt-5.6-luna', 'openai-codex-responses')
  return new MicrocodeAgent({
    cwd,
    modelId: modelConfig.model.id,
    api: modelConfig.model.api,
    permission: { mode: 'interactive' },
    persistence: sessions,
    compactionSettings: { enabled: false },
    streamFn: (model) => {
      const message: any = {
        role: 'assistant',
        content: [{ type: 'text', text: 'Runtime response.' }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 1,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 3,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: Date.now(),
      }
      const stream = createAssistantMessageEventStream()
      stream.push({ type: 'start', partial: message })
      stream.push({ type: 'done', reason: 'stop', message })
      return stream
    },
  })
}

describe('ApplicationRuntime', () => {
  test('dispatches ordered events, persists turns, and restores snapshots for a project session', async () => {
    ensureBootstrapMacro()
    const root = mkdtempSync(join(tmpdir(), 'microcode-runtime-'))
    const cwd = join(root, 'project')
    await mkdir(cwd, { recursive: true })
    const sessions = new SessionManager({ sessionsRoot: join(root, 'sessions'), tasksRoot: join(root, 'tasks') })
    sessions.beginDraft(cwd)
    const agent = createTestAgent(cwd, sessions)
    const runtime = new ApplicationRuntime({ cwd, agent, sessions })
    let resumedRuntime: ApplicationRuntime | undefined
    const events: Array<{ protocolVersion: number; sequence: number; type: string }> = []
    const unsubscribe = runtime.subscribe((event) => events.push({ protocolVersion: event.protocolVersion, sequence: event.sequence, type: event.type }))

    try {
      const response = await runtime.dispatch({
        commandId: 'prompt-1',
        command: { type: 'agent.prompt', prompt: 'Say hello.' },
      })
      expect(response.ok).toBe(true)
      expect(events[0]?.type).toBe('prompt.started')
      expect(events.at(-1)?.type).toBe('prompt.completed')
      expect(events.map((event) => event.sequence)).toEqual([...events.map((event) => event.sequence)].sort((a, b) => a - b))
      expect(new Set(events.map((event) => event.sequence)).size).toBe(events.length)

      const snapshot = runtime.getSnapshot()
      expect(snapshot.protocolVersion).toBe(1)
      expect(events[0]?.protocolVersion).toBe(1)
      expect(snapshot.project.cwd).toBe(cwd)
      expect(snapshot.session.id).toBeTruthy()
      expect(snapshot.messages.some((message: any) => message.role === 'assistant' && message.content.some((part: any) => part.text === 'Runtime response.'))).toBe(true)
      expect(snapshot.sequence).toBe(events.at(-1)?.sequence)

      const resumeId = snapshot.session.id!
      unsubscribe()
      await runtime.dispatch({
        commandId: 'offline-title',
        command: { type: 'session.set_title', sessionId: resumeId, title: 'Changed while disconnected' },
      })
      const reconnectEvents: Array<{ sequence: number; type: string }> = []
      const connection = runtime.subscribeWithSnapshot((event) => reconnectEvents.push({ sequence: event.sequence, type: event.type }))
      expect(connection.snapshot.session.title).toBe('Changed while disconnected')
      await runtime.dispatch({
        commandId: 'online-title',
        command: { type: 'session.set_title', sessionId: resumeId, title: 'Changed after reconnect' },
      })
      expect(reconnectEvents).toEqual([{ sequence: connection.snapshot.sequence + 1, type: 'session.changed' }])
      connection.unsubscribe()
      await runtime.close()

      const resumedSessions = new SessionManager({ sessionsRoot: join(root, 'sessions'), tasksRoot: join(root, 'tasks') })
      resumedSessions.beginDraft(cwd)
      const resumed = new ApplicationRuntime({ cwd, agent: createTestAgent(cwd, resumedSessions), sessions: resumedSessions })
      resumedRuntime = resumed
      const resumedResponse = await resumed.dispatch({
        commandId: 'resume-1',
        command: { type: 'session.resume', sessionId: resumeId, cwd },
      })
      expect(resumedResponse.ok).toBe(true)
      expect(resumed.getSnapshot().session.id).toBe(resumeId)
      expect(resumed.getSnapshot().messages.some((message: any) => message.role === 'assistant' && message.content.some((part: any) => part.text === 'Runtime response.'))).toBe(true)
      await resumed.close()
    } finally {
      unsubscribe()
      await runtime.close().catch(() => undefined)
      await resumedRuntime?.close().catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  })

  test('routes approval responses by request ID and rejects commands after close', async () => {
    ensureBootstrapMacro()
    const root = mkdtempSync(join(tmpdir(), 'microcode-runtime-permission-'))
    const sessions = new SessionManager({ sessionsRoot: join(root, 'sessions'), tasksRoot: join(root, 'tasks') })
    sessions.beginDraft(root)
    const runtime = new ApplicationRuntime({ cwd: root, agent: createTestAgent(root, sessions), sessions })
    let responsePromise: Promise<unknown> | undefined
    const unsubscribe = runtime.subscribe((event) => {
      if (event.type === 'permission.requested') {
        responsePromise = runtime.dispatch({
          commandId: 'permission-response',
          command: { type: 'permission.respond', requestId: event.request.requestId, decision: 'allow' },
        })
      }
    })

    try {
      const approval = await runtime.dispatch({
        commandId: 'permission-request',
        command: { type: 'permission.request', toolName: 'write', input: { path: 'file.txt' }, description: 'Write file.txt' },
      })
      expect(approval).toMatchObject({ ok: true, result: true })
      expect((await responsePromise!).ok).toBe(true)
      const incompatible = await runtime.dispatch({
        protocolVersion: 999,
        commandId: 'incompatible-version',
        command: { type: 'agent.cancel' },
      })
      expect(incompatible).toMatchObject({ protocolVersion: 1, ok: false, error: { code: 'protocol_version_mismatch' } })
      const staleResponse = await runtime.dispatch({
        commandId: 'stale-permission-response',
        command: { type: 'permission.respond', requestId: 'missing-request', decision: 'allow' },
      })
      expect(staleResponse).toMatchObject({ ok: true, result: { requestId: 'missing-request', accepted: false } })
      const missingSession = await runtime.dispatch({
        commandId: 'missing-session',
        command: { type: 'session.select', sessionId: 'missing-session-id' },
      })
      expect(missingSession).toMatchObject({ ok: false, error: { code: 'session_not_found' } })
      unsubscribe()
      await runtime.close()
      const closed = await runtime.dispatch({ commandId: 'closed', command: { type: 'agent.cancel' } })
      expect(closed).toMatchObject({ ok: false, error: { code: 'runtime_closed' } })
    } finally {
      unsubscribe()
      await runtime.close().catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  })

  test('closes owned resources exactly once and exposes stable lifecycle errors', async () => {
    ensureBootstrapMacro()
    const root = mkdtempSync(join(tmpdir(), 'microcode-runtime-close-'))
    const sessions = new SessionManager({ sessionsRoot: join(root, 'sessions'), tasksRoot: join(root, 'tasks') })
    sessions.beginDraft(root)
    let disconnectCount = 0
    let onClosedCount = 0
    const mcp = {
      getServerStates: () => [],
      disconnectAll: async () => { disconnectCount++ },
    } as unknown as McpClientManager
    const runtime = new ApplicationRuntime({
      cwd: root,
      agent: createTestAgent(root, sessions),
      sessions,
      mcp,
      onClosed: () => { onClosedCount++ },
    })
    let reentrantClose: Promise<void> | undefined
    const unsubscribe = runtime.subscribe((event) => {
      if (event.type === 'runtime.lifecycle' && event.state === 'closing') reentrantClose = runtime.close()
    })

    try {
      await Promise.all([runtime.close(), runtime.close()])
      await reentrantClose
      expect(runtime.getSnapshot().lifecycle).toBe('closed')
      expect(disconnectCount).toBe(1)
      expect(onClosedCount).toBe(1)
      const rejected = await runtime.dispatch({ commandId: 'after-close', command: { type: 'agent.cancel' } })
      expect(rejected).toMatchObject({ ok: false, error: { code: 'runtime_closed' } })
    } finally {
      unsubscribe()
      await runtime.close().catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  })
})

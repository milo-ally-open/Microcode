import { describe, expect, test } from 'bun:test'
import type { RuntimeEvent, RuntimeSnapshot } from '../../src/runtime/protocol.ts'
import type { DesktopBackendSnapshot } from '../../src/desktop/protocol.ts'
import { applyRuntimeEvent } from '../../src/desktop/renderer/state.ts'

function desktopSnapshot(sequence: number): DesktopBackendSnapshot {
  return {
    workspace: '/project',
    runtime: { sequence, messages: [] } as unknown as RuntimeSnapshot,
    pendingPermissions: [],
    startupWarnings: [],
  }
}

describe('desktop runtime event state', () => {
  test('adds and removes approvals by request ID in event order', () => {
    const current = desktopSnapshot(4)
    const requested = {
      protocolVersion: 1,
      sequence: 5,
      emittedAt: 1,
      sessionId: 'session-1',
      type: 'permission.requested',
      request: { requestId: 'approval-7', sessionId: 'session-1', kind: 'tool', toolName: 'write', input: { path: 'a.ts' }, description: 'Write a.ts' },
    } as const satisfies RuntimeEvent
    const added = applyRuntimeEvent(current, requested)
    expect(added.sequenceGap).toBe(false)
    expect(added.snapshot.pendingPermissions.map((item) => item.requestId)).toEqual(['approval-7'])

    const resolved = {
      protocolVersion: 1,
      sequence: 6,
      emittedAt: 2,
      sessionId: 'session-1',
      type: 'permission.resolved',
      requestId: 'approval-7',
      allowed: false,
    } as const satisfies RuntimeEvent
    const removed = applyRuntimeEvent(added.snapshot, resolved)
    expect(removed.snapshot.pendingPermissions).toEqual([])
  })

  test('requests a snapshot when a runtime event sequence is missing', () => {
    const gap = {
      protocolVersion: 1,
      sequence: 9,
      emittedAt: 1,
      sessionId: null,
      type: 'prompt.started',
    } as const satisfies RuntimeEvent
    expect(applyRuntimeEvent(desktopSnapshot(7), gap).sequenceGap).toBe(true)
  })

  test('replaces an assistant message as streaming updates arrive', () => {
    const update = {
      protocolVersion: 1,
      sequence: 8,
      emittedAt: 1,
      sessionId: 'session-1',
      type: 'agent.event',
      event: {
        type: 'message_update',
        agentId: 'agent-1',
        message: { role: 'assistant', id: 'assistant-1', timestamp: 7, content: [{ type: 'text', text: 'First token' }] },
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'First token' },
      },
    } as const satisfies RuntimeEvent
    const result = applyRuntimeEvent(desktopSnapshot(7), update)
    expect(result.sequenceGap).toBe(false)
    expect(result.snapshot.runtime?.messages).toHaveLength(1)
    expect(result.snapshot.runtime?.messages[0]?.content).toEqual([{ type: 'text', text: 'First token' }])
  })

  test('waits for the model switch command snapshot before updating the selected model', () => {
    const current = desktopSnapshot(3)
    const originalAgent = { model: { id: 'original-model', provider: 'sample-provider' } }
    const runtime = current.runtime as RuntimeSnapshot & { agent: typeof originalAgent }
    const snapshot = { ...current, runtime: { ...runtime, agent: originalAgent } }
    const modelChanged = {
      protocolVersion: 1,
      sequence: 4,
      emittedAt: 1,
      sessionId: 'session-1',
      type: 'agent.event',
      event: {
        type: 'state_changed',
        agentId: 'agent-1',
        reason: 'model_changed',
        snapshot: { model: { id: 'new-model', provider: 'sample-provider' } },
      },
    } as const satisfies RuntimeEvent

    const result = applyRuntimeEvent(snapshot, modelChanged)
    expect(result.sequenceGap).toBe(false)
    expect(result.snapshot.runtime?.sequence).toBe(4)
    expect(result.snapshot.runtime?.agent.model?.id).toBe('original-model')
  })
})

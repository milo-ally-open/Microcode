import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { estimateMessagesTokens, estimateTokens } from '../../src/session/TokenEstimator.ts'
import { replaceImageBlocksForPersistence } from '../../src/session/imageSerializer.ts'
import { SessionManager } from '../../src/session/SessionManager.ts'
import { getAllModels } from '../../src/models/index.ts'

describe('session modules', () => {
  test('estimates text, thinking, tool call, image, and summary messages', () => {
    const user = { role: 'user', content: '12345678', timestamp: 0 } as any
    const assistant = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'abcd' },
        { type: 'thinking', thinking: 'efgh' },
        { type: 'toolCall', name: 'tool', arguments: { a: 1 } },
      ],
      timestamp: 0,
    } as any
    const image = {
      role: 'toolResult',
      content: [{ type: 'image', data: 'x', mimeType: 'image/png' }],
      timestamp: 0,
    } as any
    const summary = { role: 'compactionSummary', summary: '1234', timestamp: 0 } as any

    expect(estimateTokens(user)).toBe(2)
    expect(estimateTokens(assistant)).toBeGreaterThan(2)
    expect(estimateTokens(image)).toBe(2000)
    expect(estimateTokens(summary)).toBe(1)
    expect(estimateMessagesTokens([user, summary])).toBe(3)
  })

  test('estimates every message role and block variant', () => {
    expect(estimateTokens({ role: 'user', content: [{ type: 'text', text: 'abcd' }, { type: 'image', data: 'x' }], timestamp: 0 } as any)).toBe(2001)
    expect(estimateTokens({ role: 'toolResult', content: [{ type: 'text', text: 'abcd' }], timestamp: 0 } as any)).toBe(1)
    expect(estimateTokens({ role: 'bashExecution', command: 'echo hi', output: 'hello', timestamp: 0 } as any)).toBe(3)
    expect(estimateTokens({ role: 'branchSummary', summary: 'abcd', timestamp: 0 } as any)).toBe(1)
    expect(estimateTokens({ role: 'custom', content: 'abcd', timestamp: 0 } as any)).toBe(1)
    expect(estimateTokens({ role: 'custom', content: [{ type: 'text', text: 'abcd' }], timestamp: 0 } as any)).toBe(1)
  })

  test('replaces persisted image blocks without mutating non-image messages', () => {
    const msg = {
      role: 'user',
      content: [
        { type: 'text', text: 'see' },
        { type: 'image', data: 'base64', mimeType: 'image/png' },
      ],
      timestamp: 0,
    } as any
    const persisted = replaceImageBlocksForPersistence(msg) as any

    expect(persisted).not.toBe(msg)
    expect(persisted.content).toEqual([
      { type: 'text', text: 'see' },
      { type: 'text', text: '[Image: image/png]' },
    ])
    expect(replaceImageBlocksForPersistence({ role: 'assistant', content: [], timestamp: 0 } as any).role).toBe('assistant')
  })

  test('creates the main branch before saving the first message', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'microcode-session-'))
    const cwd = join(dir, 'workspace')
    const manager = new SessionManager({ sessionsRoot: join(dir, 'sessions') })
    try {
      const sessionId = await manager.create(cwd)
      await manager.saveMessages([{ role: 'user', content: 'hello', timestamp: 1 } as any])
      expect(manager.getSessionId()).toBe(sessionId)
      expect(await manager.loadMessages()).toHaveLength(1)
    } finally {
      await manager.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('loads the latest compaction checkpoint while preserving the full archive', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'microcode-session-checkpoint-'))
    const cwd = join(dir, 'workspace')
    const sessionsRoot = join(dir, 'sessions')
    const manager = new SessionManager({ sessionsRoot })
    let resumedManager: SessionManager | undefined
    let managerClosed = false
    try {
      const sessionId = await manager.create(cwd)
      const original = [
        { role: 'user', content: 'old request', timestamp: 1 },
        { role: 'assistant', content: [{ type: 'text', text: 'old response' }], timestamp: 2 },
      ] as any
      const compacted = [
        { role: 'user', content: 'summary and recent context', timestamp: 3 },
        { role: 'assistant', content: [{ type: 'text', text: 'recent response' }], timestamp: 4 },
      ] as any

      await manager.saveMessages(original)
      await manager.recordCompaction({
        summary: 'summary',
        messages: compacted,
        tokensBefore: 100_000,
        tokensAfter: 20_000,
        keptMessageCount: 1,
        compactedMessageCount: compacted.length,
        automatic: false,
        model: { provider: 'test', modelId: 'test-model', contextWindow: 128_000 },
      })
      expect(await manager.loadMessages()).toEqual(compacted)

      const archive = await manager.loadArchiveEntries()
      expect(archive.filter((entry) => entry.type === 'message')).toHaveLength(original.length)
      expect(archive.some((entry) => entry.type === 'custom' && entry.customType === 'microcode.compaction-checkpoint')).toBe(true)

      const followUp = { role: 'user', content: 'after compaction', timestamp: 5 } as any
      await manager.saveMessages([...compacted, followUp])
      const metadata = (await manager.list()).find((item) => item.id === sessionId)!
      await manager.close()
      managerClosed = true

      resumedManager = new SessionManager({ sessionsRoot })
      expect(await resumedManager.open(metadata)).toEqual([...compacted, followUp])
    } finally {
      if (!managerClosed) await manager.close()
      await resumedManager?.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('rebuilds the active context from legacy compaction markers without deleting history', async () => {
    const model = getAllModels()[0]!
    const dir = await mkdtemp(join(tmpdir(), 'microcode-session-legacy-compaction-'))
    const manager = new SessionManager({ sessionsRoot: join(dir, 'sessions') })
    try {
      await manager.create(join(dir, 'workspace'))
      const original = [
        { role: 'user', content: 'old '.repeat(10_000), timestamp: 1 },
        {
          role: 'assistant', model: model.id, provider: model.provider, api: model.api,
          content: [{ type: 'text', text: 'old response '.repeat(10_000) }],
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'stop', timestamp: 2,
        },
        { role: 'user', content: 'recent question', timestamp: 3 },
        {
          role: 'assistant', model: model.id, provider: model.provider, api: model.api,
          content: [{ type: 'text', text: 'recent answer' }],
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'stop', timestamp: 4,
        },
      ] as any[]
      const tokensBefore = estimateMessagesTokens(original)
      const legacyMarker = {
        role: 'user',
        content: `[Earlier conversation summarized (${tokensBefore} tokens before compaction)]:\nEarlier discussion summary`,
        timestamp: 5,
      } as any
      await manager.saveMessages([...original, legacyMarker])

      const activeMessages = await manager.loadMessages()
      expect(activeMessages[0]?.role).toBe('user')
      expect((activeMessages[0] as any).content).toContain('Earlier discussion summary')
      expect(activeMessages.some((message) => JSON.stringify(message).includes('old response'))).toBe(false)
      expect(activeMessages.some((message) => JSON.stringify(message).includes('recent answer'))).toBe(true)
      expect((await manager.loadArchiveEntries()).filter((entry) => entry.type === 'message')).toHaveLength(original.length + 1)
    } finally {
      await manager.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

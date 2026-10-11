import { describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'fs/promises'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Type } from 'typebox'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import { AgentModelManager, resolveAgentModelConfig } from '../../src/agent/AgentModelManager.ts'
import { AgentSkillManager } from '../../src/agent/AgentSkillManager.ts'
import { AgentTokenTracker } from '../../src/agent/AgentTokenTracker.ts'
import { MicrocodeAgent } from '../../src/agent/MicrocodeAgent.ts'
import { ensureBootstrapMacro } from '../../src/macro.ts'

describe('agent modules', () => {
  test('model manager resolves, commits, snapshots, and tracks thinking level', () => {
    const initial = resolveAgentModelConfig('deepseek-v4-pro', 'openai-completions')
    const manager = new AgentModelManager({ ...initial, thinkingLevel: 'low' })

    const next = manager.resolve('gemini-2.5-flash', 'google-generative-ai')
    manager.commit(next)
    manager.setThinkingLevel('high')

    const snapshot = manager.getSnapshot()
    expect(manager.getModel().id).toBe('gemini-2.5-flash')
    expect(manager.getProvider()).toBe('google')
    expect(snapshot.thinkingLevel).toBe('high')
    expect(() => ((snapshot as any).provider = 'mutated')).toThrow()
  })

  test('model manager can use a transport-owned model resolver without consulting local credentials', () => {
    const initial = resolveAgentModelConfig('deepseek-v4-pro', 'openai-completions')
    const gatewayModel = { ...initial.model, id: 'gateway-only-model', provider: 'custom:gateway-only' }
    const manager = new AgentModelManager({
      model: initial.model,
      apiKey: '',
      resolveModelConfig: () => ({ model: gatewayModel, apiKey: '' }),
      resolveApiKey: () => undefined,
    })

    manager.commit(manager.resolve('gateway-only-model'))

    expect(manager.getModel().id).toBe('gateway-only-model')
    expect(manager.getApiKey()).toBe('')
    expect(manager.getSnapshot().apiKeyConfigured).toBe(false)
  })

  test('skill manager loads skill bodies once and appends them to prompts', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'microcode-agent-skill-'))
    try {
      const dir = join(cwd, 'skills', 'alpha')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'SKILL.md'), `---\nname: alpha\ndescription: Alpha skill\n---\nBody\n`)

      const manager = new AgentSkillManager({ cwd, skillPaths: [join(cwd, 'skills')], includeDefaults: false })
      expect(manager.findSkill('alpha')?.name).toBe('alpha')
      manager.load('alpha')
      manager.load('alpha')
      expect(manager.getLoadedNames()).toEqual(['alpha'])
      expect(manager.appendLoadedSkills('Base')).toContain('# Skill: alpha')
      expect(manager.getSkills()).toHaveLength(1)
      expect(manager.getDiagnostics()).toEqual([])
      expect(manager.isLoaded('alpha')).toBe(true)
      expect(manager.getSnapshot().loaded[0].body).toBe('Body\n')
      expect(manager.unload('alpha')).toBe(true)
      expect(() => manager.load('missing')).toThrow('Skill "missing" not found')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('skill manager refreshes newly added project skills and changed loaded skill bodies', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'microcode-live-skills-'))
    try {
      const skillsDir = join(cwd, '.microcode', 'skills')
      const alphaDir = join(skillsDir, 'alpha')
      await mkdir(alphaDir, { recursive: true })
      const alphaFile = join(alphaDir, 'SKILL.md')
      await writeFile(alphaFile, '---\nname: alpha\ndescription: Alpha skill\n---\nFirst body\n')

      const manager = new AgentSkillManager({ cwd, skillPaths: [skillsDir], includeDefaults: false })
      manager.load('alpha')
      await writeFile(alphaFile, '---\nname: alpha\ndescription: Alpha skill\n---\nUpdated body\n')
      const betaDir = join(skillsDir, 'beta')
      await mkdir(betaDir, { recursive: true })
      await writeFile(join(betaDir, 'SKILL.md'), '---\nname: beta\ndescription: Beta skill\n---\nBeta body\n')

      expect(manager.refresh()).toBe(true)
      expect(manager.findSkill('beta')?.name).toBe('beta')
      expect(manager.getSnapshot().loaded[0]?.body).toBe('Updated body\n')
      expect(manager.appendLoadedSkills('Base')).toContain('Updated body')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('token tracker deduplicates assistant usage and computes context budget', () => {
    const model = resolveAgentModelConfig('deepseek-v4-pro', 'openai-completions').model
    const tracker = new AgentTokenTracker()
    const assistant = {
      role: 'assistant',
      responseId: 'resp-1',
      provider: model.provider,
      api: model.api,
      model: model.id,
      content: [{ type: 'text', text: 'done' }],
      usage: {
        input: 10,
        output: 5,
        cacheRead: 2,
        cacheWrite: 1,
        totalTokens: 18,
        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
      },
      timestamp: 1,
    } as any

    tracker.recordMessage(assistant)
    tracker.recordMessage(assistant)
    const snapshot = tracker.getSnapshot({ systemPrompt: '1234', messages: [assistant], model })

    expect(snapshot.session.requests).toBe(1)
    expect(snapshot.currentModel.totalTokens).toBe(18)
    expect(snapshot.context.usedTokens).toBeGreaterThan(0)
    tracker.reset()
    expect(tracker.getSnapshot({ systemPrompt: '', messages: [], model }).session.requests).toBe(0)
    tracker.rebuild([assistant])
    expect(tracker.getSnapshot({ systemPrompt: '', messages: [], model }).session.requests).toBe(1)
  })

  test('automatic compaction replaces the running loop context across tool turns', async () => {
    ensureBootstrapMacro()
    const model = resolveAgentModelConfig('deepseek-v4-pro', 'openai-completions').model
    const compactAtTokens = 60_000
    let summaryCalls = 0
    let requestCount = 0
    const observedContexts: string[] = []
    const agent = new MicrocodeAgent({
      cwd: process.cwd(),
      modelId: 'deepseek-v4-pro',
      api: 'openai-completions',
      permission: { mode: 'auto-approve' },
      compactionSettings: { reserveTokens: model.contextWindow - compactAtTokens },
      generateSummaryFn: async () => {
        summaryCalls++
        return { ok: true, value: 'Earlier work summary.' } as any
      },
      streamFn: (requestModel, context) => {
        requestCount++
        const text = context.messages.map((message: any) =>
          typeof message.content === 'string'
            ? message.content
            : message.content?.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n') ?? '',
        ).join('\n')
        observedContexts.push(text)
        const message: any = {
          role: 'assistant',
          content: requestCount === 1
            ? [{ type: 'toolCall', id: 'ctx-tool-call', name: 'test_context_tool', arguments: {} }]
            : [{ type: 'text', text: 'Finished.' }],
          api: requestModel.api,
          provider: requestModel.provider,
          model: requestModel.id,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: requestCount === 1 ? 'toolUse' : 'stop',
          timestamp: Date.now(),
        }
        const stream = createAssistantMessageEventStream()
        stream.push({ type: 'start', partial: message })
        stream.push({ type: 'done', reason: message.stopReason, message })
        return stream
      },
    })

    const systemMessage = agent.getMessages()[0]!
    const history = 'old-history-marker '.repeat(5_500)
    const historicalUsage = {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    }
    agent.replaceMessages([
      systemMessage,
      { role: 'user', content: history, timestamp: 1 } as any,
      {
        role: 'assistant', content: [{ type: 'text', text: 'First old answer.' }],
        api: model.api, provider: model.provider, model: model.id, usage: historicalUsage, timestamp: 2,
      } as any,
      { role: 'user', content: history, timestamp: 3 } as any,
      {
        role: 'assistant', content: [{ type: 'text', text: 'Second old answer.' }],
        api: model.api, provider: model.provider, model: model.id, usage: historicalUsage, timestamp: 4,
      } as any,
    ])
    agent.addTools([{
      name: 'test_context_tool',
      label: 'Context test',
      description: 'A deterministic test tool.',
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: 'text', text: 'small tool result' }] }),
    } as any])

    expect(agent.getTokenStats().context.usedTokens).toBeLessThan(compactAtTokens)
    await agent.prompt(`Continue the test. ${'new-prompt-context '.repeat(5_000)}`)

    expect(requestCount).toBe(2)
    expect(summaryCalls).toBe(1)
    expect(observedContexts.every((context) => !context.includes('old-history-marker'))).toBe(true)
    expect(agent.getTokenStats().context.usedTokens).toBeLessThan(compactAtTokens)
  })

  test('a restored context above 100% forces compaction before the first model request', async () => {
    ensureBootstrapMacro()
    const model = resolveAgentModelConfig('gpt-5.6-luna', 'openai-codex-responses').model
    let agent!: MicrocodeAgent
    let summaryCalls = 0
    let promptWasPresentWhenSummarizing = true
    const observedContexts: string[] = []
    agent = new MicrocodeAgent({
      cwd: process.cwd(),
      modelId: 'gpt-5.6-luna',
      api: 'openai-codex-responses',
      permission: { mode: 'auto-approve' },
      compactionSettings: { enabled: false },
      generateSummaryFn: async () => {
        summaryCalls++
        promptWasPresentWhenSummarizing = agent.getMessages().some((message: any) =>
          message.role === 'user' && message.content?.includes('Resume over budget session.'),
        )
        return { ok: true, value: 'Earlier work summary.' } as any
      },
      streamFn: (requestModel, context) => {
        observedContexts.push(context.messages.map((message: any) =>
          typeof message.content === 'string'
            ? message.content
            : message.content?.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n') ?? '',
        ).join('\n'))
        const message: any = {
          role: 'assistant',
          content: [{ type: 'text', text: 'Resumed.' }],
          api: requestModel.api,
          provider: requestModel.provider,
          model: requestModel.id,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
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

    const history = `restored-history-marker ${'x'.repeat(model.contextWindow * 4 + 10_000)}`
    const usage = {
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    }
    agent.replaceMessages([
      agent.getMessages()[0]!,
      { role: 'user', content: history, timestamp: 1 } as any,
      {
        role: 'assistant', content: [{ type: 'text', text: 'Old response.' }],
        api: model.api, provider: model.provider, model: model.id, usage, timestamp: 2,
      } as any,
      { role: 'user', content: history, timestamp: 3 } as any,
      {
        role: 'assistant', content: [{ type: 'text', text: 'Latest old response.' }],
        api: model.api, provider: model.provider, model: model.id, usage, timestamp: 4,
      } as any,
    ])

    await agent.prompt('Resume over budget session.')

    expect(summaryCalls).toBe(1)
    expect(promptWasPresentWhenSummarizing).toBe(false)
    expect(observedContexts[0]).toContain('Earlier work summary.')
    expect(observedContexts[0]).not.toContain('restored-history-marker')
    expect(agent.getTokenStats().context.usedTokens).toBeLessThan(model.contextWindow)
  })

  test('over-limit context still summarizes after microcompacting old tool results', async () => {
    ensureBootstrapMacro()
    const model = resolveAgentModelConfig('gpt-5.6-luna', 'openai-codex-responses').model
    let summaryCalls = 0
    const agent = new MicrocodeAgent({
      cwd: process.cwd(),
      modelId: 'gpt-5.6-luna',
      api: 'openai-codex-responses',
      compactionSettings: { enabled: false },
      generateSummaryFn: async () => {
        summaryCalls++
        return { ok: true, value: 'Summarized old tool activity.' } as any
      },
    })
    const largeResult = 'old-tool-result '.repeat(8_000)
    const messages: any[] = [agent.getMessages()[0]!]
    for (let index = 0; index < 10; index++) {
      messages.push({
        role: 'toolResult',
        toolCallId: `old-call-${index}`,
        toolName: 'bash',
        content: [{ type: 'text', text: largeResult }],
        timestamp: index + 1,
      })
    }
    agent.replaceMessages(messages)
    expect(agent.getTokenStats().context.usedTokens).toBeGreaterThan(model.contextWindow)

    const compacted = await agent.compactIfNeeded()

    expect(summaryCalls).toBe(1)
    expect(compacted.some((message: any) =>
      message.role === 'user' && message.content.includes('Summarized old tool activity.'),
    )).toBe(true)
    expect(agent.getTokenStats().context.usedTokens).toBeLessThan(model.contextWindow)
  })
})

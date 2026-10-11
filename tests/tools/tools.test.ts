import { describe, expect, test } from 'bun:test'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from 'typebox'
import { createMcpTool, formatMcpInputSchema, registerMcpToolsAsDeferred } from '../../src/tools/index.ts'
import { createCodingTools } from '../../src/tools/index.ts'
import { formatToolActivity, formatToolDetail, formatToolStatus, formatToolSummary, getAllDeferredToolDefinitions, getAllToolDefinitions, registerDynamicDeferredTool, registerTool, unregisterDynamicDeferredTool } from '../../src/tools/registry.ts'
import { boolTag, count, countLines, joinSummaryParts, previewList, producedText, statusPrefix, text } from '../../src/tools/summary.ts'

describe('tools modules', () => {
  test('summary helpers compact optional values', () => {
    const context = { result: { isError: false, content: [] }, textStats: { chars: 1234, lines: 2 } } as any
    expect(count(3, 'files')).toBe('3 files')
    expect(countLines('first\nsecond\n')).toBe(2)
    expect(countLines('')).toBe(0)
    expect(text('hello')).toBe('hello')
    expect(boolTag(true, 'enabled')).toBe('enabled')
    expect(statusPrefix({ ...context, result: { isError: true } })).toBe('failed · ')
    expect(producedText(context)).toBe('produced 1,234 chars across 2 lines')
    expect(joinSummaryParts(['a', undefined, 'b'])).toBe('a · b')
    expect(previewList(['a', 'b', 'c'], 2, 'items')).toBe('items: a, b, ...')
  })

  test('registry display formatters override default MCP summaries', () => {
    registerTool({
      name: 'custom_summary_tool',
      policy: { defaultPermission: 'allow' },
      agent: {
        create: () => ({ name: 'custom_summary_tool', label: 'Custom', description: 'Custom', parameters: Type.Object({}), execute: async () => ({ content: [] }) } as AgentTool),
        summarizeResult: () => 'custom summary',
      },
      presentation: {
        activity: () => 'Doing custom work',
        detail: () => 'custom detail',
        status: () => 'custom status',
      },
    })

    expect(formatToolActivity('custom_summary_tool', {})).toBe('Doing custom work')
    expect(formatToolDetail('custom_summary_tool', {})).toBe('custom detail')
    expect(formatToolStatus('custom_summary_tool', {})).toBe('custom status')
    expect(formatToolSummary('custom_summary_tool', { content: [], isError: false })).toBe('custom summary')
    expect(formatToolSummary('mcp__demo__dump', { content: [{ type: 'text', text: 'abc' }], isError: false })).toContain('[demo/dump] completed')
  })

  test('registered core tool display callbacks format concrete inputs and results', () => {
    createCodingTools({ cwd: process.cwd() })

    expect(formatToolActivity('bash', { command: 'bun test' })).toBe('Running a command')
    expect(formatToolDetail('bash', { command: 'bun test ./tests' })).toContain('bun test')
    expect(formatToolStatus('bash', {}, { stdout: 'a\nb\n', stderr: '' })).toBe('2 lines')
    expect(formatToolSummary('bash', { content: [], isError: false, details: { exitCode: 0 }, textStats: { chars: 4, lines: 2 } })).toContain('exit=0')

    expect(formatToolActivity('edit', { file_path: 'src/a.ts' })).toContain('Editing')
    expect(formatToolDetail('edit', { file_path: 'src/a.ts' })).toBe('a.ts')
    expect(formatToolStatus('edit', {}, { additions: 2, removals: 1 })).toBe('2+ 1-')
    expect(formatToolSummary('edit', { content: [], isError: false, details: { path: 'src/a.ts', replacements: 1, additions: 2, removals: 1 } })).toContain('src/a.ts')

    expect(formatToolActivity('write', { file_path: 'src/b.ts' })).toContain('Writing')
    expect(formatToolDetail('write', { file_path: 'src/b.ts' })).toBe('b.ts')
    expect(formatToolStatus('write', {}, { bytesWritten: 2048 })).toBe('2.0KB')
    expect(formatToolSummary('write', { content: [], isError: false, details: { path: 'src/b.ts', written: false, warning: 'conflict' } })).toContain('not written')
  })

  test('MCP tool preserves raw input schema for deferred search and executes through client manager', async () => {
    const inputSchema = { type: 'object', required: ['filePath'], properties: { filePath: { type: 'string' }, optional: { type: 'string' } } }
    expect(formatMcpInputSchema(inputSchema)).toContain('"required"')

    const calls: any[] = []
    const tool = createMcpTool({
      callTool: async (serverName: string, toolName: string, args: any) => {
        calls.push({ serverName, toolName, args })
        return { content: [{ type: 'text', text: 'ok' }] }
      },
    } as any, {
      name: 'evaluate_script',
      serverName: 'chrome',
      description: 'Run JS',
      inputSchema: {
        type: 'object',
        required: ['filePath'],
        properties: {
          filePath: { type: 'string' },
          count: { type: 'integer' },
          enabled: { type: 'boolean' },
          items: { type: 'array' },
          nested: { type: 'object' },
          unknown: {},
        },
      },
    })

    const result = await tool.execute('call', { filePath: '', optional: 'x' })
    expect(result.content[0]?.text).toBe('ok')
    expect(calls).toEqual([{ serverName: 'chrome', toolName: 'evaluate_script', args: { filePath: '', optional: 'x' } }])

    registerMcpToolsAsDeferred({ getAllTools: () => [{ name: 'x', serverName: 'srv', description: 'X', inputSchema }] } as any)
  })

  test('createCodingTools builds registry tools and respects image support and skill injection', () => {
    const withoutVision = createCodingTools({ cwd: process.cwd(), modelSupportsImages: false })
    expect(withoutVision.map((tool) => tool.name)).not.toContain('vision')
    const withDeferred = createCodingTools({ cwd: process.cwd(), includeDeferred: true })
    expect(withDeferred.map((tool) => tool.name)).not.toContain('search')
    const withSkill = createCodingTools({
      cwd: process.cwd(),
      getSkills: () => [{ name: 'alpha', description: 'Alpha', filePath: 'x', baseDir: '.', disableModelInvocation: false }],
    })
    expect(withSkill.map((tool) => tool.name)).toContain('skill')

    registerDynamicDeferredTool({
      name: 'DynamicTestTool',
      policy: { defaultPermission: 'allow' },
      agent: {
        shouldDefer: true,
        create: () => ({ name: 'DynamicTestTool', label: 'Dynamic', description: 'Dynamic', parameters: Type.Object({}), execute: async () => ({ content: [] }) } as any),
      },
      presentation: {},
    })
    expect(getAllDeferredToolDefinitions().map((definition) => definition.name)).toContain('DynamicTestTool')
    unregisterDynamicDeferredTool('DynamicTestTool')
  })

  test('every registered tool separates Agent, policy, and presentation contracts', () => {
    createCodingTools({ cwd: process.cwd() })
    const definitions = getAllToolDefinitions()
    expect(definitions.length).toBeGreaterThan(0)
    for (const definition of definitions) {
      expect(typeof definition.agent.create).toBe('function')
      expect(definition.policy.defaultPermission).toBeDefined()
      expect(definition.presentation).toBeDefined()
    }
  })
})

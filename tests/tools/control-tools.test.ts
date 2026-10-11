import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Type } from 'typebox'
import { createAskUserQuestionTool } from '../../src/tools/AskUserQuestionTool/AskUserQuestionTool.ts'
import { createListMcpResourcesTool, createReadMcpResourceTool, createSkillToolWithAgent } from '../../src/tools/index.ts'
import { createTaskTool } from '../../src/tools/TaskTool/TaskTool.ts'
import { createToolSearchTool } from '../../src/tools/ToolSearchTool/ToolSearchTool.ts'

function taskList(overrides: any = {}) {
  return {
    id: 'list-1',
    title: 'Plan',
    createdAt: 'now',
    updatedAt: 'now',
    tasks: [
      { id: 'task-1', content: 'Read', completed: false, pending: false, createdAt: 'now', updatedAt: 'now' },
    ],
    stats: { total: 1, completed: 0, inProgress: 0, remaining: 1 },
    ...overrides,
  }
}

describe('control tools', () => {
  test('Ask tool consumes pending answers before parameter fallback', async () => {
    const tool = createAskUserQuestionTool('/tmp')
    const questions = [{
      question: 'Choose?',
      header: 'Choice',
      options: [
        { label: 'A', description: 'a' },
        { label: 'B', description: 'b' },
      ],
    }]
    tool.setAnswers({ 'Choose?': 'A' })

    const first = await tool.execute('ask', { questions, answers: { 'Choose?': 'B' } })
    const second = await tool.execute('ask', { questions, answers: { 'Choose?': 'B' } })

    expect(first.details?.answers).toEqual({ 'Choose?': 'A' })
    expect(second.details?.answers).toEqual({ 'Choose?': 'B' })
    expect(first.content[0]?.text).toContain('"Choose?" = "A"')
  })

  test('Task tool delegates write, claim, mark, and batch operations to persistence', async () => {
    const calls: string[] = []
    const persistence = {
      createTaskList: async (title: string, tasks: string[]) => {
        calls.push(`write:${title}:${tasks.join(',')}`)
        return taskList()
      },
      claimTaskList: async (listId: string) => {
        calls.push(`claim:${listId}`)
        return taskList({ tasks: [] })
      },
      markTask: async (listId: string | undefined, taskId: string, completed: boolean, pending: boolean) => {
        calls.push(`mark:${listId}:${taskId}:${completed}:${pending}`)
        return taskList({ tasks: [{ ...taskList().tasks[0], completed, pending }] })
      },
      markTasks: async (input: any) => {
        calls.push(`batch:${input.list_id}:${input.tasks.length}`)
        return taskList()
      },
    }
    const tool = createTaskTool('/tmp', { getPersistence: () => persistence as any })

    expect((await tool.execute('task', { action: 'write', title: 'Plan', tasks: ['Read'] })).content[0]?.text).toContain('Task list')
    await tool.execute('task', { action: 'claim', list_id: 'list-1' })
    await tool.execute('task', { action: 'mark', list_id: 'list-1', task_id: 'task-1', status: 'pending' })
    await tool.execute('task', { action: 'mark_batch', list_id: 'list-1', tasks: [{ task_id: 'task-1', checked: true }] as any })

    expect(calls).toEqual([
      'write:Plan:Read',
      'claim:list-1',
      'mark:list-1:task-1:false:true',
      'batch:list-1:1',
    ])
    await expect(tool.execute('task', { action: 'write', tasks: [] as any })).rejects.toThrow('requires a non-empty tasks array')
    await expect(tool.execute('task', { action: 'write', tasks: [{ task_id: 'task-1' }] as any })).rejects.toThrow('requires task content entries')
    await expect(tool.execute('task', { action: 'mark', task_id: 'task-1' })).rejects.toThrow('requires status')
    await expect(tool.execute('task', { action: 'mark_batch', tasks: ['bad'] as any })).rejects.toThrow('requires task update objects')
    await expect(tool.execute('task', { action: 'mark_batch', tasks: [{ task_id: 'task-1' }] as any })).rejects.toThrow('requires status')

    const unavailableBatch = createTaskTool('/tmp', { getPersistence: () => ({ ...persistence, markTasks: undefined }) as any })
    await expect(unavailableBatch.execute('task', { action: 'mark_batch', tasks: [{ task_id: 'task-1', checked: true }] as any })).rejects.toThrow('Batch task updates are unavailable')
    await expect(createTaskTool('/tmp').execute('task', { action: 'claim', list_id: 'x' })).rejects.toThrow('TaskSystem is unavailable')
  })

  test('Skill tool matches skill names and rejects missing or disabled skills', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'microcode-skill-tool-'))
    try {
      const filePath = join(cwd, 'SKILL.md')
      await writeFile(filePath, 'skill content')
      const tool = createSkillToolWithAgent({
        getSkills: () => [
          { name: 'alpha', description: 'Alpha', filePath, baseDir: cwd, disableModelInvocation: false },
          { name: 'hidden', description: 'Hidden', filePath, baseDir: cwd, disableModelInvocation: true },
        ],
      })

      const result = await tool.execute('skill', { skill: 'alpha' })
      expect(result.details?.skillName).toBe('alpha')
      expect(result.content[0]?.text).toContain('skill content')
      await expect(tool.execute('skill', { skill: '/alpha' })).rejects.toThrow('not found')
      await expect(tool.execute('skill', { skill: 'hidden' })).rejects.toThrow('cannot be invoked')
      await expect(tool.execute('skill', { skill: 'missing' })).rejects.toThrow('not found')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('MCP resource tools list and read client resources', async () => {
    const client = {
      getAllResources: () => [
        { uri: 'file://a', name: 'A', serverName: 'srv', description: 'Desc' },
        { uri: 'file://b', name: 'B', serverName: 'other' },
      ],
      readResource: async (serverName: string, uri: string) => ({
        contents: [{ uri, text: `from ${serverName}`, mimeType: 'text/plain' }],
      }),
    } as any

    const listed = await createListMcpResourcesTool(client).execute('list', { server: 'srv' })
    expect(listed.content[0]?.text).toContain('file://a')
    expect(listed.content[0]?.text).not.toContain('file://b')
    const read = await createReadMcpResourceTool(client).execute('read', { server: 'srv', uri: 'file://a' })
    expect(read.content[0]?.text).toContain('from srv')
  })

  test('ToolSearch discovers cached schemas, probes schemas, searches keywords, and reports misses', async () => {
    const discovered: string[][] = []
    const tool = createToolSearchTool({
      getDeferredTools: () => [
        {
          name: 'mcp__demo__cached',
          policy: { defaultPermission: 'allow' },
          agent: {
            description: 'Cached browser tool',
            shouldDefer: true,
            schema: '{"type":"object"}',
            create: () => { throw new Error('should not probe cached schema') },
          },
          presentation: {},
        },
        {
          name: 'DeferredExample',
          policy: { defaultPermission: 'allow' },
          agent: {
            description: 'Example search target',
            shouldDefer: true,
            create: () => ({
              name: 'DeferredExample',
              label: 'Deferred',
              description: 'Deferred',
              parameters: Type.Object({ value: Type.String() }),
              execute: async () => ({ content: [] }),
            } as any),
          },
          presentation: {},
        },
      ],
      onToolsDiscovered: (names) => discovered.push(names),
    })

    expect((await tool.execute('search', { query: 'select:mcp__demo__cached' })).content[0]?.text).toContain('"type"')
    expect((await tool.execute('search', { query: 'example' })).content[0]?.text).toContain('DeferredExample')
    expect((await tool.execute('search', { query: 'missing' })).details).toMatchObject({ matches: [] })
    expect(discovered.flat()).toContain('mcp__demo__cached')
  })
})

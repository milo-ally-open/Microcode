import { describe, expect, test } from 'bun:test'
import { PermissionManager } from '../../src/permissions/manager.ts'
import { extractContentForMatching, matchRule, parseRuleString, ruleValueToString } from '../../src/permissions/rules.ts'

describe('permissions modules', () => {
  test('parses, serializes, and matches permission rules by content', () => {
    const parsed = parseRuleString('bash(rm:*)')
    expect(parsed).toEqual({ toolName: 'bash', ruleContent: 'rm:*' })
    expect(ruleValueToString(parsed)).toBe('bash(rm:*)')
    expect(extractContentForMatching('unknown', { command: 'rm -rf /tmp' })).toBe('rm -rf /tmp')
    expect(extractContentForMatching('unknown', { unrelated: true })).toBeUndefined()
    expect(matchRule('BASH', { command: 'rm -rf /tmp' }, [{ ...parsed, behavior: 'deny', source: 'cliArg' }])?.behavior).toBe('deny')
    expect(matchRule('bash', {}, [{ toolName: 'bash', behavior: 'allow', source: 'cliArg' }])?.behavior).toBe('allow')
    expect(matchRule('bash', { command: 'rm -rf /tmp' }, [{ toolName: 'bash', ruleContent: 'rm*', behavior: 'deny', source: 'cliArg' }])?.behavior).toBe('deny')
    expect(matchRule('bash', { command: 'git status' }, [{ toolName: 'bash', ruleContent: 'status', behavior: 'allow', source: 'cliArg' }])?.behavior).toBe('allow')
    expect(matchRule('bash', {}, [{ toolName: 'bash', ruleContent: 'rm:*', behavior: 'deny', source: 'cliArg' }])).toBeUndefined()
    expect(matchRule('write', { file_path: 'src/a.ts' }, [{ toolName: 'write', ruleContent: 'src', behavior: 'allow', source: 'cliArg' }])?.behavior).toBe('allow')
  })

  test('permission manager prioritizes deny, then ask, then allow and snapshots immutably', async () => {
    let requested = false
    const manager = new PermissionManager({
      mode: 'interactive',
      allowedTools: ['read'],
      askTools: ['write'],
      deniedTools: ['bash(rm:*)'],
      onPermissionRequest: async () => {
        requested = true
        return true
      },
    })

    expect(manager.checkPermission('bash', { command: 'rm -rf /tmp' }).allowed).toBe(false)
    expect(manager.checkPermission('write', { path: 'a' }).reason).toBe('ask')
    expect(manager.checkPermission('read', { path: 'a' }).allowed).toBe(true)

    const result = await manager.checkPermissionWithPrompt({
      toolCall: { name: 'write', arguments: { path: 'a' } },
      args: { path: 'a' },
    } as any)
    expect(result).toBeUndefined()
    expect(requested).toBe(true)

    const snapshot = manager.getSnapshot()
    expect(() => ((snapshot.allowRules as any).push({}))).toThrow()
  })

  test('permission manager supports rule mutation and ask answers', async () => {
    const askTool: any = { setAnswers: (answers: any) => { askTool.answers = answers } }
    const manager = new PermissionManager({
      mode: 'interactive',
      getTool: () => askTool,
      onAskUserQuestion: async () => ({ answers: { Q: 'A' } }),
    })

    manager.addSessionRule('read', 'src/*')
    expect(manager.getContext().allowRules).toHaveLength(1)
    manager.removeRule({ toolName: 'read', ruleContent: 'src/*' }, 'allow')
    expect(manager.getContext().allowRules).toHaveLength(0)
    manager.addRule({ toolName: 'write', behavior: 'ask', source: 'session' })
    expect(manager.getEffectivePolicy().rules[0].toolName).toBe('write')

    const askResult = await manager.checkPermissionWithPrompt({
      toolCall: { name: 'Ask', arguments: { questions: [] } },
      args: { questions: [] },
    } as any)
    expect(askResult).toBeUndefined()
    expect(askTool.answers).toEqual({ Q: 'A' })

    const prompted = new PermissionManager()
    prompted.setOnPermissionRequest(async (_tool, _input, description) => description.includes('write'))
    prompted.setGetTool(() => undefined)
    prompted.setMode('interactive')
    expect(await prompted.checkPermissionWithPrompt({
      toolCall: { name: 'write', arguments: { file_path: 'a' } },
      args: { file_path: 'a' },
    } as any)).toBeUndefined()

    const denied = new PermissionManager({ onPermissionRequest: async () => false })
    expect((await denied.checkPermissionWithPrompt({
      toolCall: { name: 'write', arguments: { file_path: 'a' } },
      args: { file_path: 'a' },
    } as any))?.reason).toContain('denied by user')
  })
})

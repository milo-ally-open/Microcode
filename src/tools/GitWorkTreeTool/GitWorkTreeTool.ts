import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { Type, type Static } from 'typebox'
import type { PermissionBehavior } from '../../permissions/types.ts'
import type { GitWorkTreeSystem } from '../../git/index.ts'

export const TOOL_NAME = 'worktree'
export const TOOL_DEFAULT_PERMISSION: PermissionBehavior = 'ask'

const schema = Type.Object({
  action: Type.Union([
    Type.Literal('create'),
    Type.Literal('list'),
    Type.Literal('status'),
    Type.Literal('diff'),
    Type.Literal('merge'),
    Type.Literal('remove'),
  ]),
  id: Type.Optional(Type.String({
    description: 'Short worktree ID. Required for create, status, diff, merge, and remove.',
  })),
  force: Type.Optional(Type.Boolean({
    description: 'Allow removal of a worktree with unmerged changes.',
  })),
}, { additionalProperties: false })

function textResult<T>(text: string, details: T): AgentToolResult<T> {
  return { content: [{ type: 'text', text }], details }
}

export function createGitWorkTreeTool(
  getSystem: () => Promise<GitWorkTreeSystem>,
): AgentTool<typeof schema, unknown> {
  let system: GitWorkTreeSystem | undefined
  let systemPromise: Promise<GitWorkTreeSystem> | undefined
  const resolveSystem = async () => {
    if (system) return system
    systemPromise ??= getSystem()
    try {
      system = await systemPromise
      return system
    } catch (error) {
      systemPromise = undefined
      throw error
    }
  }
  return {
    name: TOOL_NAME,
    label: 'Worktree',
    description:
      'Create and manage isolated Git worktrees. Review changes with diff/status, merge them, or remove them when finished.',
    parameters: schema,
    async execute(_toolCallId, input: Static<typeof schema>) {
      const system = await resolveSystem()

      if (input.action === 'list') {
        const worktrees = system.list()
        const text = worktrees.length === 0
          ? 'No worktrees managed in this session.'
          : worktrees.map((item) => `${item.id} ${item.branch} ${item.path}`).join('\n')
        return textResult(text, { worktrees })
      }

      if (!input.id) throw new Error(`id is required for worktree ${input.action}.`)

      if (input.action === 'create') {
        const worktree = await system.create(input.id)
        return textResult(
          `Created worktree ${worktree.id}\nBranch: ${worktree.branch}\nPath: ${worktree.path}`,
          worktree,
        )
      }
      if (input.action === 'status') {
        const status = await system.status(input.id)
        return textResult(
          `${status.id} ${status.branch}\nPath: ${status.path}\nAhead: ${status.ahead}\n` +
          (status.changes.length > 0 ? status.changes.join('\n') : 'Clean'),
          status,
        )
      }
      if (input.action === 'diff') {
        const diff = await system.diff(input.id)
        return textResult(diff || 'No changes.', { id: input.id, diff })
      }
      if (input.action === 'merge') {
        const result = await system.merge(input.id)
        return textResult(result.message, result)
      }

      await system.remove(input.id, input.force ?? false)
      return textResult(`Removed worktree ${input.id}.`, { id: input.id, removed: true })
    },
  }
}

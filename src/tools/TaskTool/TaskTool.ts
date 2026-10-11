import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { Type, type Static } from 'typebox'
import type { AgentSessionPersistence } from '../../agent/persistence.ts'
import type { PermissionBehavior } from '../../permissions/types.ts'
import type { TaskList } from '../../tasks/TaskSystem.ts'

export const TOOL_NAME = 'task'
export const TOOL_DEFAULT_PERMISSION: PermissionBehavior = 'allow'

const taskInputItemSchema = Type.Union([
  Type.String({ description: 'Task content' }),
  Type.Object({
    id: Type.Optional(Type.String({ description: 'Optional caller-provided task ID' })),
    status: Type.Optional(
      Type.Union([
        Type.Literal('pending'),
        Type.Literal('completed'),
      ]),
    ),
    content: Type.String({ description: 'Concrete task content' }),
  }),
])

const taskMarkItemSchema = Type.Object({
  task_id: Type.String({ description: 'Task ID such as "task-1".' }),
  completed: Type.Optional(Type.Boolean()),
  checked: Type.Optional(Type.Boolean({ description: 'Alias for completed.' })),
  status: Type.Optional(Type.Literal('pending')),
}, { additionalProperties: false })

const taskSchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal('write'),
      Type.Literal('claim'),
      Type.Literal('mark'),
      Type.Literal('mark_batch'),
    ],
    {
      description:
        'Operation to perform: write creates a list, claim loads unfinished tasks, mark updates one task, mark_batch updates several tasks in one write.',
    },
  ),
  title: Type.Optional(
    Type.String({
      description: 'For action="write": short task-list title. Defaults to "Task list".',
    }),
  ),
  tasks: Type.Optional(
    Type.Array(Type.Union([taskInputItemSchema, taskMarkItemSchema]), {
      minItems: 1,
      description:
        'For write: ordered task contents. For mark_batch: objects like {"task_id":"task-1","checked":true}.',
    }),
  ),
  list_id: Type.Optional(
    Type.String({
      description:
        'Required for action="claim". Optional for action="mark"; when omitted, the most recent matching list is used.',
    }),
  ),
  task_id: Type.Optional(
    Type.String({ description: 'Required for action="mark": task ID such as "task-1".' }),
  ),
  completed: Type.Optional(
    Type.Boolean({
      description: 'For action="mark": true marks complete; false reopens the task.',
    }),
  ),
  checked: Type.Optional(
    Type.Boolean({ description: 'Alias for completed when action="mark". Defaults to true.' }),
  ),
  status: Type.Optional(
    Type.Union(
      [Type.Literal('pending')],
      { description: 'Mark a task as pending (actively working on it).' },
    ),
  ),
}, {
  additionalProperties: false,
  description:
    'Session task-list operation. Pass fields at the top level; never wrap them in another object.',
})

export type TaskToolInput = Static<typeof taskSchema>

export interface TaskToolDetails {
  action: TaskToolInput['action']
  list: TaskList
}

function requirePersistence(
  getPersistence: () => AgentSessionPersistence | undefined,
): AgentSessionPersistence & Required<Pick<
  AgentSessionPersistence,
  'createTaskList' | 'claimTaskList' | 'markTask'
>> {
  const persistence = getPersistence()
  if (
    !persistence?.createTaskList ||
    !persistence.claimTaskList ||
    !persistence.markTask
  ) {
    throw new Error('TaskSystem is unavailable because no session persistence is configured.')
  }
  return persistence as AgentSessionPersistence & Required<Pick<
    AgentSessionPersistence,
    'createTaskList' | 'claimTaskList' | 'markTask'
  >>
}

function formatTaskList(list: TaskList): string {
  const stats = list.stats ?? {
    total: list.tasks.length,
    completed: list.tasks.filter((task) => task.completed).length,
    inProgress: list.tasks.filter((task) => !task.completed && task.pending).length,
    remaining: list.tasks.filter((task) => !task.completed && !task.pending).length,
  }
  const lines = [
    `Task list "${list.title}" (${list.id})`,
    `Total: ${stats.total} tasks, Completed: ${stats.completed}, In progress: ${stats.inProgress}, Remaining: ${stats.remaining}`,
  ]
  if (list.tasks.length === 0) {
    lines.push('No unfinished tasks.')
  } else {
    lines.push(
      ...list.tasks.map((task) => {
        const marker = task.completed ? '[x]' : task.pending ? '[~]' : '[ ]'
        return `${marker} ${task.id}: ${task.content}`
      }),
    )
  }
  return lines.join('\n')
}

function normalizeWriteTask(
  task: string | { content: string },
): string {
  return typeof task === 'string' ? task : task.content
}

function resolveMarkCompleted(params: TaskToolInput): { completed: boolean; pending: boolean } {
  if (params.status === 'pending') {
    return { completed: false, pending: true }
  }
  const completed = params.completed ?? params.checked
  if (completed === undefined) {
    throw new Error(
      'action="mark" requires status="pending", completed, or checked.',
    )
  }
  return { completed, pending: false }
}

function requireTasks(
  tasks: TaskToolInput['tasks'],
  action: 'write' | 'mark_batch',
): NonNullable<TaskToolInput['tasks']> {
  if (!tasks || tasks.length === 0) {
    throw new Error(`action="${action}" requires a non-empty tasks array.`)
  }
  return tasks
}

function requireString(value: string | undefined, field: string, action: string): string {
  if (!value?.trim()) {
    throw new Error(`action="${action}" requires ${field}.`)
  }
  return value
}

export function createTaskTool(
  _cwd: string,
  options: {
    getPersistence?: () => AgentSessionPersistence | undefined
  } = {},
): AgentTool<typeof taskSchema, TaskToolDetails> {
  const getPersistence = options.getPersistence ?? (() => undefined)

  return {
    name: TOOL_NAME,
    label: 'Tasks',
    description:
      'Manage session-scoped task lists. Pass arguments directly at the top level. Examples: write={"action":"write","title":"Implement feature","tasks":["Inspect code","Implement change","Run tests"]}; claim={"action":"claim","list_id":"list-id"}; mark={"action":"mark","task_id":"task-1","checked":true}; mark_batch={"action":"mark_batch","list_id":"list-id","tasks":[{"task_id":"task-1","checked":true}]}. Never call with {} and never wrap arguments under another key.',
    parameters: taskSchema,
    async execute(
      _toolCallId: string,
      params: TaskToolInput,
      _signal?: AbortSignal,
      onUpdate?: (partial: AgentToolResult<TaskToolDetails>) => void,
    ): Promise<AgentToolResult<TaskToolDetails>> {
      const persistence = requirePersistence(getPersistence)

      onUpdate?.({
        content: [{ type: 'text', text: `Managing tasks: ${params.action}` }],
        details: {
          action: params.action,
          list: {
            id: '',
            title: '',
            tasks: [],
            createdAt: '',
            updatedAt: '',
          },
        },
      })

      if (params.action === 'write') {
        const title = params.title?.trim() || 'Task list'
        const rawTasks = requireTasks(params.tasks, 'write')
        if (rawTasks.some((task) =>
          typeof task !== 'string' && !('content' in task)
        )) {
          throw new Error('action="write" requires task content entries.')
        }
        const tasks = rawTasks.map((task) =>
          normalizeWriteTask(task as string | { content: string })
        )
        const list = await persistence.createTaskList(title, tasks)
        return {
          content: [{ type: 'text', text: formatTaskList(list) }],
          details: { action: params.action, list },
        }
      }

      if (params.action === 'claim') {
        const listId = requireString(params.list_id, 'list_id', 'claim')
        const list = await persistence.claimTaskList(listId)
        return {
          content: [{ type: 'text', text: formatTaskList(list) }],
          details: { action: params.action, list },
        }
      }

      if (params.action === 'mark_batch') {
        if (!persistence.markTasks) {
          throw new Error('Batch task updates are unavailable in session persistence.')
        }
        const rawTasks = requireTasks(params.tasks, 'mark_batch')
        if (rawTasks.some((task) =>
          typeof task === 'string' || !('task_id' in task)
        )) {
          throw new Error('action="mark_batch" requires task update objects.')
        }
        const tasks = rawTasks.map((task) => {
          const update = task as {
            task_id: string
            completed?: boolean
            checked?: boolean
            status?: 'pending'
          }
          if (
            update.status !== 'pending' &&
            update.completed === undefined &&
            update.checked === undefined
          ) {
            throw new Error(
              `action="mark_batch" task "${update.task_id}" requires status="pending", completed, or checked.`,
            )
          }
          return update
        })
        const list = await persistence.markTasks({
          list_id: params.list_id,
          tasks,
        })
        return {
          content: [{ type: 'text', text: formatTaskList(list) }],
          details: { action: params.action, list },
        }
      }

      const taskId = requireString(params.task_id, 'task_id', 'mark')
      const { completed, pending } = resolveMarkCompleted(params)
      const list = await persistence.markTask(
        params.list_id,
        taskId,
        completed,
        pending,
      )
      return {
        content: [{ type: 'text', text: formatTaskList(list) }],
        details: { action: params.action, list },
      }
    },
  }
}

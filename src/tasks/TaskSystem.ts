import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { dirname, join } from 'path'

export interface TaskItem {
  id: string
  content: string
  completed: boolean
  pending?: boolean
  reminder?: boolean
  createdAt: string
  updatedAt: string
}

export interface TaskList {
  id: string
  title: string
  tasks: TaskItem[]
  createdAt: string
  updatedAt: string
  stats?: TaskListStats
}

export interface TaskListStats {
  total: number
  completed: number
  inProgress: number
  remaining: number
}

export interface TaskMarkUpdate {
  task_id: string
  completed?: boolean
  checked?: boolean
  status?: 'pending'
}

export interface TaskReminderUpdate {
  task_id: string
  reminder?: boolean
}

interface SessionTaskData {
  version: 1
  lists: TaskList[]
}

const EMPTY_DATA: SessionTaskData = { version: 1, lists: [] }
const MAX_REMINDER_TASKS_PER_LIST = 20

function cloneList(list: TaskList): TaskList {
  return {
    ...list,
    stats: list.stats ? { ...list.stats } : undefined,
    tasks: list.tasks.map((task) => ({ ...task })),
  }
}

function getStats(tasks: readonly TaskItem[]): TaskListStats {
  const completed = tasks.filter((task) => task.completed).length
  const inProgress = tasks.filter((task) => !task.completed && task.pending).length
  return {
    total: tasks.length,
    completed,
    inProgress,
    remaining: tasks.length - completed - inProgress,
  }
}

function createId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 8)
  return `${prefix}-${Date.now().toString(36)}-${random}`
}

function validateSessionId(sessionId: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(sessionId)) {
    throw new Error('Invalid session ID.')
  }
  return sessionId
}

export class TaskSystem {
  private readonly sessionQueues = new Map<string, Promise<void>>()

  constructor(private readonly root: string) {}

  async createList(
    sessionId: string,
    title: string,
    contents: readonly string[],
  ): Promise<TaskList> {
    return this.withSessionLock(sessionId, async () => {
      const data = await this.read(sessionId)
      const normalizedTitle = title.trim()
      const normalizedContents = contents.map((content) => content.trim())
      if (!normalizedTitle) {
        throw this.businessError('Task list title cannot be empty.', data)
      }
      if (normalizedContents.length === 0) {
        throw this.businessError('A task list must contain at least one task.', data)
      }
      if (normalizedContents.some((content) => !content)) {
        throw this.businessError('Task content cannot be empty.', data)
      }

      const now = new Date().toISOString()
      const list: TaskList = {
        id: createId('list'),
        title: normalizedTitle,
        tasks: normalizedContents.map((content, index) => ({
          id: `task-${index + 1}`,
          content,
          completed: false,
          pending: false,
          reminder: false,
          createdAt: now,
          updatedAt: now,
        })),
        createdAt: now,
        updatedAt: now,
      }
      data.lists.push(list)
      await this.write(sessionId, data)
      return cloneList({ ...list, stats: getStats(list.tasks) })
    })
  }

  async listTaskLists(sessionId: string): Promise<TaskList[]> {
    return this.withSessionLock(sessionId, async () => {
      const data = await this.read(sessionId)
      return data.lists.map((list) =>
        cloneList({ ...list, stats: getStats(list.tasks) })
      )
    })
  }

  async getReminder(sessionId: string): Promise<string | undefined> {
    return this.withSessionLock(sessionId, async () => {
      const data = await this.read(sessionId)
      const activeLists = data.lists
        .map((list) => ({
          ...list,
          tasks: list.tasks.filter((task) => !task.completed),
        }))
        .filter((list) => list.tasks.length > 0)

      if (activeLists.length === 0) return undefined

      const focusedTasks = activeLists.flatMap((list) =>
        list.tasks
          .filter((task) => task.reminder === true)
          .map((task) => ({ list, task })),
      )
      const lines = [
        '<reminder>',
        'You have unfinished tasks in the current session.',
        'Keep the task list synchronized: work from these tasks and call the task tool with action="mark" immediately after completing or reopening each task.',
        '',
      ]

      if (focusedTasks.length > 0) {
        lines.push(
          'User-selected priority tasks:',
          'The user explicitly selected these tasks through /tasks. Prioritize completing them and keep their status updated.',
        )
        for (const { list, task } of focusedTasks) {
          lines.push(
            `- [!] ${task.id}: ${task.content} (list_id: ${list.id}, list: ${list.title})`,
          )
        }
        lines.push('')
      }

      for (const list of activeLists) {
        const regularTasks = list.tasks.filter((task) => task.reminder !== true)
        if (regularTasks.length === 0) continue
        lines.push(`Task list: ${list.title} (list_id: ${list.id})`)
        for (const task of regularTasks.slice(0, MAX_REMINDER_TASKS_PER_LIST)) {
          const marker = task.pending ? '[~]' : '[ ]'
          lines.push(`- ${marker} ${task.id}: ${task.content}`)
        }
        if (regularTasks.length > MAX_REMINDER_TASKS_PER_LIST) {
          lines.push(
            `- ... ${regularTasks.length - MAX_REMINDER_TASKS_PER_LIST} more unfinished tasks`,
          )
        }
        lines.push('')
      }

      const totalUnfinished = activeLists.reduce(
        (total, list) => total + list.tasks.length,
        0,
      )
      const hidden = activeLists.reduce((total, list) => {
        const regularCount = list.tasks.filter(
          (task) => task.reminder !== true,
        ).length
        return total + Math.max(0, regularCount - MAX_REMINDER_TASKS_PER_LIST)
      }, 0)
      lines.push(
        'Do not merely say a task is complete; update its status with the task tool.',
        `<!-- task-reminder-meta: ${activeLists.length} lists, ${totalUnfinished} total unfinished, ${hidden} hidden (capped by MAX_REMINDER) -->`,
        '</reminder>',
      )
      return lines.join('\n')
    })
  }

  async getTaskList(sessionId: string, listId: string): Promise<TaskList | undefined> {
    return this.withSessionLock(sessionId, async () => {
      const data = await this.read(sessionId)
      const list = data.lists.find((item) => item.id === listId)
      return list
        ? cloneList({ ...list, stats: getStats(list.tasks) })
        : undefined
    })
  }

  async claimTaskList(sessionId: string, listId: string): Promise<TaskList> {
    return this.withSessionLock(sessionId, async () => {
      const data = await this.read(sessionId)
      const list = data.lists.find((item) => item.id === listId)
      if (!list) {
        throw this.businessError(`Task list not found: ${listId}`, data)
      }
      return cloneList({
        ...list,
        tasks: list.tasks.filter((task) => !task.completed),
        stats: getStats(list.tasks),
      })
    })
  }

  async remindTask(
    sessionId: string,
    listId: string,
    taskId: string,
    reminder = true,
  ): Promise<TaskList> {
    return this.remindTasks(sessionId, listId, [{ task_id: taskId, reminder }])
  }

  async remindTasks(
    sessionId: string,
    listId: string,
    tasks: readonly TaskReminderUpdate[],
  ): Promise<TaskList> {
    return this.withSessionLock(sessionId, async () => {
      const data = await this.read(sessionId)
      const list = data.lists.find((item) => item.id === listId)
      if (!list) throw this.businessError(`Task list not found: ${listId}`, data)
      if (tasks.length === 0) {
        throw this.businessError('remindTasks requires at least one task.', data, list)
      }

      const resolved = tasks.map((update) => {
        const task = list.tasks.find((item) => item.id === update.task_id)
        if (!task) {
          throw this.businessError(`Task '${update.task_id}' not found.`, data, list)
        }
        if (task.completed && update.reminder !== false) {
          throw this.businessError(
            'Completed tasks cannot be added as reminders.',
            data,
            list,
          )
        }
        return { task, reminder: update.reminder ?? true }
      })
      const now = new Date().toISOString()
      for (const update of resolved) {
        update.task.reminder = update.reminder
        update.task.updatedAt = now
      }
      list.updatedAt = now
      await this.write(sessionId, data)
      return cloneList({ ...list, stats: getStats(list.tasks) })
    })
  }

  async markTask(
    sessionId: string,
    listId: string | undefined,
    taskId: string,
    completed: boolean,
    pending?: boolean,
  ): Promise<TaskList> {
    return this.markTasks(sessionId, {
      list_id: listId,
      tasks: [{
        task_id: taskId,
        completed,
        status: !completed && pending ? 'pending' : undefined,
      }],
    })
  }

  async markTasks(
    sessionId: string,
    input: { list_id?: string; tasks: readonly TaskMarkUpdate[] },
  ): Promise<TaskList> {
    return this.withSessionLock(sessionId, async () => {
      const data = await this.read(sessionId)
      if (input.tasks.length === 0) {
        throw this.businessError('markTasks requires at least one task.', data)
      }
      const list = input.list_id
        ? data.lists.find((item) => item.id === input.list_id)
        : [...data.lists].reverse().find((item) =>
            input.tasks.every((update) =>
              item.tasks.some((task) => task.id === update.task_id)
            )
          )
      if (!list) {
        throw this.businessError(
          input.list_id
            ? `Task list not found: ${input.list_id}`
            : 'No task list contains all requested tasks.',
          data,
        )
      }

      const resolved = input.tasks.map((update) => {
        const task = list.tasks.find((item) => item.id === update.task_id)
        if (!task) {
          throw this.businessError(`Task '${update.task_id}' not found.`, data, list)
        }
        const completed = update.completed ?? update.checked
        if (update.status !== 'pending' && completed === undefined) {
          throw this.businessError(
            `Task '${update.task_id}' requires status="pending", completed, or checked.`,
            data,
            list,
          )
        }
        return {
          task,
          completed: update.status === 'pending' ? false : completed!,
          pending: update.status === 'pending',
        }
      })
      const now = new Date().toISOString()
      for (const update of resolved) {
        update.task.completed = update.completed
        update.task.pending = update.completed ? false : update.pending
        if (update.completed) update.task.reminder = false
        update.task.updatedAt = now
      }
      list.updatedAt = now
      await this.write(sessionId, data)
      return cloneList({ ...list, stats: getStats(list.tasks) })
    })
  }

  private filePath(sessionId: string): string {
    return join(this.root, `${validateSessionId(sessionId)}.json`)
  }

  private async read(sessionId: string): Promise<SessionTaskData> {
    return this.retryIo(async () => {
      try {
        const raw = await readFile(this.filePath(sessionId), 'utf8')
        const parsed = JSON.parse(raw) as Partial<SessionTaskData>
        if (parsed.version !== 1 || !Array.isArray(parsed.lists)) {
          throw new Error('Unsupported task data format.')
        }
        return { version: 1, lists: parsed.lists }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return { ...EMPTY_DATA, lists: [] }
        }
        throw error
      }
    })
  }

  private async write(sessionId: string, data: SessionTaskData): Promise<void> {
    await this.retryIo(async () => {
      const target = this.filePath(sessionId)
      await mkdir(dirname(target), { recursive: true })
      const temporary =
        `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
      await writeFile(temporary, JSON.stringify(data, null, 2), 'utf8')
      await rename(temporary, target)
    })
  }

  private withSessionLock<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = validateSessionId(sessionId)
    const previous = this.sessionQueues.get(key) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(operation)
    const tail = result.then(() => undefined, () => undefined)
    this.sessionQueues.set(key, tail)
    return result.finally(() => {
      if (this.sessionQueues.get(key) === tail) this.sessionQueues.delete(key)
    })
  }

  private async retryIo<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      if (!(error as NodeJS.ErrnoException).code) throw error
      return operation()
    }
  }

  private businessError(
    message: string,
    data: SessionTaskData,
    list?: TaskList,
  ): Error {
    if (list) {
      return new Error(
        `${message} Current tasks in list '${list.id}': ${this.snapshot(list)}`,
      )
    }
    const snapshots = data.lists.length === 0
      ? 'No current task lists.'
      : data.lists.map((item) =>
          `Current tasks in list '${item.id}': ${this.snapshot(item)}`
        ).join(' | ')
    return new Error(`${message} ${snapshots}`)
  }

  private snapshot(list: TaskList): string {
    return list.tasks.map((task) => {
      const marker = task.completed ? '[x]' : task.pending ? '[~]' : '[ ]'
      return `[${task.id}] ${marker} ${task.content}`
    }).join(', ')
  }
}

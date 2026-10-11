import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type {
  TaskList,
  TaskMarkUpdate,
  TaskReminderUpdate,
} from '../tasks/TaskSystem.ts'

export interface AgentCompactionRecord {
  summary: string
  messages: AgentMessage[]
  tokensBefore: number
  tokensAfter: number
  keptMessageCount: number
  compactedMessageCount: number
  automatic: boolean
  model: {
    provider: string
    modelId: string
    contextWindow: number
  }
}

export interface AgentSessionPersistence {
  saveMessages(messages: readonly AgentMessage[]): Promise<void>
  recordCompaction(record: AgentCompactionRecord): Promise<void>
  getSessionId?(): string | null
  createTaskList?(title: string, tasks: readonly string[]): Promise<TaskList>
  listTaskLists?(): Promise<TaskList[]>
  getTaskReminder?(): Promise<string | undefined>
  claimTaskList?(listId: string): Promise<TaskList>
  remindTask?(listId: string, taskId: string, reminder?: boolean): Promise<TaskList>
  remindTasks?(listId: string, tasks: readonly TaskReminderUpdate[]): Promise<TaskList>
  markTask?(
    listId: string | undefined,
    taskId: string,
    completed: boolean,
    pending?: boolean,
  ): Promise<TaskList>
  markTasks?(input: {
    list_id?: string
    tasks: readonly TaskMarkUpdate[]
  }): Promise<TaskList>
}

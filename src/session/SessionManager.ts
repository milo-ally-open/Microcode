import * as path from 'path'
import * as os from 'os'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import {
  type JsonlSessionMetadata,
  type AgentMessage,
} from '@earendil-works/pi-agent-core'
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core'
import { JsonlSessionRepo, type JsonValue, type Session, type Entry } from '@earendil-works/pi-agent-core/harness/session'
import { NodeFileSystem } from './NodeFileSystem.ts'
import { replaceImageBlocksForPersistence } from './imageSerializer.ts'
import { findModel } from '../models/index.ts'
import { getCompactUserSummaryMessage } from './compactPrompt.ts'
import { restoreLegacyCompactionContext } from './CompactionManager.ts'
import type {
  AgentCompactionRecord,
  AgentSessionPersistence,
} from '../agent/persistence.ts'
import {
  TaskSystem,
  type TaskList,
  type TaskMarkUpdate,
  type TaskReminderUpdate,
} from '../tasks/TaskSystem.ts'

const SESSIONS_DIR = path.join(os.homedir(), '.microcode', 'sessions')
const TITLES_FILE = path.join(SESSIONS_DIR, '.titles.json')
const TASKS_DIR = path.join(SESSIONS_DIR, '.tasks')
const COMPACTION_CHECKPOINT_TYPE = 'microcode.compaction-checkpoint'

interface CompactionCheckpoint {
  version: 1
  summary: string
  contextMessages: AgentMessage[]
  tokensBefore: number
  tokensAfter: number
  keptMessageCount: number
  compactedMessageCount: number
  automatic: boolean
  model: AgentCompactionRecord['model']
}

function isCompactionCheckpoint(data: unknown): data is CompactionCheckpoint {
  if (!data || typeof data !== 'object') return false
  const checkpoint = data as Partial<CompactionCheckpoint>
  return checkpoint.version === 1 &&
    typeof checkpoint.summary === 'string' &&
    Array.isArray(checkpoint.contextMessages) &&
    typeof checkpoint.tokensBefore === 'number' &&
    typeof checkpoint.tokensAfter === 'number'
}

function getLegacyCompactionSummary(message: AgentMessage): { summary: string; tokensBefore: number } | undefined {
  if (message.role !== 'user' || typeof message.content !== 'string') return undefined
  const match = message.content.match(/^\[Earlier conversation summarized \((\d+) tokens before compaction\)\]:\n([\s\S]*)$/)
  if (!match) return undefined
  return { tokensBefore: Number(match[1]), summary: match[2] ?? '' }
}

export interface SessionListItem extends JsonlSessionMetadata {
  title?: string
}

/**
 * Manages session lifecycle: create, persist, resume, list.
 * Wraps pi-agent-core's JsonlSessionRepo and Session.
 */
export class SessionManager implements AgentSessionPersistence {
  private repo: JsonlSessionRepo
  private session: Session | null = null
  private metadata: JsonlSessionMetadata | null = null
  private draftCwd: string | null = null
  private createPromise: Promise<string> | null = null
  private savedMessageCount = 0
  private titleCache: Map<string, string> | null = null
  private readonly taskSystem: TaskSystem

  constructor(options: { sessionsRoot?: string; tasksRoot?: string } = {}) {
    const fs = new NodeFileSystem('/')
    this.repo = new JsonlSessionRepo({
      fileSystem: fs,
      sessionsRoot: options.sessionsRoot ?? SESSIONS_DIR,
    })
    this.taskSystem = new TaskSystem(options.tasksRoot ?? TASKS_DIR)
  }

  /**
   * Create a new session for the given working directory.
   */
  async create(cwd: string): Promise<string> {
    this.session = await this.repo.create({ cwd }, BACKGROUND_CONTEXT)
    await this.ensureMainBranch(this.session)
    this.metadata = this.session.metadata as JsonlSessionMetadata
    this.draftCwd = null
    this.savedMessageCount = 0
    return this.metadata.id
  }

  /**
   * Start a new in-memory session without writing anything to disk yet.
   */
  beginDraft(cwd: string): void {
    this.session = null
    this.metadata = null
    this.draftCwd = cwd
    this.savedMessageCount = 0
  }

  /**
   * Materialize the current draft session only when durable state is needed.
   */
  async ensureCreated(cwd?: string): Promise<string> {
    if (this.metadata?.id) return this.metadata.id
    const targetCwd = cwd ?? this.draftCwd
    if (!targetCwd) throw new Error('No active session.')
    if (!this.createPromise) {
      this.createPromise = this.create(targetCwd).finally(() => {
        this.createPromise = null
      })
    }
    return this.createPromise
  }

  isDraft(): boolean {
    return !this.metadata && Boolean(this.draftCwd)
  }

  /**
   * Resume an existing session from metadata.
   */
  async open(meta: JsonlSessionMetadata): Promise<AgentMessage[]> {
    this.session = await this.repo.open(meta, BACKGROUND_CONTEXT)
    await this.ensureMainBranch(this.session)
    this.metadata = meta
    this.draftCwd = null
    const messages = await this.readSessionMessages(this.session)
    this.savedMessageCount = messages.length
    return messages
  }

  /**
   * List available sessions, optionally filtered by cwd.
   */
  async list(cwd?: string): Promise<JsonlSessionMetadata[]> {
    return this.repo.list({ cwd }, BACKGROUND_CONTEXT)
  }

  /**
   * Get the most recent session for a given cwd, if any.
   */
  async getLatestSession(cwd: string): Promise<JsonlSessionMetadata | null> {
    const sessions = await this.list(cwd)
    return sessions[0] ?? null
  }

  /**
   * Persist new messages to the session.
   * Only appends messages that haven't been saved yet.
   */
  async saveMessages(messages: readonly AgentMessage[]): Promise<void> {
    if (!this.session) {
      if (messages.length === 0) return
      await this.ensureCreated()
    }
    if (!this.session) return

    // Append only new messages, with image blocks replaced by text references
    for (let i = this.savedMessageCount; i < messages.length; i++) {
      const serialized = replaceImageBlocksForPersistence(messages[i])
      const branch = await this.session.branch('main', BACKGROUND_CONTEXT)
      if (!branch) throw new Error('Session main branch is unavailable.')
      await branch.appendMessage(serialized, BACKGROUND_CONTEXT)
    }
    this.savedMessageCount = messages.length
  }

  async recordCompaction(record: AgentCompactionRecord): Promise<void> {
    if (!this.session) return
    const entries = await this.session.findEntries({ order: 'asc' }, BACKGROUND_CONTEXT)
    const messageEntries = entries.filter((entry) => entry.type === 'message')
    if (messageEntries.length === 0) {
      throw new Error('No persisted messages available for compaction.')
    }
    const branch = await this.session.branch('main', BACKGROUND_CONTEXT)
    if (!branch) throw new Error('Session main branch is unavailable.')
    const checkpoint: CompactionCheckpoint = {
      version: 1,
      summary: record.summary,
      contextMessages: record.messages.map(replaceImageBlocksForPersistence),
      tokensBefore: record.tokensBefore,
      tokensAfter: record.tokensAfter,
      keptMessageCount: record.keptMessageCount,
      compactedMessageCount: record.compactedMessageCount,
      automatic: record.automatic,
      model: record.model,
    }
    await branch.appendCustomEntry(
      COMPACTION_CHECKPOINT_TYPE,
      checkpoint as unknown as JsonValue,
      BACKGROUND_CONTEXT,
    )
    this.savedMessageCount = record.compactedMessageCount
  }

  /**
   * Load all messages from the session.
   */
  async loadMessages(): Promise<AgentMessage[]> {
    if (!this.session) return []
    return this.readSessionMessages(this.session)
  }

  /** Load the append-only session log for analytics and archival inspection. */
  async loadArchiveEntries(): Promise<Entry[]> {
    if (!this.session) return []
    return this.session.findEntries({ order: 'asc' }, BACKGROUND_CONTEXT)
  }

  /**
   * Get the current session metadata.
   */
  getMetadata(): JsonlSessionMetadata | null {
    return this.metadata
  }

  /**
   * Get the session ID.
   */
  getSessionId(): string | null {
    return this.metadata?.id ?? null
  }

  async createTaskList(title: string, tasks: readonly string[]): Promise<TaskList> {
    const sessionId = await this.ensureCreated()
    return this.taskSystem.createList(sessionId, title, tasks)
  }

  async listTaskLists(): Promise<TaskList[]> {
    const sessionId = this.getSessionId()
    if (!sessionId) return []
    return this.taskSystem.listTaskLists(sessionId)
  }

  async getTaskReminder(): Promise<string | undefined> {
    const sessionId = this.getSessionId()
    if (!sessionId) return undefined
    return this.taskSystem.getReminder(sessionId)
  }

  async claimTaskList(listId: string): Promise<TaskList> {
    return this.taskSystem.claimTaskList(await this.ensureCreated(), listId)
  }

  async remindTask(listId: string, taskId: string, reminder = true): Promise<TaskList> {
    return this.taskSystem.remindTask(await this.ensureCreated(), listId, taskId, reminder)
  }

  async remindTasks(
    listId: string,
    tasks: readonly TaskReminderUpdate[],
  ): Promise<TaskList> {
    return this.taskSystem.remindTasks(await this.ensureCreated(), listId, tasks)
  }

  async markTask(
    listId: string | undefined,
    taskId: string,
    completed: boolean,
    pending?: boolean,
  ): Promise<TaskList> {
    return this.taskSystem.markTask(
      await this.ensureCreated(),
      listId,
      taskId,
      completed,
      pending,
    )
  }

  async markTasks(input: {
    list_id?: string
    tasks: readonly TaskMarkUpdate[]
  }): Promise<TaskList> {
    return this.taskSystem.markTasks(await this.ensureCreated(), input)
  }

  /**
   * Delete a session.
   */
  async delete(meta: JsonlSessionMetadata): Promise<void> {
    await this.repo.delete(meta, BACKGROUND_CONTEXT)
  }

  /**
   * Load the titles map from disk into cache.
   */
  private loadTitles(): void {
    if (this.titleCache) return
    try {
      if (existsSync(TITLES_FILE)) {
        const raw = readFileSync(TITLES_FILE, 'utf-8')
        const data = JSON.parse(raw)
        this.titleCache = new Map(Object.entries(data))
      } else {
        this.titleCache = new Map()
      }
    } catch {
      this.titleCache = new Map()
    }
  }

  /**
   * Save the titles cache back to disk.
   */
  private saveTitles(): void {
    try {
      const dir = path.dirname(TITLES_FILE)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      const data = Object.fromEntries(this.titleCache ?? new Map())
      writeFileSync(TITLES_FILE, JSON.stringify(data, null, 2))
    } catch {}
  }

  /**
   * Set the title for a session.
   */
  setTitle(sessionId: string, title: string): void {
    this.loadTitles()
    this.titleCache!.set(sessionId, title)
    this.saveTitles()
  }

  /**
   * Get the title for a session.
   */
  getTitle(sessionId: string): string | undefined {
    this.loadTitles()
    return this.titleCache?.get(sessionId)
  }

  /**
   * List sessions enriched with titles.
   */
  async listWithTitles(cwd?: string): Promise<SessionListItem[]> {
    const sessions = await this.repo.list({ cwd }, BACKGROUND_CONTEXT)
    this.loadTitles()
    return sessions.map((s) => ({
      ...s,
      title: this.titleCache?.get(s.id),
    }))
  }

  /**
   * Switch to a different session, returning its messages.
   * The caller is responsible for persisting the current runtime first.
   */
  async switchToSession(meta: JsonlSessionMetadata): Promise<AgentMessage[]> {
    this.session = await this.repo.open(meta, BACKGROUND_CONTEXT)
    await this.ensureMainBranch(this.session)
    this.metadata = meta
    this.draftCwd = null
    const messages = await this.readSessionMessages(this.session)
    this.savedMessageCount = messages.length
    return messages
  }

  private async readSessionMessages(session: Session): Promise<AgentMessage[]> {
    const entries = await session.findEntries({ order: 'asc' }, BACKGROUND_CONTEXT)
    let messages: AgentMessage[] = []
    for (const entry of entries) {
      if (entry.type === 'message') {
        const legacy = getLegacyCompactionSummary(entry.message)
        if (legacy) {
          const priorAssistant = [...messages].reverse().find((message) => message.role === 'assistant')
          const model = priorAssistant?.role === 'assistant'
            ? findModel(priorAssistant.model, priorAssistant.api, String(priorAssistant.provider))
            : undefined
          messages = model
            ? restoreLegacyCompactionContext(
                messages,
                model.contextWindow,
                legacy.tokensBefore,
                legacy.summary,
                entry.timestamp,
              )
            : [...messages, entry.message]
        } else {
          messages.push(entry.message)
        }
        continue
      }

      if (entry.type === 'compaction') {
        messages = [
          { role: 'user', content: getCompactUserSummaryMessage(entry.summary), timestamp: entry.timestamp },
          ...entry.retainedTail,
        ]
      } else if (entry.type === 'branch_summary') {
        messages.push({ role: 'user', content: `[Conversation summary]:\n${entry.summary}`, timestamp: entry.timestamp })
      } else if (entry.type === 'custom' &&
        entry.customType === COMPACTION_CHECKPOINT_TYPE &&
        isCompactionCheckpoint(entry.data)) {
        messages = [...entry.data.contextMessages]
      }
    }
    return messages
  }

  private async ensureMainBranch(session: Session): Promise<void> {
    if (await session.branch('main', BACKGROUND_CONTEXT)) return
    await session.createBranch('main', null, BACKGROUND_CONTEXT)
  }

  async close(): Promise<void> {
    await this.repo.close(BACKGROUND_CONTEXT)
  }
}

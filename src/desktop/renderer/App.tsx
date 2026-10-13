import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { PermissionMode } from '../../permissions/types.ts'
import type {
  DesktopBackendSnapshot,
  DesktopBackendStatus,
  DesktopEvent,
  DesktopFileDiff,
  DesktopImageAttachment,
  DesktopModelOption,
  DesktopProjectRef,
  DesktopReviewSnapshot,
} from '../protocol.ts'
import { applyRuntimeEvent, messageText } from './state.ts'
import { buildProjectTree, labelProjectSessions, sessionsWithActiveDraft } from './project-tree.ts'
import { buildReviewChangeTree, filterReviewChangeTree, type ReviewTreeNode } from './change-tree.ts'
import { DESKTOP_TERMINAL_THEME } from './terminal-theme.ts'
import { normalizeTerminalDimensions } from './terminal-dimensions.ts'
import { encodePastedImage, getPastedImageFiles, MAX_DESKTOP_IMAGE_ATTACHMENTS } from './image-attachments.ts'
import { redactDisplayText, redactDisplayValue } from '../security.ts'
import { SettingsPanel } from './SettingsPanel.tsx'

const h = React.createElement
const Fragment = React.Fragment

type SessionRow = { readonly id: string; readonly title?: string; readonly updatedAt?: number; readonly draft?: boolean }
type ToolRun = { readonly name: string; readonly status: 'running' | 'done' | 'error' }
type ApprovalResponder = (requestId: string, decision: 'allow' | 'allow_session' | 'deny', answers?: Readonly<Record<string, string>>, block?: boolean) => void

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readSessionRows(value: readonly unknown[]): readonly SessionRow[] {
  return value.flatMap((item) => {
    const row = object(item)
    return typeof row?.id === 'string' ? [{ id: row.id, title: typeof row.title === 'string' ? row.title : undefined, updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : undefined }] : []
  })
}

function currentModelValue(snapshot: DesktopBackendSnapshot | null, models: readonly DesktopModelOption[]): string {
  const model = snapshot?.runtime?.agent.model
  const selected = models.find((item) => item.id === model?.id && item.provider === model?.provider && item.api === model?.api)
  return selected ? modelKey(selected) : ''
}

function modelKey(model: Pick<DesktopModelOption, 'id' | 'provider' | 'api'>): string {
  return `${model.provider}/${model.id}::${model.api}`
}

function formatDate(timestamp?: number): string {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date)
}

function summaryText(value: unknown): string {
  const safe = redactDisplayValue(value)
  if (typeof safe === 'string') return safe
  try { return JSON.stringify(safe, null, 2) } catch { return '' }
}

function renderMessageBlocks(message: AgentMessage): React.ReactNode[] {
  const value = object(message)
  const content = value?.content
  if (typeof content === 'string') return [<p className="message-copy" key="text">{redactDisplayText(content)}</p>]
  if (!Array.isArray(content)) return []
  return content.flatMap((part, index) => {
    const item = object(part)
    if (!item) return []
    if (item.type === 'text' && typeof item.text === 'string') {
      return [<p className="message-copy" key={`text-${index}`}>{redactDisplayText(item.text)}</p>]
    }
    if (item.type === 'image') return [<span className="message-attachment" key={`image-${index}`}>▧ Attached image</span>]
    if (item.type === 'toolCall') {
      const toolName = typeof item.name === 'string' ? item.name : 'Tool'
      return [
        <details className="activity-card" key={`call-${String(item.id ?? index)}`}>
          <summary><span className="activity-dot" />{toolName}<span className="activity-state">Tool call</span></summary>
          <pre>{summaryText(item.arguments ?? item.input ?? {})}</pre>
        </details>,
      ]
    }
    return []
  })
}

function toolResultDetails(message: AgentMessage): { readonly name: string; readonly output: string; readonly error: boolean; readonly id: string } | null {
  const value = object(message)
  if (value?.role !== 'toolResult') return null
  const content = value.content
  const output = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.flatMap((part) => {
        const item = object(part)
        return item?.type === 'text' && typeof item.text === 'string' ? [item.text] : []
      }).join('\n')
      : ''
  return {
    name: typeof value.toolName === 'string' ? value.toolName : 'Tool',
    output: redactDisplayText(output),
    error: value.isError === true,
    id: typeof value.toolCallId === 'string' ? value.toolCallId : `${String(value.toolName ?? 'tool')}-${String(value.timestamp ?? messageText(message).slice(0, 24))}`,
  }
}

function isToolResult(message: AgentMessage): boolean {
  return object(message)?.role === 'toolResult'
}

function Timeline({
  messages,
  optimisticPrompt,
}: {
  messages: readonly AgentMessage[]
  optimisticPrompt: string | null
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const wasNearBottom = useRef(true)
  useEffect(() => {
    const element = scrollRef.current
    if (element && wasNearBottom.current) element.scrollTop = element.scrollHeight
  }, [messages, optimisticPrompt])

  const onScroll = () => {
    const element = scrollRef.current
    if (element) wasNearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 160
  }

  if (messages.length === 0 && !optimisticPrompt) {
    return (
      <div className="empty-conversation">
        <div className="empty-mark">M</div>
        <p className="eyebrow">MICROCODE WORKSPACE</p>
        <h2>What should we build today?</h2>
        <p>Ask Microcode to explore the code, make a change, or explain how something works.</p>
        <div className="prompt-suggestions">
          <span>Review this project</span><span>Find a bug</span><span>Explain the architecture</span>
        </div>
      </div>
    )
  }

  return (
    <div className="timeline" ref={scrollRef} onScroll={onScroll} aria-label="Conversation">
      <div className="timeline-inner">
        {messages.map((message, index) => {
          const data = object(message)
          const role = data?.role
          if (role === 'system' || role === 'toolResult') {
            if (role === 'toolResult') {
              const result = toolResultDetails(message)
              if (!result) return null
              return (
                <details className={`tool-result ${result.error ? 'is-error' : ''}`} key={`result-${result.id}`}>
                  <summary><span className="activity-dot" />{result.name}<span className="activity-state">{result.error ? 'Failed' : 'Completed'}</span><span className="chevron">⌄</span></summary>
                  {result.output && <pre>{result.output.slice(0, 12000)}{result.output.length > 12000 ? '\n… output shortened' : ''}</pre>}
                </details>
              )
            }
            return null
          }
          const user = role === 'user'
          const text = messageText(message)
          const blocks = renderMessageBlocks(message)
          return (
            <article className={`message ${user ? 'from-user' : 'from-assistant'}`} key={`message-${index}`}>
              <div className="message-avatar">{user ? 'Y' : 'M'}</div>
              <div className="message-main">
                <div className="message-meta"><strong>{user ? 'You' : 'Microcode'}</strong>{data?.timestamp && <time>{formatDate(Number(data.timestamp))}</time>}</div>
                {blocks.length ? blocks : text && <p className="message-copy">{redactDisplayText(text)}</p>}
              </div>
            </article>
          )
        })}
        {optimisticPrompt && (
          <article className="message from-user optimistic-message">
            <div className="message-avatar">Y</div>
            <div className="message-main"><div className="message-meta"><strong>You</strong><span>Sending…</span></div><p className="message-copy">{redactDisplayText(optimisticPrompt)}</p></div>
          </article>
        )}
      </div>
    </div>
  )
}

function ReviewPanel({
  review,
  selectedPath,
  diff,
  loading,
  onSelect,
}: {
  review: DesktopReviewSnapshot | null
  selectedPath: string | null
  diff: DesktopFileDiff | null
  loading: boolean
  onSelect(path: string): void
}) {
  const tree = useMemo(() => buildReviewChangeTree(review?.changes ?? []), [review?.changes])
  const [fileFilter, setFileFilter] = useState('')
  const visibleTree = useMemo(() => filterReviewChangeTree(tree, fileFilter), [tree, fileFilter])
  const [collapsedDirectories, setCollapsedDirectories] = useState<ReadonlySet<string>>(() => new Set())

  const renderChange = (node: ReviewTreeNode, depth: number): React.ReactNode => {
    if (node.kind === 'directory') {
      const expanded = !collapsedDirectories.has(node.path)
      return (
        <div className="change-tree-branch" key={`directory:${node.path}`}>
          <button
            aria-expanded={expanded}
            className="change-directory"
            onClick={() => setCollapsedDirectories((current) => {
              const next = new Set(current)
              if (expanded) next.add(node.path)
              else next.delete(node.path)
              return next
            })}
            role="treeitem"
            style={{ paddingLeft: `${8 + depth * 14}px` }}
            title={node.path}
            type="button"
          >
            <span className="directory-chevron">{expanded ? '⌄' : '›'}</span>
            <span className="directory-glyph">▰</span>
            <span className="directory-name">{node.name}</span>
          </button>
          {expanded && <div role="group">{node.children.map((child) => renderChange(child, depth + 1))}</div>}
        </div>
      )
    }

    const status = node.change.status.toUpperCase()
    const kind = node.change.untracked || status.includes('A') || status.includes('?')
      ? { label: 'A', className: 'added' }
      : status.includes('D')
        ? { label: 'D', className: 'deleted' }
        : status.includes('R') || status.includes('C')
          ? { label: 'R', className: 'renamed' }
          : node.change.staged && !node.change.unstaged
            ? { label: 'S', className: 'staged' }
            : { label: 'M', className: 'modified' }

    return (
      <button
        aria-selected={selectedPath === node.path}
        className={`change-file ${selectedPath === node.path ? 'selected' : ''}`}
        key={`file:${node.path}`}
        onClick={() => onSelect(node.path)}
        role="treeitem"
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        title={node.path}
        type="button"
      >
        <span className={`change-indicator ${kind.className}`}>{kind.label}</span>
        <span className="file-name">{node.name}</span>
        <span className="file-status">{node.change.status}</span>
      </button>
    )
  }

  return (
    <aside className="review-panel" aria-label="Change review">
      <div className="panel-heading">
        <div><p className="eyebrow">WORKTREE</p><h2>Review changes</h2></div>
        <span className="change-count">{review?.changes.length ?? 0}</span>
      </div>
      {review?.available ? (
        <>
          <div className="branch-row"><span className="branch-glyph">⌥</span><span>{review.branch || 'Working tree'}</span><span className="branch-count">{review.ahead ? `↑${review.ahead}` : ''}{review.behind ? ` ↓${review.behind}` : ''}</span></div>
          <div className="review-body">
            <div className="diff-view">
              {!selectedPath && <div className="diff-placeholder">Select a file to inspect its diff.</div>}
              {selectedPath && <div className="diff-heading"><span className="file-glyph">⌗</span><span title={selectedPath}>{selectedPath}</span></div>}
              {loading && <div className="diff-placeholder">Loading diff…</div>}
              {diff && !loading && <pre className="diff-text">{diff.text.split('\n').map((line, index) => (
                <span className={line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-remove' : line.startsWith('@@') ? 'diff-hunk' : ''} key={`${index}-${line.slice(0, 24)}`}>{redactDisplayText(line)}{'\n'}</span>
              ))}</pre>}
            </div>
            <aside className="change-sidebar" aria-label="Changed files">
              <label className="change-filter"><span aria-hidden="true">⌕</span><input aria-label="Filter changed files" onChange={(event) => setFileFilter(event.target.value)} placeholder="Filter files" type="search" value={fileFilter} /></label>
              <div className="change-list" role="tree" aria-label="Changed files">
                {review.changes.length === 0 && <p className="quiet-empty">No changed files in this project.</p>}
                {review.changes.length > 0 && visibleTree.length === 0 && <p className="quiet-empty">No files match this filter.</p>}
                {visibleTree.map((node) => renderChange(node, 0))}
              </div>
            </aside>
          </div>
        </>
      ) : (
        <div className="panel-empty"><span className="panel-empty-icon">⌘</span><strong>Git review unavailable</strong><p>{review?.message || 'Open a project folder to inspect local changes.'}</p></div>
      )}
    </aside>
  )
}

function TerminalDrawer({ workspace, active, onError }: { workspace: string; active: boolean; onError(message: string): void }) {
  const bridge = window.microcodeDesktop
  const hostRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const terminalIdRef = useRef('')
  const lastResizeRef = useRef<{ readonly terminalId: string; readonly cols: number; readonly rows: number } | null>(null)
  const startingRef = useRef(false)
  const activeRef = useRef(active)
  const pendingEventsRef = useRef<DesktopEvent[]>([])
  const unsubscribeRef = useRef<(() => void) | null>(null)
  const [terminalStatus, setTerminalStatus] = useState('Open Bash to start a shell.')

  activeRef.current = active

  const handleEventRef = useRef<(event: DesktopEvent) => void>(() => undefined)
  handleEventRef.current = (event) => {
    if (event.type !== 'terminal.data' && event.type !== 'terminal.exit') return
    const terminalId = terminalIdRef.current
    if (!terminalId) { pendingEventsRef.current.push(event); return }
    if (event.terminalId !== terminalId) return
    const terminal = terminalRef.current
    if (!terminal) return
    if (event.type === 'terminal.data') {
      const bytes = Uint8Array.from(atob(event.data), (character) => character.charCodeAt(0))
      terminal.write(bytes)
      return
    }
    terminalIdRef.current = ''
    lastResizeRef.current = null
    setTerminalStatus(`Bash exited (${event.signal || event.exitCode}).`)
    terminal.writeln(`\r\n[Process exited: ${event.signal || `code ${event.exitCode}`}]`)
  }

  const syncSizeRef = useRef<() => void>(() => undefined)
  syncSizeRef.current = () => {
    const host = hostRef.current
    const terminal = terminalRef.current
    const fit = fitRef.current
    if (!activeRef.current || !host || host.clientWidth === 0 || host.clientHeight === 0 || !terminal || !fit) return
    try {
      fit.fit()
      const dimensions = normalizeTerminalDimensions(terminal.cols, terminal.rows)
      if (terminal.cols !== dimensions.cols || terminal.rows !== dimensions.rows) terminal.resize(dimensions.cols, dimensions.rows)
      const terminalId = terminalIdRef.current
      const previous = lastResizeRef.current
      if (terminalId && (previous?.terminalId !== terminalId || previous.cols !== dimensions.cols || previous.rows !== dimensions.rows)) {
        lastResizeRef.current = { terminalId, ...dimensions }
        void bridge.resizeTerminal(terminalId, dimensions.cols, dimensions.rows).catch((error) => {
          lastResizeRef.current = null
          onError(String(error))
        })
      }
    } catch { /* The panel can briefly have no measurable size while its container is changing. */ }
  }

  const startTerminalRef = useRef<() => Promise<void>>(async () => undefined)
  startTerminalRef.current = async () => {
    const terminal = terminalRef.current
    if (!activeRef.current || !terminal || terminalIdRef.current || startingRef.current) return
    startingRef.current = true
    setTerminalStatus('Starting Bash…')
    pendingEventsRef.current = []
    unsubscribeRef.current?.()
    unsubscribeRef.current = bridge.onEvent((event) => handleEventRef.current(event))
    try {
      syncSizeRef.current()
      const proposed = fitRef.current?.proposeDimensions()
      const dimensions = normalizeTerminalDimensions(proposed?.cols ?? terminal.cols, proposed?.rows ?? terminal.rows)
      if (terminal.cols !== dimensions.cols || terminal.rows !== dimensions.rows) terminal.resize(dimensions.cols, dimensions.rows)
      const terminalId = await bridge.createTerminal(dimensions.cols, dimensions.rows)
      if (!hostRef.current) {
        await bridge.closeTerminal(terminalId)
        return
      }
      terminalIdRef.current = terminalId
      lastResizeRef.current = { terminalId, ...dimensions }
      setTerminalStatus('Bash · interactive PTY')
      for (const event of pendingEventsRef.current.splice(0)) handleEventRef.current(event)
      syncSizeRef.current()
      terminal.focus()
    } catch (error) {
      pendingEventsRef.current = []
      unsubscribeRef.current?.()
      unsubscribeRef.current = null
      setTerminalStatus('Bash could not start.')
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      startingRef.current = false
    }
  }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const terminal = new Terminal({
      allowProposedApi: false,
      cursorBlink: true,
      drawBoldTextInBrightColors: true,
      fontFamily: 'Cascadia Code, Consolas, "DM Mono", monospace',
      fontSize: 12,
      scrollback: 5000,
      theme: DESKTOP_TERMINAL_THEME,
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host)
    terminalRef.current = terminal
    fitRef.current = fit
    const inputSubscription = terminal.onData((data) => {
      const terminalId = terminalIdRef.current
      if (!terminalId) return
      void (async () => {
        for (let offset = 0; offset < data.length; offset += 16 * 1024) {
          await bridge.writeTerminal(terminalId, data.slice(offset, offset + 16 * 1024))
        }
      })().catch((error) => onError(error instanceof Error ? error.message : String(error)))
    })
    const observer = new ResizeObserver(() => syncSizeRef.current())
    observer.observe(host)
    return () => {
      observer.disconnect()
      inputSubscription.dispose()
      unsubscribeRef.current?.()
      unsubscribeRef.current = null
      const terminalId = terminalIdRef.current
      terminalIdRef.current = ''
      lastResizeRef.current = null
      if (terminalId) void bridge.closeTerminal(terminalId).catch(() => undefined)
      terminal.dispose()
      terminalRef.current = null
      fitRef.current = null
    }
  }, [workspace])

  useEffect(() => {
    if (!active) return
    requestAnimationFrame(() => syncSizeRef.current())
    void startTerminalRef.current()
  }, [active, workspace])

  return (
    <section className={`terminal-drawer ${active ? '' : 'is-hidden'}`} aria-label="Bash terminal" aria-hidden={!active}>
      <div className="terminal-topbar"><div className="terminal-title"><span className="terminal-led" />Bash <span className="terminal-workspace" title={workspace}>{workspace}</span></div><span className="terminal-status">{terminalStatus}</span></div>
      <div className="terminal-content"><div className="terminal-host" ref={hostRef} /></div>
    </section>
  )
}

function ApprovalPanel({
  snapshot,
  deciding,
  onRespond,
}: {
  snapshot: DesktopBackendSnapshot
  deciding: ReadonlySet<string>
  onRespond: ApprovalResponder
}) {
  return (
    <div className="approval-stack" aria-label="Pending approvals">
      {snapshot.pendingPermissions.map((request, index) => {
        const input = request.input
        const questionsValue = input.questions
        const questions = Array.isArray(questionsValue) ? questionsValue.flatMap((entry, questionIndex) => {
          const item = object(entry)
          return item && typeof item.question === 'string' ? [{ key: String(item.id ?? questionIndex), label: item.question }] : []
        }) : []
        const waiting = deciding.has(request.requestId)
        return (
          <ApprovalCard
            key={request.requestId}
            requestId={request.requestId}
            kind={request.kind}
            title={request.kind === 'question' ? 'Microcode has a question' : `${request.toolName} needs approval`}
            detail={request.description || summaryText(input)}
            extra={summaryText(input)}
            index={index + 1}
            total={snapshot.pendingPermissions.length}
            questions={questions}
            waiting={waiting}
            onRespond={onRespond}
          />
        )
      })}
    </div>
  )
}

function ApprovalCard({
  requestId,
  kind,
  title,
  detail,
  extra,
  index,
  total,
  questions,
  waiting,
  onRespond,
}: {
  requestId: string
  kind: 'tool' | 'question'
  title: string
  detail: string
  extra: string
  index: number
  total: number
  questions: readonly { readonly key: string; readonly label: string }[]
  waiting: boolean
  onRespond: ApprovalResponder
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const isQuestion = kind === 'question'
  return (
    <section className="approval-card" aria-label={title}>
      <div className="approval-heading"><span className="approval-icon">{isQuestion ? '?' : '!'}</span><div><strong>{title}</strong><p>{redactDisplayText(detail)}</p></div>{total > 1 && <span className="approval-count">{index}/{total}</span>}</div>
      <details className="approval-details"><summary>Request details</summary><pre>{extra}</pre></details>
      {questions.map((question) => <label className="answer-field" key={question.key}>{redactDisplayText(question.label)}<input value={answers[question.key] ?? ''} onChange={(event) => setAnswers((current) => ({ ...current, [question.key]: event.target.value }))} /></label>)}
      <div className="approval-actions">
        {isQuestion ? (
          <><button className="button-quiet" disabled={waiting} onClick={() => onRespond(requestId, 'deny', undefined, true)} type="button">Block</button><button className="button-primary approval-submit" disabled={waiting} onClick={() => onRespond(requestId, 'allow', answers)} type="button">{waiting ? 'Waiting for runtime…' : 'Submit answer'}</button></>
        ) : (
          <><button className="button-quiet" disabled={waiting} onClick={() => onRespond(requestId, 'deny')} type="button">Deny</button><button className="button-quiet" disabled={waiting} onClick={() => onRespond(requestId, 'allow_session')} type="button">Allow for session</button><button className="button-primary approval-submit" disabled={waiting} onClick={() => onRespond(requestId, 'allow')} type="button">{waiting ? 'Waiting…' : 'Allow once'}</button></>
        )}
      </div>
    </section>
  )
}

export function App() {
  const bridge = window.microcodeDesktop
  const [backendStatus, setBackendStatus] = useState<DesktopBackendStatus>({ type: 'backend.status', status: 'starting' })
  const [logsPath, setLogsPath] = useState('')
  const [recentProjects, setRecentProjects] = useState<readonly DesktopProjectRef[]>([])
  const [snapshot, setSnapshot] = useState<DesktopBackendSnapshot | null>(null)
  const [sessions, setSessions] = useState<readonly SessionRow[]>([])
  const [models, setModels] = useState<readonly DesktopModelOption[]>([])
  const [review, setReview] = useState<DesktopReviewSnapshot | null>(null)
  const [diff, setDiff] = useState<DesktopFileDiff | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<readonly DesktopImageAttachment[]>([])
  const [optimisticPrompt, setOptimisticPrompt] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [canceling, setCanceling] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [expandedProjects, setExpandedProjects] = useState<ReadonlySet<string>>(() => new Set())
  const [modelsLoading, setModelsLoading] = useState(false)
  const [workspaceError, setWorkspaceError] = useState('')
  const [deciding, setDeciding] = useState<ReadonlySet<string>>(() => new Set())
  const [tools, setTools] = useState<Readonly<Record<string, ToolRun>>>({})
  const [errorNotice, setErrorNotice] = useState('')
  const selectedPathRef = useRef(selectedPath)
  selectedPathRef.current = selectedPath
  const reviewRequestIdRef = useRef(0)
  const diffRequestIdRef = useRef(0)

  const workspaceName = snapshot?.workspace?.split(/[\\/]/).filter(Boolean).at(-1) || 'Open a project'
  const runtime = snapshot?.runtime
  const messages = runtime?.messages ?? []
  const currentMode = runtime?.agent.permission.mode ?? 'interactive'
  const modelValue = useMemo(() => currentModelValue(snapshot, models), [snapshot, models])

  const loadSessions = async () => {
    if (!snapshot?.workspace) { setSessions([]); return }
    try { setSessions(readSessionRows(await bridge.listSessions())) } catch (error) { setErrorNotice(String(error)) }
  }

  const loadModels = async () => {
    setModelsLoading(true)
    try { setModels(await bridge.listModels()) } catch (error) { setErrorNotice(String(error)) } finally { setModelsLoading(false) }
  }

  const loadReview = async (keepSelection = true) => {
    const requestId = ++reviewRequestIdRef.current
    if (!snapshot?.workspace) {
      diffRequestIdRef.current++
      selectedPathRef.current = null
      setReview(null)
      setDiff(null)
      setSelectedPath(null)
      setDiffLoading(false)
      return
    }
    try {
      const next = await bridge.reviewStatus()
      if (requestId !== reviewRequestIdRef.current) return
      setReview(next)
      const currentSelection = selectedPathRef.current
      const selected = keepSelection && currentSelection && next.changes.some((change) => change.path === currentSelection)
        ? currentSelection
        : next.changes[0]?.path ?? null
      selectedPathRef.current = selected
      setSelectedPath(selected)
      if (selected) await loadDiff(selected)
      else {
        diffRequestIdRef.current++
        setDiff(null)
        setDiffLoading(false)
      }
    } catch (error) {
      if (requestId === reviewRequestIdRef.current) setErrorNotice(String(error))
    }
  }

  const loadDiff = async (path: string) => {
    const requestId = ++diffRequestIdRef.current
    setDiffLoading(true)
    setDiff(null)
    try {
      const next = await bridge.readDiff(path)
      if (requestId === diffRequestIdRef.current) setDiff(next)
    } catch (error) {
      if (requestId === diffRequestIdRef.current) {
        setDiff(null)
        setErrorNotice(String(error))
      }
    } finally {
      if (requestId === diffRequestIdRef.current) setDiffLoading(false)
    }
  }

  const loadWorkspacePanels = () => {
    void loadSessions()
    void loadModels()
    void loadReview(false)
  }

  const refreshers = useRef({ loadSessions, loadReview, loadWorkspacePanels })
  refreshers.current = { loadSessions, loadReview, loadWorkspacePanels }

  useEffect(() => {
    const unsubscribe = bridge.onEvent((event) => {
      if (event.type === 'backend.status') setBackendStatus(event)
      if (event.type === 'workspace.changed') {
        reviewRequestIdRef.current++
        diffRequestIdRef.current++
        selectedPathRef.current = null
        setReview(null)
        setDiff(null)
        setSelectedPath(null)
        setDiffLoading(false)
        setSnapshot(event.snapshot)
        setWorkspaceError('')
        setOptimisticPrompt(null)
        setTools({})
      }
      if (event.type !== 'runtime.event') return
      const runtimeEvent = event.event
      if (runtimeEvent.type === 'prompt.started') { setRunning(true); setCanceling(false) }
      if (runtimeEvent.type === 'prompt.completed') { setRunning(false); setCanceling(false); setOptimisticPrompt(null) }
      if (runtimeEvent.type === 'permission.resolved') {
        setDeciding((current) => {
          if (!current.has(runtimeEvent.requestId)) return current
          const next = new Set(current)
          next.delete(runtimeEvent.requestId)
          return next
        })
      }
      if (runtimeEvent.type === 'agent.event') {
        const agentEvent = object(runtimeEvent.event)
        const id = typeof agentEvent?.toolCallId === 'string' ? agentEvent.toolCallId : `${runtimeEvent.sequence}`
        if (agentEvent?.type === 'tool_started' && typeof agentEvent.toolName === 'string') {
          setTools((current) => ({ ...current, [id]: { name: agentEvent.toolName as string, status: 'running' } }))
          if (String(agentEvent.toolName).toLowerCase().includes('write') || String(agentEvent.toolName).toLowerCase().includes('edit') || String(agentEvent.toolName).toLowerCase().includes('bash')) void refreshers.current.loadReview()
        }
        if (agentEvent?.type === 'tool_finished' && typeof agentEvent.toolName === 'string') {
          setTools((current) => ({ ...current, [id]: { name: agentEvent.toolName as string, status: agentEvent.isError === true ? 'error' : 'done' } }))
          void refreshers.current.loadReview()
        }
        if (agentEvent?.type === 'message_start' && object(agentEvent.message)?.role === 'user') setOptimisticPrompt(null)
      }
      setSnapshot((current) => {
        if (!current) return current
        const applied = applyRuntimeEvent(current, runtimeEvent)
        if (applied.sequenceGap) void bridge.getSnapshot().then(setSnapshot).catch(() => undefined)
        if (runtimeEvent.type === 'session.changed') queueMicrotask(() => { void refreshers.current.loadSessions() })
        return applied.snapshot
      })
    })

    void bridge.bootstrap().then(async (result) => {
      setBackendStatus(result.backendStatus)
      setRecentProjects(result.recentProjects)
      setLogsPath(result.logsPath)
      setSnapshot(result.snapshot)
      if (result.snapshot?.workspace) {
        setTimeout(() => refreshers.current.loadWorkspacePanels(), 0)
      }
    }).catch((error: unknown) => setErrorNotice(error instanceof Error ? error.message : String(error)))

    return unsubscribe
  }, [])

  useEffect(() => {
    if (snapshot?.workspace) loadWorkspacePanels()
  }, [snapshot?.workspace])

  useEffect(() => {
    if (!snapshot?.workspace) return
    setExpandedProjects((current) => new Set(current).add(snapshot.workspace!))
  }, [snapshot?.workspace])

  const chooseWorkspace = async () => {
    setWorkspaceError('')
    try {
      const result = await bridge.chooseWorkspace()
      if (result) {
        setSnapshot(result)
        const refreshed = await bridge.bootstrap()
        setRecentProjects(refreshed.recentProjects)
      }
    } catch (error) { setWorkspaceError(error instanceof Error ? error.message : String(error)) }
  }

  const openRecentProject = async (project: DesktopProjectRef) => {
    setWorkspaceError('')
    try { setSnapshot(await bridge.openRecentProject(project.id)) } catch (error) { setWorkspaceError(error instanceof Error ? error.message : String(error)) }
  }

  const createSession = async () => {
    try {
      const next = await bridge.startNewSession()
      setSnapshot(next)
      setOptimisticPrompt(null)
      setTools({})
      await loadSessions()
    } catch (error) { setErrorNotice(error instanceof Error ? error.message : String(error)) }
  }

  const selectSession = async (sessionId: string) => {
    try {
      const next = await bridge.selectSession(sessionId)
      setSnapshot(next)
      setTools({})
      setOptimisticPrompt(null)
    } catch (error) { setErrorNotice(error instanceof Error ? error.message : String(error)) }
  }

  const sendPrompt = async () => {
    const prompt = draft.trim()
    if (!prompt || running || !snapshot?.workspace) return
    setDraft('')
    setOptimisticPrompt(prompt)
    setRunning(true)
    const selectedImages = attachments.map((attachment) => attachment.image)
    setAttachments([])
    try {
      await bridge.sendPrompt(prompt, selectedImages.length ? selectedImages : undefined)
      const current = await bridge.getSnapshot()
      setSnapshot(current)
      setOptimisticPrompt(null)
    } catch (error) {
      setDraft((current) => current || prompt)
      setAttachments((current) => current.length ? current : attachments)
      setOptimisticPrompt(null)
      setRunning(false)
      setSnapshot(await bridge.getSnapshot().catch(() => snapshot))
      setErrorNotice(error instanceof Error ? error.message : String(error))
    }
  }

  const cancelPrompt = async () => {
    if (!running || canceling) return
    setCanceling(true)
    try { await bridge.cancelPrompt() } catch (error) { setCanceling(false); setErrorNotice(error instanceof Error ? error.message : String(error)) }
  }

  const respondToPermission = async (
    requestId: string,
    decision: 'allow' | 'allow_session' | 'deny',
    answers?: Readonly<Record<string, string>>,
    block?: boolean,
  ) => {
    if (deciding.has(requestId)) return
    setDeciding((current) => new Set(current).add(requestId))
    try {
      const result = await bridge.respondToPermission(requestId, decision, answers, block)
      if (!result.accepted) {
        const latest = await bridge.getSnapshot()
        setSnapshot(latest)
        setDeciding((current) => { const next = new Set(current); next.delete(requestId); return next })
      }
    } catch (error) {
      setDeciding((current) => { const next = new Set(current); next.delete(requestId); return next })
      setErrorNotice(error instanceof Error ? error.message : String(error))
    }
  }

  const chooseImages = async () => {
    try {
      const next = await bridge.chooseImages()
      setAttachments((current) => [...current, ...next].slice(0, 4))
    } catch (error) { setErrorNotice(error instanceof Error ? error.message : String(error)) }
  }

  const attachPastedImages = async (files: readonly File[]) => {
    const available = Math.max(0, MAX_DESKTOP_IMAGE_ATTACHMENTS - attachments.length)
    if (files.length > available) setErrorNotice('You can attach up to four images. Remove an image before pasting more.')
    const selected = files.slice(0, available)
    if (!selected.length) return
    try {
      const next = await Promise.all(selected.map((file, index) => encodePastedImage(file, index + 1)))
      setAttachments((current) => [...current, ...next].slice(0, MAX_DESKTOP_IMAGE_ATTACHMENTS))
    } catch (error) {
      setErrorNotice(error instanceof Error ? error.message : String(error))
    }
  }

  const changeModel = async (key: string) => {
    const selected = models.find((item) => modelKey(item) === key)
    if (!selected) return
    try {
      setSnapshot(await bridge.switchModel(selected))
    } catch (error) { setErrorNotice(error instanceof Error ? error.message : String(error)) }
  }

  const changePermissionMode = async (mode: PermissionMode) => {
    try {
      await bridge.setPermissionMode(mode)
      setSnapshot(await bridge.getSnapshot())
    } catch (error) { setErrorNotice(error instanceof Error ? error.message : String(error)) }
  }

  const toggleReview = () => {
    const next = !reviewOpen
    setReviewOpen(next)
    if (next) void loadReview()
  }

  const sessionsForUi = labelProjectSessions(sessionsWithActiveDraft(sessions, runtime?.session.draft === true))
  const projectsForUi = buildProjectTree(recentProjects, snapshot?.workspace ?? null, sessionsForUi, workspaceName)
  const title = runtime?.session.title || (runtime?.session.draft ? 'New conversation' : 'Conversation')
  const messageCount = messages.filter((message) => {
    const role = object(message)?.role
    return role === 'user' || role === 'assistant'
  }).length

  return (
    <div className="app-shell">
      <nav className="app-rail" aria-label="Primary navigation">
        <button className="brand-mark" title="Microcode home" type="button">M</button>
        <div className="rail-divider" />
        <button className="rail-button active" aria-label="Workspace" title="Workspace" type="button">⌂</button>
        <button className={`rail-button ${reviewOpen ? 'active' : ''}`} aria-label="Review changes" title="Review changes" onClick={toggleReview} type="button">⑂</button>
        <button className={`rail-button ${terminalOpen ? 'active' : ''}`} aria-label="Bash terminal" title="Bash terminal" onClick={() => setTerminalOpen((open) => !open)} type="button">▤</button>
        <div className="rail-spacer" />
        <button className={`rail-button settings-icon ${settingsOpen ? 'active' : ''}`} aria-label="Application settings" title="Settings" onClick={() => setSettingsOpen(true)} type="button">⚙</button>
        <div className="user-mark">MC</div>
      </nav>

      <aside className={`project-sidebar ${sidebarOpen ? '' : 'is-collapsed'}`} aria-label="Projects and sessions">
        <div className="sidebar-brand"><span className="sidebar-brand-mark">M</span><div><strong>Microcode</strong><small>Workspace</small></div><button className="icon-button sidebar-collapse" title="Collapse sidebar" aria-label="Collapse sidebar" onClick={() => setSidebarOpen(false)} type="button">‹</button></div>
        <div className="sidebar-section-title"><span>PROJECTS</span><button className="small-icon-button" aria-label="Open project folder" title="Open project folder" onClick={() => void chooseWorkspace()} type="button">＋</button></div>
        <div className="projects-list">
          {projectsForUi.map(({ project, active: isActiveProject, sessions: projectSessions }) => {
            const expanded = isActiveProject && expandedProjects.has(project.path)
            return (
              <div className="project-tree-node" key={project.path}>
                <button
                  className={`project-row ${isActiveProject ? 'current' : ''}`}
                  aria-expanded={isActiveProject ? expanded : undefined}
                  onClick={() => {
                    if (!isActiveProject) { void openRecentProject(project); return }
                    setExpandedProjects((current) => {
                      const next = new Set(current)
                      if (next.has(project.path)) next.delete(project.path)
                      else next.add(project.path)
                      return next
                    })
                  }}
                  type="button"
                >
                  <span className={`project-disclosure ${isActiveProject ? '' : 'muted'}`}>{isActiveProject ? (expanded ? '⌄' : '›') : '↗'}</span>
                  <span className={`project-folder ${isActiveProject ? '' : 'muted'}`}>▱</span>
                  <span className="project-label" title={project.path}>{project.name}</span>
                </button>
                {isActiveProject && expanded && (
                  <div className="project-session-children" role="group" aria-label={`${project.name} sessions`}>
                    <button className="new-session-row" disabled={running} onClick={() => void createSession()} type="button"><span>＋</span>New conversation</button>
                    {projectSessions.map((session) => (
                      <button className={`session-row ${session.draft || runtime?.session.id === session.id ? 'active' : ''}`} key={session.id} disabled={running} onClick={() => { if (!session.draft) void selectSession(session.id) }} type="button">
                        <span className={`session-glyph ${runtime?.session.id === session.id && running ? 'working' : ''}`}>{session.draft ? '•' : runtime?.session.id === session.id ? (running ? '◌' : '•') : '·'}</span>
                        <span className="session-title" title={session.title || session.id}>{session.displayTitle}</span>
                      </button>
                    ))}
                    {projectSessions.length === 0 && <p className="sidebar-hint nested-hint">No conversations in this project yet.</p>}
                  </div>
                )}
              </div>
            )
          })}
          {!snapshot?.workspace && recentProjects.length === 0 && <p className="sidebar-hint">Open a local folder to start a workspace.</p>}
        </div>
        <div className="sidebar-footer">
          <div className="connection-state"><span className={`connection-dot ${backendStatus.status}`} />{backendStatus.status === 'ready' ? 'Runtime connected' : backendStatus.status === 'starting' ? 'Starting runtime…' : backendStatus.status === 'failed' ? 'Runtime unavailable' : 'Runtime closed'}</div>
          {runtime && <div className="project-path" title={snapshot?.workspace ?? ''}>{snapshot?.workspace ?? ''}</div>}
        </div>
      </aside>
      {!sidebarOpen && <button className="restore-sidebar" onClick={() => setSidebarOpen(true)} type="button" aria-label="Expand sidebar">›</button>}

      <main className="workspace-shell">
        <header className="workspace-header">
          <div className="breadcrumb"><span className="breadcrumb-project">{workspaceName}</span><span className="breadcrumb-separator">/</span><span className="breadcrumb-title">{title}</span>{runtime && <span className={`turn-status ${running ? 'working' : ''}`}><span />{running ? 'Working' : 'Ready'}</span>}</div>
          <div className="workspace-actions">
            <button className={`header-action ${reviewOpen ? 'selected' : ''}`} onClick={toggleReview} type="button"><span>⑂</span>Review{review?.changes.length ? <b>{review.changes.length}</b> : null}</button>
            <button className={`header-action ${terminalOpen ? 'selected' : ''}`} onClick={() => setTerminalOpen((open) => !open)} type="button"><span>▤</span>Bash</button>
            <button className="header-action open-project" onClick={() => void chooseWorkspace()} type="button"><span>▱</span>Open folder</button>
          </div>
        </header>

        {backendStatus.status === 'failed' && (
          <div className="backend-banner"><div><strong>Runtime did not start</strong><p>{backendStatus.message || 'Microcode could not connect to the local runtime.'} {logsPath && <span>Logs: {logsPath}</span>}</p></div><button className="button-primary" onClick={() => void bridge.retryBackend().catch((error) => setErrorNotice(String(error)))} type="button">Retry backend</button></div>
        )}
        {workspaceError && <div className="notice-banner" role="alert">{workspaceError}<button onClick={() => setWorkspaceError('')} type="button" aria-label="Dismiss">×</button></div>}
        {errorNotice && <div className="notice-banner" role="alert"><span>{redactDisplayText(errorNotice)}</span>{/settings/i.test(errorNotice) && <button className="notice-action" onClick={() => setSettingsOpen(true)} type="button">Open settings</button>}<button onClick={() => setErrorNotice('')} type="button" aria-label="Dismiss">×</button></div>}

        {!snapshot?.workspace ? (
          <div className="workspace-welcome">
            <div className="welcome-card">
              <div className="welcome-mark">M</div><p className="eyebrow">A CODING WORKSPACE THAT THINKS WITH YOU</p><h1>Bring your project in.</h1><p>Microcode will work in the folder you choose. Your code and provider credentials stay with the local runtime.</p>
              <button className="button-primary welcome-open" onClick={() => void chooseWorkspace()} type="button"><span>▱</span>Open project folder</button>
              {recentProjects.length > 0 && <div className="recent-projects"><span>PROJECTS</span>{recentProjects.map((project) => <button key={project.id} onClick={() => void openRecentProject(project)} type="button"><span className="project-dot" /><span>{project.name}</span><small title={project.path}>{project.path}</small><b>↗</b></button>)}</div>}
            </div>
          </div>
        ) : (
          <>
            <div className={`workspace-row ${reviewOpen ? 'review-visible' : ''}`}>
              <section className="conversation-column">
                {snapshot.startupWarnings.length > 0 && <div className="startup-warnings">{snapshot.startupWarnings.map((warning, index) => <p key={`${index}-${warning}`}>ⓘ {redactDisplayText(warning)}</p>)}</div>}
                <Timeline messages={messages} optimisticPrompt={optimisticPrompt} />
                <footer className="composer-dock">
                  {snapshot.pendingPermissions.length > 0 && <ApprovalPanel snapshot={snapshot} deciding={deciding} onRespond={respondToPermission} />}
                  <div className="composer-box">
                    {attachments.length > 0 && <div className="attachment-list">{attachments.map((attachment, index) => <div className="attachment-chip" key={`${attachment.name}-${index}`}><img src={`data:${attachment.image.mimeType};base64,${attachment.image.data}`} alt="" /><span>{attachment.name}</span><button aria-label={`Remove ${attachment.name}`} onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))} type="button">×</button></div>)}</div>}
                    <textarea
                      aria-label="Message Microcode"
                      placeholder={snapshot.pendingPermissions.length ? 'Resolve the request above to continue…' : 'Ask Microcode anything about this project, or paste an image…'}
                      value={draft}
                      maxLength={120_000}
                      onChange={(event) => setDraft(event.target.value)}
                      onPaste={(event) => {
                        const files = getPastedImageFiles(event.clipboardData)
                        if (!files.length) return
                        if (!event.clipboardData.getData('text/plain')) event.preventDefault()
                        void attachPastedImages(files)
                      }}
                      onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void sendPrompt() } }}
                      disabled={!runtime || snapshot.pendingPermissions.length > 0}
                    />
                    <div className="composer-controls">
                      <div className="composer-left-controls">
                        <button className="composer-icon-button" aria-label="Attach images" title="Attach images" disabled={attachments.length >= 4} onClick={() => void chooseImages()} type="button">＋</button>
                        <label className="select-control model-select"><span className="control-dot">◉</span><select aria-label="Model" value={modelValue} disabled={modelsLoading || models.length === 0} onChange={(event) => void changeModel(event.target.value)}><option value="">{modelsLoading ? 'Loading models…' : runtime?.agent.model.name || 'Model'}</option>{models.map((model) => <option key={modelKey(model)} value={modelKey(model)}>{model.name} · {model.provider}{model.authentication === 'missing' ? ' · set up in Settings' : model.authentication === 'error' ? ' · auth check failed' : ''}</option>)}</select><span className="select-chevron">⌄</span></label>
                        <label className="select-control permission-select"><span className="mode-indicator">{currentMode === 'interactive' ? '◈' : currentMode === 'plan' ? '◇' : '✓'}</span><select aria-label="Permission mode" value={currentMode} onChange={(event) => void changePermissionMode(event.target.value as PermissionMode)}><option value="interactive">Ask each time</option><option value="plan">Plan mode</option><option value="auto-approve">Auto approve</option></select><span className="select-chevron">⌄</span></label>
                      </div>
                      <div className="composer-right-controls"><span className="composer-hint">Ctrl+V to paste images · Enter to send · Shift+Enter for newline</span>{running ? <button className="stop-button" disabled={canceling} onClick={() => void cancelPrompt()} type="button"><span>■</span>{canceling ? 'Stopping…' : 'Stop'}</button> : <button className="send-button" disabled={!draft.trim()} onClick={() => void sendPrompt()} type="button"><span>↑</span></button>}</div>
                    </div>
                  </div>
                  <p className="composer-disclaimer">Microcode can make mistakes. Review changes before applying them.</p>
                </footer>
              </section>
              {reviewOpen && <ReviewPanel review={review} selectedPath={selectedPath} diff={diff} loading={diffLoading} onSelect={(path) => { selectedPathRef.current = path; setSelectedPath(path); void loadDiff(path) }} />}
            </div>
            <TerminalDrawer key={snapshot.workspace} workspace={snapshot.workspace} active={terminalOpen} onError={setErrorNotice} />
          </>
        )}
        <footer className="status-bar"><div><span className={`status-dot ${running ? 'working' : ''}`} />{running ? 'Agent turn in progress' : 'Workspace ready'}{runtime && <span className="status-separator">·</span>}{runtime && `${messageCount} messages`}</div><div>{runtime?.agent.model.name || 'No model selected'}<span className="status-separator">·</span>{currentMode}</div></footer>
      </main>
      {settingsOpen && <SettingsPanel
        bridge={bridge}
        snapshot={snapshot}
        busy={running}
        onClose={() => setSettingsOpen(false)}
        onError={setErrorNotice}
        onSnapshotChange={setSnapshot}
      />}
    </div>
  )
}

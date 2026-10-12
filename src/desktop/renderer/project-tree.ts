import type { DesktopProjectRef } from '../protocol.ts'

export interface DesktopSessionRow {
  readonly id: string
  readonly title?: string
  readonly draft?: boolean
  readonly displayTitle?: string
}

export interface DesktopProjectTreeNode {
  readonly project: DesktopProjectRef
  readonly active: boolean
  readonly sessions: readonly DesktopSessionRow[]
}

export function sessionsWithActiveDraft(sessions: readonly DesktopSessionRow[], hasActiveDraft: boolean): readonly DesktopSessionRow[] {
  if (!hasActiveDraft) return sessions
  return Object.freeze([...sessions, Object.freeze({ id: 'active-draft', title: 'New conversation', draft: true })])
}

export function labelProjectSessions(sessions: readonly DesktopSessionRow[]): readonly DesktopSessionRow[] {
  const titleOf = (session: DesktopSessionRow) => session.draft ? 'New conversation' : session.title?.trim() || `Untitled · ${session.id.slice(0, 8)}`
  const counts = new Map<string, number>()
  for (const session of sessions) {
    const title = titleOf(session)
    counts.set(title, (counts.get(title) ?? 0) + 1)
  }
  return Object.freeze(sessions.map((session) => {
    const title = titleOf(session)
    const displayTitle = (counts.get(title) ?? 0) > 1 && !session.draft
      ? `${title} · ${session.id.slice(0, 6)}`
      : title
    return Object.freeze({ ...session, displayTitle })
  }))
}

/** Keep every visible conversation attached to the project whose runtime listed it. */
export function buildProjectTree(
  projects: readonly DesktopProjectRef[],
  workspace: string | null,
  sessions: readonly DesktopSessionRow[],
  workspaceName: string,
): readonly DesktopProjectTreeNode[] {
  const current = workspace
    ? projects.find((project) => project.path === workspace) ?? { id: 'active-workspace', path: workspace, name: workspaceName }
    : null
  const rows = [
    ...(current ? [current] : []),
    ...projects.filter((project) => project.path !== workspace),
  ]
  return Object.freeze(rows.map((project) => {
    const active = project.path === workspace
    return Object.freeze({ project, active, sessions: Object.freeze(active ? [...sessions] : []) })
  }))
}

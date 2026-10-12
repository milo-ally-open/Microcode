import { describe, expect, test } from 'bun:test'
import { buildProjectTree, labelProjectSessions, sessionsWithActiveDraft } from '../../src/desktop/renderer/project-tree.ts'

describe('desktop project conversation tree', () => {
  test('renders sessions only as children of the active project', () => {
    const projects = [
      { id: 'project-a', path: '/work/a', name: 'a' },
      { id: 'project-b', path: '/work/b', name: 'b' },
    ]
    const sessions = [
      { id: 'session-1', title: '01' },
      { id: 'session-2', title: '02' },
    ]

    expect(buildProjectTree(projects, '/work/b', sessions, 'b')).toEqual([
      { project: projects[1], active: true, sessions },
      { project: projects[0], active: false, sessions: [] },
    ])
  })

  test('keeps sessions under a synthesized project row when that project is newly opened', () => {
    expect(buildProjectTree([], '/work/new', [{ id: 'session-1' }], 'new')).toEqual([
      { project: { id: 'active-workspace', path: '/work/new', name: 'new' }, active: true, sessions: [{ id: 'session-1' }] },
    ])
  })

  test('shows a new in-memory draft as a child until it is persisted', () => {
    expect(sessionsWithActiveDraft([], true)).toEqual([
      { id: 'active-draft', title: 'New conversation', draft: true },
    ])
    const persisted = [{ id: 'session-1', title: 'Existing conversation' }]
    expect(sessionsWithActiveDraft(persisted, false)).toBe(persisted)
  })

  test('distinguishes untitled and duplicate-title conversations without recency labels', () => {
    expect(labelProjectSessions([
      { id: 'abcdef123456', title: 'New conversation' },
      { id: 'active-draft', draft: true },
      { id: 'fedcba654321' },
    ])).toEqual([
      { id: 'abcdef123456', title: 'New conversation', displayTitle: 'New conversation · abcdef' },
      { id: 'active-draft', draft: true, displayTitle: 'New conversation' },
      { id: 'fedcba654321', displayTitle: 'Untitled · fedcba65' },
    ])
  })
})

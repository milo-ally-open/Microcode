import { describe, expect, test } from 'bun:test'
import { closeConversationTab, upsertConversationTab } from '../../src/desktop/renderer/conversation-tabs.ts'

describe('desktop conversation tabs', () => {
  test('opens a conversation only once and updates its title', () => {
    const first = upsertConversationTab([], { id: 'session-1', title: 'Untitled' })
    const updated = upsertConversationTab(first, { id: 'session-1', title: 'Fix renderer' })

    expect(updated).toEqual([{ id: 'session-1', title: 'Fix renderer' }])
  })

  test('replaces the temporary draft tab after the first message creates a session', () => {
    const draft = upsertConversationTab([], { id: 'active-draft', title: 'New conversation' })
    const saved = upsertConversationTab(draft, { id: 'session-1', title: 'First prompt' })

    expect(saved).toEqual([{ id: 'session-1', title: 'First prompt' }])
  })

  test('selects the adjacent tab when closing the active conversation', () => {
    const tabs = [
      { id: 'session-1', title: 'One' },
      { id: 'session-2', title: 'Two' },
      { id: 'session-3', title: 'Three' },
    ]

    expect(closeConversationTab(tabs, 'session-2', 'session-2')).toEqual({
      tabs: [tabs[0], tabs[2]],
      selectedId: 'session-3',
    })
  })

  test('keeps the current selection when closing an inactive conversation', () => {
    const tabs = [{ id: 'session-1', title: 'One' }, { id: 'session-2', title: 'Two' }]

    expect(closeConversationTab(tabs, 'session-1', 'session-2')).toEqual({
      tabs: [tabs[1]],
      selectedId: 'session-2',
    })
  })
})

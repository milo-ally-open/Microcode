export interface ConversationTab {
  readonly id: string
  readonly title: string
}

export interface ClosedConversationTabs {
  readonly tabs: readonly ConversationTab[]
  readonly selectedId: string | null
}

/** Keep tabs unique and replace the temporary draft tab when it becomes durable. */
export function upsertConversationTab(
  tabs: readonly ConversationTab[],
  tab: ConversationTab,
): readonly ConversationTab[] {
  const existingTabs = tab.id === 'active-draft'
    ? [...tabs]
    : tabs.filter((existing) => existing.id !== 'active-draft')
  const index = existingTabs.findIndex((existing) => existing.id === tab.id)
  if (index < 0) return Object.freeze([...existingTabs, Object.freeze({ ...tab })])
  return Object.freeze(existingTabs.map((existing, current) =>
    current === index ? Object.freeze({ ...tab }) : existing,
  ))
}

/** Close one visible tab and choose a neighboring tab when the active one closes. */
export function closeConversationTab(
  tabs: readonly ConversationTab[],
  id: string,
  selectedId: string | null,
): ClosedConversationTabs {
  const index = tabs.findIndex((tab) => tab.id === id)
  if (index < 0) return { tabs, selectedId }
  const nextTabs = Object.freeze(tabs.filter((tab) => tab.id !== id))
  if (selectedId !== id) return { tabs: nextTabs, selectedId }
  const neighbor = nextTabs[Math.min(index, nextTabs.length - 1)]
  return { tabs: nextTabs, selectedId: neighbor?.id ?? null }
}

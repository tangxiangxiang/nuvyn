import type { WorkspaceTab } from './tabs'

function documentPath(tab: WorkspaceTab): string {
  return tab.documentPath ?? (tab.kind === 'document' ? tab.id : '')
}

export function fallbackAfterClosingWorkspaceTab(
  tabs: readonly WorkspaceTab[],
  closingId: string,
): string | null {
  const closingIndex = tabs.findIndex((tab) => tab.id === closingId)
  const closing = tabs[closingIndex]
  if (!closing) return null

  const path = documentPath(closing)
  const remaining = tabs.filter((tab) => tab.id !== closingId)
  if (closing.kind === 'diff') {
    const current = remaining.find((tab) => tab.kind === 'document' && tab.id === path)
    if (current) return current.id
  }
  if (closing.kind === 'document') {
    const comparison = remaining.find((tab) => tab.kind === 'diff' && documentPath(tab) === path)
    if (comparison) return comparison.id
  }

  return remaining[closingIndex]?.id ?? remaining[closingIndex - 1]?.id ?? null
}

export function fallbackAfterClosingWorkspaceTabs(
  tabs: readonly WorkspaceTab[],
  closingIds: readonly string[],
  activeId: string | null,
): string | null {
  if (!activeId) return null
  const closing = new Set(closingIds)
  if (!closing.has(activeId)) return activeId

  const activeIndex = tabs.findIndex((tab) => tab.id === activeId)
  const active = tabs[activeIndex]
  if (!active) return null
  const remaining = tabs.filter((tab) => !closing.has(tab.id))
  const path = documentPath(active)

  if (active.kind === 'diff') {
    const current = remaining.find((tab) => tab.kind === 'document' && tab.id === path)
    if (current) return current.id
  }
  if (active.kind === 'document') {
    const comparison = remaining.find((tab) => tab.kind === 'diff' && documentPath(tab) === path)
    if (comparison) return comparison.id
  }

  return remaining.find((tab) => tabs.indexOf(tab) > activeIndex)?.id
    ?? [...remaining].reverse().find((tab) => tabs.indexOf(tab) < activeIndex)?.id
    ?? null
}
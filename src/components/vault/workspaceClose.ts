import type { WorkspaceTab } from './tabs'
import {
  fallbackAfterClosingWorkspaceTab,
  fallbackAfterClosingWorkspaceTabs,
} from './workspaceNavigation'

interface ComparisonRef {
  tabId: string
  documentPath: string
}

export interface WorkspaceCloseDependencies {
  workspaceTabs: readonly WorkspaceTab[]
  activeId: string | null
  comparisons: readonly ComparisonRef[]
  closeEditorTab: (id: string) => Promise<boolean>
  closeComparison: (id: string) => void
  workingTreeDiffs?: readonly ComparisonRef[]
  closeWorkingTreeDiff?: (id: string) => void
  closeRecovery?: (id: string) => void
  refreshDocumentComparison: (path: string) => Promise<boolean>
}

export interface WorkspaceCloseManyDependencies {
  workspaceTabs: readonly WorkspaceTab[]
  activeId: string | null
  comparisons: () => readonly ComparisonRef[]
  confirmEditorTabs: (ids: string[]) => Promise<boolean>
  closeEditorTabsConfirmed: (ids: string[]) => void
  closeComparisons: (ids: string[]) => void
  workingTreeDiffs?: () => readonly ComparisonRef[]
  closeWorkingTreeDiffs?: (ids: string[]) => void
  closeRecoveries?: (ids: string[]) => void
  refreshDocumentComparison: (path: string) => Promise<boolean>
}

export interface WorkspaceCloseResult {
  closed: boolean
  activeWillClose: boolean
  fallbackId: string | null
}

export async function closeWorkspaceTabState(
  id: string,
  deps: WorkspaceCloseDependencies,
): Promise<WorkspaceCloseResult> {
  const activeWillClose = deps.activeId === id
  const fallbackId = activeWillClose
    ? fallbackAfterClosingWorkspaceTab(deps.workspaceTabs, id)
    : null

  const tab = deps.workspaceTabs.find((candidate) => candidate.id === id)
  if (!tab) return { closed: false, activeWillClose, fallbackId }
  switch (tab.kind) {
    case 'diff':
      if (deps.workingTreeDiffs?.some((diff) => diff.tabId === id)) {
        deps.closeWorkingTreeDiff?.(id)
      } else {
        deps.closeComparison(id)
      }
      break
    case 'recovery':
      deps.closeRecovery?.(id)
      break
    case 'document': {
      const closed = await deps.closeEditorTab(id)
      if (!closed) return { closed: false, activeWillClose, fallbackId }
      // This must run after the editor disappears: the comparison then reads
      // saved disk content instead of the discarded in-memory document.
      await deps.refreshDocumentComparison(id)
      break
    }
  }

  return { closed: true, activeWillClose, fallbackId }
}

export async function closeManyWorkspaceTabState(
  ids: readonly string[],
  deps: WorkspaceCloseManyDependencies,
): Promise<WorkspaceCloseResult> {
  const workspaceIds = new Set(deps.workspaceTabs.map((tab) => tab.id))
  const closingIds = ids.filter((id) => workspaceIds.has(id))
  if (closingIds.length === 0) {
    return { closed: false, activeWillClose: false, fallbackId: null }
  }

  const activeWillClose = deps.activeId !== null && closingIds.includes(deps.activeId)
  const fallbackId = fallbackAfterClosingWorkspaceTabs(
    deps.workspaceTabs,
    closingIds,
    deps.activeId,
  )
  const closingTabs = deps.workspaceTabs.filter((tab) => closingIds.includes(tab.id))
  const comparisonIds = closingTabs.filter((tab) => tab.kind === 'diff').map((tab) => tab.id)
  const workingTreeDiffIds = new Set(
    comparisonIds.filter((id) => deps.workingTreeDiffs?.().some((diff) => diff.tabId === id)),
  )
  const documentIds = closingTabs.filter((tab) => tab.kind === 'document').map((tab) => tab.id)
  const recoveryIds = closingTabs.filter((tab) => tab.kind === 'recovery').map((tab) => tab.id)

  // Confirm all dirty documents before mutating any kind of Workspace tab.
  if (!(await deps.confirmEditorTabs(documentIds))) {
    return { closed: false, activeWillClose, fallbackId }
  }

  deps.closeEditorTabsConfirmed(documentIds)
  deps.closeComparisons(comparisonIds.filter((id) => !workingTreeDiffIds.has(id)))
  deps.closeWorkingTreeDiffs?.(comparisonIds.filter((id) => workingTreeDiffIds.has(id)))
  deps.closeRecoveries?.(recoveryIds)

  const remainingComparisonPaths = documentIds.filter((path) =>
    deps.comparisons().some((comparison) => comparison.documentPath === path),
  )
  await Promise.all(
    remainingComparisonPaths.map((path) => deps.refreshDocumentComparison(path)),
  )

  return { closed: true, activeWillClose, fallbackId }
}

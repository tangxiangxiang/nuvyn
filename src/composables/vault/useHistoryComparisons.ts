import { computed, ref } from 'vue'
import * as historyApi from '../../lib/history-api'
import { computeFileDiff } from '../../../shared/file-diff'
import { isManagedDiaryPath } from '../../../shared/diaryProtocol'
import type { FileDiff } from '../../lib/history-api'

export type HistoryComparisonStatus = 'loading' | 'ready' | 'error'

export type HistoryComparisonMode = 'commit-change' | 'revision-to-worktree'

/**
 * A user's choice of "this document, this revision".
 *
 * History commit comparisons use the first parent for merge commits.
 * Combined merge diffs are outside the current UI model.
 */
export interface HistoryRevisionSelection {
  documentPath: string
  documentTitle: string
  revisionId: string
  parentRevisionId: string | null
  revisionTime: number
  summary: string
}

export interface CurrentDocumentContent {
  raw: string
  dirty: boolean
  /** Optional so existing editor/document loaders can keep their contract. */
  exists?: boolean
}

interface EditorDocumentCandidate {
  path: string
  raw: string
  originalRaw: string
  loading: boolean
  loadError: string | null
}

export function getLoadedEditorDocument(
  tabs: readonly EditorDocumentCandidate[],
  path: string,
): CurrentDocumentContent | null {
  const tab = tabs.find((item) => item.path === path)
  if (!tab || tab.loading || tab.loadError) return null

  return {
    raw: tab.raw,
    dirty: tab.raw !== tab.originalRaw,
    exists: true,
  }
}

export interface HistoricalFileState {
  raw: string
  exists: boolean
}

export interface HistoryComparison {
  tabId: string
  documentPath: string
  documentTitle: string
  mode: HistoryComparisonMode
  revisionId: string
  parentRevisionId: string | null
  beforeRef: string | null
  afterRef: string | typeof historyApi.WORKTREE_REF
  beforeRaw: string
  afterRaw: string
  beforeExists: boolean
  afterExists: boolean
  revisionTime: number
  summary: string
  currentDirty: boolean
  diff: FileDiff | null
  status: HistoryComparisonStatus
  error: string | null
}

interface HistoryComparisonOptions {
  getCurrentDocument: (path: string) => CurrentDocumentContent | null
  loadCurrentDocument: (path: string) => Promise<string | CurrentDocumentContent>
}

function comparisonTabId(path: string): string {
  return `diff:${path}`
}

function historyPath(path: string): string {
  return path.endsWith('.md') ? path : `${path}.md`
}

/**
 * A file missing at a historical ref is an expected state for file creation
 * and deletion commits. Only HTTP 404 is converted to an empty side; all
 * other failures continue through the comparison error state.
 */
export async function loadHistoricalFileState(
  documentPath: string,
  revisionId: string | null,
): Promise<HistoricalFileState> {
  if (!revisionId) return { raw: '', exists: false }

  try {
    const result = await historyApi.getFileAt(historyPath(documentPath), revisionId)
    return { raw: result.content, exists: true }
  } catch (error) {
    if (error instanceof historyApi.HistoryApiError && error.status === 404) {
      return { raw: '', exists: false }
    }
    throw error
  }
}

function normalizeCurrentDocument(
  loaded: string | CurrentDocumentContent,
): CurrentDocumentContent {
  if (typeof loaded === 'string') return { raw: loaded, dirty: false, exists: true }
  return { ...loaded, exists: loaded.exists ?? true }
}

export function useHistoryComparisons(options: HistoryComparisonOptions) {
  const comparisons = ref<HistoryComparison[]>([])
  const activeComparisonId = ref<string | null>(null)
  const requestIds = new Map<string, number>()

  const activeComparison = computed(() => (
    comparisons.value.find((comparison) => comparison.tabId === activeComparisonId.value) ?? null
  ))

  function nextRequestId(tabId: string): number {
    const requestId = (requestIds.get(tabId) ?? 0) + 1
    requestIds.set(tabId, requestId)
    return requestId
  }

  function resetComparison(
    comparison: HistoryComparison,
    selection: HistoryRevisionSelection,
  ): void {
    Object.assign(comparison, {
      documentTitle: selection.documentTitle,
      mode: 'commit-change' as const,
      revisionId: selection.revisionId,
      parentRevisionId: selection.parentRevisionId,
      beforeRef: selection.parentRevisionId,
      afterRef: selection.revisionId,
      revisionTime: selection.revisionTime,
      summary: selection.summary,
      beforeRaw: '',
      afterRaw: '',
      beforeExists: false,
      afterExists: false,
      currentDirty: false,
      diff: null,
      status: 'loading' as const,
      error: null,
    })
  }

  /** Open the selected commit as parent revision → selected revision. */
  async function openComparison(selection: HistoryRevisionSelection): Promise<HistoryComparison> {
    const tabId = comparisonTabId(selection.documentPath)
    let comparison = comparisons.value.find((item) => item.tabId === tabId)
    if (!comparison) {
      const created: HistoryComparison = {
        tabId,
        documentPath: selection.documentPath,
        documentTitle: selection.documentTitle,
        mode: 'commit-change',
        revisionId: selection.revisionId,
        parentRevisionId: selection.parentRevisionId,
        beforeRef: selection.parentRevisionId,
        afterRef: selection.revisionId,
        beforeRaw: '',
        afterRaw: '',
        beforeExists: false,
        afterExists: false,
        revisionTime: selection.revisionTime,
        summary: selection.summary,
        currentDirty: false,
        diff: null,
        status: 'loading',
        error: null,
      }
      comparisons.value.push(created)
      // `ref([])` wraps array entries in reactive proxies. Continue with the
      // proxied entry so the first load updates the pane from loading to
      // ready; mutating `created` after push would bypass Vue's dependency
      // tracking and leave the first comparison visibly stuck on loading.
      comparison = comparisons.value.find((item) => item.tabId === tabId)
      if (!comparison) throw new Error('comparison tab was not created')
    } else {
      resetComparison(comparison, selection)
    }

    activeComparisonId.value = tabId
    await loadComparisonContent(comparison, nextRequestId(tabId))
    return comparison
  }

  async function loadCommitChangeComparison(
    comparison: HistoryComparison,
    requestId: number,
  ): Promise<void> {
    const [before, after] = await Promise.all([
      loadHistoricalFileState(comparison.documentPath, comparison.parentRevisionId),
      loadHistoricalFileState(comparison.documentPath, comparison.revisionId),
    ])
    if (requestIds.get(comparison.tabId) !== requestId) return

    comparison.beforeRef = comparison.parentRevisionId
    comparison.afterRef = comparison.revisionId
    comparison.beforeRaw = before.raw
    comparison.afterRaw = after.raw
    comparison.beforeExists = before.exists
    comparison.afterExists = after.exists
    comparison.currentDirty = false
    comparison.diff = computeFileDiff(before.raw, after.raw)
    comparison.status = 'ready'
    comparison.error = null
  }

  async function loadRevisionToWorktreeComparison(
    comparison: HistoryComparison,
    requestId: number,
  ): Promise<void> {
    const currentPromise = Promise.resolve(options.getCurrentDocument(comparison.documentPath))
      .then(async (openDocument): Promise<CurrentDocumentContent> => {
        if (openDocument) return { ...openDocument, exists: openDocument.exists ?? true }
        return normalizeCurrentDocument(await options.loadCurrentDocument(comparison.documentPath))
      })
    const [historical, current] = await Promise.all([
      loadHistoricalFileState(comparison.documentPath, comparison.revisionId),
      currentPromise,
    ])
    if (requestIds.get(comparison.tabId) !== requestId) return

    comparison.beforeRef = comparison.revisionId
    comparison.afterRef = historyApi.WORKTREE_REF
    comparison.beforeRaw = historical.raw
    comparison.afterRaw = current.raw
    comparison.beforeExists = historical.exists
    comparison.afterExists = current.exists ?? true
    comparison.currentDirty = current.dirty
    comparison.diff = computeFileDiff(historical.raw, current.raw)
    comparison.status = 'ready'
    comparison.error = null
  }

  /**
   * Resolve the active comparison mode. The request-id guard ensures a
   * slower historical or working-tree request cannot overwrite a newer mode
   * selection, revision selection, or a closed comparison tab.
   */
  async function loadComparisonContent(
    comparison: HistoryComparison,
    requestId: number,
  ): Promise<void> {
    try {
      if (comparison.mode === 'commit-change') {
        await loadCommitChangeComparison(comparison, requestId)
      } else {
        await loadRevisionToWorktreeComparison(comparison, requestId)
      }
    } catch (error) {
      if (requestIds.get(comparison.tabId) !== requestId) return
      comparison.status = 'error'
      comparison.error = error instanceof Error && error.message ? error.message : null
    }
  }

  async function setComparisonMode(
    tabId: string,
    mode: HistoryComparisonMode,
  ): Promise<HistoryComparison | null> {
    const comparison = comparisons.value.find((item) => item.tabId === tabId)
    if (!comparison) return null
    comparison.mode = mode
    comparison.beforeRef = mode === 'commit-change' ? comparison.parentRevisionId : comparison.revisionId
    comparison.afterRef = mode === 'commit-change' ? comparison.revisionId : historyApi.WORKTREE_REF
    comparison.beforeRaw = ''
    comparison.afterRaw = ''
    comparison.beforeExists = false
    comparison.afterExists = false
    comparison.currentDirty = false
    comparison.diff = null
    comparison.status = 'loading'
    comparison.error = null
    await loadComparisonContent(comparison, nextRequestId(tabId))
    return comparison
  }

  function compareWithWorkingTree(tabId: string): Promise<HistoryComparison | null> {
    return setComparisonMode(tabId, 'revision-to-worktree')
  }

  function viewCommitChanges(tabId: string): Promise<HistoryComparison | null> {
    return setComparisonMode(tabId, 'commit-change')
  }

  async function refreshComparison(tabId: string): Promise<HistoryComparison | null> {
    const comparison = comparisons.value.find((item) => item.tabId === tabId)
    if (!comparison) return null

    comparison.status = 'loading'
    comparison.error = null
    await loadComparisonContent(comparison, nextRequestId(tabId))
    return comparison
  }

  function selectComparison(tabId: string): void {
    if (!comparisons.value.some((comparison) => comparison.tabId === tabId)) return
    activeComparisonId.value = tabId
    void refreshComparison(tabId)
  }

  async function refreshDocumentComparison(path: string): Promise<boolean> {
    const comparison = comparisons.value.find((item) => item.documentPath === path)
    if (!comparison) return true
    const refreshed = await refreshComparison(comparison.tabId)
    return refreshed?.status === 'ready'
  }

  function deactivate(): void {
    activeComparisonId.value = null
  }

  /** Fence outstanding historical reads and drop comparison bodies. A Diary
   *  teardown must not leave decrypted before/after snapshots reachable from
   *  a hidden comparison tab. */
  function clearSensitiveState(): void {
    const managedIds = new Set(comparisons.value
      .filter((comparison) => isManagedDiaryPath(comparison.documentPath.replace(/\.md$/, '')))
      .map((comparison) => comparison.tabId))
    for (const tabId of managedIds) nextRequestId(tabId)
    comparisons.value = comparisons.value.filter((comparison) => !managedIds.has(comparison.tabId))
    if (activeComparisonId.value && managedIds.has(activeComparisonId.value)) {
      activeComparisonId.value = null
    }
  }

  function closeComparison(tabId: string): void {
    nextRequestId(tabId)
    comparisons.value = comparisons.value.filter((comparison) => comparison.tabId !== tabId)
    if (activeComparisonId.value === tabId) activeComparisonId.value = null
  }

  function closeComparisons(tabIds: string[]): void {
    const ids = new Set(tabIds)
    for (const tabId of ids) nextRequestId(tabId)
    comparisons.value = comparisons.value.filter((comparison) => !ids.has(comparison.tabId))
    if (activeComparisonId.value && ids.has(activeComparisonId.value)) {
      activeComparisonId.value = null
    }
  }

  return {
    comparisons,
    activeComparisonId,
    activeComparison,
    openComparison,
    compareWithWorkingTree,
    viewCommitChanges,
    selectComparison,
    refreshComparison,
    refreshDocumentComparison,
    deactivate,
    clearSensitiveState,
    closeComparison,
    closeComparisons,
  }
}

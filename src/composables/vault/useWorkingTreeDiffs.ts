import { computed, ref } from 'vue'
import { getDiff, WORKTREE_REF, type FileDiff, type StatusEntry } from '../../lib/history-api'
import { isManagedDiaryPath } from '../../../shared/diaryProtocol'

export type WorkingTreeDiffStatus = 'loading' | 'ready' | 'error'

export interface WorkingTreeDiff {
  tabId: string
  documentPath: string
  documentTitle: string
  statusKind: 'modified' | 'added' | 'deleted'
  diff: FileDiff | null
  status: WorkingTreeDiffStatus
  error: string | null
}

interface WorkingTreeDiffOptions {
  getDocumentTitle?: (path: string) => string
}

export function changesDiffTabId(path: string): string {
  return `changes-diff:${path}`
}

function statusKind(entry: StatusEntry): WorkingTreeDiff['statusKind'] {
  if (entry.index === '?' || entry.worktree === '?' || entry.index === 'A') return 'added'
  if (entry.index === 'D' || entry.worktree === 'D') return 'deleted'
  return 'modified'
}

export function useWorkingTreeDiffs(options: WorkingTreeDiffOptions = {}) {
  const diffs = ref<WorkingTreeDiff[]>([])
  const activeDiffId = ref<string | null>(null)
  const requestIds = new Map<string, number>()

  const activeDiff = computed(() => (
    diffs.value.find((diff) => diff.tabId === activeDiffId.value) ?? null
  ))

  function nextRequestId(tabId: string): number {
    const requestId = (requestIds.get(tabId) ?? 0) + 1
    requestIds.set(tabId, requestId)
    return requestId
  }

  async function loadDiff(diff: WorkingTreeDiff, entry: StatusEntry, requestId: number): Promise<void> {
    try {
      const response = await getDiff(entry.path, 'HEAD', WORKTREE_REF)
      if (requestIds.get(diff.tabId) !== requestId) return
      diff.diff = response.diff
      diff.status = 'ready'
      diff.error = null
    } catch (error) {
      if (requestIds.get(diff.tabId) !== requestId) return
      diff.status = 'error'
      diff.error = error instanceof Error && error.message ? error.message : null
    }
  }

  async function openDiff(entry: StatusEntry, documentTitle: string): Promise<WorkingTreeDiff> {
    const tabId = changesDiffTabId(entry.path)
    let diff = diffs.value.find((item) => item.tabId === tabId)
    const next = {
      tabId,
      documentPath: entry.path.endsWith('.md') ? entry.path.slice(0, -3) : entry.path,
      documentTitle: documentTitle || options.getDocumentTitle?.(entry.path) || entry.path,
      statusKind: statusKind(entry),
      diff: null,
      status: 'loading' as const,
      error: null,
    }
    if (diff) Object.assign(diff, next)
    else {
      diffs.value.push(next)
      diff = diffs.value.find((item) => item.tabId === tabId)!
    }
    activeDiffId.value = tabId
    await loadDiff(diff, entry, nextRequestId(tabId))
    return diff
  }

  async function refreshDiff(tabId: string): Promise<WorkingTreeDiff | null> {
    const diff = diffs.value.find((item) => item.tabId === tabId)
    if (!diff) return null
    const path = `${diff.documentPath}.md`
    const entry: StatusEntry = { path, index: ' ', worktree: 'M' }
    diff.status = 'loading'
    diff.error = null
    await loadDiff(diff, entry, nextRequestId(tabId))
    return diff
  }

  function selectDiff(tabId: string): void {
    if (!diffs.value.some((diff) => diff.tabId === tabId)) return
    activeDiffId.value = tabId
    void refreshDiff(tabId)
  }

  async function refreshDocumentDiff(path: string): Promise<boolean> {
    const normalizedPath = path.endsWith('.md') ? path.slice(0, -3) : path
    const diff = diffs.value.find((item) => item.documentPath === normalizedPath)
    if (!diff) return true
    const refreshed = await refreshDiff(diff.tabId)
    return refreshed?.status === 'ready'
  }

  function deactivate(): void {
    activeDiffId.value = null
  }

  /** Fence outstanding diff reads and drop raw diff snapshots during an
   *  authoritative Diary teardown. */
  function clearSensitiveState(): void {
    const managedIds = new Set(diffs.value
      .filter((diff) => isManagedDiaryPath(diff.documentPath))
      .map((diff) => diff.tabId))
    for (const tabId of managedIds) nextRequestId(tabId)
    diffs.value = diffs.value.filter((diff) => !managedIds.has(diff.tabId))
    if (activeDiffId.value && managedIds.has(activeDiffId.value)) activeDiffId.value = null
  }

  function closeDiff(tabId: string): void {
    nextRequestId(tabId)
    diffs.value = diffs.value.filter((diff) => diff.tabId !== tabId)
    if (activeDiffId.value === tabId) activeDiffId.value = null
  }

  function closeDiffs(tabIds: string[]): void {
    const ids = new Set(tabIds)
    for (const tabId of ids) nextRequestId(tabId)
    diffs.value = diffs.value.filter((diff) => !ids.has(diff.tabId))
    if (activeDiffId.value && ids.has(activeDiffId.value)) activeDiffId.value = null
  }

  return {
    diffs,
    activeDiffId,
    activeDiff,
    openDiff,
    selectDiff,
    refreshDiff,
    refreshDocumentDiff,
    deactivate,
    clearSensitiveState,
    closeDiff,
    closeDiffs,
  }
}

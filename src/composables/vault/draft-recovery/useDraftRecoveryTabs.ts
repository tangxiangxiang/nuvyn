import { computed, ref } from 'vue'
import type { DraftRecoveryDecisionKind } from './draftRecoveryDecision'
import type { DraftRecoveryItem } from './useUnsavedDraftRecovery'
import { isManagedDiaryPath } from '../../../../shared/diaryProtocol'

export interface DraftRecoveryTab {
  tabId: string
  recoveryId: string
  source: 'primary' | 'conflict'
  documentId: string
  documentPath: string
  documentTitle: string
  decisionKind: DraftRecoveryDecisionKind
  diskStatus: 'ready' | 'missing' | 'unreadable'
  diskDocumentId: string | null
  canViewCurrent: boolean
  canViewDiff: boolean
  view: 'content' | 'diff'
  draftRaw: string
  diskRaw: string | null
  status: 'ready' | 'error'
  error: string | null
}

function titleFromPath(path: string): string {
  const filename = path.split('/').pop() || path
  return filename.endsWith('.md') ? filename.slice(0, -3) : filename
}

export function recoveryTabId(
  vaultId: string,
  documentId: string,
  recoveryId?: string,
): string {
  const candidate = recoveryId
    ? `:${encodeURIComponent(recoveryId)}`
    : ''
  return `recovery:${encodeURIComponent(vaultId)}:${encodeURIComponent(documentId)}${candidate}`
}

export function useDraftRecoveryTabs() {
  const tabs = ref<DraftRecoveryTab[]>([])
  const activeTabId = ref<string | null>(null)
  const activeTab = computed(() =>
    tabs.value.find((tab) => tab.tabId === activeTabId.value) ?? null,
  )

  function open(item: DraftRecoveryItem, view: 'content' | 'diff'): DraftRecoveryTab | null {
    if (item.status !== 'ready' || !item.decision
      || isManagedDiaryPath(item.draft.documentPath.replace(/\.md$/, ''))) return null
    const id = recoveryTabId(
      item.draft.vaultId,
      item.draft.documentId,
      item.source === 'conflict' ? item.recoveryId : undefined,
    )
    let tab = tabs.value.find((candidate) => candidate.tabId === id)
    const diskRaw = item.decision.disk.status === 'ready'
      ? item.decision.disk.raw
      : null
    const diskDocumentId = item.decision.disk.status === 'ready'
      ? item.decision.disk.documentId
      : null
    const canViewCurrent = item.decision.disk.status === 'ready'
      && diskDocumentId === item.draft.documentId
    const canViewDiff = item.decision.disk.status === 'ready'
    const next: DraftRecoveryTab = {
      tabId: id,
      recoveryId: item.recoveryId,
      source: item.source,
      documentId: item.draft.documentId,
      documentPath: item.draft.documentPath,
      documentTitle: titleFromPath(item.draft.documentPath),
      decisionKind: item.decision.kind,
      diskStatus: item.decision.disk.status,
      diskDocumentId,
      canViewCurrent,
      canViewDiff,
      view: view === 'diff' && !canViewDiff ? 'content' : view,
      draftRaw: item.draft.content,
      diskRaw,
      status: 'ready',
      error: null,
    }
    if (tab) Object.assign(tab, next)
    else {
      tabs.value.push(next)
      tab = tabs.value.at(-1)!
    }
    activeTabId.value = id
    return tab
  }

  function select(tabId: string): void {
    if (tabs.value.some((tab) => tab.tabId === tabId)) activeTabId.value = tabId
  }

  function deactivate(): void {
    activeTabId.value = null
  }

  function close(tabId: string): void {
    tabs.value = tabs.value.filter((tab) => tab.tabId !== tabId)
    if (activeTabId.value === tabId) activeTabId.value = null
  }

  function closeMany(tabIds: readonly string[]): void {
    const ids = new Set(tabIds)
    tabs.value = tabs.value.filter((tab) => !ids.has(tab.tabId))
    if (activeTabId.value && ids.has(activeTabId.value)) activeTabId.value = null
  }

  function closeRecovery(recoveryId: string): void {
    closeMany(tabs.value
      .filter((tab) => tab.recoveryId === recoveryId)
      .map((tab) => tab.tabId))
  }

  /** Remove only managed-Diary recovery viewers at the authoritative
   *  teardown boundary. Ordinary Note recovery tabs remain untouched. */
  function clearSensitiveState(): void {
    closeMany(tabs.value
      .filter((tab) => isManagedDiaryPath(tab.documentPath.replace(/\.md$/, '')))
      .map((tab) => tab.tabId))
  }

  return {
    tabs,
    activeTabId,
    activeTab,
    open,
    select,
    deactivate,
    close,
    closeMany,
    closeRecovery,
    clearSensitiveState,
  }
}

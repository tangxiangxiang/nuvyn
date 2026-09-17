import { computed, ref, watch } from 'vue'
import {
  createCommit,
  discardIndexRepair,
  getContentHashes,
  getIndexRepairStatus,
  HistoryApiError,
  repairIndex,
  type CommitResult,
  type IndexRepairTransaction,
} from '../../lib/history-api'
import { useI18n } from '../useI18n'
import { useToast } from '../useToast'
import type { HistoryState } from './useHistory'

export interface HistoryCommitOptions {
  history: HistoryState
  saveSelected(paths: readonly string[]): Promise<void | ((
    options?: { flushPending?: boolean }
  ) => Promise<void>)>
  refreshComparisons?(committedPaths: readonly string[]): Promise<void>
  acquireMutation?(paths: readonly string[]): (() => void) | null
  canMutate?(paths: readonly string[]): boolean
}

export function useHistoryCommit(options: HistoryCommitOptions) {
  const { t } = useI18n()
  const toast = useToast()
  const selectedPaths = ref<Set<string>>(new Set())
  const message = ref('')
  const busy = ref(false)
  const busyPaths = ref<Set<string>>(new Set())
  const error = ref<string | null>(null)
  const lastCommittedPaths = ref<readonly string[]>([])
  const completionId = ref(0)
  const repositoryChangeId = ref(0)
  const indexRepairTransactions = ref<readonly IndexRepairTransaction[]>([])
  const indexRepairPaths = computed<readonly string[]>(() => (
    [...new Set(indexRepairTransactions.value.flatMap((transaction) => transaction.paths))]
  ))
  const indexRepairBusy = ref(false)
  const indexRepairConflictToken = ref<string | null>(null)
  let initializedSelection = false

  function setIndexRepairTransactions(
    transactions: readonly IndexRepairTransaction[],
  ): void {
    indexRepairTransactions.value = transactions
    indexRepairConflictToken.value = transactions.find(
      (transaction) => transaction.status === 'superseded',
    )?.token ?? null
  }

  async function refreshIndexRepairStatus(): Promise<boolean> {
    try {
      setIndexRepairTransactions(await getIndexRepairStatus())
      return true
    } catch {
      // Capability/repository initialization can still be in flight during
      // Vault setup. A later commit or explicit repair retries this read.
      return false
    }
  }

  function registerIndexRepair(transaction: IndexRepairTransaction): void {
    const replaced = new Set(transaction.paths)
    const retained = indexRepairTransactions.value.map((item) => {
      const paths = item.paths.filter((filePath) => !replaced.has(filePath))
      return {
        ...item,
        paths,
        expectedIndex: Object.fromEntries(paths.map((filePath) => (
          [filePath, item.expectedIndex[filePath] ?? []]
        ))),
      }
    }).filter((item) => item.paths.length > 0 && item.token !== transaction.token)
    setIndexRepairTransactions([...retained, transaction])
  }

  function settleIndexRepairPaths(paths: readonly string[]): void {
    const settled = new Set(paths)
    setIndexRepairTransactions(
      indexRepairTransactions.value.map((transaction) => ({
        ...transaction,
        paths: transaction.paths.filter((filePath) => !settled.has(filePath)),
      })).filter((transaction) => transaction.paths.length > 0),
    )
  }

  function removeIndexRepairToken(token: string): void {
    setIndexRepairTransactions(
      indexRepairTransactions.value.filter(
        (transaction) => transaction.token !== token,
      ),
    )
  }

  void refreshIndexRepairStatus()

  watch(
    () => options.history.status.value.map((entry) => entry.path),
    (paths) => {
      const available = new Set(paths)
      if (!initializedSelection) {
        if (paths.length === 0) return
        initializedSelection = true
        selectedPaths.value = new Set(paths)
        return
      }
      selectedPaths.value = new Set(
        [...selectedPaths.value].filter((path) => available.has(path)),
      )
    },
    { immediate: true },
  )

  const selectedCount = computed(() => selectedPaths.value.size)
  const trimmedMessage = computed(() => message.value.trim())
  const canCommit = computed(() => (
    selectedCount.value > 0
    && trimmedMessage.value.length > 0
    && !busy.value
    && (options.canMutate?.([...selectedPaths.value]) ?? true)
  ))

  function toggle(path: string): void {
    if (busy.value) return
    const next = new Set(selectedPaths.value)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    selectedPaths.value = next
  }

  function selectAll(): void {
    if (busy.value) return
    selectedPaths.value = new Set(options.history.status.value.map((entry) => entry.path))
  }

  function clearSelection(): void {
    if (busy.value) return
    selectedPaths.value = new Set()
  }

  async function refreshAfterCommit(paths: readonly string[]): Promise<void> {
    await Promise.all([
      options.history.refreshStatus(),
      options.history.refreshLog(),
    ])
    await options.refreshComparisons?.(paths)
  }

  async function submit(): Promise<CommitResult | null> {
    if (busy.value) return null
    error.value = null
    const paths = [...selectedPaths.value]
    const versionMessage = trimmedMessage.value
    if (paths.length === 0) {
      error.value = t('history.commit_no_selection')
      return null
    }
    if (!versionMessage) {
      error.value = t('history.commit_empty_message')
      return null
    }

    const releaseMutation = options.acquireMutation?.(paths)
    if (options.acquireMutation && !releaseMutation) {
      error.value = t('history.document_mutation_in_progress')
      toast.info(error.value)
      return null
    }
    busy.value = true
    busyPaths.value = new Set(paths)
    let releaseBarrier: ((options?: { flushPending?: boolean }) => Promise<void>) | null = null
    try {
      releaseBarrier = await options.saveSelected(paths) ?? null
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : t('common.unknown_error')
      error.value = t('history.commit_save_failed', { error: detail })
      toast.error(error.value)
      busy.value = false
      busyPaths.value = new Set()
      releaseMutation?.()
      return null
    }

    try {
      const expected = await getContentHashes(paths)
      const result = await createCommit(paths, versionMessage, expected)
      await releaseBarrier?.()
      releaseBarrier = null
      await refreshAfterCommit(result.filesCommitted)
      selectedPaths.value = new Set(
        [...selectedPaths.value].filter((path) => !result.filesCommitted.includes(path)),
      )
      message.value = ''
      lastCommittedPaths.value = result.filesCommitted
      completionId.value += 1
      const success = result.filesCommitted.length === 1
        ? t('history.commit_success')
        : t('history.commit_success_count', { count: result.filesCommitted.length })
      if (result.indexRefreshFailed) {
        if (result.indexRepair) registerIndexRepair(result.indexRepair)
        toast.info(
          result.repairStatePersistenceFailed
            ? t('history.commit_repair_state_persistence_failed')
            : t('history.commit_index_refresh_failed'),
          5000,
        )
      } else {
        settleIndexRepairPaths(result.filesCommitted)
        if (result.repairStatePersistenceFailed) {
          toast.info(t('history.commit_repair_state_persistence_failed'), 5000)
        } else {
          toast.success(success)
        }
      }
      await refreshIndexRepairStatus()
      return result
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : t('common.unknown_error')
      if (cause instanceof HistoryApiError && cause.status === 409) {
        if (cause.code === 'HISTORY_REPOSITORY_CHANGED' || /repository changed before commit/i.test(detail)) {
          await Promise.all([options.history.refreshStatus(), options.history.refreshLog()])
          repositoryChangeId.value += 1
          error.value = t('history.commit_repository_changed')
        } else if (cause.code === 'HISTORY_REPOSITORY_OPERATION' || /repository operation in progress/i.test(detail)) {
          await options.history.refreshStatus()
          error.value = t('history.repository_operation_in_progress')
        } else {
          await options.history.refreshStatus()
          error.value = t('history.commit_stale', { error: detail })
        }
      } else {
        error.value = t('history.commit_failed', { error: detail })
      }
      toast.error(error.value)
      return null
    } finally {
      await releaseBarrier?.()
      busy.value = false
      busyPaths.value = new Set()
      releaseMutation?.()
    }
  }

  async function retryIndexRepair(): Promise<boolean> {
    if (indexRepairBusy.value || indexRepairTransactions.value.length === 0) return false
    indexRepairBusy.value = true
    error.value = null
    let repairingToken: string | null = null
    let repairStatePersistenceFailed = false
    try {
      for (const transaction of indexRepairTransactions.value) {
        repairingToken = transaction.token
        const result = await repairIndex(transaction.token)
        if (!result.repairStatePersistenceFailed) {
          removeIndexRepairToken(transaction.token)
        }
        repairStatePersistenceFailed ||= result.repairStatePersistenceFailed === true
      }
      await options.history.refreshStatus()
      await refreshIndexRepairStatus()
      if (repairStatePersistenceFailed) {
        toast.info(t('history.index_repair_state_persistence_failed'), 5000)
      } else {
        toast.success(t('history.index_repair_success'))
      }
      return true
    } catch (cause) {
      await refreshIndexRepairStatus()
      const detail = cause instanceof Error ? cause.message : t('common.unknown_error')
      const repairStatePersistenceFailed = cause instanceof HistoryApiError
        && cause.status === 409
        && cause.code === 'HISTORY_INDEX_REPAIR_STATE_PERSISTENCE_FAILED'
      error.value = repairStatePersistenceFailed
        ? t('history.index_repair_replacement_state_failed')
        : cause instanceof HistoryApiError
        && cause.status === 409
        && (cause.code === 'HISTORY_INDEX_REPAIR_CONFLICT' || /index changed after repair/i.test(detail))
        ? t('history.index_repair_conflict')
        : t('history.index_repair_failed', { error: detail })
      if (cause instanceof HistoryApiError
        && cause.status === 409
        && (cause.code === 'HISTORY_INDEX_REPAIR_CONFLICT' || /index changed after repair/i.test(detail))) {
        indexRepairConflictToken.value = repairingToken
      }
      toast.error(error.value)
      return false
    } finally {
      indexRepairBusy.value = false
    }
  }

  async function discardConflictingIndexRepair(): Promise<boolean> {
    const token = indexRepairConflictToken.value
    if (!token || indexRepairBusy.value) return false
    indexRepairBusy.value = true
    error.value = null
    try {
      await discardIndexRepair(token)
      removeIndexRepairToken(token)
      await refreshIndexRepairStatus()
      toast.success(t('history.index_repair_discarded'))
      return true
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : t('common.unknown_error')
      error.value = t('history.index_repair_discard_failed', { error: detail })
      toast.error(error.value)
      return false
    } finally {
      indexRepairBusy.value = false
    }
  }

  return {
    selectedPaths,
    selectedCount,
    message,
    busy,
    busyPaths,
    error,
    lastCommittedPaths,
    completionId,
    repositoryChangeId,
    indexRepairTransactions,
    indexRepairPaths,
    indexRepairBusy,
    indexRepairConflictToken,
    canCommit,
    toggle,
    selectAll,
    clearSelection,
    submit,
    retryIndexRepair,
    discardConflictingIndexRepair,
    refreshIndexRepairStatus,
    registerIndexRepair,
    settleIndexRepairPaths,
  }
}

export type HistoryCommitState = ReturnType<typeof useHistoryCommit>

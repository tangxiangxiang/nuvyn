import { computed, ref } from 'vue'
import {
  dropCommit,
  HistoryApiError,
  type DropCommitResult,
} from '../../lib/history-api'
import { useI18n } from '../useI18n'
import { useToast } from '../useToast'
import type { HistoryState } from './useHistory'

interface HistoryWithdrawOptions {
  history: HistoryState
  confirm(): Promise<boolean>
  acquireMutation(): (() => void) | null
  canMutate?(): boolean
  refreshComparisons(paths: readonly string[]): Promise<void>
  refreshIndexRepairStatus(): Promise<boolean>
  registerIndexRepair(transaction: NonNullable<DropCommitResult['indexRepair']>): void
  settleIndexRepairPaths(paths: readonly string[]): void
  closeDroppedRevision(sha: string): void
  drop?: typeof dropCommit
}

export function useHistoryWithdraw(options: HistoryWithdrawOptions) {
  const { t } = useI18n()
  const toast = useToast()
  const busy = ref(false)
  const error = ref<string | null>(null)
  const completionId = ref(0)
  const lastDroppedSha = ref<string | null>(null)
  const lastChangedPaths = ref<readonly string[]>([])
  let pending = false
  const canWithdraw = computed(() => !busy.value && (options.canMutate?.() ?? true))

  async function withdraw(sha: string): Promise<DropCommitResult | null> {
    if (pending || busy.value) return null
    if (!(options.canMutate?.() ?? true)) {
      error.value = t('history.history_mutation_in_progress')
      toast.info(error.value)
      return null
    }
    pending = true
    error.value = null
    try {
      let confirmed: boolean
      try {
        confirmed = await options.confirm()
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : t('common.unknown_error')
        error.value = t('history.withdraw_failed', { error: detail })
        toast.error(error.value)
        return null
      }
      if (!confirmed) return null

      const releaseMutation = options.acquireMutation()
      if (!releaseMutation) {
        error.value = t('history.history_mutation_in_progress')
        toast.info(error.value)
        return null
      }

      busy.value = true
      try {
        const result = await (options.drop ?? dropCommit)(sha)
        if (result.indexRefreshFailed) {
          if (result.indexRepair) options.registerIndexRepair(result.indexRepair)
        } else {
          options.settleIndexRepairPaths(result.filesChanged)
        }
        options.closeDroppedRevision(result.droppedSha)
        await Promise.allSettled([
          options.history.refreshStatus(),
          options.history.refreshLog(),
          options.refreshComparisons(result.filesChanged),
        ])
        await options.refreshIndexRepairStatus()
        lastDroppedSha.value = result.droppedSha
        lastChangedPaths.value = result.filesChanged
        completionId.value += 1

        if (result.repairStatePersistenceFailed) {
          toast.info(t('history.withdraw_repair_state_persistence_failed'), 5000)
        } else if (result.indexRefreshFailed) {
          toast.info(t('history.withdraw_index_refresh_failed'), 5000)
        } else {
          toast.success(t('history.withdraw_success'))
        }
        return result
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : t('common.unknown_error')
        if (cause instanceof HistoryApiError && cause.status === 409) {
          if (cause.code === 'HISTORY_NOT_NUVYN_VERSION') {
            error.value = t('history.withdraw_not_nuvyn_version')
          } else if (cause.code === 'HISTORY_REPOSITORY_OPERATION' || /repository operation in progress/i.test(detail)) {
            error.value = t('history.withdraw_repository_operation')
          } else if (cause.code === 'HISTORY_REPOSITORY_CHANGED' || /only the latest version|repository changed before withdrawal/i.test(detail)) {
            await Promise.all([options.history.refreshStatus(), options.history.refreshLog()])
            error.value = t('history.withdraw_latest_changed')
          } else if (cause.code === 'HISTORY_VAULT_WRITER_ACTIVE') {
            error.value = t('history.history_mutation_in_progress')
          } else {
            error.value = t('history.withdraw_failed', { error: detail })
          }
        } else {
          error.value = t('history.withdraw_failed', { error: detail })
        }
        toast.error(error.value)
        return null
      } finally {
        busy.value = false
        releaseMutation()
      }
    } finally {
      pending = false
    }
  }

  return {
    busy,
    error,
    completionId,
    lastDroppedSha,
    lastChangedPaths,
    canWithdraw,
    withdraw,
  }
}

export type HistoryWithdrawState = ReturnType<typeof useHistoryWithdraw>

import { computed, readonly, ref, type ComputedRef, type DeepReadonly, type Ref } from 'vue'
import {
  capacitySnapshot,
  compareRecoveryNewestFirst,
  conflictRecoveryRecord,
  planDraftCleanup,
  primaryRecoveryRecord,
  recoveryIdentityId,
  recoveryRecordId,
  type ClassifiedCleanupDecision,
  type CleanupDecision,
  type DraftCapacitySnapshot,
  type RecoveryRecordRef,
} from './draftCleanup'
import type { DraftConditionalDeleteOutcome, DraftRecoveryInventory, DraftStore } from './draftStore'
import type { DraftCleanupProtection } from './useUnsavedDraftPersistence'
import type { UnsavedDraftRecovery } from './useUnsavedDraftRecovery'
import { isManagedDiaryPath } from '../../../../shared/diaryProtocol'

export type RecoveryDeleteStatus = DraftConditionalDeleteOutcome['status'] | 'protected'

export interface RecoveryDeleteResult {
  record: RecoveryRecordRef
  status: RecoveryDeleteStatus
}

export interface BulkRecoveryDeleteReport {
  deleted: RecoveryRecordRef[]
  missing: RecoveryRecordRef[]
  stale: RecoveryRecordRef[]
  protected: RecoveryRecordRef[]
  unsupported: RecoveryRecordRef[]
  failed: RecoveryRecordRef[]
}

export interface DraftCleanupReport {
  status: 'completed' | 'before-scan-failed' | 'after-scan-failed'
  before: DraftCapacitySnapshot
  after: DraftCapacitySnapshot
  deleted: RecoveryRecordRef[]
  stale: RecoveryRecordRef[]
  skippedProtected: RecoveryRecordRef[]
  unsupportedCount: number
  failed: RecoveryRecordRef[]
  stillOverCapacity: boolean
}

interface ManagementOptions {
  store: DraftStore
  recovery: UnsavedDraftRecovery
  getPersistenceProtection: (vaultId: string) => DraftCleanupProtection
  openRecoveryIds?: Ref<readonly string[]>
  onRecordsRemoved?: (recoveryIds: readonly string[]) => void
  now?: () => number
}

export interface DraftRecoveryManagement {
  records: DeepReadonly<Ref<RecoveryRecordRef[]>>
  capacity: DeepReadonly<Ref<DraftCapacitySnapshot>>
  unsupportedCount: DeepReadonly<Ref<number>>
  loading: DeepReadonly<Ref<boolean>>
  error: DeepReadonly<Ref<string | null>>
  selectedIds: DeepReadonly<Ref<Set<string>>>
  protectedIds: ComputedRef<Set<string>>
  cleanupReport: DeepReadonly<Ref<DraftCleanupReport | null>>
  refresh(vaultId: string): Promise<boolean>
  toggleSelected(recoveryId: string): void
  clearSelection(): void
  deleteRecord(record: RecoveryRecordRef): Promise<RecoveryDeleteResult>
  deleteSelected(): Promise<BulkRecoveryDeleteReport>
  deleteAllUnprotected(): Promise<BulkRecoveryDeleteReport>
  cleanupNow(): Promise<DraftCleanupReport>
  dispose(): void
}

function emptyBulkReport(): BulkRecoveryDeleteReport {
  return {
    deleted: [], missing: [], stale: [], protected: [], unsupported: [], failed: [],
  }
}

export function createDraftRecoveryManagement(
  options: ManagementOptions,
): DraftRecoveryManagement {
  const records = ref<RecoveryRecordRef[]>([])
  const capacity = ref(capacitySnapshot([]))
  const unsupportedCount = ref(0)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const selectedIds = ref(new Set<string>())
  const activeOperations = ref(new Set<string>())
  const cleanupReport = ref<DraftCleanupReport | null>(null)
  const now = options.now ?? Date.now
  let vaultId = ''
  let generation = 0
  let disposed = false
  let cleanupPromise: Promise<DraftCleanupReport> | null = null
  let cleanupRequested = false
  let cleanupTargetVault = ''

  const protectedIds = computed(() => {
    const result = new Set(activeOperations.value)
    for (const id of options.openRecoveryIds?.value ?? []) result.add(id)
    for (const id of options.recovery.classifyingRecoveryIds.value) result.add(id)
    if (vaultId) {
      const identities = new Set(options.getPersistenceProtection(vaultId).identityIds)
      for (const id of options.recovery.classifyingIdentityIds.value) identities.add(id)
      for (const record of records.value) {
        if (identities.has(recoveryIdentityId(record))) result.add(recoveryRecordId(record))
      }
    }
    return result
  })

  function inventoryRecords(inventory: DraftRecoveryInventory): RecoveryRecordRef[] {
    return [
      ...inventory.primary
        .filter((record) => !isManagedDiaryPath(record.documentPath.replace(/\.md$/, '')))
        .map(primaryRecoveryRecord),
      ...inventory.conflicts
        .filter((record) => !isManagedDiaryPath(record.documentPath.replace(/\.md$/, '')))
        .map(conflictRecoveryRecord),
    ].sort(compareRecoveryNewestFirst)
  }

  function applyInventory(inventory: DraftRecoveryInventory): void {
    records.value = inventoryRecords(inventory)
    capacity.value = capacitySnapshot(records.value)
    unsupportedCount.value = inventory.unsupportedPrimaryCount
      + inventory.unsupportedConflictCount
    const existing = new Set(records.value.map(recoveryRecordId))
    selectedIds.value = new Set([...selectedIds.value].filter((id) => existing.has(id)))
  }

  async function refresh(nextVaultId: string): Promise<boolean> {
    const currentGeneration = ++generation
    vaultId = nextVaultId
    loading.value = true
    error.value = null
    const outcome = await options.store.inspectVaultRecovery(nextVaultId)
    if (disposed || currentGeneration !== generation || vaultId !== nextVaultId) return false
    loading.value = false
    if (outcome.status === 'failed') {
      // Surface the storage classification itself (upgrade-blocked /
      // indexeddb-unavailable / open-failed / transaction-failed) so the
      // Center can explain the actionable blocked-upgrade case.
      error.value = outcome.reason
      return false
    }
    applyInventory(outcome.inventory)
    // A successful read must clear any earlier failure explicitly: a
    // retry that recovers has to leave the Center in a clean state
    // (also clears stale cleanup-scan errors from a previous pass).
    error.value = null
    return true
  }

  function currentProtected(record: RecoveryRecordRef, includeActive = true): boolean {
    const id = recoveryRecordId(record)
    if (includeActive && activeOperations.value.has(id)) return true
    if ((options.openRecoveryIds?.value ?? []).includes(id)) return true
    if (options.recovery.classifyingRecoveryIds.value.has(id)) return true
    const identityId = recoveryIdentityId(record)
    return options.recovery.classifyingIdentityIds.value.has(identityId)
      || options.getPersistenceProtection(record.record.vaultId).identityIds.has(identityId)
  }

  async function conditionalDelete(record: RecoveryRecordRef): Promise<RecoveryDeleteResult> {
    const id = recoveryRecordId(record)
    if (currentProtected(record)) return { record, status: 'protected' }
    activeOperations.value = new Set(activeOperations.value).add(id)
    try {
      // Re-read protection immediately before the conditional Store mutation.
      // The operation's own lock is excluded from this second check.
      if (currentProtected(record, false)) {
        return { record, status: 'protected' }
      }
      const outcome = record.source === 'primary'
        ? await options.store.deleteDraftIfUnchanged(record.record)
        : await options.store.deleteConflictDraftIfUnchanged(record.record)
      return { record, status: outcome.status }
    } catch {
      return { record, status: 'failed' }
    } finally {
      const next = new Set(activeOperations.value)
      next.delete(id)
      activeOperations.value = next
    }
  }

  function addResult(report: BulkRecoveryDeleteReport, result: RecoveryDeleteResult): void {
    report[result.status].push(result.record)
  }

  async function deleteMany(targets: readonly RecoveryRecordRef[]): Promise<BulkRecoveryDeleteReport> {
    const report = emptyBulkReport()
    for (const record of targets) addResult(report, await conditionalDelete(record))
    const removedIds = [...report.deleted, ...report.missing].map(recoveryRecordId)
    await refresh(vaultId)
    await options.recovery.discover(vaultId)
    options.onRecordsRemoved?.(removedIds)
    return report
  }

  async function deleteRecord(record: RecoveryRecordRef): Promise<RecoveryDeleteResult> {
    const report = await deleteMany([record])
    const status = (['deleted', 'missing', 'stale', 'protected', 'unsupported', 'failed'] as const)
      .find((candidate) => report[candidate].length > 0) ?? 'failed'
    return { record, status }
  }

  function toggleSelected(recoveryId: string): void {
    const next = new Set(selectedIds.value)
    if (next.has(recoveryId)) next.delete(recoveryId)
    else next.add(recoveryId)
    selectedIds.value = next
  }

  function clearSelection(): void {
    selectedIds.value = new Set()
  }

  async function deleteSelected(): Promise<BulkRecoveryDeleteReport> {
    const wanted = selectedIds.value
    const result = await deleteMany(records.value.filter((record) => wanted.has(recoveryRecordId(record))))
    clearSelection()
    return result
  }

  async function deleteAllUnprotected(): Promise<BulkRecoveryDeleteReport> {
    return deleteMany(records.value.filter((record) => !currentProtected(record)))
  }

  function decisions(): Map<string, ClassifiedCleanupDecision> {
    const result = new Map<string, ClassifiedCleanupDecision>()
    for (const item of options.recovery.items.value) {
      const decision: CleanupDecision = item.status === 'ready' && item.decision
        // safe-redundant requires the SAME stable identity: a path
        // reused by another document with an accidentally identical
        // body is an identity-mismatch, never redundant. Mirrors the
        // recovery decision's own identity-mismatch classification.
        ? item.decision.disk.status === 'ready'
          && item.decision.disk.documentId === item.draft.documentId
          && item.draft.content === item.decision.disk.raw
          ? 'safe-redundant'
          : item.decision.kind
        : item.status === 'error'
          ? 'error'
          : null
      // Bind the verdict to the exact classified record: cleanup must
      // never apply it to a different record another context may have
      // written under the same recoveryId (see ClassifiedCleanupDecision).
      if (item.source === 'conflict') {
        const conflict = item.conflict
        if (!conflict) continue
        result.set(item.recoveryId, {
          source: 'conflict', recoveryId: item.recoveryId, expected: conflict, decision,
        })
      } else {
        result.set(item.recoveryId, {
          source: 'primary', recoveryId: item.recoveryId, expected: item.draft, decision,
        })
      }
    }
    return result
  }

  function uniqueRecords(records: readonly RecoveryRecordRef[]): RecoveryRecordRef[] {
    return [...new Map(records.map((record) => [recoveryRecordId(record), record])).values()]
  }

  async function runCleanup(targetVaultId: string): Promise<DraftCleanupReport> {
    await options.recovery.waitForClassification(targetVaultId)
    if (disposed) {
      return {
        status: 'before-scan-failed',
        before: capacitySnapshot([]), after: capacitySnapshot([]),
        deleted: [], stale: [], skippedProtected: [], failed: [],
        unsupportedCount: 0, stillOverCapacity: true,
      }
    }
    const beforeOutcome = await options.store.inspectVaultRecovery(targetVaultId)
    if (beforeOutcome.status === 'failed') {
      const report: DraftCleanupReport = {
        status: 'before-scan-failed',
        before: targetVaultId === vaultId ? capacity.value : capacitySnapshot([]),
        after: targetVaultId === vaultId ? capacity.value : capacitySnapshot([]),
        deleted: [], stale: [], skippedProtected: [], failed: [],
        unsupportedCount: targetVaultId === vaultId ? unsupportedCount.value : 0,
        stillOverCapacity: true,
      }
      if (!disposed && targetVaultId === vaultId) {
        error.value = 'cleanup-before-scan-failed'
        cleanupReport.value = report
      }
      return report
    }
    const beforeInventory = beforeOutcome.inventory
    const beforeRecords = inventoryRecords(beforeInventory)
    const openIds = new Set(options.openRecoveryIds?.value ?? [])
    const identityProtection = new Set(options.getPersistenceProtection(targetVaultId).identityIds)
    for (const id of options.recovery.classifyingIdentityIds.value) identityProtection.add(id)
    for (const id of options.recovery.classifyingRecoveryIds.value) openIds.add(id)
    const plan = planDraftCleanup({
      records: beforeRecords,
      decisions: decisions(),
      protectedRecoveryIds: openIds,
      protectedIdentityIds: identityProtection,
      now: now(),
    })
    const bulk = emptyBulkReport()
    for (const record of plan.candidates) addResult(bulk, await conditionalDelete(record))
    const removedIds = [...bulk.deleted, ...bulk.missing].map(recoveryRecordId)
    const afterOutcome = await options.store.inspectVaultRecovery(targetVaultId)
    const afterInventory = afterOutcome.status === 'ok' ? afterOutcome.inventory : beforeInventory
    const afterRecords = inventoryRecords(afterInventory)
    const report: DraftCleanupReport = {
      status: afterOutcome.status === 'ok' ? 'completed' : 'after-scan-failed',
      before: plan.before,
      after: capacitySnapshot(afterRecords),
      deleted: bulk.deleted,
      stale: bulk.stale,
      skippedProtected: uniqueRecords([...plan.skippedProtected, ...bulk.protected]),
      unsupportedCount: afterInventory.unsupportedPrimaryCount
        + afterInventory.unsupportedConflictCount,
      failed: bulk.failed,
      stillOverCapacity: afterOutcome.status === 'ok'
        ? capacitySnapshot(afterRecords).overCapacity
        : true,
    }
    if (!disposed && targetVaultId === vaultId) {
      if (afterOutcome.status === 'ok') applyInventory(afterInventory)
      else error.value = 'cleanup-after-scan-failed'
      cleanupReport.value = report
      if (removedIds.length > 0) {
        if (afterOutcome.status === 'ok') await options.recovery.discover(targetVaultId)
        else options.recovery.removeRecoveryIds(removedIds)
        options.onRecordsRemoved?.(removedIds)
      }
    }
    return report
  }

  function cleanupNow(): Promise<DraftCleanupReport> {
    cleanupTargetVault = vaultId
    if (cleanupPromise) {
      cleanupRequested = true
      return cleanupPromise
    }
    cleanupPromise = (async () => {
      let aggregate: DraftCleanupReport | null = null
      let aggregateVault = ''
      do {
        cleanupRequested = false
        const passVault = cleanupTargetVault
        const pass = await runCleanup(passVault)
        aggregate = aggregate === null || aggregateVault !== passVault ? pass : {
          ...pass,
          before: aggregate.before,
          deleted: [...aggregate.deleted, ...pass.deleted],
          stale: [...aggregate.stale, ...pass.stale],
          skippedProtected: [...aggregate.skippedProtected, ...pass.skippedProtected],
          failed: [...aggregate.failed, ...pass.failed],
        }
        aggregateVault = passVault
      } while (cleanupRequested && !disposed)
      return aggregate!
    })().finally(() => {
      cleanupPromise = null
    })
    return cleanupPromise
  }

  function dispose(): void {
    disposed = true
    generation++
  }

  return {
    records: readonly(records),
    capacity: readonly(capacity),
    unsupportedCount: readonly(unsupportedCount),
    loading: readonly(loading),
    error: readonly(error),
    selectedIds: readonly(selectedIds),
    protectedIds,
    cleanupReport: readonly(cleanupReport),
    refresh,
    toggleSelected,
    clearSelection,
    deleteRecord,
    deleteSelected,
    deleteAllUnprotected,
    cleanupNow,
    dispose,
  }
}

import {
  conflictDraftsEqual,
  draftsEqual,
  type DraftConflictRecord,
  type UnsavedDraft,
} from './draftTypes'
import type { DraftRecoveryDecisionKind } from './draftRecoveryDecision'

export const MAX_DRAFT_CONTENT_BYTES = 2 * 1024 * 1024
export const MAX_VAULT_RECOVERY_RECORDS = 100
export const MAX_VAULT_RECOVERY_CONTENT_BYTES = 20 * 1024 * 1024
export const ORPHAN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

export type RecoveryRecordRef =
  | { source: 'primary'; record: UnsavedDraft; bytes: number }
  | { source: 'conflict'; record: DraftConflictRecord; bytes: number }

export interface DraftCapacitySnapshot {
  recordCount: number
  contentBytes: number
  recordLimit: number
  contentByteLimit: number
  overCapacity: boolean
}

export interface DraftCleanupPlan {
  before: DraftCapacitySnapshot
  candidates: RecoveryRecordRef[]
  retentionCandidates: RecoveryRecordRef[]
  capacityCandidates: RecoveryRecordRef[]
  skippedProtected: RecoveryRecordRef[]
  stillOverCapacity: boolean
}

export function draftContentBytes(content: string): number {
  return new TextEncoder().encode(content).byteLength
}

export function primaryRecoveryRecord(record: UnsavedDraft): RecoveryRecordRef {
  return { source: 'primary', record, bytes: draftContentBytes(record.content) }
}

export function conflictRecoveryRecord(record: DraftConflictRecord): RecoveryRecordRef {
  return { source: 'conflict', record, bytes: draftContentBytes(record.content) }
}

export function recoveryRecordId(value: RecoveryRecordRef): string {
  return value.source === 'primary'
    ? JSON.stringify([value.record.vaultId, value.record.documentId])
    : JSON.stringify([
        value.record.vaultId,
        value.record.documentId,
        'conflict',
        value.record.conflictId,
      ])
}

export function recoveryIdentityId(value: RecoveryRecordRef): string {
  return JSON.stringify([value.record.vaultId, value.record.documentId])
}

export function compareRecoveryOldestFirst(
  left: RecoveryRecordRef,
  right: RecoveryRecordRef,
): number {
  return left.record.updatedAt - right.record.updatedAt
    || left.record.createdAt - right.record.createdAt
    || (left.source === right.source ? 0 : left.source === 'conflict' ? -1 : 1)
    || left.record.documentId.localeCompare(right.record.documentId)
    || (left.source === 'conflict' ? left.record.conflictId : '')
      .localeCompare(right.source === 'conflict' ? right.record.conflictId : '')
}

export function compareRecoveryNewestFirst(
  left: RecoveryRecordRef,
  right: RecoveryRecordRef,
): number {
  return compareRecoveryOldestFirst(right, left)
}

export function capacitySnapshot(records: readonly RecoveryRecordRef[]): DraftCapacitySnapshot {
  const contentBytes = records.reduce((sum, item) => sum + item.bytes, 0)
  return {
    recordCount: records.length,
    contentBytes,
    recordLimit: MAX_VAULT_RECOVERY_RECORDS,
    contentByteLimit: MAX_VAULT_RECOVERY_CONTENT_BYTES,
    overCapacity: records.length > MAX_VAULT_RECOVERY_RECORDS
      || contentBytes > MAX_VAULT_RECOVERY_CONTENT_BYTES,
  }
}

/** The cleanup verdict the planner routes on: a recovery classification
 *  kind, plus the cleanup-only verdicts — `safe-redundant` (the record's
 *  body is already byte-identical to disk under the SAME stable
 *  identity), `error` (classification failed) and `null` (still
 *  unresolved). None of `error` / `null` / the non-redundant kinds ever
 *  selects a record for automatic deletion on its own. */
export type CleanupDecision =
  | DraftRecoveryDecisionKind
  | 'error'
  | 'safe-redundant'
  | null

/** A cleanup decision bound to the EXACT recovery record the
 *  classification certified. Cleanup plans from a fresh Store inventory
 *  and must never apply a decision to a record the classification never
 *  saw: a recoveryId carries only vaultId + documentId (plus conflictId
 *  for candidates) — no version, body or timestamp marker — so another
 *  context can replace the family's record under the SAME recoveryId
 *  between classification and cleanup. The conditional Store delete
 *  cannot catch that: it would match the replacement exactly and delete
 *  it. The planner therefore acts on the decision ONLY while the fresh
 *  inventory record still equals `expected` (full `draftsEqual` for
 *  primary records, full `conflictDraftsEqual` for conflict candidates);
 *  a replaced record degrades to "no decision" and stays until a fresh
 *  classification certifies it. */
export type ClassifiedCleanupDecision =
  | {
      source: 'primary'
      recoveryId: string
      expected: UnsavedDraft
      decision: CleanupDecision
    }
  | {
      source: 'conflict'
      recoveryId: string
      expected: DraftConflictRecord
      decision: CleanupDecision
    }

export interface PlanDraftCleanupInput {
  records: readonly RecoveryRecordRef[]
  decisions?: ReadonlyMap<string, ClassifiedCleanupDecision>
  protectedRecoveryIds?: ReadonlySet<string>
  protectedIdentityIds?: ReadonlySet<string>
  now: number
}

/** The verdict a cleanup plan may act on for one fresh inventory
 *  record: the classified decision, but ONLY while the record still
 *  equals the exact record the classification certified (see
 *  ClassifiedCleanupDecision). A record another context replaced under
 *  the same recoveryId since classification has no certified verdict —
 *  `undefined`, never an inherited stale one — and the planner keeps
 *  it. */
function certifiedDecision(
  record: RecoveryRecordRef,
  decisions: ReadonlyMap<string, ClassifiedCleanupDecision> | undefined,
): CleanupDecision | undefined {
  const classified = decisions?.get(recoveryRecordId(record))
  if (!classified) return undefined
  if (record.source === 'primary' && classified.source === 'primary') {
    return draftsEqual(record.record, classified.expected)
      ? classified.decision
      : undefined
  }
  if (record.source === 'conflict' && classified.source === 'conflict') {
    return conflictDraftsEqual(record.record, classified.expected)
      ? classified.decision
      : undefined
  }
  return undefined
}

export function planDraftCleanup(input: PlanDraftCleanupInput): DraftCleanupPlan {
  const records = [...input.records].sort(compareRecoveryOldestFirst)
  const before = capacitySnapshot(records)
  const isProtected = (record: RecoveryRecordRef): boolean => (
    input.protectedRecoveryIds?.has(recoveryRecordId(record)) === true
    || input.protectedIdentityIds?.has(recoveryIdentityId(record)) === true
  )
  const skippedProtected = records.filter(isProtected)
  const retentionCandidates = records.filter((record) => {
    if (isProtected(record)) return false
    const decision = certifiedDecision(record, input.decisions)
    return decision === 'safe-redundant'
      || ((decision === 'missing-source' || decision === 'identity-mismatch')
        && input.now - record.record.updatedAt > ORPHAN_RETENTION_MS)
  })
  const selected = new Set(retentionCandidates.map(recoveryRecordId))
  const remaining = records.filter((record) => !selected.has(recoveryRecordId(record)))
  let remainingCount = remaining.length
  let remainingBytes = remaining.reduce((sum, record) => sum + record.bytes, 0)
  // Capacity is deliberately a soft limit. Records with unique or
  // unclassified bytes (divergent/conflict/unknown/error) are never
  // evicted merely because they are old. Only records independently
  // proven redundant or expired-orphaned above are automatic candidates.
  const capacityCandidates: RecoveryRecordRef[] = []
  return {
    before,
    candidates: [...retentionCandidates, ...capacityCandidates],
    retentionCandidates,
    capacityCandidates,
    skippedProtected,
    stillOverCapacity: remainingCount > MAX_VAULT_RECOVERY_RECORDS
      || remainingBytes > MAX_VAULT_RECOVERY_CONTENT_BYTES,
  }
}

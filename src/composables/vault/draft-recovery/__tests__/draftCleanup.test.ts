import { describe, expect, it } from 'vitest'
import {
  MAX_DRAFT_CONTENT_BYTES,
  MAX_VAULT_RECOVERY_RECORDS,
  ORPHAN_RETENTION_MS,
  conflictRecoveryRecord,
  draftContentBytes,
  planDraftCleanup,
  primaryRecoveryRecord,
  recoveryIdentityId,
  recoveryRecordId,
  type ClassifiedCleanupDecision,
  type CleanupDecision,
  type RecoveryRecordRef,
} from '../draftCleanup'
import type { DraftConflictRecord, UnsavedDraft } from '../draftTypes'

function draft(id: string, updatedAt: number, content = id): UnsavedDraft {
  return {
    version: 1, vaultId: 'vault', documentId: id, documentPath: `notes/${id}`,
    content, baseContentHash: null, baseModifiedAt: null,
    createdAt: updatedAt, updatedAt,
  }
}

function conflict(id: string, updatedAt: number): DraftConflictRecord {
  return {
    ...draft(id, updatedAt), conflictId: `c-${id}`, origin: 'delete-conflict',
    crossContextUpdatedAt: null, recordedAt: updatedAt,
  }
}

function classified(
  record: RecoveryRecordRef,
  decision: CleanupDecision,
): [string, ClassifiedCleanupDecision] {
  const recoveryId = recoveryRecordId(record)
  return [
    recoveryId,
    record.source === 'primary'
      ? { source: 'primary', recoveryId, expected: record.record, decision }
      : { source: 'conflict', recoveryId, expected: record.record, decision },
  ]
}

describe('draft cleanup policy', () => {
  it('measures UTF-8 bytes and preserves the exact 2 MiB boundary', () => {
    expect(draftContentBytes('abc')).toBe(3)
    expect(draftContentBytes('草稿')).toBe(6)
    expect(draftContentBytes('a'.repeat(MAX_DRAFT_CONTENT_BYTES))).toBe(MAX_DRAFT_CONTENT_BYTES)
  })

  it('expires only missing or identity-mismatch records older than 30 days', () => {
    const now = ORPHAN_RETENTION_MS + 100
    const expired = primaryRecoveryRecord(draft('expired', 99))
    const boundary = primaryRecoveryRecord(draft('boundary', 100))
    const unknown = primaryRecoveryRecord(draft('unknown', 0))
    const decisions = new Map([
      classified(expired, 'missing-source'),
      classified(boundary, 'identity-mismatch'),
      classified(unknown, 'unknown'),
    ])
    const plan = planDraftCleanup({ records: [boundary, unknown, expired], decisions, now })
    expect(plan.retentionCandidates.map(recoveryRecordId)).toEqual([recoveryRecordId(expired)])
  })

  it('counts primary and conflicts but treats capacity as a soft limit', () => {
    const records = [
      primaryRecoveryRecord(draft('same', 1)),
      conflictRecoveryRecord(conflict('same', 1)),
      ...Array.from({ length: MAX_VAULT_RECOVERY_RECORDS }, (_, index) => (
        primaryRecoveryRecord(draft(`d-${index}`, index + 2))
      )),
    ]
    const plan = planDraftCleanup({ records, now: 0 })
    expect(plan.before.recordCount).toBe(102)
    expect(plan.capacityCandidates).toEqual([])
    expect(plan.stillOverCapacity).toBe(true)
  })

  it('deduplicates retention and capacity candidates', () => {
    const records = Array.from({ length: 101 }, (_, index) => (
      primaryRecoveryRecord(draft(`d-${index}`, index))
    ))
    const decisions = new Map([classified(records[0]!, 'missing-source')])
    const plan = planDraftCleanup({ records, decisions, now: ORPHAN_RETENTION_MS + 1 })
    expect(new Set(plan.candidates.map(recoveryRecordId)).size).toBe(plan.candidates.length)
  })

  it('never selects protected identities and reports unresolved capacity', () => {
    const records = Array.from({ length: 101 }, (_, index) => (
      primaryRecoveryRecord(draft(`d-${index}`, index))
    ))
    const identities = new Set(records.map(recoveryIdentityId))
    const plan = planDraftCleanup({ records, protectedIdentityIds: identities, now: 0 })
    expect(plan.candidates).toEqual([])
    expect(plan.skippedProtected).toHaveLength(101)
    expect(plan.stillOverCapacity).toBe(true)
  })

  it('cleans only records independently classified as redundant', () => {
    const redundant = primaryRecoveryRecord(draft('redundant', 1))
    const divergent = primaryRecoveryRecord(draft('divergent', 0))
    const plan = planDraftCleanup({
      records: [divergent, redundant],
      decisions: new Map([
        classified(redundant, 'safe-redundant'),
        classified(divergent, 'divergent'),
      ]),
      now: 2,
    })
    expect(plan.candidates.map(recoveryRecordId)).toEqual([recoveryRecordId(redundant)])
  })

  it('ignores a decision once the classified record was replaced under the same recoveryId', () => {
    // The classification certified these exact records...
    const certifiedPrimary = primaryRecoveryRecord(draft('doc', 1, 'disk content'))
    const certifiedConflict = conflictRecoveryRecord(conflict('doc', 1))
    // ...but another context has since replaced both families' records
    // under the SAME recoveryId: newer updatedAt + new body for the
    // primary, a fresh candidate body for the conflict.
    const replacedPrimary = primaryRecoveryRecord(draft('doc', 2, 'new unsaved content'))
    const replacedConflict = conflictRecoveryRecord({
      ...conflict('doc', 1), content: 'fresh candidate', recordedAt: 2,
    })
    const expiredButReplaced = primaryRecoveryRecord(draft('orphan', 0, 'old'))
    // Positive control: a decision still matching its record applies.
    const stillRedundant = primaryRecoveryRecord(draft('redundant', 1))

    const plan = planDraftCleanup({
      records: [replacedPrimary, replacedConflict, expiredButReplaced, stillRedundant],
      decisions: new Map([
        classified(certifiedPrimary, 'safe-redundant'),
        classified(certifiedConflict, 'safe-redundant'),
        // A stale missing-source verdict on an expired orphan must not
        // reach the replacement record either, even past the 30-day
        // retention window — the replacement was never classified.
        classified(primaryRecoveryRecord(draft('orphan', 0, 'gone')), 'missing-source'),
        classified(stillRedundant, 'safe-redundant'),
      ]),
      now: ORPHAN_RETENTION_MS + 100,
    })

    expect(plan.candidates.map(recoveryRecordId))
      .toEqual([recoveryRecordId(stillRedundant)])
  })
})

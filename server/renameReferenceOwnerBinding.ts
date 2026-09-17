import path from 'node:path'

import { promises as fs } from 'node:fs'

import {
  rewriteDurableJournal,
} from './atomicTextWrite.js'
import {
  parseRenameReferenceJournalObject,
  type RenameReferenceJournalEntry,
} from './renameReferenceJournal.js'
import { isPhysicallyContained } from './documentFileLifecycle.js'
import { parseFolderMoveJournalV4Object } from './folderMoveV4DurableJournal.js'
import { validateRound17SnapshotRestoreDisposition } from './folderMoveTransaction.js'
import { recoveryMarkerToken } from './technicalNamespace.js'

export type RenameReferenceOwnerDisposition =
  | { kind: 'legacy-prefix-move' }
  | { kind: 'folder-snapshot-owned', ownerJournal: string, ownerTransactionId: string, ownerDescriptorHash: string, metadataHandled: boolean }
  | {
    kind: 'folder-snapshot-owner-pending',
    ownerJournal: string,
    ownerTransactionId: string,
    ownerDescriptorHash: string,
    previousDirection: 'roll-forward' | 'roll-back',
  }
  | {
    kind: 'folder-snapshot-owner-aborted',
    ownerJournal: string,
    ownerTransactionId: string,
    ownerDescriptorHash: string,
    previousDirection: 'roll-forward' | 'roll-back',
    reason: 'owner-journal-absent',
  }

export type FolderRaceOwnerHooks = {
  afterBindOwnerPending?: () => void | Promise<void>
  afterV4OwnerJournalDurable?: () => void | Promise<void>
  afterOwnerDurableMark?: () => void | Promise<void>
}
let __ownerRaceHooks: FolderRaceOwnerHooks | null = null
export function __setFolderMoveOwnerRaceHooksForTesting(hooks: FolderRaceOwnerHooks | null): void {
  __ownerRaceHooks = hooks
}

/**
 * Step one of the P0-1 owner binding protocol: rewrite the companion
 * journal as folder-snapshot-owner-pending BEFORE the durable v4 owner
 * folder journal is written. This produces a durable "started but not
 * yet committed" state that recovery can reconcile on startup.
 *
 * On a crash between bindOwnerPending and the v4 owner folder journal
 * rewrite, the companion remains owner-pending and recovery must NOT
 * silently defer it — recovery must either promote the owner binding
 * (if the v4 journal is on disk and matches) or quarantine it (if the
 * v4 journal is missing or mismatched).
 */
export type RenameReferenceOwnerEntryShape = RenameReferenceJournalEntry & {
  phase: RenameReferenceJournalEntry['phase']
  metadataDisposition?: never
}

export async function bindOwnerPending(input: {
  journalPath: string
  phase: RenameReferenceJournalEntry['phase']
  baseEntry: RenameReferenceJournalEntry
  descriptorHash: string
  owner: { ownerJournal: string, ownerTransactionId: string }
}): Promise<void> {
  const disposition: RenameReferenceOwnerDisposition = {
    kind: 'folder-snapshot-owner-pending',
    ownerJournal: input.owner.ownerJournal,
    ownerTransactionId: input.owner.ownerTransactionId,
    ownerDescriptorHash: input.descriptorHash,
    previousDirection: input.phase === 'roll-back' ? 'roll-back' : 'roll-forward',
  }
  await rewriteDurableJournal(input.journalPath, {
    ...input.baseEntry,
    phase: input.phase,
    metadataDisposition: disposition,
  })
  if (__ownerRaceHooks?.afterBindOwnerPending) {
    await __ownerRaceHooks.afterBindOwnerPending()
  }
}

/**
 * Step three of the P0-1 owner binding protocol: rewrite the companion
 * journal as folder-snapshot-owned / metadataHandled=false AFTER the
 * durable v4 owner folder journal is on disk and validated.
 */
export async function markOwnerDurable(input: {
  journalPath: string
  phase: RenameReferenceJournalEntry['phase']
  baseEntry: RenameReferenceJournalEntry
  owner: { ownerJournal: string, ownerTransactionId: string }
  descriptorHash: string
}): Promise<void> {
  await rewriteDurableJournal(input.journalPath, {
    ...input.baseEntry,
    phase: input.phase,
    metadataDisposition: {
      kind: 'folder-snapshot-owned',
      ownerJournal: input.owner.ownerJournal,
      ownerTransactionId: input.owner.ownerTransactionId,
      ownerDescriptorHash: input.descriptorHash,
      metadataHandled: false,
    },
  })
  if (__ownerRaceHooks?.afterOwnerDurableMark) {
    await __ownerRaceHooks.afterOwnerDurableMark()
  }
}

/**
 * Step four: when the rename handoff is complete, mark handled (the
 * equivalent of markRenameReferenceMetadataHandled, but uses the
 * unified P0-1 state machine).
 */
export async function markOwnerHandled(input: {
  journalPath: string
  owner: { ownerJournal: string, ownerTransactionId: string, ownerDescriptorHash: string }
}): Promise<boolean> {
  const raw = await fs.readFile(input.journalPath, 'utf8')
  const parsed = parseRenameReferenceJournalObject(JSON.parse(raw))
  if (!parsed
    || parsed.metadataDisposition?.kind !== 'folder-snapshot-owned'
    || parsed.metadataDisposition.ownerJournal !== input.owner.ownerJournal
    || parsed.metadataDisposition.ownerTransactionId !== input.owner.ownerTransactionId
    || parsed.metadataDisposition.ownerDescriptorHash !== input.owner.ownerDescriptorHash) {
    return false
  }
  if (parsed.metadataDisposition.metadataHandled) return true
  await rewriteDurableJournal(input.journalPath, {
    ...parsed,
    metadataDisposition: { ...parsed.metadataDisposition, metadataHandled: true },
  })
  return true
}

export type ReconcilePendingResult =
  | { action: 'promote', reason: 'owner journal matches' }
  | { action: 'abort', reason: string }
  | { action: 'quarantine', reason: string }
  | { action: 'no-action', reason: string }

/**
 * Reconcile a companion journal whose metadataDisposition is
 * folder-snapshot-owner-pending. This runs at the START of
 * recoverRenameReferencesJournal — before the
 * metadataHandled:false early return — so the companion can either be
 * promoted to folder-snapshot-owned (if the v4 owner folder journal is
 * on disk and matches) or quarantined (if the v4 journal is absent or
 * mismatched). Either way, recovery advances the companion and never
 * silently defers it.
 */
export async function reconcilePendingRenameReferenceOwner(input: {
  contentDir: string
  journalPath: string
  entry: RenameReferenceJournalEntry
  transactionId: string
  ownerDescriptorHash: string
}): Promise<ReconcilePendingResult> {
  const disposition = input.entry.metadataDisposition
  if (disposition?.kind !== 'folder-snapshot-owner-pending') {
    return { action: 'no-action', reason: 'not in owner-pending state' }
  }
  const ownerJournalRel = disposition.ownerJournal
  const ownerJournalAbs = path.join(path.dirname(input.journalPath), ownerJournalRel)
  try {
    if (!await isPhysicallyContained(input.contentDir, ownerJournalAbs)) {
      return {
        action: 'quarantine',
        reason: `companion owner-binding pending and owner journal escapes the vault: ${ownerJournalRel}`,
      }
    }
    const ownerStat = await fs.lstat(ownerJournalAbs, { bigint: true })
    if (!ownerStat.isFile() || ownerStat.isSymbolicLink()) {
      return {
        action: 'quarantine',
        reason: `companion owner-binding pending and owner journal is not a real file: ${ownerJournalRel}`,
      }
    }
  } catch {
    // The owner folder journal is absent. Durably leave the pending
    // state, restore the independent reference direction, and record a
    // terminal fail-closed disposition. The terminal marker keeps later
    // startups from replaying references or prefix metadata without the
    // owner-backed snapshot decision.
    await rewriteDurableJournal(input.journalPath, {
      ...input.entry,
      phase: disposition.previousDirection,
      metadataDisposition: {
        kind: 'folder-snapshot-owner-aborted',
        ownerJournal: disposition.ownerJournal,
        ownerTransactionId: disposition.ownerTransactionId,
        ownerDescriptorHash: disposition.ownerDescriptorHash,
        previousDirection: disposition.previousDirection,
        reason: 'owner-journal-absent',
      },
    })
    return {
      action: 'abort',
      reason: 'rename-reference owner-binding aborted because owner folder journal is absent',
    }
  }
  // Owner folder journal exists: validate that the journal entry binds
  // to the exact transactionId and descriptorHash the companion claims.
  let ownerEntry: unknown
  try {
    ownerEntry = JSON.parse(await fs.readFile(ownerJournalAbs, 'utf8'))
  } catch {
    return {
      action: 'quarantine',
      reason: 'rename-reference owner-binding pending and owner folder journal is unreadable',
    }
  }
  const ownerJournal = parseFolderMoveJournalV4Object(ownerEntry)
  if (!ownerJournal) {
    return {
      action: 'quarantine',
      reason: 'rename-reference owner-binding pending and owner folder journal is unreadable',
    }
  }
  const ownerFileTransactionId = recoveryMarkerToken(path.basename(ownerJournalAbs), 'journal')
  if (ownerFileTransactionId !== disposition.ownerTransactionId) {
    return {
      action: 'quarantine',
      reason: 'rename-reference owner-binding transactionId mismatch',
    }
  }
  // The companion owner descriptorHash must match the descriptor hash
  // built from the companion's own stable descriptor; if the v4 owner
  // folder journal carries a different hash it cannot be the same
  // transaction (a malicious journal cannot bind to the companion).
  if (disposition.ownerDescriptorHash !== input.ownerDescriptorHash) {
    return {
      action: 'quarantine',
      reason: 'rename-reference owner-binding descriptorHash mismatch',
    }
  }
  if (ownerJournal.srcRel !== input.entry.destRel
    || ownerJournal.destRel !== input.entry.srcRel
    || ownerJournal.metadataDisposition.kind !== 'snapshot-restore') {
    return {
      action: 'quarantine',
      reason: 'rename-reference owner-binding folder direction mismatch',
    }
  }
  const referenceProof = ownerJournal.metadataDisposition.referenceJournal
  if (!referenceProof
    || referenceProof.relativePath !== path.basename(input.journalPath)
    || referenceProof.operation !== 'folder-rename-references'
    || referenceProof.transactionId !== input.transactionId
    || referenceProof.journalHash !== input.ownerDescriptorHash
    || referenceProof.srcRel !== input.entry.srcRel
    || referenceProof.destRel !== input.entry.destRel) {
    return {
      action: 'quarantine',
      reason: 'rename-reference owner-binding companion proof mismatch',
    }
  }
  const promotedDisposition = {
    kind: 'folder-snapshot-owned' as const,
    ownerJournal: disposition.ownerJournal,
    ownerTransactionId: disposition.ownerTransactionId,
    ownerDescriptorHash: disposition.ownerDescriptorHash,
    metadataHandled: false,
  }
  const ownerValidation = validateRound17SnapshotRestoreDisposition(
    ownerJournal,
    ownerJournal.metadataDisposition,
    {
      referenceJournal: {
        ...input.entry,
        op: 'folder-rename-references',
        identities: input.entry.identities ?? [],
        transactionId: input.transactionId,
        descriptorHash: input.ownerDescriptorHash,
        metadataDisposition: promotedDisposition,
      },
      ownerJournal: disposition.ownerJournal,
      ownerTransactionId: disposition.ownerTransactionId,
    },
  )
  if (ownerValidation !== null) {
    return {
      action: 'quarantine',
      reason: `rename-reference owner-binding owner proof mismatch: ${ownerValidation}`,
    }
  }
  // All checks pass: promote to folder-snapshot-owned (metadataHandled=false).
  // Recovery will continue; if the owner journal completes its handoff,
  // the companion is consumed; otherwise it remains a pinned dependent.
  await rewriteDurableJournal(input.journalPath, {
    ...input.entry,
    metadataDisposition: promotedDisposition,
  })
  return { action: 'promote', reason: 'owner journal matches' }
}

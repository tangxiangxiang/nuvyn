import { hashDraftBaseline } from './draftHash'
import { createDraftStore, type DraftStore } from './draftStore'
import {
  UNSAVED_DRAFT_VERSION,
  draftsEqual,
  isUnsavedDraft,
  type DraftConflictRecord,
  type DraftConflictSource,
  type UnsavedDraft,
} from './draftTypes'
import type {
  DraftDeleteRequest,
  DraftDeleteConfirmation,
  DraftDocumentIdentity,
  DraftFileMutationBarrier,
  DraftFileTransactionResult,
  DraftPathMapping,
} from './useDraftFileTransactions'
import { MAX_DRAFT_CONTENT_BYTES, draftContentBytes } from './draftCleanup'
import { isManagedDiaryPath } from '../../../../shared/diaryProtocol'

export const DRAFT_PERSIST_DEBOUNCE_MS = 800

/** Backoff schedule for the automatic retry armed after a family move
 *  settles without persisting the latest snapshot (a
 *  'moved-write-failed' settlement). Bounded to three attempts
 *  (800ms, 2s, 5s — ~7.8s total): a persistently failing store must
 *  not keep a high-frequency retry loop alive forever — once the
 *  budget is spent, the write flag stays set and user input, manual
 *  flush and pagehide each retry the channel from scratch (each such
 *  retry re-resolves the target through the mode state machine and
 *  can re-arm this budget if it still fails. The initial failure and
 *  final exhausted attempt publish warnings; intermediate automatic
 *  attempts stay quiet. A new user edit resets the backoff: schedule() clears
 *  the armed retry timer and the edit's own write owns persistence. */
const SETTLE_RETRY_DELAYS_MS = [800, 2_000, 5_000] as const

export interface DraftBufferSnapshot {
  vaultId: string
  documentId: string
  documentPath: string
  content: string
  authoritativeContent: string
  baseContentHash: string | null
  baseModifiedAt: number | null
  revision: number
  loaded?: boolean
}

export interface DraftOwner {
  vaultId: string
  documentId: string
  generation: number
}

export interface UnsavedDraftPersistence {
  schedule(snapshot: DraftBufferSnapshot): DraftOwner | null
  flush(vaultId: string, documentId: string): Promise<boolean>
  /** Flush every live persistence channel and report whether all channels
   *  reached a durable state. */
  flushAll(): Promise<boolean>
  /** Read-only transition probe; it never mutates the Draft Store. */
  hasPendingWrites(): boolean
  markClean(owner: DraftOwner, acknowledgedRevision: number): Promise<void>
  returnedToBaseline(vaultId: string, documentId: string): Promise<void>
  discard(owner: DraftOwner): Promise<boolean>
  discardIdentity(vaultId: string, documentId: string): Promise<boolean>
  discardIdentityIfUnchanged(expected: UnsavedDraft): Promise<boolean>
  discardConflict(
    vaultId: string,
    documentId: string,
    conflictId: string,
  ): Promise<boolean>
  adoptRecoveredDraft(
    expected: UnsavedDraft,
    snapshot: DraftBufferSnapshot,
  ): Promise<DraftOwner | null>
  prepareFileMutation(
    identities: readonly DraftDocumentIdentity[],
  ): Promise<DraftFileMutationBarrier>
  captureDeleteConfirmation(
    identity: DraftDocumentIdentity,
    revision: number,
    expectedDraft?: UnsavedDraft | null,
    expectedConflictIds?: readonly string[],
  ): DraftDeleteConfirmation
  findTrackedIdentitiesByPaths(
    paths: readonly string[],
  ): DraftDocumentIdentity[]
  getDraftCleanupProtection(vaultId: string): DraftCleanupProtection
  invalidateOwner(owner: DraftOwner): void
  invalidate(vaultId: string, documentId: string): void
  /** Synchronously fence and clear all in-memory managed-Diary draft state.
   *  Existing durable records are intentionally left untouched for the
   *  explicit D8.4 cleanup/migration owner. */
  clearSensitiveState(): void
  dispose(): Promise<void>
}

export interface DraftCleanupProtection {
  identityIds: ReadonlySet<string>
}

export type DraftPersistenceIssue =
  | {
      kind: 'draft-too-large'
      vaultId: string
      documentId: string
      bytes: number
      limit: number
    }
  | {
      kind: 'storage-write-failed'
      vaultId: string
      documentId: string
      revision: number
    }

interface DraftEntry {
  vaultId: string
  documentId: string
  releaseWhenInactive: boolean
  generation: number
  timer: ReturnType<typeof setTimeout> | null
  latestSnapshot: DraftBufferSnapshot | null
  latestSnapshotNeedsWrite: boolean
  pendingWrite: Promise<boolean> | null
  previousUpdatedAt: number
  createdAt: number | null
  persistedDraft: UnsavedDraft | null
  fileTransaction: symbol | null
  /** The persistence channel state machine — the single source of
   *  truth for WHERE the entry's next write must land (see
   *  resolveDraftWriteTarget) and HOW the draft family relates to the
   *  tab's path. Converges the former `pendingConflictId` /
   *  `conflictCrossContextUpdatedAt` / `conflictDocumentPath` /
   *  `pendingFamilyMove` fields: every transition goes through
   *  `enterPrimaryMode` / `enterConflictMode` / `enterMoveQuarantine`
   *  / `completeFamilyMove` / `markFamilyIndeterminate` /
   *  `adoptCertifiedFamilyPath`, so the family path, the conflict pin
   *  and the quarantine state update as ONE change and can never
   *  drift apart (a conflict pin landing mid-quarantine keeps the
   *  quarantine; a verified family move switches the snapshot path,
   *  the persistedDraft path AND the channel pin in a single
   *  transition). */
  mode: DraftPersistenceMode
  /** Bytes may already be durable while their path is still awaiting
   *  post-write authentication against the server's stable identity. */
  emptyFamilyRecovery: {
    move: { oldPath: string | null; newPath: string }
    anchorPath: string | null
  } | null
  /** Current automatic settlement retry attempt. Null means no
   *  scheduler-owned budget is active. */
  settleRetryAttempt: number | null
}

/** The persistence channel state machine (DraftEntry.mode).
 *  - `primary` — the normal channel: writes persist the primary
 *    record at the snapshot's own path. The family path is whatever
 *    persistedDraft / latestSnapshot say — the mode deliberately
 *    carries no path state of its own to drift out of sync.
 *  - `conflict` — the local snapshot has been promoted to a separate
 *    conflict record (stale / conflict / path-mismatch save, delete
 *    handoff, unsupported save with an agreed family path): new edits
 *    must persist as conflict candidates at `familyPath` — never the
 *    primary record (a fresh `safeTimestamp()` would overwrite the
 *    cross-context record), never the snapshot's possibly-stale path
 *    (candidates there would split the family the channel exists to
 *    keep whole). `conflictId` is the newest candidate's id (`failed:`
 *    prefix when the save was rejected — the channel stays pinned so
 *    retries never fall back to a primary overwrite);
 *    `crossContextUpdatedAt` is the source the channel diverged from
 *    (null for unsupported families the store couldn't describe).
 *  - `move-quarantine` — the server rename succeeded but the draft
 *    family move came back incomplete (`failed` / `unsupported` /
 *    `conflict`) during commitMoves, or the lifecycle resolved an
 *    identity-mismatch against the server's ACTUAL target path: the
 *    family (primary record + every candidate) stays whole at
 *    `familyPath` — the family's ACTUAL path, a chained rename A→B→C
 *    that failed twice keeps it at A — while the tab already shows
 *    `serverPath` (the server truth). An edit on any path other than
 *    `familyPath` retries the atomic family move FIRST; while the
 *    retry keeps failing, the latest content persists as a candidate
 *    at `familyPath` — never at the server path (a plain write there
 *    would move the primary alone and strand the candidates —
 *    DraftStore accepts the higher-`updatedAt` draft's path
 *    wholesale). `conflict` carries a coexisting conflict pin: a
 *    handoff landing mid-quarantine must not lose the quarantine, and
 *    a healed move carries the pin to the new path. The store-level
 *    family-aware save is the stateless backstop for the same
 *    invariant across page reloads (this mode is in-memory only).
 *  - `indeterminate` — an unsupported save with NO certifiable family
 *    path (the store's raw rows split, or no readable path): there is
 *    nowhere safe to write. Writes are blocked — fail closed, keep
 *    the write flag set, keep the tab open as the only surface
 *    holding the bytes — until the next user edit re-probes:
 *    schedule() sets `reprobePending` (NOT a primary-mode flip — the
 *    family is still unverified, and treating the snapshot path as
 *    the family path would guess), and the next debounce runs one
 *    real store probe; a successful probe transitions out, a failed
 *    one clears `reprobePending` and blocks again.
 *  - `move-indeterminate` — the server rename succeeded but the
 *    family was ALREADY uncertifiable when the move was attempted
 *    (the entry was indeterminate, or turned indeterminate while
 *    quarantined): the family has NO certified path — unlike
 *    move-quarantine, which knows its familyPath. The entry keeps
 *    retrying the atomic family move toward `serverPath` (the only
 *    path the server certifies); while the retry keeps failing it
 *    writes NOTHING — no candidate at the rename's fromPath (a
 *    guess), none at the tab path. Fail closed: write flag stays
 *    set, close seal returns 'failed', the tab stays open, and the
 *    next user edit / flush retries the move — a healed family
 *    completes the move to `serverPath` and persists there. */
type DraftPersistenceMode =
  | { kind: 'primary' }
  | {
      kind: 'conflict'
      familyPath: string
      conflictId: string
      crossContextUpdatedAt: number | null
    }
  | {
      kind: 'move-quarantine'
      familyPath: string
      serverPath: string
      conflict: { conflictId: string; crossContextUpdatedAt: number | null } | null
    }
  | {
      kind: 'indeterminate'
      familyPath: string | null
      reason: DraftIndeterminateReason
      /** A user edit re-armed the probe (schedule): the next debounce
       *  runs one real store probe instead of blocking. Deliberately
       *  NOT a flip back to primary mode — the family is still
       *  unverified, and only a successful probe may certify a path. */
      reprobePending: boolean
    }
  | {
      kind: 'move-indeterminate'
      /** The server's certified target path — the ONLY path this mode
       *  may write to, and only via a completed atomic family move.
       *  There is deliberately NO familyPath field: the family's
       *  current path is uncertified, and carrying one would invite
       *  guessed-path candidates. */
      serverPath: string
      reason: DraftIndeterminateReason
      /** A coexisting conflict pin (a delete handoff that landed while
       *  the family was uncertifiable). The resolver ignores it while
       *  the family stays uncertified (every write routes through the
       *  move retry, which writes nothing on failure); a healed move
       *  carries the pin to the new path via completeFamilyMove. */
      conflict: { conflictId: string; crossContextUpdatedAt: number | null } | null
    }

/** Why an entry entered indeterminate mode: the structured reason the
 *  store's unsupported outcome reported (split rows / an unreadable
 *  conflict or primary row), plus a reserved storage-failure state. */
type DraftIndeterminateReason =
  | import('./draftStore').UnsupportedFamilyReason
  | 'storage-failure'

/** The single routing decision every write path asks before touching
 *  the store (see resolveDraftWriteTarget): primary write at a path,
 *  conflict candidate at the pinned family path, an atomic family
 *  move retry oldPath→newPath (`oldPath` null when the family's
 *  current path is uncertified — a move-indeterminate entry), a
 *  re-probe of an indeterminate family at the snapshot's path, or
 *  blocked (indeterminate family with no pending re-probe). */
type DraftWriteTarget =
  | { kind: 'primary'; path: string }
  | {
      kind: 'conflict'
      path: string
      conflictId: string
      crossContextUpdatedAt: number | null
    }
  | { kind: 'retry-family-move'; oldPath: string | null; newPath: string }
  | { kind: 'authenticate-empty-family' }
  | { kind: 're-probe'; path: string }
  | { kind: 'blocked'; reason: string }

/** Result of promoting a superseded local snapshot into the conflict
 *  store during a delete transaction. The handoff is BOUNDED to two
 *  saves: it persists the current snapshot, and if a newer edit lands
 *  during that save it persists the NEW latest snapshot once more —
 *  never chasing indefinitely (a steady typer must not keep the file
 *  transaction / mutation lock open on a moving target).
 *  `persisted` — the latest snapshot now lives in the conflict store,
 *  verified within the transaction, so the caller may safely let the
 *  lifecycle close the tab; `failed` — a save was rejected, or edits
 *  kept landing across both attempts, so the latest bytes are still
 *  only in-memory: the caller must report 'failed' and keep the tab
 *  visible (the release arms the conflict debounce so the write is
 *  retried in the background while the tab remains the visible
 *  surface). */
export type ConflictHandoffResult =
  | { status: 'persisted'; conflictId: string }
  | { status: 'failed' }

/** Result of releasing a file transaction's hold on an entry.
 *  `released` — the lock was dropped without an immediate persistence
 *  requirement (nothing pending, or a debounce was armed instead);
 *  `persisted` — an immediate orphan/conflict write completed and the
 *  bytes are durable; `failed` — an immediate write was attempted and
 *  rejected, so the latest snapshot is still only in-memory. Every
 *  delete path that lets the lifecycle close the file tab must map
 *  `failed` to a 'failed' transaction result — the open tab is then
 *  the only surface still holding those bytes. */
type DraftReleaseResult =
  | { status: 'released' }
  | { status: 'persisted' }
  | { status: 'failed' }

/** Fired when a background quarantine retry changes the draft family
 *  AFTER the rename transaction already reported (the lifecycle has
 *  long since refreshed Recovery against the failed/mismatched state).
 *  - `moved-and-persisted` — the retry united the family at `newPath`
 *    AND the latest snapshot was successfully persisted on the new
 *    path's primary record. The family is whole and durable; Recovery
 *    must follow the family.
 *  - `moved-write-failed` — the retry united the family at `newPath`
 *    but the latest snapshot's primary write was rejected. The
 *    family is whole on disk but the latest edit is still only in
 *    memory; Recovery must follow the family AND keep the tab open.
 *    A bounded backoff retry is armed automatically (see
 *    SETTLE_RETRY_DELAYS_MS) so the snapshot re-persists without
 *    waiting for user input.
 *  - `conflict` — the retry failed again but the latest content was
 *    persisted as a move-quarantine candidate next to the old
 *    family. Recovery must surface the new candidate.
 *  `oldPath` is the family's certified pre-move path — or `null` when
 *  the move settled from move-indeterminate (the family's pre-move
 *  path was never certified, so no value may be reported; consumers
 *  route on vaultId / documentId / status).
 *  The owner should refresh the Recovery identity (and any open
 *  Recovery tabs) so they follow the family instead of showing the
 *  stale pre-retry state. Never warns — the original failure
 *  already did. */
export interface DraftFamilyMoveSettlement {
  vaultId: string
  documentId: string
  oldPath: string | null
  newPath: string
  status:
    | 'moved-and-persisted'
    | 'moved-write-failed'
    | 'path-authentication-pending'
    | 'conflict'
}

/** The server's authoritative answer to "where does this document
 *  live right now": the CURRENT path (a moving attribute — another
 *  window may rename at any time) plus a version token the caller can
 *  carry. Authentication compares PATHS: `version` (the server's
 *  updatedAt) also advances on metadata-only edits (title / tags)
 *  that do NOT rename, so treating version drift as a conflict would
 *  burn the bounded attempts on an active document and fail closed
 *  spuriously. The version is carried for the contract (and any
 *  future server-side CAS), never as the authentication criterion.
 *  Only a by-stable-identity server query may produce this value —
 *  never a cached tree / Tab / posts path, which a concurrent rename
 *  can stale at any moment. */
export interface CurrentDocumentLocation {
  path: string
  version: string | number
}

interface CreateOptions {
  store?: DraftStore
  debounceMs?: number
  now?: () => number
  targetWindow?: Pick<Window, 'addEventListener' | 'removeEventListener'>
  onDraftFamilyMoveSettled?: (settlement: DraftFamilyMoveSettlement) => void
  onIssue?: (issue: DraftPersistenceIssue) => void
  onRecordPersisted?: (vaultId: string) => void
  /** Re-validates the document's CURRENT server path by stable
   *  identity. Consulted by a move-indeterminate retry whose probe
   *  reports an EMPTIED draft family: the absence of every draft row
   *  is not a server-path verdict — another window may have renamed
   *  the document again (serverPath→C) and cleared its draft rows,
   *  and the stale serverPath may even have been reused by another
   *  document. The retry runs a bounded TOCTOU flow around it
   *  (resolve → write → revalidate → expected-path CAS on drift →
   *  final revalidation; at most two attempts): a query alone cannot
   *  certify the path, because another window may rename AGAIN
   *  between the query and the primary write. An absent resolver, a
   *  null / blank result or a thrown error fail closed — no primary
   *  is ever minted at the stale serverPath without re-validation. */
  resolveCurrentDocumentPath?: (
    vaultId: string,
    documentId: string,
  ) => Promise<CurrentDocumentLocation | null>
}

export function createUnsavedDraftPersistence(
  options: CreateOptions = {},
): UnsavedDraftPersistence {
  const store = options.store ?? createDraftStore()
  const debounceMs = options.debounceMs ?? DRAFT_PERSIST_DEBOUNCE_MS
  const now = options.now ?? Date.now
  const targetWindow = options.targetWindow
    ?? (typeof window === 'undefined' ? undefined : window)
  const entries = new Map<string, DraftEntry>()
  const oversizedRevisionWarnings = new Set<string>()
  const storageRevisionWarnings = new Set<string>()
  let disposed = false
  let disposePromise: Promise<void> | null = null

  function key(vaultId: string, documentId: string): string {
    return JSON.stringify([vaultId, documentId])
  }

  function validIdentity(vaultId: string, documentId: string): boolean {
    return vaultId.trim().length > 0 && documentId.trim().length > 0
  }

  function allowRecordContent(
    vaultId: string,
    documentId: string,
    revision: number,
    content: string,
  ): boolean {
    const bytes = draftContentBytes(content)
    if (bytes <= MAX_DRAFT_CONTENT_BYTES) return true
    const warningKey = JSON.stringify([vaultId, documentId, revision])
    if (!oversizedRevisionWarnings.has(warningKey)) {
      oversizedRevisionWarnings.add(warningKey)
      try {
        options.onIssue?.({
          kind: 'draft-too-large',
          vaultId,
          documentId,
          bytes,
          limit: MAX_DRAFT_CONTENT_BYTES,
        })
      } catch {
        // A warning handler never owns persistence.
      }
    }
    return false
  }

  function notifyRecordPersisted(vaultId: string): void {
    try {
      options.onRecordPersisted?.(vaultId)
    } catch {
      // Capacity maintenance never owns persistence success.
    }
  }

  function notifyStorageWriteFailed(
    vaultId: string,
    documentId: string,
    revision: number,
  ): void {
    const warningKey = JSON.stringify([vaultId, documentId, revision])
    if (storageRevisionWarnings.has(warningKey)) return
    storageRevisionWarnings.add(warningKey)
    try {
      options.onIssue?.({ kind: 'storage-write-failed', vaultId, documentId, revision })
    } catch {
      // A warning handler never owns persistence.
    }
  }

  function conflictId(documentId: string, generation: number): string {
    const uuid = typeof crypto !== 'undefined'
      && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    return `delete-conflict:${documentId}:${generation}:${uuid}`
  }

  /** Build a conflict record for a snapshot. Mints a timestamp strictly
   *  newer than the cross-context source so recovery can sort candidates.
   *  Shared by the delete-time handoff, the conflict-channel write path
   *  and the failed-family-move quarantine so all produce identical
   *  record shapes.
   *  `documentPath` falls back to the `identity.documentPath` so callers
   *  that explicitly know the family's actual path (e.g. a stale Tab
   *  whose snapshot path differs from the family's real path) can pin
   *  the candidate to the family's path; callers that want the
   *  snapshot's path can pass it through `identity.documentPath`. */
  function buildConflictRecord(
    snapshot: DraftBufferSnapshot,
    entry: DraftEntry,
    identity: DraftDocumentIdentity,
    crossContextUpdatedAt: number | null,
    origin: DraftConflictSource = 'delete-conflict',
  ): DraftConflictRecord {
    const localConflictId = conflictId(identity.documentId, entry.generation)
    const recordedAt = Math.max(safeTimestamp(entry), (crossContextUpdatedAt ?? 0) + 1)
    entry.previousUpdatedAt = recordedAt
    if (entry.createdAt === null) entry.createdAt = recordedAt
    return {
      version: UNSAVED_DRAFT_VERSION,
      conflictId: localConflictId,
      vaultId: identity.vaultId,
      documentId: identity.documentId,
      documentPath: identity.documentPath,
      content: snapshot.content,
      baseContentHash: snapshot.baseContentHash,
      baseModifiedAt: snapshot.baseModifiedAt,
      createdAt: entry.createdAt,
      updatedAt: recordedAt,
      origin,
      crossContextUpdatedAt,
      recordedAt,
    }
  }

  function entryFor(vaultId: string, documentId: string): DraftEntry {
    const identity = key(vaultId, documentId)
    let entry = entries.get(identity)
    if (!entry) {
      entry = {
        vaultId,
        documentId,
        releaseWhenInactive: false,
        generation: 0,
        timer: null,
        latestSnapshot: null,
        latestSnapshotNeedsWrite: false,
        pendingWrite: null,
        previousUpdatedAt: -1,
        createdAt: null,
        persistedDraft: null,
        fileTransaction: null,
        mode: { kind: 'primary' },
        emptyFamilyRecovery: null,
        settleRetryAttempt: null,
      }
      entries.set(identity, entry)
    }
    return entry
  }

  function releaseInactiveEntry(entry: DraftEntry): void {
    if (!entry.releaseWhenInactive
      || entry.latestSnapshot !== null
      || entry.latestSnapshotNeedsWrite
      || entry.timer !== null
      || entry.pendingWrite !== null
      || entry.fileTransaction !== null
      || entry.emptyFamilyRecovery !== null
      || entry.settleRetryAttempt !== null) return
    enterPrimaryMode(entry)
    entries.delete(key(entry.vaultId, entry.documentId))
  }

  function requestInactiveEntryRelease(entry: DraftEntry): void {
    entry.releaseWhenInactive = true
    releaseInactiveEntry(entry)
  }

  function clearTimer(entry: DraftEntry): void {
    if (entry.timer === null) return
    clearTimeout(entry.timer)
    entry.timer = null
    entry.settleRetryAttempt = null
  }

  function safeTimestamp(entry: DraftEntry): number {
    const requested = Math.max(0, Math.floor(now()))
    const next = Math.max(requested, entry.previousUpdatedAt + 1)
    const value = Math.min(Number.MAX_SAFE_INTEGER, next)
    entry.previousUpdatedAt = value
    if (entry.createdAt === null) entry.createdAt = value
    return value
  }

  function cloneSnapshot(snapshot: DraftBufferSnapshot): DraftBufferSnapshot {
    return { ...snapshot }
  }

  // ── Draft family persistence state machine ─────────────────────
  // Every transition below updates the entry's mode as ONE change;
  // resolveDraftWriteTarget is the ONLY place that maps a mode onto a
  // store target, runResolvedTarget / queueTargetWrite the only
  // places that execute one. The debounce timer, flush, flushAll /
  // pagehide, dispose, releaseEntry, the close seal and the settle
  // retry all go through them — none re-derive the channel itself.

  function enterPrimaryMode(entry: DraftEntry): void {
    entry.mode = { kind: 'primary' }
    entry.emptyFamilyRecovery = null
  }

  /** Open (or re-pin) the conflict channel at the family's
   *  authoritative path. A handoff landing on a quarantined entry
   *  keeps the quarantine (the family still needs its move retried)
   *  and attaches the pin to it — losing the quarantine here would
   *  stop the family move retries forever. */
  function enterConflictMode(
    entry: DraftEntry,
    familyPath: string,
    conflictId: string,
    crossContextUpdatedAt: number | null,
  ): void {
    if (entry.mode.kind === 'move-quarantine') {
      entry.mode = {
        ...entry.mode,
        conflict: { conflictId, crossContextUpdatedAt },
      }
      return
    }
    if (entry.mode.kind === 'move-indeterminate') {
      // The pin attaches to the pending move — the resolver keeps
      // routing every write through the move retry until the family
      // is certified again (the pin's path is NOT trusted while the
      // family is uncertifiable).
      entry.mode = {
        ...entry.mode,
        conflict: { conflictId, crossContextUpdatedAt },
      }
      return
    }
    entry.mode = { kind: 'conflict', familyPath, conflictId, crossContextUpdatedAt }
  }

  /** Quarantine the entry after an incomplete family move whose
   *  server rename succeeded. `familyPath` is the family's ACTUAL
   *  path: a chained rename (A→B failed leaving the family at A, now
   *  B→C fails) keeps the earlier oldPath — only the server/tab path
   *  advances. A coexisting conflict pin travels into the quarantine.
   *  An entry whose family path was NEVER certified (indeterminate,
   *  or an already move-indeterminate chained rename) becomes
   *  move-indeterminate instead: the rename's fromPath is NOT a
   *  certified family path, and adopting it would let a later failed
   *  retry persist a candidate at a guessed path. */
  function enterMoveQuarantine(
    entry: DraftEntry,
    fromPath: string,
    toPath: string,
  ): void {
    const mode = entry.mode
    if (entry.emptyFamilyRecovery !== null) {
      entry.emptyFamilyRecovery.move = { oldPath: null, newPath: toPath }
      entry.mode = {
        kind: 'move-indeterminate',
        serverPath: toPath,
        reason: mode.kind === 'move-indeterminate'
          ? mode.reason
          : 'storage-failure',
        conflict: mode.kind === 'move-indeterminate' ? mode.conflict : null,
      }
      return
    }
    if (mode.kind === 'move-quarantine') {
      entry.mode = { ...mode, serverPath: toPath }
      return
    }
    if (mode.kind === 'indeterminate' || mode.kind === 'move-indeterminate') {
      entry.mode = {
        kind: 'move-indeterminate',
        serverPath: toPath,
        reason: mode.reason,
        // A conflict pin (delete handoff landing while the family was
        // uncertifiable) travels into the new state — losing it would
        // let a later flush fall back to a primary overwrite.
        conflict: mode.kind === 'move-indeterminate' ? mode.conflict : null,
      }
      return
    }
    entry.mode = {
      kind: 'move-quarantine',
      familyPath: fromPath,
      serverPath: toPath,
      conflict: mode.kind === 'conflict'
        ? { conflictId: mode.conflictId, crossContextUpdatedAt: mode.crossContextUpdatedAt }
        : null,
    }
  }

  /** A verified family move completed (commitMoves `moved`/`missing`,
   *  or a healed quarantine retry): the mode, the snapshot path, the
   *  persistedDraft path and the conflict channel switch to the new
   *  path as ONE atomic in-memory change. Leaving any of them on the
   *  old path would route the very next write (the release's
   *  immediate write, the next debounce) back to the pre-move path
   *  and split the family the move just united. */
  function completeFamilyMove(entry: DraftEntry, newPath: string): void {
    const mode = entry.mode
    const authenticatingEmptyFamily = entry.emptyFamilyRecovery !== null
    const conflict = mode.kind === 'conflict'
      ? { conflictId: mode.conflictId, crossContextUpdatedAt: mode.crossContextUpdatedAt }
      : mode.kind === 'move-quarantine'
        ? mode.conflict
        : mode.kind === 'move-indeterminate'
          ? mode.conflict
          : null
    entry.mode = conflict
      ? {
          kind: 'conflict',
          familyPath: newPath,
          conflictId: conflict.conflictId,
          crossContextUpdatedAt: conflict.crossContextUpdatedAt,
        }
      : { kind: 'primary' }
    if (entry.latestSnapshot) {
      if (authenticatingEmptyFamily) entry.latestSnapshot.documentPath = newPath
      else entry.latestSnapshot = { ...entry.latestSnapshot, documentPath: newPath }
    }
    if (entry.persistedDraft) {
      entry.persistedDraft = { ...entry.persistedDraft, documentPath: newPath }
    }
    entry.emptyFamilyRecovery = null
  }

  /** An unsupported save with no certifiable family path: block every
   *  write (fail closed) until the next user edit re-arms the probe
   *  (schedule sets reprobePending). A pending family move is
   *  preserved: a quarantined / move-indeterminate entry becomes
   *  move-indeterminate — the move retry keeps running toward
   *  serverPath, but the once-certified familyPath is no longer
   *  trusted (the store rows now disagree or went unreadable), so no
   *  candidate may be written until the move completes or a probe
   *  re-certifies the family. */
  function markFamilyIndeterminate(
    entry: DraftEntry,
    familyPath: string | null,
    reason: DraftIndeterminateReason,
  ): void {
    const mode = entry.mode
    if (mode.kind === 'move-quarantine') {
      entry.mode = {
        kind: 'move-indeterminate',
        serverPath: mode.serverPath,
        reason,
        conflict: mode.conflict,
      }
      return
    }
    if (mode.kind === 'move-indeterminate') {
      entry.mode = { ...mode, reason }
      return
    }
    entry.mode = { kind: 'indeterminate', familyPath, reason, reprobePending: false }
  }

  /** The store certified the family's CURRENT path against a write
   *  (a conflict candidate came back path-mismatch with the family's
   *  new path — another context moved it): adopt the certified path
   *  WITHOUT writing anything. The write that discovered the move
   *  fails closed (needsWrite stays set); the next write goes at the
   *  corrected path. Writing at the stale path instead would strand
   *  the candidate and split the family the other context's move
   *  just united. Conflict mode re-pins its channel; a quarantine
   *  re-pins its actual family path (the conflict pin, if any, is
   *  path-independent and travels unchanged). */
  function adoptCertifiedFamilyPath(
    entry: DraftEntry,
    familyPath: string,
  ): void {
    const mode = entry.mode
    if (mode.kind === 'conflict') {
      entry.mode = { ...mode, familyPath }
      return
    }
    if (mode.kind === 'move-quarantine') {
      entry.mode = { ...mode, familyPath }
    }
  }

  /** The ONLY channel decision in the persistence layer: map the
   *  entry's mode + the snapshot onto a concrete store target.
   *  Read AT FIRE time (inside the queued task, after any in-flight
   *  write settled — see queueTargetWrite) so a handoff, a quarantine
   *  lift or a superseding edit landing between schedule and fire
   *  always routes through the CURRENT mode, never a stale channel
   *  captured at schedule time.
   *  - primary → primary write at the snapshot's own path (ordinary
   *    edit saves never implicitly change the family path);
   *  - conflict → candidate at the pinned familyPath, whatever path
   *    the snapshot still reports;
   *  - move-quarantine → a snapshot still at the family's actual
   *    path writes there (conflict channel when pinned, primary
   *    otherwise); a snapshot on any other path (the renamed tab)
   *    retries the atomic family move toward serverPath first (the
   *    server's certified target — never the snapshot's path, which
   *    a stale pre-migration snapshot could still report wrong);
   *  - move-indeterminate → always retry the atomic family move
   *    toward serverPath, with oldPath null: the family's current
   *    path is uncertified, so while the retry fails NOTHING may be
   *    written (no guessed candidate);
   *  - indeterminate → a pending re-probe runs one real store probe
   *    at the snapshot's path (a successful probe transitions out);
   *    without one, blocked: no safe path exists, nothing may be
   *    written until schedule() re-arms the probe. */
  function resolveDraftWriteTarget(
    entry: DraftEntry,
    snapshot: DraftBufferSnapshot,
  ): DraftWriteTarget {
    if (entry.emptyFamilyRecovery !== null) {
      return { kind: 'authenticate-empty-family' }
    }
    switch (entry.mode.kind) {
      case 'primary':
        return { kind: 'primary', path: snapshot.documentPath }
      case 'conflict':
        return {
          kind: 'conflict',
          path: entry.mode.familyPath,
          conflictId: entry.mode.conflictId,
          crossContextUpdatedAt: entry.mode.crossContextUpdatedAt,
        }
      case 'move-quarantine': {
        const mode = entry.mode
        if (snapshot.documentPath === mode.familyPath) {
          return mode.conflict
            ? {
                kind: 'conflict',
                path: mode.familyPath,
                conflictId: mode.conflict.conflictId,
                crossContextUpdatedAt: mode.conflict.crossContextUpdatedAt,
              }
            : { kind: 'primary', path: mode.familyPath }
        }
        return {
          kind: 'retry-family-move',
          oldPath: mode.familyPath,
          newPath: mode.serverPath,
        }
      }
      case 'move-indeterminate':
        return {
          kind: 'retry-family-move',
          oldPath: null,
          newPath: entry.mode.serverPath,
        }
      case 'indeterminate':
        return entry.mode.reprobePending
          ? { kind: 're-probe', path: snapshot.documentPath }
          : { kind: 'blocked', reason: entry.mode.reason }
    }
  }

  /** Dispatch a freshly resolved target to its pure write function,
   *  WITHOUT re-serializing on pendingWrite — for call sites already
   *  running inside the queued task (the family-move retry's post-lift
   *  write would deadlock against its own task otherwise). */
  function runResolvedTarget(
    owner: DraftOwner,
    entry: DraftEntry,
    snapshot: DraftBufferSnapshot,
    allowDisposed: boolean,
  ): Promise<boolean> {
    const target = resolveDraftWriteTarget(entry, snapshot)
    switch (target.kind) {
      case 'primary':
        return writePrimary(owner, snapshot, target.path, allowDisposed)
      case 'conflict':
        return writeConflict(
          owner,
          snapshot,
          target.path,
          target.conflictId,
          target.crossContextUpdatedAt,
          allowDisposed,
        )
      case 'retry-family-move':
        return executeFamilyMoveRetry(owner, snapshot, target, allowDisposed)
      case 'authenticate-empty-family': {
        const recovery = entry.emptyFamilyRecovery
        return recovery
          ? recoverEmptiedFamily(owner, entry, recovery.move, allowDisposed)
          : Promise.resolve(false)
      }
      case 're-probe':
        // One real store probe at the snapshot's path: writePrimary's
        // save attempt IS the probe — a successful save transitions
        // out of indeterminate, a rejected one re-marks it (clearing
        // reprobePending) or hands off to the certified family path.
        return writePrimary(owner, snapshot, target.path, allowDisposed)
      case 'blocked':
        return Promise.resolve(false)
    }
  }

  /** The single write executor: serialize on entry.pendingWrite, THEN
   *  resolve the target at fire time (fresher than any schedule-time
   *  capture — see resolveDraftWriteTarget) and dispatch through
   *  runResolvedTarget. Shared by every write route. */
  function queueTargetWrite(
    owner: DraftOwner,
    snapshot: DraftBufferSnapshot,
    allowDisposed = false,
  ): Promise<boolean> {
    const entry = entries.get(key(owner.vaultId, owner.documentId))
    if (!entry || (!allowDisposed && disposed)) return Promise.resolve(false)
    const previous = entry.pendingWrite
    const task = (async () => {
      if (previous) await previous.catch(() => false)
      const targetEntry = entries.get(key(owner.vaultId, owner.documentId))
      if (!targetEntry || (!allowDisposed && disposed)) return false
      return runResolvedTarget(owner, targetEntry, snapshot, allowDisposed)
    })()
    entry.pendingWrite = task
    void task.finally(() => {
      if (entry.pendingWrite === task) {
        entry.pendingWrite = null
        releaseInactiveEntry(entry)
      }
    })
    return task
  }

  /** Notify the owner that a background quarantine retry settled the
   *  draft family (see DraftFamilyMoveSettlement). Best effort — a
   *  throwing handler must never break draft persistence. */
  function notifyFamilyMoveSettled(
    vaultId: string,
    documentId: string,
    quarantine: { oldPath: string | null; newPath: string },
    status: DraftFamilyMoveSettlement['status'],
  ): void {
    try {
      options.onDraftFamilyMoveSettled?.({
        vaultId,
        documentId,
        oldPath: quarantine.oldPath,
        newPath: quarantine.newPath,
        status,
      })
    } catch {
      // Recovery sync is best-effort UX.
    }
  }

  function snapshotMatches(
    current: DraftBufferSnapshot | null,
    expected: DraftBufferSnapshot | null,
  ): boolean {
    if (!current || !expected) return current === expected
    return current.vaultId === expected.vaultId
      && current.documentId === expected.documentId
      && current.documentPath === expected.documentPath
      && current.content === expected.content
      && current.authoritativeContent === expected.authoritativeContent
      && current.baseContentHash === expected.baseContentHash
      && current.baseModifiedAt === expected.baseModifiedAt
      && current.revision === expected.revision
      && current.loaded === expected.loaded
  }

  function draftMatchesSnapshot(
    draft: UnsavedDraft,
    snapshot: DraftBufferSnapshot,
  ): boolean {
    return draft.vaultId === snapshot.vaultId
      && draft.documentId === snapshot.documentId
      && draft.documentPath === snapshot.documentPath
      && draft.content === snapshot.content
      && draft.baseModifiedAt === snapshot.baseModifiedAt
      && (snapshot.baseContentHash === null
        || draft.baseContentHash === snapshot.baseContentHash)
  }

  function current(
    owner: DraftOwner,
    entry: DraftEntry | undefined,
  ): entry is DraftEntry {
    return Boolean(entry && entry.generation === owner.generation)
  }

  async function buildDraft(
    snapshot: DraftBufferSnapshot,
    owner: DraftOwner,
    entry: DraftEntry,
  ): Promise<UnsavedDraft | null> {
    const baseContentHash = snapshot.baseContentHash
      ?? await hashDraftBaseline(snapshot.authoritativeContent)
    if (!current(owner, entry) || entry.latestSnapshot?.revision !== snapshot.revision) {
      return null
    }
    const updatedAt = safeTimestamp(entry)
    const draft: UnsavedDraft = {
      version: UNSAVED_DRAFT_VERSION,
      vaultId: snapshot.vaultId,
      documentId: snapshot.documentId,
      documentPath: snapshot.documentPath,
      content: snapshot.content,
      baseContentHash,
      baseModifiedAt: snapshot.baseModifiedAt,
      createdAt: entry.createdAt ?? updatedAt,
      updatedAt,
    }
    return isUnsavedDraft(draft) ? draft : null
  }

  /** The normalized result of one family-atomic candidate write.
   *  Every route that records a local edit as a conflict candidate
   *  goes through attemptCandidateWrite → DraftStore.saveConflictCandidate:
   *  - `saved` — the candidate is durable at its record path;
   *  - `path-mismatch` — the store certified the family now lives at
   *    `familyPath` (another context moved it); nothing was written —
   *    the caller re-pins at the certified path and fails this write
   *    closed (the next write goes at the corrected path);
   *  - `unsupported` — the family rows are split / unreadable; nothing
   *    was written — the caller marks the entry indeterminate (fail
   *    closed, no guessed side);
   *  - `failed` — the transaction aborted; the caller keeps whatever
   *    pin it had and fails closed (write flag stays set). */
  type CandidateWriteResult =
    | { kind: 'saved' }
    | { kind: 'path-mismatch'; familyPath: string }
    | { kind: 'unsupported'; reason: DraftIndeterminateReason }
    | { kind: 'failed' }

  async function attemptCandidateWrite(
    record: DraftConflictRecord,
  ): Promise<CandidateWriteResult> {
    const entry = entries.get(key(record.vaultId, record.documentId))
    const revision = entry?.latestSnapshot?.revision ?? -1
    if (!allowRecordContent(record.vaultId, record.documentId, revision, record.content)) {
      return { kind: 'failed' }
    }
    let outcome: import('./draftStore').DraftConflictCandidateOutcome
    try {
      outcome = await store.saveConflictCandidate(record)
    } catch {
      notifyStorageWriteFailed(record.vaultId, record.documentId, revision)
      return { kind: 'failed' }
    }
    switch (outcome.status) {
      case 'saved':
        notifyRecordPersisted(record.vaultId)
        return { kind: 'saved' }
      case 'path-mismatch':
        return { kind: 'path-mismatch', familyPath: outcome.familyPath }
      case 'unsupported':
        return { kind: 'unsupported', reason: outcome.reason }
      case 'failed':
        notifyStorageWriteFailed(record.vaultId, record.documentId, revision)
        return { kind: 'failed' }
    }
  }

  /** Core primary-record write shared by the debounced, flushed and
   *  finalized paths. Returns true ONLY when the exact readback after
   *  the save still equals the draft just written AND the snapshot is
   *  still the entry's latest at resolution:
   *  - an edit landing during the save advances the generation,
   *    replaces the snapshot and re-arms the write flag, so a `true`
   *    that ignored the supersession would certify outdated content;
   *  - another context may replace the record between the save and
   *    the readback (DraftStore accepts a higher `updatedAt` record
   *    wholesale), so a `true` based on `saveDraft` alone would
   *    certify content that is already gone from the store — and a
   *    close seal acting on it would close the tab holding the only
   *    remaining copy.
   *  On a readback mismatch the write hands off instead of retrying:
   *  the attempted revision is persisted as an independent conflict
   *  candidate (never a fresh-timestamp primary overwrite, which
   *  would bury the cross-context record) and the entry is pinned to
   *  the conflict channel. The write still returns false — the bytes
   *  survived as a candidate but not as the primary record, so the
   *  caller (close seal, release) fails closed and keeps the tab
   *  open while Recovery surfaces the candidate. A rejected candidate
   *  also returns false, leaving the write flag set so flush / close
   *  seal keep retrying the conflict channel. */
  async function writePrimary(
    owner: DraftOwner,
    snapshot: DraftBufferSnapshot,
    path: string,
    allowDisposed: boolean,
  ): Promise<boolean> {
    const entry = entries.get(key(owner.vaultId, owner.documentId))
    if (!entry || (!allowDisposed && disposed)) return false
    if ((!allowDisposed && disposed) || !current(owner, entry)) return false
    const built = await buildDraft(snapshot, owner, entry)
    if (!built || (!allowDisposed && disposed) || !current(owner, entry)) return false
    const capturedSnapshot = entry.latestSnapshot
    const capturedRevision = snapshot.revision
    if (!capturedSnapshot || capturedSnapshot.revision !== capturedRevision) return false
    // The resolver's path is authoritative: an ordinary edit save may
    // never implicitly change the family path. In primary mode the two
    // are identical; a quarantined snapshot writing at the family's
    // actual path gets its record pinned there.
    const draft: UnsavedDraft = built.documentPath === path
      ? built
      : { ...built, documentPath: path }
    if (!allowRecordContent(
      draft.vaultId, draft.documentId, snapshot.revision, draft.content,
    )) return false
    let outcome: import('./draftStore').DraftSaveOutcome
    try {
      outcome = await store.saveDraft(draft)
    } catch {
      notifyStorageWriteFailed(owner.vaultId, owner.documentId, snapshot.revision)
      return false
    }
    if (outcome.status === 'failed') {
      notifyStorageWriteFailed(owner.vaultId, owner.documentId, snapshot.revision)
      // Store threw / returned a fatal error. The latest bytes are still
      // in memory only — keep the write flag set and fail closed so
      // flush / close seal retry until the store recovers. Without this
      // a debounce `void queueTargetWrite(...)` would silently drop the
      // edit on a transient store outage.
      if (entry.mode.kind === 'indeterminate' && entry.mode.reprobePending) {
        // This save attempt WAS the armed re-probe — and it failed at
        // the store. A storage failure is not a family verdict: re-close
        // the entry (clear reprobePending, reason storage-failure) so a
        // manual flush / pagehide / dispose does not re-fire the probe
        // against the broken store on every invocation — the "one probe
        // per user edit" contract. The next user edit (schedule) re-arms
        // exactly one probe.
        entry.mode = {
          kind: 'indeterminate',
          familyPath: null,
          reason: 'storage-failure',
          reprobePending: false,
        }
      }
      return false
    }
    if (outcome.status === 'unsupported') {
      // A future-version / corrupt row (or a non-saveable shape) blocks
      // the WHOLE primary save. The caller must NEVER retry a plain
      // overwrite.
      // When the store's family probe certified a path every raw row
      // agrees on (`familyPath`), promote the snapshot to an
      // independent conflict candidate ON that path and pin the
      // conflict channel there — Recovery surfaces the candidate next
      // to the family it belongs to, and every subsequent
      // conflict-channel write follows the same path instead of the
      // snapshot's stale one (a stale Tab keeps reporting its old path
      // on every keystroke; candidates recorded there would split the
      // conflict-only family).
      // When the family path is indeterminate (`null` — the rows
      // disagree on the path, no row carries a readable path, or the
      // store could not be re-read; the outcome's `reason` says which)
      // there is nowhere safe to pin a candidate: creating one at THIS
      // snapshot's path is exactly the split this branch must avoid.
      // Mark the entry indeterminate so every subsequent flush /
      // pagehide / close seal fails closed WITHOUT hammering the store
      // with speculative re-reads — until the next user edit
      // (schedule) re-arms the probe, the family may have been healed
      // server-side in the meantime.
      if (outcome.familyPath === null) {
        markFamilyIndeterminate(entry, null, outcome.reason)
        return false
      }
      if ((!allowDisposed && disposed) || !current(owner, entry)
        || entry.latestSnapshot !== capturedSnapshot
        || entry.latestSnapshot.revision !== capturedRevision
        || entry.mode.kind === 'conflict'
        || (entry.mode.kind === 'move-quarantine' && entry.mode.conflict !== null)) {
        return false
      }
      const familyPath = outcome.familyPath
      const record = buildConflictRecord(
        snapshot,
        entry,
        {
          vaultId: owner.vaultId,
          documentId: owner.documentId,
          // The candidate joins the family at the path the store's raw
          // rows agree on — never this snapshot's possibly-stale path.
          documentPath: familyPath,
        },
        // No cross-context source — the local content is preserved
        // alongside whatever the store holds (the store couldn't tell
        // us what).
        null,
        'delete-conflict',
      )
      // Family-atomic candidate write: if another context moved the
      // family between the saveDraft probe and this write, the store
      // reports the new path (path-mismatch) — pin failed there so
      // the next write retries at the certified path instead of
      // stranding this candidate on the stale one. If the family
      // turned uncertifiable (unsupported), fail closed without
      // guessing a side.
      const attempt = await attemptCandidateWrite(record)
      if (attempt.kind === 'unsupported') {
        markFamilyIndeterminate(entry, null, attempt.reason)
        return false
      }
      const pinPath = attempt.kind === 'path-mismatch' ? attempt.familyPath : familyPath
      // Pin the conflict channel to the family path so every
      // subsequent conflict-channel write lands there too — the
      // snapshot path this Tab reports stays stale.
      if (attempt.kind !== 'saved') {
        enterConflictMode(entry, pinPath, `failed:${record.conflictId}`, null)
        return false
      }
      enterConflictMode(entry, pinPath, record.conflictId, null)
      if (current(owner, entry)
        && entry.latestSnapshot === capturedSnapshot
        && entry.latestSnapshot.revision === capturedRevision) {
        entry.latestSnapshotNeedsWrite = false
      }
      return false
    }
    if (outcome.status === 'stale' || outcome.status === 'conflict') {
      // The store already holds a record with higher (or equal) priority
      // — either a newer cross-context draft, or a same-timestamp
      // conflict. Persist the local content as a candidate and pin the
      // entry to the conflict channel so every subsequent edit follows
      // it. NEVER retry the primary: `safeTimestamp()` would mint a
      // higher `updatedAt` and silently bury the other context.
      if ((!allowDisposed && disposed) || !current(owner, entry)
        || entry.latestSnapshot !== capturedSnapshot
        || entry.latestSnapshot.revision === undefined
        || entry.latestSnapshot.revision !== capturedRevision
        || entry.mode.kind === 'conflict'
        || (entry.mode.kind === 'move-quarantine' && entry.mode.conflict !== null)) {
        return false
      }
      const familyPath = outcome.current.documentPath
      const crossContextUpdatedAt = outcome.current.updatedAt
      const record = buildConflictRecord(
        snapshot,
        entry,
        {
          vaultId: owner.vaultId,
          documentId: owner.documentId,
          // The candidate's `documentPath` MUST track the family's
          // actual path (the cross-context source it diverged from),
          // not the snapshot's possibly-stale path — otherwise a later
          // move would never migrate the candidate with the rest of
          // the family and it would be stranded on the wrong path
          // forever, invisible to Recovery.
          documentPath: familyPath,
        },
        crossContextUpdatedAt,
      )
      // Family-atomic candidate write: path-mismatch means another
      // context moved the family after this save's outcome was
      // captured — pin failed at the certified new path (the next
      // write retries there); unsupported means the family turned
      // uncertifiable — fail closed without guessing a side.
      const attempt = await attemptCandidateWrite(record)
      if (attempt.kind === 'unsupported') {
        markFamilyIndeterminate(entry, null, attempt.reason)
        return false
      }
      const pinPath = attempt.kind === 'path-mismatch' ? attempt.familyPath : familyPath
      // Pin the conflict channel to the family's authoritative path so
      // every subsequent conflict-channel write lands there too — a
      // stale Tab keeps reporting its old path on every edit.
      if (attempt.kind !== 'saved') {
        enterConflictMode(entry, pinPath, `failed:${record.conflictId}`, crossContextUpdatedAt)
        return false
      }
      enterConflictMode(entry, pinPath, record.conflictId, crossContextUpdatedAt)
      entry.persistedDraft = outcome.current
      if (current(owner, entry)
        && entry.latestSnapshot === capturedSnapshot
        && entry.latestSnapshot.revision === capturedRevision) {
        entry.latestSnapshotNeedsWrite = false
      }
      return false
    }
    if (outcome.status === 'path-mismatch') {
      // The family's primary record lives at a different path than the
      // incoming draft — the server already moved the file (or another
      // context did), and this snapshot's path is stale. A plain
      // primary write here would either silently drag the family back
      // to the old path (the Stateless family-aware backstop used to do
      // this — re-introducing the exact split the move is supposed to
      // prevent) or overwrite the family's current record (if the
      // family was empty). Promote the local content to an independent
      // conflict candidate next to the family's actual path, pin the
      // entry to the conflict channel so every subsequent edit follows
      // it, and surface the cross-context source's updatedAt on the
      // candidate so Recovery can sort it correctly.
      if ((!allowDisposed && disposed) || !current(owner, entry)
        || entry.latestSnapshot !== capturedSnapshot
        || entry.latestSnapshot.revision !== capturedRevision
        || entry.mode.kind === 'conflict'
        || (entry.mode.kind === 'move-quarantine' && entry.mode.conflict !== null)) {
        return false
      }
      const familyPath = outcome.current.documentPath
      const crossContextUpdatedAt = outcome.current.updatedAt
      const record = buildConflictRecord(
        snapshot,
        entry,
        {
          vaultId: owner.vaultId,
          documentId: owner.documentId,
          // The candidate's `documentPath` MUST track the family's
          // actual path (the cross-context source it diverged from),
          // not the stale snapshot path — otherwise a later move
          // would never migrate the candidate with the rest of the
          // family and it would be stranded on the wrong path
          // forever, invisible to Recovery.
          documentPath: familyPath,
        },
        crossContextUpdatedAt,
      )
      // Family-atomic candidate write: path-mismatch means the family
      // moved AGAIN after this save's outcome was captured — pin
      // failed at the certified new path (the next write retries
      // there); unsupported means the family turned uncertifiable —
      // fail closed without guessing a side.
      const attempt = await attemptCandidateWrite(record)
      if (attempt.kind === 'unsupported') {
        markFamilyIndeterminate(entry, null, attempt.reason)
        return false
      }
      const pinPath = attempt.kind === 'path-mismatch' ? attempt.familyPath : familyPath
      // Pin the conflict channel to the family's authoritative path so
      // every subsequent conflict-channel write lands there too — a
      // stale Tab keeps reporting its old path on every edit.
      if (attempt.kind !== 'saved') {
        enterConflictMode(entry, pinPath, `failed:${record.conflictId}`, crossContextUpdatedAt)
        return false
      }
      enterConflictMode(entry, pinPath, record.conflictId, crossContextUpdatedAt)
      // A conflict-only family has no primary record to CAS against:
      // the anchor is then a conflict candidate, not a persistedDraft.
      entry.persistedDraft = isUnsavedDraft(outcome.current) ? outcome.current : null
      if (current(owner, entry)
        && entry.latestSnapshot === capturedSnapshot
        && entry.latestSnapshot.revision === capturedRevision) {
        entry.latestSnapshotNeedsWrite = false
      }
      return false
    }
    if (outcome.status !== 'saved') {
      return false
    }
    // A newer local edit landing during the save supersedes this
    // revision — its own write is responsible for persistence.
    if ((!allowDisposed && disposed) || !current(owner, entry)
      || entry.latestSnapshot !== capturedSnapshot
      || entry.latestSnapshot.revision !== capturedRevision) {
      return false
    }
    // Exact readback: re-read the store ourselves to detect a race
    // that happened AFTER the save. The structured outcome's `stored`
    // value was captured DURING the save; between then and now
    // another context may have replaced the record (the store accepts
    // a higher-`updatedAt` record wholesale, body AND path). A direct
    // re-read here catches that race — the previous (now-stale) `saved`
    // outcome must NOT certify the bytes durable if the store no
    // longer holds them. DraftStore preserves an existing record's
    // original `createdAt`; the equality check tolerates that.
    let stored: UnsavedDraft | null = null
    try {
      stored = await store.getDraft(draft.vaultId, draft.documentId)
    } catch {
      stored = null
    }
    if (stored
      && draftsEqual(stored, { ...draft, createdAt: stored.createdAt })) {
      // The attempted revision is durable. Re-verify ownership AFTER
      // the readback resolves: an edit landing DURING the readback
      // await supersedes this revision and owns its own persistence.
      // Clearing the write flag here would leave the newer revision
      // displayed in the editor while flush / pagehide / dispose AND
      // the close seal's re-arm all believe it is already persisted —
      // the exact bytes-only-in-memory state the seal exists to
      // prevent. Fail closed instead: record the store truth (the
      // attempted revision really is the primary record now, so a
      // later confirmed-delete CAS targets the right row) and return
      // false without touching the newer revision's flag. NEVER
      // promote this revision to a conflict candidate here — it
      // already lives in the primary store; a duplicate candidate
      // would surface in Recovery as a false orphan.
      if ((!allowDisposed && disposed) || !current(owner, entry)
        || entry.latestSnapshot !== capturedSnapshot
        || entry.latestSnapshot.revision !== capturedRevision) {
        entry.persistedDraft = stored
        return false
      }
      // A successful re-probe (the writePrimary dispatched by the
      // 're-probe' target) must EXIT indeterminate: the save AND its
      // exact readback just certified that the snapshot's path is the
      // family's writable path again. Staying indeterminate would keep
      // blocking every later write and — worse — route the NEXT rename
      // through enterMoveQuarantine's indeterminate branch into
      // move-indeterminate, whose retries have no trustworthy expected
      // path. The primary channel is certified now: the next edit saves
      // normally, and the next rename gets full quarantine semantics.
      if (entry.mode.kind === 'indeterminate') {
        enterPrimaryMode(entry)
      }
      entry.latestSnapshotNeedsWrite = false
      entry.persistedDraft = stored
      notifyRecordPersisted(stored.vaultId)
      return true
    }
    // Readback mismatch: the record the store now holds is a newer
    // cross-context draft (or is gone). NEVER retry with a fresh
    // timestamp — `safeTimestamp()` would mint a higher `updatedAt`
    // and silently bury the other context's record, the exact race
    // the conflict channel exists to prevent. Persist the attempted
    // revision as an independent conflict candidate instead and pin
    // the entry to the conflict channel so every subsequent edit
    // follows it. A rejected candidate fails closed: the close seal
    // keeps the tab open (the only surface still holding the bytes)
    // and flush/dispose keep retrying the conflict channel.
    if ((!allowDisposed && disposed)
      || entry.mode.kind === 'conflict'
      || (entry.mode.kind === 'move-quarantine' && entry.mode.conflict !== null)) {
      return false
    }
    const crossContextUpdatedAt = stored?.updatedAt ?? null
    // Attempt the candidate at the family's likely path (whatever the
    // store now holds — falling back to the snapshot path when the
    // readback returned nothing). The fallback IS a guess, but the
    // family-atomic candidate write validates it inside the store
    // transaction: if the family actually lives elsewhere the write
    // returns path-mismatch with the certified path and nothing is
    // stranded at the guess.
    const familyPath = stored?.documentPath ?? snapshot.documentPath
    const record = buildConflictRecord(
      snapshot,
      entry,
      {
        vaultId: owner.vaultId,
        documentId: owner.documentId,
        // The candidate's `documentPath` MUST track the family's
        // actual path (whatever the store now holds), not the
        // possibly-stale snapshot path — otherwise a later move
        // would never migrate the candidate with the rest of the
        // family and it would be stranded on the wrong path
        // forever, invisible to Recovery.
        documentPath: familyPath,
      },
      crossContextUpdatedAt,
    )
    const attempt = await attemptCandidateWrite(record)
    if (attempt.kind === 'unsupported') {
      // The family turned uncertifiable mid-handoff: fail closed
      // without guessing a side.
      markFamilyIndeterminate(entry, null, attempt.reason)
      return false
    }
    const pinPath = attempt.kind === 'path-mismatch' ? attempt.familyPath : familyPath
    if (attempt.kind !== 'saved') {
      // Pin as failed (at the certified path when the family moved)
      // so flush / close-seal retries stay on the conflict channel
      // instead of falling back to a primary write that would
      // overwrite the cross-context record.
      enterConflictMode(entry, pinPath, `failed:${record.conflictId}`, crossContextUpdatedAt)
      return false
    }
    enterConflictMode(entry, pinPath, record.conflictId, crossContextUpdatedAt)
    // The cross-context record owns the primary store from here on.
    entry.persistedDraft = stored
    if (current(owner, entry)
      && entry.latestSnapshot === capturedSnapshot
      && entry.latestSnapshot.revision === capturedRevision) {
      // The candidate holds the latest content — clear the write
      // flag. A newer local edit that landed mid-handoff keeps its
      // flag set so it persists on the conflict channel next.
      entry.latestSnapshotNeedsWrite = false
    }
    // The attempted revision is durable as a conflict candidate, but
    // NOT as the primary record the caller asked to persist — report
    // false so a close seal keeps the tab open and a Recovery refresh
    // surfaces the candidate.
    return false
  }

  /** Core conflict-channel write (dispatched by runResolvedTarget).
   *  Persists the snapshot as a conflict candidate at the resolver's
   *  path — never the primary store, never the snapshot's
   *  possibly-stale path. The candidate path, the pinned conflictId
   *  and the cross-context marker all arrive pre-resolved from the
   *  entry's mode. Empty-family authentication may also call it while
   *  move-indeterminate carries a conflict pin: the Store probe has
   *  certified the anchor, but the server path is not authenticated
   *  yet, so the pin stays attached until completeFamilyMove. */
  async function writeConflict(
    owner: DraftOwner,
    snapshot: DraftBufferSnapshot,
    path: string,
    conflictId: string,
    crossContextUpdatedAt: number | null,
    allowDisposed: boolean,
  ): Promise<boolean> {
    void conflictId
    const entry = entries.get(key(owner.vaultId, owner.documentId))
    if (!entry || (!allowDisposed && disposed)) return false
    if ((!allowDisposed && disposed) || !current(owner, entry)) return false
    // The channel must still be pinned: a mid-flight lift (a confirmed
    // delete) means the candidate write no longer reflects the entry's
    // mode — fail closed and let the next route re-resolve.
    const pinned = entry.mode.kind === 'conflict'
      || (entry.mode.kind === 'move-quarantine' && entry.mode.conflict !== null)
      || (entry.mode.kind === 'move-indeterminate' && entry.mode.conflict !== null)
    if (!pinned) return false
    if (entry.latestSnapshot?.revision !== snapshot.revision) return false
    const record = buildConflictRecord(
      snapshot,
      entry,
      {
        vaultId: owner.vaultId,
        documentId: owner.documentId,
        // The resolver pinned the candidate to the family's
        // authoritative path (the mode's familyPath / the
        // quarantine's actual path): every candidate must land there,
        // never on the stale path the editor snapshot still reports.
        documentPath: path,
      },
      crossContextUpdatedAt,
    )
    // Family-atomic candidate write: the store validates the pinned
    // path against the family's CURRENT rows inside one transaction,
    // so a move committed by another context since the pin was set
    // surfaces as path-mismatch here instead of stranding the
    // candidate on the pre-move path.
    const attempt = await attemptCandidateWrite(record)
    const stillPinned = entry.mode.kind === 'conflict'
      || (entry.mode.kind === 'move-quarantine' && entry.mode.conflict !== null)
      || (entry.mode.kind === 'move-indeterminate' && entry.mode.conflict !== null)
    if (attempt.kind === 'saved') {
      if (stillPinned
        && current(owner, entry)
        && entry.latestSnapshot?.revision === snapshot.revision) {
        // The pin follows the newest candidate (a quarantine keeps
        // its move retry; a plain conflict channel stays pinned with
        // the fresh id).
        if (entry.mode.kind === 'move-quarantine') {
          entry.mode = {
            ...entry.mode,
            conflict: { conflictId: record.conflictId, crossContextUpdatedAt },
          }
        } else if (entry.mode.kind === 'move-indeterminate') {
          entry.mode = {
            ...entry.mode,
            conflict: { conflictId: record.conflictId, crossContextUpdatedAt },
          }
        } else if (entry.mode.kind === 'conflict') {
          entry.mode = { ...entry.mode, conflictId: record.conflictId }
        }
        entry.latestSnapshotNeedsWrite = false
        return true
      }
      return false
    }
    if (attempt.kind === 'path-mismatch') {
      // The family moved in another context after the pin was set —
      // the certified current path supersedes everything this channel
      // was chasing.
      // A move-quarantine is DISCARDED: any candidate write meeting
      // path-mismatch proves the quarantine's serverPath stale, and
      // keeping it alive would let a later flush retry the stale move
      // — a CAS re-derived against the family's real path would then
      // drag the family back toward the old server target.
      // adoptCertifiedFamilyAtCurrentPath persists the pending content
      // as a move-conflict candidate AT the certified path and pins
      // the plain conflict channel there (or failed:@path when even
      // that write cannot complete) — the old serverPath is never
      // retried again.
      // A plain conflict channel has no stale serverPath to discard:
      // it adopts the path WITHOUT writing — this write fails closed
      // (the write flag stays set) and the next write retries at the
      // corrected path. Writing at the stale pinned path is exactly
      // the split the family-atomic store write prevents.
      if (stillPinned && current(owner, entry)) {
        if (entry.mode.kind === 'move-quarantine') {
          return adoptCertifiedFamilyAtCurrentPath(
            owner,
            entry,
            {
              oldPath: entry.mode.familyPath,
              newPath: entry.mode.serverPath,
            },
            attempt.familyPath,
            allowDisposed,
          )
        }
        if (entry.mode.kind === 'move-indeterminate') {
          entry.mode = {
            ...entry.mode,
            conflict: entry.mode.conflict
              ? { ...entry.mode.conflict, conflictId: `failed:${record.conflictId}` }
              : null,
          }
          return false
        }
        adoptCertifiedFamilyPath(entry, attempt.familyPath)
      }
      return false
    }
    if (attempt.kind === 'unsupported') {
      // The family turned uncertifiable (split / unreadable rows):
      // fail closed until the next probe or move retry re-certifies
      // a path. markFamilyIndeterminate converts a pinned quarantine
      // into move-indeterminate (the move retry keeps running toward
      // serverPath; no candidate may be written until it completes).
      if (current(owner, entry)) {
        markFamilyIndeterminate(entry, null, attempt.reason)
      }
      return false
    }
    // failed: the pin stays as-is; the write flag stays set and
    // flush / close seal keep retrying the conflict channel.
    return false
  }

  /** A move retry discovered the family no longer sits where the retry
   *  expected — the store's CAS returned `path-mismatch` with the
   *  family's certified CURRENT path (another context's verified rename
   *  moved it), or a move-indeterminate probe certified the family at a
   *  path other than the stale serverPath. The server file operation is
   *  ALWAYS authoritative: the family must NOT be dragged back toward
   *  the retry's stale target (it may even have been reused by another
   *  document). Discard the stale quarantine's serverPath and adopt the
   *  certified current path instead — persist the pending content as a
   *  move-conflict candidate ON the family's real path and pin the entry
   *  to the conflict channel there, so every subsequent edit lands on
   *  the certified path too.
   *  The candidate write itself is family-atomic: if the family moves
   *  AGAIN mid-adoption the write comes back path-mismatch with the
   *  newer certified path — pin there as `failed:` (no quarantine to
   *  keep: its serverPath is stale) and fail closed; if the family
   *  turns uncertifiable, mark it indeterminate (fail closed); if the
   *  transaction aborts, pin `failed:` at the certified path anyway
   *  and fail closed — that path came from the store's own verdict
   *  and supersedes the stale serverPath, which may never be retried
   *  again. */
  async function adoptCertifiedFamilyAtCurrentPath(
    owner: DraftOwner,
    entry: DraftEntry,
    move: { oldPath: string | null; newPath: string },
    certifiedPath: string,
    allowDisposed: boolean,
  ): Promise<boolean> {
    const latest = entry.latestSnapshot
    if (!latest) return false
    const capturedRef = latest
    const capturedRevision = latest.revision
    const record = buildConflictRecord(
      latest,
      entry,
      {
        vaultId: owner.vaultId,
        documentId: owner.documentId,
        // The candidate joins the family at its certified CURRENT path —
        // never at the stale serverPath the retry was chasing, and never
        // at the renamed tab's snapshot path (which would split the
        // family immediately).
        documentPath: certifiedPath,
      },
      null,
      'move-conflict',
    )
    const attempt = await attemptCandidateWrite(record)
    if ((!allowDisposed && disposed) || !current(owner, entry)) return false
    if (attempt.kind === 'path-mismatch') {
      // The family moved again mid-adoption: pin the conflict channel at
      // the newer certified path as failed so the next write retries
      // there. NOT enterConflictMode — a quarantined entry would keep
      // its stale serverPath alive, and the certified path has already
      // superseded it.
      entry.mode = {
        kind: 'conflict',
        familyPath: attempt.familyPath,
        conflictId: `failed:${record.conflictId}`,
        crossContextUpdatedAt: null,
      }
      return false
    }
    if (attempt.kind === 'unsupported') {
      // The family turned uncertifiable mid-adoption: fail closed. The
      // entry stays on its pending-move mode — a move-indeterminate
      // retry now re-verifies before acting, so its stale serverPath
      // can never blind-move the family again.
      markFamilyIndeterminate(entry, null, attempt.reason)
      return false
    }
    if (attempt.kind !== 'saved') {
      // Transaction aborted. The certified path (the store's own
      // path-mismatch / probe verdict that led here) is STILL the
      // freshest trustworthy fact this entry holds — fresher than the
      // quarantine's oldPath or the move-indeterminate serverPath the
      // retry was chasing. Pin the conflict channel there as failed
      // and discard the stale quarantine / move-indeterminate state:
      // the old serverPath may never be retried again (a later CAS
      // re-derived against the family's real path would drag it back).
      // The pending content stays in memory — the write flag is set,
      // and the next write persists it on the pinned channel.
      entry.mode = {
        kind: 'conflict',
        familyPath: certifiedPath,
        conflictId: `failed:${record.conflictId}`,
        crossContextUpdatedAt: null,
      }
      return false
    }
    // The candidate now sits on the family's certified current path.
    // Pin the conflict channel there and discard the stale quarantine /
    // move-indeterminate state — the family's real path is authoritative
    // from here on. NOT enterConflictMode: it would keep a quarantine
    // alive whose serverPath another context's verified rename has
    // superseded.
    entry.mode = {
      kind: 'conflict',
      familyPath: certifiedPath,
      conflictId: record.conflictId,
      crossContextUpdatedAt: null,
    }
    // A new candidate now sits next to the family on its real path —
    // notify so Recovery shows it even though the stale move never ran.
    notifyFamilyMoveSettled(owner.vaultId, owner.documentId, move, 'conflict')
    if (entry.latestSnapshot === capturedRef
      && entry.latestSnapshot.revision === capturedRevision) {
      // The candidate holds the latest content — clear the write flag,
      // mirroring the failed-retry candidate convention. A superseding
      // edit keeps its flag and persists on the pinned channel next.
      entry.latestSnapshotNeedsWrite = false
      return true
    }
    return false
  }

  /** A move-indeterminate retry whose probe reports an EMPTIED draft
   *  family. The absence of every draft row certifies neither a
   *  server path nor a family path — another window may have renamed
   *  the document again (serverPath→C) and cleared its rows, and the
   *  stale serverPath may even have been reused by another document.
   *  So the pending snapshot's primary is minted at a server-
   *  RE-VALIDATED path (resolveCurrentDocumentPath, by stable
   *  identity) and the mint is then AUTHENTICATED against a second
   *  server query: the path can race between the query and the write
   *  (window B renames B→C after the resolver returned B; its own
   *  draft move sees no rows; a write at B would leave the server
   *  file at C and the draft primary at B — the stale-quarantine
   *  split relocated onto the resolver seam). Bounded flow, at most
   *  two attempts:
   *    (1) query the server's current path + version;
   *    (2) establish the family there — the first mint writes the
   *        primary (nothing to split: the store holds no row for this
   *        identity); a later attempt converges the already-written
   *        family via an expected-path CAS, never a blind save;
   *    (3) query again — an unchanged path authenticates;
   *    (4) changed → the expected-path CAS moves the just-written
   *        family to the newest path (a path-mismatch adopts the
   *        CAS-certified current path instead), then ONE final
   *        revalidation authenticates;
   *    (5) still changing past the bound → fail closed: with a mint
   *        landed, the latest bytes persist at the last server-
   *        authoritative path the flow reached (recoverable), the
   *        path-authentication-pending settlement records that the
   *        bytes are durable but the path is not yet certified; the
   *        next retry / flush resumes authentication. Without a mint,
   *        nothing was written anywhere and the tab stays the sole
   *        holder of the in-memory bytes.
   *  Absent / null / blank / throwing resolution fails closed BEFORE
   *  anything is minted. Authentication compares PATHS, never the
   *  version token: a metadata-only edit (title / tags) bumps the
   *  server's updatedAt WITHOUT renaming, and treating that drift as
   *  a conflict would burn the bounded attempts on an active
   *  document. Self-contained — the probe-'none' branch returns its
   *  verdict directly; the movedStatus success path below serves only
   *  certified-family outcomes. */
  async function recoverEmptiedFamily(
    owner: DraftOwner,
    entry: DraftEntry,
    move: { oldPath: string | null; newPath: string },
    allowDisposed: boolean,
  ): Promise<boolean> {
    const resolver = options.resolveCurrentDocumentPath
    if (!resolver) return false
    // Keep authentication state on the entry across flush / pagehide /
    // automatic-retry calls. Durable bytes and an authenticated path
    // are separate facts: a successful write may still need another
    // server query before this entry can return to a normal channel.
    const recovery = entry.emptyFamilyRecovery ?? {
      move: { ...move },
      anchorPath: null,
    }
    entry.emptyFamilyRecovery = recovery
    let anchor = recovery.anchorPath

    const setAnchor = (path: string): void => {
      anchor = path
      recovery.anchorPath = path
      if (entry.latestSnapshot) {
        entry.latestSnapshot.documentPath = path
      }
      if (entry.persistedDraft) {
        entry.persistedDraft = { ...entry.persistedDraft, documentPath: path }
      }
    }

    // Every failure exit routes through here: once a mint has landed,
    // the latest bytes persist at the anchor (recoverable) and the
    // settlement distinguishes bytes still only in memory from bytes
    // already durable at an anchor whose path is not authenticated.
    // Before any mint it is a silent no-op: nothing was written
    // anywhere, the flush's false return alone keeps the tab.
    const failClosed = (): false => {
      const shouldNotify = entry.settleRetryAttempt === null
        || entry.settleRetryAttempt === SETTLE_RETRY_DELAYS_MS.length - 1
      if (anchor !== null && shouldNotify) {
        notifyFamilyMoveSettled(
          owner.vaultId, owner.documentId,
          { oldPath: move.oldPath, newPath: anchor },
          entry.latestSnapshotNeedsWrite
            ? 'moved-write-failed'
            : 'path-authentication-pending',
        )
      }
      if (entry.latestSnapshot && entry.settleRetryAttempt === null) {
        scheduleSettleRetry(
          owner.vaultId,
          owner.documentId,
          entry.generation,
          0,
          { oldPath: move.oldPath, newPath: anchor ?? move.newPath },
        )
      }
      return false
    }

    const revalidate = async (): Promise<CurrentDocumentLocation | null> => {
      try {
        const location = await resolver(owner.vaultId, owner.documentId)
        if (!location || typeof location.path !== 'string'
          || location.path.trim().length === 0) return null
        return location
      } catch {
        return null
      }
    }
    // Converge the family onto `path` via an expected-path CAS from
    // the anchor. The store derives the family's current path from
    // the raw rows inside the same transaction as the move, so the
    // certified answer is always fresh: 'moved' (or a path-mismatch
    // whose certified current path IS the target) adopts `path`; a
    // path-mismatch certifying a DIFFERENT path adopts that one
    // instead; 'missing' (another context cleared the rows) drops the
    // anchor so the next attempt re-mints; anything uncertifiable
    // reports null and the caller consumes the attempt.
    const converge = async (path: string): Promise<string | null> => {
      if (anchor === null) return null
      if (anchor === path) return anchor
      const outcome = await store.moveDraftFamilyIfAtPath(
        owner.vaultId, owner.documentId, anchor, path,
      )
      if ((!allowDisposed && disposed) || !current(owner, entry)) return null
      if (outcome.status === 'moved') {
        setAnchor(path)
        return path
      }
      if (outcome.status === 'path-mismatch') {
        setAnchor(outcome.currentPath)
        return outcome.currentPath
      }
      if (outcome.status === 'missing') {
        anchor = null
        recovery.anchorPath = null
      }
      return null
    }

    // A primary write can fail closed after preserving the bytes as a
    // conflict candidate. Its boolean result deliberately does not
    // certify a primary write, so empty-family authentication must ask
    // the store where the resulting family actually lives. This also
    // covers a family minted by another context between our initial
    // `none` probe and first write. The probe's familyPath is the only
    // safe recovery anchor; the resolver path is merely the server
    // target we still need to converge toward.
    const adoptStoredFamilyAnchor = async (): Promise<boolean> => {
      let probe: Awaited<ReturnType<DraftStore['probeDraftFamily']>>
      try {
        probe = await store.probeDraftFamily(owner.vaultId, owner.documentId)
      } catch {
        return false
      }
      if ((!allowDisposed && disposed) || !current(owner, entry)) return false
      if (probe.status !== 'path') return false
      setAnchor(probe.familyPath)
      return true
    }

    /** Persist recovery bytes at the store-certified anchor without
     *  changing their ownership channel. A failed first-mint candidate
     *  pins move-indeterminate.conflict; every later authentication
     *  attempt must keep writing candidates and may never promote those
     *  bytes to a primary record merely because the family path has now
     *  been authenticated. */
    const persistRecoveryContentAtAnchor = async (
      snapshot: DraftBufferSnapshot,
      path: string,
    ): Promise<boolean> => {
      const mode = entry.mode
      const conflict = mode.kind === 'conflict'
        ? {
            conflictId: mode.conflictId,
            crossContextUpdatedAt: mode.crossContextUpdatedAt,
          }
        : mode.kind === 'move-quarantine' || mode.kind === 'move-indeterminate'
          ? mode.conflict
          : null
      return conflict
        ? writeConflict(
            owner,
            snapshot,
            path,
            conflict.conflictId,
            conflict.crossContextUpdatedAt,
            allowDisposed,
          )
        : writePrimary(owner, snapshot, path, allowDisposed)
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      if ((!allowDisposed && disposed) || !current(owner, entry)) return failClosed()

      // (1) Query the server's current path by stable identity —
      // never a cached tree / Tab / posts path. A failure here fails
      // closed: nothing is ever minted at the stale serverPath.
      const resolved = await revalidate()
      if ((!allowDisposed && disposed) || !current(owner, entry)) return failClosed()
      if (!resolved) return failClosed()

      if (anchor === null) {
        // (2a) First mint: the store holds no row for this identity,
        // so a write at the re-validated path cannot split anything.
        entry.persistedDraft = null
        const latest = entry.latestSnapshot
        if (!latest || !entry.latestSnapshotNeedsWrite) {
          // `needsWrite=false` may mean writePrimary preserved the
          // latest bytes as a candidate before returning false. Never
          // infer an empty family from the in-memory flag: re-probe and
          // adopt the store-certified family path before authenticating.
          if (!await adoptStoredFamilyAnchor()) return failClosed()
          if (await converge(resolved.path) === null) return failClosed()
          // Continue to the post-write server authentication below.
        } else {
          // Mint directly at the resolver path while retaining the
          // move-indeterminate/authentication state. Routing through
          // runResolvedTarget here would recurse into this recovery;
          // switching to primary before the write would let a failed
          // mint's retry bypass server authentication.
          latest.documentPath = resolved.path
          const writeSucceeded = await persistRecoveryContentAtAnchor(
            cloneSnapshot(latest),
            resolved.path,
          )
          if (!writeSucceeded) {
            // A false primary result can still mean the bytes became a
            // durable candidate at a family path established by another
            // context. Adopt that certified path and keep authenticating;
            // only a genuinely unwritten snapshot fails here.
            const adopted = await adoptStoredFamilyAnchor()
            if (!adopted || entry.latestSnapshotNeedsWrite) {
              const shouldNotify = entry.settleRetryAttempt === null
                || entry.settleRetryAttempt === SETTLE_RETRY_DELAYS_MS.length - 1
              if (anchor === null && shouldNotify) {
                notifyFamilyMoveSettled(
                  owner.vaultId, owner.documentId,
                  { oldPath: move.oldPath, newPath: resolved.path },
                  'moved-write-failed',
                )
              }
              return failClosed()
            }
          } else {
            setAnchor(resolved.path)
          }
        }
      } else {
        // (2b) The family already sits at the anchor (written by an
        // earlier attempt): converge it onto the fresh server path
        // via the expected-path CAS — never a blind save.
        if (await converge(resolved.path) === null) {
          if ((!allowDisposed && disposed) || !current(owner, entry)) return failClosed()
          continue
        }
      }

      // Authentication never substitutes for content persistence. A
      // newer editor revision may arrive after the anchor was minted
      // (or while its CAS convergence awaited IndexedDB). Persist that
      // exact latest snapshot at the current anchor before asking the
      // server to authenticate the path.
      if (anchor !== null && entry.latestSnapshotNeedsWrite) {
        const latest = entry.latestSnapshot
        if (!latest) return failClosed()
        latest.documentPath = anchor
        const writeSucceeded = await persistRecoveryContentAtAnchor(
          cloneSnapshot(latest),
          anchor,
        )
        if (!writeSucceeded) return failClosed()
        setAnchor(anchor)
      }

      // (3) Revalidate: the server query AFTER the write / convergence
      // is what authenticates the path the family now sits at.
      const recheck = await revalidate()
      if ((!allowDisposed && disposed) || !current(owner, entry)) return failClosed()
      if (!recheck) continue
      if (recheck.path === anchor && !entry.latestSnapshotNeedsWrite) {
        notifyFamilyMoveSettled(
          owner.vaultId, owner.documentId,
          { oldPath: move.oldPath, newPath: anchor },
          'moved-and-persisted',
        )
        completeFamilyMove(entry, anchor)
        return true
      }

      // (4) The path changed between the write and the revalidation —
      // converge the just-written family onto the newest server path
      // and authenticate ONCE more.
      const converged = await converge(recheck.path)
      if (converged === null) {
        if ((!allowDisposed && disposed) || !current(owner, entry)) return failClosed()
        continue
      }
      const finalCheck = await revalidate()
      if ((!allowDisposed && disposed) || !current(owner, entry)) return failClosed()
      if (finalCheck
        && finalCheck.path === converged
        && !entry.latestSnapshotNeedsWrite) {
        notifyFamilyMoveSettled(
          owner.vaultId, owner.documentId,
          { oldPath: move.oldPath, newPath: converged },
          'moved-and-persisted',
        )
        completeFamilyMove(entry, converged)
        return true
      }
      // Still changing — the bounded second attempt re-resolves fresh.
    }

    // (5) Bound exhausted under continuous change: fail closed. With
    // a mint landed, the bytes persist at the last server-
    // authoritative path reached and the settlement keeps the tab
    // open; without one, nothing was written anywhere.
    return failClosed()
  }

  /** Retry the atomic family move for a quarantined / move-indeterminate
   *  entry (the server rename succeeded, the tab already shows
   *  `newPath`). A plain primary write at newPath would move ONLY the
   *  primary record there (DraftStore accepts the higher-`updatedAt`
   *  draft's path wholesale), stranding the conflict candidates on
   *  the old one — the exact split the atomic family move exists to
   *  prevent. So the write retries the atomic move FIRST — but NEVER
   *  blindly:
   *  - certified `oldPath` (move-quarantine) → the move is a CAS:
   *    moveDraftFamilyIfAtPath moves the family ONLY while it still
   *    sits at oldPath. A chained rename in another window (A: A→B
   *    succeeded on the server but the draft move failed; B: B→C
   *    succeeded whole) leaves the family at C — a blind move would
   *    drag it back to B, violating "the server file operation is
   *    always authoritative" (and B may already be reused by another
   *    document). The CAS returns path-mismatch with the certified
   *    current path instead, and the retry adopts THAT path
   *    (adoptCertifiedFamilyAtCurrentPath) — nothing moves;
   *  - `oldPath` null (move-indeterminate) → there is no trustworthy
   *    expected path, so the retry must NEVER move anything: it
   *    re-verifies the family's current state with a strict read-only
   *    probe first. Only a certified result acts — the family already
   *    at newPath heals in memory, a family certified at a different
   *    path is adopted there, and an EMPTIED family is handed to
   *    recoverEmptiedFamily (a bounded resolve → write → revalidate
   *    → expected-path CAS flow keyed on a by-stable-identity server
   *    query, authenticating the mint AFTER the write because another
   *    window may rename AGAIN between the query and the write);
   *    absent / throwing / empty resolution and continuous change
   *    past the bound fail closed (the absence of draft rows
   *    certifies no server path); an uncertifiable / unread family
   *    fails closed (write NOTHING) until the next probe;
   *  - move succeeds → the quarantine lifts via completeFamilyMove
   *    (mode, snapshot path, persistedDraft path and conflict pin
   *    switch to newPath as ONE change) and the latest snapshot
   *    persists on the entry's active channel at the new path, family
   *    whole (a candidate recorded by an earlier failed retry travels
   *    with it);
   *  - CAS unsupported / failed + certified `oldPath` → the primary
   *    record is never touched; the latest content persists as a
   *    separate move-quarantine candidate AT `oldPath` (the family's
   *    actual path — persisting it at the renamed tab path would split
   *    the family immediately), the quarantine stays, and the next
   *    edit / flush / pagehide / dispose retries the move again. */
  async function executeFamilyMoveRetry(
    owner: DraftOwner,
    snapshot: DraftBufferSnapshot,
    move: { oldPath: string | null; newPath: string },
    allowDisposed: boolean,
  ): Promise<boolean> {
    const entry = entries.get(key(owner.vaultId, owner.documentId))
    if (!entry || (!allowDisposed && disposed) || !current(owner, entry)) return false
    let movedStatus: 'moved' | 'missing' | null = null
    if (move.oldPath !== null) {
      // Certified expected path: the CAS move. The store derives the
      // family's current path from the raw rows inside the same
      // transaction as the move, so a verified rename committed by
      // another context can never slip between — the move either runs
      // against a family still sitting at oldPath, or refuses and
      // certifies where the family actually lives now.
      const outcome = await store.moveDraftFamilyIfAtPath(
        owner.vaultId,
        owner.documentId,
        move.oldPath,
        move.newPath,
      )
      if ((!allowDisposed && disposed) || !current(owner, entry)) return false
      if (outcome.status === 'moved') movedStatus = 'moved'
      else if (outcome.status === 'missing') movedStatus = 'missing'
      else if (outcome.status === 'path-mismatch') {
        // The family no longer sits at the quarantine's certified
        // oldPath — another context's verified rename moved it. Nothing
        // moved (the CAS refused); adopt the certified current path
        // instead of ever retrying the stale serverPath.
        return adoptCertifiedFamilyAtCurrentPath(
          owner, entry, move, outcome.currentPath, allowDisposed,
        )
      }
      // 'unsupported' / 'failed' fall through to the failure branch
      // below (movedStatus stays null): with a certified oldPath the
      // latest content still persists there as a move-quarantine
      // candidate and the quarantine keeps retrying.
    } else {
      // Move-indeterminate: no trustworthy expectedFamilyPath exists,
      // so this retry must NEVER blind-move "whatever is there" toward
      // the stale serverPath. Re-verify the family's current state
      // first and act only on a certified result.
      const probe = await store.probeDraftFamily(owner.vaultId, owner.documentId)
      if ((!allowDisposed && disposed) || !current(owner, entry)) return false
      if (probe.status === 'failed') {
        // The store could not be read — that is not an empty family.
        // Fail closed: write nothing, move nothing, try again next flush.
        return false
      }
      if (probe.status === 'unsupported') {
        // The family still cannot be certified (split / unreadable
        // rows): stay move-indeterminate (serverPath preserved) and
        // fail closed — no path a candidate could safely join.
        markFamilyIndeterminate(entry, null, probe.reason)
        return false
      }
      if (probe.status === 'none') {
        // The family is gone entirely from the store — there is
        // nothing to move and nothing to adopt, and the absence of
        // every draft row is NOT a server-path verdict: another
        // window may have renamed the document again (serverPath→C)
        // and cleared its draft rows, and this retry's stale
        // serverPath may even have been reused by another document.
        // recoverEmptiedFamily re-validates the document's current
        // server path by stable identity, mints the pending snapshot
        // there, and AUTHENTICATES the mint against a second server
        // query (the path can race between the query and the write),
        // converging the just-written family via an expected-path
        // CAS when it drifts. Absent / throwing / empty resolution
        // and continuous change past the bound fail closed — nothing
        // is ever minted at the stale serverPath.
        return recoverEmptiedFamily(owner, entry, move, allowDisposed)
      } else if (probe.familyPath === move.newPath) {
        // The family is already verified AT the rename's server target
        // (healed by a later move that caught it up) — no store move
        // needed; heal in memory and persist the pending snapshot on
        // the certified path.
        movedStatus = probe.hasPrimary ? 'moved' : 'missing'
      } else {
        // The family is certified at a path that is neither the stale
        // serverPath nor anywhere this retry may move it from: the
        // server file operation is authoritative — adopt the certified
        // path instead of dragging the family to the stale target.
        return adoptCertifiedFamilyAtCurrentPath(
          owner, entry, move, probe.familyPath, allowDisposed,
        )
      }
    }
    if (movedStatus !== null) {
      // The move that actually completed at the retry's certified
      // target (the emptied-family case is self-contained in
      // recoverEmptiedFamily and never reaches here).
      const settledMove = move
      // The store state changed — lift the quarantine FIRST so a
      // superseding edit (its owner check fails below) persists
      // normally on the new path instead of re-running the move.
      // completeFamilyMove switches the mode, the snapshot path, the
      // persistedDraft path and the conflict pin to the settled path
      // as ONE atomic transition.
      completeFamilyMove(entry, move.newPath)
      if (movedStatus === 'missing') {
        // Conflict-only family: no primary record exists to certify a
        // persisted draft against.
        entry.persistedDraft = null
      } else {
        try {
          const fresh = await store.getDraft(owner.vaultId, owner.documentId)
          if (fresh) {
            entry.persistedDraft = fresh
          }
          // A null readback after a verified move is a store hiccup,
          // not an absence — keep the completeFamilyMove-updated
          // record instead of losing the new path.
        } catch {
          // Same rationale.
        }
      }
      if ((!allowDisposed && disposed) || !current(owner, entry)) {
        // The family is whole on the new path even though we can't
        // observe the latest snapshot — Recovery must still follow
        // it. The 'moved-write-failed' settlement signals "family
        // moved but persistence not verified" so the owner keeps
        // the tab open (the only surface still possibly holding
        // unpersisted bytes) while refreshing Recovery.
        notifyFamilyMoveSettled(
          owner.vaultId, owner.documentId, settledMove, 'moved-write-failed',
        )
        return false
      }
      const latest = entry.latestSnapshot
      if (!latest || !entry.latestSnapshotNeedsWrite) {
        // No pending snapshot to write — the family moved and the
        // move itself is the durable change. Recovery must follow.
        notifyFamilyMoveSettled(
          owner.vaultId, owner.documentId, settledMove, 'moved-and-persisted',
        )
        return true
      }
      // Resolve the channel AFTER the lift: conflict-pinned entries
      // write their candidate at newPath, everything else the primary
      // record — both on the family's new path.
      const writeSucceeded = await runResolvedTarget(owner, entry, cloneSnapshot(latest), allowDisposed)
      // The family moved in the background, after the rename
      // transaction already refreshed Recovery against the failed
      // state — notify AFTER the final write completes so the
      // owner refreshes Recovery against the actual durable state
      // (not a transient "moved but not yet persisted" snapshot).
      notifyFamilyMoveSettled(
        owner.vaultId, owner.documentId, settledMove,
        writeSucceeded ? 'moved-and-persisted' : 'moved-write-failed',
      )
      if (!writeSucceeded) {
        // The settlement toast promises the save retries
        // automatically — make it true: arm a bounded backoff retry
        // so the latest snapshot re-persists without waiting for
        // user input, manual flush or pagehide. Each retry
        // re-resolves the channel at fire time (queueTargetWrite),
        // and a superseding edit clears the timer (schedule() →
        // clearTimer) and resets the backoff — the new edit's own
        // write owns persistence from there. A retry that succeeds
        // reports 'moved-and-persisted' so the owner refreshes
        // Recovery against the durable state.
        scheduleSettleRetry(owner.vaultId, owner.documentId, entry.generation, 0, settledMove)
      }
      return writeSucceeded
    }
    // The CAS retry failed ('unsupported' / 'failed') with a certified
    // oldPath. (Move-indeterminate retries — `oldPath` null — are
    // handled by the probe above and never reach this branch; the guard
    // below is defensive dead code: without a certified path there is
    // no path a candidate could join, so write NOTHING and fail closed.)
    if (move.oldPath === null) {
      return false
    }
    // The family stays whole at the OLD path. Never write the primary
    // record: persist the latest content as a separate move-quarantine
    // candidate so Recovery shows it next to the old family, and keep
    // the quarantine so the next edit retries the move again.
    if (entry.mode.kind === 'move-quarantine' && entry.mode.conflict !== null) {
      // Conflict-pinned entries stay on their existing channel — the
      // pinned familyPath IS oldPath.
      const pin = entry.mode.conflict
      return writeConflict(
        owner,
        snapshot,
        move.oldPath,
        pin.conflictId,
        pin.crossContextUpdatedAt,
        allowDisposed,
      )
    }
    const latest = entry.latestSnapshot
    if (!latest) return false
    const capturedRef = latest
    const capturedRevision = latest.revision
    const record = buildConflictRecord(
      latest,
      entry,
      {
        vaultId: owner.vaultId,
        documentId: owner.documentId,
        // The candidate must join the family where it actually is —
        // `oldPath`, whole and unmoved. `latest.documentPath` is the
        // renamed Tab's path (usually newPath): pinning the
        // candidate there would split the family immediately — the
        // primary record and any existing candidates stay at oldPath
        // while the new candidate lands on newPath, exactly the
        // split the quarantine exists to prevent.
        documentPath: move.oldPath,
      },
      null,
      'move-conflict',
    )
    const attempt = await attemptCandidateWrite(record)
    if (attempt.kind === 'path-mismatch') {
      // Another context moved the family between the failed retry and
      // this candidate write. The certified current path supersedes
      // the quarantine's stale serverPath — the quarantine is
      // DISCARDED: the pending content persists as a move-conflict
      // candidate AT the certified path and the entry pins to the
      // plain conflict channel there (or failed:@path if even that
      // write cannot complete). Adopting the path alone and keeping
      // the quarantine alive would let a later flush retry the stale
      // move — a CAS re-derived against the family's real path would
      // then drag the family back to the old server target.
      if (current(owner, entry)) {
        return adoptCertifiedFamilyAtCurrentPath(
          owner, entry, move, attempt.familyPath, allowDisposed,
        )
      }
      return false
    }
    if (attempt.kind === 'unsupported') {
      // The family turned uncertifiable mid-quarantine: convert to
      // move-indeterminate — the move retry keeps running toward
      // newPath, but no candidate may be written until it completes
      // or a probe re-certifies the family.
      if (current(owner, entry)) {
        markFamilyIndeterminate(entry, null, attempt.reason)
      }
      return false
    }
    const saved = attempt.kind === 'saved'
    if (saved) {
      // A new candidate now sits next to the old family — notify so
      // Recovery shows it even though the move is still failing.
      notifyFamilyMoveSettled(owner.vaultId, owner.documentId, move, 'conflict')
    }
    if (saved
      && current(owner, entry)
      && entry.mode.kind === 'move-quarantine'
      && entry.latestSnapshot === capturedRef
      && entry.latestSnapshot.revision === capturedRevision) {
      entry.latestSnapshotNeedsWrite = false
      return true
    }
    return false
  }

  function schedule(snapshot: DraftBufferSnapshot): DraftOwner | null {
    if (disposed
      || snapshot.loaded === false
      || isManagedDiaryPath(snapshot.documentPath.replace(/\.md$/, ''))
      || !validIdentity(snapshot.vaultId, snapshot.documentId)
      || snapshot.documentPath.trim().length === 0) {
      return null
    }
    const captured = cloneSnapshot(snapshot)
    const entry = entryFor(captured.vaultId, captured.documentId)
    clearTimer(entry)
    entry.settleRetryAttempt = null
    entry.generation += 1
    entry.latestSnapshot = captured
    entry.latestSnapshotNeedsWrite = true
    // A user edit re-arms the probe: an indeterminate entry (an
    // unsupported save with no certifiable family path) gets ONE real
    // store probe on its next debounce — the save attempt itself IS
    // the probe, and its structured outcome re-derives the family
    // state (the family may have been healed server-side — a
    // migration, a fresh cross-context write — since the block was
    // set). Deliberately NOT a flip back to primary mode: the family
    // is still unverified, and a failed probe must clear the pending
    // flag and block again rather than keep hammering the store on
    // every flush / pagehide. Conflict pins, quarantines,
    // move-indeterminate retries and clean primary channels are
    // untouched: their own transitions own their lifecycle. This also
    // resets a running settle-retry backoff — the armed timer is
    // cleared above and the new edit's own write owns persistence
    // from here.
    if (entry.mode.kind === 'indeterminate') {
      entry.mode = { ...entry.mode, reprobePending: true }
    }
    const owner: DraftOwner = {
      vaultId: captured.vaultId,
      documentId: captured.documentId,
      generation: entry.generation,
    }
    if (!entry.fileTransaction) {
      entry.timer = setTimeout(() => {
        entry.timer = null
        // Resolve the write target AT TIMER FIRE time, not at schedule
        // time (see resolveDraftWriteTarget). A user edit can land
        // while an earlier readback-conflict handoff is still
        // mid-flight and pin the conflict channel between schedule()
        // and the timer firing — a channel captured up-front would
        // let a primary write overwrite the cross-context record that
        // won the CAS, exactly the race the conflict channel exists
        // to prevent. The same applies to the quarantine: a previous
        // (failed) family move can resolve before the timer fires,
        // and a stale schedule-time decision would route the write
        // through the now-obsolete path. queueTargetWrite resolves
        // inside the queued task, after any in-flight write settled.
        void queueTargetWrite(owner, captured)
      }, debounceMs)
    }
    return owner
  }

  async function flush(
    vaultId: string,
    documentId: string,
    allowDisposed = false,
  ): Promise<boolean> {
    const entry = entries.get(key(vaultId, documentId))
    if (!entry || (!allowDisposed && disposed)) return false
    if (isManagedDiaryPath(entry.latestSnapshot?.documentPath?.replace(/\.md$/, '') ?? entry.persistedDraft?.documentPath?.replace(/\.md$/, '') ?? '')) {
      clearTimer(entry)
      entry.latestSnapshot = null
      entry.latestSnapshotNeedsWrite = false
      // Do not delete a legacy managed record; D8.4 owns explicit discard.
      requestInactiveEntryRelease(entry)
      return false
    }
    if (entry.fileTransaction) return false
    clearTimer(entry)
    const snapshot = entry.latestSnapshot
    // No snapshot: a conflict-pinned entry (or a quarantine /
    // move-indeterminate entry carrying a conflict pin) holds its
    // bytes in the conflict store — clean. Anything else has nothing
    // persisted — fail closed.
    if (!snapshot) {
      return entry.mode.kind === 'conflict'
        || (entry.mode.kind === 'move-quarantine' && entry.mode.conflict !== null)
        || (entry.mode.kind === 'move-indeterminate' && entry.mode.conflict !== null)
    }
    // A successful mint can make the bytes durable while the path is
    // still unauthenticated. Never let that state masquerade as clean:
    // every flush must re-enter the resolver/CAS authentication loop.
    if (!entry.latestSnapshotNeedsWrite && entry.emptyFamilyRecovery === null) {
      return true
    }
    // The single router picks the channel: conflict-pinned entries
    // persist a still-pending snapshot as a conflict record (never the
    // primary record — a primary write would mint a fresh
    // `safeTimestamp()` and overwrite the cross-context record),
    // quarantined snapshots route through the family-move retry (or
    // write at the family's actual path), indeterminate entries block
    // fail-closed, everything else writes primary. Skipping the
    // channel state here would drop an in-debounce conflict-channel
    // edit on pagehide/dispose — the bytes would exist neither in the
    // primary store nor the conflict store.
    const owner = { vaultId, documentId, generation: entry.generation }
    return queueTargetWrite(owner, cloneSnapshot(snapshot), allowDisposed)
  }

  async function flushAllInternal(allowDisposed = false): Promise<boolean> {
    const results = await Promise.all([...entries.entries()].map(async ([serialized, entry]) => {
      if (isManagedDiaryPath(entry.latestSnapshot?.documentPath?.replace(/\.md$/, '') ?? entry.persistedDraft?.documentPath?.replace(/\.md$/, '') ?? '')) {
        clearTimer(entry)
        entry.latestSnapshot = null
        entry.latestSnapshotNeedsWrite = false
        requestInactiveEntryRelease(entry)
        return false
      }
      if (!entry.latestSnapshot) {
        if (!entry.pendingWrite) {
          return entry.mode.kind !== 'primary' || entry.persistedDraft === null
        }
        const settled = await entry.pendingWrite.catch(() => false)
        if (!settled) return false
        // A failed primary cleanup can leave the previously persisted draft
        // attached to an otherwise empty entry. Treat that as an unresolved
        // transition rather than claiming the channel is durable merely
        // because the delete promise has settled.
        return entry.mode.kind !== 'primary' || entry.persistedDraft === null
      }
      // Delegate to `flush()`, which picks the right channel per entry:
      // conflict-pinned entries persist a still-pending snapshot as a
      // conflict record (never the primary record — a primary write
      // would mint a fresh `safeTimestamp()` and overwrite the cross-
      // context record), while normal entries write primary. Skipping
      // conflict-pinned entries here would drop an in-debounce
      // conflict-channel edit on pagehide/dispose — the bytes would
      // exist neither in the primary store nor the conflict store.
      const [vaultId, documentId] = JSON.parse(serialized) as [string, string]
      const result = await flush(vaultId, documentId, allowDisposed)
      // A channel can already have a settled snapshot while its previous
      // store operation is still in flight (for example markClean/delete).
      // Await that operation as well so auth transitions never tear down the
      // workspace between the snapshot decision and the durable write.
      const pending = entry.pendingWrite
      if (pending) return result && await pending.catch(() => false)
      return result
    }))
    return results.every(Boolean)
  }

  /** Arm a bounded backoff retry after a failed settlement. This owns
   *  the sole retry budget for both content-write failures and durable
   *  families whose path authentication is still pending. Without it
   *  the debounce timer is already consumed and no automatic work
   *  would resume until the user types, flushes or hides the page.
   *  Each attempt re-resolves the write target AT
   *  FIRE time through the mode state machine (queueTargetWrite —
   *  see resolveDraftWriteTarget): a quarantine re-entry, a channel
   *  pin or a superseding edit landing between schedule and fire
   *  routes the write through the current mode, never a stale one.
   *  A retry that SUCCEEDS is reported exactly once: ordinary move
   *  quarantine retries are published by this scheduler, while an
   *  empty-family authentication publishes only after its own final
   *  server revalidation. The retry state is observably cleared — the
   *  write flag is off and no timer remains. The budget is per event
   *  (800ms, 2s, 5s — ~7.8s total) and deliberately NOT extended by
   *  failures: a persistently failing store gets three tries, with no
   *  warning on intermediate attempts and one final warning when the
   *  budget is exhausted. The write flag then stays set for flush /
   *  close seal / pagehide to pick up. A new
   *  user edit clears the timer via schedule() and resets the
   *  backoff; flush and dispose clear it via clearTimer(). */
  function scheduleSettleRetry(
    vaultId: string,
    documentId: string,
    generation: number,
    attempt: number,
    quarantine: { oldPath: string | null; newPath: string } | null,
  ): void {
    const entry = entries.get(key(vaultId, documentId))
    if (!entry || entry.generation !== generation) return
    if (disposed || attempt >= SETTLE_RETRY_DELAYS_MS.length) {
      entry.settleRetryAttempt = null
      return
    }
    if (!entry.latestSnapshot
      || (!entry.latestSnapshotNeedsWrite && entry.emptyFamilyRecovery === null)) {
      entry.settleRetryAttempt = null
      return
    }
    if (entry.timer !== null) return
    entry.settleRetryAttempt = attempt
    entry.timer = setTimeout(() => {
      entry.timer = null
      if (disposed) {
        entry.settleRetryAttempt = null
        return
      }
      const target = entries.get(key(vaultId, documentId))
      if (!target || target.generation !== generation) {
        entry.settleRetryAttempt = null
        return
      }
      if (!target.latestSnapshot
        || (!target.latestSnapshotNeedsWrite && target.emptyFamilyRecovery === null)) {
        target.settleRetryAttempt = null
        return
      }
      const owner = { vaultId, documentId, generation: target.generation }
      const captured = cloneSnapshot(target.latestSnapshot)
      const wasAuthenticatingEmptyFamily = target.emptyFamilyRecovery !== null
      void queueTargetWrite(owner, captured).then((succeeded) => {
        if (succeeded) {
          target.settleRetryAttempt = null
          // Empty-family recovery publishes success only after its own
          // final server revalidation. Other quarantine retries do not
          // have that inner authentication layer, so the scheduler owns
          // their success settlement.
          if (quarantine && !wasAuthenticatingEmptyFamily) {
            notifyFamilyMoveSettled(
              vaultId,
              documentId,
              quarantine,
              'moved-and-persisted',
            )
          }
          return
        }
        scheduleSettleRetry(vaultId, documentId, generation, attempt + 1, quarantine)
      }).catch(() => {
        scheduleSettleRetry(vaultId, documentId, generation, attempt + 1, quarantine)
      })
    }, SETTLE_RETRY_DELAYS_MS[attempt])
  }

  async function deleteOwned(
    owner: DraftOwner,
    explicitExpected?: UnsavedDraft,
  ): Promise<boolean> {
    const entry = entries.get(key(owner.vaultId, owner.documentId))
    if (!current(owner, entry)) return false
    clearTimer(entry)
    const previous = entry.pendingWrite
    if (previous) await previous.catch(() => false)
    // Waiting for an in-flight write must not invalidate its ownership before
    // it can record the exact persisted draft. Conversely, any schedule that
    // occurs while waiting advances the generation and owns all newer work.
    if (!current(owner, entry)) return false
    const expected = explicitExpected ?? entry.persistedDraft

    const deleteGeneration = ++entry.generation
    entry.latestSnapshot = null
    entry.latestSnapshotNeedsWrite = false
    // A clean/discarded buffer must still relinquish its in-memory snapshot
    // when no record was persisted. It simply has no cross-context authority
    // to delete anything from the store.
    if (!expected) {
      requestInactiveEntryRelease(entry)
      return false
    }
    entry.releaseWhenInactive = true
    const task = (async () => {
      if (entry.generation !== deleteGeneration || entry.latestSnapshot !== null) {
        return false
      }
      // Runtime ownership is not enough to delete a cross-context record.
      // Only the exact draft this coordinator persisted or adopted may be
      // removed; an absent ownership record fails closed.
      if (!expected) return false
      try {
        const result = await store.deleteDraftIfUnchanged(expected)
        const deleted = result.status === 'deleted' || result.status === 'missing'
        if (deleted
          && entry.generation === deleteGeneration
          && entry.persistedDraft
          && draftsEqual(entry.persistedDraft, expected)) {
          entry.persistedDraft = null
        }
        return deleted
      } catch {
        return false
      }
    })()
    entry.pendingWrite = task
    void task.finally(() => {
      if (entry.pendingWrite === task) {
        entry.pendingWrite = null
        releaseInactiveEntry(entry)
      }
    })
    return task
  }

  async function markClean(
    owner: DraftOwner,
    acknowledgedRevision: number,
  ): Promise<void> {
    const entry = entries.get(key(owner.vaultId, owner.documentId))
    if (!current(owner, entry)
      || entry.latestSnapshot?.revision !== acknowledgedRevision) {
      return
    }
    await deleteOwned(owner)
  }

  async function returnedToBaseline(vaultId: string, documentId: string): Promise<void> {
    if (!validIdentity(vaultId, documentId)) return
    const entry = entryFor(vaultId, documentId)
    const owner = { vaultId, documentId, generation: entry.generation }
    await deleteOwned(owner)
  }

  function invalidate(vaultId: string, documentId: string): void {
    if (!validIdentity(vaultId, documentId)) return
    const entry = entryFor(vaultId, documentId)
    clearTimer(entry)
    entry.generation += 1
    entry.latestSnapshot = null
    entry.latestSnapshotNeedsWrite = false
    requestInactiveEntryRelease(entry)
  }

  function invalidateOwner(owner: DraftOwner): void {
    const entry = entries.get(key(owner.vaultId, owner.documentId))
    if (!current(owner, entry)) return
    clearTimer(entry)
    entry.generation += 1
    entry.latestSnapshot = null
    entry.latestSnapshotNeedsWrite = false
    requestInactiveEntryRelease(entry)
  }

  function clearSensitiveState(): void {
    for (const entry of entries.values()) {
      const modePaths = entry.mode.kind === 'conflict'
        ? [entry.mode.familyPath]
        : entry.mode.kind === 'move-quarantine'
          ? [entry.mode.familyPath, entry.mode.serverPath]
          : entry.mode.kind === 'move-indeterminate'
            ? [entry.mode.serverPath]
            : []
      const candidatePaths = [
        entry.latestSnapshot?.documentPath,
        entry.persistedDraft?.documentPath,
        entry.emptyFamilyRecovery?.move.oldPath,
        entry.emptyFamilyRecovery?.move.newPath,
        entry.emptyFamilyRecovery?.anchorPath,
        ...modePaths,
      ]
      if (!candidatePaths.some((value) => (
        typeof value === 'string'
        && isManagedDiaryPath(value.replace(/\.md$/, ''))
      ))) continue
      clearTimer(entry)
      // Advance the owner generation before dropping buffers. Any already
      // queued async store operation must therefore fail its ownership check
      // and cannot republish a managed plaintext snapshot after teardown.
      entry.generation += 1
      entry.latestSnapshot = null
      entry.latestSnapshotNeedsWrite = false
      entry.persistedDraft = null
      entry.emptyFamilyRecovery = null
      entry.fileTransaction = null
      entry.settleRetryAttempt = null
      enterPrimaryMode(entry)
      requestInactiveEntryRelease(entry)
    }
  }

  async function discard(owner: DraftOwner): Promise<boolean> {
    if (disposed) return false
    return deleteOwned(owner)
  }

  async function discardIdentity(vaultId: string, documentId: string): Promise<boolean> {
    if (disposed || !validIdentity(vaultId, documentId)) return false
    const entry = entryFor(vaultId, documentId)
    return deleteOwned({ vaultId, documentId, generation: entry.generation })
  }

  async function discardIdentityIfUnchanged(expected: UnsavedDraft): Promise<boolean> {
    if (disposed || !isUnsavedDraft(expected) || isManagedDiaryPath(expected.documentPath.replace(/\.md$/, ''))) return false
    const entry = entryFor(expected.vaultId, expected.documentId)
    return deleteOwned({
      vaultId: expected.vaultId,
      documentId: expected.documentId,
      generation: entry.generation,
    }, expected)
  }

  async function discardConflict(
    vaultId: string,
    documentId: string,
    conflictId: string,
  ): Promise<boolean> {
    if (disposed || !validIdentity(vaultId, documentId) || conflictId.trim().length === 0) {
      return false
    }
    const result = await store.deleteConflictDraft(vaultId, documentId, conflictId)
    return result === 'deleted' || result === 'missing'
  }

  async function adoptRecoveredDraft(
    expected: UnsavedDraft,
    snapshot: DraftBufferSnapshot,
  ): Promise<DraftOwner | null> {
    if (disposed
      || !isUnsavedDraft(expected)
      || isManagedDiaryPath(expected.documentPath.replace(/\.md$/, ''))
      || isManagedDiaryPath(snapshot.documentPath.replace(/\.md$/, ''))
      || snapshot.loaded === false
      || expected.vaultId !== snapshot.vaultId
      || expected.documentId !== snapshot.documentId
      || !validIdentity(snapshot.vaultId, snapshot.documentId)) {
      return null
    }
    const entry = entryFor(expected.vaultId, expected.documentId)
    if (entry.timer !== null
      || entry.pendingWrite !== null
      || entry.latestSnapshotNeedsWrite
      || entry.latestSnapshot !== null) {
      return null
    }
    const expectedGeneration = entry.generation
    const expectedTimer = entry.timer
    const expectedPendingWrite = entry.pendingWrite
    const expectedSnapshot = entry.latestSnapshot
    const entryIsUnchanged = () =>
      entry.generation === expectedGeneration
      && entry.timer === expectedTimer
      && entry.pendingWrite === expectedPendingWrite
      && entry.latestSnapshot === expectedSnapshot
      && !entry.latestSnapshotNeedsWrite

    let stored: UnsavedDraft | null
    try {
      stored = await store.getDraft(expected.vaultId, expected.documentId)
    } catch {
      return null
    }
    if (disposed
      || !entryIsUnchanged()
      || !stored
      || !draftsEqual(stored, expected)) {
      return null
    }

    // Recheck the stored record across a second asynchronous boundary. Local
    // entry state is observed, never cleared: concurrent edits own their timer
    // and generation and make this adoption fail closed.
    try {
      stored = await store.getDraft(expected.vaultId, expected.documentId)
    } catch {
      return null
    }
    if (disposed
      || !entryIsUnchanged()
      || !stored
      || !draftsEqual(stored, expected)) {
      return null
    }
    entry.generation += 1
    entry.latestSnapshot = cloneSnapshot(snapshot)
    entry.latestSnapshotNeedsWrite = false
    entry.previousUpdatedAt = expected.updatedAt
    entry.createdAt = expected.createdAt
    entry.persistedDraft = expected
    return {
      vaultId: expected.vaultId,
      documentId: expected.documentId,
      generation: entry.generation,
    }
  }

  async function prepareFileMutation(
    identities: readonly DraftDocumentIdentity[],
  ): Promise<DraftFileMutationBarrier> {
    const token = Symbol('draft-file-transaction')
    const held = new Map<string, {
      identity: DraftDocumentIdentity
      entry: DraftEntry
      confirmedDraft: UnsavedDraft | null
      preparedGeneration: number
    }>()

    for (const identity of identities) {
      if (isManagedDiaryPath(identity.documentPath.replace(/\.md$/, ''))) continue
      if (!validIdentity(identity.vaultId, identity.documentId)) continue
      const entry = entryFor(identity.vaultId, identity.documentId)
      if (entry.fileTransaction) continue
      clearTimer(entry)
      entry.fileTransaction = token
      held.set(key(identity.vaultId, identity.documentId), {
        identity: { ...identity },
        entry,
        confirmedDraft: null,
        preparedGeneration: entry.generation,
      })
    }
    await Promise.all([...held.values()].map(async ({ entry }) => {
      if (entry.pendingWrite) await entry.pendingWrite.catch(() => false)
    }))
    for (const state of held.values()) {
      if (state.entry.fileTransaction !== token) continue
      state.confirmedDraft = state.entry.persistedDraft
        ?? await store.getDraft(
          state.identity.vaultId,
          state.identity.documentId,
        ).catch(() => null)
      state.preparedGeneration = state.entry.generation
    }

    let settled = false
    let finalized = false
    let closeSealed = false
    // Identities whose commit already reported 'failed'. Their tabs stay
    // open regardless and their armed debounce retries in the background,
    // so the finalize gates never re-REPORT them — re-running the failure
    // there could only duplicate the user-visible warning.
    // finalizeBeforeDocumentClose skips them outright; finalizeAfterTab-
    // Migration still RELEASES them (their fileTransaction token must not
    // outlive the barrier — without the release, schedule() would never
    // arm a timer again and flush()/pagehide could never persist the
    // entry's subsequent edits), but suppresses the duplicate result.
    const alreadyFailedKeys = new Set<string>()
    const pendingReleases = new Map<string, {
      path: string
      writeLatest: boolean
      documentId: string
      fromPath: string
      toPath?: string
    }>()

    async function releaseEntry(
      state: typeof held extends Map<string, infer V> ? V : never,
      path: string,
      writeLatest: boolean,
      immediate = false,
    ): Promise<DraftReleaseResult> {
      const { entry, identity } = state
      if (entry.fileTransaction !== token) return { status: 'released' }
      entry.fileTransaction = null
      if (entry.latestSnapshot) {
        entry.latestSnapshot = {
          ...entry.latestSnapshot,
          documentPath: path,
        }
      }
      if (!writeLatest
        || !entry.latestSnapshot
        || (!entry.latestSnapshotNeedsWrite && entry.emptyFamilyRecovery === null)) {
        releaseInactiveEntry(entry)
        return { status: 'released' }
      }
      // The single router picks the channel at fire time: a
      // conflict-pinned entry keeps writing conflict candidates
      // (never the primary record, even when released by a file
      // transaction — e.g. a move finalized while in conflict mode),
      // a quarantined entry routes through the family-move retry.
      entry.generation += 1
      const owner = {
        vaultId: identity.vaultId,
        documentId: identity.documentId,
        generation: entry.generation,
      }
      const captured = cloneSnapshot(entry.latestSnapshot)
      if (immediate) {
        // An immediate write must be OBSERVED: it is the last persistence
        // step before the caller reports the transaction result that
        // decides whether the file tab closes. A rejected write leaves
        // the bytes only in-memory — return 'failed' so the caller maps
        // it to a 'failed' transaction result and the lifecycle keeps
        // the tab open (the only surface still holding the content).
        const saved = await queueTargetWrite(owner, captured)
        return saved ? { status: 'persisted' } : { status: 'failed' }
      }
      entry.timer = setTimeout(() => {
        entry.timer = null
        // Resolve the target AT TIMER FIRE time (see schedule() for
        // the full rationale). A handoff can land between the release
        // and the debounce firing — a release-time channel capture
        // could overwrite the cross-context record a prior mid-flight
        // handoff pinned.
        void queueTargetWrite(owner, captured)
      }, debounceMs)
      return { status: 'released' }
    }

    /**
     * Promote a CAS-confirmed-then-superseded local snapshot into a
     * separate conflict record so the in-memory entry cannot later
     * be flushed back to the primary record (which would overwrite
     * the cross-context source via a fresh `safeTimestamp()`).
     *
     * This is the dual-source conflict storage the spec demands: the
     * IndexedDB primary keeps the cross-context draft, the conflict
     * record holds the local orphan, and the entry enters conflict
     * mode so `flush` / `flushAll` / `dispose` keep any later edits
     * on the conflict channel instead of writing primary.
     *
     * The handoff is bounded to TWO saves so it always terminates — a
     * steady typer cannot keep the file transaction / mutation lock
     * open on a moving target — yet it never reports success while
     * the latest bytes are still only in-memory: attempt 1 persists
     * the current snapshot; if a newer edit lands during that save,
     * attempt 2 persists the NEW latest snapshot immediately. An edit
     * that lands during attempt 2 is NOT chased — the handoff fails
     * closed instead, keeping the tab open (the only visible surface)
     * while the armed conflict debounce retries in the background.
     */
    async function persistLocalAsConflict(
      state: typeof held extends Map<string, infer V> ? V : never,
      entry: DraftEntry,
      outcome: string,
      crossContextUpdatedAt: number | null,
    ): Promise<ConflictHandoffResult> {
      const { identity } = state
      // No snapshot → nothing to preserve; the cross-context record
      // stands alone.
      if (!entry.latestSnapshot) {
        await releaseEntry(state, identity.documentPath, false, true)
        return { status: 'persisted', conflictId: '' }
      }
      let lastConflictId = ''
      // Bounded to exactly two attempts — the hard cap is the whole
      // point: an unbounded re-save loop let a slow IndexedDB write
      // plus steady typing keep this transaction open indefinitely.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const snapshot = entry.latestSnapshot
        // The snapshot was invalidated mid-handoff (the buffer was
        // reloaded / discarded) — nothing left to persist.
        if (!snapshot) break
        const capturedGeneration = entry.generation
        const capturedRevision = snapshot.revision
        const capturedRef = snapshot
        const record = buildConflictRecord(snapshot, entry, identity, crossContextUpdatedAt)
        lastConflictId = record.conflictId
        // Family-atomic candidate write: the store validates the
        // identity path against the family's CURRENT rows, so a move
        // committed by another context during the handoff surfaces as
        // path-mismatch instead of stranding the candidate.
        const attempt = await attemptCandidateWrite(record)
        if (attempt.kind === 'path-mismatch') {
          // The family moved during the handoff: pin failed at the
          // certified new path (the background conflict debounce
          // retries there) — writing at the stale identity path would
          // split the family the other context's move just united.
          enterConflictMode(
            entry,
            attempt.familyPath,
            `failed:${record.conflictId}`,
            crossContextUpdatedAt,
          )
          clearTimer(entry)
          console.warn(`[commitDeletes] Conflict candidate path-mismatch for ${identity.documentPath} (family now at ${attempt.familyPath}; ${outcome})`)
          await releaseEntry(state, identity.documentPath, true)
          return { status: 'failed' }
        }
        if (attempt.kind === 'unsupported') {
          // The family turned uncertifiable mid-handoff: fail closed
          // without guessing a side — no candidate, no pin at a
          // guessed path. The release arms the debounce; the entry
          // blocks (or retries its pending move) until a safe probe
          // re-certifies the family.
          markFamilyIndeterminate(entry, null, attempt.reason)
          clearTimer(entry)
          console.warn(`[commitDeletes] Conflict candidate unsupported for ${identity.documentPath} (${outcome})`)
          await releaseEntry(state, identity.documentPath, true)
          return { status: 'failed' }
        }
        if (attempt.kind === 'failed') {
          // Rejected: keep the content in-memory and pin as failed so
          // flush/flushAll/dispose never overwrite the primary record
          // (and retry the conflict write if the store recovers). The
          // release arms the conflict debounce for a background retry
          // while the lifecycle keeps the tab open — it is the only
          // surface still holding these bytes.
          enterConflictMode(
            entry,
            identity.documentPath,
            `failed:${record.conflictId}`,
            crossContextUpdatedAt,
          )
          clearTimer(entry)
          console.warn(`[commitDeletes] Conflict record save failed for ${identity.documentPath} (${outcome})`)
          await releaseEntry(state, identity.documentPath, true)
          return { status: 'failed' }
        }
        const advanced = entry.generation !== capturedGeneration
          || entry.latestSnapshot?.revision !== capturedRevision
          || entry.latestSnapshot !== capturedRef
        if (!advanced) {
          // Stable: the saved record holds the latest content. Pin the
          // entry and drop the in-memory snapshot (it now lives in the
          // conflict store).
          enterConflictMode(
            entry,
            identity.documentPath,
            record.conflictId,
            crossContextUpdatedAt,
          )
          clearTimer(entry)
          entry.latestSnapshot = null
          entry.latestSnapshotNeedsWrite = false
          await releaseEntry(state, identity.documentPath, false, true)
          return { status: 'persisted', conflictId: record.conflictId }
        }
        // Superseded: a newer edit landed during the save. Loop into
        // attempt 2 on the NEW latest snapshot (or fall through to the
        // fail-closed tail once both attempts are spent).
      }
      // Both attempts saved candidates, but the entry kept advancing
      // (or its snapshot vanished mid-handoff): the latest bytes are
      // not verified persisted. Fail closed — pin the conflict channel
      // to the last saved candidate and end the transaction with the
      // debounce armed, so the unpersisted snapshot retries in the
      // background while the tab stays open as the visible surface.
      const existingConflictId = entry.mode.kind === 'conflict'
        ? entry.mode.conflictId
        : entry.mode.kind === 'move-quarantine' && entry.mode.conflict
          ? entry.mode.conflict.conflictId
          : entry.mode.kind === 'move-indeterminate' && entry.mode.conflict
            ? entry.mode.conflict.conflictId
            : null
      const pinId = lastConflictId || existingConflictId
      if (pinId) {
        enterConflictMode(entry, identity.documentPath, pinId, crossContextUpdatedAt)
      }
      clearTimer(entry)
      await releaseEntry(state, identity.documentPath, true)
      return { status: 'failed' }
    }

    async function commitMoves(
      mappings: readonly DraftPathMapping[],
      preserved: readonly DraftDocumentIdentity[] = [],
      mismatched: readonly DraftPathMapping[] = [],
    ): Promise<DraftFileTransactionResult[]> {
      if (settled) return []
      settled = true
      const results: DraftFileTransactionResult[] = []
      const mappedKeys = new Set<string>()
      void preserved
      for (const mapping of mappings) {
        const identityKey = key(mapping.vaultId, mapping.documentId)
        const state = held.get(identityKey)
        if (!state
          || state.entry.fileTransaction !== token
          || state.identity.documentPath !== mapping.fromPath) {
          results.push({
            documentId: mapping.documentId,
            oldPath: mapping.fromPath,
            newPath: mapping.toPath,
            status: 'identity-mismatch',
          })
          continue
        }
        mappedKeys.add(identityKey)
        // Move the primary record and every conflict candidate for this
        // identity in ONE IndexedDB transaction. Conflict records share
        // the documentId identity but live in a separate store; moving
        // them in an independent transaction could leave the primary
        // renamed while conflicts are stranded on the pre-rename path
        // (misclassified as missing-source / identity-mismatch), and a
        // conflict-phase failure used to be silently swallowed while the
        // result still reported 'moved'. The family move fails closed:
        // any error rolls both stores back and surfaces as 'failed',
        // which reportDraftResults turns into a user-visible warning.
        // Conflict candidates travel even when the primary record is
        // 'missing' (conflict-only documents).
        const outcome = await store.moveDraftFamily(
          mapping.vaultId,
          mapping.documentId,
          mapping.toPath,
        )
        const status = outcome.status
        const familyMoved = status === 'moved' || status === 'missing'
        if (!familyMoved) {
          // failed / unsupported / conflict: the server rename already
          // succeeded and the lifecycle WILL migrate the tab to the
          // new path — but the draft family is still whole where it
          // was ('unsupported' means the pre-flight blocked the WHOLE
          // move, so nothing changed; 'failed' means it rolled back).
          // Quarantine the entry on EVERY incomplete status: a later
          // edit made on the new tab path must retry the atomic move
          // before anything writes the primary record there (a plain
          // write would move the primary alone, stranding the
          // conflict candidates on the old path — re-creating exactly
          // the split the family move failed to complete). oldPath is
          // the family's ACTUAL path: a previous quarantine's oldPath
          // when this rename chains onto an earlier failed one (A→B
          // failed leaving the family at A, then B→C fails — the
          // family is at A, not at the mapping's fromPath B).
          if (status === 'failed') alreadyFailedKeys.add(identityKey)
          enterMoveQuarantine(state.entry, mapping.fromPath, mapping.toPath)
        } else {
          // The family moved (or nothing existed to move): any stale
          // quarantine left by an earlier failed rename targeting a
          // different path is obsolete — keeping it would let a later
          // edit retry the move against the OLD target and drag the
          // family back from the path it actually lives on now.
          // completeFamilyMove switches the mode, the snapshot path,
          // the persistedDraft path AND the conflict channel to the
          // new path as ONE atomic transition — leaving any of them
          // on the old path would route the next conflict-channel
          // write (e.g. the release's immediate conflict write) back
          // to the pre-rename path and split the family the move
          // just united.
          completeFamilyMove(state.entry, mapping.toPath)
          if (status === 'moved') {
            state.entry.persistedDraft = await store.getDraft(
              mapping.vaultId,
              mapping.documentId,
            )
          } else {
            // 'missing' (conflict-only family): no primary record
            // exists. completeFamilyMove rewrote the cached
            // persistedDraft onto the new path — but that record is
            // now a PHANTOM: it points at a row the store does not
            // hold. Leaving it would make a confirmed delete CAS
            // against a non-existent primary (reporting 'stale'
            // instead of cleaning the conflict-only family) and lie
            // to captureDeleteConfirmation's expectedDraft. Drop it:
            // the family's candidates at the new path are tracked by
            // the conflict store itself.
            state.entry.persistedDraft = null
          }
        }
        pendingReleases.set(identityKey, {
          // An incomplete move releases on the family's actual path:
          // the transaction-time edit persists where the family is
          // whole, never as a lone primary write at the renamed path.
          path: familyMoved
            ? mapping.toPath
            : (state.entry.mode.kind === 'move-quarantine'
                ? state.entry.mode.familyPath
                : state.identity.documentPath),
          writeLatest: true,
          documentId: mapping.documentId,
          fromPath: mapping.fromPath,
          toPath: mapping.toPath,
        })
        results.push({
          documentId: mapping.documentId,
          oldPath: mapping.fromPath,
          newPath: mapping.toPath,
          status,
        })
      }
      // Identities whose server rename succeeded but whose post-rename
      // identity resolution does not match the draft identity. The
      // barrier attempts NO move for them — the lifecycle reports the
      // identity-mismatch itself — but it still receives the ACTUAL
      // server target path: the tab migrates there, so a later edit
      // made under the stale draft identity must quarantine-and-retry
      // exactly like a failed move instead of writing the primary
      // record alone at the new path (stranding the family on the old
      // one). Released without a result, like preserved identities.
      for (const mapping of mismatched) {
        const identityKey = key(mapping.vaultId, mapping.documentId)
        const state = held.get(identityKey)
        if (!state || state.entry.fileTransaction !== token) continue
        mappedKeys.add(identityKey)
        enterMoveQuarantine(state.entry, mapping.fromPath, mapping.toPath)
        pendingReleases.set(identityKey, {
          path: state.entry.mode.kind === 'move-quarantine'
            ? state.entry.mode.familyPath
            : mapping.fromPath,
          writeLatest: true,
          documentId: mapping.documentId,
          fromPath: mapping.fromPath,
          toPath: mapping.toPath,
        })
      }
      for (const [identityKey, state] of held) {
        if (mappedKeys.has(identityKey)) continue
        pendingReleases.set(identityKey, {
          path: state.identity.documentPath,
          // Identity mismatch preserves the record at its old identity, but
          // transaction-time edits must also be persisted as orphan recovery.
          writeLatest: true,
          documentId: state.identity.documentId,
          fromPath: state.identity.documentPath,
        })
      }
      return results
    }

    async function commitDeletes(
      deletions: readonly DraftDeleteRequest[],
    ): Promise<DraftFileTransactionResult[]> {
      if (settled) return []
      settled = true
      const results: DraftFileTransactionResult[] = []
      const deletedKeys = new Set<string>()
      for (const deletion of deletions) {
        const identityKey = key(deletion.vaultId, deletion.documentId)
        const state = held.get(identityKey)
        if (!state || state.entry.fileTransaction !== token) {
          results.push({
            documentId: deletion.documentId,
            oldPath: deletion.documentPath,
            status: 'identity-mismatch',
          })
          continue
        }
        deletedKeys.add(identityKey)
        if (deletion.policy === 'preserve') {
          const release = await releaseEntry(state, deletion.documentPath, true, true)
          const status = release.status === 'failed' ? 'failed' as const : 'preserved' as const
          if (status === 'failed') alreadyFailedKeys.add(identityKey)
          results.push({
            documentId: deletion.documentId,
            oldPath: deletion.documentPath,
            // An immediate orphan write failure leaves the latest
            // snapshot only in-memory — report 'failed' (not
            // 'preserved') so the lifecycle keeps the tab open: it is
            // the only surface still holding those bytes.
            status,
          })
          continue
        }
        const confirmation = deletion.confirmation
        if (!confirmation
          || confirmation.vaultId !== deletion.vaultId
          || confirmation.documentId !== deletion.documentId
          || confirmation.documentPath !== deletion.documentPath
          || confirmation.ownerGeneration !== state.preparedGeneration
          || state.entry.generation !== confirmation.ownerGeneration
          || (state.entry.latestSnapshot !== null
            && state.entry.latestSnapshot.revision !== confirmation.revision)
          || !snapshotMatches(
            state.entry.latestSnapshot,
            confirmation.expectedSnapshot,
          )) {
          const release = await releaseEntry(state, deletion.documentPath, true, true)
          const status = release.status === 'failed' ? 'failed' as const : 'stale' as const
          if (status === 'failed') alreadyFailedKeys.add(identityKey)
          results.push({
            documentId: deletion.documentId,
            oldPath: deletion.documentPath,
            // The mismatch re-queues the newer snapshot as an orphan
            // immediately; if that write fails the snapshot is still
            // only in-memory — 'failed' keeps the tab open instead of
            // closing it behind a 'stale' result.
            status,
          })
          continue
        }
        const expected = state.entry.persistedDraft
          && confirmation.expectedSnapshot
          && draftMatchesSnapshot(
            state.entry.persistedDraft,
            confirmation.expectedSnapshot,
          )
          ? state.entry.persistedDraft
          : confirmation.expectedDraft
        // Snapshot the entry's pre-CAS ownership so the post-CAS
        // branch can detect edits that landed during the await.
        const preCasGeneration = state.entry.generation
        const preCasRevision = state.entry.latestSnapshot?.revision ?? null
        const preCasSnapshotRef = state.entry.latestSnapshot
        const preCasConfirmedDraft = state.confirmedDraft
        const outcome = expected
          ? await store.deleteDraftIfUnchanged(expected)
          : { status: 'missing' as const }
        const entry = state.entry
        // Refine the CAS outcome using the pre-prepare confirmedDraft.
        // - `missing` + confirmedDraft: at prepare time the store had
        //   a record; CAS found none → a concurrent context deleted
        //   it. Surface as 'stale' so the UI refreshes Recovery
        //   instead of silently dropping the identity.
        const refinedStatus: typeof outcome.status = (() => {
          if (outcome.status === 'missing' && preCasConfirmedDraft) {
            return 'stale'
          }
          return outcome.status
        })()
        // Post-CAS ownership check: detect edits made during the
        // CAS await. `schedule()` advances `entry.generation` even
        // while a file transaction is held, so a strict generation
        // check catches them. Normalize the revision read to `null`
        // (matching `preCasRevision`) so a snapshot-less entry — e.g.
        // a conflict-only delete with no open editor — isn't falsely
        // flagged as advanced (`undefined !== null`).
        const entryAdvancedDuringAwait = entry.generation !== preCasGeneration
          || (entry.latestSnapshot?.revision ?? null) !== preCasRevision
          || entry.latestSnapshot !== preCasSnapshotRef
        if ((refinedStatus === 'deleted' || refinedStatus === 'missing')
          && !entryAdvancedDuringAwait) {
          // Truly confirmed. Clear the entry's confirmed snapshot and
          // ownership, but HOLD the file transaction until the frozen-
          // conflict cleanup AND the final re-verification below
          // complete. Releasing it here (as an earlier revision did)
          // let an edit typed during the cleanup arm a normal primary
          // debounce: the lifecycle could then close the tab before
          // the debounce fired, losing bytes that lived only in
          // coordinator memory while the identity was already reported
          // deleted.
          clearTimer(entry)
          entry.generation += 1
          entry.latestSnapshot = null
          entry.latestSnapshotNeedsWrite = false
          entry.persistedDraft = null
          enterPrimaryMode(entry)
          // The confirmed discard also removes the conflict candidates
          // frozen at confirmation time. Without this the conflict-store
          // rows survive and resurface on the next discovery even though
          // the user confirmed deleting this identity. Track every
          // delete result: a store error leaves the row alive, and
          // reporting full success anyway would hide it behind the UI's
          // removeIdentity() until the next refresh.
          const failedConflictIds: string[] = []
          for (const conflictId of confirmation.expectedConflictIds) {
            const conflictOutcome = await store.deleteConflictDraft(
              deletion.vaultId,
              deletion.documentId,
              conflictId,
            )
            if (conflictOutcome === 'failed' || conflictOutcome === 'unsupported') {
              failedConflictIds.push(conflictId)
            }
          }
          // Anything still on the conflict store for this identity — a
          // frozen row whose delete failed, or a candidate recorded
          // AFTER confirmation (never frozen, intentionally surviving)
          // — must keep the identity visible. The strict read fails
          // closed on a store error: the lossy listConflictDrafts()
          // returns [] there, which would report a full delete while
          // unread survivors hide behind it until the next refresh.
          // Scoped to this identity: a same-identity row that fails
          // validation (future-version / corrupt — never freezable, so
          // it always survives the cleanup above) surfaces as
          // 'unsupported' instead of being silently filtered behind a
          // full delete, mirroring the family move's raw-row pre-flight.
          const conflictList = await store.listConflictDraftsStrict(
            deletion.vaultId,
            deletion.documentId,
          )
          // Final re-verification across the cleanup awaits. schedule()
          // still advances the entry while the transaction is held (it
          // just does not arm a timer), so a non-null snapshot here is
          // an edit made during the cleanup window. It exists only in
          // coordinator memory right now — persist it as a conflict
          // candidate BEFORE reporting anything, so the lifecycle never
          // closes the tab on unpersisted bytes.
          if (entry.latestSnapshot !== null) {
            const handoff = await persistLocalAsConflict(
              state,
              entry,
              refinedStatus,
              // The primary record was just removed by the confirmed
              // CAS — there is no cross-context source left for the
              // candidate to record a divergence from.
              null,
            )
            const status = handoff.status === 'failed' || failedConflictIds.length > 0
              ? 'failed' as const
              : 'conflict' as const
            if (status === 'failed') alreadyFailedKeys.add(identityKey)
            results.push({
              documentId: deletion.documentId,
              oldPath: deletion.documentPath,
              status,
            })
            continue
          }
          if (failedConflictIds.length > 0) {
            console.warn(`[commitDeletes] Frozen conflict delete failed for ${deletion.documentPath}: ${failedConflictIds.join(', ')}`)
            alreadyFailedKeys.add(identityKey)
            await releaseEntry(state, deletion.documentPath, false, true)
            results.push({
              documentId: deletion.documentId,
              oldPath: deletion.documentPath,
              status: 'failed',
            })
            continue
          }
          if (conflictList.status === 'failed') {
            console.warn(`[commitDeletes] Conflict store read failed for ${deletion.documentPath}; reporting failed instead of full success`)
            alreadyFailedKeys.add(identityKey)
            await releaseEntry(state, deletion.documentPath, false, true)
            results.push({
              documentId: deletion.documentId,
              oldPath: deletion.documentPath,
              status: 'failed',
            })
            continue
          }
          if (conflictList.status === 'unsupported') {
            // A future-version / corrupt conflict row for this identity
            // survived the confirmed delete — the store cannot certify
            // the conflict state is empty. Report 'unsupported' (not a
            // clean delete) so the Recovery identity stays visible and
            // the user is warned instead of the row being outlived
            // silently behind removeIdentity().
            console.warn(`[commitDeletes] Unsupported conflict row survived the confirmed delete for ${deletion.documentPath}; reporting unsupported instead of full success`)
            await releaseEntry(state, deletion.documentPath, false, true)
            results.push({
              documentId: deletion.documentId,
              oldPath: deletion.documentPath,
              status: 'unsupported',
            })
            continue
          }
          if (conflictList.records.some(
            (record) => record.documentId === deletion.documentId,
          )) {
            await releaseEntry(state, deletion.documentPath, false, true)
            results.push({
              documentId: deletion.documentId,
              oldPath: deletion.documentPath,
              status: 'conflict',
            })
            continue
          }
          await releaseEntry(state, deletion.documentPath, false, true)
          results.push({
            documentId: deletion.documentId,
            oldPath: deletion.documentPath,
            status: refinedStatus,
          })
          continue
        }
        if ((refinedStatus === 'deleted' || refinedStatus === 'missing')
          && entryAdvancedDuringAwait) {
          // CAS succeeded on the IndexedDB record the user
          // confirmed, but a new local edit (post-CAS) owns a
          // different generation / revision. Preserve the new
          // snapshot by NOT clearing the entry — `releaseEntry`'s
          // normal write path will re-queue the new snapshot with
          // a bumped generation. Report 'conflict' so callers can
          // surface "the deleted source had a newer edit that was
          // preserved as a new orphan recovery entry" instead of
          // treating the operation as a clean delete.
          const release = await releaseEntry(state, deletion.documentPath, true, true)
          const status = release.status === 'failed' ? 'failed' as const : 'conflict' as const
          if (status === 'failed') alreadyFailedKeys.add(identityKey)
          results.push({
            documentId: deletion.documentId,
            oldPath: deletion.documentPath,
            // The post-CAS snapshot is re-queued as an orphan
            // immediately; if that write fails the new edit is still
            // only in-memory — 'failed' (not 'conflict') keeps the tab
            // open as the only surface still holding it.
            status,
          })
          continue
        }
        if (refinedStatus === 'stale' && entryAdvancedDuringAwait) {
          // CAS found a newer cross-context record AND the user
          // made a new local edit during the await. Auto-writing
          // the new local edit with a fresh `safeTimestamp()` would
          // overwrite the cross-context record, which is exactly
          // what the spec forbids. Surface as 'conflict' so the
          // caller can hand the orphan back to Recovery without
          // touching IndexedDB.
          // Re-read the IndexedDB record so the conflict record
          // captures the cross-context source's updatedAt —
          // `state.confirmedDraft` may hold the LOCAL persisted
          // draft, not the cross-context record that won the CAS.
          let crossContextUpdatedAt: number | null = null
          try {
            const remote = await store.getDraft(deletion.vaultId, deletion.documentId)
            if (remote) crossContextUpdatedAt = remote.updatedAt
          } catch {
            crossContextUpdatedAt = null
          }
          const handoff = await persistLocalAsConflict(
            state,
            entry,
            refinedStatus,
            crossContextUpdatedAt,
          )
          const status = handoff.status === 'failed' ? 'failed' as const : 'conflict' as const
          if (status === 'failed') alreadyFailedKeys.add(identityKey)
          results.push({
            documentId: deletion.documentId,
            oldPath: deletion.documentPath,
            // A failed handoff means the local content is still only
            // in-memory; surface 'failed' so the lifecycle keeps the tab
            // open instead of closing the only surface holding it.
            status,
          })
          continue
        }
        // 'stale' / 'failed' / 'unsupported' without a waiting-period
        // edit: the IndexedDB record (or lack thereof) is the source
        // of truth. Never call queueTargetWrite here — releaseEntry's
        // writeLatest=true path would assign a fresh `safeTimestamp()`
        // that could overwrite a cross-context newer record. Instead,
        // just release the transaction lock without re-writing so
        // Recovery refresh can pick up whatever IndexedDB actually
        // holds.
        await releaseEntry(state, deletion.documentPath, false, true)
        results.push({
          documentId: deletion.documentId,
          oldPath: deletion.documentPath,
          status: refinedStatus,
        })
      }
      for (const [identityKey, state] of held) {
        if (!deletedKeys.has(identityKey)) {
          await releaseEntry(state, state.identity.documentPath, true, true)
        }
      }
      return results
    }

    /** Seal released entries just before the lifecycle closes document
     *  tabs — as ONE batch barrier over every identity about to close.
     *  commitDeletes releases every entry when it reports, but the
     *  lifecycle still awaits Recovery synchronization before closing
     *  tabs — an edit typed during that async window arms a fresh
     *  debounce (the transaction lock is already gone) that the tab
     *  close could outrun: if that debounced write later failed, the
     *  bytes would exist nowhere visible.
     *  Phase 1 (synchronous, before ANY await): install a fresh close
     *  seal on every identity being closed and clear its timer. The
     *  seal reuses the fileTransaction mechanism — schedule() may
     *  still update a snapshot but no longer arms a timer, and flush()
     *  steps aside — so an edit typed while a SIBLING document's save
     *  is in flight cannot arm a debounce the tab close would outrun.
     *  Phase 2: persist anything still pending on the entry's active
     *  channel (conflict-pinned entries keep writing conflict records;
     *  quarantined entries route through the family-move retry), all
     *  writes in flight together.
     *  Phase 3: only AFTER every write settles, re-verify each entry
     *  against its seal-time state. An identity whose latest content
     *  was not verified durable — a rejected write, OR an edit that
     *  landed during the phase (its generation advanced / snapshot
     *  replaced / write flag still set) — returns 'failed' so the
     *  lifecycle keeps THAT tab open (the only surface still holding
     *  those bytes); releasing its seal re-arms the background retry.
     *  A verified write returns 'preserved' so the lifecycle's second
     *  synchronization pass (after the tab decision) refreshes the
     *  current Recovery identity — otherwise the panel keeps showing
     *  the pre-window record, or never sees a fresh orphan recorded
     *  after a confirmed delete. 'preserved' never warns.
     *  Identities that already reported 'failed' are never sealed:
     *  their tabs stay open regardless and their armed debounce must
     *  keep retrying in the background.
     *  The lifecycle must close tabs synchronously after this promise
     *  resolves (no await in between) so no user input event can open
     *  a new window. */
    async function finalizeBeforeDocumentClose(): Promise<DraftFileTransactionResult[]> {
      if (closeSealed) return []
      closeSealed = true
      const results: DraftFileTransactionResult[] = []
      const closeToken = Symbol('draft-close-seal')
      // Phase 1 — seal every identity being closed BEFORE any await.
      const sealed: Array<{
        identityKey: string
        state: {
          identity: DraftDocumentIdentity
          entry: DraftEntry
          confirmedDraft: UnsavedDraft | null
          preparedGeneration: number
        }
        sealedGeneration: number
        sealedSnapshot: DraftBufferSnapshot | null
        pending: boolean
        save: Promise<boolean> | null
      }> = []
      for (const [identityKey, state] of held) {
        if (alreadyFailedKeys.has(identityKey)) continue
        const { entry } = state
        if (entry.fileTransaction) continue
        clearTimer(entry)
        entry.fileTransaction = closeToken
        sealed.push({
          identityKey,
          state,
          sealedGeneration: entry.generation,
          sealedSnapshot: entry.latestSnapshot,
          pending: entry.latestSnapshot !== null
            && (entry.latestSnapshotNeedsWrite || entry.emptyFamilyRecovery !== null),
          save: null,
        })
      }
      // Phase 2 — bounded saves, all in flight together (a slow
      // document must not serialize its siblings behind it).
      for (const attempt of sealed) {
        if (!attempt.pending) continue
        const { entry, identity } = attempt.state
        const latest = entry.latestSnapshot
        if (!latest) continue
        const owner = {
          vaultId: identity.vaultId,
          documentId: identity.documentId,
          generation: entry.generation,
        }
        attempt.save = queueTargetWrite(owner, cloneSnapshot(latest))
      }
      const saveResults = await Promise.all(sealed.map(async (attempt) => {
        if (!attempt.save) return true
        try {
          return await attempt.save
        } catch {
          return false
        }
      }))
      // Phase 3 — uniform re-verification across the WHOLE phase: the
      // latest content is certified durable only for an entry whose
      // state is exactly what the seal captured. An edit that landed
      // during a sibling's write fails closed whatever its own save
      // returned. Release every seal on the way out — it must not
      // outlive this gate.
      sealed.forEach((attempt, index) => {
        const { identityKey, state, sealedGeneration, sealedSnapshot, pending } = attempt
        const { entry, identity } = state
        const superseded = entry.generation !== sealedGeneration
          || entry.latestSnapshot !== sealedSnapshot
          || entry.latestSnapshotNeedsWrite
          || entry.emptyFamilyRecovery !== null
        const failed = superseded || (pending && !saveResults[index])
        if (entry.fileTransaction === closeToken) entry.fileTransaction = null
        if (!failed) {
          if (pending) {
            // The settlement-window edit is durable — report a
            // non-warning status so the lifecycle runs its second
            // Recovery sync after the tab decision: refreshIdentity
            // re-reads the store, so the panel shows the window edit
            // instead of the stale pre-window record (and, after a
            // confirmed delete already removed the identity, re-adds
            // the fresh orphan — otherwise invisible in the current
            // session until the next full discovery).
            // 'preserved' never warns.
            results.push({
              documentId: identity.documentId,
              oldPath: identity.documentPath,
              status: 'preserved',
            })
          }
          return
        }
        alreadyFailedKeys.add(identityKey)
        // Re-arm the background retry: the tab stays open as the
        // visible surface while the debounce persists the latest
        // snapshot on the entry's active channel.
        if (entry.latestSnapshot
          && (entry.latestSnapshotNeedsWrite || entry.emptyFamilyRecovery !== null)) {
          entry.generation += 1
          const owner = {
            vaultId: identity.vaultId,
            documentId: identity.documentId,
            generation: entry.generation,
          }
          const captured = cloneSnapshot(entry.latestSnapshot)
          entry.timer = setTimeout(() => {
            entry.timer = null
            // The write channel is resolved AT TIMER FIRE time inside
            // queueTargetWrite (see schedule() for the full rationale).
            // Capturing the channel here would miss a handoff that
            // lands between this re-arm and the debounce firing — the
            // next write could overwrite the cross-context record a
            // prior mid-flight handoff pinned.
            void queueTargetWrite(owner, captured)
          }, debounceMs)
        }
        results.push({
          documentId: identity.documentId,
          oldPath: identity.documentPath,
          status: 'failed',
        })
      })
      return results
    }

    async function finalizeAfterTabMigration(): Promise<DraftFileTransactionResult[]> {
      if (finalized) return []
      finalized = true
      const results: DraftFileTransactionResult[] = []
      for (const [identityKey, release] of pendingReleases) {
        const state = held.get(identityKey)
        if (!state) continue
        // Every pending entry MUST be released — including one the
        // commit already reported 'failed' (e.g. a failed family move).
        // Skipping the release would leave entry.fileTransaction pinned
        // to this dead barrier forever: schedule() would stop arming
        // timers, flush() would keep returning false, and pagehide /
        // dispose could never persist the entry's subsequent edits — a
        // permanent lock on exactly the tab the failure keeps open.
        const releaseResult = await releaseEntry(
          state,
          release.path,
          release.writeLatest,
          true,
        )
        if (alreadyFailedKeys.has(identityKey)) {
          // Already reported failed by the commit results — re-reporting
          // would only duplicate the user-visible warning. The release
          // above is what matters.
          continue
        }
        if (releaseResult.status === 'failed') {
          // The immediate write of the transaction-time snapshot to
          // the actual post-rename path was rejected: the latest edit
          // is still only in-memory. Report 'failed' so the lifecycle
          // merges it into the transaction results — the server rename
          // stays successful and the tab keeps its new path, but the
          // user is warned that the local draft could not be persisted
          // (a crash or refresh now could lose the transaction-time
          // edit). Never reverse the rename over a draft write failure.
          alreadyFailedKeys.add(identityKey)
          results.push({
            documentId: release.documentId,
            oldPath: release.fromPath,
            newPath: release.toPath,
            status: 'failed',
          })
        }
      }
      pendingReleases.clear()
      return results
    }

    async function rollback(): Promise<void> {
      if (settled) return
      settled = true
      for (const state of held.values()) {
        await releaseEntry(state, state.identity.documentPath, true)
      }
    }

    return {
      commitMoves,
      commitDeletes,
      finalizeBeforeDocumentClose,
      finalizeAfterTabMigration,
      rollback,
    }
  }

  function captureDeleteConfirmation(
    identity: DraftDocumentIdentity,
    revision: number,
    expectedDraft?: UnsavedDraft | null,
    expectedConflictIds?: readonly string[],
  ): DraftDeleteConfirmation {
    const entry = entryFor(identity.vaultId, identity.documentId)
    const expected = entry.persistedDraft ?? (expectedDraft
      && expectedDraft.vaultId === identity.vaultId
      && expectedDraft.documentId === identity.documentId
      ? expectedDraft
      : null)
    return {
      ...identity,
      revision,
      ownerGeneration: entry.generation,
      expectedDraft: expected
        ? { ...expected }
        : null,
      expectedSnapshot: entry.latestSnapshot
        ? cloneSnapshot(entry.latestSnapshot)
        : null,
      // Freeze the conflict candidates present at confirmation time so a
      // confirmed discard removes exactly these (and nothing recorded
      // afterwards).
      expectedConflictIds: [...(expectedConflictIds ?? [])],
    }
  }

  function findTrackedIdentitiesByPaths(
    paths: readonly string[],
  ): DraftDocumentIdentity[] {
    const wanted = new Set(paths)
    const found = new Map<string, DraftDocumentIdentity>()
    for (const entry of entries.values()) {
      const snapshot = entry.latestSnapshot
      if (!snapshot || !wanted.has(snapshot.documentPath)) continue
      found.set(key(snapshot.vaultId, snapshot.documentId), {
        vaultId: snapshot.vaultId,
        documentId: snapshot.documentId,
        documentPath: snapshot.documentPath,
      })
    }
    return [...found.values()]
  }

  function getDraftCleanupProtection(vaultId: string): DraftCleanupProtection {
    const identityIds = new Set<string>()
    for (const entry of entries.values()) {
      const snapshot = entry.latestSnapshot
      if (entry.vaultId !== vaultId) continue
      const protectedEntry = (snapshot !== null
          && snapshot.content !== snapshot.authoritativeContent)
        || entry.latestSnapshotNeedsWrite
        || entry.timer !== null
        || entry.pendingWrite !== null
        || entry.fileTransaction !== null
        || entry.mode.kind !== 'primary'
        || entry.emptyFamilyRecovery !== null
        || entry.settleRetryAttempt !== null
      if (protectedEntry) {
        identityIds.add(JSON.stringify([entry.vaultId, entry.documentId]))
      }
    }
    return { identityIds }
  }

  function hasPendingWrites(): boolean {
    return [...entries.values()].some((entry) => (
      entry.timer !== null
      || entry.pendingWrite !== null
      || entry.latestSnapshotNeedsWrite
      || entry.fileTransaction !== null
      || entry.emptyFamilyRecovery !== null
      || entry.settleRetryAttempt !== null
      || (entry.latestSnapshot === null
        && entry.mode.kind === 'primary'
        && entry.persistedDraft !== null)
    ))
  }

  function onPageHide(): void {
    void flushAllInternal().catch(() => {})
  }

  targetWindow?.addEventListener('pagehide', onPageHide)

  async function dispose(): Promise<void> {
    if (disposePromise) return disposePromise
    targetWindow?.removeEventListener('pagehide', onPageHide)
    disposePromise = (async () => {
      disposed = true
      for (const entry of entries.values()) clearTimer(entry)
      await flushAllInternal(true)
    })()
    return disposePromise
  }

  return {
    schedule,
    flush,
    flushAll: () => flushAllInternal(),
    markClean,
    returnedToBaseline,
    discard,
    discardIdentity,
    discardIdentityIfUnchanged,
    discardConflict,
    adoptRecoveredDraft,
    prepareFileMutation,
    captureDeleteConfirmation,
    findTrackedIdentitiesByPaths,
    getDraftCleanupProtection,
    hasPendingWrites,
    invalidateOwner,
    invalidate,
    clearSensitiveState,
    dispose,
  }
}

import { draftKey, isDraftIdentity, type DraftKey } from './draftKey'
import {
  cloneDraft,
  cloneConflictRecord,
  conflictDraftsEqual,
  draftsEqual,
  isDraftConflictRecord,
  isUnsavedDraft,
  type DraftConflictRecord,
  type UnsavedDraft,
} from './draftTypes'
import { isManagedDiaryPath } from '../../../../shared/diaryProtocol'
import { NUVYN_DRAFT_DATABASE_NAME, openNamedIndexedDb } from '../../../technicalNamespace'

const DATABASE_NAME = NUVYN_DRAFT_DATABASE_NAME
const DATABASE_VERSION = 2
const DRAFT_STORE_NAME = 'drafts'
const CONFLICT_STORE_NAME = 'draftConflicts'
const VAULT_UPDATED_INDEX = 'vaultUpdatedAt'
const CONFLICT_VAULT_INDEX = 'vaultId'

export const DIARY_DRAFT_RECOVERY_UNSUPPORTED_CODE = 'diary-draft-recovery-unsupported' as const

function isManagedDraftPath(value: unknown): boolean {
  return typeof value === 'string' && isManagedDiaryPath(value.replace(/\.md$/, ''))
}

type SaveResult = 'saved' | 'stale' | 'conflict' | 'unsupported' | 'path-mismatch'
type SaveDecision =
  | { result: 'saved'; draft: UnsavedDraft }
  | { result: Exclude<SaveResult, 'saved'>; draft?: never }

/** Outcome of a primary-record save. Mirrors the store-level
 *  classification so the caller can route each non-success case to the
 *  right recovery surface:
 *  - `saved` — the save committed and the readback still matches the
 *    draft we sent (DraftStore preserves an existing record's
 *    `createdAt`; the returned `stored` reflects that);
 *  - `stale` — the store already held a newer record; the caller
 *    preserves the local content as a conflict candidate and pins the
 *    entry to the conflict channel;
 *  - `conflict` — same `updatedAt`, different body; the caller routes
 *    the local content to the conflict store instead of dropping it;
 *  - `path-mismatch` — the incoming draft's `documentPath` differs
 *    from the family's current path. The store REFUSES to
 *    implicitly migrate the family (path changes are only authoritative
 *    when they come from an explicit `commitMoves()` mapping, a
 *    persistent quarantine, or a freshly re-read server identity).
 *    The caller must promote the local content to an independent
 *    conflict candidate instead of retrying a plain overwrite — a
 *    stale old-path Tab's edits must never drag the family back from
 *    the path the server currently lives on. `current` is the family
 *    member the save diverged from: the primary record when one
 *    exists, otherwise the newest candidate of a CONFLICT-ONLY family
 *    — same-identity candidates form a family (and an authoritative
 *    path) even without a primary record, so a plain first-write on a
 *    diverging path is refused exactly like a cross-path overwrite.
 *  - `unsupported` — a future-version / corrupt row (primary OR
 *    same-identity conflict) blocked the whole save; the caller
 *    preserves the local content as an independent conflict candidate
 *    rather than retrying a plain overwrite. `familyPath` is the path
 *    every raw family row (the primary record, if any, plus every
 *    same-identity conflict row — including rows the store could not
 *    validate, whose `documentPath` is still readable) agrees on, so
 *    the caller pins its candidate ON the family instead of at its own
 *    possibly-stale snapshot path — a candidate created at the stale
 *    path would split the very family the store could not certify.
 *    `null` when the rows disagree on the path, no row carries a
 *    readable path, or the family could not be re-read: the caller
 *    must then fail closed — keep the write flag set, write no
 *    candidate — rather than guess a path and split the family.
 *    `reason` names WHY the family is unsupported so the caller can
 *    route its state machine without re-deriving it:
 *    - `split-conflict-paths` — the raw rows disagree on the path (or
 *      carry no readable path at all); `familyPath` is always `null`
 *      and the caller must fail closed, never guess a side;
 *    - `unsupported-conflict` — at least one same-identity conflict
 *      row is unreadable (the primary may or may not exist / be
 *      readable); when `familyPath` is non-null the caller's candidate
 *      joins the family on that path;
 *    - `unsupported-primary` — the blocking row is the primary record
 *      itself (or the incoming draft is malformed, or the family could
 *      not be probed); the conflict rows, if any, are all readable;
 *  - `failed` — the underlying store threw or returned a status the
 *    caller cannot route; the write must fail closed (write flag
 *    stays set, close seal keeps the tab open) so the latest bytes
 *    stay visible until a retry succeeds. */
/** The family member a rejected primary save diverged from: the
 *  primary record when one exists, otherwise the newest candidate
 *  anchoring a conflict-only family's path. Both expose the
 *  `documentPath` + `updatedAt` the caller needs to pin its own
 *  candidate onto the family (path and cross-context marker). */
export type DraftFamilyAnchor = UnsavedDraft | DraftConflictRecord

/** Why an unsupported save could not persist — the structured
 *  classification the persistence state machine routes on (see the
 *  `unsupported` outcome and probeFamily). */
export type UnsupportedFamilyReason =
  | 'unsupported-primary'
  | 'unsupported-conflict'
  | 'split-conflict-paths'

export type DraftSaveOutcome =
  | { status: 'saved'; stored: UnsavedDraft }
  | { status: 'stale'; current: UnsavedDraft }
  | { status: 'conflict'; current: UnsavedDraft }
  | { status: 'path-mismatch'; current: DraftFamilyAnchor }
  | { status: 'unsupported'; familyPath: string | null; reason: UnsupportedFamilyReason }
  | { status: 'failed' }
type MoveResult = 'moved' | 'missing' | 'conflict' | 'unsupported'
type DeleteResult = 'deleted' | 'missing' | 'unsupported'
type ConditionalDeleteResult = DeleteResult | 'stale'
type BackendOperation =
  | 'save' | 'get' | 'list' | 'delete' | 'move' | 'moveConflicts'
  | 'moveFamily' | 'moveFamilyConflicts' | 'moveFamilyIfAtPath' | 'clear'
  | 'saveConflict' | 'saveConflictCandidate'
  | 'listConflicts' | 'deleteConflict' | 'deleteConflictIfUnchanged' | 'clearConflicts'
  | 'inspect'

export interface DraftStorageBackend {
  /** Persist a primary draft record under the (vaultId, documentId)
   *  CAS rules (see decideSave). Path-authority: a plain primary save
   *  MUST NOT silently migrate the family to a different path — path
   *  changes are only authoritative when they come from an explicit
   *  commitMoves() mapping (or a persistent quarantine). When the
   *  saved draft's `documentPath` differs from the family's current
   *  path, the save returns 'path-mismatch' and the caller must
   *  persist the local content as an independent conflict candidate
   *  instead of retrying a plain overwrite. The family's path is the
   *  primary record's path when a primary exists; when it does not,
   *  the same-identity conflict candidates still form a family —
   *  their shared path is authoritative (a conflict-only first-write
   *  on a diverging path returns 'path-mismatch' too), and mutually
   *  diverging candidate paths return 'unsupported' rather than
   *  guessing. A first-write to a truly empty identity (no primary
   *  AND no candidates) always succeeds: no family exists yet to
   *  migrate. An unsupported (future-version / corrupt) primary
   *  record — OR any same-identity unsupported conflict row — blocks
   *  the whole save and returns 'unsupported' (the caller persists
   *  the local content as a separate candidate instead of retrying a
   *  plain overwrite). */
  save(draft: UnsavedDraft): Promise<SaveResult>
  get(key: DraftKey): Promise<unknown | null>
  list(vaultId: string): Promise<unknown[]>
  delete(key: DraftKey): Promise<DeleteResult>
  deleteIfUnchanged(expected: UnsavedDraft): Promise<ConditionalDeleteResult>
  move(
    vaultId: string,
    oldDocumentId: string,
    newDocumentId: string,
    newPath: string,
  ): Promise<MoveResult>
  moveConflicts(
    vaultId: string,
    oldDocumentId: string,
    newDocumentId: string,
    newPath: string,
  ): Promise<number>
  /** Move the primary record AND every conflict candidate for the
   *  identity as one unit. Backed by a single IndexedDB transaction
   *  across both stores so a failure anywhere rolls the whole family
   *  move back — a conflict-phase error can never leave the primary
   *  renamed with its conflicts stranded on the pre-rename path. */
  moveFamily(
    vaultId: string,
    documentId: string,
    newPath: string,
  ): Promise<FamilyMoveBackendResult>
  /** CAS (compare-and-swap) variant of moveFamily: move the family as
   *  one unit, but ONLY while it still sits at `expectedFamilyPath` —
   *  the only move API a quarantine / move-indeterminate retry may use.
   *  Inside ONE transaction across both stores the family's current path
   *  is derived from the raw rows (the primary record, if any, plus
   *  every same-identity conflict row — each validated first, exactly
   *  like moveFamily's pre-flight) and compared against the certified
   *  expected path: `moved` / `missing` when the family still sits at
   *  the expected path (a conflict-only family's rows are re-pinned at
   *  `newPath` too, reported as `missing`), `path-mismatch` when another
   *  context's verified rename moved the family (NOTHING moves;
   *  `currentPath` certifies where it lives now), `unsupported` when
   *  the pre-flight cannot certify the family (NOTHING moves). A
   *  transaction abort THROWS; the store layer reports `failed`. */
  moveFamilyIfAtPath(
    vaultId: string,
    documentId: string,
    expectedFamilyPath: string,
    newPath: string,
  ): Promise<FamilyCasMoveBackendResult>
  clear(vaultId: string): Promise<void>
  saveConflict(record: DraftConflictRecord): Promise<void>
  /** Persist a conflict candidate as part of ONE transaction that also
   *  reads the family's current path (primary record + same-identity
   *  conflict rows). The candidate is only written when the family
   *  agrees on its path; a family move committed in another context
   *  between the path read and the write is impossible — both happen
   *  inside the same readwrite transaction, so the write either sees
   *  the moved family (path-mismatch, nothing written) or joins it
   *  atomically. A duplicate conflictId or a transaction abort throws. */
  saveConflictCandidate(
    record: DraftConflictRecord,
  ): Promise<ConflictCandidateBackendResult>
  listConflicts(vaultId: string): Promise<unknown[]>
  inspect(vaultId: string): Promise<{ primary: unknown[]; conflicts: unknown[] }>
  deleteConflict(
    vaultId: string,
    documentId: string,
    conflictId: string,
  ): Promise<'deleted' | 'missing' | 'unsupported'>
  deleteConflictIfUnchanged(
    expected: DraftConflictRecord,
  ): Promise<ConditionalDeleteResult>
  clearConflicts(vaultId: string): Promise<void>
}

export type DraftMoveOutcome =
  | { status: 'moved' }
  | { status: 'missing' }
  | { status: 'conflict' }
  | { status: 'unsupported' }
  | { status: 'failed' }

type FamilyMoveBackendResult = {
  status: MoveResult
  movedConflicts: number
}

/** Backend-level CAS move result: the four outcomes minus `failed` —
 *  a transaction abort THROWS instead, and the store layer converts
 *  the throw into `failed`. */
type FamilyCasMoveBackendResult =
  | { status: 'moved' }
  | { status: 'missing' }
  | { status: 'path-mismatch'; currentPath: string }
  | { status: 'unsupported' }

/** Outcome of an atomic primary+conflicts rename. The whole family is
 *  pre-flight validated BEFORE anything is written: if the primary OR
 *  any conflict row for the identity is unsupported (future-version /
 *  corrupt), NOTHING moves and `status` is `unsupported` — a partial
 *  migration would split the family across paths (persistence keeps
 *  the in-memory snapshot on the old path for an unsupported result,
 *  and an unreadable conflict left behind could never resurface under
 *  the new path). Otherwise `status` classifies the primary record (a
 *  rename never changes documentId identity, so the primary cannot
 *  conflict with a separate target) and `movedConflicts` counts the
 *  conflict candidates migrated in the same transaction. `failed`
 *  means the family move was rolled back — neither store changed. */
export type DraftFamilyMoveOutcome = {
  status: MoveResult | 'failed'
  movedConflicts: number
}

/** Outcome of a CAS (expected-path) family move — the only move API a
 *  quarantine / move-indeterminate retry may use against the store. The
 *  family's current path is derived from the raw rows inside the SAME
 *  transaction as the move, so a rename committed by another context can
 *  never slip between the caller's last probe and the move:
 *  - `moved` — the family still sat at the certified expected path and
 *    now lives at `newPath` (a primary record existed);
 *  - `missing` — the identity held no rows at all, or a conflict-only
 *    family still sat at the expected path: there was no primary to
 *    move; any same-identity conflict rows present at the expected path
 *    were re-pinned at `newPath` in the same transaction;
 *  - `path-mismatch` — the family no longer sits at the expected path
 *    (another context's verified rename moved it): NOTHING moved.
 *    `currentPath` certifies where the family lives now, so the caller
 *    can adopt THAT path (pin its pending content as a candidate on the
 *    family's real path) instead of retrying the stale target — the
 *    server file operation is always authoritative, so a stale
 *    quarantine retry must never drag the family back from the path the
 *    server actually lives on;
 *  - `unsupported` — pre-flight blocked the whole move (the primary OR
 *    any same-identity conflict row is future-version / corrupt, or the
 *    readable rows disagree on the path): NOTHING moved;
 *  - `failed` — the transaction aborted (or the arguments were
 *    invalid): neither store changed. */
export type DraftFamilyCasMoveOutcome =
  | { status: 'moved' }
  | { status: 'missing' }
  | { status: 'path-mismatch'; currentPath: string }
  | { status: 'unsupported' }
  | { status: 'failed' }

/** Outcome of a strict, read-only family probe — the state
 *  re-verification a move-indeterminate retry must run BEFORE acting:
 *  it carries no trustworthy expected path, so it must never blind-move
 *  "whatever is there" toward a stale serverPath:
 *  - `none` — no rows for the identity: nothing to move or heal;
 *  - `path` — every row of the identity is readable and agrees on
 *    `familyPath`; `hasPrimary` says whether a primary record exists
 *    (a conflict-only family still certifies its path);
 *  - `unsupported` — the rows disagree on the path or at least one is
 *    unreadable: no current path may be certified (`reason` classifies
 *    the blocking row, mirroring probeReason's priority — split
 *    dominates an unreadable conflict row, which dominates an
 *    unreadable primary);
 *  - `failed` — the store could not be read.
 *  The probe is a strict read: it writes nothing. */
export type DraftFamilyProbeOutcome =
  | { status: 'none' }
  | { status: 'path'; familyPath: string; hasPrimary: boolean }
  | { status: 'unsupported'; reason: UnsupportedFamilyReason }
  | { status: 'failed' }

export type DraftDeleteOutcome =
  | { status: 'deleted' }
  | { status: 'missing' }
  | { status: 'unsupported' }
  | { status: 'failed' }

export type DraftConditionalDeleteOutcome =
  | { status: 'deleted' }
  | { status: 'missing' }
  | { status: 'stale' }
  | { status: 'unsupported' }
  | { status: 'failed' }

export interface DraftRecoveryInventory {
  primary: UnsavedDraft[]
  conflicts: DraftConflictRecord[]
  unsupportedPrimaryCount: number
  unsupportedConflictCount: number
}

/** Managed-Diary recovery rows are intentionally hidden from the ordinary
 * Note recovery surface.  D8.4's Settings bridge may inspect these rows as
 * structural/action input, while keeping their body content in the browser's
 * short-lived memory until an explicit import or typed discard. */
export interface ManagedDiaryRecoveryInventory {
  primary: UnsavedDraft[]
  conflicts: DraftConflictRecord[]
  unsupportedPrimaryCount: number
  unsupportedConflictCount: number
}

/** Why a recovery-inventory read failed. The IndexedDB backend
 *  classifies open/upgrade failures so the UI can tell a version
 *  upgrade blocked by another open Nuvyn page (an old page still
 *  holds the version 1 connection) apart from other read failures —
 *  the actionable fix ("close the other tabs and retry") exists only
 *  for the blocked case. Every backend maps store errors it cannot
 *  classify to `transaction-failed`. The reason is a storage
 *  classification; it never carries draft content. */
export type DraftStorageFailureReason =
  | 'indexeddb-unavailable'
  | 'upgrade-blocked'
  | 'open-failed'
  | 'transaction-failed'

/** Structured storage error the IndexedDB backend throws for
 *  classifiable open/upgrade failures; the store level maps it onto
 *  the inventory outcome's `reason` (see storageFailureReason). */
export class DraftStorageError extends Error {
  readonly reason: DraftStorageFailureReason
  constructor(reason: DraftStorageFailureReason, message?: string) {
    super(message ?? reason)
    this.name = 'DraftStorageError'
    this.reason = reason
  }
}

export type DraftRecoveryInventoryOutcome =
  | { status: 'ok'; inventory: DraftRecoveryInventory }
  | { status: 'failed'; reason: DraftStorageFailureReason }

export interface MemoryDraftStorageBackend extends DraftStorageBackend {
  failNext(operation: BackendOperation): void
  seedRaw(value: unknown): Promise<void>
  seedRawConflict(value: unknown): Promise<void>
}

export type DraftConflictSaveOutcome =
  | { status: 'saved' }
  | { status: 'unsupported' }
  | { status: 'failed' }

/** Outcome of a family-atomic conflict-candidate write. The candidate
 *  is validated against the family's CURRENT path inside ONE
 *  transaction across both stores, so a family move committed by
 *  another context can never slip between the path read and the write:
 *  - `saved` — the family agreed on the candidate's path (or was
 *    empty: a first candidate establishes the path); the record is
 *    durable and `stored` is the persisted row;
 *  - `path-mismatch` — the family now lives at `familyPath` (a rename
 *    landed elsewhere); NOTHING was written. The caller must re-pin at
 *    the reported path and retry — writing at the stale path would
 *    strand the candidate and split the family;
 *  - `unsupported` — the family rows disagree on the path or carry no
 *    readable path (`familyPath` is always `null`); NOTHING was
 *    written. The caller fails closed exactly like an unsupported
 *    primary save — no guessed side, no guessed path;
 *  - `failed` — the transaction aborted (store error or duplicate
 *    conflictId); the caller fails closed (write flag stays set). */
export type DraftConflictCandidateOutcome =
  | { status: 'saved'; stored: DraftConflictRecord }
  | { status: 'path-mismatch'; familyPath: string }
  | { status: 'unsupported'; familyPath: null; reason: UnsupportedFamilyReason }
  | { status: 'failed' }

/** Backend-level candidate result: the four outcomes minus `failed` —
 *  a transaction abort (or a duplicate conflictId key) THROWS instead,
 *  and the store layer converts the throw into `failed`. */
type ConflictCandidateBackendResult =
  | { status: 'saved'; stored: DraftConflictRecord }
  | { status: 'path-mismatch'; familyPath: string }
  | { status: 'unsupported'; familyPath: null; reason: UnsupportedFamilyReason }

/** Strict result of a conflict-store read. File transactions must use
 *  this instead of the lossy `listConflictDrafts()`: a store read error
 *  surfaces as `{ status: 'failed' }` rather than masquerading as an
 *  empty list — an unread store may still hold survivors, and a full
 *  'deleted' reported on top of it would hide them behind the UI's
 *  removeIdentity() until the next refresh. A row that fails validation
 *  (future-version / corrupt) surfaces as `{ status: 'unsupported' }`
 *  instead of being silently filtered away — the same raw-row semantics
 *  as the family move's pre-flight: the store cannot certify that
 *  identity's conflict state, so the caller must keep the identity
 *  visible and warn instead of certifying a clean delete on top of a
 *  row it could not read. Discovery (best-effort by nature) keeps the
 *  plain array API. */
export type ConflictListOutcome =
  | { status: 'ok'; records: DraftConflictRecord[] }
  | { status: 'unsupported' }
  | { status: 'failed' }

export interface DraftStore {
  saveDraft(draft: UnsavedDraft): Promise<DraftSaveOutcome>
  getDraft(vaultId: string, documentId: string): Promise<UnsavedDraft | null>
  listDrafts(vaultId: string): Promise<UnsavedDraft[]>
  inspectVaultRecovery(vaultId: string): Promise<DraftRecoveryInventoryOutcome>
  /** D8.4-only bridge; unlike inspectVaultRecovery this includes managed
   * Diary rows, but it never writes or sends their content to the server. */
  inspectManagedDiaryRecovery?(vaultId: string): Promise<DraftRecoveryInventoryOutcome>
  deleteDraft(vaultId: string, documentId: string): Promise<DraftDeleteOutcome>
  deleteDraftIfUnchanged(
    expected: UnsavedDraft,
  ): Promise<DraftConditionalDeleteOutcome>
  /** Conditional deletion for a D8.4-reviewed managed Diary draft. */
  deleteManagedDraftIfUnchanged?(expected: UnsavedDraft): Promise<DraftConditionalDeleteOutcome>
  moveDraft(
    vaultId: string,
    oldDocumentId: string,
    newDocumentId: string,
    newPath: string,
  ): Promise<DraftMoveOutcome>
  moveConflicts(
    vaultId: string,
    oldDocumentId: string,
    newDocumentId: string,
    newPath: string,
  ): Promise<number>
  moveDraftFamily(
    vaultId: string,
    documentId: string,
    newPath: string,
  ): Promise<DraftFamilyMoveOutcome>
  /** CAS (expected-path) variant of moveDraftFamily — the only move API
   *  a quarantine / move-indeterminate retry may use. Moves the whole
   *  family ONLY while its current path (derived from the raw rows
   *  inside the same transaction) still equals `expectedFamilyPath`; a
   *  stale retry against a family another context already moved returns
   *  `path-mismatch` and moves NOTHING. See DraftFamilyCasMoveOutcome. */
  moveDraftFamilyIfAtPath(
    vaultId: string,
    documentId: string,
    expectedFamilyPath: string,
    newPath: string,
  ): Promise<DraftFamilyCasMoveOutcome>
  /** Strict read-only probe of the family's current state — the state
   *  re-verification a move-indeterminate retry runs before acting (it
   *  has no trustworthy expected path and must never blind-move). Writes
   *  nothing; see DraftFamilyProbeOutcome. */
  probeDraftFamily(
    vaultId: string,
    documentId: string,
  ): Promise<DraftFamilyProbeOutcome>
  clearVaultDrafts(vaultId: string): Promise<boolean>
  saveConflictDraft(record: DraftConflictRecord): Promise<DraftConflictSaveOutcome>
  /** Persist a conflict candidate FAMILY-ATOMICALLY: the candidate's
   *  path is validated against the family's current path inside one
   *  transaction across both stores (see DraftConflictCandidateOutcome).
   *  Every route that records a local edit as a conflict candidate —
   *  conflict-channel writes, quarantine retries, readback / delete
   *  handoffs, pagehide / dispose flushes — must use this instead of
   *  the plain `saveConflictDraft` (kept for fixture seeding only): a
   *  bare add cannot see a family move committed by another context
   *  between the caller's last probe and the write, and would strand
   *  the candidate on the pre-move path, splitting the family. */
  saveConflictCandidate(
    record: DraftConflictRecord,
  ): Promise<DraftConflictCandidateOutcome>
  listConflictDrafts(vaultId: string): Promise<DraftConflictRecord[]>
  /** Strict conflict read for file transactions. When `documentId` is
   *  given, both the unsupported-row check and the returned records are
   *  scoped to that identity — mirroring the family move's same-identity
   *  pre-flight, so an unreadable row THIS delete is about to outlive
   *  surfaces as `unsupported` while other identities' rows (valid or
   *  not) do not shadow an otherwise clean delete. */
  listConflictDraftsStrict(
    vaultId: string,
    documentId?: string,
  ): Promise<ConflictListOutcome>
  deleteConflictDraft(
    vaultId: string,
    documentId: string,
    conflictId: string,
  ): Promise<'deleted' | 'missing' | 'unsupported' | 'failed'>
  deleteConflictDraftIfUnchanged(
    expected: DraftConflictRecord,
  ): Promise<DraftConditionalDeleteOutcome>
  /** Conditional deletion for a D8.4-reviewed managed Diary conflict row. */
  deleteManagedConflictDraftIfUnchanged?(expected: DraftConflictRecord): Promise<DraftConditionalDeleteOutcome>
  clearVaultConflictDrafts(vaultId: string): Promise<boolean>
}

interface CreateDraftStoreOptions {
  backend?: DraftStorageBackend
  indexedDB?: IDBFactory
}

export function createDraftStore(options: CreateDraftStoreOptions = {}): DraftStore {
  const backend = options.backend ?? createIndexedDbDraftBackend(options.indexedDB)

  /** Strict conflict-store read scoped to one identity, shared by the
   *  public `listConflictDraftsStrict` and the `saveDraft` path-mismatch
   *  anchor (a conflict-only family has no primary record to re-read —
   *  its newest candidate is the family member the save diverged from). */
  async function strictConflictRead(
    vaultId: string,
    documentId: string | undefined,
  ): Promise<ConflictListOutcome> {
    const raw = await backend.listConflicts(vaultId)
    // Validate the raw rows BEFORE filtering, mirroring the family
    // move's pre-flight: a future-version or corrupt row for this
    // identity must surface as 'unsupported' instead of being
    // silently dropped. A 'deleted' certified on top of a row the
    // store could not read would outlive it with no warning — the
    // Recovery identity would be removed while the unreadable row
    // persists behind it.
    if (raw.some((value) => (
      (documentId === undefined || recordField(value, 'documentId') === documentId)
      && !isDraftConflictRecord(value)
    ))) {
      return { status: 'unsupported' as const }
    }
    const records = readConflicts(raw)
    return {
      status: 'ok' as const,
      records: documentId === undefined
        ? records
        : records.filter((record) => record.documentId === documentId),
    }
  }

  /** Re-read the raw family rows after an unsupported save and derive
   *  BOTH the path they agree on (if any) AND why the family is
   *  unsupported. Mirrors the stale / conflict / path-mismatch
   *  branches' current-record re-read: the classification alone is not
   *  enough — the caller needs the family's real path to pin its
   *  candidate onto it instead of its own possibly-stale snapshot
   *  path, and the structured reason to route its state machine
   *  (fail-closed indeterminate vs. candidate-joins-family) without
   *  re-deriving either from the raw rows.
   *  Invalid (future-version / corrupt) rows contribute their readable
   *  `documentPath` too — a row can fail validation and still say
   *  where the family lives; a row without a readable path renders the
   *  whole probe indeterminate, as do disagreeing paths. `split`
   *  dominates the reason: a caller told "unsupported-primary with a
   *  path" would pin a candidate the readable rows disagree with —
   *  exactly the split the probe exists to prevent.
   *  Any read error degrades to null / unsupported-primary — the
   *  caller then fails closed (keeps the write flag set, writes no
   *  candidate) rather than guesses. */
  async function probeFamily(
    vaultId: string,
    documentId: string,
  ): Promise<{
    familyPath: string | null
    split: boolean
    primaryUnreadable: boolean
    conflictUnreadable: boolean
  }> {
    try {
      const parts: Array<string | null> = []
      let primaryUnreadable = false
      let conflictUnreadable = false
      const primary = await backend.get(draftKey(vaultId, documentId))
      if (primary !== null && primary !== undefined) {
        parts.push(readRawDocumentPath(primary))
        if (!isUnsavedDraft(primary)) primaryUnreadable = true
      }
      const conflicts = await backend.listConflicts(vaultId)
      for (const value of conflicts) {
        if (recordField(value, 'documentId') !== documentId) continue
        parts.push(readRawDocumentPath(value))
        if (!isDraftConflictRecord(value)) conflictUnreadable = true
      }
      const distinct = new Set(parts)
      const split = parts.length === 0 || parts.some((part) => part === null)
        || distinct.size > 1
      return {
        familyPath: split ? null : parts[0]!,
        split,
        primaryUnreadable,
        conflictUnreadable,
      }
    } catch {
      return {
        familyPath: null,
        split: false,
        primaryUnreadable: false,
        conflictUnreadable: false,
      }
    }
  }

  /** Map a raw family probe onto the outcome's `reason`: split
   *  dominates (never certify a path the readable rows disagree on),
   *  then an unreadable conflict row, then everything else (an
   *  unreadable primary, a malformed incoming draft, or a probe that
   *  could not read the store at all). */
  function probeReason(probe: {
    split: boolean
    conflictUnreadable: boolean
  }): UnsupportedFamilyReason {
    if (probe.split) return 'split-conflict-paths'
    if (probe.conflictUnreadable) return 'unsupported-conflict'
    return 'unsupported-primary'
  }

  return {
    async saveDraft(draft) {
      if (isManagedDraftPath((draft as any)?.documentPath)) {
        // Classification is before any backend transaction. D8.3 does not
        // introduce encrypted IndexedDB drafts; keep the edit in tab memory.
        return {
          status: 'unsupported' as const,
          familyPath: null,
          reason: 'unsupported-primary' as const,
        }
      }
      // A malformed draft carries no reliable identity — there is no
      // family to probe a path for; the incoming primary itself is
      // what cannot be persisted.
      if (!isUnsavedDraft(draft)) {
        return {
          status: 'unsupported' as const,
          familyPath: null,
          reason: 'unsupported-primary' as const,
        }
      }
      try {
        const result = await backend.save(cloneDraft(draft))
        if (result === 'saved') {
          // Return the exact stored value (DraftStore may preserve an
          // existing record's original createdAt; the caller compares
          // against this to certify a successful overwrite).
          const stored = await backend.get(draftKey(draft.vaultId, draft.documentId))
          if (isUnsavedDraft(stored)) {
            return { status: 'saved' as const, stored: cloneDraft(stored) }
          }
          const probe = await probeFamily(draft.vaultId, draft.documentId)
          return {
            status: 'unsupported' as const,
            familyPath: probe.familyPath,
            reason: probeReason(probe),
          }
        }
        if (result === 'stale' || result === 'conflict' || result === 'path-mismatch') {
          // Re-read the current record so the caller can pin the local
          // content as a conflict candidate WITH the exact cross-context
          // source captured (a 'stale' / 'conflict' / 'path-mismatch'
          // classification alone is not enough — the candidate must
          // record the source's updatedAt and the body the local edit
          // diverged from).
          const current = await backend.get(draftKey(draft.vaultId, draft.documentId))
          if (isUnsavedDraft(current)) {
            return { status: result, current: cloneDraft(current) }
          }
          if (result === 'path-mismatch' && (current === null || current === undefined)) {
            // Conflict-only family: the backend refused the path against
            // the same-identity candidates' shared path (a family exists
            // even without a primary record). Anchor the outcome on the
            // newest candidate so the caller pins its own candidate onto
            // the family path with the right cross-context marker,
            // instead of degrading to 'unsupported' and then re-deriving
            // the path from the stale snapshot (which would split the
            // family again).
            try {
              const family = await strictConflictRead(draft.vaultId, draft.documentId)
              if (family.status === 'ok' && family.records.length > 0) {
                return { status: 'path-mismatch', current: family.records[0] }
              }
            } catch {
              // Fall through to 'unsupported'.
            }
          }
          // A non-save result without a recoverable current record is
          // unsupported — the caller cannot pin a candidate on the
          // primary record. The family's raw rows may still agree on a
          // path the candidate can join (a conflict-only family whose
          // rows all sit at one path); when they do not, `null` tells
          // the caller to fail closed rather than split the family.
          const probe = await probeFamily(draft.vaultId, draft.documentId)
          return {
            status: 'unsupported' as const,
            familyPath: probe.familyPath,
            reason: probeReason(probe),
          }
        }
        // result === 'unsupported': a future-version / corrupt row
        // blocked the save. Report the path the family's raw rows
        // agree on (if any) so the caller pins its candidate ON the
        // family instead of at its own possibly-stale snapshot path,
        // plus the structured reason the family is unsupported.
        const probe = await probeFamily(draft.vaultId, draft.documentId)
        return {
          status: result,
          familyPath: probe.familyPath,
          reason: probeReason(probe),
        }
      } catch {
        return { status: 'failed' as const }
      }
    },

    async getDraft(vaultId, documentId) {
      if (!isDraftIdentity(vaultId, documentId)) return null
      try {
        const value = await backend.get(draftKey(vaultId, documentId))
        return isUnsavedDraft(value) && !isManagedDraftPath(value.documentPath) ? cloneDraft(value) : null
      } catch {
        return null
      }
    },

    async listDrafts(vaultId) {
      if (vaultId.trim().length === 0) return []
      try {
        return (await backend.list(vaultId))
          .filter((value): value is UnsavedDraft => isUnsavedDraft(value) && !isManagedDraftPath(value.documentPath))
          .map(cloneDraft)
          .sort((left, right) => (
            right.updatedAt - left.updatedAt
            || left.documentId.localeCompare(right.documentId)
          ))
      } catch {
        return []
      }
    },

    async inspectVaultRecovery(vaultId) {
      if (vaultId.trim().length === 0) {
        return {
          status: 'ok' as const,
          inventory: {
            primary: [], conflicts: [],
            unsupportedPrimaryCount: 0,
            unsupportedConflictCount: 0,
          },
        }
      }
      try {
        const raw = await backend.inspect(vaultId)
        const primary = raw.primary
          .filter((value): value is UnsavedDraft => isUnsavedDraft(value) && !isManagedDraftPath(value.documentPath))
          .map(cloneDraft)
        const conflicts = raw.conflicts
          .filter((value): value is DraftConflictRecord => isDraftConflictRecord(value) && !isManagedDraftPath(value.documentPath))
          .map(cloneConflictRecord)
        return {
          status: 'ok' as const,
          inventory: {
            primary,
            conflicts,
            unsupportedPrimaryCount: raw.primary.length - primary.length,
            unsupportedConflictCount: raw.conflicts.length - conflicts.length,
          },
        }
      } catch (error) {
        return { status: 'failed' as const, reason: storageFailureReason(error) }
      }
    },

    async inspectManagedDiaryRecovery(vaultId) {
      if (vaultId.trim().length === 0) {
        return {
          status: 'ok' as const,
          inventory: {
            primary: [], conflicts: [],
            unsupportedPrimaryCount: 0,
            unsupportedConflictCount: 0,
          },
        }
      }
      try {
        const raw = await backend.inspect(vaultId)
        const primary = raw.primary
          .filter((value): value is UnsavedDraft => isUnsavedDraft(value) && isManagedDraftPath(value.documentPath))
          .map(cloneDraft)
        const conflicts = raw.conflicts
          .filter((value): value is DraftConflictRecord => isDraftConflictRecord(value) && isManagedDraftPath(value.documentPath))
          .map(cloneConflictRecord)
        return {
          status: 'ok' as const,
          inventory: {
            primary,
            conflicts,
            unsupportedPrimaryCount: raw.primary.length - primary.length - raw.primary.filter((value) => isUnsavedDraft(value) && !isManagedDraftPath(value.documentPath)).length,
            unsupportedConflictCount: raw.conflicts.length - conflicts.length - raw.conflicts.filter((value) => isDraftConflictRecord(value) && !isManagedDraftPath(value.documentPath)).length,
          },
        }
      } catch (error) {
        return { status: 'failed' as const, reason: storageFailureReason(error) }
      }
    },

    async deleteDraft(vaultId, documentId) {
      if (!isDraftIdentity(vaultId, documentId)) return { status: 'failed' }
      try {
        return { status: await backend.delete(draftKey(vaultId, documentId)) }
      } catch {
        return { status: 'failed' }
      }
    },

    async deleteDraftIfUnchanged(expected) {
      if (!isUnsavedDraft(expected) || isManagedDraftPath(expected.documentPath)) return { status: 'failed' }
      try {
        return { status: await backend.deleteIfUnchanged(cloneDraft(expected)) }
      } catch {
        return { status: 'failed' }
      }
    },

    async deleteManagedDraftIfUnchanged(expected) {
      if (!isUnsavedDraft(expected) || !isManagedDraftPath(expected.documentPath)) return { status: 'failed' }
      try {
        return { status: await backend.deleteIfUnchanged(cloneDraft(expected)) }
      } catch {
        return { status: 'failed' }
      }
    },

    async moveDraft(vaultId, oldDocumentId, newDocumentId, newPath) {
      if (isManagedDraftPath(newPath)) return { status: 'unsupported' as const }
      if (!isDraftIdentity(vaultId, oldDocumentId)
        || !isDraftIdentity(vaultId, newDocumentId)
        || newPath.trim().length === 0) {
        return { status: 'failed' }
      }
      try {
        const status = await backend.move(
          vaultId,
          oldDocumentId,
          newDocumentId,
          newPath,
        )
        return { status }
      } catch {
        return { status: 'failed' }
      }
    },

    async moveConflicts(vaultId, oldDocumentId, newDocumentId, newPath) {
      if (isManagedDraftPath(newPath)) return 0
      if (!isDraftIdentity(vaultId, oldDocumentId)
        || !isDraftIdentity(vaultId, newDocumentId)
        || newPath.trim().length === 0) {
        return 0
      }
      try {
        return await backend.moveConflicts(
          vaultId,
          oldDocumentId,
          newDocumentId,
          newPath,
        )
      } catch {
        return 0
      }
    },

    async moveDraftFamily(vaultId, documentId, newPath) {
      if (isManagedDraftPath(newPath)) return { status: 'unsupported' as const, movedConflicts: 0 }
      if (!isDraftIdentity(vaultId, documentId) || newPath.trim().length === 0) {
        return { status: 'failed', movedConflicts: 0 }
      }
      try {
        return await backend.moveFamily(vaultId, documentId, newPath)
      } catch {
        // Any error (including an aborted cross-store transaction) means
        // the family move rolled back. Report a structured failure so the
        // caller surfaces a warning instead of reporting a clean 'moved'
        // with conflicts stranded on the old path.
        return { status: 'failed', movedConflicts: 0 }
      }
    },

    async moveDraftFamilyIfAtPath(vaultId, documentId, expectedFamilyPath, newPath) {
      if (isManagedDraftPath(expectedFamilyPath) || isManagedDraftPath(newPath)) {
        return { status: 'unsupported' as const }
      }
      if (!isDraftIdentity(vaultId, documentId)
        || expectedFamilyPath.trim().length === 0
        || newPath.trim().length === 0) {
        return { status: 'failed' as const }
      }
      try {
        return await backend.moveFamilyIfAtPath(
          vaultId, documentId, expectedFamilyPath, newPath,
        )
      } catch {
        // Any error (including an aborted cross-store transaction) means
        // nothing moved. Report a structured failure so the caller fails
        // closed (keeps the write flag set) instead of guessing.
        return { status: 'failed' as const }
      }
    },

    async probeDraftFamily(vaultId, documentId) {
      if (!isDraftIdentity(vaultId, documentId)) return { status: 'failed' as const }
      try {
        const paths = new Set<string>()
        let hasPrimary = false
        let primaryUnreadable = false
        let conflictUnreadable = false
        const primary = await backend.get(draftKey(vaultId, documentId))
        if (primary !== null && primary !== undefined) {
          if (isUnsavedDraft(primary)) {
            hasPrimary = true
            paths.add(primary.documentPath)
          } else {
            primaryUnreadable = true
          }
        }
        for (const value of await backend.listConflicts(vaultId)) {
          if (recordField(value, 'documentId') !== documentId) continue
          if (!isDraftConflictRecord(value)) {
            conflictUnreadable = true
            continue
          }
          paths.add(value.documentPath)
        }
        // Apply probeReason's priority — split dominates an unreadable
        // conflict row, which dominates an unreadable primary: a caller
        // told "path" while a same-identity row is unreadable would
        // certify a family the store could not fully read.
        if (paths.size > 1) {
          return { status: 'unsupported' as const, reason: 'split-conflict-paths' as const }
        }
        if (conflictUnreadable) {
          return { status: 'unsupported' as const, reason: 'unsupported-conflict' as const }
        }
        if (primaryUnreadable) {
          return { status: 'unsupported' as const, reason: 'unsupported-primary' as const }
        }
        if (paths.size === 0) return { status: 'none' as const }
        return {
          status: 'path' as const,
          familyPath: [...paths][0]!,
          hasPrimary,
        }
      } catch {
        // A read error is not an empty family: report a structured
        // failure so the caller fails closed instead of certifying
        // "none" on top of an unread store.
        return { status: 'failed' as const }
      }
    },

    async clearVaultDrafts(vaultId) {
      if (vaultId.trim().length === 0) return false
      try {
        await backend.clear(vaultId)
        return true
      } catch {
        return false
      }
    },

    async saveConflictDraft(record) {
      if (!isDraftConflictRecord(record)) return { status: 'unsupported' }
      if (isManagedDraftPath(record.documentPath)) return { status: 'unsupported' }
      if (record.vaultId.trim().length === 0
        || record.documentId.trim().length === 0
        || record.conflictId.trim().length === 0) {
        return { status: 'unsupported' }
      }
      try {
        await backend.saveConflict(cloneConflictRecord(record))
        return { status: 'saved' }
      } catch {
        return { status: 'failed' }
      }
    },

    async saveConflictCandidate(record) {
      // A malformed candidate cannot join a family: report
      // unsupported-conflict (not 'failed') so the caller's state
      // machine treats it as a fail-closed family condition, mirroring
      // saveConflictDraft's pre-validation.
      if (!isDraftConflictRecord(record)) {
        return { status: 'unsupported', familyPath: null, reason: 'unsupported-conflict' }
      }
      if (isManagedDraftPath(record.documentPath)) {
        return { status: 'unsupported', familyPath: null, reason: 'unsupported-conflict' }
      }
      if (record.vaultId.trim().length === 0
        || record.documentId.trim().length === 0
        || record.conflictId.trim().length === 0) {
        return { status: 'unsupported', familyPath: null, reason: 'unsupported-conflict' }
      }
      try {
        return await backend.saveConflictCandidate(cloneConflictRecord(record))
      } catch {
        // A store error or aborted family transaction (including a
        // duplicate conflictId key) is not an empty write: fail closed
        // so the caller keeps the write flag set and the tab open —
        // the bytes are still only in memory.
        return { status: 'failed' }
      }
    },

    async listConflictDrafts(vaultId) {
      if (vaultId.trim().length === 0) return []
      try {
        return readConflicts(await backend.listConflicts(vaultId))
          .filter((record) => !isManagedDraftPath(record.documentPath))
      } catch {
        return []
      }
    },

    async listConflictDraftsStrict(vaultId, documentId) {
      if (vaultId.trim().length === 0) return { status: 'ok' as const, records: [] }
      try {
        const result = await strictConflictRead(vaultId, documentId)
        if (result.status === 'ok') {
          result.records = result.records.filter((record) => !isManagedDraftPath(record.documentPath))
        }
        return result
      } catch {
        // A read error is not an empty store. Report a structured
        // failure so file transactions fail closed (keep the identity
        // visible, warn the user) instead of mistaking unread
        // survivors for absent ones.
        return { status: 'failed' as const }
      }
    },

    async deleteConflictDraft(vaultId, documentId, conflictId) {
      if (vaultId.trim().length === 0
        || documentId.trim().length === 0
        || conflictId.trim().length === 0) {
        return 'failed'
      }
      try {
        return await backend.deleteConflict(vaultId, documentId, conflictId)
      } catch {
        // A store error is not the same as an absent record. Report
        // 'failed' so callers only treat a genuine 'deleted'/'missing'
        // as success — otherwise the record survives and silently
        // resurfaces on the next discovery.
        return 'failed'
      }
    },

    async deleteConflictDraftIfUnchanged(expected) {
      if (!isDraftConflictRecord(expected) || isManagedDraftPath(expected.documentPath)) return { status: 'failed' }
      try {
        return { status: await backend.deleteConflictIfUnchanged(cloneConflictRecord(expected)) }
      } catch {
        return { status: 'failed' }
      }
    },

    async deleteManagedConflictDraftIfUnchanged(expected) {
      if (!isDraftConflictRecord(expected) || !isManagedDraftPath(expected.documentPath)) return { status: 'failed' }
      try {
        return { status: await backend.deleteConflictIfUnchanged(cloneConflictRecord(expected)) }
      } catch {
        return { status: 'failed' }
      }
    },

    async clearVaultConflictDrafts(vaultId) {
      if (vaultId.trim().length === 0) return false
      try {
        await backend.clearConflicts(vaultId)
        return true
      } catch {
        return false
      }
    },
  }
}

export function createMemoryDraftBackend(): MemoryDraftStorageBackend {
  const records = new Map<string, unknown>()
  const conflictRecords = new Map<string, unknown>()
  const failures = new Set<BackendOperation>()

  function serializedKey(vaultId: string, documentId: string): string {
    return JSON.stringify(draftKey(vaultId, documentId))
  }

  function serializedConflictKey(
    vaultId: string,
    documentId: string,
    conflictId: string,
  ): string {
    // Conflict records share the (vaultId, documentId) identity with
    // the primary draft but live under a disjoint Map region by
    // prefixing the conflictId. The prefix ensures a stale
    // listDrafts() (which filters by vaultId) never returns conflict
    // rows and vice versa.
    return `conflict:${vaultId}:${documentId}:${conflictId}`
  }

  function consumeFailure(operation: BackendOperation): void {
    if (!failures.delete(operation)) return
    throw new Error(`Injected draft backend ${operation} failure`)
  }

  return {
    async save(draft) {
      consumeFailure('save')
      if (isManagedDraftPath(draft.documentPath)) return 'unsupported'
      const familyKey = serializedKey(draft.vaultId, draft.documentId)
      const current = records.get(familyKey)
      const decision = decideSave(current, draft)
      if (decision.result !== 'saved') return decision.result
      // Path-authority check (see DraftStorageBackend.save): a plain
      // primary save must NEVER silently migrate the family to a
      // different path. The server file operation is the only
      // authoritative path source — implicit migration would let a
      // stale old-path Tab drag a family back from the path the
      // server actually lives on. The caller must obtain an explicit
      // commitMoves() mapping (or a persistent quarantine) before
      // changing the family's path. When the primary record is
      // missing, the same-identity candidates still form a family —
      // their shared path is authoritative (see conflictFamilyPath),
      // so a diverging first-write is refused instead of creating a
      // primary that splits the family.
      const currentPath = isUnsavedDraft(current) ? current.documentPath : null
      if (currentPath !== null && currentPath !== decision.draft.documentPath) {
        return 'path-mismatch'
      }
      // Family-state check: if any same-identity conflict row is
      // unsupported (future-version / corrupt), the family is in an
      // indeterminate state — the caller must persist the local
      // content as a candidate rather than a plain overwrite.
      // Without this check, a future-version conflict could survive
      // a primary write, invisible to Recovery (the only discoverable
      // surface is the conflict store; a silently overwriting primary
      // hides the corruption behind a fresh record).
      for (const value of conflictRecords.values()) {
        if (recordField(value, 'vaultId') !== draft.vaultId
          || recordField(value, 'documentId') !== draft.documentId) continue
        if (!isDraftConflictRecord(value)) return 'unsupported'
      }
      if (currentPath === null) {
        const family = conflictFamilyPath(
          conflictRecords.values(), draft.vaultId, draft.documentId,
        )
        if (family.status === 'unsupported' || family.status === 'split') {
          return 'unsupported'
        }
        if (family.status === 'path' && family.path !== decision.draft.documentPath) {
          return 'path-mismatch'
        }
      }
      records.set(familyKey, cloneDraft(decision.draft))
      return 'saved'
    },

    async get([vaultId, documentId]) {
      consumeFailure('get')
      return cloneUnknown(records.get(serializedKey(vaultId, documentId)) ?? null)
    },

    async list(vaultId) {
      consumeFailure('list')
      return [...records.values()]
        .filter((value) => recordVaultId(value) === vaultId)
        .map(cloneUnknown)
    },

    async delete([vaultId, documentId]) {
      consumeFailure('delete')
      const key = serializedKey(vaultId, documentId)
      const value = records.get(key)
      if (value === undefined || value === null) return 'missing'
      if (isManagedDraftPath(recordField(value, 'documentPath'))) return 'unsupported'
      if (!isUnsavedDraft(value)) return 'unsupported'
      records.delete(key)
      return 'deleted'
    },

    async deleteIfUnchanged(expected) {
      consumeFailure('delete')
      const key = serializedKey(expected.vaultId, expected.documentId)
      const value = records.get(key)
      if (value === undefined || value === null) return 'missing'
      if (isManagedDraftPath(recordField(value, 'documentPath'))) return 'unsupported'
      if (!isUnsavedDraft(value)) return 'unsupported'
      if (!draftsEqual(value, expected)) return 'stale'
      records.delete(key)
      return 'deleted'
    },

    async move(vaultId, oldDocumentId, newDocumentId, newPath) {
      consumeFailure('move')
      const oldKey = serializedKey(vaultId, oldDocumentId)
      const newKey = serializedKey(vaultId, newDocumentId)
      const source = records.get(oldKey)
      const target = oldKey === newKey ? undefined : records.get(newKey)
      if (isManagedDraftPath(recordField(source, 'documentPath'))
        || isManagedDraftPath(newPath)) return 'unsupported'
      const decision = decideMove(source, target, newDocumentId, newPath)
      if (decision.result !== 'moved') return decision.result

      records.set(newKey, cloneDraft(decision.draft))
      if (oldKey !== newKey) records.delete(oldKey)
      return 'moved'
    },

    async moveConflicts(vaultId, oldDocumentId, newDocumentId, newPath) {
      consumeFailure('moveConflicts')
      if (isManagedDraftPath(newPath)) return 0
      const family = [...conflictRecords.values()].filter((value) => (
        recordField(value, 'vaultId') === vaultId
        && recordField(value, 'documentId') === oldDocumentId
      ))
      if (family.some((value) => (
        isManagedDraftPath(recordField(value, 'documentPath'))
        || !isDraftConflictRecord(value)
      ))) return 0
      let moved = 0
      for (const value of family) {
        if (!isDraftConflictRecord(value)) continue
        const updated: DraftConflictRecord = {
          ...value,
          documentId: newDocumentId,
          documentPath: newPath,
        }
        if (oldDocumentId !== newDocumentId) {
          conflictRecords.delete(
            serializedConflictKey(vaultId, oldDocumentId, value.conflictId),
          )
        }
        conflictRecords.set(
          serializedConflictKey(vaultId, newDocumentId, value.conflictId),
          cloneConflictRecord(updated),
        )
        moved += 1
      }
      return moved
    },

    async moveFamily(vaultId, documentId, newPath) {
      consumeFailure('moveFamily')
      if (isManagedDraftPath(newPath)) return { status: 'unsupported', movedConflicts: 0 }
      const familyKey = serializedKey(vaultId, documentId)
      const source = records.get(familyKey)
      if (isManagedDraftPath(recordField(source, 'documentPath'))) {
        return { status: 'unsupported', movedConflicts: 0 }
      }
      // A rename never changes the documentId identity, so there is no
      // target record to collide with — decideMove only classifies the
      // source here.
      const decision = decideMove(source, undefined, documentId, newPath)
      // Pre-flight the WHOLE family before writing anything (see the
      // IndexedDB backend for the full rationale). An unsupported
      // primary short-circuits: its conflicts must stay on the old
      // path with it — persistence keeps the in-memory snapshot on
      // the old path for an unsupported result, so moving the
      // conflicts would orphan them on a path nothing points at.
      if (decision.result === 'unsupported') {
        return { status: 'unsupported', movedConflicts: 0 }
      }
      // Validate every conflict row for this identity BEFORE applying
      // anything: a future-version or corrupt row blocks the whole
      // family move — migrating the valid rows would strand the
      // unreadable one on the pre-rename path, silently.
      const conflictUpdates: Array<{ key: string; record: DraftConflictRecord }> = []
      for (const value of [...conflictRecords.values()]) {
        if (recordField(value, 'vaultId') !== vaultId
          || recordField(value, 'documentId') !== documentId) continue
        if (isManagedDraftPath(recordField(value, 'documentPath'))) {
          return { status: 'unsupported', movedConflicts: 0 }
        }
        if (!isDraftConflictRecord(value)) {
          return { status: 'unsupported', movedConflicts: 0 }
        }
        conflictUpdates.push({
          key: serializedConflictKey(vaultId, documentId, value.conflictId),
          record: { ...value, documentPath: newPath },
        })
      }
      // Plan every conflict update BEFORE writing anything, then apply
      // the whole family in one step. An injected conflict-phase failure
      // therefore leaves the primary untouched too, mirroring the
      // IndexedDB cross-store transaction rollback.
      consumeFailure('moveFamilyConflicts')
      if (decision.result === 'moved') {
        records.set(familyKey, cloneDraft(decision.draft))
      }
      for (const { key, record } of conflictUpdates) {
        conflictRecords.set(key, cloneConflictRecord(record))
      }
      return { status: decision.result, movedConflicts: conflictUpdates.length }
    },

    async moveFamilyIfAtPath(vaultId, documentId, expectedFamilyPath, newPath) {
      consumeFailure('moveFamilyIfAtPath')
      if (isManagedDraftPath(expectedFamilyPath) || isManagedDraftPath(newPath)) {
        return { status: 'unsupported' }
      }
      const familyKey = serializedKey(vaultId, documentId)
      const source = records.get(familyKey)
      if (isManagedDraftPath(recordField(source, 'documentPath'))) {
        return { status: 'unsupported' }
      }
      const decision = decideMove(source, undefined, documentId, newPath)
      // Pre-flight the WHOLE family before writing anything, exactly
      // like moveFamily: an unsupported primary blocks the move — its
      // conflicts must stay on the current path with it.
      if (decision.result === 'unsupported') {
        return { status: 'unsupported' }
      }
      // Derive the family's CURRENT path from the raw rows: the primary
      // record's path (when one exists) plus every same-identity conflict
      // row's path. Validating every conflict row here doubles as
      // moveFamily's pre-flight — an unreadable row blocks the move, and
      // it would corrupt the derivation anyway.
      const paths = new Set<string>()
      if (isUnsavedDraft(source)) paths.add(source.documentPath)
      const conflictUpdates: Array<{ key: string; record: DraftConflictRecord }> = []
      for (const value of [...conflictRecords.values()]) {
        if (recordField(value, 'vaultId') !== vaultId
          || recordField(value, 'documentId') !== documentId) continue
        if (isManagedDraftPath(recordField(value, 'documentPath'))) {
          return { status: 'unsupported' }
        }
        if (!isDraftConflictRecord(value)) {
          return { status: 'unsupported' }
        }
        paths.add(value.documentPath)
        conflictUpdates.push({
          key: serializedConflictKey(vaultId, documentId, value.conflictId),
          record: { ...value, documentPath: newPath },
        })
      }
      if (paths.size === 0) {
        // No family rows at all: nothing to drag anywhere.
        return { status: 'missing' }
      }
      if (paths.size > 1) {
        // The readable rows disagree on the path: the family is
        // indeterminate and the move fails closed — moving one side
        // would strand the other.
        return { status: 'unsupported' }
      }
      const currentPath = [...paths][0]!
      if (currentPath !== expectedFamilyPath) {
        // The CAS failed: another context's verified rename moved the
        // family off the quarantine's certified path. Move NOTHING and
        // certify where the family lives now — the caller adopts that
        // path instead of retrying the stale target.
        return { status: 'path-mismatch', currentPath }
      }
      // The family still sits at the certified expected path — apply the
      // move as one unit. The injected conflict-phase failure leaves the
      // primary untouched too, mirroring the IndexedDB cross-store
      // transaction rollback, exactly like moveFamily.
      consumeFailure('moveFamilyConflicts')
      if (decision.result === 'moved') {
        records.set(familyKey, cloneDraft(decision.draft))
      }
      for (const { key, record } of conflictUpdates) {
        conflictRecords.set(key, cloneConflictRecord(record))
      }
      return { status: decision.result === 'moved' ? 'moved' : 'missing' }
    },

    async clear(vaultId) {
      consumeFailure('clear')
      for (const [key, value] of records) {
        if (isUnsavedDraft(value) && value.vaultId === vaultId
          && !isManagedDraftPath(value.documentPath)) records.delete(key)
      }
    },

    async saveConflict(record) {
      consumeFailure('saveConflict')
      if (isManagedDraftPath(record.documentPath)) return
      const key = serializedConflictKey(record.vaultId, record.documentId, record.conflictId)
      if (conflictRecords.has(key)) throw new Error('Draft conflict record already exists')
      conflictRecords.set(key, cloneConflictRecord(record))
    },

    async saveConflictCandidate(record) {
      consumeFailure('saveConflictCandidate')
      if (isManagedDraftPath(record.documentPath)) {
        return { status: 'unsupported', familyPath: null, reason: 'unsupported-conflict' }
      }
      // Derive the family path from the RAW rows BEFORE writing —
      // mirroring the IndexedDB backend's both-store transaction,
      // where the derivation and the add run inside one readwrite
      // transaction. The memory backend is single-threaded, so the
      // read-then-write here is atomic with respect to any other
      // store operation.
      const authority = conflictCandidateAuthority(
        records.get(serializedKey(record.vaultId, record.documentId)),
        conflictRecords.values(),
        record.vaultId,
        record.documentId,
      )
      if (authority.status === 'unsupported') {
        return { status: 'unsupported', familyPath: null, reason: authority.reason }
      }
      if (authority.status === 'path' && authority.path !== record.documentPath) {
        return { status: 'path-mismatch', familyPath: authority.path }
      }
      const key = serializedConflictKey(record.vaultId, record.documentId, record.conflictId)
      if (conflictRecords.has(key)) throw new Error('Draft conflict record already exists')
      conflictRecords.set(key, cloneConflictRecord(record))
      return { status: 'saved', stored: cloneConflictRecord(record) }
    },

    async listConflicts(vaultId) {
      consumeFailure('listConflicts')
      // Return the vault's raw rows — future-version / corrupt records
      // included — exactly like the IndexedDB backend's getAll. Store-
      // level readers filter; family pre-flight must SEE the invalid
      // rows to block on them.
      return [...conflictRecords.values()]
        .filter((value) => recordField(value, 'vaultId') === vaultId)
        .map(cloneUnknown)
    },

    async inspect(vaultId) {
      consumeFailure('inspect')
      return {
        primary: [...records.values()]
          .filter((value) => recordField(value, 'vaultId') === vaultId)
          .map(cloneUnknown),
        conflicts: [...conflictRecords.values()]
          .filter((value) => recordField(value, 'vaultId') === vaultId)
          .map(cloneUnknown),
      }
    },

    async deleteConflict(vaultId, documentId, conflictId) {
      consumeFailure('deleteConflict')
      const key = serializedConflictKey(vaultId, documentId, conflictId)
      const value = conflictRecords.get(key)
      if (value === undefined || value === null) return 'missing'
      if (isManagedDraftPath(recordField(value, 'documentPath'))) return 'unsupported'
      conflictRecords.delete(key)
      return 'deleted'
    },

    async deleteConflictIfUnchanged(expected) {
      consumeFailure('deleteConflictIfUnchanged')
      const key = serializedConflictKey(
        expected.vaultId, expected.documentId, expected.conflictId,
      )
      const value = conflictRecords.get(key)
      if (value === undefined || value === null) return 'missing'
      if (isManagedDraftPath(recordField(value, 'documentPath'))) return 'unsupported'
      if (!isDraftConflictRecord(value)) return 'unsupported'
      if (!conflictDraftsEqual(value, expected)) return 'stale'
      conflictRecords.delete(key)
      return 'deleted'
    },

    async clearConflicts(vaultId) {
      consumeFailure('clearConflicts')
      for (const [key, value] of conflictRecords) {
        if (isDraftConflictRecord(value) && value.vaultId === vaultId
          && !isManagedDraftPath(value.documentPath)) {
          conflictRecords.delete(key)
        }
      }
    },

    failNext(operation) {
      failures.add(operation)
    },

    async seedRaw(value) {
      const vaultId = recordField(value, 'vaultId')
      const documentId = recordField(value, 'documentId')
      if (typeof vaultId !== 'string' || typeof documentId !== 'string') {
        throw new Error('Raw draft seed requires vaultId and documentId')
      }
      records.set(serializedKey(vaultId, documentId), cloneUnknown(value))
    },

    async seedRawConflict(value) {
      const vaultId = recordField(value, 'vaultId')
      const documentId = recordField(value, 'documentId')
      const conflictId = recordField(value, 'conflictId')
      if (typeof vaultId !== 'string'
        || typeof documentId !== 'string'
        || typeof conflictId !== 'string') {
        throw new Error('Raw conflict seed requires vaultId, documentId and conflictId')
      }
      conflictRecords.set(
        serializedConflictKey(vaultId, documentId, conflictId),
        cloneUnknown(value),
      )
    },
  }
}

export function createIndexedDbDraftBackend(
  factory: IDBFactory | undefined = globalThis.indexedDB,
): DraftStorageBackend {
  let databasePromise: Promise<IDBDatabase> | null = null

  function database(): Promise<IDBDatabase> {
    if (!factory) {
      return Promise.reject(new DraftStorageError(
        'indexeddb-unavailable', 'IndexedDB is unavailable',
      ))
    }
    if (!databasePromise) {
      const cached = openDatabase(factory)
        .then((db) => {
          const release = () => {
            if (databasePromise === cached) databasePromise = null
          }
          db.onversionchange = () => {
            db.close()
            release()
          }
          db.onclose = release
          return db
        })
        .catch((error: unknown) => {
          if (databasePromise === cached) databasePromise = null
          throw error
        })
      databasePromise = cached
    }
    return databasePromise
  }

  return {
    async save(draft) {
      const db = await database()
      if (isManagedDraftPath(draft.documentPath)) return 'unsupported'
      // ONE transaction across both stores: the family pre-flight below
      // must read the same-identity conflict rows and write the primary
      // record atomically, mirroring the memory backend (and the family
      // move). Scanning the conflict store in a separate transaction
      // would let a same-identity unsupported row land between the scan
      // and the write — the primary would be updated while the
      // unreadable row stays invisible to Recovery.
      const transaction = db.transaction(
        [DRAFT_STORE_NAME, CONFLICT_STORE_NAME],
        'readwrite',
      )
      const store = transaction.objectStore(DRAFT_STORE_NAME)
      const current = await request(store.get(
        idbKey(draft.vaultId, draft.documentId),
      ))
      const decision = decideSave(current, draft)
      if (decision.result === 'saved') {
        // Path-authority check (see DraftStorageBackend.save): a plain
        // primary save must NEVER silently migrate the family to a
        // different path. Path changes are only authoritative when
        // they come from an explicit commitMoves() mapping (or a
        // persistent quarantine); implicit migration would let a
        // stale old-path Tab drag a family back from the path the
        // server actually lives on. The conflict candidates stay on
        // the family's real path and the caller persists the local
        // content as a candidate instead.
        const currentPath = isUnsavedDraft(current) ? current.documentPath : null
        if (currentPath !== null && currentPath !== decision.draft.documentPath) {
          await transactionDone(transaction)
          return 'path-mismatch'
        }
        // Family pre-flight: scan the same-identity conflict rows
        // BEFORE writing the primary. Any unsupported (future-version /
        // corrupt) row blocks the whole save — without this the primary
        // would be updated while the unreadable row survives in the
        // conflict store, invisible to Recovery and outliving the write
        // with no warning. Mirrors the memory backend's family-state
        // check, which the IndexedDB backend previously skipped.
        const conflictValues = await request(
          transaction.objectStore(CONFLICT_STORE_NAME)
            .index(CONFLICT_VAULT_INDEX).getAll(draft.vaultId),
        )
        for (const value of conflictValues) {
          if (recordField(value, 'documentId') !== draft.documentId) continue
          if (!isDraftConflictRecord(value)) {
            await transactionDone(transaction)
            return 'unsupported'
          }
        }
        // Conflict-only family path authority: with no primary record
        // the same-identity candidates still form a family — their
        // shared path is authoritative, and split paths are
        // indeterminate (see conflictFamilyPath). A diverging
        // first-write is refused instead of creating a primary that
        // splits the family.
        if (currentPath === null) {
          const family = conflictFamilyPath(
            conflictValues, draft.vaultId, draft.documentId,
          )
          if (family.status === 'unsupported' || family.status === 'split') {
            await transactionDone(transaction)
            return 'unsupported'
          }
          if (family.status === 'path' && family.path !== decision.draft.documentPath) {
            await transactionDone(transaction)
            return 'path-mismatch'
          }
        }
        store.put(cloneDraft(decision.draft))
      }
      await transactionDone(transaction)
      return decision.result
    },

    async get(key) {
      const db = await database()
      const transaction = db.transaction(DRAFT_STORE_NAME, 'readonly')
      const value = await request(
        transaction.objectStore(DRAFT_STORE_NAME).get(idbKey(...key)),
      )
      await transactionDone(transaction)
      return value ?? null
    },

    async list(vaultId) {
      const db = await database()
      const transaction = db.transaction(DRAFT_STORE_NAME, 'readonly')
      const values = await request(
        transaction.objectStore(DRAFT_STORE_NAME).index(VAULT_UPDATED_INDEX)
          .getAll(IDBKeyRange.bound([vaultId, 0], [vaultId, Number.MAX_SAFE_INTEGER])),
      )
      await transactionDone(transaction)
      return values
    },

    async inspect(vaultId) {
      const db = await database()
      const transaction = db.transaction(
        [DRAFT_STORE_NAME, CONFLICT_STORE_NAME],
        'readonly',
      )
      // Scope the raw management scan by the compound primary-key prefix.
      // Unlike the updatedAt index this still includes corrupt/future rows
      // whose indexed metadata is malformed, without reading other vaults.
      const [allPrimary, allConflicts] = await Promise.all([
        request(transaction.objectStore(DRAFT_STORE_NAME).getAll(
          IDBKeyRange.bound([vaultId, ''], [vaultId, '\uffff']),
        )),
        request(transaction.objectStore(CONFLICT_STORE_NAME).getAll(
          IDBKeyRange.bound([vaultId, '', ''], [vaultId, '\uffff', '\uffff']),
        )),
      ])
      const [primary, conflicts] = [
        allPrimary.filter((value) => recordField(value, 'vaultId') === vaultId),
        allConflicts.filter((value) => recordField(value, 'vaultId') === vaultId),
      ]
      await transactionDone(transaction)
      return { primary, conflicts }
    },

    async delete(key) {
      const db = await database()
      const transaction = db.transaction(DRAFT_STORE_NAME, 'readwrite')
      const store = transaction.objectStore(DRAFT_STORE_NAME)
      const value = await request(store.get(idbKey(...key)))
      if (value === undefined || value === null) {
        await transactionDone(transaction)
        return 'missing'
      }
      if (isManagedDraftPath(recordField(value, 'documentPath'))) {
        await transactionDone(transaction)
        return 'unsupported'
      }
      if (!isUnsavedDraft(value)) {
        await transactionDone(transaction)
        return 'unsupported'
      }
      store.delete(idbKey(...key))
      await transactionDone(transaction)
      return 'deleted'
    },

    async deleteIfUnchanged(expected) {
      const db = await database()
      const transaction = db.transaction(DRAFT_STORE_NAME, 'readwrite')
      const store = transaction.objectStore(DRAFT_STORE_NAME)
      const key = idbKey(expected.vaultId, expected.documentId)
      const value = await request(store.get(key))
      let result: ConditionalDeleteResult
      if (value === undefined || value === null) result = 'missing'
      else if (isManagedDraftPath(recordField(value, 'documentPath'))) result = 'unsupported'
      else if (!isUnsavedDraft(value)) result = 'unsupported'
      else if (!draftsEqual(value, expected)) result = 'stale'
      else {
        store.delete(key)
        result = 'deleted'
      }
      await transactionDone(transaction)
      return result
    },

    async move(vaultId, oldDocumentId, newDocumentId, newPath) {
      const db = await database()
      const transaction = db.transaction(DRAFT_STORE_NAME, 'readwrite')
      const store = transaction.objectStore(DRAFT_STORE_NAME)
      const oldKey = idbKey(vaultId, oldDocumentId)
      const newKey = idbKey(vaultId, newDocumentId)
      const source = await request(store.get(oldKey))
      const target = oldDocumentId === newDocumentId
        ? undefined
        : await request(store.get(newKey))
      if (isManagedDraftPath(recordField(source, 'documentPath'))
        || isManagedDraftPath(newPath)) {
        await transactionDone(transaction)
        return 'unsupported'
      }
      const decision = decideMove(source, target, newDocumentId, newPath)
      if (decision.result === 'moved') {
        store.put(cloneDraft(decision.draft))
        if (oldDocumentId !== newDocumentId) store.delete(oldKey)
      }
      await transactionDone(transaction)
      return decision.result
    },

    async moveConflicts(vaultId, oldDocumentId, newDocumentId, newPath) {
      const db = await database()
      if (isManagedDraftPath(newPath)) return 0
      const transaction = db.transaction(CONFLICT_STORE_NAME, 'readwrite')
      const store = transaction.objectStore(CONFLICT_STORE_NAME)
      const values = await request(
        store.index(CONFLICT_VAULT_INDEX).getAll(vaultId),
      )
      const family = values.filter((value) => (
        recordField(value, 'documentId') === oldDocumentId
      ))
      if (family.some((value) => (
        isManagedDraftPath(recordField(value, 'documentPath'))
        || !isDraftConflictRecord(value)
      ))) {
        await transactionDone(transaction)
        return 0
      }
      let moved = 0
      for (const value of family) {
        if (!isDraftConflictRecord(value)) continue
        // Preserve conflictId, body, baseline, timestamps, and origin;
        // only the identity/path follow the rename. Same-documentId
        // renames keep the compound key and update in place.
        const updated: DraftConflictRecord = {
          ...value,
          documentId: newDocumentId,
          documentPath: newPath,
        }
        if (oldDocumentId !== newDocumentId) {
          store.delete(idbConflictKey(vaultId, oldDocumentId, value.conflictId))
        }
        store.put(cloneConflictRecord(updated))
        moved += 1
      }
      await transactionDone(transaction)
      return moved
    },

    async moveFamily(vaultId, documentId, newPath) {
      const db = await database()
      if (isManagedDraftPath(newPath)) return { status: 'unsupported', movedConflicts: 0 }
      // ONE transaction across both stores: if anything fails, the whole
      // family move aborts and rolls back — the primary can never end up
      // renamed while its conflict candidates are stranded on the
      // pre-rename path (which recovery would misclassify).
      const transaction = db.transaction(
        [DRAFT_STORE_NAME, CONFLICT_STORE_NAME],
        'readwrite',
      )
      const draftStore = transaction.objectStore(DRAFT_STORE_NAME)
      const conflictStore = transaction.objectStore(CONFLICT_STORE_NAME)
      const familyKey = idbKey(vaultId, documentId)
      const source = await request(draftStore.get(familyKey))
      if (isManagedDraftPath(recordField(source, 'documentPath'))) {
        await transactionDone(transaction)
        return { status: 'unsupported', movedConflicts: 0 }
      }
      // A rename never changes the documentId identity, so there is no
      // target record — decideMove only classifies the source here.
      const decision = decideMove(source, undefined, documentId, newPath)
      // Pre-flight the whole family BEFORE writing anything. Database-
      // level atomicity is not enough: an unsupported primary still
      // splits the family in product semantics — persistence keeps the
      // in-memory snapshot on the old path for an unsupported result,
      // so migrating the conflicts would orphan them on a path neither
      // the snapshot nor the primary record points at.
      if (decision.result === 'unsupported') {
        await transactionDone(transaction)
        return { status: 'unsupported', movedConflicts: 0 }
      }
      const familyConflicts: DraftConflictRecord[] = []
      const values = await request(
        conflictStore.index(CONFLICT_VAULT_INDEX).getAll(vaultId),
      )
      for (const value of values) {
        if (recordField(value, 'documentId') !== documentId) continue
        if (isManagedDraftPath(recordField(value, 'documentPath'))) {
          await transactionDone(transaction)
          return { status: 'unsupported', movedConflicts: 0 }
        }
        // A future-version or corrupt row for THIS identity blocks the
        // whole move: migrating the valid rows would strand the
        // unreadable one on the pre-rename path — silently, with no
        // warning, and recovery could never resurface it under the new
        // path. Validate first, write nothing until every row checks
        // out.
        if (!isDraftConflictRecord(value)) {
          await transactionDone(transaction)
          return { status: 'unsupported', movedConflicts: 0 }
        }
        familyConflicts.push(value)
      }
      // All rows validated — apply the family as one unit.
      if (decision.result === 'moved') {
        // Same keyPath value (documentId unchanged) — put updates the
        // record's path in place, preserving body/baseline/timestamps.
        draftStore.put(cloneDraft(decision.draft))
      }
      // Conflict candidates travel with the rename even when the primary
      // record is missing (conflict-only documents), so their rows are
      // not stranded on the old path.
      for (const record of familyConflicts) {
        // Same compound key (documentId unchanged) — put updates the
        // path in place, preserving conflictId/body/baseline/timestamps
        // and origin.
        conflictStore.put(cloneConflictRecord({ ...record, documentPath: newPath }))
      }
      await transactionDone(transaction)
      return { status: decision.result, movedConflicts: familyConflicts.length }
    },

    async moveFamilyIfAtPath(vaultId, documentId, expectedFamilyPath, newPath) {
      const db = await database()
      if (isManagedDraftPath(expectedFamilyPath) || isManagedDraftPath(newPath)) {
        return { status: 'unsupported' }
      }
      // ONE transaction across both stores: the current-path derivation
      // and the move must be atomic — a moveDraftFamily committed by
      // another context serializes against this transaction, so the CAS
      // either sees the moved family (path-mismatch, nothing moved) or
      // moves it atomically. A derivation-then-move across separate
      // transactions would let a verified rename slip between the two
      // and drag the family back from the path the server now lives on.
      const transaction = db.transaction(
        [DRAFT_STORE_NAME, CONFLICT_STORE_NAME],
        'readwrite',
      )
      const draftStore = transaction.objectStore(DRAFT_STORE_NAME)
      const conflictStore = transaction.objectStore(CONFLICT_STORE_NAME)
      const familyKey = idbKey(vaultId, documentId)
      const source = await request(draftStore.get(familyKey))
      if (isManagedDraftPath(recordField(source, 'documentPath'))) {
        await transactionDone(transaction)
        return { status: 'unsupported' }
      }
      const decision = decideMove(source, undefined, documentId, newPath)
      // Pre-flight the whole family BEFORE writing anything (same
      // rationale as moveFamily).
      if (decision.result === 'unsupported') {
        await transactionDone(transaction)
        return { status: 'unsupported' }
      }
      // Derive the family's CURRENT path inside the same transaction:
      // the primary record's path (when one exists) plus every
      // same-identity conflict row's path. An unreadable conflict row
      // blocks the whole move, exactly like moveFamily's pre-flight —
      // and it would corrupt the derivation anyway.
      const paths = new Set<string>()
      if (isUnsavedDraft(source)) paths.add(source.documentPath)
      const familyConflicts: DraftConflictRecord[] = []
      const values = await request(
        conflictStore.index(CONFLICT_VAULT_INDEX).getAll(vaultId),
      )
      for (const value of values) {
        if (recordField(value, 'documentId') !== documentId) continue
        if (isManagedDraftPath(recordField(value, 'documentPath'))) {
          await transactionDone(transaction)
          return { status: 'unsupported' }
        }
        if (!isDraftConflictRecord(value)) {
          await transactionDone(transaction)
          return { status: 'unsupported' }
        }
        paths.add(value.documentPath)
        familyConflicts.push(value)
      }
      if (paths.size === 0) {
        // No family rows at all: nothing to drag anywhere.
        await transactionDone(transaction)
        return { status: 'missing' }
      }
      if (paths.size > 1) {
        // Split family: the move fails closed — moving one side would
        // strand the other.
        await transactionDone(transaction)
        return { status: 'unsupported' }
      }
      const currentPath = [...paths][0]!
      if (currentPath !== expectedFamilyPath) {
        // The CAS failed: another context's verified rename moved the
        // family off the quarantine's certified path. Move NOTHING and
        // certify where the family lives now — the caller adopts that
        // path instead of retrying the stale target.
        await transactionDone(transaction)
        return { status: 'path-mismatch', currentPath }
      }
      // The family still sits at the certified expected path — apply the
      // move as one unit.
      if (decision.result === 'moved') {
        draftStore.put(cloneDraft(decision.draft))
      }
      for (const record of familyConflicts) {
        conflictStore.put(cloneConflictRecord({ ...record, documentPath: newPath }))
      }
      await transactionDone(transaction)
      return { status: decision.result === 'moved' ? 'moved' : 'missing' }
    },

    async clear(vaultId) {
      const db = await database()
      const transaction = db.transaction(DRAFT_STORE_NAME, 'readwrite')
      const store = transaction.objectStore(DRAFT_STORE_NAME)
      const values = await request(store.getAll())
      for (const value of values) {
        if (isUnsavedDraft(value) && value.vaultId === vaultId
          && !isManagedDraftPath(value.documentPath)) {
          store.delete(idbKey(value.vaultId, value.documentId))
        }
      }
      await transactionDone(transaction)
    },

    async saveConflict(record) {
      const db = await database()
      if (isManagedDraftPath(record.documentPath)) return
      const transaction = db.transaction(CONFLICT_STORE_NAME, 'readwrite')
      const store = transaction.objectStore(CONFLICT_STORE_NAME)
      store.add(cloneConflictRecord(record))
      await transactionDone(transaction)
    },

    async saveConflictCandidate(record) {
      const db = await database()
      if (isManagedDraftPath(record.documentPath)) {
        return { status: 'unsupported', familyPath: null, reason: 'unsupported-conflict' }
      }
      // ONE readwrite transaction across both stores: the family-path
      // derivation reads the primary record AND the same-identity
      // conflict rows, and the add runs ONLY after validation. A
      // moveDraftFamily committed by another context serializes
      // against this transaction — the candidate write either sees the
      // moved family (path-mismatch, nothing written) or joins it
      // atomically. A bare add on the conflict store alone would let
      // the move slip between the caller's last probe and this write,
      // stranding the candidate on the pre-move path.
      const transaction = db.transaction(
        [DRAFT_STORE_NAME, CONFLICT_STORE_NAME],
        'readwrite',
      )
      const draftStore = transaction.objectStore(DRAFT_STORE_NAME)
      const conflictStore = transaction.objectStore(CONFLICT_STORE_NAME)
      const primaryValue = await request(
        draftStore.get(idbKey(record.vaultId, record.documentId)),
      )
      const conflictValues = await request(
        conflictStore.index(CONFLICT_VAULT_INDEX).getAll(record.vaultId),
      )
      const authority = conflictCandidateAuthority(
        primaryValue,
        conflictValues,
        record.vaultId,
        record.documentId,
      )
      if (authority.status === 'unsupported') {
        await transactionDone(transaction)
        return { status: 'unsupported', familyPath: null, reason: authority.reason }
      }
      if (authority.status === 'path' && authority.path !== record.documentPath) {
        await transactionDone(transaction)
        return { status: 'path-mismatch', familyPath: authority.path }
      }
      // Certified: the family agrees on the candidate's path (or no
      // family row exists and this first candidate establishes it).
      // Write only now — a duplicate conflictId aborts the transaction
      // (the store layer reports 'failed').
      conflictStore.add(cloneConflictRecord(record))
      await transactionDone(transaction)
      return { status: 'saved', stored: cloneConflictRecord(record) }
    },

    async listConflicts(vaultId) {
      const db = await database()
      const transaction = db.transaction(CONFLICT_STORE_NAME, 'readonly')
      const values = await request(
        transaction.objectStore(CONFLICT_STORE_NAME).index(CONFLICT_VAULT_INDEX)
          .getAll(vaultId),
      )
      await transactionDone(transaction)
      return values
    },

    async deleteConflict(vaultId, documentId, conflictId) {
      const db = await database()
      const transaction = db.transaction(CONFLICT_STORE_NAME, 'readwrite')
      const store = transaction.objectStore(CONFLICT_STORE_NAME)
      const key = idbConflictKey(vaultId, documentId, conflictId)
      const value = await request(store.get(key))
      if (value === undefined || value === null) {
        await transactionDone(transaction)
        return 'missing'
      }
      if (isManagedDraftPath(recordField(value, 'documentPath'))) {
        await transactionDone(transaction)
        return 'unsupported'
      }
      store.delete(key)
      await transactionDone(transaction)
      return 'deleted'
    },

    async deleteConflictIfUnchanged(expected) {
      const db = await database()
      const transaction = db.transaction(CONFLICT_STORE_NAME, 'readwrite')
      const store = transaction.objectStore(CONFLICT_STORE_NAME)
      const key = idbConflictKey(
        expected.vaultId, expected.documentId, expected.conflictId,
      )
      const value = await request(store.get(key))
      if (value === undefined || value === null) {
        await transactionDone(transaction)
        return 'missing'
      }
      if (isManagedDraftPath(recordField(value, 'documentPath'))) {
        await transactionDone(transaction)
        return 'unsupported'
      }
      if (!isDraftConflictRecord(value)) {
        await transactionDone(transaction)
        return 'unsupported'
      }
      if (!conflictDraftsEqual(value, expected)) {
        await transactionDone(transaction)
        return 'stale'
      }
      store.delete(key)
      await transactionDone(transaction)
      return 'deleted'
    },

    async clearConflicts(vaultId) {
      const db = await database()
      const transaction = db.transaction(CONFLICT_STORE_NAME, 'readwrite')
      const store = transaction.objectStore(CONFLICT_STORE_NAME)
      const values = await request(store.getAll())
      for (const value of values) {
        if (isDraftConflictRecord(value) && value.vaultId === vaultId
          && !isManagedDraftPath(value.documentPath)) {
          store.delete(idbConflictKey(value.vaultId, value.documentId, value.conflictId))
        }
      }
      await transactionDone(transaction)
    },
  }
}

function readConflicts(raw: unknown[]): DraftConflictRecord[] {
  return raw
    .filter(isDraftConflictRecord)
    .map(cloneConflictRecord)
    .sort((left, right) => (
      right.updatedAt - left.updatedAt
      || left.documentId.localeCompare(right.documentId)
      || left.conflictId.localeCompare(right.conflictId)
    ))
}

/** Derive a conflict-only family's authoritative path from the raw
 *  same-identity conflict rows. Same-identity candidates form a family
 *  even without a primary record:
 *  - `none` — no rows for the identity: no family exists, a first
 *    write may establish the path;
 *  - `path` — every row is valid and shares one path: that path is the
 *    family's authority, and a plain save on a diverging path must be
 *    refused ('path-mismatch') exactly like a cross-path primary
 *    overwrite — otherwise the primary would be created at the stale
 *    path while the candidates stay behind, splitting the family;
 *  - `split` — valid rows disagree on the path: the family is
 *    indeterminate, the save must fail closed ('unsupported') rather
 *    than guess which side to join;
 *  - `unsupported` — a future-version / corrupt row for the identity:
 *    the family state cannot be certified, the save must fail closed.
 *  Shared by both backends so memory and IndexedDB enforce identical
 *  family-path authority. */
function conflictFamilyPath(
  conflictValues: Iterable<unknown>,
  vaultId: string,
  documentId: string,
): { status: 'none' }
  | { status: 'path'; path: string }
  | { status: 'split' }
  | { status: 'unsupported' } {
  const paths = new Set<string>()
  for (const value of conflictValues) {
    if (recordField(value, 'vaultId') !== vaultId
      || recordField(value, 'documentId') !== documentId) continue
    if (!isDraftConflictRecord(value)) return { status: 'unsupported' }
    paths.add(value.documentPath)
  }
  if (paths.size === 0) return { status: 'none' }
  if (paths.size > 1) return { status: 'split' }
  return { status: 'path', path: [...paths][0]! }
}

/** Derive the family path a conflict CANDIDATE write must join, from
 *  the identity's raw family rows (primary + same-identity conflicts).
 *  Rows are read WITHOUT validation — an unreadable row can still
 *  certify its PATH when the path itself is readable: adding a
 *  candidate at the agreed path never touches that row and cannot
 *  split the family (unlike a primary overwrite, which is why
 *  probeFamily fails closed on unreadable rows but this derivation
 *  does not). Returns:
 *  - `none` — no rows for the identity: a first candidate establishes
 *    the family path;
 *  - `path` — every locatable row shares one path: a candidate at that
 *    path saves, a diverging one is refused ('path-mismatch');
 *  - `unsupported` — a row carries no readable path, or the rows
 *    disagree: the candidate write fails closed without guessing a
 *    side. `reason` classifies the blocking row, mirroring probeReason
 *    (unsupported-primary / unsupported-conflict / split-conflict-paths).
 *  Shared by both backends so memory and IndexedDB enforce identical
 *  family-path authority for candidate writes. */
function conflictCandidateAuthority(
  primaryValue: unknown,
  conflictValues: Iterable<unknown>,
  vaultId: string,
  documentId: string,
): { status: 'none' }
  | { status: 'path'; path: string }
  | { status: 'unsupported'; reason: UnsupportedFamilyReason } {
  const paths = new Set<string>()
  let rows = 0
  if (primaryValue !== undefined && primaryValue !== null) {
    rows += 1
    const path = readRawDocumentPath(primaryValue)
    if (path === null) return { status: 'unsupported', reason: 'unsupported-primary' }
    paths.add(path)
  }
  for (const value of conflictValues) {
    if (recordField(value, 'vaultId') !== vaultId
      || recordField(value, 'documentId') !== documentId) continue
    rows += 1
    const path = readRawDocumentPath(value)
    if (path === null) return { status: 'unsupported', reason: 'unsupported-conflict' }
    paths.add(path)
  }
  if (rows === 0) return { status: 'none' }
  if (paths.size > 1) return { status: 'unsupported', reason: 'split-conflict-paths' }
  return { status: 'path', path: [...paths][0]! }
}

/** Read a raw family row's `documentPath` WITHOUT validating the row:
 *  a future-version / corrupt record can still carry a readable path,
 *  and the unsupported-save probe needs those paths to pin a conflict
 *  candidate onto the family's actual location. Validation decides
 *  whether a row is USABLE; this only decides whether it is
 *  LOCATABLE. */
function readRawDocumentPath(value: unknown): string | null {
  const path = recordField(value, 'documentPath')
  return typeof path === 'string' && path.trim().length > 0 ? path : null
}

function decideSave(current: unknown, incoming: UnsavedDraft): SaveDecision {
  if (current === undefined || current === null) {
    return { result: 'saved', draft: cloneDraft(incoming) }
  }
  if (!isUnsavedDraft(current)) return { result: 'unsupported' }

  const normalized = {
    ...incoming,
    createdAt: current.createdAt,
  }
  if (normalized.updatedAt > current.updatedAt) {
    return { result: 'saved', draft: normalized }
  }
  if (normalized.updatedAt < current.updatedAt) return { result: 'stale' }
  return draftsEqual(current, normalized)
    ? { result: 'saved', draft: normalized }
    : { result: 'conflict' }
}

function decideMove(
  sourceValue: unknown,
  targetValue: unknown,
  newDocumentId: string,
  newPath: string,
): { result: Exclude<MoveResult, 'moved'>; draft?: never }
  | { result: 'moved'; draft: UnsavedDraft } {
  if (sourceValue === undefined || sourceValue === null) {
    return { result: 'missing' }
  }
  if (!isUnsavedDraft(sourceValue)) return { result: 'unsupported' }

  const movedSource: UnsavedDraft = {
    ...sourceValue,
    documentId: newDocumentId,
    documentPath: newPath,
  }
  if (targetValue === undefined || targetValue === null) {
    return { result: 'moved', draft: movedSource }
  }
  if (!isUnsavedDraft(targetValue)) return { result: 'unsupported' }

  const movedTarget: UnsavedDraft = {
    ...targetValue,
    documentId: newDocumentId,
    documentPath: newPath,
  }
  if (draftsEqual(movedSource, movedTarget)) {
    return { result: 'moved', draft: movedSource }
  }
  return { result: 'conflict' }
}

function recordVaultId(value: unknown): unknown {
  return recordField(value, 'vaultId')
}

function idbKey(vaultId: string, documentId: string): IDBValidKey[] {
  return [vaultId, documentId]
}

function idbConflictKey(
  vaultId: string,
  documentId: string,
  conflictId: string,
): IDBValidKey[] {
  return [vaultId, documentId, conflictId]
}

function recordField(value: unknown, field: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  return (value as Record<string, unknown>)[field]
}

/** Map a backend throw onto the inventory outcome's reason: the
 *  IndexedDB backend's structured open/upgrade failures keep their
 *  classification; every other throw (transaction aborts, request
 *  errors, memory-backend injected failures) is an unclassifiable
 *  store error. */
function storageFailureReason(error: unknown): DraftStorageFailureReason {
  return error instanceof DraftStorageError ? error.reason : 'transaction-failed'
}

function cloneUnknown<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value)
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}

async function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  let db: IDBDatabase
  try {
    db = await openNamedIndexedDb(factory, DATABASE_NAME, DATABASE_VERSION, (request) => {
      const database = request.result
      const transaction = request.transaction
      const store = database.objectStoreNames.contains(DRAFT_STORE_NAME)
        ? transaction!.objectStore(DRAFT_STORE_NAME)
        : database.createObjectStore(DRAFT_STORE_NAME, {
          keyPath: ['vaultId', 'documentId'],
        })
      if (!store.indexNames.contains(VAULT_UPDATED_INDEX)) {
        store.createIndex(VAULT_UPDATED_INDEX, ['vaultId', 'updatedAt'])
      }
      const conflictStore = database.objectStoreNames.contains(CONFLICT_STORE_NAME)
        ? transaction!.objectStore(CONFLICT_STORE_NAME)
        : database.createObjectStore(CONFLICT_STORE_NAME, {
          keyPath: ['vaultId', 'documentId', 'conflictId'],
        })
      if (!conflictStore.indexNames.contains(CONFLICT_VAULT_INDEX)) {
        conflictStore.createIndex(CONFLICT_VAULT_INDEX, 'vaultId')
      }
    })
  } catch (error) {
    throw new DraftStorageError(
      'open-failed',
      error instanceof Error ? error.message : 'Failed to open draft database',
    )
  }
  return db
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result)
    value.onerror = () => reject(value.error ?? new Error('Draft database request failed'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(
      transaction.error ?? new Error('Draft database transaction aborted'),
    )
    transaction.onerror = () => reject(
      transaction.error ?? new Error('Draft database transaction failed'),
    )
  })
}

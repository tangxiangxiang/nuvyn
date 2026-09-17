import type { UnsavedDraft } from './draftTypes'
import type { DraftBufferSnapshot } from './useUnsavedDraftPersistence'

export type DraftDeletePolicy = 'preserve' | 'discard-confirmed'

export interface DraftDocumentIdentity {
  vaultId: string
  documentId: string
  documentPath: string
}

export interface DraftPathMapping {
  vaultId: string
  documentId: string
  fromPath: string
  toPath: string
}

export interface DraftDeleteConfirmation extends DraftDocumentIdentity {
  revision: number
  ownerGeneration: number
  expectedDraft: UnsavedDraft | null
  expectedSnapshot: DraftBufferSnapshot | null
  /** The conflict record ids present for this identity at the moment
   *  the user confirmed the delete. A confirmed discard removes
   *  exactly these — a conflict recorded after confirmation was never
   *  part of the confirmed set and must survive. */
  expectedConflictIds: string[]
}

export interface DraftDeleteRequest extends DraftDocumentIdentity {
  policy: DraftDeletePolicy
  confirmation?: DraftDeleteConfirmation | null
}

export type DraftFileTransactionStatus =
  | 'moved'
  | 'deleted'
  | 'missing'
  | 'preserved'
  | 'stale'
  | 'identity-mismatch'
  | 'conflict'
  | 'unsupported'
  | 'failed'

export interface DraftFileTransactionResult {
  documentId: string
  oldPath: string
  newPath?: string
  status: DraftFileTransactionStatus
}

export interface DraftFileMutationBarrier {
  /** Commit the draft side of a server rename. `mappings` attempt the
   *  atomic family move per identity; any INCOMPLETE outcome (failed,
   *  unsupported, conflict) quarantines the entry — the tab migrates
   *  to the server's new path while the family stays whole at its
   *  actual old path, and a later edit on the new path retries the
   *  move before any primary write. A completed move (`moved` /
   *  `missing`) clears any stale quarantine from an earlier failed
   *  rename. `mismatched` carries identities the lifecycle's
   *  post-rename identity resolution did NOT match (identity-
   *  mismatch): no move is attempted and no result is produced (the
   *  lifecycle reports the mismatch itself), but the actual server
   *  target path still quarantines the entry so a later edit under
   *  the stale identity cannot write the primary alone at the new
   *  path and split the family. */
  commitMoves(
    mappings: readonly DraftPathMapping[],
    preserved?: readonly DraftDocumentIdentity[],
    mismatched?: readonly DraftPathMapping[],
  ): Promise<DraftFileTransactionResult[]>
  commitDeletes(
    deletions: readonly DraftDeleteRequest[],
  ): Promise<DraftFileTransactionResult[]>
  /** Final persistence gate before the lifecycle closes document tabs,
   *  implemented as ONE batch barrier over every identity about to
   *  close. A delete transaction releases every entry when it reports,
   *  but the lifecycle still awaits Recovery synchronization before
   *  closing tabs — edits typed during that async window arm a fresh
   *  debounce that the tab close could outrun. The gate installs a
   *  close seal on every identity BEFORE any await (schedule() may
   *  still update snapshots but no longer arms timers), runs all
   *  pending writes concurrently, and only after they settle
   *  re-verifies each entry against its seal-time state: an identity
   *  whose latest content was not verified durable — a rejected write,
   *  or an edit that landed while a sibling document's write was in
   *  flight — produces a `failed` result so the lifecycle keeps THAT
   *  tab open (the only surface still holding those bytes) while the
   *  seal release re-arms the background retry. A verified write
   *  produces a `preserved` result so the lifecycle's post-close
   *  Recovery sync refreshes the identity (showing the settlement-
   *  window edit, or re-adding an orphan recorded after a confirmed
   *  delete) — it never warns. The lifecycle must close tabs
   *  synchronously after this promise resolves, before any further
   *  await, so no user input event can open a new window. */
  finalizeBeforeDocumentClose(): Promise<DraftFileTransactionResult[]>
  /** Immediate post-tab-migration persistence results. Each pending
   *  release writes its latest snapshot to the actual post-rename path;
   *  a rejected write produces a `failed` result (with the actual
   *  server-suffixed `newPath`) that the lifecycle merges into its
   *  reported transaction results — the server rename stays successful
   *  and the tab keeps its new path, but the user is warned that the
   *  local draft could not be persisted. Identities the commit already
   *  reported `failed` are released too — their transaction token must
   *  not outlive the barrier — but not re-reported. A failed family
   *  move additionally quarantines the entry: the tab migrates to the
   *  server's new path while the draft family stays whole at the old
   *  one, and a subsequent edit on the new path retries the atomic
   *  family move before any primary write — so the next plain edit
   *  cannot split primary and conflict records across paths. */
  finalizeAfterTabMigration(): Promise<DraftFileTransactionResult[]>
  rollback(): Promise<void>
}

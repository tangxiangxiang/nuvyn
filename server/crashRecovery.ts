// Startup crash recovery for the atomic write/delete protocols.
//
// The atomic replace protocol (server/atomicTextWrite.ts) commits by
// taking the current generation aside to a private staging path,
// verifying it, and linking the new generation in create-only. Between
// the takeover rename and the link the formal path does not exist; if
// the process dies there (kill -9, power loss, container stop) the
// vault is left with the formal path MISSING and only hidden staging
// files — the note appears to vanish, because vault traversal only
// sees *.md names. The delete protocols stage generations under
// `.nuvyn-delete-inflight-*` names with the same exposure.
//
// recoverInterruptedOperations() runs at startup BEFORE the HTTP
// server accepts requests (server/prod.ts, server/vite-plugin.ts) and
// reconciles every reserved-pattern artifact it finds. The rules never
// destroy user data they cannot prove stale:
//
//   * journaled replace, staged + no target: complete the commit when
//     BOTH generations still match the journaled hashes; otherwise
//     restore the old generation (create-only — a path claimed
//     externally during recovery quarantines the staged bytes instead
//     of clobbering the new one);
//   * journaled replace, staged + target present: the commit landed or
//     an external writer won the path — clean the staging (staged ==
//     the caller's verified base, which the caller held);
//   * journaled replace, no staged: the takeover never happened —
//     remove the stale journal (and an uncommitted save temp whose
//     target still exists);
//   * journal-less staged/remove temps: restore the bytes create-only
//     when the path is empty; leave them quarantined when claimed;
//   * journal-less save temp: remove it when the target exists (it
//     never committed); keep + report it when the target is gone
//     (intent cannot be guessed);
//   * `.nuvyn-delete-inflight-*` with the target still empty:
//     COMPLETE the interrupted delete (the deletion was initiated and
//     validated; leaving the metadata row would bind an identity to a
//     missing file); target re-occupied: leave the quarantine as the
//     path-reuse branch intended; explicit `.nuvyn-quarantine-reuse-*`
//     artifacts are never auto-deleted, even if the path later empties;
//   * journaled folder rename (op 'folder-rename'): the directory move
//     is a single rename(2) over our own mkdir-gated empty directory,
//     so after a crash the whole tree sits at exactly one of the two
//     paths. Source tree still present: the move never landed — remove
//     the stale journal (and our own EMPTY gate directory at the
//     destination, proven ours by being empty); source gone +
//     destination present: the move landed — COMPLETE the metadata
//     prefix move (idempotent) and remove the journal;
//   * replayable folder rename (strategy 'replayable'): the Windows
//     per-file protocol — rename(2) cannot replace a directory there,
//     so the journal carries every entry's relative path and content
//     hash. A crash can leave the tree SPLIT between the two paths;
//     recovery replays the source-resident entries into the
//     destination create-only (or prunes the file-free gate when
//     nothing moved), then moves the metadata prefix;
//   * journal-less `.nuvyn-rename-*` staging (create-only file move):
//     the protocol takes the source aside, links it into the
//     destination (create-only), and unlinks the staging name. A crash
//     between link and unlink leaves two names on one inode — an
//     inode scan finds the destination partner, the staging name is
//     removed, and the metadata move completes. No partner: the crash
//     hit between takeover and link — restore the source create-only
//     (a re-used source quarantines the staging instead).
//
// Every pattern name is reserved by the vault path syntax
// (server/paths.ts): no legal document or folder name can contain a
// dot segment, so these artifacts are unambiguous. Recovery never
// throws — per-item failures are reported and left on disk — and never
// logs file CONTENT: paths and actions only.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import type { Database as DatabaseT } from 'better-sqlite3'
import { atomicReplaceTextIfUnchanged, removeDurableJournal, removeDurableRecoveryPayload, rewriteDurableJournal, sha256Hex, sha256HexBuffer, syncParentDirectoryBestEffort, verifyDirectoryGeneration, writeDurableJournal } from './atomicTextWrite.js'
import {
  captureDurableDirectoryIdentity,
  type DurableDirectoryIdentity,
} from './durableDirectoryIdentity.js'
import { isValidPathSyntax } from './paths.js'
import { isManagedDiaryPath } from '../shared/diaryProtocol.js'
import {
  isRecoveryMarkerName,
  recoveryMarkerName,
  recoveryMarkerPrefix,
  recoveryMarkerToken,
} from './technicalNamespace.js'
import {
  parseAndValidateDurableRenameReferenceBundle,
  parseRenameReferenceJournalObject,
} from './renameReferenceJournal.js'
import {
  deleteDocumentMetadata,
  deleteDocumentMetadataPrefix,
  getDocumentMetadata,
  listDocumentMetadata,
  metadataSnapshotsExactlyEqual,
  moveDocumentMetadataPrefix,
  moveDocumentMetadataReplacingDestination,
  restoreDocumentMetadataMutationCAS,
  snapshotDocumentMetadataMutationCurrentOwnership,
} from './documentMetadata.js'
import {
  classifyPlacementV4,
  createOnlyMoveFile,
  FOLDER_MOVE_STRATEGIES,
  fireReplayableMovedEntryHook,
  gateTokenName,
  isPhysicallyContained,
  moveFolderEntriesIntoExistingGate,
  platformDirectoryMoveStrategy,
  resolveDirectoryMoveStrategy,
  pruneEmptyDirectories,
  RenameDestinationOccupiedError,
  RenameSourceReusedError,
  verifyExactParity,
  verifyFolderMoveDestinationV4,
  type FolderMoveJournalStrategy,
} from './documentFileLifecycle.js'
import {
  createFolderMoveGateProof,
  FOLDER_MOVE_JOURNAL_VERSION,
  isFolderMoveGateMarkerName,
  isValidDeleteRollbackSnapshot,
  listPhysicalMoveEntries,
  reviveMetadataSnapshot,
  validateDirectoryManifest,
  validateFolderMovePhaseShape,
  validateSourceDirectoryGeneration,
  validateJournalEntriesV4,
  validateSnapshotPhysicalEntries,
  type FolderMoveJournalEntry,
  type FolderMoveJournalEntryV4,
  type FolderMoveJournalV4,
  type FolderMoveMetadataDisposition,
} from './folderMoveTransaction.js'
import { validateFolderMoveJournalV4Provenance as validateFolderMoveJournalV4RootProvenance } from './folderMoveJournalValidation.js'
import { executeFolderMoveV4Physical } from './folderMoveV4Executor.js'
import { parseDurableFolderMoveJournalV4 } from './folderMoveV4DurableJournal.js'
import { classifyFolderMoveRecoveryStrength } from './legacyFolderMoveStrength.js'
import { reconcilePendingRenameReferenceOwner } from './renameReferenceOwnerBinding.js'
import { inspectFolderMoveSourceInventory } from './folderMoveSourceOwnership.js'
import {
  createFolderMoveDestinationDirectories,
  verifyFolderMoveDirectoryEntries,
} from './folderMoveDirectoryOwnership.js'
import {
  removeFolderMoveGateProof,
  verifyFolderMoveGateProof,
} from './folderMoveGateProof.js'
import {
  completeFolderMoveV4Metadata as completeFolderMoveV4MetadataShared,
  finalizeFolderMoveV4Cleanup as finalizeFolderMoveV4CleanupShared,
  validateDurableSnapshotRestoreDisposition,
} from './folderMoveV4Metadata.js'
import { withVaultMutation } from './vaultMutation.js'

export interface RecoveryAction {
  /** Vault-relative path of the affected file/folder (or artifact). */
  readonly file: string
  /** completed-save | completed-rename | restored | completed-delete | cleaned | quarantined | failed */
  readonly action: 'completed-save' | 'completed-rename' | 'restored' | 'completed-delete' | 'cleaned' | 'quarantined' | 'failed'
  readonly detail?: string
}

export interface RecoveryReport {
  readonly actions: readonly RecoveryAction[]
}

export type CrashRecoveryHooks = {
  afterRecoveryStarted?: () => void | Promise<void>
}

let crashRecoveryHooks: CrashRecoveryHooks | null = null

export function __setCrashRecoveryHooksForTesting(
  hooks: CrashRecoveryHooks | null,
): void {
  crashRecoveryHooks = hooks
}

interface ReplaceJournal {
  version: 1
  op: 'replace'
  staged: string
  replacement: string
  expectedHash: string
  replacementHash: string
  phase?: 'quarantine-save-pending' | 'manual-recovery-required' | 'post-commit-external-mutation'
  pendingReplacement?: string
  observedStagedHash?: string
}

/** The unified in-memory shape of every folder-move journal. Schema
 * v3 (round-9) adds: unpredictable gateToken secret persisted in the
 * journal (so recovery can verify the exact marker bytes, not just
 * the filename — F2); entries carry sourceDev/sourceIno as strings
 * (safe for Windows large file IDs — F4); directories are mandatory
 * and closed over file parents and ancestors (F6). v2 journals that
 * omitted directories are rejected (the absence is ambiguous — F6).
 * Legacy v1 journals (`{rel, id, sourceHash}` entries, short strategy
 * names) are NORMALIZED into this shape at parse time. */
interface FolderRenameJournal {
  version: 1 | 2 | 3
  op: 'folder-rename' | 'folder-move'
  /** Vault-relative folder paths (no leading/trailing slash). */
  srcRel: string
  destRel: string
  sourceDev: number
  sourceIno: number
  /** Canonical after parsing; v1 'atomic'/'replayable' normalize. */
  strategy?: FolderMoveJournalStrategy
  emptyTree?: boolean
  entries?: FolderMoveJournalEntry[]
  /** Every subdirectory (including empty ones) the move must recreate
   * and verify — round-8 P1. v3 mandatory; v2 optional (rejected when
   * missing — round-9 F6). */
  directories?: string[]
  /** v2+ only; v1 journals default to prefix-move. */
  metadataDisposition?: FolderMoveMetadataDisposition
  /** v3+: unpredictable gate-token secret persisted so recovery can
   * verify the exact marker bytes, not just the name (round-9 F2). */
  gateToken?: string
}

interface FileRenameJournal {
  version: 1
  op: 'file-rename'
  srcRel: string
  destRel: string
  staging?: string
  documentId?: string
  sourceHash: string
}

interface DeleteReuseManifest {
  version: 1
  op: 'delete-path-reuse'
  /** A managed-Diary owner writes this structural intent before takeover.
   * Legacy generic path-reuse manifests omit the phase and retain their
   * original quarantine-only semantics. */
  phase?: 'managed-delete-intent'
  kind: 'file' | 'folder'
  path: string
  inflight: string
  quarantine: string
  identities: Array<{ path: string; id: string }>
  documentId?: string
  source?: {
    dev: string
    ino: string
    parentDev: string
    parentIno: string
  }
}

interface LegacyDeleteQuarantineManifest {
  version: 1
  op: 'legacy-delete-quarantine'
  path: string
  quarantine: string
  identities: Array<{ path: string; id: string }>
}

interface RenameReferencesJournal {
  version: 1
  op: 'document-rename-references' | 'folder-rename-references'
  phase: 'preparing' | 'roll-forward' | 'roll-back' | 'cleanup'
  srcRel: string
  destRel: string
  documentId?: string
  sourceHash?: string
  sourceDev?: number
  sourceIno?: number
  /** Folder identities carry each document's source hash: directory
   * inodes are weak generation proof (recycled after external
   * delete/recreate, unreliable on some Windows file systems, and a
   * replayable move's destination directory is brand new). Recovery
   * verifies the actual file content instead. Optional only for
   * legacy in-flight journals written before the hash existed. */
  identities?: Array<{ path: string; id: string; sourceHash?: string }>
  referenceIdentities?: Array<{
    documentId: string
    sourcePath: string
    writePath: string
    beforeHash: string
    afterHash: string
  }>
  references: Array<{
    path: string
    beforeHash: string
    afterHash: string
    beforePayload: string
    afterPayload: string
  }>
}

// Reserved artifact name patterns (see file header for why they are
// unambiguous). The capture is the target's basename.
const JOURNAL_RE = /^\.(.+)\.nuvyn-journal-[0-9a-f-]+$/
const STAGED_RE = /^\.(.+)\.nuvyn-staged-[0-9a-f-]+$/
const SAVE_RE = /^\.(.+)\.nuvyn-save-[0-9a-f-]+$/
const REMOVE_RE = /^\.(.+)\.nuvyn-remove-[0-9a-f-]+$/
const RENAME_RE = /^\.(.+)\.nuvyn-rename-[0-9a-f-]+$/
const DELETE_RE = /^(.+)\.nuvyn-delete-\d+$/
const DELETE_INFLIGHT_RE = /^(.+)\.nuvyn-delete-inflight-[0-9a-f-]+$/
const DELETE_QUARANTINE_RE = /^(.+)\.nuvyn-quarantine-reuse-[0-9a-f-]+$/
const DELETE_MANIFEST_RE = /^\.(.+)\.nuvyn-delete-manifest-[0-9a-f-]+$/
const QUARANTINE_MANIFEST_RE = /^\.(.+)\.nuvyn-quarantine-manifest-[0-9a-f-]+$/
const SHA256_RE = /^[0-9a-f]{64}$/

interface ArtifactGroup {
  base: string
  journals: string[]
  staged: string[]
  save: string[]
  remove: string[]
  rename: string[]
  quarantines: string[]
  deleteManifests: string[]
  quarantineManifests: string[]
}

async function exists(absPath: string): Promise<boolean> {
  try {
    await fs.stat(absPath)
    return true
  } catch {
    return false
  }
}

async function rm(absPath: string): Promise<void> {
  await fs.rm(absPath, { force: true, recursive: false }).catch(() => {})
}

async function hashMatches(absPath: string, expectedHash: string): Promise<boolean> {
  try {
    return sha256Hex(await fs.readFile(absPath, 'utf8')) === expectedHash
  } catch {
    return false
  }
}

async function readHash(absPath: string): Promise<string | undefined> {
  try {
    return sha256Hex(await fs.readFile(absPath, 'utf8'))
  } catch {
    return undefined
  }
}

/** link(2) is create-only: a path claimed externally wins; the staged
 * bytes then stay on disk under their staging name (quarantined). */
async function restoreCreateOnly(stagedAbs: string, targetAbs: string): Promise<{ restored: boolean }> {
  try {
    await fs.link(stagedAbs, targetAbs)
    // The link is create-only. Remove the staging entry only through the
    // recovery artifact proof; if its generation changed, retain the extra
    // hard-link as quarantine instead of deleting an occupant.
    await removeDurableRecoveryPayload(stagedAbs)
    return { restored: true }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { restored: false }
    throw error
  }
}

function parseReplaceJournal(raw: string): ReplaceJournal | null {
  try {
    const entry = JSON.parse(raw) as Partial<ReplaceJournal>
    if (
      entry.version === 1
      && entry.op === 'replace'
      && typeof entry.staged === 'string'
      && typeof entry.replacement === 'string'
      && typeof entry.expectedHash === 'string'
      && typeof entry.replacementHash === 'string'
      && SHA256_RE.test(entry.expectedHash)
      && SHA256_RE.test(entry.replacementHash)
      && (entry.phase === undefined
        || entry.phase === 'quarantine-save-pending'
        || entry.phase === 'manual-recovery-required'
        || entry.phase === 'post-commit-external-mutation')
      && (entry.pendingReplacement === undefined || typeof entry.pendingReplacement === 'string')
      && (entry.observedStagedHash === undefined || SHA256_RE.test(entry.observedStagedHash))
    ) {
      return entry as ReplaceJournal
    }
    return null
  } catch {
    return null
  }
}

/**
 * Vault containment is checked physically, not lexically — see
 * `isPhysicallyContained` in documentFileLifecycle.ts (shared with the
 * mover, which containment-checks every per-entry path before touching
 * it). Recovery applies it to journal paths and to every folder-move
 * entry's source and destination.
 */

async function validReplaceJournalPaths(dir: string, contentDir: string, targetAbs: string, journal: ReplaceJournal): Promise<boolean> {
  const targetBase = path.basename(targetAbs)
  if (path.basename(journal.staged) !== journal.staged || path.basename(journal.replacement) !== journal.replacement) return false
  if (!journal.staged.startsWith(recoveryMarkerPrefix('staged', targetBase))) return false
  const validReplacementName = journal.phase === 'manual-recovery-required'
    ? isRecoveryMarkerName(journal.replacement, 'quarantine-save')
    : isRecoveryMarkerName(journal.replacement, 'save')
  if (!validReplacementName) return false
  if (journal.phase === 'quarantine-save-pending') {
    if (!journal.pendingReplacement
      || path.basename(journal.pendingReplacement) !== journal.pendingReplacement
      || !isRecoveryMarkerName(journal.pendingReplacement, 'quarantine-save')
      || !await isPhysicallyContained(contentDir, path.resolve(dir, journal.pendingReplacement))) return false
  }
  return await isPhysicallyContained(contentDir, path.resolve(dir, journal.staged))
    && await isPhysicallyContained(contentDir, path.resolve(dir, journal.replacement))
    && await isPhysicallyContained(contentDir, targetAbs)
}

async function validRenameRel(contentDir: string, rel: string): Promise<boolean> {
  if (!isValidPathSyntax(rel)) return false
  return isPhysicallyContained(contentDir, path.resolve(contentDir, rel))
}

function journalBelongsToSource(
  contentDir: string,
  journalAbs: string,
  srcRel: string,
  kind: 'file' | 'folder',
  destRel?: string,
): boolean {
  const sourceAbs = kind === 'file'
    ? path.join(contentDir, `${srcRel}.md`)
    : path.join(contentDir, srcRel)
  if (path.dirname(journalAbs) !== path.dirname(sourceAbs)) return false
  const base = path.basename(journalAbs)
  if (base.startsWith(recoveryMarkerPrefix('journal', path.basename(sourceAbs)))) return true
  // A folder journal durably flipped to describe its own ROLLBACK is
  // physically named after the original source — bind it through the
  // destination endpoint. Same-parent renames share this directory, so
  // the dirname check above still pins the journal next to both ends.
  if (kind === 'folder' && destRel !== undefined) {
    const destAbs = path.join(contentDir, destRel)
    return path.dirname(journalAbs) === path.dirname(destAbs)
      && base.startsWith(recoveryMarkerPrefix('journal', path.basename(destAbs)))
  }
  return false
}

/** Physical relative paths inside a moved folder keep their real
 * extensions (and may be unicode attachment names), so the strict
 * kebab-only document syntax does not apply — but no segment may
 * escape the moved directory. */
function isValidRelativeFilePath(rel: string): boolean {
  if (!rel || rel.startsWith('/') || rel.endsWith('/') || rel.includes('\\') || rel.includes('\0')) return false
  return rel.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

function parseFolderRenameJournal(raw: string): FolderRenameJournal | null {
  try {
    const entry = JSON.parse(raw) as Omit<Partial<FolderRenameJournal>, 'strategy' | 'entries' | 'metadataDisposition'> & { strategy?: unknown; entries?: unknown; metadataDisposition?: unknown; gateToken?: unknown; version?: unknown }
    // v4 is handled by the dedicated v4 parser. The legacy parser
    // does not (and must not) accept v4.
    if ((entry as { version?: number }).version === 4) return null
    if (entry.version !== 1 && entry.version !== 2 && entry.version !== 3) return null
    if (entry.op !== 'folder-rename' && entry.op !== 'folder-move') return null
    if (typeof entry.srcRel !== 'string' || typeof entry.destRel !== 'string') return null
    if (typeof entry.sourceDev !== 'number' || typeof entry.sourceIno !== 'number') return null
    // NOT isSafeInteger: Windows volumes (NTFS with large file records,
    // ReFS/Dev Drive) report file IDs beyond 2**53, which JSON
    // round-trips as a finite double. The values are compared for
    // equality against the same stat conversion, and the strong proof
    // is the per-entry content hash anyway.
    if (!Number.isFinite(entry.sourceDev) || entry.sourceDev < 0) return null
    if (!Number.isFinite(entry.sourceIno) || entry.sourceIno < 0) return null
    // The persisted strategy is the ONE shared enum the mover runs
    // (FOLDER_MOVE_STRATEGIES). v2 journals must carry it — persisted
    // exactly as run. v1 journals may also carry the legacy short
    // names; both spellings normalize to the canonical value (accepting
    // the canonical names in v1 also repairs the journals the round-7
    // HEAD route already wrote with them).
    let strategy: FolderMoveJournalStrategy | undefined
    if (entry.strategy !== undefined) {
      if (entry.strategy === 'atomic' || entry.strategy === 'atomic-rename') strategy = 'atomic-rename'
      else if (entry.strategy === 'replayable' || entry.strategy === 'replayable-move') strategy = 'replayable-move'
      else return null
      if (entry.version >= 2 && !FOLDER_MOVE_STRATEGIES.includes(entry.strategy as FolderMoveJournalStrategy)) return null
    } else if (entry.version >= 2) {
      return null
    }
    if (entry.emptyTree !== undefined && typeof entry.emptyTree !== 'boolean') return null
    let entries: FolderMoveJournalEntry[] | undefined
    let directories: string[] | undefined
    let metadataDisposition: FolderMoveMetadataDisposition | undefined
    let gateToken: string | undefined
    // v3 gateToken: unpredictable secret persisted in the journal (F2).
    if (entry.version >= 3) {
      if (typeof entry.gateToken !== 'string' || !/^[0-9a-f]{64}$/.test(entry.gateToken as string)) return null
      gateToken = entry.gateToken as string
    }
    if (entry.version >= 2) {
      if (!Array.isArray(entry.entries)) return null
      const emptyTree = entry.emptyTree === true
      if (emptyTree ? entry.entries.length !== 0 : entry.entries.length === 0) return null
      const rawEntries = entry.entries as Array<Partial<FolderMoveJournalEntry>>
      if (!rawEntries.every((item) => item
        && typeof item.relativeFilePath === 'string' && isValidRelativeFilePath(item.relativeFilePath)
        && typeof item.sourceHash === 'string' && SHA256_RE.test(item.sourceHash)
        && ((item.documentId === undefined && item.documentPath === undefined)
          || (typeof item.documentId === 'string' && item.documentId.length > 0
            && typeof item.documentPath === 'string' && isValidPathSyntax(item.documentPath))))) return null
      if (new Set(rawEntries.map((item) => item.relativeFilePath)).size !== rawEntries.length) return null
      // v3: sourceDev/sourceIno must be present as strings on every entry.
      const isV3 = entry.version >= 3
      if (isV3) {
        if (!rawEntries.every((item) => {
          const rec = item as Record<string, unknown>
          return typeof rec.sourceDev === 'string' && /^\d+$/.test(rec.sourceDev as string)
            && typeof rec.sourceIno === 'string' && /^[1-9]\d*$/.test(rec.sourceIno as string)
        })) return null
      }
      entries = rawEntries.map((item) => {
        const mapped: FolderMoveJournalEntry = {
          relativeFilePath: item.relativeFilePath as string,
          sourceHash: item.sourceHash as string,
          ...(item.documentId !== undefined ? { documentId: item.documentId as string, documentPath: item.documentPath as string } : {}),
        }
        if (isV3) {
          mapped.sourceDev = (item as Record<string, string>).sourceDev
          mapped.sourceIno = (item as Record<string, string>).sourceIno
        }
        return mapped
      })
      // directories: v3 mandatory, validated (F6); v2 optional but
      // replayable without directories is rejected (ambiguous).
      if (entry.version >= 3) {
        // v3: directories mandatory.
        if (!Array.isArray(entry.directories)) return null
        if (!entry.directories.every((dir) => typeof dir === 'string' && isValidRelativeFilePath(dir))) return null
        if (new Set(entry.directories).size !== entry.directories.length) return null
        directories = [...entry.directories]
        // Validate against entry paths (sorted, parent-closed, no conflicts).
        const entryRels = entries.map((e) => e.relativeFilePath)
        const dirError = validateDirectoryManifest(directories, entryRels, ['.nuvyn-'])
        if (dirError !== null) return null
      } else if (entry.directories !== undefined) {
        if (!Array.isArray(entry.directories)
          || !entry.directories.every((dir) => typeof dir === 'string' && isValidRelativeFilePath(dir))) return null
        if (new Set(entry.directories).size !== entry.directories.length) return null
        directories = [...entry.directories]
      }
      // v2 replayable journals without a directory manifest are rejected
      // (F6): the absence is ambiguous — undeclared empty dirs could be
      // external content silently merged during replay. Empty-tree
      // journals carry no entries and therefore need no directory
      // manifest: the journal declares the move's shape exhaustively.
      if (entry.version === 2 && strategy === 'replayable-move' && directories === undefined && !emptyTree) return null
      if (entry.metadataDisposition === undefined) {
        metadataDisposition = { kind: 'prefix-move' }
      } else if (entry.metadataDisposition && typeof entry.metadataDisposition === 'object') {
        const disposition = entry.metadataDisposition as { kind?: string; snapshot?: unknown }
        if (disposition.kind === 'prefix-move') metadataDisposition = { kind: 'prefix-move' }
        else if (disposition.kind === 'snapshot-restore'
          && isValidDeleteRollbackSnapshot(disposition.snapshot, entry.destRel)) {
          // v2+ snapshot-restore: also validate physical Markdown entry
          // correspondence — no snapshot document without a journaled
          // physical entry backing it (F1).
          if (entry.version >= 2 && entries) {
            const snapError = validateSnapshotPhysicalEntries(
              disposition.snapshot as import('./folderMoveTransaction.js').SerializedMetadataSnapshot,
              entries,
              entry.destRel,
            )
            if (snapError !== null) return null
          }
          metadataDisposition = { kind: 'snapshot-restore', snapshot: disposition.snapshot }
        } else return null
      } else return null
      return {
        version: entry.version as 2 | 3, op: entry.op, srcRel: entry.srcRel, destRel: entry.destRel,
        sourceDev: entry.sourceDev, sourceIno: entry.sourceIno,
        strategy, ...(emptyTree ? { emptyTree } : {}), entries,
        ...(directories !== undefined ? { directories } : {}), metadataDisposition,
        ...(gateToken !== undefined ? { gateToken } : {}),
      }
    }
    // v1: legacy `{rel, id, sourceHash}` entries — normalized to the
    // physical shape (the old recovery appended '.md' itself).
    if (entry.emptyTree !== undefined) return null
    if (entry.metadataDisposition !== undefined) return null
    if (entry.entries !== undefined) {
      const legacy = entry.entries as Array<{ rel?: unknown; id?: unknown; sourceHash?: unknown }>
      if (!Array.isArray(legacy) || legacy.length === 0
        || !legacy.every((item) => item && typeof item.rel === 'string' && isValidPathSyntax(item.rel)
          && typeof item.id === 'string' && (item.id as string).length > 0
          && typeof item.sourceHash === 'string' && SHA256_RE.test(item.sourceHash as string))) return null
      if (new Set(legacy.map((item) => item.rel)).size !== legacy.length) return null
      if (new Set(legacy.map((item) => item.id)).size !== legacy.length) return null
      entries = legacy.map((item) => ({
        relativeFilePath: `${item.rel}.md`,
        sourceHash: item.sourceHash as string,
        documentId: item.id as string,
        documentPath: `${entry.srcRel}/${item.rel}`,
      }))
    }
    // A replayable journal is worthless without its entry list: it must
    // reconcile a tree that may be split between two paths.
    if (strategy === 'replayable-move' && (entries === undefined || entries.length === 0)) return null
    return {
      version: 1, op: entry.op === 'folder-move' ? 'folder-move' : 'folder-rename',
      srcRel: entry.srcRel, destRel: entry.destRel,
      sourceDev: entry.sourceDev, sourceIno: entry.sourceIno,
      ...(strategy !== undefined ? { strategy } : {}),
      ...(entries !== undefined ? { entries } : {}),
    }
  } catch {
    return null
  }
}

function parseFileRenameJournal(raw: string): FileRenameJournal | null {
  try {
    const entry = JSON.parse(raw) as Partial<FileRenameJournal>
    if (entry.version === 1 && entry.op === 'file-rename'
      && typeof entry.srcRel === 'string' && typeof entry.destRel === 'string'
      && (entry.staging === undefined || typeof entry.staging === 'string')
      && typeof entry.sourceHash === 'string' && SHA256_RE.test(entry.sourceHash)
      && typeof entry.documentId === 'string' && entry.documentId.length > 0) return entry as FileRenameJournal
    return null
  } catch { return null }
}

function parseDeleteReuseManifest(raw: string): DeleteReuseManifest | null {
  try {
    const entry = JSON.parse(raw) as Partial<DeleteReuseManifest>
    if (entry.version !== 1 || entry.op !== 'delete-path-reuse') return null
    if (entry.phase !== undefined && entry.phase !== 'managed-delete-intent') return null
    if (entry.kind !== 'file' && entry.kind !== 'folder') return null
    if (typeof entry.path !== 'string' || typeof entry.inflight !== 'string' || typeof entry.quarantine !== 'string') return null
    if (!Array.isArray(entry.identities) || entry.identities.length === 0
      || !entry.identities.every((item) => item && typeof item.path === 'string' && typeof item.id === 'string' && item.id.length > 0)) return null
    if (new Set(entry.identities.map((identity) => identity.path)).size !== entry.identities.length
      || new Set(entry.identities.map((identity) => identity.id)).size !== entry.identities.length) return null
    if (entry.phase === 'managed-delete-intent') {
      if (entry.kind !== 'file' || !isManagedDiaryPath(entry.path)
        || typeof entry.documentId !== 'string' || entry.documentId.length === 0
        || !entry.source || typeof entry.source !== 'object'
        || typeof entry.source.dev !== 'string' || typeof entry.source.ino !== 'string'
        || typeof entry.source.parentDev !== 'string' || typeof entry.source.parentIno !== 'string') return null
      if (!entry.identities.some((identity) => identity.path === entry.path && identity.id === entry.documentId)) return null
    }
    return entry as DeleteReuseManifest
  } catch { return null }
}

function parseLegacyDeleteQuarantineManifest(raw: string): LegacyDeleteQuarantineManifest | null {
  try {
    const entry = JSON.parse(raw) as Partial<LegacyDeleteQuarantineManifest>
    if (entry.version !== 1 || entry.op !== 'legacy-delete-quarantine') return null
    if (typeof entry.path !== 'string' || typeof entry.quarantine !== 'string') return null
    if (!Array.isArray(entry.identities) || entry.identities.length === 0
      || !entry.identities.every((item) => item && typeof item.path === 'string' && typeof item.id === 'string' && item.id.length > 0)) return null
    if (new Set(entry.identities.map((identity) => identity.path)).size !== entry.identities.length
      || new Set(entry.identities.map((identity) => identity.id)).size !== entry.identities.length) return null
    return entry as LegacyDeleteQuarantineManifest
  } catch { return null }
}

function parseRenameReferencesJournal(raw: string): RenameReferencesJournal | null {
  try {
    return parseRenameReferenceJournalObject(
      JSON.parse(raw),
    ) as RenameReferencesJournal | null
  } catch { return null }
}

function vaultRelative(contentDir: string, absPath: string): string {
  return path.relative(contentDir, absPath).split(path.sep).join('/')
}

/** Document metadata paths are vault paths without the .md extension. */
function metadataPathFor(vaultRel: string): string {
  return vaultRel.replace(/\.md$/, '')
}

async function isDirectory(absPath: string): Promise<boolean> {
  try {
    return (await fs.stat(absPath)).isDirectory()
  } catch {
    return false
  }
}

async function walkDirectories(
  dir: string,
  visit: (dir: string, entries: Dirent[]) => Promise<void>,
): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  await visit(dir, entries)
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    await walkDirectories(path.join(dir, entry.name), visit)
  }
}

async function recoverReplaceJournal(
  contentDir: string,
  dir: string,
  targetAbs: string,
  journalAbs: string,
  journal: ReplaceJournal,
  note: (absPath: string, action: RecoveryAction['action'], detail?: string) => void,
): Promise<void> {
  if (!await validReplaceJournalPaths(dir, contentDir, targetAbs, journal)) {
    note(journalAbs, 'quarantined', 'invalid replace journal paths; no referenced path was touched')
    return
  }
  if (journal.phase === 'quarantine-save-pending') {
    const oldAbs = path.join(dir, journal.replacement)
    const nextName = journal.pendingReplacement!
    const nextAbs = path.join(dir, nextName)
    try {
      if (await exists(oldAbs) && !await exists(nextAbs)) {
        await fs.rename(oldAbs, nextAbs)
        await syncParentDirectoryBestEffort(nextAbs)
      }
      if (!await exists(nextAbs)) {
        note(journalAbs, 'failed', 'pending replacement quarantine has neither old nor new payload')
        return
      }
      await rewriteDurableJournal(journalAbs, {
        ...journal,
        phase: 'manual-recovery-required',
        replacement: nextName,
        pendingReplacement: undefined,
      })
      note(journalAbs, 'quarantined', 'pending replacement quarantine completed')
    } catch (error) {
      note(journalAbs, 'failed', `could not complete pending replacement quarantine: ${(error as Error).message}`)
    }
    return
  }
  if (journal.phase === 'manual-recovery-required') {
    note(journalAbs, 'quarantined', 'manual recovery set retained; no generation was touched')
    return
  }
  if (journal.phase === 'post-commit-external-mutation') {
    note(
      journalAbs,
      'quarantined',
      'post-commit external mutation retained; no generation was touched',
    )
    return
  }
  const stagedAbs = path.join(dir, journal.staged)
  const saveAbs = path.join(dir, journal.replacement)
  const quarantineReplacement = async (): Promise<string> => {
    if (!await exists(saveAbs) || isRecoveryMarkerName(journal.replacement, 'quarantine-save')) return journal.replacement
    const quarantinedName = recoveryMarkerName(
      'quarantine-save',
      path.basename(targetAbs),
      randomUUID(),
    )
    const quarantinedAbs = path.join(dir, quarantinedName)
    await rewriteDurableJournal(journalAbs, {
      ...journal,
      phase: 'quarantine-save-pending',
      pendingReplacement: quarantinedName,
    })
    await fs.rename(saveAbs, quarantinedAbs)
    await syncParentDirectoryBestEffort(quarantinedAbs)
    return quarantinedName
  }
  const stagedExists = await exists(stagedAbs)
  const targetExists = await exists(targetAbs)

  if (!stagedExists) {
    // The takeover never happened (crash before the rename) or an
    // earlier recovery already resolved it. The journal is stale; an
    // uncommitted save temp is removed only when its target still
    // exists — with the target gone the intent cannot be guessed, so
    // the hidden temp stays and is reported.
    if (await exists(saveAbs)) {
      if (targetExists) {
        await removeDurableRecoveryPayload(saveAbs)
        note(saveAbs, 'cleaned', 'uncommitted save temp')
      } else {
        note(saveAbs, 'quarantined', 'save temp without a target; kept for inspection')
      }
    }
    await removeDurableJournal(journalAbs).catch(() => {})
    note(journalAbs, 'cleaned', 'stale journal (takeover never happened)')
    return
  }

  if (targetExists) {
    const targetIsReplacement = await hashMatches(targetAbs, journal.replacementHash)
    const targetIsExpected = await hashMatches(targetAbs, journal.expectedHash)
    if (targetIsReplacement) {
      // A completed replacement must not make a changed old generation
      // disappear. This also protects the case where the phase rewrite was
      // interrupted after an external old-FD write.
      if (!await hashMatches(stagedAbs, journal.expectedHash)) {
        note(journalAbs, 'quarantined', 'staged generation changed after replacement; retained for inspection')
        await rewriteDurableJournal(journalAbs, {
          ...journal,
          phase: 'post-commit-external-mutation',
          observedStagedHash: await readHash(stagedAbs),
        }).catch(() => {})
        return
      }
      await removeDurableRecoveryPayload(stagedAbs)
      await removeDurableRecoveryPayload(saveAbs)
      await removeDurableJournal(journalAbs).catch(() => {})
      note(targetAbs, 'cleaned', 'staging from a completed save')
    } else {
      // The formal path is the old generation or a third-party version.
      // Neither hidden generation is provably stale; retain both and the
      // journal as an explicit recovery set for manual inspection.
      note(journalAbs, 'quarantined', targetIsExpected
        ? 'old generation occupies target; replacement retained for inspection'
        : 'external generation occupies target; old and replacement generations retained')
      const replacement = await quarantineReplacement().catch(() => journal.replacement)
      await rewriteDurableJournal(journalAbs, { ...journal, replacement, phase: 'manual-recovery-required' }).catch(() => {})
    }
    return
  }

  // Interrupted after the takeover, target still empty. Complete the
  // commit when both generations still match the journaled hashes —
  // that is exactly the commit the process died inside; otherwise
  // restore the old generation.
  if (
    await hashMatches(stagedAbs, journal.expectedHash)
    && await exists(saveAbs)
    && await hashMatches(saveAbs, journal.replacementHash)
  ) {
    try {
      await fs.link(saveAbs, targetAbs)
    await removeDurableRecoveryPayload(saveAbs)
    await removeDurableRecoveryPayload(stagedAbs)
      await removeDurableJournal(journalAbs).catch(() => {})
      note(targetAbs, 'completed-save', 'interrupted save completed from journal')
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        note(targetAbs, 'failed', `could not complete interrupted save: ${(error as Error).message}`)
        return
      }
      // An external writer claimed the path between our check and the
      // link: fall through and restore/quarantine the old generation.
    }
  }
  const { restored } = await restoreCreateOnly(stagedAbs, targetAbs).catch((error) => {
    note(targetAbs, 'failed', `could not restore previous generation: ${(error as Error).message}`)
    return { restored: false }
  })
  if (restored) {
    note(targetAbs, 'restored', 'interrupted save rolled back to the previous generation')
  } else if (await exists(stagedAbs)) {
    note(stagedAbs, 'quarantined', 'previous generation kept; target claimed externally during recovery')
  }
  // A failed verification means neither replacement nor its intent is
  // proven stale. Keep it and the journal as a recovery set.
  if (await exists(saveAbs)) {
    const replacement = await quarantineReplacement()
    await rewriteDurableJournal(journalAbs, { ...journal, replacement, phase: 'manual-recovery-required' }).catch((error) => {
      note(journalAbs, 'failed', `could not persist manual-recovery phase: ${(error as Error).message}`)
    })
  } else {
    await removeDurableJournal(journalAbs).catch(() => {})
  }
}

async function recoverFileRenameJournal(
  contentDir: string, db: DatabaseT, journalAbs: string, journal: FileRenameJournal,
  legacyStagingNames: readonly string[],
  note: (absPath: string, action: RecoveryAction['action'], detail?: string) => void,
): Promise<void> {
  if (
    journal.srcRel === journal.destRel
    || !await validRenameRel(contentDir, journal.srcRel)
    || !await validRenameRel(contentDir, journal.destRel)
    || !journalBelongsToSource(contentDir, journalAbs, journal.srcRel, 'file')
    || (journal.staging !== undefined && path.basename(journal.staging) !== journal.staging)
  ) {
    note(journalAbs, 'quarantined', 'invalid file-rename journal paths; no referenced path was touched')
    return
  }
  const srcAbs = path.join(contentDir, `${journal.srcRel}.md`)
  const destAbs = path.join(contentDir, `${journal.destRel}.md`)
  const stagingName = journal.staging ?? (legacyStagingNames.length === 1 ? legacyStagingNames[0] : undefined)
  const stagingAbs = stagingName ? path.join(path.dirname(srcAbs), stagingName) : null
  if (
    stagingName !== undefined
    && (
      !stagingName.startsWith(recoveryMarkerPrefix('rename', path.basename(srcAbs)))
      || !stagingAbs
      || !await isPhysicallyContained(contentDir, stagingAbs)
    )
  ) {
    note(journalAbs, 'quarantined', 'invalid file-rename staging path; no referenced path was touched')
    return
  }
  const srcExists = await exists(srcAbs)
  const destExists = await exists(destAbs)
  const stagingExists = stagingAbs ? await exists(stagingAbs) : false
  const sourceMetadata = getDocumentMetadata(db, journal.srcRel)
  const destinationMetadata = getDocumentMetadata(db, journal.destRel)
  if (journal.documentId && destinationMetadata?.id === journal.documentId) {
    if (stagingExists) {
      if (!destExists) {
        note(journalAbs, 'quarantined', 'metadata committed but destination is missing; staging retained')
        return
      }
      const [stagedStat, destStat] = await Promise.all([fs.stat(stagingAbs!), fs.stat(destAbs)])
      if (stagedStat.dev !== destStat.dev || stagedStat.ino !== destStat.ino) {
        note(journalAbs, 'quarantined', 'metadata committed but staging belongs to another generation')
        return
      }
      await rm(stagingAbs!)
    }
    await removeDurableJournal(journalAbs).catch(() => {})
    note(destAbs, 'cleaned', 'file-rename metadata already committed')
    return
  }
  if (!srcExists && destExists && await hashMatches(destAbs, journal.sourceHash)) {
    if (stagingExists) {
      const [stagedStat, destStat] = await Promise.all([fs.stat(stagingAbs!), fs.stat(destAbs)])
      if (stagedStat.dev !== destStat.dev || stagedStat.ino !== destStat.ino) {
        note(journalAbs, 'quarantined', 'rename staging does not match destination generation')
        return
      }
    }
    if (!journal.documentId || sourceMetadata?.id !== journal.documentId) {
      note(journalAbs, 'quarantined', 'file-rename source identity no longer matches journal')
      return
    }
    try {
      const moved = moveDocumentMetadataReplacingDestination(db, journal.srcRel, journal.destRel)
      if (!moved) {
        note(journalAbs, 'quarantined', 'file-rename source metadata missing; journal retained')
        return
      }
      if (stagingExists) await rm(stagingAbs!)
      await removeDurableJournal(journalAbs)
      note(destAbs, 'completed-rename', 'interrupted file rename metadata move completed from journal')
    } catch (error) {
      note(journalAbs, 'failed', `could not complete file-rename metadata move: ${(error as Error).message}`)
    }
    return
  }
  if (!srcExists && !destExists && stagingExists) {
    if (!stagingAbs || !await hashMatches(stagingAbs, journal.sourceHash)) {
      note(journalAbs, 'quarantined', 'rename staging hash does not match journal')
      return
    }
    const { restored } = await restoreCreateOnly(stagingAbs, srcAbs)
    if (!restored) {
      note(stagingAbs, 'quarantined', 'rename staging retained; source claimed during recovery')
      return
    }
    await removeDurableJournal(journalAbs)
    note(srcAbs, 'restored', 'interrupted file rename rolled back before destination link')
    return
  }
  if (srcExists && !destExists && await hashMatches(srcAbs, journal.sourceHash)) {
    await removeDurableJournal(journalAbs)
    note(journalAbs, 'cleaned', 'stale file-rename journal (move never landed)')
    return
  }
  note(journalAbs, 'quarantined', 'ambiguous file-rename state retained for inspection')
}

type CompanionFolderMoveLookup =
  | { kind: 'none' }
  | { kind: 'single'; path: string; version: 1 | 2 | 3 | 4 }
  | { kind: 'conflict'; paths: string[] }

/** Find a folder-move journal bound to the move srcRel→destRel living
 * next to the move's source directory — the durable companion a
 * reference rollback (or delete rollback) writes before moving. Used
 * to DEFER: while the companion exists, it owns the tree, and the
 * reference journal must not move anything itself.
 *
 * Round-14 P1-4: returns a discriminated union so callers can react
 * to multiple-companion conflict (multiple authoritative companions
 * for the same move must quarantine the caller without creating any
 * new journal — round-13 returned the first match, silently missing
 * later companions). */
async function findCompanionFolderMoveJournals(
  contentDir: string,
  moveSrcRel: string,
  moveDestRel: string,
): Promise<CompanionFolderMoveLookup> {
  const moveSrcAbs = path.join(contentDir, moveSrcRel)
  const dir = path.dirname(moveSrcAbs)
  let dirents: Dirent[]
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return { kind: 'none' }
  }
  const matches: Array<{ path: string; version: 1 | 2 | 3 | 4 }> = []
  for (const entry of dirents) {
    if (!entry.isFile()) continue
    const match = JOURNAL_RE.exec(entry.name)
    if (!match || match[1] !== path.basename(moveSrcAbs)) continue
    const abs = path.join(dir, entry.name)
    try {
      const raw = await fs.readFile(abs, 'utf8')
      const v4Journal = parseDurableFolderMoveJournalV4(raw)
      if (v4Journal && v4Journal.srcRel === moveSrcRel && v4Journal.destRel === moveDestRel) {
        matches.push({ path: abs, version: 4 })
        continue
      }
      const journal = parseFolderRenameJournal(raw)
      if (journal && journal.srcRel === moveSrcRel && journal.destRel === moveDestRel) {
        matches.push({ path: abs, version: journal.version as 1 | 2 | 3 })
      }
    } catch { /* unreadable companion: treat as absent */ }
  }
  if (matches.length === 0) return { kind: 'none' }
  if (matches.length === 1) return { kind: 'single', path: matches[0].path, version: matches[0].version }
  return { kind: 'conflict', paths: matches.map((m) => m.path) }
}

async function recoverRenameReferencesJournal(
  contentDir: string,
  db: DatabaseT,
  journalAbs: string,
  journal: RenameReferencesJournal,
  note: (absPath: string, action: RecoveryAction['action'], detail?: string) => void,
): Promise<void> {
  const bundle = await parseAndValidateDurableRenameReferenceBundle({
    contentDir,
    journalPath: journalAbs,
    value: journal,
  })
  if (!bundle) {
    note(journalAbs, 'quarantined', 'invalid durable rename-reference bundle')
    return
  }
  journal = bundle.entry as RenameReferencesJournal
  if (journal.op === 'folder-rename-references'
    && bundle.proofStrength !== 'strong') {
    note(
      journalAbs,
      'quarantined',
      'legacy journal lacks sufficient durable ownership proof',
    )
    return
  }
  let metadataDisposition = bundle.entry.metadataDisposition
  // P0-1 owner binding reconciliation: a companion stuck in owner-pending
  // cannot remain stuck forever. Recovery either promotes it (v4 owner
  // journal on disk and matches) or quarantines it (owner journal absent
  // or mismatched). Both cases advance the companion — the previous
  // round-17 behavior of deferring with metadataHandled:false left the
  // companion pinned and never reached a terminal action.
  if (metadataDisposition?.kind === 'folder-snapshot-owner-pending') {
    const reconcile = await reconcilePendingRenameReferenceOwner({
      contentDir,
      journalPath: journalAbs,
      entry: bundle.entry,
      transactionId: bundle.transactionId,
      ownerDescriptorHash: bundle.descriptorHash,
    })
    if (reconcile.action === 'quarantine'
      || reconcile.action === 'abort') {
      note(journalAbs, 'quarantined', reconcile.reason)
      return
    }
    if (reconcile.action === 'promote') {
      const refreshed = await parseAndValidateDurableRenameReferenceBundle({
        contentDir,
        journalPath: journalAbs,
      })
      if (!refreshed) {
        note(journalAbs, 'quarantined', 'owner-binding promotion refresh failed')
        return
      }
      journal = refreshed.entry as RenameReferencesJournal
      metadataDisposition = refreshed.entry.metadataDisposition
    }
  }
  if (metadataDisposition?.kind === 'folder-snapshot-owner-aborted') {
    note(
      journalAbs,
      'quarantined',
      'rename-reference owner-binding aborted because owner folder journal is absent',
    )
    return
  }
  if (metadataDisposition?.kind === 'folder-snapshot-owned'
    && !metadataDisposition.metadataHandled) {
    // The owner folder journal pins this journal and its payloads.  Do not
    // report a terminal action: a later recovery pass may complete the
    // durable handoff in this same startup.
    return
  }
  if (metadataDisposition?.kind === 'folder-snapshot-owned'
    && await exists(path.join(
      path.dirname(journalAbs),
      metadataDisposition.ownerJournal,
    ))) {
    // Even after the handoff bit is durable, the owner journal must finish
    // its final verification and be removed before dependents consume the
    // companion/payload proof.
    return
  }
  const referenceOnly = metadataDisposition?.kind
    === 'folder-snapshot-owned'
    && metadataDisposition.metadataHandled
  const kind = journal.op === 'document-rename-references' ? 'file' : 'folder'
  if (journal.srcRel === journal.destRel
    || !await validRenameRel(contentDir, journal.srcRel)
    || !await validRenameRel(contentDir, journal.destRel)
    || !journalBelongsToSource(contentDir, journalAbs, journal.srcRel, kind)) {
    note(journalAbs, 'quarantined', 'invalid rename-reference journal provenance')
    return
  }
  if (kind === 'folder' && !journal.identities!.every((identity) =>
    isValidPathSyntax(identity.path)
      && (identity.path === journal.srcRel || identity.path.startsWith(`${journal.srcRel}/`)))) {
    note(journalAbs, 'quarantined', 'folder rename-reference identities are outside the source subtree')
    return
  }
  const srcAbs = kind === 'file' ? path.join(contentDir, `${journal.srcRel}.md`) : path.join(contentDir, journal.srcRel)
  const destAbs = kind === 'file' ? path.join(contentDir, `${journal.destRel}.md`) : path.join(contentDir, journal.destRel)
  const srcExists = await exists(srcAbs)
  const destExists = await exists(destAbs)
  const journalDir = path.dirname(journalAbs)
  const sourceBase = path.basename(srcAbs)
  const journalName = path.basename(journalAbs)
  const transactionId = recoveryMarkerToken(journalName, 'journal')
  if (!transactionId) {
    note(journalAbs, 'quarantined', 'rename-reference journal token is invalid')
    return
  }
  const payloads: string[] = []
  for (let index = 0; index < journal.references.length; index += 1) {
    const reference = journal.references[index]
    if (!isValidPathSyntax(reference.path)
      || path.basename(reference.beforePayload) !== reference.beforePayload
      || path.basename(reference.afterPayload) !== reference.afterPayload
      || reference.beforePayload !== recoveryMarkerName(
        'ref-before',
        sourceBase,
        transactionId,
        index,
      )
      || reference.afterPayload !== recoveryMarkerName(
        'ref-after',
        sourceBase,
        transactionId,
        index,
      )) {
      note(journalAbs, 'quarantined', 'invalid rename-reference payload provenance')
      return
    }
    // The reference rewrite would read and atomically replace this
    // path (and create its save temp in the target's parent): a
    // symlinked ancestor must never route that outside the vault.
    if (!await isPhysicallyContained(contentDir, path.join(contentDir, `${reference.path}.md`))) {
      note(journalAbs, 'quarantined', 'rename-reference path escapes the vault; no referenced path was touched')
      return
    }
    payloads.push(path.join(journalDir, reference.beforePayload), path.join(journalDir, reference.afterPayload))
  }
  const cleanup = async (): Promise<void> => {
    // Never delete the journal while a declared payload may remain.
    // Missing payloads are idempotent (`force: true`); a real removal
    // error retains the authoritative journal for the next startup.
    for (const payload of payloads) await removeDurableRecoveryPayload(payload)
    await removeDurableJournal(journalAbs)
  }
  if (journal.phase === 'preparing' || journal.phase === 'cleanup') {
    await cleanup()
    note(journalAbs, 'cleaned', `rename-reference ${journal.phase} state cleaned`)
    return
  }
  const destinationAfterHash = journal.references.find((reference) => reference.path === journal.destRel)?.afterHash
  const fileGenerationMatches = async (absPath: string): Promise<boolean> =>
    await hashMatches(absPath, journal.sourceHash!)
      || Boolean(destinationAfterHash && await hashMatches(absPath, destinationAfterHash))
  const folderGenerationMatches = async (absPath: string): Promise<boolean> => {
    try {
      const stat = await fs.stat(absPath)
      if (!stat.isDirectory()) return false
      const identities = journal.identities!
      const allHashed = identities.every((identity) => typeof identity.sourceHash === 'string')
      if (allHashed) {
        // CONTENT PROOF: directory inode numbers can be recycled after
        // an external delete/recreate, are weak evidence on some
        // Windows file systems, and a replayable move's destination
        // directory is brand new by construction. An external sync
        // that preserves the directory while recreating its files must
        // not pass: every journaled document must hold the journaled
        // generation — or its declared after-rewrite when the document
        // references the renamed folder itself and the rewrite already
        // landed before the crash.
        return (await Promise.all(identities.map(async (identity) => {
          const fileAbs = path.join(absPath, `${identity.path.slice(journal.srcRel.length)}.md`)
          if (await hashMatches(fileAbs, identity.sourceHash!)) return true
          // A backlink file INSIDE the renamed folder carries its
          // reference under the DESTINATION path — the route rewrites
          // internal sources to their new home — so the after-rewrite
          // proof must look the identity up at the destination path,
          // not the source path (round-7 P1: the source-path lookup
          // misjudged a legitimately rewritten internal document as an
          // external generation and detached its identity forever).
          const destinationIdentityPath = journal.destRel + identity.path.slice(journal.srcRel.length)
          const selfReference = journal.references.find((reference) => reference.path === destinationIdentityPath)
            ?? journal.references.find((reference) => reference.path === identity.path)
          return Boolean(selfReference && await hashMatches(fileAbs, selfReference.afterHash))
        }))).every(Boolean)
      }
      // Legacy in-flight journal without per-file hashes: the weaker
      // directory-inode + existence proof is the best available.
      if (journal.sourceDev === undefined || journal.sourceIno === undefined) return false
      if (stat.dev !== journal.sourceDev || stat.ino !== journal.sourceIno) return false
      return (await Promise.all(identities.map((identity) => {
        const relative = identity.path.slice(journal.srcRel.length)
        return fs.stat(path.join(absPath, `${relative}.md`))
          .then((item) => item.isFile(), () => false)
      }))).every(Boolean)
    } catch { return false }
  }
  const generationMatches = kind === 'file' ? fileGenerationMatches : folderGenerationMatches

  if (journal.phase === 'roll-forward') {
    // A source path may have been re-used by an external generation
    // while rollback was attempted. Destination ownership, not source
    // absence, is the proof that this transaction must finish forward.
    if (!destExists) {
      note(journalAbs, 'quarantined', 'rename-reference transaction has ambiguous source/destination state')
      return
    }
    if (!await generationMatches(destAbs)) {
      if (kind === 'file' && getDocumentMetadata(db, journal.destRel)?.id === journal.documentId) {
        // The public destination is a different generation while SQLite
        // still carries the renamed document's old identity. Detach by
        // documentId CAS; the later metadata scan will mint an identity
        // for the external bytes without rebinding the old generation.
        deleteDocumentMetadata(db, journal.destRel)
      } else if (kind === 'folder') {
        for (const identity of journal.identities!) {
          const destinationPath = journal.destRel + identity.path.slice(journal.srcRel.length)
          if (getDocumentMetadata(db, destinationPath)?.id === identity.id) {
            deleteDocumentMetadata(db, destinationPath)
          }
        }
      }
      note(journalAbs, 'quarantined', 'rename-reference destination generation does not match journal')
      return
    }
    if (kind === 'file') {
      if (getDocumentMetadata(db, journal.destRel)?.id !== journal.documentId) {
        note(journalAbs, 'quarantined', 'rename-reference destination identity does not match journal')
        return
      }
    }
  } else {
    const sourceOwned = srcExists && await generationMatches(srcAbs)
    const destinationOwned = destExists && await generationMatches(destAbs)
    if (!sourceOwned && !destinationOwned) {
      note(journalAbs, 'quarantined', 'rename-reference rollback has no owned source or destination generation')
      return
    }
    if (destinationOwned && srcExists) {
      // The original path belongs to an external generation. Rolling
      // back would overwrite it, so durably choose the only safe final
      // direction and complete the references in this same startup.
      const forward = { ...journal, phase: 'roll-forward' as const }
      await rewriteDurableJournal(journalAbs, forward)
      await recoverRenameReferencesJournal(contentDir, db, journalAbs, forward, note)
      return
    }
    if (kind === 'file') {
      const sourceId = getDocumentMetadata(db, journal.srcRel)?.id
      const destinationId = getDocumentMetadata(db, journal.destRel)?.id
      if (sourceId !== journal.documentId && destinationId !== journal.documentId) {
        note(journalAbs, 'quarantined', 'rename-reference rollback identity does not match either owned generation')
        return
      }
    }
  }
  for (const reference of journal.references) {
    const referenceAbs = path.join(contentDir, `${reference.path}.md`)
    const beforeAbs = path.join(journalDir, reference.beforePayload)
    const afterAbs = path.join(journalDir, reference.afterPayload)
    if (!await hashMatches(beforeAbs, reference.beforeHash) || !await hashMatches(afterAbs, reference.afterHash)) {
      note(journalAbs, 'quarantined', `rename-reference payload hash mismatch: ${reference.path}`)
      return
    }
    const expectedHash = journal.phase === 'roll-forward' ? reference.beforeHash : reference.afterHash
    const desiredHash = journal.phase === 'roll-forward' ? reference.afterHash : reference.beforeHash
    if (await hashMatches(referenceAbs, desiredHash)) continue
    if (!await hashMatches(referenceAbs, expectedHash)) {
      note(journalAbs, 'quarantined', `reference changed externally: ${reference.path}`)
      return
    }
    const [beforeRaw, afterRaw] = await Promise.all([fs.readFile(beforeAbs, 'utf8'), fs.readFile(afterAbs, 'utf8')])
    try {
      await atomicReplaceTextIfUnchanged(
        referenceAbs,
        journal.phase === 'roll-forward' ? beforeRaw : afterRaw,
        journal.phase === 'roll-forward' ? afterRaw : beforeRaw,
      )
    } catch (error) {
      note(journalAbs, 'failed', `could not roll forward reference ${reference.path}: ${(error as Error).message}`)
      return
    }
  }
  if (journal.phase === 'roll-back' && destExists && !srcExists) {
    try {
      if (kind === 'file') {
        await createOnlyMoveFile(destAbs, srcAbs)
        if (!moveDocumentMetadataReplacingDestination(db, journal.destRel, journal.srcRel)) {
          throw new Error('rename-reference rollback destination metadata is missing')
        }
      } else {
        // DURABLE reverse move (round-7 P1): the reference journal
        // records direction, not per-file placement — a replayable
        // rollback that crashed mid-move would leave a split tree
        // nothing describes (both sides fail the generation check and
        // the journal would be retained forever). The reverse move
        // therefore gets its OWN folder-move journal BEFORE the first
        // file moves. If that journal already exists (a crash left
        // it), it owns the tree and this journal waits: recovery
        // replays it on a later startup once the tree has settled.
        const companion = await findCompanionFolderMoveJournals(contentDir, journal.destRel, journal.srcRel)
        if (companion.kind === 'conflict') {
          note(journalAbs, 'quarantined', `multiple authoritative folder-move companions exist: ${companion.paths.map((p) => path.basename(p)).join(', ')}`)
          return
        }
        if (companion.kind === 'single') {
          note(journalAbs, 'quarantined', 'rename-reference rollback deferred to its folder-move journal')
          return
        }
        let moveEntries: FolderMoveJournalEntry[]
        let moveDirectories: string[]
        let moveDirectoryGenerations: NonNullable<
          FolderMoveJournalV4['directoryGenerations']
        >
        try {
          const enumerated = await listPhysicalMoveEntries(destAbs, (relativeFilePath) => {
            if (!relativeFilePath.endsWith('.md')) return null
            const documentSuffix = relativeFilePath.slice(0, -'.md'.length)
            const sourceIdentityPath = `${journal.srcRel}/${documentSuffix}`
            const identity = journal.identities!.find((item) => item.path === sourceIdentityPath)
            const moveSourcePath = `${journal.destRel}/${documentSuffix}`
            return identity ? { documentId: identity.id, documentPath: moveSourcePath } : null
          }, journal.destRel)
          moveEntries = enumerated.entries
          moveDirectories = enumerated.directories
          moveDirectoryGenerations = enumerated.directoryGenerations
        } catch (error) {
          note(journalAbs, 'failed', `could not enumerate the folder rollback tree: ${(error as Error).message}`)
          return
        }
        const moveUuid = randomUUID()
        const moveJournalAbs = path.join(
          path.dirname(destAbs),
          recoveryMarkerName('journal', path.basename(destAbs), moveUuid),
        )
        // Same default as the routes (the platform strategy); the
        // test-only override lets crash children run the journaled
        // per-file protocol on POSIX and kill recovery mid-replay.
        const moveStrategy = resolveDirectoryMoveStrategy()
        try {
          let destinationIdentity: DurableDirectoryIdentity
          try {
            destinationIdentity =
              await captureDurableDirectoryIdentity(destAbs)
          } catch {
            note(
              journalAbs,
              'quarantined',
              'folder rollback source is not a real directory',
            )
            return
          }
          const moveJournalEntries: FolderMoveJournalEntryV4[] = moveEntries.map((entry) => ({
            relativeFilePath: entry.relativeFilePath,
            sourceDev: entry.sourceDev ?? '',
            sourceIno: entry.sourceIno ?? '',
            sourceHash: entry.sourceHash,
            ...(entry.documentId !== undefined ? { documentId: entry.documentId } : {}),
            ...(entry.documentPath !== undefined ? { documentPath: entry.documentPath } : {}),
          }))
          // Round-14 P1-5: recovery-created companion journals are
          // v4 ONLY. v1–v3 journals were weakly typed (gate token on
          // disk, no per-entry generation proof) and a recovery that
          // wrote v2 here could be parsed by legacy parsers but never
          // reach the v4 phase machine — recovery would resolve to a
          // stale-journal cleanup and silently lose the data.
          const prepared: FolderMoveJournalV4 & { phase: 'prepared' } = {
            version: FOLDER_MOVE_JOURNAL_VERSION,
            op: 'folder-move',
            phase: 'prepared',
            srcRel: journal.destRel,
            destRel: journal.srcRel,
            strategy: moveStrategy,
            sourceDev: destinationIdentity.dev,
            sourceIno: destinationIdentity.ino,
            sourceBirthtimeNs: destinationIdentity.birthtimeNs,
            gateProof: createFolderMoveGateProof(),
            ...(moveJournalEntries.length === 0 ? { emptyTree: true } : {}),
            entries: moveJournalEntries,
            directories: moveDirectories,
            directoryGenerations: moveDirectoryGenerations,
            metadataDisposition: { kind: 'prefix-move' },
          }
          await writeDurableJournal(moveJournalAbs, prepared)
          const physical = await executeFolderMoveV4Physical({
            contentDir,
            journalAbs: moveJournalAbs,
            journal: prepared,
            srcAbs: destAbs,
            destAbs: srcAbs,
            strategy: moveStrategy,
          })
          await completeFolderMoveV4Metadata(
            contentDir,
            db,
            moveJournalAbs,
            physical.journal,
            destAbs,
            srcAbs,
            note,
          )
          if (await exists(moveJournalAbs)) {
            note(journalAbs, 'failed', 'folder-move companion retained after incomplete v4 metadata finalization')
            return
          }
        } catch (error) {
          // A thrown move may have left the tree SPLIT: the move
          // journal stays (it completes the rollback at the next
          // startup) and this journal replays afterwards.
          note(journalAbs, 'failed', `folder-move journal will complete the reference rollback: ${(error as Error).message}`)
          return
        }
      }
    } catch (error) {
      if (error instanceof RenameDestinationOccupiedError || error instanceof RenameSourceReusedError) {
        const forward = { ...journal, phase: 'roll-forward' as const }
        await rewriteDurableJournal(journalAbs, forward)
        await recoverRenameReferencesJournal(contentDir, db, journalAbs, forward, note)
        return
      }
      note(journalAbs, 'failed', `could not finish rename-reference main rollback: ${(error as Error).message}`)
      return
    }
  } else if (journal.phase === 'roll-back' && kind === 'file'
    && getDocumentMetadata(db, journal.srcRel)?.id !== journal.documentId
    && getDocumentMetadata(db, journal.destRel)?.id === journal.documentId) {
    if (!moveDocumentMetadataReplacingDestination(db, journal.destRel, journal.srcRel)) {
      note(journalAbs, 'failed', 'could not restore rename-reference source metadata')
      return
    }
  } else if (journal.phase === 'roll-back' && kind === 'folder'
    && !referenceOnly) {
    moveDocumentMetadataPrefix(db, journal.destRel, journal.srcRel)
  }
  await cleanup()
  note(journal.phase === 'roll-forward' ? destAbs : srcAbs, 'completed-rename', `rename reference transaction ${journal.phase === 'roll-forward' ? 'rolled forward' : 'rolled back'}`)
}

/** Derive every parent directory implied by entry file paths. Used when a
 * journal predates the directories field (v1) or when the declared set
 * must be extended for exact-parity checking. */
function deriveParentDirectories(entries: readonly FolderMoveJournalEntry[]): string[] {
  const dirs = new Set<string>()
  for (const entry of entries) {
    const parts = entry.relativeFilePath.split('/')
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'))
    }
  }
  return [...dirs].sort((a, b) => a.localeCompare(b))
}

/** Binary-safe content proof: folder-move journals hash EVERY physical
 * file (attachments included) with sha256HexBuffer. */
async function fileHashMatches(absPath: string, expectedHash: string): Promise<boolean> {
  try {
    return sha256HexBuffer(await fs.readFile(absPath)) === expectedHash
  } catch {
    return false
  }
}

/** Destination inventory result (round-8 P1/P3). Recovery must account
 * for the destination BEFORE replaying anything, so it never merges
 * journaled bytes into a directory an external writer owns. */
type DestInventory =
  | { kind: 'absent' }
  | { kind: 'external'; reason: string }
  | { kind: 'ours'; hasLandedFiles: boolean; hasGateToken: boolean }

/**
 * Reconcile a journaled folder move (the unified replay for every
 * journal that carries entries — v2 physical journals and normalized
 * v1 journals alike). The entries — every moved file's relative path
 * and content hash — plus the journaled directory set are the proof:
 *
 *   * every entry still at the source: the file move never landed.
 *     For a prefix-move journal (rename, either direction) that is a
 *     STALE journal: a destination proven ours by its gate token (not
 *     by mere emptiness) is pruned, any partial metadata move rolled
 *     back, journal removed; anything external quarantines. For a
 *     snapshot-restore journal (delete rollback) the restore IS the
 *     durable intent — the tree must not be stranded under its staging
 *     name, so the move completes FORWARD instead (into an absent or
 *     provably-ours destination only);
 *   * otherwise the move is completed FORWARD: every source-resident
 *     entry replays create-only into the destination, then the
 *     metadata disposition runs (prefix move, or the persisted
 *     snapshot restore). Recovery never moves an entry whose journaled
 *     generation it cannot find, never replaces a destination file
 *     (create-only link), and never merges into a destination holding
 *     undeclared content: an external generation anywhere retains the
 *     journal for inspection instead.
 *
 * Every per-entry source AND destination path is physically
 * containment-checked first (round-8 P0/P1), so a symlinked ancestor
 * planted after the journal was written cannot route a read/rename/link
 * (an external symlink planted after journal-write can only route
 * a read — the linker is what reads, not the journal).
 */
type AtomicGateCreatedResolution =
  | { kind: 'rename-not-landed'; finalGeneration?: never }
  | { kind: 'rename-landed'; finalGeneration: DurableDirectoryIdentity }
  | { kind: 'quarantined'; reason: string }

async function isEmptyDirectoryExcept(
  directoryAbs: string,
  ignoredName?: string,
): Promise<boolean> {
  try {
    const stat = await fs.lstat(directoryAbs)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false
    const entries = await fs.readdir(directoryAbs)
    return entries.every(name => ignoredName !== undefined && name === ignoredName)
  } catch {
    return false
  }
}

async function readDirectoryGeneration(
  directoryAbs: string,
): Promise<DurableDirectoryIdentity | null> {
  try {
    return await captureDurableDirectoryIdentity(directoryAbs)
  } catch {
    return null
  }
}

async function resolveAtomicGateCreatedState(
  srcAbs: string,
  destAbs: string,
  journal: FolderMoveJournalV4,
): Promise<AtomicGateCreatedResolution> {
  if (journal.strategy !== 'atomic-rename' || journal.phase !== 'gate-created') {
    return {
      kind: 'quarantined',
      reason: 'atomic gate-created resolver received incompatible journal',
    }
  }
  if (typeof journal.destDev !== 'string'
    || typeof journal.destIno !== 'string'
    || typeof journal.destBirthtimeNs !== 'string'
    || typeof journal.sourceBirthtimeNs !== 'string') {
    return {
      kind: 'quarantined',
      reason: 'atomic gate-created journal is missing gate generation',
    }
  }

  const sourceGeneration = {
    dev: String(journal.sourceDev),
    ino: String(journal.sourceIno),
    birthtimeNs: journal.sourceBirthtimeNs,
  }
  const gateGeneration = {
    dev: journal.destDev,
    ino: journal.destIno,
    birthtimeNs: journal.destBirthtimeNs,
  }
  const sourceExists = await isDirectory(srcAbs)
  const destinationExists = await isDirectory(destAbs)
  const sourceMatchesOriginal = sourceExists
    && await verifyDirectoryGeneration(srcAbs, sourceGeneration)
  const destinationMatchesGate = destinationExists
    && await verifyDirectoryGeneration(destAbs, gateGeneration)
  const destinationMatchesOriginalSource = destinationExists
    && await verifyDirectoryGeneration(destAbs, sourceGeneration)

  if (sourceMatchesOriginal && destinationMatchesGate) {
    if (journal.gateProof
      && !await verifyFolderMoveGateProof(destAbs, journal.gateProof)) {
      return {
        kind: 'quarantined',
        reason: 'atomic destination gate proof is missing or mismatched',
      }
    }
    if (!await isEmptyDirectoryExcept(destAbs, journal.gateProof?.markerName)) {
      return {
        kind: 'quarantined',
        reason: 'atomic destination gate contains undeclared external content',
      }
    }
    return { kind: 'rename-not-landed' }
  }

  if (!sourceExists && destinationMatchesOriginalSource) {
    return {
      kind: 'rename-landed',
      finalGeneration: sourceGeneration,
    }
  }

  return {
    kind: 'quarantined',
    reason: 'atomic gate-created state cannot prove either an intact gate or a landed source generation',
  }
}

async function finalizeFolderMoveV4Cleanup(
  _contentDir: string,
  db: DatabaseT,
  journalAbs: string,
  journal: FolderMoveJournalV4 & { phase: 'metadata-committed' },
  srcAbs: string,
  destAbs: string,
  note: (absPath: string, action: RecoveryAction['action'], detail?: string) => void,
): Promise<void> {
  const finalization = await finalizeFolderMoveV4CleanupShared(
    db,
    journalAbs,
    journal,
    srcAbs,
    destAbs,
  )
  note(
    finalization.completed ? destAbs : journalAbs,
    finalization.action,
    finalization.detail,
  )
}

async function completeFolderMoveV4Metadata(
  _contentDir: string,
  db: DatabaseT,
  journalAbs: string,
  journal: FolderMoveJournalV4 & { phase: 'files-landed' },
  srcAbs: string,
  destAbs: string,
  note: (absPath: string, action: RecoveryAction['action'], detail?: string) => void,
): Promise<void> {
  const finalization = await completeFolderMoveV4MetadataShared(
    db,
    journalAbs,
    journal,
    srcAbs,
    destAbs,
  )
  note(
    finalization.completed ? destAbs : journalAbs,
    finalization.action,
    finalization.detail,
  )
}

async function recoverFolderMoveJournalV4(
  contentDir: string,
  db: DatabaseT,
  journalAbs: string,
  journal: FolderMoveJournalV4,
  srcAbs: string,
  destAbs: string,
  note: (absPath: string, action: RecoveryAction['action'], detail?: string) => void,
): Promise<void> {
  const entries = journal.entries
  const directories = journal.directories
  const isSnapshotRestore = journal.metadataDisposition.kind === 'snapshot-restore'
  const effectiveSrcRel = isSnapshotRestore ? '' : journal.srcRel
  // P1-3: classify recovery strength before any mutation. Weak
  // journals (legacy variants, v4 markerless / empty-tree / mixed
  // proof / unsafe-numeric) are quarantined with a documented detail
  // — disk state and SQLite rows are preserved.
  const strength = classifyFolderMoveRecoveryStrength(journal)
  if (strength.strength !== 'strong') {
    note(
      journalAbs,
      'quarantined',
      'legacy journal lacks sufficient durable ownership proof',
    )
    return
  }
  const rootProvenanceError = await validateFolderMoveJournalV4RootProvenance(journal, contentDir, journalAbs)
  if (rootProvenanceError !== null) {
    note(journalAbs, 'quarantined', `v4 provenance validation failed: ${rootProvenanceError}`)
    return
  }
  if (isSnapshotRestore) {
    const metadataProvenanceError =
      await validateDurableSnapshotRestoreDisposition(
        journalAbs,
        journal,
      )
    if (metadataProvenanceError !== null) {
      note(journalAbs, 'quarantined', metadataProvenanceError)
      return
    }
  }

  const entryError = validateJournalEntriesV4(entries, effectiveSrcRel, isSnapshotRestore)
  if (entryError !== null) {
    note(journalAbs, 'quarantined', `v4 entry validation failed: ${entryError}`)
    return
  }
  const phaseError = validateFolderMovePhaseShape(journal)
  if (phaseError !== null) {
    note(journalAbs, 'quarantined', `v4 phase shape failed: ${phaseError}`)
    return
  }
  const sourceGenerationError = validateSourceDirectoryGeneration(journal)
  if (sourceGenerationError !== null) {
    note(journalAbs, 'quarantined', `v4 source generation failed: ${sourceGenerationError}`)
    return
  }
  for (const entry of entries) {
    const srcFile = path.join(srcAbs, entry.relativeFilePath)
    const destFile = path.join(destAbs, entry.relativeFilePath)
    if (!await isPhysicallyContained(contentDir, srcFile)
      || !await isPhysicallyContained(contentDir, destFile)) {
      note(journalAbs, 'quarantined', `v4 entry escapes the vault: ${entry.relativeFilePath}`)
      return
    }
  }
  for (const dirRel of directories) {
    const dirAbs = path.join(destAbs, dirRel)
    if (!await isPhysicallyContained(contentDir, dirAbs)) {
      note(journalAbs, 'quarantined', `v4 directory escapes the vault: ${dirRel}`)
      return
    }
  }

  if (journal.phase === 'prepared') {
    const sourceGenerationMatches = await verifyDirectoryGeneration(srcAbs, {
      dev: String(journal.sourceDev),
      ino: String(journal.sourceIno),
      birthtimeNs: journal.sourceBirthtimeNs as string,
    })
    const destinationAbsent = !await isDirectory(destAbs)
    const sourceInventory = sourceGenerationMatches
      ? await inspectFolderMoveSourceInventory(srcAbs, journal)
      : { kind: 'external' as const, reason: 'source root generation changed' }
    if (journal.metadataDisposition.kind === 'snapshot-restore') {
      if (!sourceGenerationMatches || !destinationAbsent) {
        note(journalAbs, 'quarantined', 'prepared snapshot restore cannot prove an intact source generation with an absent destination')
        return
      }
      try {
        const physical = await executeFolderMoveV4Physical({
          contentDir,
          journalAbs,
          journal: journal as FolderMoveJournalV4 & { phase: 'prepared' },
          srcAbs,
          destAbs,
          strategy: journal.strategy,
        })
        await completeFolderMoveV4Metadata(
          contentDir,
          db,
          journalAbs,
          physical.journal,
          srcAbs,
          destAbs,
          note,
        )
      } catch (error) {
        note(journalAbs, 'failed', `prepared snapshot restore executor failed: ${(error as Error).message}`)
      }
      return
    }

    const rows = listDocumentMetadata(db).filter((row) =>
      row.path === journal.srcRel || row.path.startsWith(`${journal.srcRel}/`)
        || row.path === journal.destRel || row.path.startsWith(`${journal.destRel}/`),
    )
    const expectedSource = new Map<string, string>()
    for (const entry of journal.entries) {
      if (entry.documentId !== undefined && entry.documentPath !== undefined) {
        expectedSource.set(entry.documentPath, entry.documentId)
      }
    }
    const sourceRows = rows.filter((row) =>
      row.path === journal.srcRel || row.path.startsWith(`${journal.srcRel}/`),
    )
    const destinationRows = rows.filter((row) =>
      row.path === journal.destRel || row.path.startsWith(`${journal.destRel}/`),
    )
    const sourceMetadataIntact = sourceRows.length === expectedSource.size
      && sourceRows.every((row) => expectedSource.get(row.path) === row.id)
    let preparedMetadataIntact = sourceMetadataIntact
      && destinationRows.length === 0
    if (journal.metadataDisposition.preparedSnapshot) {
      const expectedPrepared = reviveMetadataSnapshot(
        journal.metadataDisposition.preparedSnapshot,
      )
      const currentPrepared =
        snapshotDocumentMetadataMutationCurrentOwnership(db, expectedPrepared)
      preparedMetadataIntact = metadataSnapshotsExactlyEqual(
        currentPrepared,
        expectedPrepared,
      )
    }
    if (sourceGenerationMatches && sourceInventory.kind === 'intact'
      && destinationAbsent
      && preparedMetadataIntact) {
      await removeDurableJournal(journalAbs)
      note(journalAbs, 'cleaned', 'stale v4 prefix-move prepared journal (source generation and metadata intact; destination absent)')
      return
    }
    note(
      journalAbs,
      'quarantined',
      sourceInventory.kind === 'external'
        ? sourceInventory.reason
        : journal.metadataDisposition.preparedSnapshot
        ? 'live prefix metadata graph differs from prepared snapshot'
        : 'v4 prefix-move prepared journal cannot prove intact source generation/metadata with an absent destination',
    )
    return
  }

  if (journal.phase === 'gate-created') {
    if (journal.strategy === 'atomic-rename') {
      const resolution = await resolveAtomicGateCreatedState(srcAbs, destAbs, journal)
      if (resolution.kind === 'quarantined') {
        note(journalAbs, 'quarantined', resolution.reason)
        return
      }
      let finalGeneration: DurableDirectoryIdentity
      if (resolution.kind === 'rename-not-landed') {
        if (platformDirectoryMoveStrategy !== 'atomic-rename') {
          note(
            journalAbs,
            'quarantined',
            'atomic directory rename is unsupported on this platform',
          )
          return
        }
        if (journal.gateProof) {
          try {
            await removeFolderMoveGateProof(destAbs, journal.gateProof)
          } catch (error) {
            note(journalAbs, 'failed', `atomic recovery gate marker removal failed: ${(error as Error).message}`)
            return
          }
        }
        try {
          await fs.rename(srcAbs, destAbs)
        } catch (error) {
          note(journalAbs, 'failed', `atomic recovery rename failed: ${(error as Error).message}`)
          return
        }
        try {
          finalGeneration =
            await captureDurableDirectoryIdentity(destAbs)
        } catch (error) {
          note(journalAbs, 'failed', `atomic recovery destination stat failed: ${(error as Error).message}`)
          return
        }
        if (finalGeneration.dev !== String(journal.sourceDev)
          || finalGeneration.ino !== String(journal.sourceIno)
          || finalGeneration.birthtimeNs !== journal.sourceBirthtimeNs) {
          note(journalAbs, 'quarantined', 'atomic recovery rename produced a destination generation different from the original source')
          return
        }
      } else {
        finalGeneration = resolution.finalGeneration
      }
      if (await verifyFolderMoveDestinationV4(destAbs, {
        destDev: finalGeneration.dev,
        destIno: finalGeneration.ino,
        destBirthtimeNs: finalGeneration.birthtimeNs,
        entries,
        directories,
        directoryGenerations: journal.directoryGenerations,
        strategy: journal.strategy,
      })) {
        note(journalAbs, 'quarantined', 'atomic gate-created destination exact parity failed')
        return
      }
      const filesLanded = {
        ...journal,
        phase: 'files-landed' as const,
        destDev: finalGeneration.dev,
        destIno: finalGeneration.ino,
        destBirthtimeNs: finalGeneration.birthtimeNs,
      }
      await rewriteDurableJournal(journalAbs, filesLanded)
      await completeFolderMoveV4Metadata(
        contentDir,
        db,
        journalAbs,
        filesLanded,
        srcAbs,
        destAbs,
        note,
      )
      return
    }

    if (!journal.destDev || !journal.destIno || !journal.destBirthtimeNs) {
      note(journalAbs, 'quarantined', 'replayable gate-created journal is missing gate generation')
      return
    }
    if (journal.gateProof) {
      if (!await verifyFolderMoveGateProof(destAbs, journal.gateProof)) {
        note(journalAbs, 'quarantined', 'replayable destination gate proof is missing or mismatched')
        return
      }
      const currentGeneration = await readDirectoryGeneration(destAbs)
      if (currentGeneration === null) {
        note(journalAbs, 'quarantined', 'replayable destination gate proof is missing or mismatched')
        return
      }
      if (journal.destDev !== currentGeneration.dev
        || journal.destIno !== currentGeneration.ino
        || journal.destBirthtimeNs !== currentGeneration.birthtimeNs) {
        note(journalAbs, 'quarantined', 'replayable destination gate generation does not match journal')
        return
      }
    } else if (!await verifyDirectoryGeneration(destAbs, {
      dev: journal.destDev,
      ino: journal.destIno,
      birthtimeNs: journal.destBirthtimeNs,
    })) {
        note(journalAbs, 'quarantined', 'replayable destination gate generation does not match journal')
        return
    }
    if (journal.destinationDirectoryGenerations === undefined) {
      let unexpectedDestinationEntries: string[]
      try {
        unexpectedDestinationEntries = (await fs.readdir(destAbs))
          .filter(name => name !== journal.gateProof?.markerName)
      } catch (error) {
        note(
          journalAbs,
          'failed',
          `replayable destination directory inspection failed: ${(error as Error).message}`,
        )
        return
      }
      if (unexpectedDestinationEntries.length > 0) {
        note(
          journalAbs,
          'quarantined',
          'replayable destination directories lack durable generation proof',
        )
        return
      }
      try {
        journal = {
          ...journal,
          destinationDirectoryGenerations:
            await createFolderMoveDestinationDirectories(
              destAbs,
              journal.directories,
              contentDir,
            ),
        }
        await rewriteDurableJournal(journalAbs, journal)
      } catch (error) {
        note(
          journalAbs,
          'failed',
          `replayable destination directory creation failed: ${(error as Error).message}`,
        )
        return
      }
    } else {
      const directoryConflict = await verifyFolderMoveDirectoryEntries(
        destAbs,
        journal.destinationDirectoryGenerations,
      )
      if (directoryConflict !== null) {
        note(journalAbs, 'quarantined', directoryConflict)
        return
      }
    }
    const placements = await Promise.all(entries.map((entry) =>
      classifyPlacementV4(
        path.join(srcAbs, entry.relativeFilePath),
        path.join(destAbs, entry.relativeFilePath),
        { sourceDev: entry.sourceDev, sourceIno: entry.sourceIno, sourceHash: entry.sourceHash },
      ),
    ))
    if (placements.some((placement) => placement === 'external' || placement === 'missing')) {
      note(journalAbs, 'quarantined', 'replayable gate-created journal contains an external generation or missing entries')
      return
    }
    const remainingEntries = entries.filter((_, index) => placements[index] === 'src')
    if (remainingEntries.length > 0) {
      try {
        await moveFolderEntriesIntoExistingGate(srcAbs, destAbs, {
          vaultRoot: contentDir,
          entries: remainingEntries,
          directories,
          directoryGenerations: journal.directoryGenerations,
          expectedDestinationDirectoryGenerations:
            journal.destinationDirectoryGenerations,
          ignoredDestinationEntries: journal.gateProof
            ? [journal.gateProof.markerName]
            : [],
          preservePartialLandingOnError: true,
        })
      } catch (error) {
        note(journalAbs, 'failed', `replayable recovery failed: ${(error as Error).message}`)
        return
      }
    }
    const parityFailed = await verifyFolderMoveDestinationV4(destAbs, journal, {
      ignoredRelativePaths: journal.gateProof
        ? [journal.gateProof.markerName]
        : [],
    })
    if (parityFailed) {
      note(journalAbs, 'quarantined', 'replayable gate-created destination exact parity failed')
      return
    }
    const filesLanded = {
      ...journal,
      phase: 'files-landed' as const,
    }
    await rewriteDurableJournal(journalAbs, filesLanded)
    await completeFolderMoveV4Metadata(contentDir, db, journalAbs, filesLanded, srcAbs, destAbs, note)
    return
  }

  if (journal.phase === 'files-landed') {
    if (!journal.destDev || !journal.destIno || !journal.destBirthtimeNs) {
      note(journalAbs, 'quarantined', 'files-landed journal is missing final destination generation')
      return
    }
    if (journal.strategy === 'replayable-move' && journal.gateProof) {
      if (!await verifyFolderMoveGateProof(destAbs, journal.gateProof)) {
        note(journalAbs, 'quarantined', 'replayable destination gate proof is missing or mismatched')
        return
      }
      const currentGeneration = await readDirectoryGeneration(destAbs)
      if (currentGeneration === null) {
        note(journalAbs, 'quarantined', 'replayable destination gate proof is missing or mismatched')
        return
      }
      if (journal.destDev !== currentGeneration.dev
        || journal.destIno !== currentGeneration.ino
        || journal.destBirthtimeNs !== currentGeneration.birthtimeNs) {
        note(journalAbs, 'quarantined', 'files-landed destination generation does not match journal')
        return
      }
    } else if (!await verifyDirectoryGeneration(destAbs, {
      dev: journal.destDev,
      ino: journal.destIno,
      birthtimeNs: journal.destBirthtimeNs,
    })) {
        note(journalAbs, 'quarantined', 'files-landed destination generation does not match journal')
        return
    }
    await completeFolderMoveV4Metadata(
      contentDir,
      db,
      journalAbs,
      journal as FolderMoveJournalV4 & { phase: 'files-landed' },
      srcAbs,
      destAbs,
      note,
    )
    return
  }

  if (journal.phase === 'metadata-committed') {
    await finalizeFolderMoveV4Cleanup(
      contentDir,
      db,
      journalAbs,
      journal as FolderMoveJournalV4 & { phase: 'metadata-committed' },
      srcAbs,
      destAbs,
      note,
    )
    return
  }

  note(journalAbs, 'quarantined', `v4 unknown phase: ${journal.phase}`)
}

async function recoverFolderMoveJournal(
  contentDir: string,
  db: DatabaseT,
  journalAbs: string,
  journal: FolderRenameJournal,
  srcAbs: string,
  destAbs: string,
  note: (absPath: string, action: RecoveryAction['action'], detail?: string) => void,
): Promise<void> {
  const entries = journal.entries!
  const directories = journal.directories ?? []
  // Directory-set parity applies only when the journal declared its
  // directories (v2). v1 journals predate the field; enforcing it there
  // would flag their legitimate nested dirs as external.
  const declaredDirs = journal.directories
  // Exact-parity directories: the union of declared directories and
  // every parent implied by entry paths. For v3 this is the same set
  // (the parser enforces parent-closure); for v2 with directories it
  // extends the declared set so on-demand mkdir-p during replay is
  // covered; for v1 it is the complete set derived from entries alone.
  const parityDirectories = [...new Set([
    ...(journal.directories ?? []),
    ...deriveParentDirectories(entries),
  ])].sort((a, b) => a.localeCompare(b))
  const disposition: FolderMoveMetadataDisposition = journal.metadataDisposition ?? { kind: 'prefix-move' }
  // The journal's transaction id (its filename suffix) is the gate
  // token the mover drops inside the destination gate it creates.
  const journalName = path.basename(journalAbs)
  const transactionId = recoveryMarkerToken(journalName, 'journal') ?? ''
  const tokenName = gateTokenName(transactionId)
  const entryByRel = new Map(entries.map((entry) => [entry.relativeFilePath, entry]))
  const expectedDirs = new Set(declaredDirs ?? [])

  // Physical containment of every entry's two paths (round-8 P0/P1).
  for (const entry of entries) {
    const srcFile = path.join(srcAbs, entry.relativeFilePath)
    const destFile = path.join(destAbs, entry.relativeFilePath)
    if (!await isPhysicallyContained(contentDir, srcFile) || !await isPhysicallyContained(contentDir, destFile)) {
      note(journalAbs, 'quarantined', `folder-move entry escapes the vault via a symlinked path: ${entry.relativeFilePath}`)
      return
    }
  }

  type Placement = 'src' | 'dest' | 'external' | 'missing'
  const placements: Placement[] = await Promise.all(entries.map(async (entry) => {
    const srcFile = path.join(srcAbs, entry.relativeFilePath)
    const destFile = path.join(destAbs, entry.relativeFilePath)
    // Destination first: replay only moves forward, so a landed entry
    // is done even if an external file re-appeared at the source path.
    if (await fileHashMatches(destFile, entry.sourceHash)) return 'dest'
    if (await fileHashMatches(srcFile, entry.sourceHash)) return 'src'
    if (await exists(destFile) || await exists(srcFile)) return 'external'
    return 'missing'
  }))
  const countAt = (placement: Placement): number => placements.filter((found) => found === placement).length

  // Inventory the destination (round-8 P1/P3): everything present must
  // be provably ours — a hash-matched landed entry, a journaled
  // directory, or our gate token. Any undeclared file, symlink, special
  // entry, or foreign directory means an external writer owns (part of)
  // the destination and we quarantine rather than merge into it.
  const inventoryDestination = async (): Promise<DestInventory> => {
    if (!await exists(destAbs)) return { kind: 'absent' }
    if (!await isDirectory(destAbs)) return { kind: 'external', reason: 'destination exists but is not a directory' }
    let hasLandedFiles = false
    let hasGateToken = false
    let external: string | null = null
    const walk = async (dir: string, rel: string): Promise<void> => {
      if (external) return
      let dirents
      try {
        dirents = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        external = `destination directory is unreadable: ${rel || '.'}`
        return
      }
      for (const dirent of dirents) {
        if (external) return
        const relPath = rel === '' ? dirent.name : `${rel}/${dirent.name}`
        const absPath = path.join(dir, dirent.name)
        if (dirent.isSymbolicLink()) { external = `destination holds a symlink: ${relPath}`; return }
        if (dirent.isDirectory()) {
          if (declaredDirs !== undefined && !expectedDirs.has(relPath)) { external = `destination holds an undeclared directory: ${relPath}`; return }
          await walk(absPath, relPath)
        } else if (dirent.isFile()) {
          if (dirent.name === tokenName && rel === '') {
            // v3 gateToken: verify exact content, not just name (F2).
            if (journal.gateToken) {
              try {
                if (await fs.readFile(absPath, 'utf8') !== journal.gateToken) {
                  external = 'gate token content does not match the journal'
                  return
                }
              } catch { external = 'gate token file is unreadable'; return }
            }
            hasGateToken = true
            continue
          }
          const entry = entryByRel.get(relPath)
          if (!entry) { external = `destination holds an undeclared file: ${relPath}`; return }
          if (!await fileHashMatches(absPath, entry.sourceHash)) { external = `destination file does not match the journal: ${relPath}`; return }
          // v3 generation proof (F4): a byte-identical external
          // replacement gets a fresh inode — the hard-linked landing
          // preserves the source identity. The hash matched but the
          // generation is a different physical file.
          if (entry.sourceDev && entry.sourceIno) {
            try {
              const destStat = await fs.stat(absPath, { bigint: true })
              if (destStat.dev.toString() !== entry.sourceDev
                || destStat.ino.toString() !== entry.sourceIno) {
                external = `destination file generation identity does not match the journal: ${relPath}`
                return
              }
            } catch { external = `destination file is unreadable: ${relPath}`; return }
          }
          hasLandedFiles = true
        } else {
          external = `destination holds a special entry: ${relPath}`
          return
        }
      }
    }
    await walk(destAbs, '')
    if (external) return { kind: 'external', reason: external }
    return { kind: 'ours', hasLandedFiles, hasGateToken }
  }

  const completeMetadata = (): void => {
    if (disposition.kind === 'snapshot-restore') {
      const revived = reviveMetadataSnapshot(disposition.snapshot)
      // Do NOT trust the persisted preexistingTagIds for the orphan-tag
      // cleanup: recompute against the live DB so a forged snapshot can
      // never mark an unrelated tag "created by the mutation" and have
      // it deleted. Unioning with the live ids makes the cleanup a
      // no-op (safe — a rollback re-installs the folder's own tags).
      const liveTagIds = (db.prepare('SELECT id FROM tags').all() as Array<{ id: number }>).map((row) => row.id)
      revived.preexistingTagIds = [...new Set([...liveTagIds, ...revived.preexistingTagIds])]
      // Round-10 F8: validation + restore happen in the SAME SQLite
      // IMMEDIATE transaction. The validator runs INSIDE the
      // transaction with a fresh snapshot of the live rows the restore
      // is about to overwrite — concurrent writers cannot race the
      // restore because IMMEDIATE acquires a write lock up front.
      restoreDocumentMetadataMutationCAS(db, revived, (current) => {
        // Live DB ownership validation (round-9 F1): every snapshot
        // documentId must either not exist in the live DB or still be
        // bound to the declared path. A forged snapshot reusing a live
        // ID bound to an unrelated path must be rejected.
        const snapshotIdSet = new Set(revived.documentIds)
        if (snapshotIdSet.size > 0) {
          const liveById = new Map<string, string>(
            current.documents
              .filter((row) => snapshotIdSet.has(row.id as string))
              .map((row) => [row.id as string, row.path as string]),
          )
          const snapshotPathById = new Map<string, string>(
            revived.documents.map((d) => [d.id as string, d.path as string]),
          )
          for (const [id, declaredPath] of snapshotPathById) {
            const livePath = liveById.get(id)
            if (livePath !== undefined && livePath !== declaredPath) {
              throw new Error(`metadata ownership: snapshot documentId ${id} is currently bound to ${livePath}, not the declared ${declaredPath}`)
            }
          }
          const snapshotPathSet = new Set(revived.paths)
          for (const row of current.documents) {
            const livePath = row.path as string
            if (snapshotPathSet.has(livePath) && !snapshotIdSet.has(row.id as string)) {
              throw new Error(`metadata ownership: snapshot path ${livePath} is currently owned by a different documentId ${row.id as string}`)
            }
          }
        }
        return true
      })
    } else {
      moveDocumentMetadataPrefix(db, journal.srcRel, journal.destRel)
    }
  }
  // Round-10 F3: owned gate-token removal (read+verify+unlink). The
  // marker is the recovery ownership proof; an external writer who
  // replaced it is detected here — the marker stays on disk and the
  // journal stays so recovery can re-verify later.
  const removeOwnedGateToken = async (): Promise<void> => {
    if (!tokenName) return
    try {
      const buf = await fs.readFile(path.join(destAbs, tokenName), 'utf8')
      if (buf !== (journal.gateToken ?? '')) return
      await fs.unlink(path.join(destAbs, tokenName))
    } catch {
      // missing or unreadable — leave the marker on disk
    }
  }
  const finishForward = async (detail: string): Promise<void> => {
    try {
      completeMetadata()
    } catch (error) {
      note(journalAbs, 'quarantined', `could not complete folder-move metadata: ${(error as Error).message}`)
      return
    }
    // Round-10 F5: metadata has just committed; remove the owned gate
    // token (the recovery ownership proof). The token removal is the
    // last filesystem step before clearing the journal.
    await removeOwnedGateToken()
    await pruneEmptyDirectories(srcAbs)
    await removeDurableJournal(journalAbs).catch(() => {})
    note(destAbs, 'completed-rename', detail)
  }
  // A crash mid-metadata-move can leave rows at the destination prefix
  // even though no file moved: roll them back with the bytes. Rows
  // split across BOTH prefixes are ambiguous and quarantine.
  const rollbackStaleMetadata = (): boolean => {
    const allMetadata = listDocumentMetadata(db)
    const sourceHasMetadata = allMetadata.some((item) => item.path === journal.srcRel || item.path.startsWith(`${journal.srcRel}/`))
    const destinationHasMetadata = allMetadata.some((item) => item.path === journal.destRel || item.path.startsWith(`${journal.destRel}/`))
    if (!destinationHasMetadata) return true
    if (sourceHasMetadata) {
      note(journalAbs, 'quarantined', 'folder source exists but metadata is split across both prefixes')
      return false
    }
    try {
      moveDocumentMetadataPrefix(db, journal.destRel, journal.srcRel)
      return true
    } catch (error) {
      note(journalAbs, 'failed', `could not restore folder metadata prefix: ${(error as Error).message}`)
      return false
    }
  }
  // Prune a stale destination gate proven ours by its gate token
  // (round-8: emptiness alone is NOT ownership proof). Round-10 F3:
  // removes the token only when the on-disk content matches the
  // journaled gate secret.
  const pruneStaleGate = async (inventory: DestInventory): Promise<boolean> => {
    if (inventory.kind === 'absent') return true
    if (inventory.kind === 'ours' && !inventory.hasLandedFiles && inventory.hasGateToken) {
      await removeOwnedGateToken()
      await pruneEmptyDirectories(destAbs)
      return true
    }
    note(journalAbs, 'quarantined', inventory.kind === 'ours'
      ? 'source intact but the destination gate is not provably ours (no gate token)'
      : `source intact but the destination holds external content (${inventory.reason})`)
    return false
  }

  const emptyTree = journal.emptyTree === true
  const srcIsDir = await isDirectory(srcAbs)
  const inventory = await inventoryDestination()

  if (emptyTree) {
    if (srcIsDir) {
      if (disposition.kind === 'prefix-move') {
        // The empty tree never left the source: stale journal. Prune
        // our own gate (proven by token); anything else is external.
        if (!await pruneStaleGate(inventory)) return
        if (!rollbackStaleMetadata()) return
        await removeDurableJournal(journalAbs).catch(() => {})
        note(journalAbs, 'cleaned', inventory.kind === 'absent'
          ? 'stale empty-tree folder-move journal (move never started)'
          : 'stale empty-tree folder-move journal (gate pruned)')
        return
      }
      // snapshot-restore: the restore is the durable intent — recreate
      // the empty folder (and its directories) plus metadata, into an
      // absent or provably-ours destination only.
      if (inventory.kind === 'external') {
        note(journalAbs, 'quarantined', `destination holds external content (${inventory.reason})`)
        return
      }
      if (inventory.kind === 'ours' && inventory.hasLandedFiles) {
        note(journalAbs, 'quarantined', 'empty-tree journal but the destination holds files')
        return
      }
      try { await fs.mkdir(destAbs, { recursive: true }) } catch { /* ours or absent */ }
      for (const dirRel of directories) await fs.mkdir(path.join(destAbs, dirRel), { recursive: true })
      await finishForward('interrupted empty-tree folder restore completed from journal')
      return
    }
    if (inventory.kind === 'ours') {
      await finishForward('interrupted empty-tree folder move completed from journal')
      return
    }
    if (inventory.kind === 'absent') {
      note(journalAbs, 'failed', 'empty-tree folder-move journal but neither source nor destination exists')
      return
    }
    note(journalAbs, 'quarantined', `destination holds external content (${inventory.reason})`)
    return
  }

  if (countAt('src') === entries.length) {
    if (disposition.kind === 'snapshot-restore') {
      // A delete rollback crashed before its first file moved: the
      // restore is the durable intent and the staged tree must not be
      // stranded under its inflight name — complete forward, but only
      // into an absent or provably-ours destination (never merge into
      // an externally-created directory — round-8 P1).
      if (inventory.kind === 'external') {
        note(journalAbs, 'quarantined', `destination holds external content (${inventory.reason})`)
        return
      }
      if (inventory.kind === 'ours' && inventory.hasLandedFiles) {
        note(journalAbs, 'quarantined', 'all entries at source but the destination already holds files')
        return
      }
      if (!await replayEntries(contentDir, entries, directories, placements, srcAbs, destAbs, journalAbs, note)) return
      const tokenFileOnDiskRestore = inventory.kind === 'ours' ? inventory.hasGateToken : false
      const shouldCheckTokenRestore = (journal.gateToken !== undefined && tokenFileOnDiskRestore)
        || (journal.gateToken === undefined && tokenFileOnDiskRestore)
      const parityFailedAfterRestore = await verifyExactParity(destAbs, {
        entries,
        directories: parityDirectories,
        // Same alias-ownership rules as the forward replay path.
        ...(shouldCheckTokenRestore ? { gateToken: transactionId } : {}),
        ...(journal.gateToken && tokenFileOnDiskRestore ? { gateTokenValue: journal.gateToken } : {}),
      })
      if (parityFailedAfterRestore) {
        note(journalAbs, 'quarantined', 'exact parity failed after snapshot-restore replay')
        return
      }
      await finishForward('interrupted folder restore completed from journal')
      return
    }
    // The file move never landed: stale journal. Prune our own gate
    // (proven by its token, not by emptiness); roll back any partial
    // metadata move; remove the journal.
    if (!await pruneStaleGate(inventory)) return
    if (!rollbackStaleMetadata()) return
    await removeDurableJournal(journalAbs).catch(() => {})
    note(journalAbs, 'cleaned', inventory.kind === 'absent'
      ? 'stale folder-move journal (move never started)'
      : 'stale folder-move journal (gate pruned)')
    return
  }

  // Split or fully landed: complete forward — but only if the
  // destination holds nothing external (round-8 P1: never merge
  // journaled bytes into an externally-owned directory).
  if (inventory.kind === 'external') {
    note(journalAbs, 'quarantined', `destination holds external content (${inventory.reason})`)
    return
  }
  if (!await replayEntries(contentDir, entries, directories, placements, srcAbs, destAbs, journalAbs, note)) return
  // Exact final parity (round-9 F3): after replay, verify the
  // destination holds exactly the journaled file+directory set with
  // matching content hashes and exact gate token before committing
  // metadata. An external writer that modified the destination during
  // replay must fail closed — the journal stays for inspection.
  //
  // Round-10 F4: only pass the gate token to parity when it is still
  // expected to be on disk. The route's finalize removes the token
  // (F3) AFTER parity passes, so a journal whose destination has all
  // entries landed but no token is a successfully-completed forward
  // move awaiting metadata commit — the token is NOT required in
  // that case.
  // Pass `gateToken` to parity only when we know the journal's token
  // marker file SHOULD be on disk. v3 journals with the secret persist
  // both name + value; v1/v2 journals without a secret that left a
  // token file behind still own it by name. v1/v2 journals with no
  // gateTokenValue and no token on disk must skip the marker check
  // (parity treats it as undeclared otherwise).
  const tokenFileOnDisk = inventory.kind === 'ours' ? inventory.hasGateToken : false
  // v3 journal + no token file on disk: the route's finalize removed
  // it after parity passed (round-10 F3/F5). The forward move
  // completed; metadata commit is the only outstanding step — skip
  // the token check entirely.
  const shouldCheckToken = (journal.gateToken !== undefined && tokenFileOnDisk)
    || (journal.gateToken === undefined && tokenFileOnDisk)
  const parityFailed = await verifyExactParity(destAbs, {
    entries,
    directories: parityDirectories,
    ...(shouldCheckToken ? { gateToken: transactionId } : {}),
    ...(journal.gateToken && tokenFileOnDisk ? { gateTokenValue: journal.gateToken } : {}),
  })
  if (parityFailed) {
    note(journalAbs, 'quarantined', 'exact parity failed after recovery replay')
    return
  }
  await finishForward('interrupted folder move completed from journal')
}

/** Replay every source-resident entry create-only into the
 * destination, recreating the journaled directory structure first
 * (round-8 P1: nested empty directories are preserved). Never replaces
 * a destination file (create-only link); an external or missing
 * generation fails closed with the journal retained. Every path is
 * containment-checked again at replay time. Fires the per-entry crash
 * seam so a kill mid-recovery replays again on the next startup. */
async function replayEntries(
  contentDir: string,
  entries: FolderMoveJournalEntry[],
  directories: string[],
  placements: Array<'src' | 'dest' | 'external' | 'missing'>,
  srcAbs: string,
  destAbs: string,
  journalAbs: string,
  note: (absPath: string, action: RecoveryAction['action'], detail?: string) => void,
): Promise<boolean> {
  for (const dirRel of directories) {
    const dirAbs = path.join(destAbs, dirRel)
    if (!await isPhysicallyContained(contentDir, dirAbs)) {
      note(journalAbs, 'quarantined', `folder-move directory escapes the vault via a symlinked path: ${dirRel}`)
      return false
    }
    try {
      await fs.mkdir(dirAbs, { recursive: true })
    } catch (error) {
      note(journalAbs, 'failed', `could not recreate folder-move directory ${dirRel}: ${(error as Error).message}`)
      return false
    }
  }
  for (let index = 0; index < entries.length; index += 1) {
    const placement = placements[index]
    if (placement === 'dest') continue
    const entry = entries[index]
    if (placement !== 'src') {
      note(journalAbs, 'failed', `folder-move entry is not replayable (${placement}): ${entry.relativeFilePath}`)
      return false
    }
    const srcFile = path.join(srcAbs, entry.relativeFilePath)
    const destFile = path.join(destAbs, entry.relativeFilePath)
    if (!await isPhysicallyContained(contentDir, srcFile) || !await isPhysicallyContained(contentDir, destFile)) {
      note(journalAbs, 'quarantined', `folder-move entry escapes the vault via a symlinked path: ${entry.relativeFilePath}`)
      return false
    }
    try {
      await fs.mkdir(path.dirname(destFile), { recursive: true })
      await createOnlyMoveFile(srcFile, destFile)
      await fireReplayableMovedEntryHook(entry.relativeFilePath)
    } catch (error) {
      note(journalAbs, 'failed', `could not replay folder-move entry ${entry.relativeFilePath}: ${(error as Error).message}`)
      return false
    }
  }
  return true
}

async function recoverFolderRenameJournal(
  contentDir: string,
  db: DatabaseT,
  journalAbs: string,
  journal: FolderRenameJournal,
  note: (absPath: string, action: RecoveryAction['action'], detail?: string) => void,
): Promise<void> {
  const recoveryStrength = classifyFolderMoveRecoveryStrength(journal)
  if (recoveryStrength.strength !== 'strong') {
    note(
      journalAbs,
      'quarantined',
      'legacy journal lacks sufficient durable ownership proof',
    )
    return
  }
  // Source provenance: a real folder path for rename journals; the
  // reserved delete-staging name for snapshot-restore (delete
  // rollback) journals — those are never user paths.
  const srcRelIsValid = journal.metadataDisposition?.kind === 'snapshot-restore'
    ? DELETE_INFLIGHT_RE.test(journal.srcRel)
      && journal.srcRel.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
    : await validRenameRel(contentDir, journal.srcRel)
  if (
    journal.srcRel === journal.destRel
    || path.dirname(journal.srcRel) !== path.dirname(journal.destRel)
    || !srcRelIsValid
    || !await validRenameRel(contentDir, journal.destRel)
    || !journalBelongsToSource(contentDir, journalAbs, journal.srcRel, 'folder', journal.destRel)
  ) {
    note(journalAbs, 'quarantined', 'invalid folder-rename journal paths; no referenced path was touched')
    return
  }
  const srcAbs = path.join(contentDir, journal.srcRel)
  const destAbs = path.join(contentDir, journal.destRel)
  if ((journal as unknown as { version?: number }).version === 4) {
    // v4 (round-11): dedicated phase-aware recovery. v1–v3 fall through
    // to the legacy token-based path below.
    const raw = await fs.readFile(journalAbs, 'utf8')
    const v4 = parseDurableFolderMoveJournalV4(raw)
    if (v4 === null) {
      note(journalAbs, 'quarantined', 'v4 journal could not be parsed')
      return
    }
    await recoverFolderMoveJournalV4(contentDir, db, journalAbs, v4, srcAbs, destAbs, note)
    return
  }
  if (journal.emptyTree || (journal.entries !== undefined && journal.entries.length > 0)) {
    await recoverFolderMoveJournal(contentDir, db, journalAbs, journal, srcAbs, destAbs, note)
    return
  }
  // The directory move is a single rename(2) over our own mkdir-gated
  // empty directory: after a crash the whole tree is at exactly ONE of
  // the two paths, never split.
  const srcIsDir = await isDirectory(srcAbs)
  const destIsDir = await isDirectory(destAbs)
  const matchesSourceGeneration = async (abs: string): Promise<boolean> => {
    try {
      const stat = await fs.stat(abs)
      return stat.dev === journal.sourceDev && stat.ino === journal.sourceIno
    } catch { return false }
  }

  if (srcIsDir) {
    if (!await matchesSourceGeneration(srcAbs)) {
      note(journalAbs, 'quarantined', 'folder-rename source generation does not match journal')
      return
    }
    if (!destIsDir) {
      // Crash before the move (or after an externally re-used
      // destination failed it — the route removes the journal in that
      // case, so this is the pre-move crash): state is consistent,
      // the journal is stale.
      const allMetadata = listDocumentMetadata(db)
      const sourceHasMetadata = allMetadata.some((item) => item.path === journal.srcRel || item.path.startsWith(`${journal.srcRel}/`))
      const destinationHasMetadata = allMetadata.some((item) => item.path === journal.destRel || item.path.startsWith(`${journal.destRel}/`))
      if (destinationHasMetadata) {
        if (sourceHasMetadata) {
          note(journalAbs, 'quarantined', 'folder source exists but metadata is split across both prefixes')
          return
        }
        try { moveDocumentMetadataPrefix(db, journal.destRel, journal.srcRel) }
        catch (error) {
          note(journalAbs, 'failed', `could not restore folder metadata prefix: ${(error as Error).message}`)
          return
        }
      }
      await removeDurableJournal(journalAbs).catch(() => {})
      note(journalAbs, 'cleaned', 'stale folder-rename journal (move never started)')
      return
    }
    // Empty is not ownership proof. Without a journaled gate token we
    // never remove a destination directory, even when it is empty.
    note(journalAbs, 'quarantined', 'source remains but destination also exists; destination ownership is unproven')
    return
  }

  if (destIsDir) {
    if (!await matchesSourceGeneration(destAbs)) {
      note(journalAbs, 'quarantined', 'folder-rename destination generation does not match journal')
      return
    }
    // The move landed; finish the metadata prefix move (idempotent: it
    // is a no-op if the crash hit after the move, during journal
    // removal) and clear the journal.
    try {
      moveDocumentMetadataPrefix(db, journal.srcRel, journal.destRel)
    } catch (error) {
      note(journalAbs, 'failed', `could not complete folder-rename metadata move: ${(error as Error).message}`)
      return
    }
    await removeDurableJournal(journalAbs).catch(() => {})
    note(destAbs, 'completed-rename', 'interrupted folder rename completed from journal')
    return
  }

  // Neither path exists: cannot guess what happened; leave the journal
  // for inspection.
  note(journalAbs, 'failed', 'folder-rename journal but neither source nor destination exists')
}

async function recoverRenameStaging(
  contentDir: string,
  db: DatabaseT,
  dir: string,
  base: string,
  stagedAbs: string,
  getInodeMap: () => Promise<Map<string, string[]>>,
  note: (absPath: string, action: RecoveryAction['action'], detail?: string) => void,
): Promise<void> {
  // The create-only file move (createOnlyMoveFile) takes the source
  // aside under this reserved name, links it into the destination
  // (create-only), then unlinks the staging name. A crash between the
  // link and the unlink leaves two names on one inode — find the
  // destination partner by inode and complete the rename. (Hardlinked
  // .md files in a vault are vanishingly rare; an unrelated hardlink
  // partner would be indistinguishable here — a documented limit.)
  const stat = await fs.stat(stagedAbs)
  const inodeMap = await getInodeMap()
  // Re-verify each candidate's inode: the map may be cached from an
  // earlier directory's recovery, and paths can have changed since.
  const partners: string[] = []
  for (const candidate of inodeMap.get(`${stat.dev}:${stat.ino}`) ?? []) {
    if (candidate === stagedAbs) continue
    try {
      if ((await fs.stat(candidate)).ino === stat.ino) partners.push(candidate)
    } catch { /* candidate vanished mid-recovery */ }
  }
  if (partners.length > 0) {
    const destAbs = [...partners].sort()[0]
    await rm(stagedAbs)
    // The metadata move runs AFTER the file move in both the forward
    // rename and its internal rollback, so with staging still on disk
    // the identity is still at the staging basename's path. Complete
    // the move so the identity follows the bytes (replacing-destination
    // semantics also cover the rollback-crash direction).
    const fromMeta = metadataPathFor(vaultRelative(contentDir, path.join(dir, base)))
    const toMeta = metadataPathFor(vaultRelative(contentDir, destAbs))
    if (fromMeta !== toMeta) {
      try { moveDocumentMetadataReplacingDestination(db, fromMeta, toMeta) } catch { /* best effort */ }
    }
    note(destAbs, 'completed-rename', 'interrupted rename completed (staging inode matched destination)')
    return
  }
  // No link partner: the crash hit between the takeover rename and the
  // link. Restore the source create-only — a path re-used externally
  // wins and the staging stays quarantined.
  const sourceAbs = path.join(dir, base)
  if (await exists(sourceAbs)) {
    note(stagedAbs, 'quarantined', 'rename staging; source re-used externally, kept for inspection')
    return
  }
  const { restored } = await restoreCreateOnly(stagedAbs, sourceAbs)
  if (restored) note(sourceAbs, 'restored', 'orphaned rename staging restored')
  else note(stagedAbs, 'quarantined', 'rename staging; source claimed externally during recovery')
}

async function completeInterruptedDelete(
  contentDir: string,
  db: DatabaseT,
  quarantineAbs: string,
  targetAbs: string,
  note: (absPath: string, action: RecoveryAction['action'], detail?: string) => void,
): Promise<void> {
  // The deletion was initiated and validated; the staged generation is
  // the only copy left. Finishing the delete reconciles the metadata
  // (otherwise the identity row would point at a missing file). The
  // bytes survive under version control / the user's own backups —
  // resurrecting a user-requested delete on every crash would be a
  // worse surprise.
  const stat = await fs.stat(quarantineAbs)
  const metaPath = metadataPathFor(vaultRelative(contentDir, targetAbs))
  if (stat.isDirectory()) {
    deleteDocumentMetadataPrefix(db, metaPath)
    await fs.rm(quarantineAbs, { recursive: true, force: true })
    await syncParentDirectoryBestEffort(quarantineAbs)
    note(targetAbs, 'completed-delete', 'interrupted folder delete completed')
    return
  }
  deleteDocumentMetadata(db, metaPath)
  await fs.rm(quarantineAbs, { force: true, recursive: false })
  await syncParentDirectoryBestEffort(quarantineAbs)
  note(targetAbs, 'completed-delete', 'interrupted delete completed')
}

async function managedDeleteSourceMatches(
  stagedAbs: string,
  parentAbs: string,
  source: NonNullable<DeleteReuseManifest['source']>,
): Promise<boolean> {
  try {
    const [file, parent] = await Promise.all([
      fs.lstat(stagedAbs, { bigint: true }),
      fs.lstat(parentAbs, { bigint: true }),
    ])
    return file.isFile()
      && !file.isSymbolicLink()
      && parent.isDirectory()
      && !parent.isSymbolicLink()
      && file.dev.toString() === source.dev
      && file.ino.toString() === source.ino
      && parent.dev.toString() === source.parentDev
      && parent.ino.toString() === source.parentIno
  } catch {
    return false
  }
}

/** Recover the structural intent written by the encrypted-Diary delete owner.
 * This is deliberately separate from the legacy generic delete rule: a
 * managed manifest carries the old documentId and source inode, so a fresh
 * identity or foreign staged generation is never detached, adopted, or
 * parsed. Body bytes are moved or removed opaquely with filesystem calls. */
async function recoverManagedDeleteIntent(
  contentDir: string,
  db: DatabaseT,
  dir: string,
  targetAbs: string,
  manifestAbs: string,
  manifest: DeleteReuseManifest,
  note: (absPath: string, action: RecoveryAction['action'], detail?: string) => void,
): Promise<void> {
  const stagedAbs = path.join(dir, manifest.inflight)
  const quarantineAbs = path.join(dir, manifest.quarantine)
  const metaPath = metadataPathFor(vaultRelative(contentDir, targetAbs))
  const oldIdentity = manifest.documentId!
  const current = getDocumentMetadata(db, metaPath)
  const ownsCurrentIdentity = current?.id === oldIdentity
  const targetExists = await exists(targetAbs)
  const stagedExists = await exists(stagedAbs)
  const quarantineExists = await exists(quarantineAbs)

  if (targetExists) {
    // A public generation won the path. Never overwrite it. If the
    // deterministic quarantine name is already occupied, stop and leave all
    // artifacts for a later/manual recovery rather than replacing either.
    if (stagedExists) {
      if (quarantineExists) throw new Error('managed delete quarantine path is already occupied')
      await fs.rename(stagedAbs, quarantineAbs)
      await syncParentDirectoryBestEffort(quarantineAbs)
    }
    // With neither staged nor quarantined old bytes, the target is already
    // the restored/current generation (or the delete completed before an
    // external replacement). Do not detach its live metadata on that path.
    if ((stagedExists || quarantineExists) && ownsCurrentIdentity) {
      deleteDocumentMetadata(db, metaPath)
    }
    await removeDurableJournal(manifestAbs)
    note(quarantineAbs, 'quarantined', 'managed delete path reuse preserved external generation')
    return
  }

  if (stagedExists) {
    const stagedOwned = await managedDeleteSourceMatches(stagedAbs, dir, manifest.source!)
    if (!stagedOwned) {
      if (quarantineExists) throw new Error('managed delete quarantine path is already occupied')
      await fs.rename(stagedAbs, quarantineAbs)
      await syncParentDirectoryBestEffort(quarantineAbs)
      if (ownsCurrentIdentity) deleteDocumentMetadata(db, metaPath)
      await removeDurableJournal(manifestAbs)
      note(quarantineAbs, 'quarantined', 'managed delete foreign staging preserved')
      return
    }
    // The exact source generation is still in the reserved staging name and
    // the public path is empty: complete the user-requested delete. Delete
    // metadata before removing the only remaining ciphertext generation.
    if (ownsCurrentIdentity) deleteDocumentMetadata(db, metaPath)
    await fs.rm(stagedAbs, { force: true, recursive: false })
    await syncParentDirectoryBestEffort(stagedAbs)
    await removeDurableJournal(manifestAbs)
    note(targetAbs, 'completed-delete', 'managed Diary delete completed during recovery')
    return
  }

  if (quarantineExists) {
    // A prior recovery/owner pass already made the path-reuse disposition.
    // Keep that opaque quarantine permanently and only replay an identity
    // detachment when the current row is exactly the manifest's old owner.
    if (ownsCurrentIdentity) deleteDocumentMetadata(db, metaPath)
    await removeDurableJournal(manifestAbs)
    note(quarantineAbs, 'quarantined', 'managed delete quarantine identity replayed')
    return
  }

  // The only remaining state is a completed filesystem/metadata transition
  // whose journal cleanup was interrupted. Remove the structural intent; do
  // not infer or create any new identity.
  if (!targetExists && ownsCurrentIdentity) deleteDocumentMetadata(db, metaPath)
  await removeDurableJournal(manifestAbs)
  note(targetAbs, 'completed-delete', 'managed Diary delete journal finalized')
}

async function recoverDirectory(
  contentDir: string,
  db: DatabaseT,
  dir: string,
  entries: Dirent[],
  getInodeMap: () => Promise<Map<string, string[]>>,
  note: (absPath: string, action: RecoveryAction['action'], detail?: string) => void,
  terminalArtifacts: ReadonlySet<string>,
): Promise<void> {
  const groups = new Map<string, ArtifactGroup>()
  const groupFor = (base: string): ArtifactGroup => {
    let group = groups.get(base)
    if (!group) {
      group = { base, journals: [], staged: [], save: [], remove: [], rename: [], quarantines: [], deleteManifests: [], quarantineManifests: [] }
      groups.set(base, group)
    }
    return group
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      // A folder delete stages the whole subtree as a DIRECTORY under
      // the reserved `.nuvyn-delete-*` name.
      const dirMatch = DELETE_RE.exec(entry.name)
      if (dirMatch) groupFor(dirMatch[1]).quarantines.push(entry.name)
      const inflightMatch = DELETE_INFLIGHT_RE.exec(entry.name)
      if (inflightMatch) groupFor(inflightMatch[1]).quarantines.push(entry.name)
      const quarantineMatch = DELETE_QUARANTINE_RE.exec(entry.name)
      if (quarantineMatch) groupFor(quarantineMatch[1]).quarantines.push(entry.name)
      continue
    }
    const name = entry.name
    let match = JOURNAL_RE.exec(name)
    if (match) { groupFor(match[1]).journals.push(name); continue }
    match = STAGED_RE.exec(name)
    if (match) { groupFor(match[1]).staged.push(name); continue }
    match = SAVE_RE.exec(name)
    if (match) { groupFor(match[1]).save.push(name); continue }
    match = REMOVE_RE.exec(name)
    if (match) { groupFor(match[1]).remove.push(name); continue }
    match = RENAME_RE.exec(name)
    if (match) { groupFor(match[1]).rename.push(name); continue }
    match = DELETE_RE.exec(name)
    if (match) { groupFor(match[1]).quarantines.push(name); continue }
    match = DELETE_INFLIGHT_RE.exec(name)
    if (match) { groupFor(match[1]).quarantines.push(name); continue }
    match = DELETE_QUARANTINE_RE.exec(name)
    if (match) { groupFor(match[1]).quarantines.push(name); continue }
    match = DELETE_MANIFEST_RE.exec(name)
    if (match) { groupFor(match[1]).deleteManifests.push(name); continue }
    match = QUARANTINE_MANIFEST_RE.exec(name)
    if (match) { groupFor(match[1]).quarantineManifests.push(name); continue }
  }

  for (const group of groups.values()) {
    const targetAbs = path.join(dir, group.base)
    for (const manifestName of group.quarantineManifests.sort()) {
      const manifestAbs = path.join(dir, manifestName)
      if (terminalArtifacts.has(path.resolve(manifestAbs))) continue
      try {
        const manifest = parseLegacyDeleteQuarantineManifest(await fs.readFile(manifestAbs, 'utf8'))
        const expectedMetaPath = metadataPathFor(vaultRelative(contentDir, targetAbs))
        if (!manifest || !isValidPathSyntax(manifest.path) || manifest.path !== expectedMetaPath
          || path.basename(manifest.quarantine) !== manifest.quarantine
          || !isRecoveryMarkerName(manifest.quarantine, 'quarantine-reuse')
          || !manifest.identities.every((identity) => isValidPathSyntax(identity.path)
            && (identity.path === manifest.path || identity.path.startsWith(`${manifest.path}/`)))) {
          note(manifestAbs, 'quarantined', 'invalid legacy delete quarantine manifest')
          continue
        }
        const quarantineAbs = path.join(dir, manifest.quarantine)
        if (!await exists(quarantineAbs)) {
          note(manifestAbs, 'failed', 'legacy quarantine manifest payload is missing')
          continue
        }
        for (const identity of manifest.identities) {
          if (getDocumentMetadata(db, identity.path)?.id === identity.id) deleteDocumentMetadata(db, identity.path)
        }
        // This manifest is intentionally permanent: it is the only
        // durable association between quarantined bytes and their old IDs.
        note(manifestAbs, 'quarantined', 'legacy quarantine identity detachment replayed')
      } catch (error) {
        note(manifestAbs, 'failed', (error as Error).message)
      }
    }
    for (const manifestName of group.deleteManifests.sort()) {
      const manifestAbs = path.join(dir, manifestName)
      if (terminalArtifacts.has(path.resolve(manifestAbs))) continue
      try {
        const manifest = parseDeleteReuseManifest(await fs.readFile(manifestAbs, 'utf8'))
        if (!manifest || !isValidPathSyntax(manifest.path)) {
          note(manifestAbs, 'quarantined', 'invalid delete path-reuse manifest')
          continue
        }
        const expectedTarget = manifest.kind === 'file'
          ? path.join(contentDir, `${manifest.path}.md`)
          : path.join(contentDir, manifest.path)
        if (expectedTarget !== targetAbs
          || path.basename(manifest.inflight) !== manifest.inflight
          || path.basename(manifest.quarantine) !== manifest.quarantine
          || !isRecoveryMarkerName(manifest.inflight, 'delete-inflight')
          || !isRecoveryMarkerName(manifest.quarantine, 'quarantine-reuse')) {
          note(manifestAbs, 'quarantined', 'delete path-reuse manifest is not bound to its public path')
          continue
        }
        const identitiesAreScoped = manifest.identities.every((identity) =>
          isValidPathSyntax(identity.path)
          && (manifest.kind === 'file'
            ? identity.path === manifest.path
            : identity.path === manifest.path || identity.path.startsWith(`${manifest.path}/`)))
        if (!identitiesAreScoped) {
          note(manifestAbs, 'quarantined', 'delete path-reuse manifest contains out-of-scope identities')
          continue
        }
        if (manifest.phase === 'managed-delete-intent') {
          await recoverManagedDeleteIntent(contentDir, db, dir, targetAbs, manifestAbs, manifest, note)
          continue
        }
        const inflightAbs = path.join(dir, manifest.inflight)
        const quarantineAbs = path.join(dir, manifest.quarantine)
        if (await exists(inflightAbs) && !await exists(quarantineAbs)) {
          await fs.rename(inflightAbs, quarantineAbs)
          await syncParentDirectoryBestEffort(quarantineAbs)
        }
        if (!await exists(quarantineAbs)) {
          note(manifestAbs, 'failed', 'delete path-reuse manifest has no surviving quarantine generation')
          continue
        }
        for (const identity of manifest.identities) {
          if (getDocumentMetadata(db, identity.path)?.id === identity.id) {
            deleteDocumentMetadata(db, identity.path)
          }
        }
        await removeDurableJournal(manifestAbs)
        note(quarantineAbs, 'quarantined', 'delete path-reuse identity detachment replayed')
      } catch (error) {
        note(manifestAbs, 'failed', (error as Error).message)
      }
    }
    // Main file/directory state must settle before reference replay. The
    // two journals use independent UUIDs, so filename order is not a
    // transaction order.
    const orderedJournals: Array<{ name: string; raw: string; references: boolean }> = []
    for (const journalName of group.journals.sort()) {
      const journalAbs = path.join(dir, journalName)
      if (terminalArtifacts.has(path.resolve(journalAbs))) continue
      try {
        const raw = await fs.readFile(journalAbs, 'utf8')
        orderedJournals.push({ name: journalName, raw, references: parseRenameReferencesJournal(raw) !== null })
      } catch (error) {
        note(journalAbs, 'failed', (error as Error).message)
      }
    }
    const recoveryOrder = (candidate: {
      raw: string
      references: boolean
    }): number => {
      if (!candidate.references) return 1
      try {
        const parsed = parseRenameReferenceJournalObject(
          JSON.parse(candidate.raw),
        )
        return parsed?.metadataDisposition?.kind
          === 'folder-snapshot-owner-pending'
          ? 0
          : 2
      } catch {
        return 2
      }
    }
    orderedJournals.sort((a, b) =>
      recoveryOrder(a) - recoveryOrder(b)
      || a.name.localeCompare(b.name))
    for (const { name: journalName, raw: journalRaw } of orderedJournals) {
      const journalAbs = path.join(dir, journalName)
      if (terminalArtifacts.has(path.resolve(journalAbs))) continue
      try {
        if (!await exists(journalAbs)) continue
        const replaceJournal = parseReplaceJournal(journalRaw)
        if (replaceJournal) {
          await recoverReplaceJournal(contentDir, dir, targetAbs, journalAbs, replaceJournal, note)
          continue
        }
        const referencesJournal = parseRenameReferencesJournal(journalRaw)
        if (referencesJournal) {
          await recoverRenameReferencesJournal(contentDir, db, journalAbs, referencesJournal, note)
          continue
        }
        const fileJournal = parseFileRenameJournal(journalRaw)
        if (fileJournal) {
          await recoverFileRenameJournal(contentDir, db, journalAbs, fileJournal, group.rename, note)
          continue
        }
        const folderJournal = parseFolderRenameJournal(journalRaw)
        if (folderJournal) {
          await recoverFolderRenameJournal(contentDir, db, journalAbs, folderJournal, note)
          continue
        }
        // v4 journals are NOT parsed by the legacy parser — they fall through
        // here. Check for v4 explicitly before marking as unrecognized.
        const v4Journal = parseDurableFolderMoveJournalV4(journalRaw)
        if (v4Journal) {
          const srcAbs = path.join(contentDir, v4Journal.srcRel)
          const destAbs = path.join(contentDir, v4Journal.destRel)
          await recoverFolderMoveJournalV4(contentDir, db, journalAbs, v4Journal, srcAbs, destAbs, note)
          continue
        }
        try {
          const rawFolderJournal = JSON.parse(journalRaw)
          if (rawFolderJournal
            && typeof rawFolderJournal === 'object'
            && (rawFolderJournal.op === 'folder-rename'
              || rawFolderJournal.op === 'folder-move')
            && classifyFolderMoveRecoveryStrength(rawFolderJournal).strength
              === 'weak') {
            note(
              journalAbs,
              'quarantined',
              'legacy journal lacks sufficient durable ownership proof',
            )
            continue
          }
        } catch {
          // Fall through to the generic unrecognized-journal report.
        }
        note(journalAbs, 'quarantined', 'unrecognized journal left in place')
      } catch (error) {
        note(journalAbs, 'failed', (error as Error).message)
      }
    }
    // A retained journal means recovery deliberately quarantined an
    // operation as ambiguous/invalid. Its companion artifacts form one
    // recovery set and must not then be consumed by the generic orphan
    // rules below.
    const authoritativeArtifacts = [
      ...group.journals,
      ...group.deleteManifests,
      ...group.quarantineManifests,
    ]
    if (await Promise.all(authoritativeArtifacts.map((name) => exists(path.join(dir, name)))).then((states) => states.some(Boolean))) {
      continue
    }
    // Whatever survived journal processing (or never had a journal) is
    // handled by the orphan rules. Existence is re-checked on disk:
    // journal recovery may already have consumed these files.
    for (const stagedName of group.staged) {
      const stagedAbs = path.join(dir, stagedName)
      if (!await exists(stagedAbs)) continue
      try {
        if (await exists(targetAbs)) {
          note(stagedAbs, 'quarantined', 'staged generation without a journal; target exists, kept for inspection')
        } else {
          const { restored } = await restoreCreateOnly(stagedAbs, targetAbs)
          if (restored) note(targetAbs, 'restored', 'orphaned staged generation restored')
          else note(stagedAbs, 'quarantined', 'orphaned staged generation; target claimed externally')
        }
      } catch (error) {
        note(stagedAbs, 'failed', (error as Error).message)
      }
    }
    for (const removeName of group.remove) {
      const removeAbs = path.join(dir, removeName)
      if (!await exists(removeAbs)) continue
      try {
        if (await exists(targetAbs)) {
          // The bytes were being removed and the path was recreated
          // externally: the staging is stale.
          await rm(removeAbs)
          note(removeAbs, 'cleaned', 'stale removal staging (target recreated)')
        } else {
          // Conservative: an interrupted conditional removal restores
          // the bytes; the removal can be retried by its owner.
          const { restored } = await restoreCreateOnly(removeAbs, targetAbs)
          if (restored) note(targetAbs, 'restored', 'interrupted removal rolled back')
          else note(removeAbs, 'quarantined', 'removal staging; target claimed externally')
        }
      } catch (error) {
        note(removeAbs, 'failed', (error as Error).message)
      }
    }
    for (const saveName of group.save) {
      const saveAbs = path.join(dir, saveName)
      if (!await exists(saveAbs)) continue
      try {
        if (await exists(targetAbs)) {
          await rm(saveAbs)
          note(saveAbs, 'cleaned', 'uncommitted save temp')
        } else {
          note(saveAbs, 'quarantined', 'save temp without a target; kept for inspection')
        }
      } catch (error) {
        note(saveAbs, 'failed', (error as Error).message)
      }
    }
    for (const quarantineName of group.quarantines) {
      const quarantineAbs = path.join(dir, quarantineName)
      if (!await exists(quarantineAbs)) continue
      if (DELETE_INFLIGHT_RE.test(quarantineName)
        && entries.some((entry) => entry.isFile()
          && isRecoveryMarkerName(entry.name, 'journal')
          && JOURNAL_RE.test(entry.name))) {
        // A delete-rollback journal is bound to this staging directory
        // and owns its recovery (completing the restore — files AND
        // the metadata snapshot — or quarantining). This rule stands
        // down while the journal exists, in either group order.
        continue
      }
      try {
        if (DELETE_QUARANTINE_RE.test(quarantineName)) {
          note(quarantineAbs, 'quarantined', 'path-reuse quarantine is never auto-deleted')
          continue
        }
        const isLegacyAmbiguous = DELETE_RE.test(quarantineName)
        const targetExists = await exists(targetAbs)
        if (targetExists || isLegacyAmbiguous) {
          // A public target alongside delete staging proves path reuse.
          // Persist that disposition BEFORE touching identity rows, so a
          // crash can never leave a reusable in-flight name behind. Old
          // timestamp-only names are ambiguous after upgrade and are
          // conservatively promoted even when the target is currently
          // absent; they are never auto-deleted.
          const permanentAbs = path.join(
            dir,
            recoveryMarkerName('quarantine-reuse', group.base, randomUUID()),
          )
          const metaPath = metadataPathFor(vaultRelative(contentDir, targetAbs))
          const stagedStatBefore = await fs.stat(quarantineAbs)
          const legacyIdentities = isLegacyAmbiguous
            ? (stagedStatBefore.isDirectory()
                ? listDocumentMetadata(db).filter((item) => item.path === metaPath || item.path.startsWith(`${metaPath}/`))
                : [getDocumentMetadata(db, metaPath)].filter((item): item is NonNullable<typeof item> => item !== null))
                .map((item) => ({ path: item.path, id: item.id }))
            : []
          // The manifest exists ONLY to keep the old identities durably
          // associated with the quarantined bytes. A metadata-less
          // legacy artifact has nothing to persist — and the parser
          // (rightly) requires identities, so an empty manifest would
          // be unparseable on the next startup: left in place as an
          // "authoritative" artifact, it would block every orphan rule
          // for this basename forever. The bytes are still promoted to
          // the permanent quarantine; only the manifest is skipped.
          if (isLegacyAmbiguous && legacyIdentities.length > 0) {
            const legacyManifestAbs = path.join(
              dir,
              recoveryMarkerName('quarantine-manifest', group.base, randomUUID()),
            )
            await writeDurableJournal(legacyManifestAbs, {
              version: 1,
              op: 'legacy-delete-quarantine',
              path: metaPath,
              quarantine: path.basename(permanentAbs),
              identities: legacyIdentities,
            })
          }
          await fs.rename(quarantineAbs, permanentAbs)
          await syncParentDirectoryBestEffort(permanentAbs)
          if (isLegacyAmbiguous) {
            for (const identity of legacyIdentities) {
              if (getDocumentMetadata(db, identity.path)?.id === identity.id) deleteDocumentMetadata(db, identity.path)
            }
          } else if (targetExists) {
            if (stagedStatBefore.isDirectory()) deleteDocumentMetadataPrefix(db, metaPath)
            else deleteDocumentMetadata(db, metaPath)
          }
          note(permanentAbs, 'quarantined', targetExists
            ? 'delete staging promoted after path reuse; stale identity removed'
            : 'legacy delete staging conservatively promoted')
          continue
        }
        await completeInterruptedDelete(contentDir, db, quarantineAbs, targetAbs, note)
      } catch (error) {
        note(quarantineAbs, 'failed', (error as Error).message)
      }
    }
    for (const renameName of group.rename) {
      const renameAbs = path.join(dir, renameName)
      if (!await exists(renameAbs)) continue
      try {
        await recoverRenameStaging(contentDir, db, dir, group.base, renameAbs, getInodeMap, note)
      } catch (error) {
        note(renameAbs, 'failed', (error as Error).message)
      }
    }
  }
}

async function cleanupOrphanFolderMoveGateMarkers(
  contentDir: string,
  note: (absPath: string, action: RecoveryAction['action'], detail?: string) => void,
): Promise<void> {
  const referencedMarkerNames = new Set<string>()
  const markerPaths: string[] = []
  await walkDirectories(contentDir, async (dir, entries) => {
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      if (isFolderMoveGateMarkerName(entry.name)) {
        markerPaths.push(abs)
      }
      if (!entry.isFile() || !JOURNAL_RE.test(entry.name)) continue
      try {
        const value = JSON.parse(await fs.readFile(abs, 'utf8')) as {
          version?: unknown
          gateProof?: { markerName?: unknown }
        }
        if (value.version === 4
          && isFolderMoveGateMarkerName(value.gateProof?.markerName)) {
          referencedMarkerNames.add(value.gateProof.markerName)
        }
      } catch {
        // Unreadable journals remain authoritative artifacts. Without
        // a trustworthy markerName there is no proof that an otherwise
        // orphaned marker belongs to them.
      }
    }
  })

  for (const markerAbs of markerPaths) {
    const markerName = path.basename(markerAbs)
    if (referencedMarkerNames.has(markerName)) continue
    if (!await isPhysicallyContained(contentDir, path.dirname(markerAbs))) {
      note(markerAbs, 'quarantined', 'orphan folder gate marker parent escapes the vault')
      continue
    }
    try {
      const stat = await fs.lstat(markerAbs)
      if (!stat.isFile() || stat.isSymbolicLink()) {
        note(markerAbs, 'quarantined', 'orphan folder gate marker is not a regular file')
        continue
      }
      await fs.rm(markerAbs, { force: true })
      await syncParentDirectoryBestEffort(markerAbs)
      note(markerAbs, 'cleaned', 'orphan folder gate marker removed')
    } catch (error) {
      note(markerAbs, 'failed', `orphan folder gate marker cleanup failed: ${(error as Error).message}`)
    }
  }
}

/**
 * Reconcile interrupted atomic operations found under `contentDir`.
 * Runs at startup before the HTTP server accepts requests. Never
 * throws; per-item failures are reported in the returned report and
 * left on disk for the next startup (or manual inspection). `db` is
 * used only to reconcile metadata of completed deletes.
 */
export async function recoverInterruptedOperations(
  contentDir: string,
  db: DatabaseT,
): Promise<RecoveryReport> {
  return withVaultMutation(contentDir, async () => {
  await crashRecoveryHooks?.afterRecoveryStarted?.()
  const actions: RecoveryAction[] = []
  const terminalArtifacts = new Set<string>()
  const terminalActionKeys = new Set<string>()
  const note = (absPath: string, action: RecoveryAction['action'], detail?: string): void => {
    if (action === 'failed' || action === 'quarantined') {
      terminalArtifacts.add(path.resolve(absPath))
      const terminalActionKey = JSON.stringify([
        path.resolve(absPath),
        action,
        detail,
      ])
      if (terminalActionKeys.has(terminalActionKey)) return
      terminalActionKeys.add(terminalActionKey)
    }
    actions.push(detail === undefined
      ? { file: vaultRelative(contentDir, absPath), action }
      : { file: vaultRelative(contentDir, absPath), action, detail })
  }
  // Lazy ONE-WALK inode index, built only if a journal-less rename
  // staging artifact needs its link partner (the rename destination)
  // identified. Keyed "dev:ino" → every path carrying that inode.
  let inodeMap: Map<string, string[]> | null = null
  const getInodeMap = async (): Promise<Map<string, string[]>> => {
    if (inodeMap) return inodeMap
    const map = new Map<string, string[]>()
    await walkDirectories(contentDir, async (walkDir, entries) => {
      for (const entry of entries) {
        if (!entry.isFile()) continue
        const abs = path.join(walkDir, entry.name)
        try {
          const stat = await fs.stat(abs)
          const key = `${stat.dev}:${stat.ino}`
          const list = map.get(key)
          if (list) list.push(abs)
          else map.set(key, [abs])
        } catch { /* vanished mid-walk */ }
      }
    })
    inodeMap = map
    return map
  }
  try {
    // Bounded multi-pass reconciliation (round-8 P1/P2). Recovery
    // artifacts form dependency chains — e.g. a reference journal whose
    // companion folder-move journal itself left an inner `.nuvyn-rename-*`
    // `.nuvyn-rename-*`
    // staging: the inner staging must restore before the companion move
    // can complete, which must complete before the reference journal can
    // finish. A fixed two-pass scan cannot close arbitrarily deep chains
    // in one startup. So: loop until a pass makes NO progress, capped by
    // the number of authoritative artifacts present at startup (each
    // pass resolves at least one dependency layer — a tight bound) plus
    // a hard ceiling for safety.
    //
    // Progress = a NEW DISTINCT action. A retained (quarantined) journal
    // is re-noted every pass but produces the SAME action, so it is not
    // progress — counting raw action count would loop to maxPasses
    // whenever any journal is retained. Stop once a whole pass adds
    // nothing new (a fixed point).
    //
    // The artifact count is folded into the FIRST pass's walk (no
    // separate pre-scan): on a slow filesystem the extra walk over
    // thousands of tiny per-seed vaults was the dominant cost.
    const seenActions = new Set<string>()
    let maxPasses = 16
    for (let pass = 0; pass < maxPasses; pass++) {
      inodeMap = null
      const before = actions.length
      let authoritativeArtifacts = 0
      await walkDirectories(contentDir, async (dir, entries) => {
        if (pass === 0) {
          for (const entry of entries) {
            if (!entry.isFile()) {
              if (entry.isDirectory() && DELETE_INFLIGHT_RE.test(entry.name)) authoritativeArtifacts += 1
              continue
            }
            if (JOURNAL_RE.test(entry.name) || DELETE_MANIFEST_RE.test(entry.name)
              || QUARANTINE_MANIFEST_RE.test(entry.name) || RENAME_RE.test(entry.name)
              || STAGED_RE.test(entry.name) || SAVE_RE.test(entry.name) || REMOVE_RE.test(entry.name)) {
              authoritativeArtifacts += 1
            }
          }
        }
        await recoverDirectory(
          contentDir,
          db,
          dir,
          entries,
          getInodeMap,
          note,
          terminalArtifacts,
        )
      })
      // A quarantine can also mean "deferred to a companion artifact".
      // If this pass completed/restored/cleaned anything, let retained
      // artifacts re-evaluate against that new state on the next pass.
      // With no non-terminal progress, failed/quarantined artifacts are
      // terminal for this invocation and remain skipped.
      if (actions.slice(before).some((action) =>
        action.action !== 'failed' && action.action !== 'quarantined')) {
        terminalArtifacts.clear()
      }
      // +4 gives headroom for the deepest plausible chain plus the
      // final no-progress detection pass; hard ceiling guards cycles.
      if (pass === 0) maxPasses = Math.min(Math.max(maxPasses, authoritativeArtifacts + 4), 64)
      let progressed = false
      for (let i = before; i < actions.length; i++) {
        const key = JSON.stringify(actions[i])
        if (!seenActions.has(key)) {
          seenActions.add(key)
          progressed = true
        }
      }
      if (!progressed) break
    }
    await cleanupOrphanFolderMoveGateMarkers(contentDir, note)
  } catch (error) {
    note(contentDir, 'failed', (error as Error).message)
  }
  return { actions }
  })
}

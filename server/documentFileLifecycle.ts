import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Database as DatabaseT } from 'better-sqlite3'
import { getDocumentMetadata, moveDocumentMetadataReplacingDestination } from './documentMetadata.js'
import {
  renameWithTransientWindowsRetry,
  restoreStagedGeneration,
  syncParentDirectoryBestEffort,
  sha256Hex,
  sha256HexBuffer,
  removeDurableJournal,
  writeDurableJournal,
  verifyDirectoryGeneration,
} from './atomicTextWrite.js'
import type { FolderMoveJournalEntry, FolderMoveJournalEntryV4 } from './folderMoveTransaction.js'
import {
  captureDurableDirectoryIdentity,
  matchesDurableDirectoryIdentity,
  type DurableDirectoryIdentity,
} from './durableDirectoryIdentity.js'
import { recoveryMarkerName } from './technicalNamespace.js'

/** Test-only hooks for the create-only move race/crash windows. Null
 * in production; tests reset in finally. `afterMkdirGate` fires right
 * after the destination gate directory is created (the window in which
 * external content can land inside it); `afterRenameLinked` fires after
 * the destination link lands but before the staging name is removed
 * (the window a kill -9 leaves two names on one inode). The replayable
 * directory-move hooks mirror those seams for the per-file protocol. */
export type CreateOnlyMoveHooks = {
  afterMkdirGate?: (toDirAbs: string) => void | Promise<void>
  afterRenameTakenOver?: (stagingPath: string) => void | Promise<void>
  afterRenameLinked?: () => void | Promise<void>
  /** Fires after the staging name is gone but before metadata moves. */
  afterFileMoveFinalized?: () => void | Promise<void>
  /** Fires right after the replayable directory move's mkdir gate is
   * created, before any entry has moved. */
  afterReplayableGate?: (toDirAbs: string) => void | Promise<void>
  /** Fires after each per-file move of a replayable directory move
   * lands at the destination — the crash window that leaves the tree
   * split between source and destination. */
  afterReplayableMovedEntry?: (entryRel: string) => void | Promise<void>
  /** Fires after exact final parity passes but BEFORE the metadata
   * transaction is committed — round-10 F5 crash window. */
  afterParityBeforeMetadata?: (toDirAbs: string) => void | Promise<void>
  /** Fires after the metadata transaction has committed but BEFORE the
   * owned gate token is removed and the durable journal is cleared —
   * round-10 F5 crash window. A kill here must still leave recovery
   * able to complete forward (token + journal both present, metadata
   * already at destination). */
  afterMetadataBeforeTokenRemoval?: (toDirAbs: string) => void | Promise<void>
  // ===== round-11 v4 phase seams =====
  /** Fires immediately after `createDestinationGate` succeeds on the
   * forward path. The journal's phase=prepared has been written; the
   * route rewrites phase=gate-created next. */
  afterGateCreated?: (toDirAbs: string, generation: { dev: string; ino: string }) => void | Promise<void>
  /** Fires after an atomic directory rename has landed, before the
   * destination generation/stat, parity, or files-landed rewrite. */
  afterAtomicRenameBeforeParity?: (
    sourceAbs: string,
    destinationAbs: string,
  ) => void | Promise<void>
  /** Fires after the v4 exact parity passes, just before the route
   * commits metadata and rewrites phase=files-landed. */
  afterFilesLanded?: (toDirAbs: string) => void | Promise<void>
  /** Fires after metadata has been committed, just before the route
   * rewrites phase=metadata-committed and removes the journal. A
   * kill here must still leave recovery able to complete the commit
   * (dest dir's (dev,ino) + per-entry (dev,ino,hash) match; metadata
   * already at destination). */
  afterMetadataCommitted?: (toDirAbs: string) => void | Promise<void>
  /** Reverse path: after the destination gate for the reverse move
   * has been created and the journal's phase=gate-created rewritten. */
  afterReverseGateCreated?: (toDirAbs: string) => void | Promise<void>
  /** Reverse path: after the first reverse file has landed. */
  afterReverseFirstEntry?: (entryRel: string) => void | Promise<void>
  /** Reverse path: after v4 exact parity on the reverse move passes. */
  afterReverseParity?: (toDirAbs: string) => void | Promise<void>
  /** Reverse path: after files-landed is durable and immediately
   * before the journal-declared metadata CAS begins. */
  beforeReverseMetadataRestore?: (toDirAbs: string) => void | Promise<void>
  /** Reverse path: after the reverse metadata restore has run. */
  afterReverseMetadata?: (toDirAbs: string) => void | Promise<void>
  /** Reverse path: metadata is complete, but the shared final verifier
   * has not yet re-proved directory generation and exact parity. */
  afterReverseMetadataBeforeFinalVerify?: (toDirAbs: string) => void | Promise<void>
  /** Reverse path: after the reverse journal's phase=metadata-committed
   * has been rewritten, just before the route removes the journal. */
  beforeReverseJournalRemove?: (toDirAbs: string) => void | Promise<void>
  /** Reverse path: the owner folder journal is gone and its metadata
   * handoff is durable, but the dependent reference journal and payloads
   * have not yet been cleaned. */
  afterReverseOwnerCleanupBeforeReferenceCleanup?: (
    toDirAbs: string,
  ) => void | Promise<void>
}
let __createOnlyMoveHooks: CreateOnlyMoveHooks | null = null
export function __setCreateOnlyMoveHooksForTesting(hooks: CreateOnlyMoveHooks | null): void {
  __createOnlyMoveHooks = hooks
}
/** Read-only access to the current test hook bag. Production code
 * never installs hooks; only the test fixtures and the routes'
 * post-`if (renamed)` blocks inspect the bag to fire per-phase crash
 * seams (round-11 v4: afterGateCreated, afterFilesLanded,
 * afterMetadataCommitted, etc.). */
export function getCreateOnlyMoveHooksForTesting(): CreateOnlyMoveHooks | null {
  return __createOnlyMoveHooks
}

/** Internal: notify the per-entry crash seam. Both the mover AND the
 * recovery replay loop call it, so a crash child can pause at the same
 * seam whether the move runs in the route or at startup recovery
 * (the "kill recovery mid-replay" point). No-op in production. */
export async function fireReplayableMovedEntryHook(entryRel: string): Promise<void> {
  if (__createOnlyMoveHooks?.afterReplayableMovedEntry) await __createOnlyMoveHooks.afterReplayableMovedEntry(entryRel)
}

/** The move destination was claimed by an external writer. The source
 * was restored (or quarantined if it too was re-used); nothing was
 * overwritten. Callers map this to a retryable conflict. */
export class RenameDestinationOccupiedError extends Error {
  constructor(destinationPath: string) {
    super(`rename destination already exists: ${destinationPath}`)
    this.name = 'RenameDestinationOccupiedError'
  }
}

/** A rolled-back rename could not return to its original path because
 * an external writer re-used it. The bytes were NOT overwritten — they
 * stayed at the rename destination (or, pathologically, quarantined
 * under a staging name). Callers must keep the identity with the bytes
 * instead of restoring it onto the external file. */
export class RenameSourceReusedError extends Error {
  readonly stagingPath?: string
  readonly survivingPath: 'staging' | 'destination'
  readonly sourceReused = true
  readonly destinationOccupied: boolean
  readonly journalPath?: string
  constructor(sourcePath: string, disposition: {
    stagingPath?: string
    survivingPath?: 'staging' | 'destination'
    destinationOccupied?: boolean
    journalPath?: string
  } = {}) {
    super(`rename rollback: source path re-used externally: ${sourcePath}`)
    this.name = 'RenameSourceReusedError'
    this.stagingPath = disposition.stagingPath
    this.survivingPath = disposition.survivingPath ?? 'destination'
    this.destinationOccupied = disposition.destinationOccupied ?? false
    this.journalPath = disposition.journalPath
  }
}

/** The filesystem cannot perform create-only moves (link(2) is
 * rejected with EPERM/EOPNOTSUPP/ENOTSUP — e.g. a link-incapable
 * filesystem). Every touched path was restored; nothing was moved.
 * Callers map this to a clear 501: a check-then-rename fallback would
 * reintroduce the exact external-overwrite race the create-only
 * protocol exists to prevent. */
export class UnsupportedDirectoryMoveError extends Error {
  readonly unsupportedMove = true
  constructor(detail: string, options?: { cause?: unknown }) {
    super(`unsupported create-only directory move: ${detail}`)
    this.name = 'UnsupportedDirectoryMoveError'
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause
  }
}

/** The bytes about to be moved (or already moved) do not match the
 * journaled generation. The recovery/replay path proves this BEFORE
 * any reverse syscall — moving a foreign file under a Nuvyn identity
 * is the exact hole round-10 closes. The owner of the bytes (Nuvyn
 * staging vs external) is preserved; nothing was overwritten. */
export class GenerationMismatchError extends Error {
  readonly generationMismatch = true
  readonly path: string
  readonly expected: { dev: string; ino: string; hash: string }
  readonly actual: { dev: string; ino: string; hash: string } | null
  /** round-11 F6: when the post-takeover re-check restores the foreign
   * replacement, this is the result of that restore. `true` means the
   * bytes are quarantined under the staging name (the source was
   * re-used externally between the takeover and the restore attempt);
   * `false` means the bytes were successfully re-published create-
   * only back to the source path. */
  readonly restored: { quarantined: boolean } | null
  constructor(
    path: string,
    expected: { dev: string; ino: string; hash: string },
    actual: { dev: string; ino: string; hash: string } | null,
    restored: { quarantined: boolean } | null = null,
  ) {
    super(`generation mismatch at ${path}: expected ${expected.dev}:${expected.ino}/${expected.hash.slice(0, 8)} but found ${actual ? `${actual.dev}:${actual.ino}/${actual.hash.slice(0, 8)}` : 'missing'}`)
    this.name = 'GenerationMismatchError'
    this.path = path
    this.expected = expected
    this.actual = actual
    this.restored = restored
  }
}

/** A generation that a Nuvyn-owned move can be required to prove —
 * content hash, device id, and inode — before its syscall runs. Hash
 * alone is insufficient (byte-identical external replacement gets a
 * fresh inode). The trio is persisted in the v3 journal. */
export type ExpectedGeneration = {
  dev: string
  ino: string
  hash: string
}

/** Read the current generation of a file for callers that need to
 * compare against an ExpectedGeneration. null when missing. */
async function readGeneration(absPath: string): Promise<ExpectedGeneration | null> {
  try {
    const buf = await fs.readFile(absPath)
    const stat = await fs.stat(absPath, { bigint: true })
    return {
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      hash: sha256HexBuffer(buf),
    }
  } catch {
    return null
  }
}

const LINK_INCAPABLE_CODES = new Set(['EPERM', 'EOPNOTSUPP', 'ENOTSUP'])

/**
 * Move a file WITHOUT ever replacing a generation we do not own:
 *
 *   1. take the source aside to a private staging path (ownership of
 *      the source bytes is now ours alone);
 *   2. when `expectedSource` is provided, VERIFY the staging bytes
 *      still match the journaled (dev, ino, hash) — round-10 F1. A
 *      byte-identical external replacement has a fresh inode; the
 *      hard-link would carry that inode into the destination as
 *      "ours" unless the trio is checked;
 *   3. link(2) the staging into the destination — create-only: if an
 *      external writer claimed the destination, EEXIST fails the move
 *      closed and the source is restored (itself create-only, so a
 *      re-used source quarantines the bytes instead of clobbering);
 *   4. unlink the staging name; the inode now has exactly one name.
 *
 * POSIX rename(2) atomically REPLACES an existing target, so a plain
 * "does the destination exist?" check at the route layer can never
 * protect external editors (Obsidian/vim/sync software ignore our
 * in-process locks). link(2) is its create-only counterpart. Both
 * paths are inside the vault, i.e. on one filesystem. A link-incapable
 * filesystem (EPERM/EOPNOTSUPP/ENOTSUP) fails closed after restoring
 * the source: a check-then-rename fallback would reintroduce the exact
 * external-overwrite race this primitive exists to prevent.
 */
export async function createOnlyMoveFile(
  fromAbs: string,
  toAbs: string,
  options: {
    preparedStagingPath?: string
    /** round-10/11: when provided, the bytes about to be moved MUST
     * still match this generation (dev + ino + hash). A mismatch —
     * detected either BEFORE the takeover rename (the cheap pre-check)
     * or AFTER the takeover (the post-takeover re-check that catches a
     * race-window external replacement) — throws
     * GenerationMismatchError. The source is restored create-only
     * (F6 round-11: the foreign replacement never hides in staging). */
    expectedSource?: ExpectedGeneration
  } = {},
): Promise<void> {
  const stagedPath = options.preparedStagingPath ?? path.join(
    path.dirname(fromAbs),
    recoveryMarkerName('rename', path.basename(fromAbs), randomUUID()),
  )

  // round-11 F6 + round-10 F1: PRE-CHECK. This is the cheap, race-free
  // observation: if the source is already not the journaled generation
  // before we touch anything, throw immediately and leave the source
  // untouched. This is NOT a TOCTOU guarantee on its own — the post-
  // takeover re-check below is the only safe one — but it lets obvious
  // mismatches fail without ever moving the file aside.
  if (options.expectedSource) {
    const before = await readGeneration(fromAbs)
    if (!generationMatches(before, options.expectedSource)) {
      throw new GenerationMismatchError(fromAbs, options.expectedSource, before)
    }
  }

  await renameWithTransientWindowsRetry(fromAbs, stagedPath)
  if (__createOnlyMoveHooks?.afterRenameTakenOver) await __createOnlyMoveHooks.afterRenameTakenOver(stagedPath)

  // round-11 F6: POST-TAKEOVER RE-CHECK. The pre-check above is not
  // enough: between the pre-check and the rename, an external writer
  // could unlink our source and create a fresh inode with the same
  // bytes (a byte-identical replacement). The staging inode now holds
  // the foreign replacement, not our bytes. Prove the staging
  // generation matches the journal — if not, the foreign replacement
  // is restored create-only back to the source path (which the
  // external writer may have re-used in the meantime; if so, the
  // bytes stay quarantined under the staging name rather than
  // clobbering either side).
  if (options.expectedSource) {
    const stagedGeneration = await readGeneration(stagedPath)
    if (!generationMatches(stagedGeneration, options.expectedSource)) {
      const restored = await restoreStagedGeneration(stagedPath, fromAbs)
      throw new GenerationMismatchError(fromAbs, options.expectedSource, stagedGeneration, restored)
    }
  }

  try {
    await fs.link(stagedPath, toAbs)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EPERM' || code === 'EOPNOTSUPP' || code === 'ENOTSUP') {
      const { quarantined } = await restoreStagedGeneration(stagedPath, fromAbs)
      if (quarantined) {
        throw new RenameSourceReusedError(fromAbs, {
          stagingPath: stagedPath,
          survivingPath: 'staging',
          destinationOccupied: await fs.stat(toAbs).then(() => true, () => false),
        })
      }
      if (await fs.stat(toAbs).then(() => true, () => false)) throw new RenameDestinationOccupiedError(toAbs)
      throw error
    }
    if (code === 'EEXIST') {
      const { quarantined } = await restoreStagedGeneration(stagedPath, fromAbs)
      throw quarantined ? new RenameSourceReusedError(fromAbs, { stagingPath: stagedPath, survivingPath: 'staging', destinationOccupied: true }) : new RenameDestinationOccupiedError(toAbs)
    }
    const { quarantined } = await restoreStagedGeneration(stagedPath, fromAbs)
    if (quarantined) {
      throw new RenameSourceReusedError(fromAbs, {
        stagingPath: stagedPath,
        survivingPath: 'staging',
        destinationOccupied: false,
      })
    }
    throw error
  }
  if (__createOnlyMoveHooks?.afterRenameLinked) await __createOnlyMoveHooks.afterRenameLinked()
  await fs.rm(stagedPath, { force: true })
  await syncParentDirectoryBestEffort(toAbs)
}

/** True iff `actual` (dev, ino, hash) all equal `expected`. A missing
 * `actual` is NEVER a match. */
function generationMatches(
  actual: ExpectedGeneration | null,
  expected: ExpectedGeneration,
): boolean {
  return actual !== null
    && actual.dev === expected.dev
    && actual.ino === expected.ino
    && actual.hash === expected.hash
}

/** How a directory move is executed. POSIX gets the single-syscall
 * atomic rename; Windows cannot replace a directory with rename(2) —
 * even an empty one — and gets the journaled per-file replay instead. */
export type DirectoryMoveStrategy = 'atomic-rename' | 'replayable-move'

/** The strategy value PERSISTED in the folder-move journal. It is the
 * runtime strategy itself: routes, the recovery parser, and the crash
 * fixtures all import this ONE type, so the persisted value can never
 * drift away from what the mover and the parser understand. (Round-7
 * P0: the route persisted 'replayable-move'/'atomic-rename' while the
 * parser only accepted 'replayable'/'atomic' — every real journal was
 * unparseable and its recovery could never run.) */
export type FolderMoveJournalStrategy = DirectoryMoveStrategy
export const FOLDER_MOVE_STRATEGIES: readonly FolderMoveJournalStrategy[] = ['atomic-rename', 'replayable-move']

export const platformDirectoryMoveStrategy: DirectoryMoveStrategy = process.platform === 'win32' ? 'replayable-move' : 'atomic-rename'

let __directoryMoveStrategyOverride: DirectoryMoveStrategy | null = null
/** Test-only seam: force the Windows replayable protocol on POSIX so
 * crash children can exercise the journaled per-file path the real
 * HTTP route persists — through the route itself, not a copy. Null in
 * production. */
export function __setDirectoryMoveStrategyOverrideForTesting(strategy: DirectoryMoveStrategy | null): void {
  __directoryMoveStrategyOverride = strategy
}
export function resolveDirectoryMoveStrategy(): DirectoryMoveStrategy {
  return __directoryMoveStrategyOverride ?? platformDirectoryMoveStrategy
}

async function listRegularFileEntries(fromDirAbs: string): Promise<string[]> {
  const entries: string[] = []
  const walk = async (dirAbs: string, rel: string): Promise<void> => {
    const dirents = await fs.readdir(dirAbs, { withFileTypes: true })
    for (const entry of dirents) {
      const entryRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) await walk(path.join(dirAbs, entry.name), entryRel)
      else if (entry.isFile()) entries.push(entryRel)
      // A symlink/junction or special entry cannot be moved create-only
      // (link(2) would FOLLOW it outside the tree): fail closed. The
      // caller restores every already-moved entry before reporting.
      else throw new UnsupportedDirectoryMoveError(`unsupported entry inside the moved folder: ${entryRel}`)
    }
  }
  await walk(fromDirAbs, '')
  entries.sort()
  return entries
}

/** Remove empty directories bottom-up; anything non-empty stays. A
 * failed rmdir simply leaves the directory — it is external property. */
export async function pruneEmptyDirectories(dirAbs: string): Promise<void> {
  let dirents
  try {
    dirents = await fs.readdir(dirAbs, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of dirents) {
    if (entry.isDirectory()) await pruneEmptyDirectories(path.join(dirAbs, entry.name))
  }
  await fs.rmdir(dirAbs).catch(() => {})
}

/**
 * Remove only directory shells explicitly declared by a durable manifest.
 * Undeclared (even empty) directories are external state and are untouched.
 *
 * The optional `directoryGenerations` parameter carries the captured
 * dev/ino of every declared directory at journal write time. Removal
 * proceeds bottom-up only when:
 *
 *   (1) every declared directory still matches its journaled generation,
 *   (2) it is empty, and
 *   (3) it is a real directory (not a symlink/junction/special entry).
 *
 * When the journaled generation mismatches the on-disk generation the
 * helper reports the conflict and skips removal — the directory is
 * external state, NOT ours to remove.
 */
export async function removeDeclaredEmptyDirectories(
  rootAbs: string,
  declaredDirectories: readonly string[],
  options: {
    removeRoot?: boolean
    expectedRootGeneration?: DurableDirectoryIdentity
    directoryGenerations?: Array<{
      relativeDirectoryPath: string
      sourceDev: string
      sourceIno: string
      sourceBirthtimeNs?: string
    }>
  } = {},
): Promise<{
  removed: string[]
  retained: string[]
  conflict: string[]
  rootRemoved: boolean
}> {
  const declaredSet = new Set([...new Set(declaredDirectories)])
  const expectedGen = new Map<string, DurableDirectoryIdentity>()
  for (const entry of options.directoryGenerations ?? []) {
    if (!entry.sourceBirthtimeNs) continue
    expectedGen.set(entry.relativeDirectoryPath, {
      dev: entry.sourceDev,
      ino: entry.sourceIno,
      birthtimeNs: entry.sourceBirthtimeNs,
    })
  }
  const removed: string[] = []
  const retained: string[] = []
  const conflict: string[] = []
  const ordered = [...declaredSet].sort((left, right) => {
    const depth = right.split('/').length - left.split('/').length
    return depth || (left < right ? -1 : left > right ? 1 : 0)
  })
  for (const relative of ordered) {
    const directoryAbs = path.join(rootAbs, relative)
    let stat: import('fs').BigIntStats
    try {
      stat = await fs.lstat(directoryAbs, { bigint: true })
    } catch {
      // The replayable protocol keeps source shells until the durable
      // files-landed phase. Absence therefore cannot be attributed to
      // this transaction and is an ownership conflict.
      conflict.push(relative)
      continue
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      conflict.push(relative)
      continue
    }
    const expected = expectedGen.get(relative)
    if (!expected || !matchesDurableDirectoryIdentity(stat, expected)) {
      conflict.push(relative)
      continue
    }
    try {
      if ((await fs.readdir(directoryAbs)).length !== 0) {
        retained.push(relative)
        continue
      }
      await fs.rmdir(directoryAbs)
      removed.push(relative)
    } catch {
      retained.push(relative)
    }
  }
  let rootRemoved = false
  if (options.removeRoot) {
    try {
      const stat = await fs.lstat(rootAbs, { bigint: true })
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        retained.push('')
      } else if (options.expectedRootGeneration
        && !matchesDurableDirectoryIdentity(
          stat,
          options.expectedRootGeneration,
        )) {
        conflict.push('')
      } else if ((await fs.readdir(rootAbs)).length !== 0) {
        retained.push('')
      } else {
        await fs.rmdir(rootAbs)
        rootRemoved = true
      }
    } catch {
      if (options.expectedRootGeneration) conflict.push('')
      else retained.push('')
    }
  }
  return { removed, retained, conflict, rootRemoved }
}

/** Relative subdirectory paths under dirAbs (excluding the root
 * itself), for destination directory-set parity. Symlinked directories
 * are rejected like the file walk rejects symlinked files. */
async function listDirectoryEntries(fromDirAbs: string): Promise<string[]> {
  const directories: string[] = []
  const walk = async (dirAbs: string, rel: string): Promise<void> => {
    const dirents = await fs.readdir(dirAbs, { withFileTypes: true })
    for (const entry of dirents) {
      const entryRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) {
        directories.push(entryRel)
        await walk(path.join(dirAbs, entry.name), entryRel)
      } else if (!entry.isFile()) {
        throw new UnsupportedDirectoryMoveError(`unsupported entry inside the moved folder: ${entryRel}`)
      }
    }
  }
  await walk(fromDirAbs, '')
  directories.sort()
  return directories
}

/**
 * Physical vault containment (round-6 F4, extended round-8 to every
 * per-entry path). A resolved string can stay inside the vault while
 * the FILESYSTEM path escapes it: with `vault/proj/sub → /outside`,
 * `vault/proj/sub/victim.bin` resolves to a string under the vault but
 * accesses a file outside it. Every journal-driven filesystem touch
 * (hash read, mkdir, rename, link — which also creates its private
 * staging in the source's parent) must first prove no ancestor below
 * the vault root is a symlink (Windows junction / reparse point reports
 * as a symlink under lstat). The leaf itself is checked too, because a
 * create-only link would FOLLOW a symlinked leaf into an external
 * inode. A missing leaf is contained.
 */
export async function isPhysicallyContained(vaultRoot: string, candidateAbs: string): Promise<boolean> {
  const root = path.resolve(vaultRoot)
  const resolved = path.resolve(candidateAbs)
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return false
  let current = path.dirname(resolved)
  while (current.length > root.length) {
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) return false
    } catch {
      // A missing ancestor cannot be a symlink we'd escape through —
      // the mover/recovery creates it with mkdir -p as a real
      // directory. Keep walking up to check the ancestors that DO
      // exist (a symlinked grandparent is still caught).
    }
    current = path.dirname(current)
  }
  try {
    if ((await fs.lstat(resolved)).isSymbolicLink()) return false
  } catch {
    /* an absent leaf is contained */
  }
  return true
}

/** Hidden marker the replayable mover drops inside the destination
 * gate it created. Recovery treats a destination directory as "provably
 * ours" only when it finds this exact token — an empty directory alone
 * is NOT ownership proof (round-8 P1/P3). */
export const GATE_TOKEN_PREFIX = '.nuvyn-folder-gate-'
export function gateTokenName(gateToken: string): string {
  return recoveryMarkerName('folder-gate', '', gateToken)
}


/**
 * The REPLAYABLE directory move: the Windows-compatible create-only
 * protocol. rename(2) cannot replace a directory on Windows (even an
 * empty one), so the tree is moved one file at a time instead:
 *
 *   1. mkdir(destination) — the same create-only gate as the atomic
 *      protocol; EEXIST means an external writer claimed it;
 *   2. EXACTLY the journaled entries move create-only (staging +
 *      link(2)) under their relative paths, parents created on demand;
 *   3. the destination is parity-checked against the entry list;
 *   4. the emptied source directories are pruned bottom-up.
 *
 * The move is replayable, not atomic: a crash between per-file moves
 * leaves the tree SPLIT between source and destination. The caller
 * writes a durable folder-move journal whose `entries` ARE the list
 * passed here BEFORE calling (see server/folderMoveTransaction.ts and
 * server/routes/folders.ts); startup crash recovery replays the
 * remaining entries from the same list — the journal is the proof that
 * decides the split. Moving ONLY the journaled set is what makes the
 * journal authoritative: a file added to the source by an external
 * writer after the journal was written simply stays at the source
 * (never lost, never split), and the destination parity check fails
 * closed if anything external lands inside the gate mid-move.
 *
 * Any external writer winning a destination path fails the WHOLE move
 * closed: every already-moved entry is rolled back create-only (a
 * re-used source path keeps its bytes at the destination instead of
 * clobbering the external file) and the gate tree is pruned.
 */
export type FolderMoveExecuteOptions = {
  /** Every subdirectory the journal declared (including empty ones);
   * created at the destination and verified by the end parity. */
  directories?: string[]
  /** Transaction token; when present the mover drops a hidden gate
   * marker inside the destination gate it creates, so recovery can tell
   * its own gate from an externally-created empty directory. */
  gateToken?: string
  /** The unpredictable gate-token secret (v3) persisted in the journal.
   * Written into the gate marker file so recovery can verify the exact
   * bytes, not just the filename (round-9 F2). */
  gateTokenValue?: string
  /** Vault root; when present every per-entry source AND destination
   * path is physically containment-checked (no symlinked ancestor)
   * before it is hashed/mkdir/renamed/linked (round-8 P0/P1). Also
   * passed through to rollback so compensation moves are contained
   * (round-9 F5). */
  vaultRoot?: string
  /** The full journal entries (with sourceHash and sourceDev/sourceIno)
   * for exact final parity verification — file set equality, per-file
   * content hash, and landed generation identity (round-9 F3). */
  entries?: readonly FolderMoveJournalEntry[]
  /** Exact root-relative paths excluded from parity. No prefixes,
   * descendants, or other hidden files are implicitly ignored. */
  ignoredRelativePaths?: readonly string[]
}

export async function executeReplayableFolderMove(
  fromDirAbs: string,
  toDirAbs: string,
  entryRels: string[],
  options: FolderMoveExecuteOptions = {},
): Promise<{ restored: boolean; parityPassed?: boolean }> {
  const directories = options.directories ?? []
  const vaultRoot = options.vaultRoot
  try {
    await fs.mkdir(toDirAbs)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST' || code === 'ENOTDIR') return { restored: false }
    throw error
  }
  // Prove the gate is ours for recovery: drop the hidden marker before
  // anything else lands inside it. v3 (round-9 F2): the marker carries
  // the unpredictable gateTokenValue (persisted in the journal) so
  // recovery can verify the exact bytes, not just the filename.
  if (options.gateToken) {
    const tokenPath = path.join(toDirAbs, gateTokenName(options.gateToken))
    if (vaultRoot && !await isPhysicallyContained(vaultRoot, tokenPath)) {
      await fs.rmdir(toDirAbs).catch(() => {})
      throw new UnsupportedDirectoryMoveError(`gate token path escapes the vault: ${gateTokenName(options.gateToken)}`)
    }
    // O_CREAT | O_EXCL | O_WRONLY — create-only; EEXIST means an
    // external writer planted the exact token name first.
    try {
      const fh = await fs.open(tokenPath, 'wx')
      try {
        await fh.writeFile(options.gateTokenValue ?? '', 'utf8')
        await fh.sync()
      } finally {
        await fh.close()
      }
      await syncParentDirectoryBestEffort(tokenPath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST') {
        await fs.rmdir(toDirAbs).catch(() => {})
        return { restored: false }
      }
      throw error
    }
  }
  if (__createOnlyMoveHooks?.afterReplayableGate) await __createOnlyMoveHooks.afterReplayableGate(toDirAbs)
  const entryByRel = new Map((options.entries ?? []).map((e) => [e.relativeFilePath, e]))
  /** Owned gate-token removal (round-10 F3): read+stat+content-match
   * the marker file before unlinking. An external writer who replaced
   * our token is detected; the journal stays so recovery can re-prove
   * destination ownership later. */
  const removeOwnedGateToken = async (): Promise<void> => {
    if (!options.gateToken) return
    const tokenPath = path.join(toDirAbs, gateTokenName(options.gateToken))
    if (vaultRoot && !await isPhysicallyContained(vaultRoot, tokenPath)) return
    try {
      const buf = await fs.readFile(tokenPath, 'utf8')
      if (buf !== (options.gateTokenValue ?? '')) return
      await fs.unlink(tokenPath)
    } catch {
      // missing or unreadable — leave the marker on disk
    }
  }
  const moved: string[] = []
  // Roll back every landed entry create-only with per-entry containment
  // (round-9 F5) AND per-entry destination generation verification
  // (round-10 F2): the destination bytes must still match the
  // journaled (dev, ino, hash) — an external writer who replaced a
  // landed file between forward move and rollback must NOT see its
  // bytes carried back to the source. The bytes stay at the
  // destination; the journal stays so recovery can reconcile.
  const rollbackMoved = async (): Promise<boolean> => {
    let rollbackFailed = false
    for (const entryRel of [...moved].reverse()) {
      const fromEntry = path.join(toDirAbs, entryRel)
      const toEntry = path.join(fromDirAbs, entryRel)
      if (vaultRoot) {
        if (!await isPhysicallyContained(vaultRoot, fromEntry) || !await isPhysicallyContained(vaultRoot, toEntry)) {
          throw new UnsupportedDirectoryMoveError(
            `rollback containment failed for ${entryRel}: an external symlink or junction would escape the vault`,
          )
        }
      }
      // Round-10 F2: prove the landed bytes are STILL the journaled
      // generation BEFORE rolling them back. If an external writer
      // replaced the file (different inode, even with the same hash),
      // do NOT move those bytes back to the source — keep them where
      // they are, mark the rollback as failed, and let the journal
      // stay so recovery decides.
      const journalEntry = entryByRel.get(entryRel)
      if (journalEntry?.sourceDev && journalEntry?.sourceIno && journalEntry?.sourceHash) {
        const actual = await readGeneration(fromEntry)
        if (!actual
          || actual.dev !== journalEntry.sourceDev
          || actual.ino !== journalEntry.sourceIno
          || actual.hash !== journalEntry.sourceHash) {
          // External generation at the destination path: do not move
          // it. The rollback fails closed at this entry; remaining
          // entries are still reversed below.
          rollbackFailed = true
          continue
        }
      }
      try {
        await createOnlyMoveFile(fromEntry, toEntry)
      } catch {
        rollbackFailed = true
      }
    }
    await removeOwnedGateToken()
    await pruneEmptyDirectories(toDirAbs)
    return rollbackFailed
  }
  try {
    // Recreate the journaled directory structure first.
    for (const dirRel of directories) {
      const dirAbs = path.join(toDirAbs, dirRel)
      if (vaultRoot && !await isPhysicallyContained(vaultRoot, dirAbs)) {
        throw new UnsupportedDirectoryMoveError(`directory path escapes the vault: ${dirRel}`)
      }
      await fs.mkdir(dirAbs, { recursive: true })
    }
    for (const entryRel of entryRels) {
      const entryFromAbs = path.join(fromDirAbs, entryRel)
      const entryToAbs = path.join(toDirAbs, entryRel)
      if (vaultRoot
        && (!await isPhysicallyContained(vaultRoot, entryFromAbs)
          || !await isPhysicallyContained(vaultRoot, entryToAbs))) {
        throw new UnsupportedDirectoryMoveError(`entry path escapes the vault: ${entryRel}`)
      }
      await fs.mkdir(path.dirname(entryToAbs), { recursive: true })
      // Round-10 F1: pass the journaled generation so createOnlyMoveFile
      // proves the source bytes still match before the link(2).
      const journalEntry = entryByRel.get(entryRel)
      const expectedSource = journalEntry?.sourceDev && journalEntry?.sourceIno && journalEntry?.sourceHash
        ? { dev: journalEntry.sourceDev, ino: journalEntry.sourceIno, hash: journalEntry.sourceHash }
        : undefined
      await createOnlyMoveFile(entryFromAbs, entryToAbs, { expectedSource })
      moved.push(entryRel)
      await fireReplayableMovedEntryHook(entryRel)
    }
  } catch (error) {
    const rollbackFailed = await rollbackMoved()
    const code = (error as NodeJS.ErrnoException).code
    if (code && LINK_INCAPABLE_CODES.has(code)) {
      throw new UnsupportedDirectoryMoveError(
        `filesystem rejected a create-only file link (${code})${rollbackFailed ? '; rollback is incomplete — inspect the destination residue' : ''}`,
        { cause: error },
      )
    }
    if (error instanceof UnsupportedDirectoryMoveError) throw error
    if (!rollbackFailed && (error instanceof RenameDestinationOccupiedError || code === 'EEXIST' || code === 'ENOTDIR')) {
      return { restored: false }
    }
    throw error
  }
  // Exact final parity (round-9 F3): shared by mover AND recovery.
  // Must verify file-set equality, per-file content hash, directory-set
  // equality, and exact gate-token content. Any mismatch fails closed:
  // do NOT move metadata, do NOT remove the journal, do NOT roll
  // unverified destination bytes back to source.
  const parityFailed = await verifyExactParity(toDirAbs, options)
  if (parityFailed) {
    const rollbackFailed = await rollbackMoved()
    if (rollbackFailed) {
      throw new Error('exact parity failed and the rollback was incomplete')
    }
    return { restored: false }
  }
  // Clean up the empty source tree before the crash seam so a killed
  // process leaves the vault without the stale source directory. The
  // gate marker stays — recovery needs it to prove destination
  // ownership. External content that landed in the source during the
  // move is untouched (directories stay non-empty).
  await pruneEmptyDirectories(fromDirAbs)
  // Crash seam: after parity passes but BEFORE the metadata transaction
  // runs (round-10 F5, first window). A kill here leaves the
  // destination provably ours (token + journaled entries both present)
  // and the metadata still at the source — recovery will replay and
  // commit metadata forward.
  if (__createOnlyMoveHooks?.afterParityBeforeMetadata) await __createOnlyMoveHooks.afterParityBeforeMetadata(toDirAbs)
  // The route commits metadata AFTER this point (between the two seams
  // wired in the route layer — see FolderRaceHooks.afterMetadataBeforeTokenRemoval),
  // then calls finalizeReplayableFolderMove which fires the second seam,
  // removes the owned gate token, and syncs.
  return { restored: true, parityPassed: true }
}

/** Round-10 F5 finalizer: the route calls this AFTER the metadata
 * transaction commits. Fires the second crash seam, removes the owned
 * gate token (round-10 F3), and fsyncs the destination directory. The
 * token is the recovery ownership proof — its removal is the LAST
 * filesystem step so a kill at any earlier seam still leaves recovery
 * able to complete forward. */
export async function finalizeReplayableFolderMove(
  toDirAbs: string,
  options: FolderMoveExecuteOptions = {},
): Promise<void> {
  if (options.vaultRoot && !await isPhysicallyContained(options.vaultRoot, toDirAbs)) {
    throw new UnsupportedDirectoryMoveError(`finalize destination escapes the vault: ${toDirAbs}`)
  }
  // Crash seam: AFTER metadata has committed but BEFORE the owned gate
  // token is removed and the durable journal is cleared (round-10 F5,
  // second window). A kill here must still leave the vault recoverable
  // forward — token + journal both present prove ownership; metadata
  // is already at the destination. Recovery finishes the commit
  // (removes token + journal) on the next startup.
  if (__createOnlyMoveHooks?.afterMetadataBeforeTokenRemoval) await __createOnlyMoveHooks.afterMetadataBeforeTokenRemoval(toDirAbs)
  if (options.gateToken) {
    const tokenPath = path.join(toDirAbs, gateTokenName(options.gateToken))
    if (options.vaultRoot && !await isPhysicallyContained(options.vaultRoot, tokenPath)) {
      // gate path escaped — token removal is unsafe, leave it for recovery
      return
    }
    // Owned-token removal (round-10 F3): read+verify-content+unlink.
    // A missing marker or a content mismatch is a no-op — the journal
    // stays so recovery can re-verify destination ownership later.
    try {
      const buf = await fs.readFile(tokenPath, 'utf8')
      if (buf === (options.gateTokenValue ?? '')) {
        await fs.unlink(tokenPath)
      }
    } catch {
      // missing or unreadable — leave the marker on disk
    }
  }
  await syncParentDirectoryBestEffort(toDirAbs)
}

// =================== round-11 v4 phase-aware mover ===================

/** Options for the v4 phase-aware mover. The destination gate is
 * already created by the route via `createDestinationGate`; the mover
 * just moves the entries into it and lets the caller rewrite the
 * journal's phase. */
export type MoveEntriesIntoGateOptions = {
  /** Vault root for physical-containment checks on every per-entry
   * source AND destination path (round-8 P0/P1). */
  vaultRoot?: string
  /** v4 per-file entries — each MUST carry (sourceDev, sourceIno,
   * sourceHash) for the post-takeover generation check. The
   * `expectedSource` of each `createOnlyMoveFile` is derived from
   * these. */
  entries: readonly FolderMoveJournalEntryV4[]
  /** Every subdirectory (including empty ones) the move must recreate
   * at the destination. Sorted, ancestor-closed, parent-closed. */
  directories: readonly string[]
  /** Source dev/ino for every declared directory. */
  directoryGenerations?: readonly {
    relativeDirectoryPath: string
    sourceDev: string
    sourceIno: string
    sourceBirthtimeNs?: string
  }[]
  expectedDestinationDirectoryGenerations?: readonly {
    relativeDirectoryPath: string
    sourceDev: string
    sourceIno: string
    sourceBirthtimeNs?: string
  }[]
  /** Exact destination-root entries owned by the transaction. */
  ignoredDestinationEntries?: readonly string[]
  /** Leave already-landed entries in place so durable recovery can
   * resume a split replayable tree after any mover error. */
  preservePartialLandingOnError?: boolean
  /** Original source root generation required before removing its shell. */
  sourceGeneration?: DurableDirectoryIdentity
}

/** Move every journaled entry into a destination gate the route
 * already created and bound to its optional v4 durable marker.
 * Destination (dev, ino) remains the strict proof for legacy journals
 * and a secondary signal for marker-bearing journals. Every
 * per-file move binds the source inode to the journaled generation
 * via `createOnlyMoveFile`'s post-takeover re-check (round-10 F1 +
 * round-11 F6). On any move failure, the whole forward move rolls
 * back create-only: landed entries are reversed with
 * `createOnlyMoveFile` (which refuses to move foreign bytes — the
 * F2 invariant carries forward). */
export async function moveFolderEntriesIntoExistingGate(
  fromDirAbs: string,
  toDirAbs: string,
  options: MoveEntriesIntoGateOptions,
): Promise<{ moved: string[]; incomplete: boolean }> {
  const entryByRel = new Map(options.entries.map((e) => [e.relativeFilePath, e]))
  const moved: string[] = []
  const destinationDirectoryGenerations: Array<{
    relativeDirectoryPath: string
    sourceDev: string
    sourceIno: string
    sourceBirthtimeNs: string
  }> = []
  // Recreate every declared directory at the destination.
  for (const dirRel of options.directories) {
    const dirAbs = path.join(toDirAbs, dirRel)
    if (options.vaultRoot && !await isPhysicallyContained(options.vaultRoot, dirAbs)) {
      throw new UnsupportedDirectoryMoveError(`directory path escapes the vault: ${dirRel}`)
    }
    await fs.mkdir(dirAbs, { recursive: true })
    const identity = await captureDurableDirectoryIdentity(dirAbs)
    destinationDirectoryGenerations.push({
      relativeDirectoryPath: dirRel,
      sourceDev: identity.dev,
      sourceIno: identity.ino,
      sourceBirthtimeNs: identity.birthtimeNs,
    })
  }
  if (options.expectedDestinationDirectoryGenerations) {
    const expected = options.expectedDestinationDirectoryGenerations
    if (expected.length !== destinationDirectoryGenerations.length
      || expected.some((entry, index) => {
        const current = destinationDirectoryGenerations[index]
        return entry.relativeDirectoryPath !== current.relativeDirectoryPath
          || entry.sourceDev !== current.sourceDev
          || entry.sourceIno !== current.sourceIno
          || entry.sourceBirthtimeNs !== current.sourceBirthtimeNs
      })) {
      throw new UnsupportedDirectoryMoveError(
        'destination declared directory generation changed',
      )
    }
  }
  for (const entry of options.entries) {
    const fromEntry = path.join(fromDirAbs, entry.relativeFilePath)
    const toEntry = path.join(toDirAbs, entry.relativeFilePath)
    if (options.vaultRoot
      && (!await isPhysicallyContained(options.vaultRoot, fromEntry)
        || !await isPhysicallyContained(options.vaultRoot, toEntry))) {
      throw new UnsupportedDirectoryMoveError(`entry path escapes the vault: ${entry.relativeFilePath}`)
    }
    await fs.mkdir(path.dirname(toEntry), { recursive: true })
    try {
      await createOnlyMoveFile(fromEntry, toEntry, {
        expectedSource: { dev: entry.sourceDev, ino: entry.sourceIno, hash: entry.sourceHash },
      })
      moved.push(entry.relativeFilePath)
      await fireReplayableMovedEntryHook(entry.relativeFilePath)
    } catch (error) {
      if (options.preservePartialLandingOnError) {
        throw error
      }
      // Roll back everything that landed create-only. The rollback
      // is itself creation-only (F2 invariant): an externally-
      // replaced landed file stays at the destination; the journal
      // remains so recovery can reconcile.
      for (const movedRel of moved.reverse()) {
        const rFrom = path.join(toDirAbs, movedRel)
        const rTo = path.join(fromDirAbs, movedRel)
        if (options.vaultRoot
          && (!await isPhysicallyContained(options.vaultRoot, rFrom)
            || !await isPhysicallyContained(options.vaultRoot, rTo))) continue
        const mEntry = entryByRel.get(movedRel)
        if (!mEntry?.sourceDev || !mEntry?.sourceIno || !mEntry?.sourceHash) continue
        try {
          await createOnlyMoveFile(rFrom, rTo, {
            expectedSource: { dev: mEntry.sourceDev, ino: mEntry.sourceIno, hash: mEntry.sourceHash },
          })
        } catch {
          // foreign generation at the destination: leave the foreign
          // bytes in place; recovery decides.
        }
      }
      // Clean up the gate if it's now empty.
      await removeDeclaredEmptyDirectories(toDirAbs, options.directories, {
        directoryGenerations: destinationDirectoryGenerations,
      })
      // The error is typed; callers map to 409.
      throw error
    }
  }
  // Do not remove source directory shells here. The files-landed phase
  // must become durable first; finalization then removes source shells
  // using their persisted generations. This prevents a crash during
  // cleanup from making an empty declared directory indistinguishable
  // from an external deletion.
  return { moved, incomplete: false }
}

/** Exact parity for the destination directory. Verification is:
 *   1. destination directory's (dev, ino) matches the journal's
 *      `destDev`/`destIno` (the v4 ownership proof);
 *   2. the file set is exactly the journaled entries, each with
 *      (dev, ino, hash) matching the journal;
 *   3. the directory set is exactly the journaled directories;
 *   4. no symlink / special / undeclared entry.
 * Returns `true` when parity FAILS. */
export async function verifyFolderMoveDestinationV4(
  destinationAbs: string,
  journal: {
    destDev?: string
    destIno?: string
    destBirthtimeNs?: string
    entries: readonly FolderMoveJournalEntryV4[]
    directories: readonly string[]
    directoryGenerations?: readonly {
      relativeDirectoryPath: string
      sourceDev: string
      sourceIno: string
      sourceBirthtimeNs?: string
    }[]
    destinationDirectoryGenerations?: readonly {
      relativeDirectoryPath: string
      sourceDev: string
      sourceIno: string
      sourceBirthtimeNs?: string
    }[]
    strategy?: FolderMoveJournalStrategy
  },
  options: FolderMoveParityOptions = {},
): Promise<boolean> {
  if (!journal.destDev || !journal.destIno || !journal.destBirthtimeNs) return true
  if (!await verifyDirectoryGeneration(destinationAbs, {
    dev: journal.destDev,
    ino: journal.destIno,
    birthtimeNs: journal.destBirthtimeNs,
  })) {
    return true
  }
  const expectedDirectoryGenerations =
    journal.strategy === 'replayable-move'
      ? journal.destinationDirectoryGenerations
      : journal.directoryGenerations
  if (expectedDirectoryGenerations) {
    for (const entry of expectedDirectoryGenerations) {
      if (!entry.sourceBirthtimeNs || !await verifyDirectoryGeneration(
        path.join(destinationAbs, entry.relativeDirectoryPath),
        {
          dev: entry.sourceDev,
          ino: entry.sourceIno,
          birthtimeNs: entry.sourceBirthtimeNs,
        },
      )) {
        return true
      }
    }
  }
  const expectedFiles = new Map(journal.entries.map((e) => [e.relativeFilePath, e]))
  const expectedDirs = new Set(journal.directories)
  const discoveredFiles = new Set<string>()
  const discoveredDirs = new Set<string>()
  const ignored = new Set(options.ignoredRelativePaths ?? [])
  const walk = async (dirAbs: string, rel: string): Promise<boolean> => {
    const dirents = await fs.readdir(dirAbs, { withFileTypes: true })
    for (const dirent of dirents) {
      const relPath = rel === '' ? dirent.name : `${rel}/${dirent.name}`
      const absPath = path.join(dirAbs, dirent.name)
      if (rel === '' && ignored.has(relPath)) continue
      if (dirent.isSymbolicLink()) return true
      if (dirent.isDirectory()) {
        if (!expectedDirs.has(relPath)) return true
        discoveredDirs.add(relPath)
        if (await walk(absPath, relPath)) return true
        continue
      }
      if (!dirent.isFile()) return true
      const expected = expectedFiles.get(relPath)
      if (!expected) return true
      const current = await readCurrentGeneration(absPath)
      if (!current
        || current.dev !== expected.sourceDev
        || current.ino !== expected.sourceIno
        || current.hash !== expected.sourceHash) {
        return true
      }
      discoveredFiles.add(relPath)
    }
    return false
  }
  try {
    if (await walk(destinationAbs, '')) return true
  } catch {
    return true
  }
  if (discoveredFiles.size !== expectedFiles.size) return true
  if (discoveredDirs.size !== expectedDirs.size) return true
  for (const expectedPath of expectedFiles.keys()) {
    if (!discoveredFiles.has(expectedPath)) return true
  }
  for (const expectedPath of expectedDirs) {
    if (!discoveredDirs.has(expectedPath)) return true
  }
  return false
}

export type FolderMoveParityOptions = {
  ignoredRelativePaths?: readonly string[]
}

/** round-11 v4: classify an entry's placement using generation proof
 * — NEVER hash alone. Returns 'src' | 'dest' | 'external' | 'missing'. */
export async function classifyPlacementV4(
  srcFile: string,
  destFile: string,
  entry: { sourceDev: string; sourceIno: string; sourceHash: string },
): Promise<'src' | 'dest' | 'external' | 'missing'> {
  const destGen = await readCurrentGeneration(destFile)
  if (destGen
    && destGen.dev === entry.sourceDev
    && destGen.ino === entry.sourceIno
    && destGen.hash === entry.sourceHash) {
    return 'dest'
  }
  const srcGen = await readCurrentGeneration(srcFile)
  if (srcGen
    && srcGen.dev === entry.sourceDev
    && srcGen.ino === entry.sourceIno
    && srcGen.hash === entry.sourceHash) {
    return 'src'
  }
  if (srcGen !== null || destGen !== null) return 'external'
  return 'missing'
}

async function readCurrentGeneration(absPath: string): Promise<ExpectedGeneration | null> {
  return readGeneration(absPath)
}

/** Shared exact final parity (round-9 F3 + round-10 F4) — used by the
 * mover AND by recovery replay. Verifies file-set equality (no missing,
 * no extra), per-file content hash, directory-set equality, exact
 * gate-token file presence + content, and no symlink/special/undeclared
 * entries. Round-10 F4: when a journaled gate token is expected, its
 * presence AND content are REQUIRED — a missing token fails parity
 * closed (the destination cannot be proven ours without it). Returns
 * true when parity fails (destination is not provably ours). */
export async function verifyExactParity(
  toDirAbs: string,
  options: FolderMoveExecuteOptions,
): Promise<boolean> {
  const expectedFiles = new Set(options.entries?.map((e) => e.relativeFilePath) ?? [])
  const expectedDirs = new Set(options.directories ?? [])
  const tokenName = options.gateToken ? gateTokenName(options.gateToken) : null
  const tokenContent = options.gateTokenValue ?? null
  const ignored = new Set(options.ignoredRelativePaths ?? [])
  const entryByRel = new Map((options.entries ?? []).map((e) => [e.relativeFilePath, e]))
  let landedFileCount = 0
  const landedDirs: string[] = []
  let tokenSeen = false
  try {
    // Destination must be a real directory (not symlink/junction).
    const destStat = await fs.lstat(toDirAbs)
    if (destStat.isSymbolicLink()) return true
    if (!destStat.isDirectory()) return true

    const walk = async (dir: string, rel: string): Promise<boolean> => {
      const dirents = await fs.readdir(dir, { withFileTypes: true })
      for (const dirent of dirents) {
        const relPath = rel === '' ? dirent.name : `${rel}/${dirent.name}`
        const absPath = path.join(dir, dirent.name)
        if (rel === '' && ignored.has(relPath)) continue
        if (dirent.isSymbolicLink()) return true
        if (dirent.isDirectory()) {
          if (!expectedDirs.has(relPath)) return true
          landedDirs.push(relPath)
          if (await walk(absPath, relPath)) return true
        } else if (dirent.isFile()) {
          // Exact gate token: skip from file set when the filename
          // matches the expected marker. Content verification only
          // runs when `gateTokenValue` is provided (round-10 F4).
          if (tokenName && dirent.name === tokenName && rel === '') {
            tokenSeen = true
            if (tokenContent !== null) {
              try {
                if (await fs.readFile(absPath, 'utf8') !== tokenContent) return true
              } catch { return true }
            }
            continue
          }
          const entry = entryByRel.get(relPath)
          if (!entry) return true
          if (!await fileHashMatchesBuffer(absPath, entry.sourceHash)) return true
          // v3 generation proof: a byte-identical external
          // replacement gets a fresh inode — the hard-linked landing
          // preserves the source identity. If the journal carried
          // sourceDev/sourceIno, the landing must still match.
          if (entry.sourceDev && entry.sourceIno) {
            try {
              const landingStat = await fs.stat(absPath, { bigint: true })
              if (landingStat.dev.toString() !== entry.sourceDev
                || landingStat.ino.toString() !== entry.sourceIno) return true
            } catch { return true }
          }
          landedFileCount++
        } else {
          return true // fail: special/socket/device/fifo
        }
      }
      return false
    }
    if (await walk(toDirAbs, '')) return true
  } catch {
    return true
  }
  // File set must be exactly equal (no missing, no extra).
  if (landedFileCount !== expectedFiles.size) return true
  // Directory set must be exactly equal.
  if (landedDirs.length !== expectedDirs.size) return true
  for (const dir of landedDirs) {
    if (!expectedDirs.has(dir)) return true
  }
  // Round-10 F4: token presence is required when `gateToken` was passed
  // (its filename is the ownership marker). Content verification only
  // runs when `gateTokenValue` is also provided — legacy v1/v2 journals
  // that don't persist the secret accept filename-only ownership proof.
  if (tokenName !== null && !tokenSeen) return true
  return false // parity passed
}

/** Binary-safe content hash verification — shared by inventory and
 * exact parity so buffer hashing is consistent everywhere. */
async function fileHashMatchesBuffer(absPath: string, expectedHash: string): Promise<boolean> {
  try {
    return sha256HexBuffer(await fs.readFile(absPath)) === expectedHash
  } catch {
    return false
  }
}

/** Execute the moved file set of a folder-move journal. The replayable
 * strategy moves EXACTLY `entryRels` (the journal is the authority);
 * the atomic strategy is a single rename(2) over the mkdir gate — the
 * whole directory crosses at once, so the entry list needs no replay.
 *
 * Replayable returns `parityPassed: true` when exact parity passed but
 * metadata has NOT been committed yet — the caller commits metadata
 * then calls finalizeReplayableFolderMove to remove the owned gate
 * token and clear the journal. Atomic returns no parityPassed flag
 * because there is no token to remove at the mover layer. */
export async function executeFolderMove(
  strategy: DirectoryMoveStrategy,
  fromDirAbs: string,
  toDirAbs: string,
  entryRels: string[],
  options: FolderMoveExecuteOptions = {},
): Promise<{ restored: boolean; parityPassed?: boolean }> {
  if (strategy === 'replayable-move') return executeReplayableFolderMove(fromDirAbs, toDirAbs, entryRels, options)
  return createOnlyMoveDirectory(fromDirAbs, toDirAbs, 'atomic-rename')
}

/**
 * Move a directory WITHOUT ever replacing external content. mkdir is
 * the create-only gate: EEXIST means an external writer claimed the
 * destination after any earlier check.
 *
 * `atomic-rename` (POSIX default): rename(2) then atomically replaces
 * OUR OWN empty gate directory — a single syscall, so a crash leaves
 * the whole tree at exactly one of the two paths, never split. If
 * external content lands inside the gate directory between mkdir and
 * rename, the rename fails (ENOTEMPTY) and the directory is no longer
 * ours: `restored: false` reports the reuse with the source tree left
 * intact.
 *
 * `replayable-move` (Windows default — rename(2) cannot replace a
 * directory there): the per-file journaled protocol, see
 * createOnlyMoveDirectoryReplayable. Tests can force either strategy
 * on any platform.
 */
export async function createOnlyMoveDirectory(
  fromDirAbs: string,
  toDirAbs: string,
  strategy: DirectoryMoveStrategy = platformDirectoryMoveStrategy,
): Promise<{ restored: boolean; parityPassed?: boolean }> {
  if (strategy === 'replayable-move') {
    // Journal-less callers enumerate fresh; unsupported entries
    // (symlink/junction/special) fail closed BEFORE the gate is
    // created, so nothing needs rolling back.
    const entryRels = await listRegularFileEntries(fromDirAbs)
    const directories = await listDirectoryEntries(fromDirAbs)
    // Compute source hashes and dev/ino for exact final parity (F3/F4).
    // Journal-less callers (tests, external moves) still verify every
    // landed byte before committing.
    const entries: FolderMoveJournalEntry[] = await Promise.all(
      entryRels.map(async (rel) => {
        const absPath = path.join(fromDirAbs, rel)
        const buf = await fs.readFile(absPath)
        const stat = await fs.stat(absPath, { bigint: true })
        return {
          relativeFilePath: rel,
          sourceHash: sha256HexBuffer(buf),
          sourceDev: stat.dev.toString(),
          sourceIno: stat.ino.toString(),
        }
      }),
    )
    return executeReplayableFolderMove(fromDirAbs, toDirAbs, entryRels, { directories, entries })
  }
  try {
    await fs.mkdir(toDirAbs)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST' || code === 'ENOTDIR') return { restored: false }
    throw error
  }
  if (__createOnlyMoveHooks?.afterMkdirGate) await __createOnlyMoveHooks.afterMkdirGate(toDirAbs)
  try {
    await renameWithTransientWindowsRetry(fromDirAbs, toDirAbs)
    await syncParentDirectoryBestEffort(toDirAbs)
    // Atomic: a single rename(2) covers the whole move + the
    // mkdir gate has no token to remove at this layer — the route's
    // finalizeReplayableFolderMove is replayable-only. parityPassed is
    // still reported so the route's `if (moved.parityPassed)`
    // dispatch is safe on every platform.
    return { restored: true, parityPassed: true }
  } catch (error) {
    try {
      // Only removable while still OUR empty gate directory.
      await fs.rmdir(toDirAbs)
    } catch {
      // External content inside: the destination is re-used.
      return { restored: false }
    }
    const code = (error as NodeJS.ErrnoException).code
    // A directory rename this platform cannot perform (Windows: EPERM
    // on any existing directory; a link-incapable filesystem: the same
    // codes createOnlyMoveFile reports). Never fall back to a
    // check-then-rename — that is the overwrite race this primitive
    // exists to prevent. The caller can retry with 'replayable-move'.
    if (code && LINK_INCAPABLE_CODES.has(code)) {
      throw new UnsupportedDirectoryMoveError(`directory rename failed (${code}); the platform needs the replayable strategy`, { cause: error })
    }
    throw error
  }
}

export async function renameDocumentWithMetadata(input: {
  db: DatabaseT
  fromPath: string
  toPath: string
  fromAbs: string
  toAbs: string
  renameFile?: (from: string, to: string) => Promise<void>
  moveMetadata?: (db: DatabaseT, fromPath: string, toPath: string) => boolean
}): Promise<void> {
  const { db, fromPath, toPath, fromAbs, toAbs } = input
  // Default is create-only: an external file at the destination fails
  // the move closed instead of being replaced (POSIX rename would
  // atomically overwrite it).
  const renameFile = input.renameFile ?? createOnlyMoveFile
  const moveMetadata = input.moveMetadata ?? moveDocumentMetadataReplacingDestination
  // Custom rename functions are test/fault-injection seams and may not
  // operate on real paths. The production create-only mover always gets
  // a durable journal spanning file move through metadata commit.
  let journalPath: string | null = null
  let journalStagingPath: string | null = null
  if (input.renameFile === undefined) {
    const sourceRaw = await fs.readFile(fromAbs, 'utf8')
    journalPath = path.join(
      path.dirname(fromAbs),
      recoveryMarkerName('journal', path.basename(fromAbs), randomUUID()),
    )
    journalStagingPath = path.join(
      path.dirname(fromAbs),
      recoveryMarkerName('rename', path.basename(fromAbs), randomUUID()),
    )
    await writeDurableJournal(journalPath, {
      version: 1,
      op: 'file-rename',
      srcRel: fromPath,
      destRel: toPath,
      staging: path.basename(journalStagingPath),
      documentId: getDocumentMetadata(db, fromPath)?.id,
      sourceHash: sha256Hex(sourceRaw),
    })
  }
  const forwardRename = input.renameFile ?? ((from: string, to: string) => createOnlyMoveFile(from, to, { preparedStagingPath: journalStagingPath ?? undefined }))
  try {
    await forwardRename(fromAbs, toAbs)
  } catch (error) {
    // A double reuse leaves the owned generation in staging. Preserve
    // the journal so startup/manual recovery can associate its identity;
    // ordinary destination contention restored the source completely.
    if (journalPath && !(error instanceof RenameSourceReusedError)) await removeDurableJournal(journalPath).catch(() => {})
    if (journalPath && error instanceof RenameSourceReusedError) {
      throw new RenameSourceReusedError(fromPath, {
        stagingPath: error.stagingPath,
        survivingPath: error.survivingPath,
        destinationOccupied: error.destinationOccupied,
        journalPath,
      })
    }
    throw error
  }
  if (__createOnlyMoveHooks?.afterFileMoveFinalized) await __createOnlyMoveHooks.afterFileMoveFinalized()
  try {
    if (!moveMetadata(db, fromPath, toPath)) {
      throw new Error(`source metadata missing: ${fromPath}`)
    }
    if (journalPath) await removeDurableJournal(journalPath).catch(() => {})
  } catch (metadataError) {
    try {
      await renameFile(toAbs, fromAbs)
    } catch (rollbackError) {
      if (rollbackError instanceof RenameDestinationOccupiedError) {
        // The original path was re-used externally: the create-only
        // rollback left the bytes at the destination rather than
        // overwriting the external file. The caller must keep the
        // identity with the bytes.
        throw new RenameSourceReusedError(fromPath, { survivingPath: 'destination', journalPath: journalPath ?? undefined })
      }
      if (rollbackError instanceof RenameSourceReusedError) {
        throw new RenameSourceReusedError(fromPath, {
          stagingPath: rollbackError.stagingPath,
          survivingPath: rollbackError.survivingPath,
          destinationOccupied: rollbackError.destinationOccupied,
          journalPath: journalPath ?? undefined,
        })
      }
      throw new AggregateError(
        [metadataError, rollbackError],
        'metadata move failed and filesystem rollback also failed',
      )
    }
    if (journalPath) await removeDurableJournal(journalPath).catch(() => {})
    throw metadataError
  }
}

import { createHash, randomUUID } from 'node:crypto'
import { constants, promises as fs } from 'node:fs'
import path from 'node:path'
import {
  captureDurableFile,
  removeCreatedDurableFile,
  writeCreateOnlyDurableFile,
  type CreatedDurableFile,
} from './durableCreateOnlyFile.js'
import {
  captureDurableDirectoryIdentity,
  matchesDurableDirectoryIdentity,
  type DurableDirectoryIdentity,
} from './durableDirectoryIdentity.js'
import { CONTENT_DIR } from './paths.js'
import { isManagedDiaryPath } from '../shared/diaryProtocol.js'
import { isEncryptedDiaryBody } from './diaryAccess/body.js'
import { recoveryMarkerName } from './technicalNamespace.js'

export function sha256Hex(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

function managedDiaryTarget(targetPath: string): boolean {
  const relative = path.relative(CONTENT_DIR, path.resolve(targetPath)).split(path.sep).join('/')
  if (!relative || relative.startsWith('../') || relative === '..' || path.isAbsolute(relative)) return false
  const logical = relative.endsWith('.md') ? relative.slice(0, -3) : relative
  return isManagedDiaryPath(logical)
}

/** Raised by the lowest-level durable writer when a managed Diary target is
 * about to receive anything other than the authenticated envelope. This is
 * defense in depth for non-route callers: plaintext must never reach a temp,
 * staged, or final managed-Diary pathname. */
export class ManagedDiaryPlaintextWriteError extends Error {
  readonly code = 'diary-plaintext-write-rejected'

  constructor(targetPath: string) {
    super(`managed Diary writes require an encrypted envelope: ${targetPath}`)
    this.name = 'ManagedDiaryPlaintextWriteError'
  }
}

/** Generic text removal has no adapter-owned encrypted delete transaction.
 * Keep this guard at the durable writer too, so a non-route caller cannot
 * stage/delete an opaque managed-Diary file through the regular pipeline. */
export class ManagedDiaryDeleteUnsupportedError extends Error {
  readonly code = 'diary-encrypted-delete-unsupported'

  constructor(targetPath: string) {
    super(`managed Diary deletion requires an adapter-aware owner: ${targetPath}`)
    this.name = 'ManagedDiaryDeleteUnsupportedError'
  }
}

function assertManagedDiaryBytes(targetPath: string, raw: string): void {
  if (managedDiaryTarget(targetPath) && !isEncryptedDiaryBody(Buffer.from(raw, 'utf8'))) {
    throw new ManagedDiaryPlaintextWriteError(targetPath)
  }
}

/** Content proof for ANY file the folder mover touches — including
 * binary attachments a utf8 read would mangle. Folder-move journals
 * hash every physical file with this. */
export function sha256HexBuffer(raw: Buffer | Uint8Array): string {
  return createHash('sha256').update(raw).digest('hex')
}

/** round-11 v4: a directory's (dev, ino) generation tuple persisted
 * in the journal. The pair uniquely identifies an inode on its
 * filesystem across the lifetime of the mount. */
export type DirectoryGeneration = DurableDirectoryIdentity

/** Create a destination gate as an empty directory the caller will
 * bind to a durable marker proof before moving into it. The freshly
 * mkdir'd (dev, ino) remains a secondary generation check. Returns
 * null when the path was already taken (an
 * external writer claimed the destination before us) or when a file
 * occupies the destination path. Throws on any other I/O error. */
export async function createDestinationGate(
  destinationAbs: string,
): Promise<DirectoryGeneration | null> {
  try {
    await fs.mkdir(destinationAbs)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST' || code === 'ENOTDIR') return null
    throw error
  }
  await syncParentDirectoryBestEffort(destinationAbs)
  try {
    return await captureDurableDirectoryIdentity(destinationAbs)
  } catch (error) {
    await fs.rmdir(destinationAbs).catch(() => {})
    await syncParentDirectoryBestEffort(destinationAbs)
    throw error
  }
}

/** round-11 v4: confirm a directory at `directoryAbs` is the same
 * inode the caller originally created. Used by recovery to prove the
 * destination is still the route's gate (an external writer could
 * unlink our gate, recreate a different one at the same path, and
 * try to confuse recovery). Returns true ONLY when (dev, ino) match
 * AND the path is a real directory. */
export async function verifyDirectoryGeneration(
  directoryAbs: string,
  expected: DirectoryGeneration,
): Promise<boolean> {
  try {
    const stat = await fs.lstat(directoryAbs, { bigint: true })
    return matchesDurableDirectoryIdentity(stat, expected)
  } catch {
    return false
  }
}

/**
 * Write a small JSON journal durably (O_EXCL create + write + fsync) so
 * it is on disk BEFORE the operation it describes begins. Startup crash
 * recovery (server/crashRecovery.ts) uses it to tell an interrupted
 * commit from an orphaned temp and to verify both generations by hash.
 */
export async function writeDurableJournal(
  journalPath: string,
  entry: unknown,
): Promise<CreatedDurableFile> {
  return writeCreateOnlyDurableFile(journalPath, JSON.stringify(entry))
}

/** Remove a journal and durably persist disappearance of its directory
 * entry. This prevents a completed operation's journal from reappearing
 * after power loss and being replayed on the next startup. */
export async function removeDurableJournal(
  journal: string | CreatedDurableFile,
): Promise<void> {
  const owned = typeof journal === 'string'
    ? await captureDurableFile(journal)
    : journal
  if (!owned) return
  await removeCreatedDurableFile(owned)
}

/** Atomically replace an owned journal with a new durable recovery
 * phase. The temporary entry and the final rename are both directory
 * synced, so repeated startup recovery observes either complete state. */
export type AtomicDurableJournalTestHooks = {
  beforeDurableJournalRename?: (temporaryPath: string, journalPath: string) => void | Promise<void>
}
let __atomicDurableJournalTestHooks: AtomicDurableJournalTestHooks | null = null
export function __setAtomicDurableJournalTestHooksForTesting(
  hooks: AtomicDurableJournalTestHooks | null,
): void {
  __atomicDurableJournalTestHooks = hooks
}

export async function rewriteDurableJournal(
  journalPath: string,
  entry: unknown,
): Promise<CreatedDurableFile> {
  const temporaryPath = `${journalPath}.rewrite-${randomUUID()}`
  const existingJournal = await captureDurableFile(journalPath)
  const ownedTemporary = await writeDurableJournal(temporaryPath, entry)
  try {
    await __atomicDurableJournalTestHooks?.beforeDurableJournalRename?.(temporaryPath, journalPath)
    await verifyOwnedDurableArtifact(ownedTemporary, journalPath)
    if (existingJournal) await verifyOwnedDurableArtifact(existingJournal, journalPath)
    else if (await captureDurableFile(journalPath)) {
      throw new AtomicTextWriteOwnershipError(journalPath)
    }
    await fs.rename(temporaryPath, journalPath)
    const rewritten = await captureDurableFile(journalPath)
    if (!rewritten
      || rewritten.fileIdentity.dev !== ownedTemporary.fileIdentity.dev
      || rewritten.fileIdentity.ino !== ownedTemporary.fileIdentity.ino) {
      throw new AtomicTextWriteOwnershipError(journalPath)
    }
    await syncParentDirectoryBestEffort(journalPath)
    return rewritten
  } catch (error) {
    await removeCreatedDurableFile(ownedTemporary).catch(() => {})
    throw error
  }
}

export async function writeDurableRecoveryPayload(
  payloadPath: string,
  raw: string,
): Promise<CreatedDurableFile> {
  return writeCreateOnlyDurableFile(payloadPath, raw)
}

export async function removeDurableRecoveryPayload(
  payload: string | CreatedDurableFile,
): Promise<void> {
  const owned = typeof payload === 'string'
    ? await captureDurableFile(payload)
    : payload
  if (!owned) return
  await removeCreatedDurableFile(owned)
}

/** Test-only hooks for real crash tests: a child process installs a
 * hook that kills the process hard at the exact protocol point under
 * test. Null in production; tests reset in afterEach/finally. */
export type AtomicWriteCrashHooks = {
  afterJournalWrite?: () => void | Promise<void>
  afterTakeover?: () => void | Promise<void>
}
let __atomicWriteCrashHooks: AtomicWriteCrashHooks | null = null
export function __setAtomicWriteCrashHooksForTesting(hooks: AtomicWriteCrashHooks | null): void {
  __atomicWriteCrashHooks = hooks
}

export type AtomicWriteTestHooks = {
  afterParentIdentityBeforeTemporaryOpen?: (temporaryPath: string) => void | Promise<void>
  afterTemporaryCloseBeforeIdentity?: (temporaryPath: string) => void | Promise<void>
  afterCreateCommitBeforeCleanup?: (targetPath: string) => void | Promise<void>
  beforeUnconditionalReplaceRename?: (temporaryPath: string) => void | Promise<void>
  beforeAtomicRemoveRename?: (targetPath: string, stagedPath: string) => void | Promise<void>
  beforeAtomicRemoveUnlink?: (stagedPath: string) => void | Promise<void>
  beforeReplacementStagedCleanup?: (stagedPath: string, targetPath: string) => void | Promise<void>
}
let __atomicWriteTestHooks: AtomicWriteTestHooks | null = null
export function __setAtomicWriteTestHooksForTesting(hooks: AtomicWriteTestHooks | null): void {
  __atomicWriteTestHooks = hooks
}

type OwnedPathIdentity = {
  dev: string
  ino: string
}

type OwnedTemporaryFile = {
  path: string
  parentPath: string
  fileIdentity: OwnedPathIdentity
  parentIdentity: OwnedPathIdentity
}

type OwnedArtifact = OwnedTemporaryFile

export type AtomicRemoveResult =
  | { removed: true; restored: false; externalMutationDetected: false; quarantined: false }
  | { removed: false; restored: boolean; externalMutationDetected: boolean; quarantined: boolean }

function sameOwnedArtifact(a: OwnedArtifact, b: OwnedArtifact): boolean {
  return a.path === b.path
    && a.parentPath === b.parentPath
    && a.fileIdentity.dev === b.fileIdentity.dev
    && a.fileIdentity.ino === b.fileIdentity.ino
    && a.parentIdentity.dev === b.parentIdentity.dev
    && a.parentIdentity.ino === b.parentIdentity.ino
}

export interface PreparedAtomicTextWrite {
  readonly temporaryPath: string
  readonly ownership: OwnedTemporaryFile
  commit(): Promise<void>
  rollback(): Promise<void>
  /**
   * Roll back the exact generation created by this create transaction. The
   * capability is closure-bound to the successful create-only link and is
   * consumed after one attempt; it is not a generic managed-Diary delete.
   * Returns null when the create never committed a generation.
   */
  rollbackCreatedGenerationIfStillOwned(): Promise<AtomicRemoveResult | null>
}

export class AtomicTextWriteOwnershipError extends Error {
  readonly code = 'HISTORY_PATH_MOVED'

  constructor(targetPath: string) {
    super(`atomic write path ownership changed: ${targetPath}`)
    this.name = 'AtomicTextWriteOwnershipError'
  }
}

export class AtomicTextWritePostCommitExternalMutationError extends Error {
  readonly code = 'HISTORY_POST_COMMIT_EXTERNAL_MUTATION'
  readonly replacementApplied: boolean
  readonly restored: boolean
  readonly quarantined: boolean

  constructor(options: {
    replacementApplied: boolean
    restored: boolean
    quarantined: boolean
  }) {
    super(
      options.replacementApplied
        ? 'replacement committed, but the previous generation changed externally and was quarantined'
        : 'external content changed during removal and was restored or quarantined',
    )
    this.name = 'AtomicTextWritePostCommitExternalMutationError'
    this.replacementApplied = options.replacementApplied
    this.restored = options.restored
    this.quarantined = options.quarantined
  }
}

export class AtomicTextWriteCleanupError extends Error {
  readonly code = 'HISTORY_ATOMIC_CLEANUP_FAILED'

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'AtomicTextWriteCleanupError'
  }
}

async function verifyOwnedDurableArtifact(
  artifact: CreatedDurableFile,
  targetPath: string,
): Promise<void> {
  let current: CreatedDurableFile | null
  try {
    current = await captureDurableFile(artifact.path)
  } catch {
    throw new AtomicTextWriteOwnershipError(targetPath)
  }
  if (!current
    || current.fileIdentity.dev !== artifact.fileIdentity.dev
    || current.fileIdentity.ino !== artifact.fileIdentity.ino
    || current.parentIdentity.dev !== artifact.parentIdentity.dev
    || current.parentIdentity.ino !== artifact.parentIdentity.ino
    || (artifact.contentHash !== undefined && current.contentHash !== artifact.contentHash)) {
    throw new AtomicTextWriteOwnershipError(targetPath)
  }
}

async function captureOwnedFileIdentity(
  filePath: string,
  targetPath: string,
): Promise<OwnedPathIdentity> {
  const stat = await fs.lstat(filePath, { bigint: true })
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new AtomicTextWriteOwnershipError(targetPath)
  }
  return { dev: stat.dev.toString(), ino: stat.ino.toString() }
}

async function captureOwnedDirectoryIdentity(
  directoryPath: string,
  targetPath: string,
): Promise<OwnedPathIdentity> {
  const stat = await fs.lstat(directoryPath, { bigint: true })
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new AtomicTextWriteOwnershipError(targetPath)
  }
  return { dev: stat.dev.toString(), ino: stat.ino.toString() }
}

async function verifyOwnedTemporaryPath(
  temporaryPath: string,
  parentPath: string,
  temporaryIdentity: OwnedPathIdentity,
  parentIdentity: OwnedPathIdentity,
  targetPath: string,
): Promise<void> {
  let currentTemporary: OwnedPathIdentity
  let currentParent: OwnedPathIdentity
  try {
    [currentTemporary, currentParent] = await Promise.all([
      captureOwnedFileIdentity(temporaryPath, targetPath),
      captureOwnedDirectoryIdentity(parentPath, targetPath),
    ])
  } catch {
    throw new AtomicTextWriteOwnershipError(targetPath)
  }
  if (
    currentTemporary.dev !== temporaryIdentity.dev
    || currentTemporary.ino !== temporaryIdentity.ino
    || currentParent.dev !== parentIdentity.dev
    || currentParent.ino !== parentIdentity.ino
  ) {
    throw new AtomicTextWriteOwnershipError(targetPath)
  }
}

async function removeOwnedTemporaryPath(
  temporaryPath: string,
  parentPath: string,
  temporaryIdentity: OwnedPathIdentity,
  parentIdentity: OwnedPathIdentity,
  targetPath: string,
): Promise<void> {
  await verifyOwnedTemporaryPath(
    temporaryPath,
    parentPath,
    temporaryIdentity,
    parentIdentity,
    targetPath,
  )
  await fs.unlink(temporaryPath)
}

async function captureOwnedTextArtifact(
  filePath: string,
  targetPath: string,
): Promise<{ artifact: OwnedArtifact; snapshot: StableTextSnapshot }> {
  const parentPath = path.dirname(filePath)
  const parentIdentity = await captureOwnedDirectoryIdentity(parentPath, targetPath)
  const before = await captureOwnedFileIdentity(filePath, targetPath)
  const raw = await fs.readFile(filePath, 'utf8')
  const secondRaw = await fs.readFile(filePath, 'utf8')
  const after = await captureOwnedFileIdentity(filePath, targetPath)
  if (before.dev !== after.dev || before.ino !== after.ino || raw !== secondRaw) {
    throw new AtomicTextWriteOwnershipError(targetPath)
  }
  const stat = await fs.lstat(filePath)
  return {
    artifact: {
      path: filePath,
      parentPath,
      fileIdentity: after,
      parentIdentity,
    },
    snapshot: {
      raw: secondRaw,
      stat: {
        mtimeMs: Number(stat.mtimeMs),
        size: Number(stat.size),
        mode: Number(stat.mode),
      },
    },
  }
}

async function verifyOwnedArtifact(
  artifact: OwnedArtifact,
  targetPath: string,
): Promise<void> {
  await verifyOwnedTemporaryPath(
    artifact.path,
    artifact.parentPath,
    artifact.fileIdentity,
    artifact.parentIdentity,
    targetPath,
  )
}

/**
 * A prepared replacement whose commit is ownership-verified: it never
 * overwrites a generation it did not verify. See commit() below.
 */
export interface PreparedAtomicTextReplace {
  readonly temporaryPath: string
  readonly ownership: OwnedTemporaryFile
  /**
   * Commit the replacement with an external-writer-safe protocol:
   *
   *   1. OWNERSHIP — atomically rename the current target aside to a
   *      private staging path. Whoever wins this rename owns the old
   *      generation; there is no check-to-rename window afterwards.
   *   2. VERIFY — the staged bytes must still equal `expectedRaw`.
   *      An external save that landed before the takeover is detected
   *      here: the staged bytes are restored create-only and the
   *      commit fails closed.
   *   3. COMMIT — link(2) the new generation into the target path.
   *      link is create-only: if an external writer recreated the
   *      path while we held the staged generation, EEXIST fails the
   *      commit and the external file is preserved untouched.
   *
   * Any external generation wins. The caller's bytes are never written
   * over a generation the caller did not prove it still owned.
   */
  commit(expectedRaw: string): Promise<void>
  rollback(): Promise<void>
}

/** Prepare a durable temporary file whose commit atomically creates, but can
 * never replace, the target path. */
export async function prepareAtomicTextCreate(
  targetPath: string,
  raw: string,
  options: { mode?: number } = {},
): Promise<PreparedAtomicTextWrite> {
  const prepared = await prepareAtomicTextWrite(targetPath, raw, options)
  const { parentPath, fileIdentity: temporaryIdentity, parentIdentity } = prepared.ownership
  let settled = false
  let committedArtifact: OwnedArtifact | null = null
  let createdRollbackConsumed = false
  return {
    temporaryPath: prepared.temporaryPath,
    ownership: prepared.ownership,
    async commit() {
      if (settled) return
      try {
        await verifyOwnedTemporaryPath(
          prepared.temporaryPath,
          parentPath,
          temporaryIdentity,
          parentIdentity,
          targetPath,
        )
        // link(2) is the create-only counterpart to rename: it atomically
        // fails with EEXIST and never replaces a newer generation.
        await fs.link(prepared.temporaryPath, targetPath)
        // A successful create-only link proves that the target is this
        // transaction's generation. Retain that identity independently of
        // temporary-path cleanup/settled state so a later route failure can
        // roll back only this exact generation.
        committedArtifact = {
          path: targetPath,
          parentPath,
          fileIdentity: temporaryIdentity,
          parentIdentity,
        }
        settled = true
        await __atomicWriteTestHooks?.afterCreateCommitBeforeCleanup?.(targetPath)
        await removeOwnedTemporaryPath(
          prepared.temporaryPath,
          parentPath,
          temporaryIdentity,
          parentIdentity,
          targetPath,
        )
        await syncParentDirectoryBestEffort(targetPath)
      } catch (error) {
        if (!(error instanceof AtomicTextWriteOwnershipError)) {
          try {
            await removeOwnedTemporaryPath(
              prepared.temporaryPath,
              parentPath,
              temporaryIdentity,
              parentIdentity,
              targetPath,
            )
          } catch {
            // The temporary path is deliberately quarantined when its
            // ownership cannot be proved. Never clean by string path alone.
          }
        }
        settled = true
        throw error
      }
    },
    async rollback() {
      if (settled) return
      await removeOwnedTemporaryPath(
        prepared.temporaryPath,
        parentPath,
        temporaryIdentity,
        parentIdentity,
        targetPath,
      )
      settled = true
    },
    async rollbackCreatedGenerationIfStillOwned() {
      if (createdRollbackConsumed || !committedArtifact) return null
      createdRollbackConsumed = true
      return removeTextIfUnchanged(targetPath, raw, committedArtifact)
    },
  }
}

export interface StableTextSnapshot {
  raw: string
  stat: {
    mtimeMs: number
    size: number
    mode: number
  }
}

export class AtomicTextWriteConflictError extends Error {
  readonly current: StableTextSnapshot

  constructor(current: StableTextSnapshot) {
    super('document changed before atomic replacement')
    this.name = 'AtomicTextWriteConflictError'
    this.current = current
  }
}

/** The target disappeared (an external delete) before the commit could
 * take ownership of its generation. */
export class AtomicTextWriteTargetMissingError extends Error {
  constructor(targetPath: string) {
    super(`atomic replacement target disappeared: ${targetPath}`)
    this.name = 'AtomicTextWriteTargetMissingError'
  }
}

export class UnstableTextSnapshotError extends Error {
  readonly latest: StableTextSnapshot

  constructor(latest: StableTextSnapshot) {
    super('document did not stabilize while reading')
    this.name = 'UnstableTextSnapshotError'
    this.latest = latest
  }
}

/** Verify a file at `absPath` belongs to the generation described by
 * `expected` — same dev, same ino, same content hash. Used to prove
 * the bytes recovery is about to touch still match the journal; an
 * external replacement that lands a byte-identical fresh inode is
 * detected by the (dev, ino) pair, not by hash alone (round-10 F1/F2).
 * A missing path returns `false` rather than throwing. */
export async function verifyExpectedGeneration(
  absPath: string,
  expected: { dev: string; ino: string; hash: string } | undefined,
): Promise<boolean> {
  if (!expected) return true
  try {
    const buf = await fs.readFile(absPath)
    if (sha256HexBuffer(buf) !== expected.hash) return false
    const stat = await fs.stat(absPath, { bigint: true })
    return stat.dev.toString() === expected.dev && stat.ino.toString() === expected.ino
  } catch {
    return false
  }
}

/** Read a file's current generation (dev + ino + content hash) for
 * callers that need to capture it before mutating or to confirm it
 * after. Buffer-hashed so binary attachments are handled correctly. */
export async function readCurrentGeneration(absPath: string): Promise<{ dev: string; ino: string; hash: string } | null> {
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

export async function syncParentDirectoryBestEffort(targetPath: string): Promise<void> {
  let directory: Awaited<ReturnType<typeof fs.open>> | null = null
  try {
    directory = await fs.open(path.dirname(targetPath), 'r')
    await directory.sync()
  } catch {
    // Directory fsync is not supported on every platform/filesystem.
  } finally {
    await directory?.close().catch(() => {})
  }
}

export async function renameWithTransientWindowsRetry(from: string, to: string): Promise<void> {
  const delays = process.platform === 'win32' ? [0, 5, 20, 50] : [0]
  let lastError: unknown
  for (const delay of delays) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    try {
      await fs.rename(from, to)
      return
    } catch (error) {
      lastError = error
      const code = (error as NodeJS.ErrnoException).code
      if (!['EACCES', 'EBUSY', 'EPERM'].includes(code ?? '')) throw error
    }
  }
  throw lastError
}

/**
 * Restore a staged generation to the target path WITHOUT ever
 * replacing a newer one: link(2) is create-only, so a path an external
 * writer recreated wins — the staged bytes then stay quarantined on
 * disk under their staging name rather than clobbering the new
 * generation. `quarantined: true` reports that the staged bytes could
 * not be restored and remain on disk under their staging name.
 */
export async function restoreStagedGeneration(
  stagedPath: string,
  targetPath: string,
): Promise<{ quarantined: boolean }> {
  let stagedArtifact: OwnedArtifact
  try {
    stagedArtifact = (await captureOwnedTextArtifact(stagedPath, targetPath)).artifact
    await verifyOwnedArtifact(stagedArtifact, targetPath)
    await captureOwnedDirectoryIdentity(path.dirname(targetPath), targetPath)
  } catch {
    return { quarantined: true }
  }
  try {
    await fs.link(stagedPath, targetPath)
    await removeOwnedTemporaryPath(
      stagedArtifact.path,
      stagedArtifact.parentPath,
      stagedArtifact.fileIdentity,
      stagedArtifact.parentIdentity,
      targetPath,
    )
    return { quarantined: false }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      // A newer external generation owns the path: never clobber it.
      return { quarantined: true }
    }
    // link failed for some other reason; put the bytes back only if
    // the path is still unclaimed.
    const targetExists = await fs.stat(targetPath).then(() => true, () => false)
    if (!targetExists) {
      try {
        await verifyOwnedArtifact(stagedArtifact, targetPath)
        await renameWithTransientWindowsRetry(stagedPath, targetPath)
        return { quarantined: false }
      } catch {
        return { quarantined: true }
      }
    }
    return { quarantined: true }
  }
}

async function writeTemporaryTextFile(
  targetPath: string,
  raw: string,
  options: { mode?: number },
): Promise<OwnedTemporaryFile> {
  const directory = path.dirname(targetPath)
  const temporaryPath = path.join(
    directory,
    recoveryMarkerName('save', path.basename(targetPath), randomUUID()),
  )
  const parentIdentity = await captureOwnedDirectoryIdentity(directory, targetPath)
  await __atomicWriteTestHooks?.afterParentIdentityBeforeTemporaryOpen?.(temporaryPath)
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null
  let fileIdentity: OwnedPathIdentity | null = null
  try {
    handle = await fs.open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      options.mode,
    )
    const stat = await handle.stat({ bigint: true })
    if (!stat.isFile()) throw new AtomicTextWriteOwnershipError(targetPath)
    // The open handle is the creation proof. Never infer this identity by
    // lstat'ing a pathname after an attacker has had a chance to replace it.
    fileIdentity = { dev: stat.dev.toString(), ino: stat.ino.toString() }
    // The pathname open may have followed a replaced intermediate directory
    // on platforms without openat. Revalidate before writing any document
    // bytes. If this fails, the only possible artifact is an empty file; the
    // cleanup below is ownership-verified and deliberately leaves it behind
    // when the parent generation cannot be proved.
    await verifyOwnedTemporaryPath(
      temporaryPath,
      directory,
      fileIdentity,
      parentIdentity,
      targetPath,
    )
    await handle.writeFile(raw, { encoding: 'utf8' })
    if (options.mode !== undefined) await handle.chmod(options.mode)
    await handle.sync()
    await handle.close()
    handle = null
    await __atomicWriteTestHooks?.afterTemporaryCloseBeforeIdentity?.(temporaryPath)
    await verifyOwnedTemporaryPath(
      temporaryPath,
      directory,
      fileIdentity,
      parentIdentity,
      targetPath,
    )
    return {
      path: temporaryPath,
      parentPath: directory,
      fileIdentity,
      parentIdentity,
    }
  } catch (error) {
    await handle?.close().catch(() => {})
    if (fileIdentity) {
      await removeOwnedTemporaryPath(
        temporaryPath,
        directory,
        fileIdentity,
        parentIdentity,
        targetPath,
      ).catch(() => {})
    }
    throw error
  }
}

export async function prepareAtomicTextWrite(
  targetPath: string,
  raw: string,
  options: { mode?: number } = {},
): Promise<PreparedAtomicTextReplace> {
  assertManagedDiaryBytes(targetPath, raw)
  const ownedTemporary = await writeTemporaryTextFile(targetPath, raw, options)
  const temporaryPath = ownedTemporary.path
  const { parentPath, fileIdentity: temporaryIdentity, parentIdentity } = ownedTemporary
  const replacementHash = sha256Hex(raw)
  let settled = false

  return {
    temporaryPath,
    ownership: ownedTemporary,
    async commit(expectedRaw: string) {
      if (settled) return
      await verifyOwnedTemporaryPath(
        temporaryPath,
        parentPath,
        temporaryIdentity,
        parentIdentity,
        targetPath,
      )
      const stagedPath = path.join(
        parentPath,
        recoveryMarkerName('staged', path.basename(targetPath), randomUUID()),
      )
      const journalPath = path.join(
        parentPath,
        recoveryMarkerName('journal', path.basename(targetPath), randomUUID()),
      )
      let stagedArtifact: OwnedArtifact | null = null
      let journalArtifact: CreatedDurableFile | null = null
      const fail = async (error: unknown): Promise<never> => {
        settled = true
        const cleanupErrors: unknown[] = []
        try {
          await removeOwnedTemporaryPath(
            temporaryPath,
            parentPath,
            temporaryIdentity,
            parentIdentity,
            targetPath,
          )
        } catch (cleanupError) {
          // Never infer ownership from a changed pathname.
          cleanupErrors.push(cleanupError)
        }
        if (journalArtifact) {
          try {
            await removeDurableJournal(journalArtifact)
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError)
          }
        }
        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            [error, ...cleanupErrors],
            'atomic operation failed and cleanup was incomplete',
          )
        }
        throw error
      }
      const failAfterCommitExternalMutation = async (
        observedRaw?: string,
      ): Promise<never> => {
        const observedHash = observedRaw === undefined ? undefined : sha256Hex(observedRaw)
        // The replacement is already linked at the formal path. Preserve the
        // changed old generation and make recovery treat this as a manual
        // quarantine set, never as ordinary stale staging.
        try {
          await rewriteDurableJournal(journalPath, {
            version: 1,
            op: 'replace',
            staged: path.basename(stagedPath),
            replacement: path.basename(temporaryPath),
            expectedHash: sha256Hex(expectedRaw),
            replacementHash,
            phase: 'post-commit-external-mutation',
            ...(observedHash ? { observedStagedHash: observedHash } : {}),
          })
        } catch {
          // Keep the original journal if the phase rewrite cannot be
          // persisted. Crash recovery also compares staged bytes with the
          // expected hash before removing them, so a changed generation is
          // still retained rather than silently deleted.
        }
        try {
          await removeOwnedTemporaryPath(
            temporaryPath,
            parentPath,
            temporaryIdentity,
            parentIdentity,
            targetPath,
          )
        } catch {
          // The replacement is already committed; an unproven save temp is
          // safer as a quarantine artifact than as a pathname deletion.
        }
        settled = true
        throw new AtomicTextWritePostCommitExternalMutationError({
          replacementApplied: true,
          restored: false,
          quarantined: true,
        })
      }
      // 0. JOURNAL: a durable record of this commit's intent and both
      //    generations' hashes, fsync'd BEFORE the takeover. If this
      //    process dies at any point after the takeover rename below
      //    (kill -9, power loss, container stop), the formal path would
      //    otherwise be left missing with only hidden staging files —
      //    the note would appear to vanish. Startup crash recovery
      //    (server/crashRecovery.ts) reads this journal, verifies the
      //    staged/replacement bytes against the hashes, and either
      //    completes the commit or restores the old generation before
      //    the HTTP server accepts a single request. The journal is
      //    removed LAST; a failed commit removes it in fail().
      try {
        journalArtifact = await writeDurableJournal(journalPath, {
          version: 1,
          op: 'replace',
          staged: path.basename(stagedPath),
          replacement: path.basename(temporaryPath),
          expectedHash: sha256Hex(expectedRaw),
          replacementHash,
        })
      } catch (error) {
        return fail(error)
      }
      if (__atomicWriteCrashHooks?.afterJournalWrite) await __atomicWriteCrashHooks.afterJournalWrite()
      // 1. OWNERSHIP: atomically take the current generation aside. An
      //    external save that landed before this rename travels with
      //    the bytes to staging and is detected at verification; one
      //    that recreates the path afterwards loses to the create-only
      //    link below. Either way it is never silently overwritten.
      let targetArtifact: OwnedArtifact
      try {
        targetArtifact = (await captureOwnedTextArtifact(targetPath, targetPath)).artifact
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return fail(new AtomicTextWriteTargetMissingError(targetPath))
        }
        return fail(error)
      }
      try {
        await renameWithTransientWindowsRetry(targetPath, stagedPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return fail(new AtomicTextWriteTargetMissingError(targetPath))
        }
        return fail(error)
      }
      stagedArtifact = {
        path: stagedPath,
        parentPath,
        fileIdentity: targetArtifact.fileIdentity,
        parentIdentity: targetArtifact.parentIdentity,
      }
      try {
        await verifyOwnedArtifact(stagedArtifact, targetPath)
      } catch (error) {
        return fail(error)
      }
      // Publish the takeover durably before continuing: a crash after
      // this point must see the staged bytes on the next startup.
      await syncParentDirectoryBestEffort(targetPath)
      if (__atomicWriteCrashHooks?.afterTakeover) await __atomicWriteCrashHooks.afterTakeover()
      // 2. VERIFY the owned generation.
      let stagedSnapshot: StableTextSnapshot
      try {
        const owned = await captureOwnedTextArtifact(stagedPath, targetPath)
        if (
          owned.artifact.fileIdentity.dev !== stagedArtifact.fileIdentity.dev
          || owned.artifact.fileIdentity.ino !== stagedArtifact.fileIdentity.ino
          || owned.artifact.parentIdentity.dev !== stagedArtifact.parentIdentity.dev
          || owned.artifact.parentIdentity.ino !== stagedArtifact.parentIdentity.ino
        ) throw new AtomicTextWriteOwnershipError(targetPath)
        stagedSnapshot = owned.snapshot
      } catch (error) {
        if (stagedArtifact) {
          await verifyOwnedArtifact(stagedArtifact, targetPath).then(
            () => restoreStagedGeneration(stagedPath, targetPath),
            () => undefined,
          )
        }
        return fail(error)
      }
      if (stagedSnapshot.raw !== expectedRaw) {
        if (stagedArtifact) {
          await verifyOwnedArtifact(stagedArtifact, targetPath).then(
            () => restoreStagedGeneration(stagedPath, targetPath),
            () => undefined,
          )
        }
        return fail(new AtomicTextWriteConflictError(stagedSnapshot))
      }
      // 3. COMMIT create-only: link(2) never replaces. EEXIST means a
      //    new external generation landed while we held the staged
      //    bytes — preserve it. The staged generation equals
      //    expectedRaw, which the caller already holds, so both of our
      //    files are removed and the conflict reports the winner.
      try {
        await fs.link(temporaryPath, targetPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          if (stagedArtifact) {
            await verifyOwnedArtifact(stagedArtifact, targetPath)
              .then(() => removeOwnedTemporaryPath(
                stagedPath,
                parentPath,
                stagedArtifact.fileIdentity,
                stagedArtifact.parentIdentity,
                targetPath,
              ))
              .catch(() => {})
          }
          let current: StableTextSnapshot
          try {
            current = await readStableTextSnapshot(targetPath)
          } catch {
            return fail(error)
          }
          return fail(new AtomicTextWriteConflictError(current))
        }
        if (stagedArtifact) {
          await verifyOwnedArtifact(stagedArtifact, targetPath).then(
            () => restoreStagedGeneration(stagedPath, targetPath),
            () => undefined,
          )
        }
        return fail(error)
      }
      settled = true
      await __atomicWriteTestHooks?.beforeReplacementStagedCleanup?.(stagedPath, targetPath)
      let finalStaged: { artifact: OwnedArtifact; snapshot: StableTextSnapshot }
      try {
        if (!stagedArtifact) throw new AtomicTextWriteOwnershipError(targetPath)
        finalStaged = await captureOwnedTextArtifact(stagedPath, targetPath)
        if (
          finalStaged.artifact.fileIdentity.dev !== stagedArtifact.fileIdentity.dev
          || finalStaged.artifact.fileIdentity.ino !== stagedArtifact.fileIdentity.ino
          || finalStaged.artifact.parentIdentity.dev !== stagedArtifact.parentIdentity.dev
          || finalStaged.artifact.parentIdentity.ino !== stagedArtifact.parentIdentity.ino
        ) throw new AtomicTextWriteOwnershipError(targetPath)
        if (finalStaged.snapshot.raw !== expectedRaw) {
          return failAfterCommitExternalMutation(finalStaged.snapshot.raw)
        }
      } catch (error) {
        if (error instanceof AtomicTextWritePostCommitExternalMutationError) throw error
        return failAfterCommitExternalMutation()
      }
      try {
        await removeOwnedTemporaryPath(
          temporaryPath,
          parentPath,
          temporaryIdentity,
          parentIdentity,
          targetPath,
        )
      } catch (error) {
        throw new AtomicTextWriteCleanupError(
          'replacement committed but its temporary artifact could not be safely removed',
          { cause: error },
        )
      }
      try {
        await removeOwnedTemporaryPath(
          stagedPath,
          parentPath,
          finalStaged.artifact.fileIdentity,
          finalStaged.artifact.parentIdentity,
          targetPath,
        )
      } catch (error) {
        throw new AtomicTextWriteCleanupError(
          'replacement committed but its staged generation could not be safely removed',
          { cause: error },
        )
      }
      // The journal goes LAST: while it exists, recovery still knows
      // this commit was in flight and can finish or undo it.
      if (journalArtifact) {
        try {
          await removeDurableJournal(journalArtifact)
        } catch (error) {
          throw new AtomicTextWriteCleanupError(
            'replacement committed but its journal could not be safely removed',
            { cause: error },
          )
        }
      }
      await syncParentDirectoryBestEffort(targetPath)
    },
    async rollback() {
      if (settled) return
      await removeOwnedTemporaryPath(
        temporaryPath,
        parentPath,
        temporaryIdentity,
        parentIdentity,
        targetPath,
      )
      settled = true
    },
  }
}

/**
 * Read around stat so a content change observed during snapshot collection is
 * retried instead of pairing an old body with a newer file status.
 */
export async function readStableTextSnapshot(
  targetPath: string,
  maxAttempts = 3,
): Promise<StableTextSnapshot> {
  let latest: StableTextSnapshot | null = null
  const numericStat = async () => {
    const stat = await fs.stat(targetPath)
    return {
      mtimeMs: Number(stat.mtimeMs),
      size: Number(stat.size),
      mode: Number(stat.mode),
    }
  }
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const before = await fs.readFile(targetPath, 'utf8')
    const stat = await numericStat()
    const after = await fs.readFile(targetPath, 'utf8')
    latest = {
      raw: after,
      stat: after === before ? stat : await numericStat(),
    }
    if (after === before) return latest
  }
  throw new UnstableTextSnapshotError(latest!)
}

/**
 * Replace a text file only while its current bytes still match the
 * caller's expectation, with no check-to-rename window: the commit
 * takes ownership of the current generation first (atomic rename
 * aside), verifies it, and links the replacement in create-only. An
 * external writer winning any race keeps its bytes and the call fails
 * closed with AtomicTextWriteConflictError (or
 * AtomicTextWriteTargetMissingError if the target was deleted). The
 * file's mode is preserved.
 */
export async function atomicReplaceTextIfUnchanged(
  targetPath: string,
  expectedRaw: string,
  replacementRaw: string,
  options: { mode?: number } = {},
): Promise<void> {
  let mode = options.mode
  if (mode === undefined) {
    mode = await fs.stat(targetPath).then((stat) => Number(stat.mode), () => undefined)
  }
  const prepared = await prepareAtomicTextWrite(targetPath, replacementRaw, { mode })
  try {
    await prepared.commit(expectedRaw)
  } catch (error) {
    await prepared.rollback()
    throw error
  }
}

/**
 * Remove a text file only while the bytes being removed still match the
 * caller's write. Renaming first means a writer that changes the same inode
 * before cleanup is detected on the staged file and restored create-only
 * (a recreated path wins), rather than being silently deleted. If the
 * bytes change after takeover, the formal path is restored when safe and a
 * structured post-commit conflict is thrown; a missing target is a no-op.
 */
async function removeTextIfUnchanged(
  targetPath: string,
  expectedRaw: string,
  expectedArtifact?: OwnedArtifact,
): Promise<AtomicRemoveResult> {
  let target: { artifact: OwnedArtifact; snapshot: StableTextSnapshot }
  try {
    target = await captureOwnedTextArtifact(targetPath, targetPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { removed: false, restored: false, externalMutationDetected: false, quarantined: false }
    }
    throw error
  }
  if (expectedArtifact && !sameOwnedArtifact(target.artifact, expectedArtifact)) {
    throw new AtomicTextWriteOwnershipError(targetPath)
  }
  if (target.snapshot.raw !== expectedRaw) {
    return { removed: false, restored: false, externalMutationDetected: false, quarantined: false }
  }

  const stagedPath = path.join(
    path.dirname(targetPath),
    recoveryMarkerName('remove', path.basename(targetPath), randomUUID()),
  )
  await __atomicWriteTestHooks?.beforeAtomicRemoveRename?.(targetPath, stagedPath)
  await verifyOwnedArtifact(target.artifact, targetPath)
  try {
    await renameWithTransientWindowsRetry(targetPath, stagedPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { removed: false, restored: false, externalMutationDetected: false, quarantined: false }
    }
    throw error
  }
  const restoreKnownStaged = async (): Promise<{ restored: boolean; quarantined: boolean }> => {
    try {
      const current = await captureOwnedTextArtifact(stagedPath, targetPath)
      if (
        current.artifact.fileIdentity.dev !== target.artifact.fileIdentity.dev
        || current.artifact.fileIdentity.ino !== target.artifact.fileIdentity.ino
        || current.artifact.parentIdentity.dev !== target.artifact.parentIdentity.dev
        || current.artifact.parentIdentity.ino !== target.artifact.parentIdentity.ino
      ) return { restored: false, quarantined: true }
      const result = await restoreStagedGeneration(stagedPath, targetPath)
      return { restored: !result.quarantined, quarantined: result.quarantined }
    } catch {
      return { restored: false, quarantined: true }
    }
  }
  let staged: { artifact: OwnedArtifact; snapshot: StableTextSnapshot }
  try {
    staged = await captureOwnedTextArtifact(stagedPath, targetPath)
    if (
      staged.artifact.fileIdentity.dev !== target.artifact.fileIdentity.dev
      || staged.artifact.fileIdentity.ino !== target.artifact.fileIdentity.ino
      || staged.artifact.parentIdentity.dev !== target.artifact.parentIdentity.dev
      || staged.artifact.parentIdentity.ino !== target.artifact.parentIdentity.ino
    ) {
      throw new AtomicTextWriteOwnershipError(targetPath)
    }
  } catch (error) {
    // No stable artifact was captured, so the pathname may now belong to a
    // different generation. Never try to restore through it.
    throw new AtomicTextWriteOwnershipError(targetPath)
  }
  if (staged.snapshot.raw !== expectedRaw) {
    const restored = await restoreKnownStaged()
    throw new AtomicTextWritePostCommitExternalMutationError({
      replacementApplied: false,
      restored: restored.restored,
      quarantined: restored.quarantined,
    })
  }

  // This final verification is the strongest portable pathname-based check
  // available here. A directory-handle-relative unlink would be required to
  // eliminate the remaining check/use window; keep the artifact instead if
  // its ownership cannot be re-established.
  await __atomicWriteTestHooks?.beforeAtomicRemoveUnlink?.(stagedPath)
  let final: { artifact: OwnedArtifact; snapshot: StableTextSnapshot }
  try {
    final = await captureOwnedTextArtifact(stagedPath, targetPath)
  } catch {
    throw new AtomicTextWriteOwnershipError(targetPath)
  }
  if (final.artifact.fileIdentity.dev !== staged.artifact.fileIdentity.dev
    || final.artifact.fileIdentity.ino !== staged.artifact.fileIdentity.ino
    || final.artifact.parentIdentity.dev !== staged.artifact.parentIdentity.dev
    || final.artifact.parentIdentity.ino !== staged.artifact.parentIdentity.ino) {
    throw new AtomicTextWriteOwnershipError(targetPath)
  }
  if (final.snapshot.raw !== expectedRaw) {
    const restored = await restoreKnownStaged()
    throw new AtomicTextWritePostCommitExternalMutationError({
      replacementApplied: false,
      restored: restored.restored,
      quarantined: restored.quarantined,
    })
  }
  await fs.unlink(stagedPath)
  await syncParentDirectoryBestEffort(targetPath)
  return { removed: true, restored: false, externalMutationDetected: false, quarantined: false }
}

export async function atomicRemoveTextIfUnchanged(
  targetPath: string,
  expectedRaw: string,
): Promise<AtomicRemoveResult> {
  if (managedDiaryTarget(targetPath)) {
    throw new ManagedDiaryDeleteUnsupportedError(targetPath)
  }
  return removeTextIfUnchanged(targetPath, expectedRaw)
}

/**
 * Unconditional replacement: prepare + rename. Callers that need
 * external-writer safety must use atomicReplaceTextIfUnchanged (or
 * prepareAtomicTextWrite's ownership-verified commit) instead.
 */
export async function atomicReplaceText(
  targetPath: string,
  raw: string,
  options: { mode?: number } = {},
): Promise<void> {
  assertManagedDiaryBytes(targetPath, raw)
  const ownedTemporary = await writeTemporaryTextFile(targetPath, raw, options)
  try {
    await __atomicWriteTestHooks?.beforeUnconditionalReplaceRename?.(ownedTemporary.path)
    await verifyOwnedArtifact(ownedTemporary, targetPath)
    await renameWithTransientWindowsRetry(ownedTemporary.path, targetPath)
    await syncParentDirectoryBestEffort(targetPath)
  } catch (error) {
    await removeOwnedTemporaryPath(
      ownedTemporary.path,
      ownedTemporary.parentPath,
      ownedTemporary.fileIdentity,
      ownedTemporary.parentIdentity,
      targetPath,
    ).catch(() => {})
    throw error
  }
}

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { diaryDateFromPath, isManagedDiaryPath } from '../../shared/diaryProtocol.js'
import { resolveSafeRelativePathDetailed } from '../paths.js'
import { NUVYN_DIARY_MIGRATION_CIPHERTEXT_PREFIX } from '../technicalNamespace.js'
import type { CandidateDurability, GenerationRecord, MigrationFinalizeCapability } from './types.js'

const NO_FOLLOW = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0

export type CapturedSource = {
  readonly absolutePath: string
  readonly parentPath: string
  readonly generation: GenerationRecord
  readonly parentGeneration: GenerationRecord
  readonly bytes: Buffer
}

export type CiphertextCandidate = {
  readonly absolutePath: string
  readonly name: string
  readonly generation: GenerationRecord
  readonly parentGeneration: GenerationRecord
  readonly fingerprint: string
  readonly durability: CandidateDurability
}

export class DiaryMigrationFsError extends Error {
  readonly code:
  | 'SOURCE_MISSING'
  | 'UNSAFE_PATH'
  | 'TARGET_OCCUPIED'
  | 'SOURCE_GENERATION_CHANGED'
  | 'PARENT_GENERATION_CHANGED'
  | 'DURABILITY_UNKNOWN'
  | 'DURABILITY_FAILED'
  | 'CANDIDATE_MISMATCH'
  | 'FILESYSTEM_UNSUPPORTED'

  constructor(code: DiaryMigrationFsError['code'], message: string) {
    super(message)
    this.name = 'DiaryMigrationFsError'
    this.code = code
  }
}

function generationFromStat(
  stat: Awaited<ReturnType<typeof fs.lstat>>,
  parent?: Awaited<ReturnType<typeof fs.lstat>>,
): GenerationRecord {
  return {
    type: 'file',
    dev: Number(stat.dev),
    ino: Number(stat.ino),
    mtimeMs: Number(stat.mtimeMs),
    ...(parent ? { parentDev: Number(parent.dev), parentIno: Number(parent.ino) } : {}),
  }
}

function parentGenerationFromStat(stat: Awaited<ReturnType<typeof fs.lstat>>): GenerationRecord {
  return {
    type: 'file',
    dev: Number(stat.dev),
    ino: Number(stat.ino),
    mtimeMs: Number(stat.mtimeMs),
  }
}

function sameIdentity(left: GenerationRecord | null, right: GenerationRecord | null): boolean {
  if (!left || !right) return false
  return left.type === right.type
    && left.dev === right.dev
    && left.ino === right.ino
    && left.fileId === right.fileId
    && left.parentDev === right.parentDev
    && left.parentIno === right.parentIno
}

/** A reviewed source generation also includes the available modification
 * provenance.  Inode identity alone would miss an in-place external write
 * between inventory, encryption and candidate preparation. */
function sameGeneration(left: GenerationRecord | null, right: GenerationRecord | null): boolean {
  return sameIdentity(left, right)
    && (left?.mtimeNs ?? left?.mtimeMs) === (right?.mtimeNs ?? right?.mtimeMs)
}

async function lstatRegular(filePath: string, label: string): Promise<Awaited<ReturnType<typeof fs.lstat>>> {
  let stat
  try {
    stat = await fs.lstat(filePath)
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      throw new DiaryMigrationFsError('SOURCE_MISSING', `${label} is missing`)
    }
    throw error
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new DiaryMigrationFsError('UNSAFE_PATH', `${label} is not a regular file`)
  }
  return stat
}

async function syncFileAndDirectory(filePath: string, parentPath: string): Promise<void> {
  try {
    const file = await fs.open(filePath, fs.constants.O_RDONLY | NO_FOLLOW)
    try { await file.sync() } finally { await file.close() }
  } catch (error: any) {
    throw new DiaryMigrationFsError('DURABILITY_FAILED', 'ciphertext durability could not be proven')
  }
  try {
    const directory = await fs.open(parentPath, fs.constants.O_RDONLY | NO_FOLLOW)
    try { await directory.sync() } finally { await directory.close() }
  } catch (error: any) {
    // A directory fsync is a required D8.4 boundary.  Do not silently turn
    // an unknown result into PUBLISHED.
    throw new DiaryMigrationFsError(
      error?.code === 'EACCES' || error?.code === 'EPERM' || error?.code === 'EINVAL'
        ? 'DURABILITY_UNKNOWN'
        : 'DURABILITY_FAILED',
      'parent-directory durability could not be proven',
    )
  }
}

/**
 * D8.4's filesystem owner.  The POSIX implementation intentionally exposes
 * only safe inspection and ciphertext-candidate operations.  It never
 * renames, unlinks, restores or overwrites the plaintext primary.
 */
export class DiaryMigrationFs {
  readonly rootDir: string
  readonly platform: NodeJS.Platform

  constructor(rootDir: string, platform: NodeJS.Platform = process.platform) {
    this.rootDir = path.resolve(rootDir)
    this.platform = platform
  }

  selectFinalizeCapability(): MigrationFinalizeCapability {
    // No native handle-bound Windows adapter exists in the JavaScript build.
    // Falling back to the reviewed manual workflow is explicitly allowed by
    // the plan; it is never a pathname-based automatic fallback.
    return 'USER_FINALIZE_REQUIRED'
  }

  private async diaryDirectory(): Promise<{ absolute: string; resolution: Awaited<ReturnType<typeof resolveSafeRelativePathDetailed>> }> {
    try {
      const resolution = await resolveSafeRelativePathDetailed(this.rootDir, 'diary')
      // `verifySafePathResolution` is intentionally file-oriented (its final
      // identity must be a regular file).  The migration root is a directory,
      // so repeat the same identity/reparse checks with the directory type.
      for (const identity of resolution.identities) {
        const stat = await fs.lstat(identity.path)
        if (stat.isSymbolicLink() || (identity.isFinal ? !stat.isDirectory() : !stat.isDirectory())) {
          throw new DiaryMigrationFsError('UNSAFE_PATH', 'Diary root changed or is not a directory')
        }
        if (Number(stat.dev) !== identity.dev || Number(stat.ino) !== identity.ino) {
          throw new DiaryMigrationFsError('UNSAFE_PATH', 'Diary root changed while accessing it')
        }
      }
      const stat = await fs.lstat(resolution.absolute)
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new DiaryMigrationFsError('UNSAFE_PATH', 'Diary root is not a directory')
      }
      return { absolute: resolution.absolute, resolution }
    } catch (error) {
      if (error instanceof DiaryMigrationFsError) throw error
      throw new DiaryMigrationFsError('UNSAFE_PATH', 'Diary root is unavailable or unsafe')
    }
  }

  async physicalPath(logicalPath: string): Promise<{ absolute: string; parent: string }> {
    if (!isManagedDiaryPath(logicalPath)) {
      throw new DiaryMigrationFsError('UNSAFE_PATH', 'invalid managed Diary path')
    }
    const date = diaryDateFromPath(logicalPath)
    if (!date) throw new DiaryMigrationFsError('UNSAFE_PATH', 'invalid managed Diary date')
    const directory = await this.diaryDirectory()
    return { absolute: path.join(directory.absolute, `${date}.md`), parent: directory.absolute }
  }

  async captureSourceGeneration(logicalPath: string): Promise<{
    absolutePath: string
    parentPath: string
    generation: GenerationRecord
    parentGeneration: GenerationRecord
  }> {
    const target = await this.physicalPath(logicalPath)
    let parentStat
    try { parentStat = await fs.lstat(target.parent) } catch (error: any) {
      if (error?.code === 'ENOENT') throw new DiaryMigrationFsError('SOURCE_MISSING', 'Diary root is missing')
      throw error
    }
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
      throw new DiaryMigrationFsError('UNSAFE_PATH', 'Diary root is not a regular directory')
    }
    const stat = await lstatRegular(target.absolute, 'Diary primary')
    return {
      absolutePath: target.absolute,
      parentPath: target.parent,
      generation: generationFromStat(stat),
      parentGeneration: parentGenerationFromStat(parentStat),
    }
  }

  async readSource(logicalPath: string): Promise<CapturedSource> {
    const captured = await this.captureSourceGeneration(logicalPath)
    const handle = await fs.open(captured.absolutePath, fs.constants.O_RDONLY | NO_FOLLOW)
    try {
      const bytes = await handle.readFile()
      const handleStat = await handle.stat()
      const currentParent = await fs.lstat(captured.parentPath)
      const currentPath = await fs.lstat(captured.absolutePath)
      if (
        currentPath.isSymbolicLink()
        || !currentPath.isFile()
        || !sameGeneration(captured.generation, generationFromStat(currentPath))
        || !sameIdentity(captured.parentGeneration, parentGenerationFromStat(currentParent))
        || Number(handleStat.dev) !== captured.generation.dev
        || Number(handleStat.ino) !== captured.generation.ino
      ) {
        throw new DiaryMigrationFsError('SOURCE_GENERATION_CHANGED', 'Diary primary changed while reading')
      }
      return { ...captured, bytes }
    } finally {
      await handle.close()
    }
  }

  async sourceGenerationMatches(
    logicalPath: string,
    generation: GenerationRecord,
    parentGeneration: GenerationRecord,
  ): Promise<boolean> {
    try {
      const current = await this.captureSourceGeneration(logicalPath)
      return sameGeneration(current.generation, generation)
        // Candidate creation changes the containing directory mtime; parent
        // provenance therefore remains identity-only while the source file
        // generation itself includes mtime/mtimeNs.
        && sameIdentity(current.parentGeneration, parentGeneration)
    } catch (error) {
      if (error instanceof DiaryMigrationFsError && error.code === 'SOURCE_MISSING') return false
      throw error
    }
  }

  async writeCiphertextTemp(
    logicalPath: string,
    transactionId: string,
    ciphertext: Buffer,
  ): Promise<CiphertextCandidate> {
    const target = await this.physicalPath(logicalPath)
    const name = `${NUVYN_DIARY_MIGRATION_CIPHERTEXT_PREFIX}${transactionId}`
    if (!isMigrationCandidateName(name)) {
      throw new DiaryMigrationFsError('UNSAFE_PATH', 'migration candidate name is unsafe')
    }
    const absolutePath = path.join(target.parent, name)
    let handle
    try {
      handle = await fs.open(absolutePath, 'wx', 0o600)
    } catch (error: any) {
      if (error?.code === 'EEXIST') {
        throw new DiaryMigrationFsError('TARGET_OCCUPIED', 'migration ciphertext candidate already exists')
      }
      throw new DiaryMigrationFsError('FILESYSTEM_UNSUPPORTED', 'ciphertext candidate could not be created')
    }
    try {
      await handle.writeFile(ciphertext)
      await handle.sync()
    } catch {
      try { await handle.close() } catch { /* best effort */ }
      throw new DiaryMigrationFsError('DURABILITY_FAILED', 'ciphertext candidate could not be durably written')
    }
    await handle.close()
    await syncFileAndDirectory(absolutePath, target.parent)
    const stat = await lstatRegular(absolutePath, 'ciphertext candidate')
    const parentStat = await fs.lstat(target.parent)
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
      throw new DiaryMigrationFsError('UNSAFE_PATH', 'candidate parent is unsafe')
    }
    return {
      absolutePath,
      name,
      generation: generationFromStat(stat),
      parentGeneration: parentGenerationFromStat(parentStat),
      fingerprint: createHash('sha256').update(ciphertext).digest('hex'),
      durability: 'DURABLE',
    }
  }

  async readCiphertextArtifact(absolutePath: string, expectedFingerprint?: string): Promise<{
    bytes: Buffer
    generation: GenerationRecord
    parentGeneration: GenerationRecord
  }> {
    if (!isMigrationCandidateName(path.basename(absolutePath))) {
      throw new DiaryMigrationFsError('UNSAFE_PATH', 'ciphertext candidate name is unsafe')
    }
    const parentPath = path.dirname(absolutePath)
    if (path.resolve(parentPath) !== path.resolve(this.rootDir, 'diary')) {
      throw new DiaryMigrationFsError('UNSAFE_PATH', 'ciphertext candidate is outside the managed Diary directory')
    }
    let parentStat
    try {
      parentStat = await fs.lstat(parentPath)
    } catch (error: any) {
      if (error?.code === 'ENOENT') throw new DiaryMigrationFsError('SOURCE_MISSING', 'ciphertext candidate is missing')
      throw error
    }
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
      throw new DiaryMigrationFsError('UNSAFE_PATH', 'candidate parent is unsafe')
    }
    const stat = await lstatRegular(absolutePath, 'ciphertext candidate')
    const handle = await fs.open(absolutePath, fs.constants.O_RDONLY | NO_FOLLOW)
    try {
      const bytes = await handle.readFile()
      const fingerprint = createHash('sha256').update(bytes).digest('hex')
      if (expectedFingerprint && fingerprint !== expectedFingerprint) {
        throw new DiaryMigrationFsError('CANDIDATE_MISMATCH', 'ciphertext fingerprint does not match')
      }
      const after = await fs.lstat(absolutePath)
      const afterParent = await fs.lstat(parentPath)
      if (
        after.isSymbolicLink()
        || !after.isFile()
        || !sameIdentity(generationFromStat(after), generationFromStat(stat))
        || !sameIdentity(parentGenerationFromStat(afterParent), parentGenerationFromStat(parentStat))
      ) throw new DiaryMigrationFsError('SOURCE_GENERATION_CHANGED', 'ciphertext candidate changed while reading')
      return {
        bytes,
        generation: generationFromStat(after),
        parentGeneration: parentGenerationFromStat(afterParent),
      }
    } finally {
      await handle.close()
    }
  }

  /**
   * Create-only publication primitive.  It is intentionally never used to
   * replace an existing POSIX plaintext primary: an occupied canonical path
   * returns TARGET_OCCUPIED and the caller must use the user-finalize flow.
   * The primitive is still useful for a missing-target recovery boundary and
   * for a future handle-bound adapter because it has no check-then-overwrite
   * window and writes ciphertext bytes only.
   */
  async publishCiphertextCandidateCreateOnly(
    logicalPath: string,
    candidateAbsolutePath: string,
    expectedFingerprint: string,
  ): Promise<{ absolutePath: string; generation: GenerationRecord; parentGeneration: GenerationRecord }> {
    const target = await this.physicalPath(logicalPath)
    const resolvedCandidate = path.resolve(candidateAbsolutePath)
    if (path.dirname(resolvedCandidate) !== path.resolve(target.parent)
      || !isMigrationCandidateName(path.basename(resolvedCandidate))) {
      throw new DiaryMigrationFsError('UNSAFE_PATH', 'ciphertext candidate path is unsafe')
    }
    const artifact = await this.readCiphertextArtifact(resolvedCandidate, expectedFingerprint)
    let handle
    try {
      handle = await fs.open(target.absolute, 'wx', 0o600)
    } catch (error: any) {
      if (error?.code === 'EEXIST') {
        throw new DiaryMigrationFsError('TARGET_OCCUPIED', 'canonical Diary target already exists')
      }
      throw new DiaryMigrationFsError('FILESYSTEM_UNSUPPORTED', 'ciphertext target could not be created')
    }
    try {
      await handle.writeFile(artifact.bytes)
      await handle.sync()
    } catch {
      try { await handle.close() } catch { /* best effort */ }
      throw new DiaryMigrationFsError('DURABILITY_FAILED', 'ciphertext target could not be durably written')
    }
    await handle.close()
    await syncFileAndDirectory(target.absolute, target.parent)
    const stat = await lstatRegular(target.absolute, 'published ciphertext')
    const parentStat = await fs.lstat(target.parent)
    return {
      absolutePath: target.absolute,
      generation: generationFromStat(stat),
      parentGeneration: parentGenerationFromStat(parentStat),
    }
  }

  async verifyCiphertextArtifact(absolutePath: string, expectedFingerprint: string): Promise<boolean> {
    try {
      await this.readCiphertextArtifact(absolutePath, expectedFingerprint)
      return true
    } catch (error) {
      if (error instanceof DiaryMigrationFsError && ['SOURCE_MISSING', 'CANDIDATE_MISMATCH'].includes(error.code)) return false
      throw error
    }
  }

  async removeCiphertextCandidate(absolutePath: string, expectedFingerprint: string): Promise<void> {
    const artifact = await this.readCiphertextArtifact(absolutePath, expectedFingerprint)
    void artifact
    await fs.unlink(absolutePath)
    await syncDirectory(path.dirname(absolutePath))
  }

  async syncDurability(absolutePath: string): Promise<CandidateDurability> {
    await syncFileAndDirectory(absolutePath, path.dirname(absolutePath))
    return 'DURABLE'
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  try {
    const handle = await fs.open(directoryPath, fs.constants.O_RDONLY | NO_FOLLOW)
    try { await handle.sync() } finally { await handle.close() }
  } catch {
    throw new DiaryMigrationFsError('DURABILITY_UNKNOWN', 'candidate removal durability could not be proven')
  }
}

export function fingerprintCiphertext(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Candidate names are generated by this owner and are deliberately kept in
 * a narrow namespace.  Persisted names are untrusted after a crash (or a
 * database restore), so every recovery/resume path must validate before
 * joining one to the managed Diary directory.  In particular, a ledger row
 * can never turn a candidate verification into a `..`/absolute-path access.
 */
export function isMigrationCandidateName(value: unknown): value is string {
  return typeof value === 'string'
    && new RegExp(`^${NUVYN_DIARY_MIGRATION_CIPHERTEXT_PREFIX}[A-Za-z0-9-]{1,128}$`).test(value)
}

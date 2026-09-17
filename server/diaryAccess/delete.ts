import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Database as DatabaseT } from 'better-sqlite3'
import { isManagedDiaryPath } from '../../shared/diaryProtocol.js'
import {
  deleteDocumentMetadata,
  getDocumentMetadata,
  restoreDocumentMetadataMutation,
  snapshotDocumentMetadataMutation,
} from '../documentMetadata.js'
import { getIndex as getLinkIndex } from '../linkIndex.js'
import {
  removeDurableJournal,
  syncParentDirectoryBestEffort,
  writeDurableJournal,
} from '../atomicTextWrite.js'
import { recoveryMarkerName } from '../technicalNamespace.js'

/** Stable errors owned by the encrypted-Diary delete transaction. */
export type ManagedDiaryDeleteErrorCode =
  | 'diary-metadata-unavailable'
  | 'diary-delete-generation-changed'
  | 'diary-delete-index-cleanup-failed'
  | 'diary-delete-rollback-failed'
  | 'diary-delete-path-reused'

export class ManagedDiaryDeleteError extends Error {
  readonly code: ManagedDiaryDeleteErrorCode
  readonly status: 409 | 503

  constructor(code: ManagedDiaryDeleteErrorCode, status: 409 | 503, message: string) {
    super(message)
    this.name = 'ManagedDiaryDeleteError'
    this.code = code
    this.status = status
  }
}

type FileIdentity = {
  dev: string
  ino: string
  parentDev: string
  parentIno: string
}

type MetadataSnapshot = ReturnType<typeof snapshotDocumentMetadataMutation>

/** A structural-only seam for failure/race tests. It never receives body data. */
export type ManagedDiaryDeleteTestHooks = {
  afterSourceStaged?: (stagedPath: string, targetPath: string) => void | Promise<void>
  beforeMetadataDelete?: (stagedPath: string, targetPath: string) => void | Promise<void>
  beforeStagedUnlink?: (stagedPath: string, targetPath: string) => void | Promise<void>
  beforeIndexCleanup?: (targetPath: string) => void | Promise<void>
}

let testHooks: ManagedDiaryDeleteTestHooks | null = null

/** Test-only hook installation; production leaves this null. */
export function __setManagedDiaryDeleteTestHooksForTesting(hooks: ManagedDiaryDeleteTestHooks | null): void {
  testHooks = hooks
}

async function captureGeneration(targetPath: string): Promise<FileIdentity> {
  const [file, parent] = await Promise.all([
    fs.lstat(targetPath, { bigint: true }),
    fs.lstat(path.dirname(targetPath), { bigint: true }),
  ])
  if (file.isSymbolicLink() || !file.isFile() || parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new ManagedDiaryDeleteError(
      'diary-delete-generation-changed',
      409,
      'Managed Diary generation is not a regular file.',
    )
  }
  return {
    dev: file.dev.toString(),
    ino: file.ino.toString(),
    parentDev: parent.dev.toString(),
    parentIno: parent.ino.toString(),
  }
}

async function generationStillOwned(targetPath: string, expected: FileIdentity): Promise<boolean> {
  try {
    const actual = await captureGeneration(targetPath)
    return actual.dev === expected.dev
      && actual.ino === expected.ino
      && actual.parentDev === expected.parentDev
      && actual.parentIno === expected.parentIno
  } catch {
    return false
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function restoreCreateOnly(stagedPath: string, targetPath: string): Promise<boolean> {
  try {
    await fs.link(stagedPath, targetPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
  await fs.unlink(stagedPath)
  await syncParentDirectoryBestEffort(targetPath)
  return true
}

async function persistReuseQuarantine(
  stagedPath: string,
  quarantinePath: string,
  manifestPath: string,
  logicalPath: string,
  snapshot: MetadataSnapshot,
): Promise<void> {
  const identities = snapshot.documents.map((row) => ({ path: String(row.path), id: String(row.id) }))
  if (identities.length > 0) {
    // This manifest contains only structural path/identity ownership. It is
    // intentionally incapable of carrying body bytes or keys.
    await writeDurableJournal(manifestPath, {
      version: 1,
      op: 'delete-path-reuse',
      kind: 'file',
      path: logicalPath,
      inflight: path.basename(stagedPath),
      quarantine: path.basename(quarantinePath),
      identities,
    })
  }
  await fs.rename(stagedPath, quarantinePath)
  await syncParentDirectoryBestEffort(quarantinePath)
}

async function writeManagedDeleteIntent(
  manifestPath: string,
  logicalPath: string,
  stagedPath: string,
  quarantinePath: string,
  documentId: string,
  source: FileIdentity,
  snapshot: MetadataSnapshot,
): Promise<void> {
  const identities = snapshot.documents.map((row) => ({ path: String(row.path), id: String(row.id) }))
  await writeDurableJournal(manifestPath, {
    version: 1,
    op: 'delete-path-reuse',
    phase: 'managed-delete-intent',
    kind: 'file',
    path: logicalPath,
    inflight: path.basename(stagedPath),
    quarantine: path.basename(quarantinePath),
    identities,
    documentId,
    source,
  })
}

async function detachOwnedMetadata(
  db: DatabaseT,
  logicalPath: string,
): Promise<void> {
  // deleteDocumentMetadata is the existing authoritative metadata owner. The
  // snapshot used by the caller is never serialized or used for adoption.
  try {
    deleteDocumentMetadata(db, logicalPath)
  } catch {
    throw new ManagedDiaryDeleteError(
      'diary-metadata-unavailable',
      503,
      'Diary metadata cleanup is unavailable.',
    )
  }
}

/**
 * Delete one canonical managed Diary generation without opening its bytes.
 *
 * The caller owns vault/document locks and supplies the existing Diary body
 * operation lease. This owner deliberately exposes no crypto method and does
 * not call read/decrypt/gray-matter/LinkIndex.applyWrite.
 */
export async function deleteManagedDiaryDocument(options: {
  logicalPath: string
  absolutePath: string
  db: DatabaseT
  assertCurrent: () => void
}): Promise<'deleted'> {
  const { logicalPath, absolutePath, db, assertCurrent } = options
  if (!isManagedDiaryPath(logicalPath)) {
    throw new ManagedDiaryDeleteError(
      'diary-delete-generation-changed',
      409,
      'Managed Diary delete requires a canonical managed path.',
    )
  }

  let sourceIdentity: FileIdentity
  try {
    sourceIdentity = await captureGeneration(absolutePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw error
    }
    if (error instanceof ManagedDiaryDeleteError) throw error
    throw new ManagedDiaryDeleteError(
      'diary-delete-generation-changed',
      409,
      'Managed Diary generation could not be captured safely.',
    )
  }

  const metadata = getDocumentMetadata(db, logicalPath)
  if (!metadata || typeof metadata.id !== 'string' || metadata.id.length === 0) {
    throw new ManagedDiaryDeleteError(
      'diary-metadata-unavailable',
      503,
      'Diary metadata is unavailable.',
    )
  }
  const snapshot = snapshotDocumentMetadataMutation(db, [logicalPath])
  if (!snapshot.documents.some((row) => String(row.id) === metadata.id && String(row.path) === logicalPath)) {
    throw new ManagedDiaryDeleteError(
      'diary-metadata-unavailable',
      503,
      'Diary metadata identity is unavailable.',
    )
  }

  const stagedPath = path.join(
    path.dirname(absolutePath),
    recoveryMarkerName('delete-inflight', path.basename(absolutePath), randomUUID()),
  )
  const quarantinePath = path.join(
    path.dirname(absolutePath),
    recoveryMarkerName('quarantine-reuse', path.basename(absolutePath), randomUUID()),
  )
  const intentManifestPath = path.join(
    path.dirname(absolutePath),
    recoveryMarkerName('delete-manifest', path.basename(absolutePath), randomUUID()),
  )
  const reuseManifestPath = path.join(
    path.dirname(absolutePath),
    recoveryMarkerName('delete-manifest', path.basename(absolutePath), randomUUID()),
  )

  let staged = false
  let metadataDeleted = false
  let indexRemoved = false
  let ownershipLost = false
  let index: Awaited<ReturnType<typeof getLinkIndex>> | null = null

  try {
    // Persist only structural ownership before the source takeover. If the
    // process dies after rename(2), recovery can distinguish this managed
    // delete from a legacy generic delete and will never detach a fresh
    // document identity that won the canonical path race.
    assertCurrent()
    await writeManagedDeleteIntent(
      intentManifestPath,
      logicalPath,
      stagedPath,
      quarantinePath,
      metadata.id,
      sourceIdentity,
      snapshot,
    )
    // rename(2) moves the existing inode; it never creates a second body
    // copy. The post-rename identity check detects a replacement that won
    // the race before our takeover.
    assertCurrent()
    await fs.rename(absolutePath, stagedPath)
    staged = true
    await syncParentDirectoryBestEffort(stagedPath)
    await testHooks?.afterSourceStaged?.(stagedPath, absolutePath)

    if (!await generationStillOwned(stagedPath, sourceIdentity)) {
      // The source generation changed before takeover. Keep the surviving
      // bytes at the public path only if that path is still empty; otherwise
      // quarantine them and detach the old identity without adoption.
      if (await pathExists(absolutePath)) {
        await persistReuseQuarantine(stagedPath, quarantinePath, reuseManifestPath, logicalPath, snapshot)
        staged = false
        await detachOwnedMetadata(db, logicalPath)
        metadataDeleted = true
        await removeDurableJournal(intentManifestPath).catch(() => {})
        await removeDurableJournal(reuseManifestPath).catch(() => {})
        return pathReuseConflict()
      }
      // The original generation was replaced before our rename. Detach the
      // old identity before exposing the surviving foreign bytes at the
      // canonical path; never restore an old documentId onto them.
      staged = false
      ownershipLost = true
      await detachOwnedMetadata(db, logicalPath)
      metadataDeleted = true
      let intentResolved = false
      try {
        const restored = await restoreCreateOnly(stagedPath, absolutePath)
        if (!restored) {
          await persistReuseQuarantine(stagedPath, quarantinePath, reuseManifestPath, logicalPath, snapshot)
        }
        intentResolved = true
      } catch {
        // Leave the reserved staging artifact for crash recovery rather than
        // touching a generation we no longer own.
      }
      try { (await getLinkIndex()).registerPath(logicalPath) } catch { /* rebuild repairs structural state */ }
      if (intentResolved) await removeDurableJournal(intentManifestPath).catch(() => {})
      if (intentResolved) await removeDurableJournal(reuseManifestPath).catch(() => {})
      return pathReuseConflict()
    }

    assertCurrent()
    index = await getLinkIndex()
    await testHooks?.beforeIndexCleanup?.(logicalPath)

    // An external generation may have claimed the canonical path after our
    // takeover. It wins; do not applyDelete against that surviving path.
    if (await pathExists(absolutePath)) {
      await persistReuseQuarantine(stagedPath, quarantinePath, reuseManifestPath, logicalPath, snapshot)
      staged = false
      assertCurrent()
      await detachOwnedMetadata(db, logicalPath)
      metadataDeleted = true
      index.registerPath(logicalPath)
      await removeDurableJournal(intentManifestPath).catch(() => {})
      await removeDurableJournal(reuseManifestPath).catch(() => {})
      throw new ManagedDiaryDeleteError(
        'diary-delete-path-reused',
        409,
        'Managed Diary path was reused by an external generation.',
      )
    }

    // Structural-only index removal is performed while the old generation is
    // still recoverable. If it fails, restore the exact inode and metadata;
    // no body re-read or applyWrite is needed.
    try {
      index.applyDelete(logicalPath)
      indexRemoved = true
    } catch (error) {
      index.registerPath(logicalPath)
      throw new ManagedDiaryDeleteError(
        'diary-delete-index-cleanup-failed',
        503,
        'Managed Diary structural index cleanup failed.',
      )
    }

    assertCurrent()
    await testHooks?.beforeMetadataDelete?.(stagedPath, absolutePath)
    await detachOwnedMetadata(db, logicalPath)
    metadataDeleted = true

    assertCurrent()
    // Never unlink a staging name whose inode was replaced by another
    // writer. Mark ownership lost so the rollback path cannot restore or
    // delete foreign bytes; startup recovery will reconcile the reserved
    // artifact conservatively.
    if (!await generationStillOwned(stagedPath, sourceIdentity)) {
      staged = false
      ownershipLost = true
      if (!metadataDeleted) await detachOwnedMetadata(db, logicalPath)
      metadataDeleted = true
      try { (await getLinkIndex()).registerPath(logicalPath) } catch { /* rebuild repairs structural state */ }
      throw new ManagedDiaryDeleteError(
        'diary-delete-generation-changed',
        409,
        'Managed Diary staging generation changed during delete.',
      )
    }
    await testHooks?.beforeStagedUnlink?.(stagedPath, absolutePath)
    await fs.unlink(stagedPath)
    staged = false
    await syncParentDirectoryBestEffort(absolutePath)
    // A cleanup failure must not turn a completed opaque delete into a
    // metadata/file resurrection. Leaving this structural intent for startup
    // recovery is safe; the recovery owner removes it once no artifact is
    // present.
    await removeDurableJournal(intentManifestPath).catch(() => {})

    // A writer that arrived during the final unlink is foreign to this
    // transaction. Keep it untouched, restore structural existence, and
    // report a stable conflict; the old identity is already detached.
    if (await pathExists(absolutePath)) {
      index.registerPath(logicalPath)
      throw new ManagedDiaryDeleteError(
        'diary-delete-path-reused',
        409,
        'Managed Diary path was reused by an external generation.',
      )
    }
    return 'deleted'
  } catch (error) {
    // An intentional path-reuse disposition has already quarantined the old
    // inode and detached its identity. It must not be rolled back onto the
    // foreign generation.
    if (error instanceof ManagedDiaryDeleteError && error.code === 'diary-delete-path-reused') {
      throw error
    }

    const rollbackErrors: unknown[] = []
    if (staged && await pathExists(stagedPath)) {
      try {
        // A staging name is private to this transaction, but a crash,
        // recovery worker, or hostile local writer can still replace it. Do
        // not create a canonical link to an inode we no longer own while
        // handling an unrelated failure.
        if (!await generationStillOwned(stagedPath, sourceIdentity)) {
          ownershipLost = true
          await persistReuseQuarantine(stagedPath, quarantinePath, reuseManifestPath, logicalPath, snapshot)
          staged = false
          if (!metadataDeleted) {
            await detachOwnedMetadata(db, logicalPath)
            metadataDeleted = true
          }
          if (indexRemoved) index?.registerPath(logicalPath)
          await removeDurableJournal(intentManifestPath).catch(() => {})
          await removeDurableJournal(reuseManifestPath).catch(() => {})
          throw new ManagedDiaryDeleteError(
            'diary-delete-generation-changed',
            409,
            'Managed Diary staging generation changed during rollback.',
          )
        }
        if (!await pathExists(absolutePath)) {
          const restored = await restoreCreateOnly(stagedPath, absolutePath)
          if (restored) {
            staged = false
            if (metadataDeleted) restoreDocumentMetadataMutation(db, snapshot)
            if (indexRemoved) index?.registerPath(logicalPath)
            await removeDurableJournal(intentManifestPath).catch(() => {})
          } else {
            await persistReuseQuarantine(stagedPath, quarantinePath, reuseManifestPath, logicalPath, snapshot)
            staged = false
            if (!metadataDeleted) await detachOwnedMetadata(db, logicalPath)
            await removeDurableJournal(intentManifestPath).catch(() => {})
            await removeDurableJournal(reuseManifestPath).catch(() => {})
            index?.registerPath(logicalPath)
            throw new ManagedDiaryDeleteError(
              'diary-delete-path-reused',
              409,
              'Managed Diary path was reused by an external generation.',
            )
          }
        } else {
          await persistReuseQuarantine(stagedPath, quarantinePath, reuseManifestPath, logicalPath, snapshot)
          staged = false
          if (!metadataDeleted) await detachOwnedMetadata(db, logicalPath)
          await removeDurableJournal(intentManifestPath).catch(() => {})
          await removeDurableJournal(reuseManifestPath).catch(() => {})
          index?.registerPath(logicalPath)
          throw new ManagedDiaryDeleteError(
            'diary-delete-path-reused',
            409,
            'Managed Diary path was reused by an external generation.',
          )
        }
      } catch (rollbackError) {
        if (rollbackError instanceof ManagedDiaryDeleteError
          && rollbackError.code === 'diary-delete-path-reused') throw rollbackError
        rollbackErrors.push(rollbackError)
      }
    } else if (metadataDeleted && !ownershipLost) {
      try { restoreDocumentMetadataMutation(db, snapshot) } catch (rollbackError) { rollbackErrors.push(rollbackError) }
      if (indexRemoved) index?.registerPath(logicalPath)
    }

    if (rollbackErrors.length > 0) {
      throw new ManagedDiaryDeleteError(
        'diary-delete-rollback-failed',
        503,
        'Managed Diary delete failed and could not be rolled back safely.',
      )
    }
    if (error instanceof ManagedDiaryDeleteError) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error
    throw new ManagedDiaryDeleteError(
      'diary-delete-generation-changed',
      409,
      'Managed Diary delete failed safely; retry if the document remains.',
    )
  }
}

function pathReuseConflict(): never {
  throw new ManagedDiaryDeleteError(
    'diary-delete-path-reused',
    409,
    'Managed Diary path was reused by an external generation.',
  )
}

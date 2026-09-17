import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Database as DatabaseT } from 'better-sqlite3'

import {
  AtomicTextWriteConflictError,
  AtomicTextWriteOwnershipError,
  AtomicTextWritePostCommitExternalMutationError,
  AtomicTextWriteTargetMissingError,
  atomicRemoveTextIfUnchanged,
  atomicReplaceTextIfUnchanged,
  prepareAtomicTextCreate,
  readStableTextSnapshot,
  type StableTextSnapshot,
} from '../atomicTextWrite.js'
import {
  ensureDocumentMetadata,
  getDocumentMetadata,
  getDocumentMetadataById,
  recordCommittedDocumentMutation,
  restoreDocumentMetadataMutation,
  snapshotDocumentMetadataMutation,
} from '../documentMetadata.js'
import { withDocumentWriteLock, withVaultStructureLock } from '../documentWriteLock.js'
import { isPhysicallyContained } from '../documentFileLifecycle.js'
import { assertPathNotOwnedByFolderMove, FolderMovePathOwnedError } from '../folderMoveJournalOwnership.js'
import { withVaultMutation } from '../vaultMutation.js'
import {
  resolveSafeRelativePathDetailed,
  verifySafePathResolution,
  type SafePathResolution,
} from '../paths.js'
import * as git from './git.js'
import {
  abortHistoryMetadataRestore,
  applyCoveredHistoricalMetadata,
  HistoryMetadataError,
  historicalBodySha,
  metadataImage,
  metadataTombstoneMatches,
  prepareHistoryMetadataRestore,
  reconcileHistoryMetadata,
  resolveHistoryMetadataRevision,
} from './metadataRevisions.js'
import { ensureRepoWithinVaultMutation } from './repo.js'
import { validateDocumentMutation } from '../documentMutationPolicy.js'
import { isManagedDiaryPath } from '../../shared/diaryProtocol.js'

export class HistoryRestoreNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HistoryRestoreNotFoundError'
  }
}

/** Service-level defense in depth for encrypted managed Diary History. */
export class ManagedDiaryHistoryRestoreUnsupportedError extends Error {
  readonly code = 'diary-history-encrypted-unsupported'

  constructor(path: string) {
    super(`managed Diary History restore is unsupported: ${path}`)
    this.name = 'ManagedDiaryHistoryRestoreUnsupportedError'
  }
}

export class HistoryRestoreConflictError extends Error {
  readonly code: 'HISTORY_CONTENT_CHANGED' | 'HISTORY_PATH_MOVED'

  constructor(
    message: string,
    code: HistoryRestoreConflictError['code'],
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'HistoryRestoreConflictError'
    this.code = code
  }
}

export type HistoryRestoreResult = {
  path: string
  ref: string
  resolvedRef: string
  raw: string
  mtime: number
  metadataMode: 'restored' | 'unavailable'
  metadataReason?: 'pre-coverage' | 'untracked' | 'pre-mood-schema'
  metadataRestored: boolean
  metadataPreserved: boolean
}

async function currentSnapshot(target: string): Promise<StableTextSnapshot | null> {
  try {
    return await readStableTextSnapshot(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function restoreHistoricalDocument(input: {
  repoRoot: string
  path: string
  ref: string
  db: DatabaseT
  beforeMutation?: () => void | Promise<void>
  beforeCommit?: () => void | Promise<void>
  afterPrepare?: () => void | Promise<void>
  afterCommit?: () => void | Promise<void>
}): Promise<HistoryRestoreResult> {
  const logicalPath = input.path.slice(0, -'.md'.length)
  // Reject before withVaultMutation, metadata reconciliation, vault-id reads,
  // locks, historical raw reads, journals, or any filesystem mutation.
  if (isManagedDiaryPath(logicalPath)) {
    throw new ManagedDiaryHistoryRestoreUnsupportedError(logicalPath)
  }
  return withVaultMutation(input.repoRoot, async () => {
    await ensureRepoWithinVaultMutation(input.repoRoot)
    await reconcileHistoryMetadata(input.db, input.repoRoot)
    const vaultId = await git.ensureNuvynVaultId(input.repoRoot)
    return withVaultStructureLock(() => withDocumentWriteLock(logicalPath, async () => {
      await assertPathNotOwnedByFolderMove(input.repoRoot, input.path)

      let target: string
      let targetResolution: SafePathResolution
      try {
        targetResolution = await resolveSafeRelativePathDetailed(
          input.repoRoot,
          input.path,
          { allowMissingFinal: true },
        )
        target = targetResolution.absolute
      } catch (error: any) {
        if (error?.code === 'ENOENT') {
          throw new HistoryRestoreConflictError(
            `document path moved before restore: ${logicalPath}`,
            'HISTORY_PATH_MOVED',
            { cause: error },
          )
        }
        throw error
      }

      const resolvedRef = await git.resolveCommit(input.repoRoot, input.ref)
      if (!resolvedRef) {
        throw new HistoryRestoreNotFoundError(`invalid reference ${input.ref}`)
      }
      const historicalRaw = await git.rawAt(input.repoRoot, resolvedRef, input.path)
      if (historicalRaw === null) {
        throw new HistoryRestoreNotFoundError(
          `file does not exist at ref ${input.ref}`,
        )
      }

      const metadataRevision = resolveHistoryMetadataRevision(input.db, {
        vaultId,
        commitSha: resolvedRef,
        pathAtRevision: input.path,
      })
      if (metadataRevision.kind === 'covered'
        && (!metadataRevision.bodySha || historicalBodySha(historicalRaw) !== metadataRevision.bodySha)) {
        throw new HistoryMetadataError(
          'HISTORY_METADATA_BODY_MISMATCH',
          `historical body does not match metadata binding: ${logicalPath}`,
        )
      }

      await input.beforeMutation?.()
      try {
        targetResolution = await resolveSafeRelativePathDetailed(
          input.repoRoot,
          input.path,
          { allowMissingFinal: true },
        )
      } catch (error: any) {
        if (error?.code === 'ENOENT' || /symbolic links|path segment|path root/i.test(error?.message ?? '')) {
          throw new HistoryRestoreConflictError(
            `document path moved before restore: ${logicalPath}`,
            'HISTORY_PATH_MOVED',
            { cause: error },
          )
        }
        throw error
      }
      target = targetResolution.absolute
      await verifySafePathResolution(targetResolution)
      const leaf = await fs.lstat(target).catch(() => null)
      if (leaf && (!leaf.isFile() || leaf.isSymbolicLink())) {
        throw new HistoryRestoreConflictError(
          `document path moved before restore: ${logicalPath}`,
          'HISTORY_PATH_MOVED',
        )
      }
      const before = await currentSnapshot(target)
      if (before) {
        validateDocumentMutation({
          operation: 'write',
          destinationPath: logicalPath,
          destinationExists: true,
        })
      } else {
        // historicalRaw was read from the resolved Git ref above. That is
        // the server-side prior-content proof for this create-only restore.
        // Generic /api/recover has no equivalent proof and is fail-closed for
        // Diary paths, so keep this mutation kind distinct from generic
        // recovery.
        validateDocumentMutation({ operation: 'history-restore', destinationPath: logicalPath })
      }

      const liveMetadata = getDocumentMetadata(input.db, logicalPath)
      const isPreMoodCoveredRevision = metadataRevision.kind === 'covered'
        && metadataRevision.metadataCompatibility === 'pre-mood-schema'
      if (metadataRevision.kind === 'covered') {
        // A covered revision can only restore into the same stable document
        // generation. A missing row is legal only when the existing delete
        // lifecycle left a matching tombstone; path equality alone is not an
        // identity proof. Pre-Mood Diary revisions are proof-bearing too, but
        // cannot rehydrate a missing current generation because their payload
        // has no historical Mood image to restore.
        if (liveMetadata) {
          if (liveMetadata.id !== metadataRevision.documentId
            || liveMetadata.path !== logicalPath
            || metadataRevision.generationId !== liveMetadata.id) {
            throw new HistoryMetadataError(
              'HISTORY_METADATA_IDENTITY_CONFLICT',
              `current document generation does not match history: ${logicalPath}`,
            )
          }
        } else if (isPreMoodCoveredRevision
          || before
          || !metadataTombstoneMatches(input.db, logicalPath, metadataRevision.documentId)
          || getDocumentMetadataById(input.db, metadataRevision.documentId)) {
          throw new HistoryMetadataError(
            'HISTORY_METADATA_IDENTITY_CONFLICT',
            `historical document generation cannot be proven for: ${logicalPath}`,
          )
        }
      }

      if (metadataRevision.kind === 'covered' && !isPreMoodCoveredRevision) {
        const targetMetadata = 'mood' in metadataRevision.values
          ? {
              id: metadataRevision.documentId,
              path: logicalPath,
              title: metadataRevision.values.title,
              summary: metadataRevision.values.summary,
              tags: metadataRevision.values.tags,
              mood: metadataRevision.values.mood,
            }
          : {
              id: metadataRevision.documentId,
              path: logicalPath,
              title: metadataRevision.values.title,
              summary: metadataRevision.values.summary,
              tags: metadataRevision.values.tags,
              mood: liveMetadata?.mood ?? null,
            }
        const journal = prepareHistoryMetadataRestore({
          db: input.db,
          vaultId,
          commitSha: resolvedRef,
          pathAtRevision: input.path,
          documentId: metadataRevision.documentId,
          generationId: metadataRevision.generationId,
          beforeRaw: before?.raw ?? null,
          beforeMetadata: metadataImage(liveMetadata),
          targetRaw: historicalRaw,
          targetMetadata,
          targetDigest: metadataRevision.payloadDigest,
        })
        let committed = false
        let metadataApplied = false
        try {
          if (before) {
            if (before.raw !== historicalRaw) {
              await input.beforeCommit?.()
              await verifySafePathResolution(targetResolution)
              await atomicReplaceTextIfUnchanged(
                target,
                before.raw,
                historicalRaw,
                { mode: before.stat.mode },
              )
              committed = true
              await input.afterCommit?.()
            }
          } else {
            // A covered create-only restore is allowed only after the
            // tombstone/generation preflight above. The filesystem operation
            // remains the existing create-only, symlink-safe protocol.
            await input.beforeCommit?.()
            let createResolution: SafePathResolution
            try {
              createResolution = await resolveSafeRelativePathDetailed(
                input.repoRoot,
                input.path,
                { allowMissingFinal: true },
              )
              await verifySafePathResolution(createResolution)
            } catch (error: any) {
              if (error?.code === 'ENOENT' || /symbolic links|path segment|path root/i.test(error?.message ?? '')) {
                throw new HistoryRestoreConflictError(
                  `document path moved before restore: ${logicalPath}`,
                  'HISTORY_PATH_MOVED',
                  { cause: error },
                )
              }
              throw error
            }
            targetResolution = createResolution
            target = createResolution.absolute
            const parent = path.dirname(target)
            const parentStat = await fs.lstat(parent).catch(() => null)
            const targetStat = await fs.lstat(target).catch((error: any) => {
              if (error?.code === 'ENOENT') return null
              throw error
            })
            if (!parentStat
              || !parentStat.isDirectory()
              || parentStat.isSymbolicLink()
              || !await isPhysicallyContained(input.repoRoot, parent)
              || targetStat !== null) {
              throw new HistoryRestoreConflictError(
                targetStat !== null
                  ? `document content changed before restore: ${logicalPath}`
                  : `document path moved before restore: ${logicalPath}`,
                targetStat !== null ? 'HISTORY_CONTENT_CHANGED' : 'HISTORY_PATH_MOVED',
              )
            }
            const prepared = await prepareAtomicTextCreate(target, historicalRaw)
            try {
              await input.afterPrepare?.()
              await verifySafePathResolution(targetResolution)
              await prepared.commit()
              committed = true
              await input.afterCommit?.()
            } catch (error) {
              let cleanupError: unknown
              try {
                await prepared.rollback()
              } catch (rollbackError) {
                cleanupError = rollbackError
              }
              if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
                throw new HistoryRestoreConflictError(
                  `document content changed before restore: ${logicalPath}`,
                  'HISTORY_CONTENT_CHANGED',
                  { cause: cleanupError ? new AggregateError([error, cleanupError]) : error },
                )
              }
              if (cleanupError) {
                throw new HistoryRestoreConflictError(
                  `document path moved before restore: ${logicalPath}`,
                  'HISTORY_PATH_MOVED',
                  { cause: new AggregateError([error, cleanupError]) },
                )
              }
              throw error
            }
          }

          const postResolution = await resolveSafeRelativePathDetailed(input.repoRoot, input.path)
          await verifySafePathResolution(postResolution)
          const observed = await readStableTextSnapshot(postResolution.absolute)
          await verifySafePathResolution(postResolution)
          if (observed.raw !== historicalRaw) {
            throw new HistoryRestoreConflictError(
              `document content changed before restore completed: ${logicalPath}`,
              'HISTORY_CONTENT_CHANGED',
            )
          }

          applyCoveredHistoricalMetadata({
            db: input.db,
            operationId: journal.operationId,
            path: logicalPath,
            documentId: metadataRevision.documentId,
            generationId: metadataRevision.generationId,
            expectedUpdatedAt: liveMetadata?.updatedAt ?? null,
            allowRehydrate: !before,
            values: metadataRevision.values,
          })
          metadataApplied = true
          return {
            path: input.path,
            ref: input.ref,
            resolvedRef,
            raw: historicalRaw,
            mtime: observed.stat.mtimeMs,
            metadataMode: 'restored' as const,
            metadataRestored: true,
            metadataPreserved: false,
          }
        } catch (error) {
          const rollbackFailures: unknown[] = []
          if (committed) {
            try {
              const rollbackResolution = await resolveSafeRelativePathDetailed(
                input.repoRoot,
                input.path,
              )
              await verifySafePathResolution(rollbackResolution)
              if (!before) await atomicRemoveTextIfUnchanged(rollbackResolution.absolute, historicalRaw)
              else await atomicReplaceTextIfUnchanged(
                rollbackResolution.absolute,
                historicalRaw,
                before.raw,
                { mode: before.stat.mode },
              )
            } catch (rollbackError) {
              if (!(rollbackError instanceof AtomicTextWriteConflictError)) rollbackFailures.push(rollbackError)
            }
          }
          if (!metadataApplied && rollbackFailures.length === 0) {
            try { abortHistoryMetadataRestore(input.db, journal.operationId, error) } catch (journalError) { rollbackFailures.push(journalError) }
          }
          if (rollbackFailures.length > 0) {
            throw new AggregateError(
              [error, ...rollbackFailures],
              'History Restore failed and rollback was incomplete',
            )
          }
          if (error instanceof FolderMovePathOwnedError) {
            throw new HistoryRestoreConflictError(
              error.message,
              'HISTORY_PATH_MOVED',
              { cause: error },
            )
          }
          if (error instanceof AtomicTextWriteConflictError
            || error instanceof AtomicTextWriteTargetMissingError) {
            throw new HistoryRestoreConflictError(
              `document content changed before restore: ${logicalPath}`,
              'HISTORY_CONTENT_CHANGED',
              { cause: error },
            )
          }
          if (error instanceof AtomicTextWriteOwnershipError) {
            throw new HistoryRestoreConflictError(
              `document path moved before restore completed: ${logicalPath}`,
              'HISTORY_PATH_MOVED',
              { cause: error },
            )
          }
          if (error instanceof AtomicTextWritePostCommitExternalMutationError) {
            throw new HistoryRestoreConflictError(
              `document content changed during restore and was preserved: ${logicalPath}`,
              'HISTORY_CONTENT_CHANGED',
              { cause: error },
            )
          }
          if (error instanceof Error && (
            /symbolic links|path changed while accessing|path segment|path root/i.test(error.message)
            || (error as NodeJS.ErrnoException).code === 'EPERM'
          )) {
            throw new HistoryRestoreConflictError(
              `document path moved before restore completed: ${logicalPath}`,
              'HISTORY_PATH_MOVED',
              { cause: error },
            )
          }
          throw error
        }
      }

      // Untracked/pre-coverage revisions remain ordinary body-only restores.
      // A trusted pre-Mood Diary revision reaches this same body-only mutation
      // path only after the covered body, identity, and generation proofs
      // above have succeeded. Its current durable metadata is preserved; it
      // is never inferred from historical Frontmatter or upgraded to a
      // synthetic Mood value.
      const hadMetadata = liveMetadata !== null
      const metadataReason = metadataRevision.kind === 'covered'
        ? 'pre-mood-schema' as const
        : metadataRevision.reason
      const databaseSnapshot = snapshotDocumentMetadataMutation(input.db, [logicalPath])
      let committed = false
      let created = false
      try {
        if (before) {
          if (hadMetadata) ensureDocumentMetadata(input.db, logicalPath, before.raw, before.stat.mtimeMs)
          if (before.raw !== historicalRaw) {
            await input.beforeCommit?.()
            await verifySafePathResolution(targetResolution)
            await atomicReplaceTextIfUnchanged(
              target,
              before.raw,
              historicalRaw,
              { mode: before.stat.mode },
            )
            committed = true
            await input.afterCommit?.()
          }
        } else {
          // For a create-only Restore, the last caller-controlled hook must
          // run before Nuvyn creates any hidden temporary file. Re-resolve
          // the parent after the hook so a moved/replaced directory cannot
          // cause cleanup to follow a later symlink.
          await input.beforeCommit?.()
          let createResolution: SafePathResolution
          try {
            createResolution = await resolveSafeRelativePathDetailed(
              input.repoRoot,
              input.path,
              { allowMissingFinal: true },
            )
            await verifySafePathResolution(createResolution)
          } catch (error: any) {
            if (error?.code === 'ENOENT' || /symbolic links|path segment|path root/i.test(error?.message ?? '')) {
              throw new HistoryRestoreConflictError(
                `document path moved before restore: ${logicalPath}`,
                'HISTORY_PATH_MOVED',
                { cause: error },
              )
            }
            throw error
          }
          targetResolution = createResolution
          target = createResolution.absolute
          const parent = path.dirname(target)
          const parentStat = await fs.lstat(parent).catch(() => null)
          const targetStat = await fs.lstat(target).catch((error: any) => {
            if (error?.code === 'ENOENT') return null
            throw error
          })
          if (!parentStat
            || !parentStat.isDirectory()
            || parentStat.isSymbolicLink()
            || !await isPhysicallyContained(input.repoRoot, parent)
            || targetStat !== null) {
            throw new HistoryRestoreConflictError(
              targetStat !== null
                ? `document content changed before restore: ${logicalPath}`
                : `document path moved before restore: ${logicalPath}`,
              targetStat !== null ? 'HISTORY_CONTENT_CHANGED' : 'HISTORY_PATH_MOVED',
            )
          }
          const prepared = await prepareAtomicTextCreate(target, historicalRaw)
          try {
            await input.afterPrepare?.()
            await verifySafePathResolution(targetResolution)
            await prepared.commit()
            committed = true
            created = true
            await input.afterCommit?.()
          } catch (error) {
            let cleanupError: unknown
            try {
              await prepared.rollback()
            } catch (rollbackError) {
              cleanupError = rollbackError
            }
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
              throw new HistoryRestoreConflictError(
                `document content changed before restore: ${logicalPath}`,
                'HISTORY_CONTENT_CHANGED',
                { cause: cleanupError ? new AggregateError([error, cleanupError]) : error },
              )
            }
            if (cleanupError) {
              throw new HistoryRestoreConflictError(
                `document path moved before restore: ${logicalPath}`,
                'HISTORY_PATH_MOVED',
                { cause: new AggregateError([error, cleanupError]) },
              )
            }
            throw error
          }
        }

        const postResolution = await resolveSafeRelativePathDetailed(input.repoRoot, input.path)
        await verifySafePathResolution(postResolution)
        const observed = await readStableTextSnapshot(postResolution.absolute)
        await verifySafePathResolution(postResolution)
        if (observed.raw !== historicalRaw) {
          throw new HistoryRestoreConflictError(
            `document content changed before restore completed: ${logicalPath}`,
            'HISTORY_CONTENT_CHANGED',
          )
        }
        if (hadMetadata) {
          committed
            ? recordCommittedDocumentMutation(input.db, logicalPath, observed.raw, observed.stat.mtimeMs, Date.now())
            : ensureDocumentMetadata(input.db, logicalPath, observed.raw, observed.stat.mtimeMs)
        }
        return {
          path: input.path,
          ref: input.ref,
          resolvedRef,
          raw: historicalRaw,
          mtime: observed.stat.mtimeMs,
          metadataMode: 'unavailable' as const,
          metadataReason,
          metadataRestored: false,
          metadataPreserved: true,
        }
      } catch (error) {
        const rollbackFailures: unknown[] = []
        if (committed) {
          try {
            const rollbackResolution = await resolveSafeRelativePathDetailed(
              input.repoRoot,
              input.path,
            )
            await verifySafePathResolution(rollbackResolution)
            if (created) await atomicRemoveTextIfUnchanged(rollbackResolution.absolute, historicalRaw)
            else if (before) {
              await atomicReplaceTextIfUnchanged(
                rollbackResolution.absolute,
                historicalRaw,
                before.raw,
                { mode: before.stat.mode },
              )
            }
          } catch (rollbackError) {
            if (!(rollbackError instanceof AtomicTextWriteConflictError)) {
              rollbackFailures.push(rollbackError)
            }
          }
        }
        try {
          restoreDocumentMetadataMutation(input.db, databaseSnapshot)
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError)
        }
        if (rollbackFailures.length > 0) {
          throw new AggregateError(
            [error, ...rollbackFailures],
            'History Restore failed and rollback was incomplete',
          )
        }
        if (error instanceof FolderMovePathOwnedError) {
          throw new HistoryRestoreConflictError(
            error.message,
            'HISTORY_PATH_MOVED',
            { cause: error },
          )
        }
        if (error instanceof AtomicTextWriteConflictError
          || error instanceof AtomicTextWriteTargetMissingError) {
          throw new HistoryRestoreConflictError(
            `document content changed before restore: ${logicalPath}`,
            'HISTORY_CONTENT_CHANGED',
            { cause: error },
          )
        }
        if (error instanceof AtomicTextWriteOwnershipError) {
          throw new HistoryRestoreConflictError(
            `document path moved before restore completed: ${logicalPath}`,
            'HISTORY_PATH_MOVED',
            { cause: error },
          )
        }
        if (error instanceof AtomicTextWritePostCommitExternalMutationError) {
          throw new HistoryRestoreConflictError(
            `document content changed during restore and was preserved: ${logicalPath}`,
            'HISTORY_CONTENT_CHANGED',
            { cause: error },
          )
        }
        if (error instanceof Error && (
          /symbolic links|path changed while accessing|path segment|path root/i.test(error.message)
          || (error as NodeJS.ErrnoException).code === 'EPERM'
        )) {
          throw new HistoryRestoreConflictError(
            `document path moved before restore completed: ${logicalPath}`,
            'HISTORY_PATH_MOVED',
            { cause: error },
          )
        }
        throw error
      }
    }))
  })
}

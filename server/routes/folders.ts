import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Database as DatabaseT } from 'better-sqlite3'
import { Hono } from 'hono'
import { canModify } from '../../shared/archiveProtocol.js'
import { classifyDiaryPath } from '../../shared/diaryProtocol.js'
import { AtomicTextWriteConflictError, atomicReplaceTextIfUnchanged, removeDurableJournal, rewriteDurableJournal, sha256Hex, syncParentDirectoryBestEffort, verifyDirectoryGeneration, writeDurableJournal } from '../atomicTextWrite.js'
import {
  deleteDocumentMetadata,
  deleteDocumentMetadataPrefix,
  getDocumentMetadata,
  moveDocumentMetadataPrefix,
  restoreDocumentMetadataMutation,
  snapshotDocumentMetadataMutationCurrentOwnership,
  snapshotDocumentMetadataPrefixMutation,
} from '../documentMetadata.js'
import {
  getCreateOnlyMoveHooksForTesting,
  resolveDirectoryMoveStrategy,
  RenameDestinationOccupiedError,
  RenameSourceReusedError,
  UnsupportedDirectoryMoveError,
  isPhysicallyContained,
  verifyFolderMoveDestinationV4,
} from '../documentFileLifecycle.js'
import {
  buildMetadataOwnershipFootprint,
  createFolderMoveGateProof,
  FOLDER_MOVE_JOURNAL_VERSION,
  listPhysicalMoveEntries,
  ManagedDiaryFolderMoveUnsupportedError,
  reviveMetadataSnapshot,
  serializeMetadataSnapshot,
  type FolderMoveJournalV4,
} from '../folderMoveTransaction.js'
import {
  AtomicRenameLandedGenerationReadError,
  executeFolderMoveV4Physical,
  FolderMoveExactParityError,
  FolderMoveGenerationMismatchError,
  FolderMoveV4ExecutionError,
} from '../folderMoveV4Executor.js'
import { readDurableFolderMoveJournalV4 } from '../folderMoveV4DurableJournal.js'
import {
  removeFolderMoveGateProof,
  verifyFolderMoveGateProof,
  writeFolderMoveGateProof,
} from '../folderMoveGateProof.js'
import {
  completeFolderMoveV4Metadata,
  verifyMetadataSnapshotGraphExact,
} from '../folderMoveV4Metadata.js'
import { withDocumentWriteLock, withDocumentWriteLocks, withVaultStructureLock } from '../documentWriteLock.js'
import { withVaultMutation } from '../vaultMutation.js'
import { getIndex as getLinkIndex } from '../linkIndex.js'
import {
  prepareRenameReferenceJournal,
  type PreparedRenameReferenceJournal,
} from '../renameReferenceJournal.js'
import {
  bindOwnerPending,
  markOwnerDurable,
} from '../renameReferenceOwnerBinding.js'
import { captureFolderMoveDirectoryEntries } from '../folderMoveDirectoryOwnership.js'
import { captureDurableDirectoryIdentity } from '../durableDirectoryIdentity.js'
import { CONTENT_DIR, filePathFor, folderPathFor, isValidPathSyntax } from '../paths.js'
import { rewriteDocumentReferences } from '../renameReferences.js'
import { listSubtreePaths } from '../tree.js'
import { bad, ensureMetadata, exists, metadataDb, recordCommittedMetadata } from './shared.js'
import { nextMetadataBatchUpdatedAt } from '../metadataVersion.js'
import { validateFolderMutation } from '../documentMutationPolicy.js'
import { rejectManagedDiaryReferenceFootprint, requireDiaryBodyAccess } from '../diaryAccess/guard.js'
import { recoveryMarkerName } from '../technicalNamespace.js'

const folderRoutes = new Hono()

/**
 * Test-only seam for the folder lifecycle race regressions: fires
 * inside the structure + document locks, immediately after the
 * in-lock subtree re-validation and before any side effect — the
 * exact window in which a concurrent membership operation would have
 * to be absorbed. `afterRenamePlanBuilt` fires after the reference
 * snapshots and every footprint check are complete, immediately
 * before the reference write loop — the exact window in which an
 * EXTERNAL editor's save to a reference file must be detected by the
 * ownership-verified reference writes. Null in production (never set
 * outside tests).
 */
export type FolderRaceHooks = {
  afterRenameRecheck?: () => void | Promise<void>
  afterRenamePlanBuilt?: () => void | Promise<void>
  afterDeleteRecheck?: () => void | Promise<void>
  /** Fires after a folder rename's rollback move restored the tree,
   * BEFORE the metadata snapshot is re-installed — the kill point
   * "all files back, metadata pending". */
  afterRollbackMove?: () => void | Promise<void>
  /** Fault injection for crash children (no vi.spyOn in a spawned
   * child): fail the staged-tree removal so the delete route takes
   * its rollback path. */
  failDeleteRemoval?: boolean
  /** Fault injection: fail the rollback journal direction flip, to
   * prove the replayable reverse move refuses to start without its
   * durable journal (round-8 P1). */
  failJournalFlip?: boolean
  /** Fires after a delete rollback's prepared snapshot-restore journal
   * is durable, before its physical executor starts. */
  afterDeleteRollbackPrepared?: (journalAbs: string) => void | Promise<void>
  /** Fires after a rename rollback's prepared snapshot-restore journal
   * is durable, before the reverse destination gate is created. */
  afterRenameRollbackPrepared?: (journalAbs: string) => void | Promise<void>
  /** Fires after every planned reference replacement landed, before its
   * companion journal is removed. Tests use this to force the real
   * rollback path after reference bytes changed. */
  afterReferenceWrites?: () => void | Promise<void>
  /** Fires after the rename rollback companion is rewritten as
   * folder-snapshot-owner-pending — the first durable write of the
   * two-step P0-1 owner binding protocol. */
  afterBindOwnerPending?: () => void | Promise<void>
  /** Fires after the flipped v4 owner folder journal is durable but
   * before the companion is promoted to folder-snapshot-owned. */
  afterV4OwnerJournalDurable?: () => void | Promise<void>
  /** Fires after the companion is rewritten as
   * folder-snapshot-owned / metadataHandled=false. */
  afterOwnerDurableMark?: () => void | Promise<void>
}
let __folderRaceHooks: FolderRaceHooks | null = null
export function __setFolderRaceHooksForTesting(hooks: FolderRaceHooks | null): void {
  __folderRaceHooks = hooks
}

function cloneFolderMoveJournal(
  journal: FolderMoveJournalV4,
): FolderMoveJournalV4 {
  return JSON.parse(JSON.stringify(journal)) as FolderMoveJournalV4
}

async function restoreForwardJournalAfterReverseContention(
  db: DatabaseT,
  journalAbs: string,
  forwardJournal: FolderMoveJournalV4,
  sourceAbs: string,
  destinationAbs: string,
  options: {
    requireSourceOccupancy: boolean
  },
): Promise<
  | { restored: true }
  | { restored: false; reason: string }
> {
  if (forwardJournal.phase !== 'metadata-committed'
    || forwardJournal.metadataDisposition.kind !== 'prefix-move'
    || !forwardJournal.metadataDisposition.committedSnapshot) {
    return {
      restored: false,
      reason: 'saved forward journal is not an exact committed prefix transaction',
    }
  }
  const sourceStat = await fs.lstat(sourceAbs).catch(() => null)
  if (sourceStat === null && options.requireSourceOccupancy) {
    return {
      restored: false,
      reason: 'original source path is not externally occupied',
    }
  }
  if (sourceStat !== null
    && (!sourceStat.isDirectory() || sourceStat.isSymbolicLink())) {
    return {
      restored: false,
      reason: 'original source path is not a real external directory',
    }
  }
  if (!forwardJournal.destDev || !forwardJournal.destIno
    || !forwardJournal.destBirthtimeNs
    || !await verifyDirectoryGeneration(destinationAbs, {
      dev: forwardJournal.destDev,
      ino: forwardJournal.destIno,
      birthtimeNs: forwardJournal.destBirthtimeNs,
    })) {
    return {
      restored: false,
      reason: 'forward destination generation no longer matches',
    }
  }
  if (await verifyFolderMoveDestinationV4(
    destinationAbs,
    forwardJournal,
    forwardJournal.strategy === 'replayable-move' && forwardJournal.gateProof
      ? { ignoredRelativePaths: [forwardJournal.gateProof.markerName] }
      : {},
  )) {
    return {
      restored: false,
      reason: 'forward destination exact physical parity failed',
    }
  }
  const expected = reviveMetadataSnapshot(
    forwardJournal.metadataDisposition.committedSnapshot,
  )
  if (!verifyMetadataSnapshotGraphExact(db, expected)) {
    return {
      restored: false,
      reason: 'forward committed metadata snapshot no longer matches',
    }
  }
  if (forwardJournal.strategy === 'replayable-move'
    && forwardJournal.gateProof) {
    try {
      await writeFolderMoveGateProof(
        destinationAbs,
        forwardJournal.gateProof,
      )
    } catch (error) {
      return {
        restored: false,
        reason: `forward destination gate proof could not be restored: ${
          (error as Error).message
        }`,
      }
    }
  }
  await rewriteDurableJournal(journalAbs, forwardJournal)
  return { restored: true }
}

// Create an empty folder. Body: { path: string }
folderRoutes.post('/api/folders', async (c) => {
  const body = await c.req.json().catch(() => null) as { path?: string } | null
  if (!body || typeof body.path !== 'string') return bad(c, 'path required')
  if (!isValidPathSyntax(body.path)) {
    return bad(c, 'invalid path syntax')
  }
  try { validateFolderMutation({ operation: 'create', path: body.path }) }
  catch (error) { return bad(c, (error as Error).message, 422) }
  let abs: string
  try { abs = folderPathFor(body.path) } catch (e: any) { return bad(c, e.message) }
  // Creating a folder changes tree membership: structure lock first.
  const createdPath = body.path
  return withVaultMutation(CONTENT_DIR, () => withVaultStructureLock(() => withDocumentWriteLock(createdPath, async () => {
    if (await exists(abs)) return bad(c, 'folder exists', 409)
    await fs.mkdir(abs, { recursive: true })
    return c.json({ path: createdPath }, 201)
  })))
})

// Rename a folder (single-segment rename, cascades on disk).
folderRoutes.patch('/api/folders/*', async (c) => {
  const splat = c.req.path.replace(/^\/api\/folders\//, '')
  const srcPath = splat
  if (!canModify(srcPath)) return bad(c, 'protected folders cannot be renamed', 422)
  let src: string
  try { src = folderPathFor(srcPath) } catch (e: any) { return bad(c, e.message) }
  if (!await exists(src)) return bad(c, 'not found', 404)

  const body = await c.req.json().catch(() => null) as { newPath?: string; updateReferences?: boolean } | null
  if (!body || typeof body.newPath !== 'string') return bad(c, 'newPath required')
  const newPath = body.newPath
  try { validateFolderMutation({ operation: 'rename', sourcePath: srcPath, destinationPath: newPath }) }
  catch (error) { return bad(c, (error as Error).message, 422) }
  // Validate: newPath parent must match srcPath parent, only last segment differs.
  const srcParent = path.dirname(srcPath)
  const newParent = path.dirname(body.newPath)
  if (srcParent !== newParent) return bad(c, 'only single-segment rename allowed', 422)
  if (!canModify(newPath)) return bad(c, 'cannot rename a folder to a protected path', 422)
  let dest: string
  try { dest = folderPathFor(body.newPath) } catch (e: any) { return bad(c, e.message) }
  // Tree membership changes serialize behind the vault structure lock.
  // The subtree/backlink/database planning happens UNDER it, so the
  // document lock footprint is acquired against a membership-stable
  // world — a concurrent create/delete/rename on any path waits for
  // the whole transaction instead of slipping a new child in between
  // the enumeration and the lock acquisition.
  return withVaultMutation(CONTENT_DIR, () => withVaultStructureLock(async () => {
  // A generic reference planner cannot inspect managed Diary bodies. When
  // reference updates are requested, conservatively reject a vault that has
  // any managed Diary file before LinkIndex planning (locked callers retain
  // the normal 423 response).
  if (body.updateReferences !== false) {
    const referenceError = await rejectManagedDiaryReferenceFootprint(c)
    if (referenceError) return referenceError
  }
  const plannedOldPaths = await listSubtreePaths(CONTENT_DIR, srcPath)
  if (plannedOldPaths.some((value) => classifyDiaryPath(value) === 'managed')) {
    return bad(c, 'folder rename reference footprint contains an encrypted managed Diary body', 422, 'diary-encrypted-reference-unsupported')
  }
  const plannedReferencePaths = body.updateReferences
    ? Object.entries((await getLinkIndex()).snapshot().outgoing)
      .filter(([, links]) => links.some((link) => plannedOldPaths.includes(link.target)))
      .map(([source]) => source)
    : []
  for (const bodyPath of [...plannedOldPaths, ...plannedReferencePaths]) {
    const bodyAccess = requireDiaryBodyAccess(c, bodyPath)
    if (bodyAccess) return bodyAccess
  }
  if ([...plannedOldPaths, ...plannedReferencePaths].some((value) => classifyDiaryPath(value) === 'managed')) {
    return bad(c, 'folder rename reference footprint contains an encrypted managed Diary body', 422, 'diary-encrypted-reference-unsupported')
  }
  const plannedNewPaths = plannedOldPaths.map((oldPath) => newPath + oldPath.slice(srcPath.length))
  const plannedReferenceWritePaths = plannedReferencePaths.map((source) =>
    source === srcPath || source.startsWith(`${srcPath}/`) ? newPath + source.slice(srcPath.length) : source,
  )
  const plannedDatabasePaths = snapshotDocumentMetadataPrefixMutation(
    metadataDb(), [srcPath, newPath], [
      ...plannedOldPaths, ...plannedNewPaths, ...plannedReferencePaths, ...plannedReferenceWritePaths,
    ],
  ).paths
  return withDocumentWriteLocks([
    srcPath, newPath, ...plannedOldPaths, ...plannedNewPaths,
    ...plannedReferencePaths, ...plannedDatabasePaths,
  ], async () => {
  if (!await exists(src)) return bad(c, 'not found', 404)
  if (await exists(dest)) return bad(c, 'destination exists', 409)
  const oldPaths = await listSubtreePaths(CONTENT_DIR, srcPath)
  if (oldPaths.join('\0') !== plannedOldPaths.join('\0')) {
    return bad(c, 'folder contents changed while rename was being prepared; retry', 409)
  }
  if (__folderRaceHooks?.afterRenameRecheck) await __folderRaceHooks.afterRenameRecheck()
  const folderReferenceSnapshots: Array<{
    sourcePath: string; writePath: string; raw: string; updated: string
    mtime: number
  }> = []
  if (body.updateReferences) {
    const idx = await getLinkIndex()
    const indexSnapshot = idx.snapshot()
    const moves = oldPaths.map((oldPath) => ({ oldPath, newPath: newPath + oldPath.slice(srcPath.length) }))
    for (const [source, links] of Object.entries(indexSnapshot.outgoing)) {
      if (!links.some((link) => oldPaths.includes(link.target))) continue
      const bodyAccess = requireDiaryBodyAccess(c, source)
      if (bodyAccess) return bodyAccess
      const raw = await fs.readFile(filePathFor(source), 'utf8')
      const updated = moves.reduce(
        (text, move) => rewriteDocumentReferences(text, source, move.oldPath, move.newPath, indexSnapshot.paths), raw,
      )
      if (updated !== raw) folderReferenceSnapshots.push({
        sourcePath: source,
        writePath: source === srcPath || source.startsWith(srcPath + '/') ? newPath + source.slice(srcPath.length) : source,
        raw,
        updated,
        mtime: 0,
      })
    }
    const actualReferences = folderReferenceSnapshots.map((item) => item.sourcePath).sort()
    const plannedReferences = [...new Set(plannedReferencePaths)].sort()
    if (actualReferences.join('\0') !== plannedReferences.join('\0')) {
      return bad(c, 'backlinks changed while rename was being prepared; retry', 409)
    }
  }
  const databaseSnapshot = snapshotDocumentMetadataPrefixMutation(
    metadataDb(), [srcPath, newPath], [
      ...oldPaths,
      ...oldPaths.map((oldPath) => newPath + oldPath.slice(srcPath.length)),
      ...folderReferenceSnapshots.flatMap((item) => [item.sourcePath, item.writePath]),
    ],
  )
  const currentDatabasePaths = [...databaseSnapshot.paths].sort()
  const lockedDatabasePaths = [...new Set(plannedDatabasePaths)].sort()
  if (currentDatabasePaths.join('\0') !== lockedDatabasePaths.join('\0')) {
    return bad(c, 'folder metadata changed while rename was being prepared; retry', 409)
  }
  const written: typeof folderReferenceSnapshots = []
  let physicalPhaseCompleted = false
  let journalPath: string | null = null
  // The persisted folder-move journal payload — kept in scope for the
  // rollback, which durably flips its direction before reversing the
  // tree (and flips it back if the source was re-used).
  let folderMoveJournal: FolderMoveJournalV4 | null = null
  let forwardCommittedJournal: FolderMoveJournalV4 | null = null
  let journalUuid = ''
  let referenceJournal: PreparedRenameReferenceJournal | null = null
  const moveStrategy = resolveDirectoryMoveStrategy()
  // Local alias so per-phase crash seams (round-11 v4) read the current
  // hook bag without each call going through the module getter.
  const moveHooks = getCreateOnlyMoveHooksForTesting()
  try {
    const sourceHashes = new Map<string, string>()
    for (const oldPath of oldPaths) {
      const oldAbs = filePathFor(oldPath)
      const [raw, stat] = await Promise.all([
        fs.readFile(oldAbs, 'utf8'),
        fs.stat(oldAbs),
      ])
      ensureMetadata(oldPath, raw, stat.mtimeMs)
      sourceHashes.set(oldPath, sha256Hex(raw))
    }
    for (const snapshot of folderReferenceSnapshots) {
      if (!oldPaths.includes(snapshot.sourcePath)) {
        const sourceStat = await fs.stat(filePathFor(snapshot.sourcePath))
        ensureMetadata(
          snapshot.sourcePath,
          snapshot.raw,
          sourceStat.mtimeMs,
        )
      }
    }
    referenceJournal = await prepareRenameReferenceJournal({
      sourceAbs: src,
      op: 'folder-rename-references',
      srcRel: srcPath,
      destRel: newPath,
      identities: oldPaths.map((oldPath) => {
        const identity = getDocumentMetadata(metadataDb(), oldPath)
        if (!identity) throw new Error(`source document identity was not created: ${oldPath}`)
        const sourceHash = sourceHashes.get(oldPath)
        if (!sourceHash) throw new Error(`source document hash was not captured: ${oldPath}`)
        return { path: oldPath, id: identity.id, sourceHash }
      }),
      references: folderReferenceSnapshots.map((snapshot) => ({
        path: snapshot.writePath,
        beforeRaw: snapshot.raw,
        afterRaw: snapshot.updated,
      })),
      referenceIdentities: folderReferenceSnapshots
        .filter(snapshot => !oldPaths.includes(snapshot.sourcePath))
        .map((snapshot) => {
          const identity = getDocumentMetadata(
            metadataDb(),
            snapshot.sourcePath,
          )
          if (!identity) {
            throw new Error(
              `reference document identity was not created: ${snapshot.sourcePath}`,
            )
          }
          return {
            documentId: identity.id,
            sourcePath: snapshot.sourcePath,
            writePath: snapshot.writePath,
          }
        }),
    })
    // Physical entries: the journal must describe EVERY file the move
    // touches — markdown AND attachments — or a crash mid-move would
    // strand unjournaled files with no reconciliation proof (the mover
    // moves all regular files; the journal is the authority recovery
    // replays). Identities ride along for the markdown documents only.
    // Directories (including empty ones) are journaled too so the move
    // recreates the full visible tree shape (round-8 P1).
    let physical: Awaited<ReturnType<typeof listPhysicalMoveEntries>>
    try {
      physical = await listPhysicalMoveEntries(src, (relativeFilePath) => {
        if (!relativeFilePath.endsWith('.md')) return null
        const documentPath = `${srcPath}/${relativeFilePath.slice(0, -'.md'.length)}`
        const identity = getDocumentMetadata(metadataDb(), documentPath)
        return identity ? { documentId: identity.id, documentPath } : null
      }, srcPath)
    } catch (error) {
      if (error instanceof ManagedDiaryFolderMoveUnsupportedError) {
        return bad(c, 'folder rename reference footprint contains an encrypted managed Diary body', 422, error.code)
      }
      throw error
    }
    // v4 entry shape: mandatory (sourceDev, sourceIno, sourceHash).
    const physicalEntriesV4: import('../folderMoveTransaction.js').FolderMoveJournalEntryV4[] = physical.entries.map((e) => ({
      relativeFilePath: e.relativeFilePath,
      sourceDev: e.sourceDev ?? '',
      sourceIno: e.sourceIno ?? '',
      sourceHash: e.sourceHash,
      ...(e.documentId !== undefined ? { documentId: e.documentId } : {}),
      ...(e.documentPath !== undefined ? { documentPath: e.documentPath } : {}),
    }))
    const physicalDirectoriesV4 = physical.directories
    // DURABLE JOURNAL (phase=prepared) before any filesystem change:
    // if the process dies between now and gate creation, recovery
    // sees phase=prepared with no dest generation → quarantines or
    // cleans up safely. Removed LAST after metadata-committed.
    const sourceDirectoryIdentity =
      await captureDurableDirectoryIdentity(src)
    const preparedMetadataSnapshot = snapshotDocumentMetadataPrefixMutation(
      metadataDb(),
      [srcPath, newPath],
      [
        ...oldPaths,
        ...oldPaths.map((oldPath) =>
          newPath + oldPath.slice(srcPath.length)),
      ],
    )
    journalUuid = randomUUID()
    const journalDocumentVersions = (preparedMetadataSnapshot.documents as Array<{ updated_at: unknown }>)
      .map((row) => Number(row.updated_at))
    const transactionTimestamp = nextMetadataBatchUpdatedAt(journalDocumentVersions, Date.now())
    folderMoveJournal = {
      version: FOLDER_MOVE_JOURNAL_VERSION,
      op: 'folder-rename',
      phase: 'prepared',
      srcRel: srcPath,
      destRel: newPath,
      strategy: moveStrategy,
      sourceDev: sourceDirectoryIdentity.dev,
      sourceIno: sourceDirectoryIdentity.ino,
      sourceBirthtimeNs: sourceDirectoryIdentity.birthtimeNs,
      gateProof: createFolderMoveGateProof(),
      ...(physicalEntriesV4.length === 0 ? { emptyTree: true } : {}),
      entries: physicalEntriesV4,
      directories: physicalDirectoriesV4,
      directoryGenerations: physical.directoryGenerations,
      metadataDisposition: {
        kind: 'prefix-move',
        transactionTimestamp,
        preparedSnapshot: serializeMetadataSnapshot(preparedMetadataSnapshot),
      },
    }
    journalPath = path.join(
      path.dirname(src),
      recoveryMarkerName('journal', path.basename(src), journalUuid),
    )
    await writeDurableJournal(journalPath, folderMoveJournal)
    let physicalMove: Awaited<ReturnType<typeof executeFolderMoveV4Physical>>
    try {
      physicalMove = await executeFolderMoveV4Physical({
        contentDir: CONTENT_DIR,
        journalAbs: journalPath,
        journal: folderMoveJournal as FolderMoveJournalV4 & { phase: 'prepared' },
        srcAbs: src,
        destAbs: dest,
        strategy: moveStrategy,
        afterGateCreated: moveHooks?.afterGateCreated,
        afterAtomicRenameBeforeParity: moveHooks?.afterAtomicRenameBeforeParity,
        afterFilesLanded: moveHooks?.afterFilesLanded,
      })
    } catch (error) {
      const durableJournal = await readDurableFolderMoveJournalV4(journalPath)
      if (durableJournal) folderMoveJournal = durableJournal
      const durablePhase = durableJournal?.phase ?? 'unreadable'
      const executionCause = error instanceof FolderMoveV4ExecutionError
        ? error.cause
        : undefined
      let safelyCancelled = false
      if (error instanceof FolderMoveV4ExecutionError
        && !error.state.physicalMayHaveLanded) {
        try {
          const attempted = error.state.journal
          let ownedGateRemoved = false
          if (attempted.phase === 'gate-created' && attempted.destDev && attempted.destIno
            && attempted.destBirthtimeNs
            && await verifyDirectoryGeneration(dest, {
              dev: attempted.destDev,
              ino: attempted.destIno,
              birthtimeNs: attempted.destBirthtimeNs,
            })
            && (!attempted.gateProof
              || await verifyFolderMoveGateProof(dest, attempted.gateProof))
            && (await fs.readdir(dest)).every(name =>
              attempted.gateProof !== undefined
              && name === attempted.gateProof.markerName)) {
            if (attempted.gateProof) {
              await removeFolderMoveGateProof(dest, attempted.gateProof)
            }
            await fs.rmdir(dest)
            ownedGateRemoved = true
          }
          const noOwnedGateWasCreated = attempted.phase === 'prepared'
          if (ownedGateRemoved || noOwnedGateWasCreated) {
            restoreDocumentMetadataMutation(metadataDb(), databaseSnapshot)
            await removeDurableJournal(journalPath)
            await referenceJournal?.cleanup()
            referenceJournal = null
            safelyCancelled = true
          }
        } catch {
          // The route still returns from the executor boundary. Any
          // incomplete safe-cancel step leaves its durable artifact for
          // startup recovery; it never re-enters the legacy outer catch.
        }
      }
      const retained = safelyCancelled ? 'transaction safely cancelled' : 'recovery journal retained'
      const destinationOccupied = executionCause instanceof RenameDestinationOccupiedError
      const unsupported = executionCause instanceof UnsupportedDirectoryMoveError
      if (unsupported) {
        return bad(c, `this filesystem does not support the create-only folder move; durable phase ${durablePhase}; ${retained}`, 501)
      }
      if (destinationOccupied) {
        return bad(c, `destination was claimed by an external writer; durable phase ${durablePhase}; ${retained}`, 409)
      }
      if (error instanceof AtomicRenameLandedGenerationReadError) {
        return bad(c, `${error.message}; durable phase ${durablePhase}; recovery journal retained`, 500)
      }
      if (error instanceof FolderMoveGenerationMismatchError) {
        return bad(c, `folder move generation mismatch; durable phase ${durablePhase}; recovery journal retained`, 409)
      }
      if (error instanceof FolderMoveExactParityError) {
        return bad(c, `destination ownership or exact parity could not be verified; durable phase ${durablePhase}; recovery journal retained`, 409)
      }
      return bad(c, `folder move executor failed at durable phase ${durablePhase}; recovery journal retained`, 500)
    }
    folderMoveJournal = physicalMove.journal
    physicalPhaseCompleted = true
    const forwardFinalization = await completeFolderMoveV4Metadata(
      metadataDb(),
      journalPath,
      physicalMove.journal,
      src,
      dest,
      {
        afterMetadataMutationBeforeJournalRewrite: async () => {
          await moveHooks?.afterMetadataCommitted?.(dest)
        },
      },
    )
    folderMoveJournal = forwardFinalization.journal
    if (!forwardFinalization.completed) {
      return bad(
        c,
        `${forwardFinalization.detail}; recovery journal retained`,
        forwardFinalization.action === 'quarantined' ? 409 : 500,
      )
    }
    forwardCommittedJournal = cloneFolderMoveJournal(
      forwardFinalization.journal,
    )
    if (__folderRaceHooks?.afterRenamePlanBuilt) await __folderRaceHooks.afterRenamePlanBuilt()
    for (const snapshot of folderReferenceSnapshots) {
      const target = filePathFor(snapshot.writePath)
      await atomicReplaceTextIfUnchanged(target, snapshot.raw, snapshot.updated)
      written.push(snapshot)
      const stat = await fs.stat(target)
      snapshot.mtime = stat.mtimeMs
      recordCommittedMetadata(snapshot.writePath, snapshot.updated, stat.mtimeMs, Date.now())
    }
    await __folderRaceHooks?.afterReferenceWrites?.()
    await referenceJournal?.cleanup()
    referenceJournal = null
  } catch (error) {
    const rollbackErrors: unknown[] = []
    let rollbackSourceReused = false
    let reversePhysicalMayHaveLanded = false
    let reverseDirectionPersisted = false
    let forwardJournalRestored = false
    let rolledTreeBack = !physicalPhaseCompleted
    if (referenceJournal) {
      try { await referenceJournal.setDirection('roll-back') }
      catch (rollbackError) { rollbackErrors.push(rollbackError) }
    }
    for (const snapshot of written.reverse()) {
      const target = filePathFor(snapshot.writePath)
      if (await exists(target)) {
        try {
          // Undo ONLY our rewrite: an external save on top of it wins
          // and the undo leaves those bytes untouched.
          await atomicReplaceTextIfUnchanged(target, snapshot.updated, snapshot.raw)
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError)
        }
      }
    }
    if (physicalPhaseCompleted) {
      // DURABLE direction flip BEFORE the first reverse file moves:
      // the journal now describes the rollback (newPath → srcPath), so
      // a crash at ANY point mid-rollback replays forward to the
      // source from the journal — no split tree is ever left without
      // a journal that describes it (round-7 P1: the reverse move was
      // journal-less, and a mid-rollback crash stranded a split tree
      // neither journal direction could reconcile). Same-parent
      // v4 reverse-direction rewrite: phase=prepared, destDev/destIno
      // removed, srcRel/destRel flipped. The persistent journal at
      // every phase is the single source of truth.
      let flipSucceeded = false
      if (journalPath && folderMoveJournal) {
        try {
          if (__folderRaceHooks?.failJournalFlip) throw new Error('injected journal flip failure')
          const rollbackExpectedCurrentSnapshot =
            snapshotDocumentMetadataMutationCurrentOwnership(
              metadataDb(),
              databaseSnapshot,
            )
          const rollbackTargetDocumentIds = new Set(
            databaseSnapshot.documentIds,
          )
          const reverseEntries:
            import('../folderMoveTransaction.js').FolderMoveJournalEntryV4[] =
            folderMoveJournal.entries.map((entry) => {
            if (typeof entry.documentId !== 'string'
              || typeof entry.documentPath !== 'string') {
              return entry
            }
            if (!rollbackTargetDocumentIds.has(entry.documentId)) {
              const {
                documentId: _documentId,
                documentPath: _documentPath,
                ...physicalEntry
              } = entry
              return physicalEntry
            }
            return {
              ...entry,
              documentPath:
                srcPath
                + '/'
                + entry.relativeFilePath.slice(0, -'.md'.length),
            }
          })
          const physicalDocumentIds = reverseEntries.flatMap(
            (entry) => typeof entry.documentId === 'string'
              ? [entry.documentId]
              : [],
          ).sort()
          const rollbackSnapshot =
            serializeMetadataSnapshot(databaseSnapshot)
          const expectedCurrentSnapshot =
            serializeMetadataSnapshot(rollbackExpectedCurrentSnapshot)
          const metadataOnlyDocumentProofs =
            rollbackSnapshot.documents
              .filter(row =>
                !physicalDocumentIds.includes(String(row.id)))
              .map((row) => {
                const documentId = String(row.id)
                const documentPath = String(row.path)
                const reason =
                  documentPath === newPath
                    || documentPath.startsWith(`${newPath}/`)
                    ? 'source-prefix' as const
                    : documentPath === srcPath
                        || documentPath.startsWith(`${srcPath}/`)
                      ? 'destination-prefix' as const
                      : 'reference-journal' as const
                return {
                  documentId,
                  path: documentPath,
                  reason,
                }
              })
              .sort((left, right) =>
                left.documentId.localeCompare(right.documentId))
          const referenceProofRows = folderReferenceSnapshots
            .filter(snapshot => {
              const identity = getDocumentMetadata(
                metadataDb(),
                snapshot.sourcePath,
              )
              if (!identity) return false
              const isReferenceRestoreDocument =
                metadataOnlyDocumentProofs.some(proof =>
                  proof.reason === 'reference-journal'
                  && proof.documentId === identity.id)
              const isExpectedOnlyReferenceDocument =
                rollbackExpectedCurrentSnapshot.documents.some(row =>
                  String(row.id) === identity.id)
                && snapshot.sourcePath !== newPath
                && !snapshot.sourcePath.startsWith(`${newPath}/`)
                && snapshot.sourcePath !== srcPath
                && !snapshot.sourcePath.startsWith(`${srcPath}/`)
              return isReferenceRestoreDocument
                || isExpectedOnlyReferenceDocument
            })
            .map((snapshot) => {
              const identity = getDocumentMetadata(
                metadataDb(),
                snapshot.sourcePath,
              )
              if (!identity) {
                throw new Error(
                  `reference document identity is missing: ${snapshot.sourcePath}`,
                )
              }
              return {
                documentId: identity.id,
                sourcePath: snapshot.sourcePath,
                writePath: snapshot.writePath,
                beforeHash: sha256Hex(snapshot.raw),
                afterHash: sha256Hex(snapshot.updated),
              }
            })
            .sort((left, right) =>
              left.documentId.localeCompare(right.documentId))
          if (referenceProofRows.length > 0 && !referenceJournal) {
            throw new Error(
              'reverse metadata provenance requires a durable reference journal',
            )
          }
          const createdMetadataIds = {
            documentIds: rollbackExpectedCurrentSnapshot.documentIds
              .filter(id => !databaseSnapshot.documentIds.includes(id))
              .sort(),
            tagIds: rollbackExpectedCurrentSnapshot.tagIds
              .filter(id => !databaseSnapshot.preexistingTagIds.includes(id))
              .sort((left, right) => left - right),
          }
          const reverseSourceIdentity =
            await captureDurableDirectoryIdentity(dest)
          if (!await isPhysicallyContained(CONTENT_DIR, dest)) {
            throw new Error(
              'reverse source is not an owned physical directory',
            )
          }
          const reverseDirectoryGenerations =
            await captureFolderMoveDirectoryEntries(dest, CONTENT_DIR)
          if (referenceProofRows.length > 0) {
            // P0-1 step 1: rewrite the companion as
            // folder-snapshot-owner-pending BEFORE the flipped v4 owner
            // folder journal is durably rewritten below. A crash here
            // must NOT leave the companion at metadataHandled:false
            // forever — recovery promotes or quarantines.
            await bindOwnerPending({
              journalPath: referenceJournal!.journalPath,
              phase: 'roll-back',
              baseEntry: referenceJournal!.entry,
              descriptorHash: referenceJournal!.descriptorHash,
              owner: {
                ownerJournal: path.basename(journalPath!),
                ownerTransactionId: journalUuid,
              },
            })
            await __folderRaceHooks?.afterBindOwnerPending?.()
          }
          const flipped: FolderMoveJournalV4 = {
            ...folderMoveJournal,
            srcRel: newPath,
            destRel: srcPath,
            sourceDev: reverseSourceIdentity.dev,
            sourceIno: reverseSourceIdentity.ino,
            sourceBirthtimeNs: reverseSourceIdentity.birthtimeNs,
            phase: 'prepared',
            gateProof: createFolderMoveGateProof(),
            // destDev/destIno are removed in the prepared phase; they
            // are re-persisted when the reverse gate is created.
            destDev: undefined,
            destIno: undefined,
            destBirthtimeNs: undefined,
            destinationDirectoryGenerations: undefined,
            // Flip each entry's documentPath to match the new srcRel.
            entries: reverseEntries,
            directoryGenerations: reverseDirectoryGenerations,
            metadataDisposition: {
              kind: 'snapshot-restore',
              snapshot: rollbackSnapshot,
              expectedCurrentSnapshot,
              physicalDocumentIds,
              metadataOnlyDocumentProofs,
              ownershipFootprint: buildMetadataOwnershipFootprint(
                rollbackSnapshot,
                expectedCurrentSnapshot,
                physicalDocumentIds,
              ),
              ...(referenceProofRows.length > 0
                ? {
                    referenceJournal: {
                      relativePath: path.basename(
                        referenceJournal!.journalPath,
                      ),
                      operation: 'folder-rename-references' as const,
                      transactionId: referenceJournal!.transactionId,
                      journalHash: referenceJournal!.descriptorHash,
                      srcRel: srcPath,
                      destRel: newPath,
                      references: referenceProofRows.map((proof) => {
                        const operation = referenceJournal!.entry.references
                          .find(item => item.path === proof.writePath)
                        if (!operation) {
                          throw new Error(
                            `reference proof operation is missing: ${proof.writePath}`,
                          )
                        }
                        return {
                          ...proof,
                          beforePayload: operation.beforePayload,
                          afterPayload: operation.afterPayload,
                        }
                      }),
                    },
                  }
                : {}),
              createdMetadataIds,
            },
          }
          await rewriteDurableJournal(journalPath, flipped)
          flipSucceeded = true
          reverseDirectionPersisted = true
          // Persist the flipped entries into the running variable so
          // subsequent rewrites (gate-created, etc.) carry the updated
          // documentPaths.
          folderMoveJournal = flipped
          // P0-1 v4 owner durable seam: the flipped v4 owner folder
          // journal is on disk. Tests observe this before the companion
          // promotion runs.
          if (referenceProofRows.length > 0
            && __folderRaceHooks?.afterV4OwnerJournalDurable) {
            await __folderRaceHooks.afterV4OwnerJournalDurable()
          }
          // P0-1 step 3: now that the v4 owner folder journal is durable,
          // promote the companion to folder-snapshot-owned. A crash
          // between step 1 and step 3 leaves the companion owner-pending
          // and recovery reconciles by either promoting (this point) or
          // quarantining (no matching v4 owner journal). A crash after
          // step 3 is the normal "owned but unhandled" early-return path.
          if (referenceProofRows.length > 0) {
            await markOwnerDurable({
              journalPath: referenceJournal!.journalPath,
              phase: 'roll-back',
              baseEntry: referenceJournal!.entry,
              owner: {
                ownerJournal: path.basename(journalPath!),
                ownerTransactionId: journalUuid,
              },
              descriptorHash: referenceJournal!.descriptorHash,
            })
            await __folderRaceHooks?.afterOwnerDurableMark?.()
          }
          await __folderRaceHooks?.afterRenameRollbackPrepared?.(journalPath)
        } catch (rollbackError) { rollbackErrors.push(rollbackError) }
      }
      if (flipSucceeded && journalPath && folderMoveJournal) {
        try {
          // Reverse hooks may be armed by the post-forward race seam after
          // the route captured its forward hook bag. Read the current bag
          // at the reverse transaction boundary.
          const reverseMoveHooks = getCreateOnlyMoveHooksForTesting()
          const reverse = await executeFolderMoveV4Physical({
            contentDir: CONTENT_DIR,
            journalAbs: journalPath,
            journal: folderMoveJournal as FolderMoveJournalV4 & { phase: 'prepared' },
            srcAbs: dest,
            destAbs: src,
            strategy: moveStrategy,
            afterGateCreated: async (destinationAbs) => {
              await reverseMoveHooks?.afterReverseGateCreated?.(destinationAbs)
            },
            afterFilesLanded: async (destinationAbs) => {
              await reverseMoveHooks?.afterReverseParity?.(destinationAbs)
            },
          })
          folderMoveJournal = reverse.journal
          rolledTreeBack = true
          if (__folderRaceHooks?.afterRollbackMove) await __folderRaceHooks.afterRollbackMove()
          const reverseFinalization = await completeFolderMoveV4Metadata(
            metadataDb(),
            journalPath,
            reverse.journal,
            dest,
            src,
            {
              beforeMetadataMutation: async () => {
                await reverseMoveHooks?.beforeReverseMetadataRestore?.(src)
              },
              afterMetadataMutationBeforeJournalRewrite: async () => {
                await reverseMoveHooks?.afterReverseMetadata?.(src)
              },
              afterMetadataJournalRewriteBeforeFinalVerify: async () => {
                await reverseMoveHooks
                  ?.afterReverseMetadataBeforeFinalVerify?.(src)
              },
              beforeJournalRemove: async () => {
                await reverseMoveHooks?.beforeReverseJournalRemove?.(src)
              },
            },
          )
          folderMoveJournal = reverseFinalization.journal
          if (!reverseFinalization.completed) {
            rollbackErrors.push(new Error(reverseFinalization.detail))
          } else {
            await reverseMoveHooks
              ?.afterReverseOwnerCleanupBeforeReferenceCleanup?.(src)
          }
        } catch (rollbackError) {
          if (rollbackError instanceof FolderMoveV4ExecutionError) {
            reversePhysicalMayHaveLanded =
              rollbackError.state.physicalMayHaveLanded
          }
          const rollbackCause = rollbackError instanceof FolderMoveV4ExecutionError
            ? rollbackError.cause
            : rollbackError
          if (rollbackCause instanceof RenameDestinationOccupiedError
            || rollbackCause instanceof RenameSourceReusedError) {
            rollbackSourceReused = true
          } else {
            rollbackErrors.push(rollbackError)
          }
        }
      } else {
        rollbackSourceReused = true
      }
    }
    if (rollbackSourceReused && journalPath && folderMoveJournal) {
      // The tree stays at newPath: flip the journal back to the
      // forward direction (phase=metadata-committed) FIRST, so a
      // crash right here leaves a journal whose recovery completes
      // the metadata move to newPath — never one that would bind
      // identities to the externally re-used source. The rows are
      // already at newPath from the forward move.
      if (reversePhysicalMayHaveLanded) {
        rollbackErrors.push(
          new Error(
            'reverse physical entries may have landed; committed forward journal cannot be restored',
          ),
        )
      } else if (!forwardCommittedJournal) {
        rollbackErrors.push(
          new Error('committed forward journal was not saved before rollback'),
        )
      } else {
        try {
          const restored = await restoreForwardJournalAfterReverseContention(
            metadataDb(),
            journalPath,
            forwardCommittedJournal,
            src,
            dest,
            {
              requireSourceOccupancy: reverseDirectionPersisted,
            },
          )
          if (restored.restored) {
            folderMoveJournal = forwardCommittedJournal
            forwardJournalRestored = true
          } else {
            rollbackErrors.push(new Error(restored.reason))
          }
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError)
        }
      }
    }
    if (rollbackSourceReused) {
      // Identity follows the bytes: the tree is at newPath. Move every
      // restored row under srcPath back under newPath (or drop them if
      // the destination vanished too, so no identity ever binds to a
      // missing tree).
      try {
        if (!forwardJournalRestored) {
          if (await exists(dest)) {
            moveDocumentMetadataPrefix(metadataDb(), srcPath, newPath)
          } else {
            deleteDocumentMetadataPrefix(metadataDb(), srcPath)
          }
        }
        const idx = await getLinkIndex()
        const pairs = await Promise.all(oldPaths.map(async (oldPath) => {
          const movedPath = newPath + oldPath.slice(srcPath.length)
          const newRaw = await fs.readFile(filePathFor(movedPath), 'utf8')
          return { oldPath, newPath: movedPath, newRaw }
        }))
        idx.applyFolderRename(pairs)
      } catch { /* best effort: the next index rebuild re-derives paths */ }
    }
    if (referenceJournal) {
      try {
        if (rollbackSourceReused) await referenceJournal.setDirection('roll-forward')
        else if (rolledTreeBack && !rollbackErrors.length) { await referenceJournal.cleanup(); referenceJournal = null }
      } catch (rollbackError) { rollbackErrors.push(rollbackError) }
    }
    if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], 'folder rename failed and rollback was incomplete')
    if (error instanceof UnsupportedDirectoryMoveError) {
      return bad(c, 'this filesystem does not support the create-only folder move (hard links); the folder was not renamed', 501)
    }
    const moveErrorCode = (error as NodeJS.ErrnoException).code
    if (moveErrorCode === 'EPERM' || moveErrorCode === 'EOPNOTSUPP' || moveErrorCode === 'ENOTSUP') {
      return bad(c, 'this filesystem does not support the create-only folder move (hard links); the folder was not renamed', 501)
    }
    if (error instanceof RenameDestinationOccupiedError) {
      return bad(c, 'destination was claimed by an external writer during the move; retry', 409)
    }
    if (error instanceof RenameSourceReusedError) {
      return bad(c, 'the folder move conflicted with an external writer on both paths; nothing was overwritten; retry', 409)
    }
    // Round-10 F1/F2: parity saw foreign bytes on the destination AND
    // the rollback refused to carry those foreign bytes back. Surface
    // as a retryable 409 — the folder is provably unsafe to commit.
    if (error instanceof Error && /exact parity failed and the rollback was incomplete/.test(error.message)) {
      return bad(c, 'an external writer replaced landed bytes during the move; the journal stays for inspection; retry', 409)
    }
    if (rollbackSourceReused) {
      return bad(c, 'the source folder was re-used externally during rollback; the folder was kept at the new path without overwriting the external folder; reference updates were not applied', 409)
    }
    if (error instanceof AtomicTextWriteConflictError) {
      return bad(c, 'a referenced document changed on disk during rename; retry', 409)
    }
    throw error
  }
  // Collect affected file paths for client cache refresh.
  const moved = await listSubtreePaths(CONTENT_DIR, newPath)
  // Update the link index. We need the OLD subtree paths (to apply
  // delete) and the NEW subtree paths + raws (to apply write with
  // the new source-dir for resolution).
  try {
    const idx = await getLinkIndex()
    const pairs = await Promise.all(moved.map(async (movedPath) => {
      const oldPath = srcPath + movedPath.slice(newPath.length)
      const newRaw = await fs.readFile(filePathFor(movedPath), 'utf8')
      return { oldPath, newPath: movedPath, newRaw }
    }))
    // Only cascade files that actually existed in the old subtree.
    const oldSet = new Set(oldPaths)
    idx.applyFolderRename(pairs.filter((p) => oldSet.has(p.oldPath)))
    for (const snapshot of folderReferenceSnapshots) {
      if (!snapshot.writePath.startsWith(newPath + '/')) idx.applyWrite(snapshot.writePath, snapshot.updated)
    }
  } catch { /* ignore */ }
  return c.json({
    path: body.newPath,
    moved,
    updatedReferences: folderReferenceSnapshots.map((snapshot) => ({
      path: snapshot.writePath,
      raw: snapshot.updated,
      mtime: snapshot.mtime,
    })),
  })
  })
  }))
})

// Delete a folder recursively. Requires ?recursive=true if non-empty.
folderRoutes.delete('/api/folders/*', async (c) => {
  const splat = c.req.path.replace(/^\/api\/folders\//, '')
  const folderP = splat
  try { validateFolderMutation({ operation: 'delete', path: folderP }) }
  catch (error) { return bad(c, (error as Error).message, 422) }
  if (!canModify(folderP)) return bad(c, 'protected folders cannot be deleted', 422)
  let abs: string
  try { abs = folderPathFor(folderP) } catch (e: any) { return bad(c, e.message) }
  if (!await exists(abs)) return bad(c, 'not found', 404)
  const recursive = c.req.query('recursive') === 'true'
  // Tree membership changes serialize behind the vault structure lock;
  // the subtree is planned under it so the lock footprint covers a
  // membership-stable world (see the rename route for the full note).
  return withVaultMutation(CONTENT_DIR, () => withVaultStructureLock(async () => {
  const planned = await listSubtreePaths(CONTENT_DIR, folderP)
  if (planned.some((value) => classifyDiaryPath(value) === 'managed')) {
    return bad(c, 'managed Diary encrypted delete is unavailable until an adapter-aware owner exists', 422, 'diary-encrypted-delete-unsupported')
  }
  for (const bodyPath of planned) {
    const bodyAccess = requireDiaryBodyAccess(c, bodyPath)
    if (bodyAccess) return bodyAccess
  }
  const plannedDatabasePaths = snapshotDocumentMetadataPrefixMutation(metadataDb(), [folderP], planned).paths
  return withDocumentWriteLocks([folderP, ...planned, ...plannedDatabasePaths], async () => {
  if (!await exists(abs)) return bad(c, 'not found', 404)
  const all = await listSubtreePaths(CONTENT_DIR, folderP)
  if (all.join('\0') !== planned.join('\0')) return bad(c, 'folder contents changed while delete was being prepared; retry', 409)
  if (all.some((value) => classifyDiaryPath(value) === 'managed')) {
    return bad(c, 'managed Diary encrypted delete is unavailable until an adapter-aware owner exists', 422, 'diary-encrypted-delete-unsupported')
  }
  if (__folderRaceHooks?.afterDeleteRecheck) await __folderRaceHooks.afterDeleteRecheck()
  if (all.length > 0 && !recursive) {
    return bad(c, 'folder is not empty; pass ?recursive=true to delete', 400)
  }
  const staged = path.join(
    path.dirname(abs),
    recoveryMarkerName('delete-inflight', path.basename(abs), randomUUID()),
  )
  const quarantine = path.join(
    path.dirname(abs),
    recoveryMarkerName('quarantine-reuse', path.basename(abs), randomUUID()),
  )
  const databaseSnapshot = snapshotDocumentMetadataPrefixMutation(metadataDb(), [folderP], all)
  const reuseManifest = path.join(
    path.dirname(abs),
    recoveryMarkerName('delete-manifest', path.basename(abs), randomUUID()),
  )
  const persistReuseQuarantine = async (): Promise<void> => {
    const identities = databaseSnapshot.documents.map((row) => ({ path: String(row.path), id: String(row.id) }))
    if (identities.length) {
      await writeDurableJournal(reuseManifest, {
        version: 1, op: 'delete-path-reuse', kind: 'folder', path: folderP,
        inflight: path.basename(staged), quarantine: path.basename(quarantine), identities,
      })
    }
    await fs.rename(staged, quarantine)
    await syncParentDirectoryBestEffort(quarantine)
  }
  const detachOldIdentities = (): void => {
    for (const row of databaseSnapshot.documents) {
      const oldPath = String(row.path)
      if (getDocumentMetadata(metadataDb(), oldPath)?.id === String(row.id)) {
        deleteDocumentMetadata(metadataDb(), oldPath)
      }
    }
  }
  await fs.rename(abs, staged)
  await syncParentDirectoryBestEffort(staged)
  try {
    deleteDocumentMetadataPrefix(metadataDb(), folderP)
    if (__folderRaceHooks?.failDeleteRemoval) throw new Error('injected recursive removal failure')
    await fs.rm(staged, { recursive: true, force: true })
  } catch (error) {
    const rollbackErrors: unknown[] = []
    // The failed delete never ran applyDelete; on path reuse the index
    // still carries the old subtree's links/titles. Drop the old paths
    // and re-derive the new subtree's entries from disk.
    const reindexReusedSubtree = async (): Promise<void> => {
      const idx = await getLinkIndex()
      idx.applyFolderDelete(all)
      for (const p of await listSubtreePaths(CONTENT_DIR, folderP)) {
        if (classifyDiaryPath(p) === 'managed') {
          // Managed Diary bodies remain opaque even in rollback reindexing;
          // retain only the structural path/title projection.
          idx.registerPath(p)
        } else {
          idx.applyWrite(p, await fs.readFile(filePathFor(p), 'utf8'))
        }
      }
    }
    if (await exists(staged)) {
      if (!await exists(abs)) {
        // The path is still empty: put the old tree back WITH its
        // identity — the path again holds exactly the staged
        // generation. The create-only protocol (atomic rename over its
        // own mkdir gate on POSIX; replayable per-file links on
        // Windows) makes the restore create-only: if an external
        // writer claimed the path between the exists() check above and
        // the restore, restored: false reports it and the metadata is
        // NEVER restored onto foreign bytes.
        //
        // DURABLE rollback journal BEFORE the reverse move (round-7
        // P1): the replayable restore can crash mid-flight with the
        // tree split between the staging name and the public path.
        // Recovery completes the restore — files AND the persisted
        // metadata snapshot — forward from this journal; its presence
        // also tells the delete-inflight orphan rule to stand down.
        const rollbackStrategy = resolveDirectoryMoveStrategy()
        const stagedRel = path.dirname(folderP) === '.' ? path.basename(staged) : `${path.dirname(folderP)}/${path.basename(staged)}`
        const rollbackUuid = randomUUID()
        const rollbackJournalPath = path.join(
          path.dirname(staged),
          recoveryMarkerName('journal', path.basename(staged), rollbackUuid),
        )
        let restored = false
        let rollbackMoveThrew = false
        let rollbackPhysicalEntriesV4: import('../folderMoveTransaction.js').FolderMoveJournalEntryV4[] = []
        let rollbackPhysicalDirectoriesV4: string[] = []
        let rollbackJournal: FolderMoveJournalV4 | null = null
        try {
          const rollbackPhysical = await listPhysicalMoveEntries(staged, (relativeFilePath) => {
            if (!relativeFilePath.endsWith('.md')) return null
            const docPath = `${folderP}/${relativeFilePath.slice(0, -'.md'.length)}`
            const doc = databaseSnapshot.documents.find((d) => String(d.path) === docPath)
            return doc ? { documentId: String(doc.id), documentPath: docPath } : null
          }, folderP)
          rollbackPhysicalEntriesV4 = rollbackPhysical.entries.map((e) => ({
            relativeFilePath: e.relativeFilePath,
            sourceDev: e.sourceDev ?? '',
            sourceIno: e.sourceIno ?? '',
            sourceHash: e.sourceHash,
            ...(e.documentId !== undefined ? { documentId: e.documentId } : {}),
            ...(e.documentPath !== undefined ? { documentPath: e.documentPath } : {}),
          }))
          rollbackPhysicalDirectoriesV4 = rollbackPhysical.directories
          const stagedIdentity =
            await captureDurableDirectoryIdentity(staged)
          rollbackJournal = {
            version: FOLDER_MOVE_JOURNAL_VERSION,
            op: 'folder-move',
            phase: 'prepared',
            srcRel: stagedRel,
            destRel: folderP,
            strategy: rollbackStrategy,
            sourceDev: stagedIdentity.dev,
            sourceIno: stagedIdentity.ino,
            sourceBirthtimeNs: stagedIdentity.birthtimeNs,
            gateProof: createFolderMoveGateProof(),
            ...(rollbackPhysicalEntriesV4.length === 0 ? { emptyTree: true } : {}),
            entries: rollbackPhysicalEntriesV4,
            directories: rollbackPhysicalDirectoriesV4,
            directoryGenerations: rollbackPhysical.directoryGenerations,
            metadataDisposition: { kind: 'snapshot-restore', snapshot: serializeMetadataSnapshot(databaseSnapshot) },
          }
          await writeDurableJournal(rollbackJournalPath, rollbackJournal)
          await __folderRaceHooks?.afterDeleteRollbackPrepared?.(rollbackJournalPath)
          const physical = await executeFolderMoveV4Physical({
            contentDir: CONTENT_DIR,
            journalAbs: rollbackJournalPath,
            journal: rollbackJournal as FolderMoveJournalV4 & { phase: 'prepared' },
            srcAbs: staged,
            destAbs: abs,
            strategy: rollbackStrategy,
          })
          rollbackJournal = physical.journal
          restored = true
          const rollbackFinalization = await completeFolderMoveV4Metadata(
            metadataDb(),
            rollbackJournalPath,
            physical.journal,
            staged,
            abs,
          )
          rollbackJournal = rollbackFinalization.journal
          if (!rollbackFinalization.completed) {
            rollbackErrors.push(new Error(rollbackFinalization.detail))
          }
        } catch (rollbackError) {
          const rollbackCause = rollbackError instanceof FolderMoveV4ExecutionError
            ? rollbackError.cause
            : rollbackError
          rollbackMoveThrew = !(rollbackCause instanceof RenameDestinationOccupiedError)
          rollbackErrors.push(rollbackError)
        }
        if (!restored && rollbackMoveThrew) {
          // A thrown move may have left the tree SPLIT between the
          // staging name and the public path: the rollback journal
          // stays (the next startup completes the restore from it)
          // and the staged tree must NOT be quarantined out from
          // under the journal. The AggregateError below surfaces the
          // failure.
        } else if (!restored) {
          // Clean contention (the path was claimed externally and the
          // move rolled itself fully back): the move journal can never
          // complete — drop it; the quarantine path below keeps the
          // bytes and detaches the stale identities.
          await removeDurableJournal(rollbackJournalPath).catch(() => {})
          // Path reuse (or restore failure): the old identities must
          // never bind to whatever now occupies the path. Drop every
          // stale row, leave the old tree quarantined under its
          // staging name, and refresh the link index against the new
          // subtree.
          let quarantined = false
          try {
            await persistReuseQuarantine()
            quarantined = true
          } catch (rollbackError) { rollbackErrors.push(rollbackError) }
          if (quarantined) {
            try { detachOldIdentities() }
            catch (rollbackError) { rollbackErrors.push(rollbackError) }
            try { await reindexReusedSubtree() } catch { /* next rebuild repairs */ }
            try { await removeDurableJournal(reuseManifest) }
            catch (rollbackError) { rollbackErrors.push(rollbackError) }
          }
        }
      } else {
        // Path reuse: an external writer recreated the folder while the
        // delete was failing. The old identities must never bind to the
        // new generation's files — drop every stale row under the path
        // (the new files get fresh identities on their next API touch)
        // and leave the old tree quarantined under its staging name.
        let quarantined = false
        try {
          await persistReuseQuarantine()
          quarantined = true
        } catch (rollbackError) { rollbackErrors.push(rollbackError) }
        if (quarantined) {
          try { detachOldIdentities() }
          catch (rollbackError) { rollbackErrors.push(rollbackError) }
          try { await reindexReusedSubtree() } catch { /* next rebuild repairs */ }
          try { await removeDurableJournal(reuseManifest) }
          catch (rollbackError) { rollbackErrors.push(rollbackError) }
        }
      }
    } else {
      try { restoreDocumentMetadataMutation(metadataDb(), databaseSnapshot) }
      catch (rollbackError) { rollbackErrors.push(rollbackError) }
    }
    if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], 'folder delete failed and rollback was incomplete')
    throw error
  }
  try {
    const idx = await getLinkIndex()
    idx.applyFolderDelete(all)
  } catch { /* ignore */ }
  return c.json({ deleted: all })
  })
  }))
})

export default folderRoutes

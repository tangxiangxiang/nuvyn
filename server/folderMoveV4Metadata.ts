import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Database as DatabaseT } from 'better-sqlite3'

import {
  removeDurableJournal,
  rewriteDurableJournal,
  verifyDirectoryGeneration,
} from './atomicTextWrite.js'
import {
  type DocumentMetadataMutationSnapshot,
  deleteDocumentMetadataPrefix,
  metadataSnapshotsExactlyEqual,
  moveDocumentMetadataPrefix,
  restoreDocumentMetadataMutationCAS,
  restoreDocumentMetadataMutationCASIdempotent,
  snapshotDocumentMetadataMutationCurrentOwnership,
  snapshotDocumentMetadataPrefixMutation,
  snapshotDocumentMetadataOwnership,
  validateSnapshotOwnership,
} from './documentMetadata.js'
import {
  removeDeclaredEmptyDirectories,
  verifyFolderMoveDestinationV4,
} from './documentFileLifecycle.js'
import { matchesDurableDirectoryIdentity } from './durableDirectoryIdentity.js'
import {
  removeFolderMoveGateProof,
  verifyFolderMoveGateProof,
} from './folderMoveGateProof.js'
import { validateSerializedMetadataSnapshot } from './metadataSnapshotClosure.js'
import { verifyFolderMoveDirectoryEntries } from './folderMoveDirectoryOwnership.js'
import {
  isValidDeleteRollbackSnapshot,
} from './folderMoveTransaction.js'
import {
  deriveCommittedPrefixSnapshot,
  getDocumentTagsSnapshotGeneration,
  reviveMetadataSnapshot,
  serializeMetadataSnapshot,
  validateRound17SnapshotRestoreDisposition,
  validateSnapshotPhysicalEntries,
  type FolderMoveJournalEntry,
  type FolderMoveJournalV4,
  type ParsedFolderRenameReferenceJournal,
} from './folderMoveTransaction.js'
import {
  markRenameReferenceMetadataHandled,
  parseAndValidateDurableRenameReferenceBundle,
} from './renameReferenceJournal.js'
import { recoveryMarkerToken } from './technicalNamespace.js'

export type FolderMoveV4FinalizationResult = {
  completed: boolean
  action: 'completed-rename' | 'quarantined' | 'failed'
  detail: string
  journal: FolderMoveJournalV4
}

type FinalizationHooks = {
  beforeMetadataMutation?: () => void | Promise<void>
  afterMetadataMutationBeforeJournalRewrite?: () => void | Promise<void>
  afterMetadataJournalRewriteBeforeFinalVerify?: () => void | Promise<void>
  beforeJournalRemove?: () => void | Promise<void>
}

function result(
  journal: FolderMoveJournalV4,
  action: FolderMoveV4FinalizationResult['action'],
  detail: string,
): FolderMoveV4FinalizationResult {
  return { completed: action === 'completed-rename', action, detail, journal }
}

function contentDirForFolderJournal(
  journalAbs: string,
  journal: FolderMoveJournalV4,
): string {
  const parent = path.dirname(journal.srcRel)
  const segments = parent === '.' ? [] : parent.split('/')
  return path.resolve(path.dirname(journalAbs), ...segments.map(() => '..'))
}

export async function validateDurableSnapshotRestoreDisposition(
  journalAbs: string,
  journal: FolderMoveJournalV4,
): Promise<string | null> {
  const disposition = journal.metadataDisposition
  if (disposition.kind !== 'snapshot-restore') return null
  const hasExpected = disposition.expectedCurrentSnapshot !== undefined
  const hasPhysical = disposition.physicalDocumentIds !== undefined
  const hasProofs = disposition.metadataOnlyDocumentProofs !== undefined
  const hasFootprint = disposition.ownershipFootprint !== undefined
  if (!hasExpected && !hasPhysical && !hasProofs && !hasFootprint) {
    return null
  }
  if (hasExpected && hasPhysical && !hasProofs && !hasFootprint) {
    return 'round17 snapshot-restore journal lacks durable metadata provenance'
  }
  let referenceJournal: ParsedFolderRenameReferenceJournal | undefined
  if (disposition.referenceJournal) {
    const contentDir = contentDirForFolderJournal(journalAbs, journal)
    const candidate = await parseAndValidateDurableRenameReferenceBundle({
      contentDir,
      journalPath: path.join(
      path.dirname(journalAbs),
      disposition.referenceJournal.relativePath,
      ),
    })
    if (candidate?.entry.op === 'folder-rename-references') {
      referenceJournal = {
        ...candidate.entry,
        op: 'folder-rename-references',
        identities: candidate.entry.identities ?? [],
        transactionId: candidate.transactionId,
        descriptorHash: candidate.descriptorHash,
      }
    }
  }
  const ownerTransactionId = recoveryMarkerToken(path.basename(journalAbs), 'journal') ?? undefined
  return validateRound17SnapshotRestoreDisposition(
    journal,
    disposition,
    {
      referenceJournal,
      ownerJournal: path.basename(journalAbs),
      ownerTransactionId,
    },
  )
}

async function proveDestinationOwnership(
  _journalAbs: string,
  journal: FolderMoveJournalV4,
  destAbs: string,
  phaseLabel: string,
): Promise<
  | { journal: FolderMoveJournalV4; error?: never }
  | { journal?: never; error: string }
> {
  if (!journal.destDev || !journal.destIno || !journal.destBirthtimeNs) {
    return { error: `${phaseLabel} journal is missing final destination generation` }
  }
  if (journal.strategy === 'replayable-move' && journal.gateProof) {
    if (!await verifyFolderMoveGateProof(destAbs, journal.gateProof)) {
      return { error: 'replayable destination gate proof is missing or mismatched' }
    }
    let stat: Awaited<ReturnType<typeof fs.lstat>>
    try {
      stat = await fs.lstat(destAbs, { bigint: true })
    } catch {
      return { error: 'replayable destination gate proof is missing or mismatched' }
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { error: 'replayable destination gate proof is missing or mismatched' }
    }
    if (!matchesDurableDirectoryIdentity(stat, {
      dev: journal.destDev,
      ino: journal.destIno,
      birthtimeNs: journal.destBirthtimeNs,
    })) {
      return { error: `${phaseLabel} destination generation does not match journal` }
    }
    return { journal }
  }
  if (!await verifyDirectoryGeneration(destAbs, {
    dev: journal.destDev,
    ino: journal.destIno,
    birthtimeNs: journal.destBirthtimeNs,
  })) {
    return { error: `${phaseLabel} destination generation does not match journal` }
  }
  return { journal }
}

function parityOptions(journal: FolderMoveJournalV4): {
  ignoredRelativePaths?: readonly string[]
} {
  return journal.strategy === 'replayable-move' && journal.gateProof
    ? { ignoredRelativePaths: [journal.gateProof.markerName] }
    : {}
}

function verifyPrefixMetadataCommitted(
  db: DatabaseT,
  journal: FolderMoveJournalV4,
): string | null {
  const disposition = journal.metadataDisposition
  if (disposition.kind !== 'prefix-move') {
    return 'prefix metadata verifier received non-prefix disposition'
  }
  if (!disposition.committedSnapshot) {
    return 'metadata-committed prefix journal lacks exact committed snapshot'
  }
  const expected = reviveMetadataSnapshot(disposition.committedSnapshot)
  const current = snapshotDocumentMetadataMutationCurrentOwnership(db, expected)
  return metadataSnapshotsExactlyEqual(current, expected)
    ? null
    : 'live prefix metadata graph differs from committed snapshot'
}

function canonicalRow(row: Record<string, unknown>): string {
  const ordered: Record<string, unknown> = {}
  for (const key of Object.keys(row).sort()) ordered[key] = row[key]
  return JSON.stringify(ordered)
}

function rowsExactlyEqualSnapshot(
  live: readonly Record<string, unknown>[],
  expected: readonly Record<string, unknown>[],
): boolean {
  return live.length === expected.length
    && live.every((row, index) =>
      canonicalRow(row) === canonicalRow(expected[index] as Record<string, unknown>),
    )
}

function verifyRound17BCreatedMetadataCleanup(
  db: DatabaseT,
  disposition: Extract<
    FolderMoveJournalV4['metadataDisposition'],
    { kind: 'snapshot-restore' }
  >,
  live: DocumentMetadataMutationSnapshot,
  expected: DocumentMetadataMutationSnapshot,
): string | null {
  const created = disposition.createdMetadataIds
  if (!created) return null
  const createdDocumentIds = new Set(created.documentIds)
  if (live.documents.some(row => createdDocumentIds.has(String(row.id)))) {
    return 'metadata-committed snapshot graph verification failed: created document remains live'
  }
  if (live.documentTags.some(row =>
    createdDocumentIds.has(String(row.document_id)))) {
    return 'metadata-committed snapshot graph verification failed: created document_tag remains live'
  }
  if (live.embeddings.some(row =>
    createdDocumentIds.has(String(row.document_id)))) {
    return 'metadata-committed snapshot graph verification failed: created embedding remains live'
  }
  if (live.migrations.some(row =>
    createdDocumentIds.has(String(row.document_id))
    || (typeof row.path === 'string'
      && row.path.startsWith('@deleted/')
      && createdDocumentIds.has(row.path.slice('@deleted/'.length))))) {
    return 'metadata-committed snapshot graph verification failed: created migration ownership remains live'
  }

  const expectedTagIds = new Set(expected.tags.map(row => Number(row.id)))
  for (const tagId of created.tagIds) {
    if (expectedTagIds.has(tagId)) continue
    const tag = db.prepare('SELECT id FROM tags WHERE id = ?').get(tagId)
    if (!tag) continue
    const liveReference = db.prepare(
      'SELECT 1 FROM document_tags WHERE tag_id = ? LIMIT 1',
    ).get(tagId)
    if (!liveReference) {
      return 'metadata-committed snapshot graph verification failed: unreferenced created tag remains live'
    }
  }
  return null
}

function rowsAreExpectedSubset(
  live: readonly Record<string, unknown>[],
  expected: readonly Record<string, unknown>[],
): boolean {
  const expectedRows = new Set(expected.map(canonicalRow))
  return live.every((row) => expectedRows.has(canonicalRow(row)))
}

function logicalDocumentTagKey(row: Record<string, unknown>): string {
  return `${String(row.document_id)}\0${String(row.tag_id)}`
}

function logicalDocumentTagsAreExpectedSubset(
  live: readonly Record<string, unknown>[],
  expected: readonly Record<string, unknown>[],
): boolean {
  const expectedRows = new Set(expected.map(logicalDocumentTagKey))
  return live.every((row) => expectedRows.has(logicalDocumentTagKey(row)))
}

export function verifyMetadataSnapshotGraphExact(
  db: DatabaseT,
  snapshot: DocumentMetadataMutationSnapshot,
): boolean {
  const live = snapshotDocumentMetadataMutationCurrentOwnership(db, snapshot)
  return metadataSnapshotsExactlyEqual(live, snapshot)
}

function snapshotRestoreOwnershipMatches(
  current: ReturnType<typeof snapshotDocumentMetadataOwnership>,
  expected: ReturnType<typeof reviveMetadataSnapshot>,
  journal: FolderMoveJournalV4,
): boolean {
  if (validateSnapshotOwnership(current, expected)) return true

  const expectedDocumentById = new Map(
    expected.documents.map((row) => [String(row.id), row]),
  )
  const expectedPaths = new Set(expected.paths)
  for (const live of current.documents) {
    const expectedRow = expectedDocumentById.get(String(live.id))
    if (!expectedRow) {
      if (expectedPaths.has(String(live.path))) return false
      continue
    }
    const expectedPath = String(expectedRow.path)
    const ownedForwardPath = `${journal.srcRel}${expectedPath.slice(journal.destRel.length)}`
    if (live.path !== expectedPath && live.path !== ownedForwardPath) return false
    const normalized = {
      ...live,
      path: expectedRow.path,
      updated_at: expectedRow.updated_at,
    }
    if (canonicalRow(normalized) !== canonicalRow(expectedRow)) return false
  }

  const legacySnapshot = journal.metadataDisposition.kind === 'snapshot-restore'
    && getDocumentTagsSnapshotGeneration(journal.metadataDisposition.snapshot) === 'v6'
  const documentTagsAreExpected = legacySnapshot
    ? logicalDocumentTagsAreExpectedSubset(current.documentTags, expected.documentTags)
    : rowsAreExpectedSubset(current.documentTags, expected.documentTags)
  if (!rowsAreExpectedSubset(current.tags, expected.tags)
    || !documentTagsAreExpected
    || !rowsAreExpectedSubset(current.embeddings, expected.embeddings)) {
    return false
  }

  const expectedMigrations = new Map(
    expected.migrations.map((row) => [
      `${String(row.document_id ?? '')}\0${String(row.original_path ?? '')}`,
      row,
    ]),
  )
  for (const live of current.migrations) {
    const expectedRow = expectedMigrations.get(
      `${String(live.document_id ?? '')}\0${String(live.original_path ?? '')}`,
    )
    if (!expectedRow) {
      const tombstonedId = typeof live.path === 'string' && live.path.startsWith('@deleted/')
        ? live.path.slice('@deleted/'.length)
        : null
      if (tombstonedId
        && expectedDocumentById.has(tombstonedId)
        && live.document_id == null
        && typeof live.original_path === 'string'
        && expectedPaths.has(live.original_path)) {
        continue
      }
      return false
    }
    const expectedPath = String(expectedRow.path)
    const ownedForwardPath = expectedPath.startsWith(`${journal.destRel}/`)
      ? `${journal.srcRel}${expectedPath.slice(journal.destRel.length)}`
      : expectedPath
    if (live.path !== expectedPath && live.path !== ownedForwardPath) return false
    const normalized = {
      ...live,
      path: expectedRow.path,
      updated_at: expectedRow.updated_at,
    }
    if (canonicalRow(normalized) !== canonicalRow(expectedRow)) return false
  }
  return true
}

export async function finalizeFolderMoveV4Cleanup(
  db: DatabaseT,
  journalAbs: string,
  journal: FolderMoveJournalV4 & { phase: 'metadata-committed' },
  srcAbs: string,
  destAbs: string,
  hooks: Pick<FinalizationHooks, 'beforeJournalRemove'> = {},
): Promise<FolderMoveV4FinalizationResult> {
  const ownership = await proveDestinationOwnership(
    journalAbs,
    journal,
    destAbs,
    'metadata-committed',
  )
  if (ownership.error) {
    return result(journal, 'quarantined', ownership.error)
  }
  const durableJournal = ownership.journal as FolderMoveJournalV4 & {
    phase: 'metadata-committed'
  }
  if (await verifyFolderMoveDestinationV4(
    destAbs,
    durableJournal,
    parityOptions(durableJournal),
  )) {
    return result(durableJournal, 'quarantined', 'metadata-committed destination exact parity failed')
  }

  if (durableJournal.metadataDisposition.kind === 'snapshot-restore') {
    const disposition = durableJournal.metadataDisposition
    const provenanceError = await validateDurableSnapshotRestoreDisposition(
      journalAbs,
      durableJournal,
    )
    if (provenanceError) {
      return result(durableJournal, 'quarantined', provenanceError)
    }
    const isRound17B = disposition.ownershipFootprint !== undefined
      && disposition.metadataOnlyDocumentProofs !== undefined
    if (isRound17B
      ? !validateSerializedMetadataSnapshot(disposition.snapshot, {
          mode: 'closed-graph',
          ownershipPaths: disposition.ownershipFootprint?.paths,
        })
      : !isValidDeleteRollbackSnapshot(disposition.snapshot, durableJournal.destRel)) {
      return result(durableJournal, 'quarantined', 'metadata-committed snapshot is invalid')
    }
    const revived = reviveMetadataSnapshot(disposition.snapshot)
    const liveTagIds = (db.prepare('SELECT id FROM tags').all() as Array<{ id: number }>)
      .map((row) => row.id)
    revived.preexistingTagIds = [...new Set([...liveTagIds, ...revived.preexistingTagIds])]
    const live = snapshotDocumentMetadataOwnership(
      db,
      disposition.ownershipFootprint?.paths ?? revived.paths,
      disposition.ownershipFootprint?.documentIds ?? revived.documentIds,
      disposition.ownershipFootprint?.tagIds ?? revived.tagIds,
      disposition.ownershipFootprint,
    )
    const createdCleanupError = verifyRound17BCreatedMetadataCleanup(
      db,
      disposition,
      live,
      revived,
    )
    if (createdCleanupError) {
      return result(durableJournal, 'quarantined', createdCleanupError)
    }
    const externallyReferencedCreatedTagIds = new Set(
      (disposition.createdMetadataIds?.tagIds ?? []).filter((tagId) =>
        !revived.tagIds.includes(tagId)
        && db.prepare(
          'SELECT 1 FROM document_tags WHERE tag_id = ? LIMIT 1',
        ).get(tagId) !== undefined),
    )
    const comparableLiveTags = live.tags.filter(row =>
      !externallyReferencedCreatedTagIds.has(Number(row.id)))
    const liveLogicalDocumentTags = live.documentTags.map(logicalDocumentTagKey).sort()
    const revivedLogicalDocumentTags = revived.documentTags.map(logicalDocumentTagKey).sort()
    const documentTagsMatch = getDocumentTagsSnapshotGeneration(disposition.snapshot) === 'v6'
      ? liveLogicalDocumentTags.length === revivedLogicalDocumentTags.length
        && liveLogicalDocumentTags.every((key, index) => key === revivedLogicalDocumentTags[index])
      : rowsExactlyEqualSnapshot(live.documentTags, revived.documentTags)
    if (!rowsExactlyEqualSnapshot(live.documents, revived.documents)
      || !rowsExactlyEqualSnapshot(comparableLiveTags, revived.tags)
      || !documentTagsMatch
      || !rowsExactlyEqualSnapshot(live.embeddings, revived.embeddings)
      || !rowsExactlyEqualSnapshot(live.migrations, revived.migrations)) {
      return result(
        durableJournal,
        'quarantined',
        'metadata-committed snapshot graph verification failed: live graph differs from snapshot',
      )
    }
  } else {
    const metadataError = verifyPrefixMetadataCommitted(db, durableJournal)
    if (metadataError !== null) {
      return result(
        durableJournal,
        'quarantined',
        metadataError,
      )
    }
  }

  try {
    const sourceStat = await fs.lstat(srcAbs, { bigint: true })
      .catch(() => null)
    if (sourceStat === null
      && durableJournal.strategy === 'replayable-move') {
      return result(
        durableJournal,
        'quarantined',
        'metadata-committed replayable source root is missing',
      )
    }
    if (sourceStat !== null) {
      if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
        return result(durableJournal, 'quarantined', 'metadata-committed source path is not a real directory')
      }
      if (!durableJournal.sourceBirthtimeNs
        || !matchesDurableDirectoryIdentity(sourceStat, {
          dev: String(durableJournal.sourceDev),
          ino: String(durableJournal.sourceIno),
          birthtimeNs: durableJournal.sourceBirthtimeNs,
        })) {
        return result(
          durableJournal,
          'quarantined',
          durableJournal.metadataDisposition.kind === 'prefix-move'
            ? 'forward transaction committed but original source path was externally reused'
            : 'metadata-committed source path was externally reused',
        )
      }
      const cleanup = await removeDeclaredEmptyDirectories(
        srcAbs,
        durableJournal.directories,
        {
          directoryGenerations: durableJournal.directoryGenerations,
          expectedRootGeneration: {
            dev: String(durableJournal.sourceDev),
            ino: String(durableJournal.sourceIno),
            birthtimeNs: durableJournal.sourceBirthtimeNs,
          },
          removeRoot: true,
        },
      )
      // P0-3: any declared directory whose generation proof no longer
      // matches the on-disk directory is external state. The journal
      // classifies "weak" if it lacked the generation proof; here we
      // surface the actual mismatch as a quarantine detail rather
      // than silently removing the directory tree.
      if (cleanup.conflict.length > 0) {
        return result(
          durableJournal,
          'quarantined',
          `metadata-committed declared directories were externally replaced: ${cleanup.conflict.join(',')}`,
        )
      }
      if (!cleanup.rootRemoved
        && (await fs.readdir(srcAbs).catch(() => [])).length > 0) {
        if (durableJournal.metadataDisposition.kind === 'prefix-move') {
          return result(
            durableJournal,
            'quarantined',
            'forward transaction committed but original source path was externally reused',
          )
        }
        return result(durableJournal, 'quarantined', 'metadata-committed source directory still contains undeclared entries')
      }
      if (!cleanup.rootRemoved) {
        return result(
          durableJournal,
          'failed',
          'metadata-committed owned source directory cleanup did not complete',
        )
      }
    }
    await hooks.beforeJournalRemove?.()
    await removeDurableJournal(journalAbs)
    if (durableJournal.strategy === 'replayable-move' && durableJournal.gateProof) {
      await removeFolderMoveGateProof(destAbs, durableJournal.gateProof).catch(() => {
        // A journal-less marker is harmless and startup recovery
        // removes it once no v4 journal references its exact name.
      })
    }
  } catch (error) {
    return result(durableJournal, 'failed', `v4 final cleanup failed: ${(error as Error).message}`)
  }
  return result(durableJournal, 'completed-rename', 'v4 metadata-committed transaction verified and cleaned')
}

export async function completeFolderMoveV4Metadata(
  db: DatabaseT,
  journalAbs: string,
  journal: FolderMoveJournalV4 & { phase: 'files-landed' },
  srcAbs: string,
  destAbs: string,
  hooks: FinalizationHooks = {},
): Promise<FolderMoveV4FinalizationResult> {
  const ownership = await proveDestinationOwnership(
    journalAbs,
    journal,
    destAbs,
    'files-landed',
  )
  if (ownership.error) {
    return result(journal, 'quarantined', ownership.error)
  }
  const durableJournal = ownership.journal as FolderMoveJournalV4 & {
    phase: 'files-landed'
  }
  if (await verifyFolderMoveDestinationV4(
    destAbs,
    durableJournal,
    parityOptions(durableJournal),
  )) {
    return result(durableJournal, 'quarantined', 'files-landed physical parity failed before metadata commit')
  }
  if (durableJournal.strategy === 'replayable-move') {
    if (!await verifyDirectoryGeneration(srcAbs, {
      dev: durableJournal.sourceDev,
      ino: durableJournal.sourceIno,
      birthtimeNs: durableJournal.sourceBirthtimeNs as string,
    })) {
      return result(
        durableJournal,
        'quarantined',
        'files-landed source root generation changed before metadata commit',
      )
    }
    const directoryConflict = await verifyFolderMoveDirectoryEntries(
      srcAbs,
      durableJournal.directoryGenerations ?? [],
    )
    if (directoryConflict !== null) {
      return result(
        durableJournal,
        'quarantined',
        `${directoryConflict} before metadata commit`,
      )
    }
  }

  await hooks.beforeMetadataMutation?.()
  if (durableJournal.metadataDisposition.kind === 'snapshot-restore') {
    const disposition = durableJournal.metadataDisposition
    const snapshot = disposition.snapshot
    const provenanceError = await validateDurableSnapshotRestoreDisposition(
      journalAbs,
      durableJournal,
    )
    if (provenanceError) {
      return result(durableJournal, 'quarantined', provenanceError)
    }
    const isRound17B = disposition.ownershipFootprint !== undefined
      && disposition.metadataOnlyDocumentProofs !== undefined
    if (isRound17B
      ? !validateSerializedMetadataSnapshot(snapshot, {
          mode: 'closed-graph',
          ownershipPaths: disposition.ownershipFootprint?.paths,
        })
      : !isValidDeleteRollbackSnapshot(snapshot, durableJournal.destRel)) {
      return result(durableJournal, 'quarantined', 'snapshot-restore metadata disposition is invalid')
    }
    const entryError = validateSnapshotPhysicalEntries(
      snapshot,
      durableJournal.entries as unknown as FolderMoveJournalEntry[],
      durableJournal.destRel,
      {
        physicalDocumentIds: disposition.physicalDocumentIds,
      },
    )
    if (entryError !== null) {
      return result(durableJournal, 'quarantined', `snapshot physical entries are invalid: ${entryError}`)
    }
    const revived = reviveMetadataSnapshot(snapshot)
    const liveTagIds = (db.prepare('SELECT id FROM tags').all() as Array<{ id: number }>)
      .map((row) => row.id)
    revived.preexistingTagIds = [...new Set([...liveTagIds, ...revived.preexistingTagIds])]
    try {
      if (disposition.expectedCurrentSnapshot) {
        const cas = restoreDocumentMetadataMutationCASIdempotent(
          db,
          revived,
          reviveMetadataSnapshot(disposition.expectedCurrentSnapshot),
          disposition.ownershipFootprint
            ? {
                ownershipFootprint: disposition.ownershipFootprint,
                createdMetadataIds: disposition.createdMetadataIds,
              }
            : undefined,
        )
        if (cas.kind === 'conflict') {
          throw new Error(cas.reason)
        }
      } else {
        restoreDocumentMetadataMutationCAS(
          db,
          revived,
          current => snapshotRestoreOwnershipMatches(
            current,
            revived,
            durableJournal,
          ),
        )
      }
    } catch (error) {
      return result(durableJournal, 'quarantined', `snapshot metadata CAS failed: ${(error as Error).message}`)
    }
  } else {
    try {
      const prefixDisposition = durableJournal.metadataDisposition
      if (prefixDisposition.preparedSnapshot
        && prefixDisposition.transactionTimestamp !== undefined) {
        const prepared = reviveMetadataSnapshot(
          prefixDisposition.preparedSnapshot,
        )
        const committedSerialized = deriveCommittedPrefixSnapshot(
          prefixDisposition.preparedSnapshot,
          durableJournal.srcRel,
          durableJournal.destRel,
          prefixDisposition.transactionTimestamp,
        )
        const committed = reviveMetadataSnapshot(committedSerialized)
        const transition = db.transaction(():
          'already-committed' | 'committed-now' | 'conflict' => {
          const footprint = {
            paths: [...new Set([
              ...prepared.paths,
              ...committed.paths,
            ])].sort(),
            documentIds: [...new Set([
              ...prepared.documentIds,
              ...committed.documentIds,
            ])].sort(),
            tagIds: [...new Set([
              ...prepared.tagIds,
              ...committed.tagIds,
            ])].sort((left, right) => left - right),
            migrationPaths: [...new Set([
              ...prepared.migrations,
              ...committed.migrations,
            ].map(row => String(row.path)))].sort(),
            migrationOriginalPaths: [...new Set([
              ...prepared.migrations,
              ...committed.migrations,
            ].map(row => String(row.original_path))
              .filter(Boolean))].sort(),
          }
          const readCurrent = (): DocumentMetadataMutationSnapshot =>
            snapshotDocumentMetadataOwnership(
              db,
              footprint.paths,
              footprint.documentIds,
              footprint.tagIds,
              footprint,
            )
          const current = readCurrent()
          if (metadataSnapshotsExactlyEqual(current, committed)) {
            return 'already-committed'
          }
          if (!metadataSnapshotsExactlyEqual(current, prepared)) {
            return 'conflict'
          }
          deleteDocumentMetadataPrefix(
            db,
            durableJournal.destRel,
            prefixDisposition.transactionTimestamp,
          )
          moveDocumentMetadataPrefix(
            db,
            durableJournal.srcRel,
            durableJournal.destRel,
            prefixDisposition.transactionTimestamp,
          )
          if (!metadataSnapshotsExactlyEqual(readCurrent(), committed)) {
            throw new Error(
              'prefix metadata move did not produce deterministic committed graph',
            )
          }
          return 'committed-now'
        })
        if (transition.immediate() === 'conflict') {
          return result(
            durableJournal,
            'quarantined',
            'prefix metadata graph matches neither prepared nor committed snapshot',
          )
        }
      } else {
        moveDocumentMetadataPrefix(
          db,
          durableJournal.srcRel,
          durableJournal.destRel,
        )
      }
    } catch (error) {
      return result(durableJournal, 'failed', `metadata prefix move failed: ${(error as Error).message}`)
    }
  }

  const referenceProof = durableJournal.metadataDisposition.kind
    === 'snapshot-restore'
    ? durableJournal.metadataDisposition.referenceJournal
    : undefined
  if (referenceProof?.transactionId && referenceProof.journalHash) {
    const ownerTransactionId = recoveryMarkerToken(path.basename(journalAbs), 'journal')
    if (!ownerTransactionId) {
      return result(
        durableJournal,
        'failed',
        'folder snapshot owner transaction id is missing',
      )
    }
    try {
      const handled = await markRenameReferenceMetadataHandled({
        contentDir: contentDirForFolderJournal(journalAbs, durableJournal),
        journalPath: path.join(
          path.dirname(journalAbs),
          referenceProof.relativePath,
        ),
        ownerJournal: path.basename(journalAbs),
        ownerTransactionId,
        ownerDescriptorHash: referenceProof.journalHash,
      })
      if (!handled) {
        return result(
          durableJournal,
          'quarantined',
          'folder snapshot metadata handoff could not be durably bound',
        )
      }
    } catch (error) {
      return result(
        durableJournal,
        'failed',
        `folder snapshot metadata handoff failed: ${(error as Error).message}`,
      )
    }
  }

  await hooks.afterMetadataMutationBeforeJournalRewrite?.()
  let metadataCommitted: FolderMoveJournalV4 & {
    phase: 'metadata-committed'
  }
  if (durableJournal.metadataDisposition.kind === 'prefix-move') {
    let committedSnapshot: DocumentMetadataMutationSnapshot
    try {
      const prefixDisposition = durableJournal.metadataDisposition
      committedSnapshot = prefixDisposition.preparedSnapshot
          && prefixDisposition.transactionTimestamp !== undefined
        ? reviveMetadataSnapshot(deriveCommittedPrefixSnapshot(
            prefixDisposition.preparedSnapshot,
            durableJournal.srcRel,
            durableJournal.destRel,
            prefixDisposition.transactionTimestamp,
          ))
        : snapshotDocumentMetadataPrefixMutation(
            db,
            [durableJournal.srcRel, durableJournal.destRel],
            prefixDisposition.preparedSnapshot?.paths ?? [],
          )
    } catch (error) {
      return result(
        durableJournal,
        'failed',
        `committed metadata snapshot capture failed: ${(error as Error).message}`,
      )
    }
    metadataCommitted = {
      ...durableJournal,
      phase: 'metadata-committed',
      metadataDisposition: {
        ...durableJournal.metadataDisposition,
        committedSnapshot: serializeMetadataSnapshot(committedSnapshot),
      },
    }
  } else {
    metadataCommitted = {
      ...durableJournal,
      phase: 'metadata-committed',
    }
  }
  try {
    await rewriteDurableJournal(journalAbs, metadataCommitted)
  } catch (error) {
    return result(metadataCommitted, 'failed', `metadata-committed journal rewrite failed: ${(error as Error).message}`)
  }
  await hooks.afterMetadataJournalRewriteBeforeFinalVerify?.()
  return finalizeFolderMoveV4Cleanup(
    db,
    journalAbs,
    metadataCommitted,
    srcAbs,
    destAbs,
    hooks,
  )
}

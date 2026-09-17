import { promises as fs } from 'node:fs'

import {
  validateFolderMoveGateProof,
  type FolderMoveJournalV4,
  type SerializedMetadataSnapshot,
} from './folderMoveTransaction.js'
import { validateFolderMoveDirectoryGeneration } from './folderMoveDirectoryOwnership.js'
import { validateSerializedMetadataSnapshot } from './metadataSnapshotClosure.js'

function movePrefixPath(
  value: string,
  fromPrefix: string,
  toPrefix: string,
): string {
  if (value === fromPrefix) return toPrefix
  return value.startsWith(`${fromPrefix}/`)
    ? toPrefix + value.slice(fromPrefix.length)
    : value
}

function snapshotRowOwnedPaths(
  snapshot: SerializedMetadataSnapshot,
): string[] {
  return [...new Set([
    ...snapshot.documents.map(row => String(row.path)),
    ...snapshot.migrations.flatMap(row => {
      const migrationPath = String(row.path)
      const originalPath = String(row.original_path ?? '')
      return [
        ...(migrationPath.startsWith('@deleted/') ? [] : [migrationPath]),
        ...(originalPath === '' ? [] : [originalPath]),
      ]
    }),
  ])]
}

function normalizeGenerationDecimal(
  value: unknown,
  options: { positive: boolean },
): string | null {
  const pattern = options.positive ? /^[1-9]\d*$/ : /^\d+$/
  if (typeof value === 'string') {
    return pattern.test(value) ? value : null
  }
  // Compatibility with v4 journals written before exact decimal
  // strings. Unsafe numbers have already lost precision and cannot
  // prove a directory generation, so they fail closed.
  if (typeof value === 'number'
    && Number.isSafeInteger(value)
    && (options.positive ? value > 0 : value >= 0)) {
    return String(value)
  }
  return null
}

export function parseFolderMoveJournalV4Object(value: unknown): FolderMoveJournalV4 | null {
  if (!value || typeof value !== 'object') return null
  const entry = value as Record<string, unknown>
  if (entry.version !== 4) return null
  if (entry.op !== 'folder-rename' && entry.op !== 'folder-move') return null
  if (typeof entry.srcRel !== 'string' || typeof entry.destRel !== 'string') return null
  const srcRel = entry.srcRel
  const destRel = entry.destRel
  const sourceDev = normalizeGenerationDecimal(entry.sourceDev, { positive: false })
  const sourceIno = normalizeGenerationDecimal(entry.sourceIno, { positive: true })
  if (sourceDev === null || sourceIno === null) return null
  const sourceBirthtimeNs = entry.sourceBirthtimeNs === undefined
    ? undefined
    : normalizeGenerationDecimal(entry.sourceBirthtimeNs, { positive: true })
  if (entry.sourceBirthtimeNs !== undefined && sourceBirthtimeNs === null) return null
  const destBirthtimeNs = entry.destBirthtimeNs === undefined
    ? undefined
    : normalizeGenerationDecimal(entry.destBirthtimeNs, { positive: true })
  if (entry.destBirthtimeNs !== undefined && destBirthtimeNs === null) return null
  if (entry.phase !== 'prepared' && entry.phase !== 'gate-created'
    && entry.phase !== 'files-landed' && entry.phase !== 'metadata-committed') return null
  if (entry.strategy !== 'atomic-rename' && entry.strategy !== 'replayable-move') return null
  if (!Array.isArray(entry.entries) || !Array.isArray(entry.directories)) return null
  // directoryGenerations remains optional only so historical v4
  // artifacts can be parsed for reporting. Recovery strength classifies
  // every missing/sparse/unsafe manifest as weak before mutation.
  let directoryGenerations:
    import('./folderMoveDirectoryOwnership.js').FolderMoveDirectoryEntry[] | undefined
  if (entry.directoryGenerations !== undefined) {
    if (!Array.isArray(entry.directoryGenerations)) return null
    directoryGenerations = []
    const seenPath = new Set<string>()
    for (const raw of entry.directoryGenerations as Array<Record<string, unknown>>) {
      if (!raw || typeof raw !== 'object') return null
      const rel = raw.relativeDirectoryPath
      const dev = raw.sourceDev
      const ino = raw.sourceIno
      const birthtimeNs = raw.sourceBirthtimeNs
      if (typeof rel !== 'string'
        || typeof dev !== 'string' || !/^\d+$/.test(dev)
        || typeof ino !== 'string' || !/^[1-9]\d*$/.test(ino)
        || (birthtimeNs !== undefined
          && (typeof birthtimeNs !== 'string'
            || !/^[1-9]\d*$/.test(birthtimeNs)))
        || seenPath.has(rel)) return null
      seenPath.add(rel)
      directoryGenerations.push({
        relativeDirectoryPath: rel,
        sourceDev: dev,
        sourceIno: ino,
        ...(birthtimeNs === undefined ? {} : { sourceBirthtimeNs: birthtimeNs }),
      })
    }
    if (validateFolderMoveDirectoryGeneration({
      directories: entry.directories as string[],
      directoryGenerations,
    }) !== null) {
      return null
    }
  }
  let destinationDirectoryGenerations:
    import('./folderMoveDirectoryOwnership.js').FolderMoveDirectoryEntry[] | undefined
  if (entry.destinationDirectoryGenerations !== undefined) {
    if (entry.phase === 'prepared'
      || entry.strategy !== 'replayable-move') return null
    if (!Array.isArray(entry.destinationDirectoryGenerations)) return null
    destinationDirectoryGenerations = []
    for (const raw of entry.destinationDirectoryGenerations as Array<Record<string, unknown>>) {
      if (!raw || typeof raw !== 'object'
        || typeof raw.relativeDirectoryPath !== 'string'
        || typeof raw.sourceDev !== 'string'
        || !/^\d+$/.test(raw.sourceDev)
        || typeof raw.sourceIno !== 'string'
        || !/^[1-9]\d*$/.test(raw.sourceIno)
        || (raw.sourceBirthtimeNs !== undefined
          && (typeof raw.sourceBirthtimeNs !== 'string'
            || !/^[1-9]\d*$/.test(raw.sourceBirthtimeNs)))) return null
      destinationDirectoryGenerations.push({
        relativeDirectoryPath: raw.relativeDirectoryPath,
        sourceDev: raw.sourceDev,
        sourceIno: raw.sourceIno,
        ...(raw.sourceBirthtimeNs === undefined
          ? {}
          : { sourceBirthtimeNs: raw.sourceBirthtimeNs }),
      })
    }
    if (validateFolderMoveDirectoryGeneration({
      directories: entry.directories as string[],
      directoryGenerations: destinationDirectoryGenerations,
    }) !== null) return null
  }
  if (entry.gateProof !== undefined && !validateFolderMoveGateProof(entry.gateProof)) return null
  if (typeof entry.metadataDisposition !== 'object' || entry.metadataDisposition === null) return null
  const disposition = entry.metadataDisposition as Record<string, unknown>
  if (disposition.kind === 'prefix-move') {
    if (disposition.transactionTimestamp !== undefined
      && (typeof disposition.transactionTimestamp !== 'number'
        || !Number.isSafeInteger(disposition.transactionTimestamp)
        || disposition.transactionTimestamp < 0)) return null
    const preparedSnapshot = disposition.preparedSnapshot as
      | SerializedMetadataSnapshot
      | undefined
    if (preparedSnapshot !== undefined
      && !validateSerializedMetadataSnapshot(
        preparedSnapshot,
        {
          mode: 'closed-graph',
          ownershipPaths: snapshotRowOwnedPaths(preparedSnapshot)
            .flatMap(item => [
              movePrefixPath(item, srcRel, destRel),
              movePrefixPath(item, destRel, srcRel),
            ]),
        },
      )) return null
    if (disposition.committedSnapshot !== undefined
      && !validateSerializedMetadataSnapshot(
        disposition.committedSnapshot as SerializedMetadataSnapshot,
        {
          mode: 'closed-graph',
          ownershipPaths: preparedSnapshot
            ? preparedSnapshot.paths.map(item =>
                movePrefixPath(item, srcRel, destRel))
            : [],
        },
      )) return null
    if (entry.phase !== 'metadata-committed'
      && disposition.committedSnapshot !== undefined) return null
  } else if (disposition.kind === 'snapshot-restore') {
    // P1-2: durable snapshot sites require the closed-graph check —
    // top-level ID set equality, row set equality, duplicate detection,
    // cross-table references. The weaker row-schema check is no longer
    // acceptable for v4 durable snapshot persistence.
    //
    // Stable order is part of the durable trust boundary. Never sort
    // untrusted bytes in-memory before validation: doing so would turn
    // a non-canonical journal into a recoverable one.
    const durableSnapshot = disposition.snapshot as SerializedMetadataSnapshot
    const ownershipPaths = disposition.ownershipFootprint
      && typeof disposition.ownershipFootprint === 'object'
      && Array.isArray(
        (disposition.ownershipFootprint as Record<string, unknown>).paths,
      )
      ? (disposition.ownershipFootprint as { paths: string[] }).paths
      : []
    if (!validateSerializedMetadataSnapshot(durableSnapshot, {
      mode: 'closed-graph',
      ownershipPaths,
    })) return null
    if (disposition.expectedCurrentSnapshot !== undefined
      && !validateSerializedMetadataSnapshot(
        disposition.expectedCurrentSnapshot as SerializedMetadataSnapshot,
        {
          mode: 'closed-graph',
          ownershipPaths,
        },
      )) return null
    if (disposition.physicalDocumentIds !== undefined
      && (!Array.isArray(disposition.physicalDocumentIds)
        || !disposition.physicalDocumentIds.every((id) =>
          typeof id === 'string' && id.length > 0)
        || new Set(disposition.physicalDocumentIds).size
          !== disposition.physicalDocumentIds.length)) return null
    const hasExpected = disposition.expectedCurrentSnapshot !== undefined
    const hasPhysicalIds = disposition.physicalDocumentIds !== undefined
    if (hasExpected !== hasPhysicalIds) return null
    const hasMetadataOnlyProofs =
      disposition.metadataOnlyDocumentProofs !== undefined
    const hasOwnershipFootprint =
      disposition.ownershipFootprint !== undefined
    if (hasMetadataOnlyProofs !== hasOwnershipFootprint) return null
    if (hasMetadataOnlyProofs) {
      if (!Array.isArray(disposition.metadataOnlyDocumentProofs)
        || !disposition.metadataOnlyDocumentProofs.every((proof) =>
          proof && typeof proof === 'object'
          && typeof (proof as Record<string, unknown>).documentId === 'string'
          && typeof (proof as Record<string, unknown>).path === 'string'
          && (
            (proof as Record<string, unknown>).reason === 'source-prefix'
            || (proof as Record<string, unknown>).reason === 'destination-prefix'
            || (proof as Record<string, unknown>).reason === 'reference-journal'
          ))) return null
      const footprint =
        disposition.ownershipFootprint as Record<string, unknown>
      if (!footprint || typeof footprint !== 'object'
        || !Array.isArray(footprint.paths)
        || !Array.isArray(footprint.documentIds)
        || !Array.isArray(footprint.tagIds)
        || !Array.isArray(footprint.migrationPaths)
        || !Array.isArray(footprint.migrationOriginalPaths)) return null
      if (disposition.referenceJournal !== undefined
        && (!disposition.referenceJournal
          || typeof disposition.referenceJournal !== 'object')) return null
      if (disposition.createdMetadataIds !== undefined) {
        const created = disposition.createdMetadataIds as Record<string, unknown>
        if (!created || typeof created !== 'object'
          || !Array.isArray(created.documentIds)
          || !Array.isArray(created.tagIds)) return null
      }
    }
  } else {
    return null
  }
  return {
    ...(entry as unknown as FolderMoveJournalV4),
    sourceDev,
    sourceIno,
    ...(sourceBirthtimeNs ? { sourceBirthtimeNs } : {}),
    ...(destBirthtimeNs ? { destBirthtimeNs } : {}),
    ...(directoryGenerations ? { directoryGenerations } : {}),
    ...(destinationDirectoryGenerations
      ? { destinationDirectoryGenerations }
      : {}),
  }
}

export function parseDurableFolderMoveJournalV4(raw: string): FolderMoveJournalV4 | null {
  try {
    return parseFolderMoveJournalV4Object(JSON.parse(raw))
  } catch {
    return null
  }
}

/** Read the journal that recovery will actually observe. Executor errors
 * carry their latest attempted in-memory phase, but an interrupted
 * rewrite may have left an older durable phase on disk. */
export async function readDurableFolderMoveJournalV4(
  journalAbs: string,
): Promise<FolderMoveJournalV4 | null> {
  try {
    return parseDurableFolderMoveJournalV4(await fs.readFile(journalAbs, 'utf8'))
  } catch {
    return null
  }
}

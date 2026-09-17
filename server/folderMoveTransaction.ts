// The durable folder-move transaction shared by every directory move
// the program performs — the folder rename route (forward AND its
// rollback), the rename-reference recovery rollback, and the folder
// delete rollback. ONE persisted schema, imported by the routes, the
// recovery parser, and the crash fixtures:
//
//   * `strategy` is the runtime DirectoryMoveStrategy itself — the
//     route persists exactly what the mover runs and the parser
//     accepts (round-7 P0);
//   * `entries` cover EVERY physical regular file the mover touches —
//     not just markdown (round-7 P1); empty trees carry `emptyTree`;
//   * `directories` cover EVERY subdirectory, including empty ones
//     (round-8 P1); v2 directories were optional → ambiguous; v3
//     enforces mandatory, sorted, ancestor-closed directories (round-9
//     F6);
//   * every replayable reverse move gets its own durable journal
//     BEFORE the first file moves (round-7 P1);
//   * v3 (round-9 F1–F6) promotes the gate token from a predictable
//     name to unpredictable content persisted in the journal so
//     recovery can verify the exact bytes, not just the filename;
//   * v3 entries persist source dev/ino so recovery can distinguish a
//     byte-identical external replacement from the original landed
//     generation — hash alone cannot tell them apart (round-9 F4).
//
// v4 uses a four-state phase machine (prepared → gate-created →
// files-landed → metadata-committed). New v4 transactions add an
// unpredictable marker proof to close directory-generation ABA;
// marker-less v4 journals remain parseable under strict legacy
// generation rules. State is always inferred from the persisted phase.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { sha256HexBuffer } from './atomicTextWrite.js'
import {
  captureDurableDirectoryIdentity,
  matchesDurableDirectoryIdentity,
} from './durableDirectoryIdentity.js'
import type { DocumentMetadataMutationSnapshot } from './documentMetadata.js'
import { UnsupportedDirectoryMoveError } from './documentFileLifecycle.js'
import { isManagedDiaryPath } from '../shared/diaryProtocol.js'
import { isRecoveryMarkerName } from './technicalNamespace.js'

/** Mutation-owner rejection for a folder transaction that would otherwise
 * read/hash or journal an encrypted managed-Diary file. Routes perform the
 * same preflight for user-facing semantics; this owner check protects
 * recovery and future non-HTTP callers. */
export class ManagedDiaryFolderMoveUnsupportedError extends Error {
  readonly code = 'diary-encrypted-reference-unsupported'

  constructor(path: string) {
    super(`folder operations touching managed Diary are unsupported: ${path}`)
    this.name = 'ManagedDiaryFolderMoveUnsupportedError'
  }
}

/** One physically moved file in a folder-move journal (schema v2/v3).
 * `relativeFilePath` keeps the real extension — recovery never appends
 * '.md'. `documentId`/`documentPath` exist ONLY for markdown documents
 * bound to metadata; attachments move without an identity. The pair is
 * all-or-nothing per entry. v3 adds `sourceDev`/`sourceIno` (string)
 * for generation-proof verification on replay. */
export type FolderMoveJournalEntry = {
  relativeFilePath: string
  sourceHash: string
  documentId?: string
  documentPath?: string
  sourceDev?: string
  sourceIno?: string
}

/** The physical enumeration a journal persists: every regular file
 * (with content hash) AND every subdirectory (including empty ones). */
export type FolderMoveEnumeration = {
  entries: FolderMoveJournalEntry[]
  directories: string[]
  directoryGenerations: Array<{
    relativeDirectoryPath: string
    sourceDev: string
    sourceIno: string
    sourceBirthtimeNs: string
  }>
}

/** The metadata outcome a completed move must produce. Rename moves
 * (forward and rollback) shift the live prefix; a delete rollback
 * re-installs the exact snapshot the delete detached (embeddings
 * included — base64-marked so the JSON journal round-trips Buffers). */
export type FolderMovePrefixMetadataDisposition = {
  kind: 'prefix-move'
  transactionTimestamp?: number
  preparedSnapshot?: SerializedMetadataSnapshot
  committedSnapshot?: SerializedMetadataSnapshot
}

export type FolderMoveMetadataOnlyDocumentProof = {
  documentId: string
  path: string
  reason: 'source-prefix' | 'destination-prefix' | 'reference-journal'
}

export type FolderMoveMetadataOwnershipFootprint = {
  paths: string[]
  documentIds: string[]
  tagIds: number[]
  migrationPaths: string[]
  migrationOriginalPaths: string[]
}

export type FolderMoveReferenceJournalProof = {
  relativePath: string
  operation: 'folder-rename-references'
  transactionId?: string
  journalHash?: string
  srcRel?: string
  destRel?: string
  references: Array<{
    documentId: string
    sourcePath: string
    writePath: string
    beforeHash: string
    afterHash: string
    beforePayload?: string
    afterPayload?: string
  }>
}

export type FolderMoveCreatedMetadataIds = {
  documentIds: string[]
  tagIds: number[]
}

export type ParsedFolderRenameReferenceJournal = {
  version: 1
  op: 'folder-rename-references'
  phase: 'preparing' | 'roll-forward' | 'roll-back' | 'cleanup'
  srcRel: string
  destRel: string
  transactionId?: string
  descriptorHash?: string
  identities: Array<{ path: string; id: string; sourceHash?: string }>
  referenceIdentities?: FolderMoveReferenceJournalProof['references']
  metadataDisposition?: {
    kind: 'legacy-prefix-move'
  } | {
    kind: 'folder-snapshot-owned'
    ownerJournal: string
    ownerTransactionId: string
    ownerDescriptorHash: string
    metadataHandled: boolean
  } | {
    kind: 'folder-snapshot-owner-pending'
    ownerJournal: string
    ownerTransactionId: string
    ownerDescriptorHash: string
    previousDirection: 'roll-forward' | 'roll-back'
  } | {
    kind: 'folder-snapshot-owner-aborted'
    ownerJournal: string
    ownerTransactionId: string
    ownerDescriptorHash: string
    previousDirection: 'roll-forward' | 'roll-back'
    reason: 'owner-journal-absent'
  }
  references: Array<{
    path: string
    beforeHash: string
    afterHash: string
    beforePayload: string
    afterPayload: string
  }>
}

export type FolderMoveSnapshotRestoreDisposition = {
  kind: 'snapshot-restore'
  snapshot: SerializedMetadataSnapshot
  expectedCurrentSnapshot?: SerializedMetadataSnapshot
  physicalDocumentIds?: string[]
  metadataOnlyDocumentProofs?: FolderMoveMetadataOnlyDocumentProof[]
  ownershipFootprint?: FolderMoveMetadataOwnershipFootprint
  referenceJournal?: FolderMoveReferenceJournalProof
  createdMetadataIds?: FolderMoveCreatedMetadataIds
}

export type FolderMoveMetadataDisposition =
  | FolderMovePrefixMetadataDisposition
  | FolderMoveSnapshotRestoreDisposition

export type SerializedMetadataSnapshot = {
  paths: string[]
  documentIds: string[]
  tagIds: number[]
  preexistingTagIds: number[]
  documents: Record<string, unknown>[]
  tags: Record<string, unknown>[]
  documentTags: Record<string, unknown>[]
  /** New journals mark the physical row generation explicitly. Legacy v6
   * journals omit this field and are classified from their exact row shape. */
  documentTagsVersion?: 6 | 7
  embeddings: Record<string, unknown>[]
  migrations: Record<string, unknown>[]
}

export type DocumentTagsSnapshotGeneration = 'v6' | 'v7'

/** Generate an unpredictable gate-token secret (32 random bytes → 64
 * hex chars). The journal persists it so recovery can verify the exact
 * bytes inside the gate marker file — an external writer who plants a
 * file with the correct name but wrong content is detected (round-9
 * F2). */
export function generateGateTokenSecret(): string {
  return randomBytes(32).toString('hex')
}

const BUFFER_MARKER = '__nuvynBuffer'

function bufferMarker(value: unknown): string | null {
  if (!isPlainRecord(value)) return null
  return typeof value[BUFFER_MARKER] === 'string' && Object.keys(value).length === 1
    ? BUFFER_MARKER
    : null
}

function encodeBufferValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return { [BUFFER_MARKER]: value.toString('base64') }
  if (value instanceof Uint8Array) return { [BUFFER_MARKER]: Buffer.from(value).toString('base64') }
  return value
}

function decodeBufferValue(value: unknown): unknown {
  const marker = bufferMarker(value)
  if (marker) return Buffer.from((value as Record<string, string>)[marker], 'base64')
  return value
}

function mapRow(row: Record<string, unknown>, convert: (value: unknown) => unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) out[key] = convert(value)
  return out
}

/** Serialize a metadata mutation snapshot for a durable journal. Only
 * binary columns (embedding vectors) need marking — metadata, never
 * draft bodies, travels through the journal. */
export function serializeMetadataSnapshot(snapshot: DocumentMetadataMutationSnapshot): SerializedMetadataSnapshot {
  return {
    paths: [...new Set(snapshot.paths)].sort(),
    documentIds: [...new Set(snapshot.documentIds)].sort(),
    tagIds: [...new Set(snapshot.tagIds)].sort((left, right) => left - right),
    preexistingTagIds: [...new Set(snapshot.preexistingTagIds)].sort((left, right) => left - right),
    documents: snapshot.documents.map((row) => mapRow(row, encodeBufferValue)),
    tags: snapshot.tags.map((row) => mapRow(row, encodeBufferValue)),
    documentTags: snapshot.documentTags.map((row) => mapRow(row, encodeBufferValue)),
    documentTagsVersion: 7,
    embeddings: snapshot.embeddings.map((row) => mapRow(row, encodeBufferValue)),
    migrations: snapshot.migrations.map((row) => mapRow(row, encodeBufferValue)),
  }
}

export function reviveMetadataSnapshot(serialized: SerializedMetadataSnapshot): DocumentMetadataMutationSnapshot {
  const documents = serialized.documents.map((row) => {
    const revived = mapRow(row, decodeBufferValue)
    // Durable folder journals written before D7.1 do not contain the new
    // nullable column. The live schema supplies NULL for those rows, so
    // normalize the legacy shape at the recovery boundary before ownership
    // comparison or reinsertion.
    return Object.prototype.hasOwnProperty.call(revived, 'mood')
      ? revived
      : { ...revived, mood: null }
  })
  return {
    paths: [...serialized.paths],
    documentIds: [...serialized.documentIds],
    tagIds: [...serialized.tagIds],
    preexistingTagIds: [...serialized.preexistingTagIds],
    documents,
    tags: serialized.tags.map((row) => mapRow(row, decodeBufferValue)),
    documentTags: serialized.documentTags.map((row) => mapRow(row, decodeBufferValue)),
    embeddings: serialized.embeddings.map((row) => mapRow(row, decodeBufferValue)),
    migrations: serialized.migrations.map((row) => mapRow(row, decodeBufferValue)),
  }
}

function moveSerializedPrefixPath(
  value: string,
  fromPrefix: string,
  toPrefix: string,
): string {
  if (value === fromPrefix) return toPrefix
  return value.startsWith(`${fromPrefix}/`)
    ? toPrefix + value.slice(fromPrefix.length)
    : value
}

/** Deterministically compute the exact graph a prefix transition commits. */
export function deriveCommittedPrefixSnapshot(
  prepared: SerializedMetadataSnapshot,
  srcRel: string,
  destRel: string,
  transactionTimestamp: number,
): SerializedMetadataSnapshot {
  const destinationDocumentIds = new Set(
    prepared.documents
      .filter(row => pathWithinPrefix(String(row.path), destRel))
      .map(row => String(row.id)),
  )
  const documents: Record<string, unknown>[] = prepared.documents
    .filter(row => !destinationDocumentIds.has(String(row.id)))
    .map((row): Record<string, unknown> => {
    const currentPath = String(row.path)
    const nextPath = moveSerializedPrefixPath(currentPath, srcRel, destRel)
    return nextPath === currentPath
      ? { ...row }
      : { ...row, path: nextPath, updated_at: transactionTimestamp }
    })
  const migrations = prepared.migrations.map((row) => {
    const originalDocumentId = typeof row.document_id === 'string'
      ? row.document_id
      : null
    const destinationDocument = prepared.documents.find(document =>
      String(document.id) === originalDocumentId)
    if (destinationDocument
      && destinationDocumentIds.has(String(destinationDocument.id))
      && row.path === destinationDocument.path) {
      return {
        ...row,
        path: `@deleted/${String(destinationDocument.id)}`,
        document_id: null,
        original_path: row.original_path === ''
          ? String(row.path)
          : row.original_path,
        status: 'orphaned',
        updated_at: transactionTimestamp,
      }
    }
    const detached = originalDocumentId !== null
      && destinationDocumentIds.has(originalDocumentId)
      ? { ...row, document_id: null }
      : { ...row }
    const currentPath = String(row.path)
    const currentOriginalPath = String(row.original_path)
    const nextPath = moveSerializedPrefixPath(currentPath, srcRel, destRel)
    const nextOriginalPath = currentOriginalPath
      ? moveSerializedPrefixPath(currentOriginalPath, srcRel, destRel)
      : ''
    return nextPath === currentPath && nextOriginalPath === currentOriginalPath
      ? detached
      : {
          ...detached,
          path: nextPath,
          original_path: nextOriginalPath,
          updated_at: transactionTimestamp,
        }
  })
  const committed = {
    ...prepared,
    paths: [...new Set(prepared.paths.map(item =>
      moveSerializedPrefixPath(item, srcRel, destRel)))].sort(),
    documents,
    documentIds: documents.map(row => String(row.id)).sort(),
    documentTags: prepared.documentTags.filter(row =>
      !destinationDocumentIds.has(String(row.document_id))),
    embeddings: prepared.embeddings.filter(row =>
      !destinationDocumentIds.has(String(row.document_id))),
    migrations,
  }
  if (!isSerializedMetadataSnapshot(committed)) {
    throw new Error('derived committed prefix snapshot is not a closed metadata graph')
  }
  return committed
}

const SNAPSHOT_COLUMNS = new Set([
  'paths', 'documentIds', 'tagIds', 'preexistingTagIds', 'documents',
  'tags', 'documentTags', 'embeddings', 'migrations',
])
const SNAPSHOT_VERSIONED_COLUMNS = new Set([...SNAPSHOT_COLUMNS, 'documentTagsVersion'])
const LEGACY_DOCUMENT_COLUMNS = ['id', 'path', 'title', 'summary', 'created_at', 'updated_at'] as const
const DOCUMENT_COLUMNS = [...LEGACY_DOCUMENT_COLUMNS, 'mood'] as const
const TAG_COLUMNS = ['id', 'name', 'normalized_name'] as const
const LEGACY_DOCUMENT_TAG_COLUMNS = ['document_id', 'tag_id'] as const
const V7_DOCUMENT_TAG_COLUMNS = ['association_id', 'document_id', 'tag_id'] as const
const EMBEDDING_COLUMNS = ['document_id', 'content_hash', 'model', 'embedding', 'indexed_at'] as const
const MIGRATION_COLUMNS = [
  'path', 'document_id', 'original_path', 'status', 'source_hash', 'error', 'updated_at', 'frontmatter_backup', 'cleaned_hash',
 ] as const
const MIGRATION_STATUSES = new Set([
  'legacy', 'imported', 'verified', 'cleaned', 'failed', 'orphaned',
])

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactColumns(
  row: unknown,
  columns: readonly string[],
): row is Record<string, unknown> {
  if (!isPlainRecord(row)) return false
  const keys = Object.keys(row).sort()
  return keys.length === columns.length
    && keys.every((key, index) => key === [...columns].sort()[index])
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isSafeInteger(value) && value > 0
}

function isSerializedBufferMarker(value: unknown): boolean {
  const marker = bufferMarker(value)
  if (!marker) return false
  const encoded = (value as Record<string, unknown>)[marker]
  if (typeof encoded !== 'string') return false
  try {
    return Buffer.from(encoded, 'base64').toString('base64') === encoded
  } catch {
    return false
  }
}

function isDocumentRow(row: unknown): row is Record<string, unknown> {
  // D7.1 adds the nullable live Mood field to the same documents owner.
  // Existing durable folder journals predate that column and remain valid;
  // SQLite supplies NULL when such a legacy row is restored.
  const hasKnownColumns = hasExactColumns(row, DOCUMENT_COLUMNS)
    || hasExactColumns(row, LEGACY_DOCUMENT_COLUMNS)
  return hasKnownColumns
    && isNonEmptyString(row.id)
    && typeof row.path === 'string' && validRelativePath(row.path)
    && typeof row.title === 'string'
    && typeof row.summary === 'string'
    && (row.mood === undefined || row.mood === null || typeof row.mood === 'string')
    && isSafeInteger(row.created_at)
    && isSafeInteger(row.updated_at)
}

function isTagRow(row: unknown): row is Record<string, unknown> {
  return hasExactColumns(row, TAG_COLUMNS)
    && isPositiveSafeInteger(row.id)
    && isNonEmptyString(row.name)
    && isNonEmptyString(row.normalized_name)
}

function isDocumentTagRow(row: unknown): row is Record<string, unknown> {
  const legacy = hasExactColumns(row, LEGACY_DOCUMENT_TAG_COLUMNS)
    && isNonEmptyString(row.document_id)
    && isPositiveSafeInteger(row.tag_id)
  const v7 = hasExactColumns(row, V7_DOCUMENT_TAG_COLUMNS)
    && isPositiveSafeInteger(row.association_id)
    && isNonEmptyString(row.document_id)
    && isPositiveSafeInteger(row.tag_id)
  return legacy || v7
}

function hasSnapshotColumns(snapshot: unknown): snapshot is Record<string, unknown> {
  if (!isPlainRecord(snapshot)) return false
  const keys = new Set(Object.keys(snapshot))
  const base = [...SNAPSHOT_COLUMNS].every((key) => keys.has(key))
  if (!base) return false
  if (keys.size === SNAPSHOT_COLUMNS.size) return true
  return keys.size === SNAPSHOT_VERSIONED_COLUMNS.size && keys.has('documentTagsVersion')
}

/** Classify the exact durable row generation. A mixed v6/v7 array is never
 * normalized heuristically: it is rejected as malformed. */
export function getDocumentTagsSnapshotGeneration(
  snapshot: unknown,
): DocumentTagsSnapshotGeneration | null {
  if (!hasSnapshotColumns(snapshot)) return null
  const entry = snapshot as Record<string, unknown>
  const marker = entry.documentTagsVersion
  if (marker !== undefined && marker !== 6 && marker !== 7) return null
  const generations = new Set<DocumentTagsSnapshotGeneration>()
  const rows = entry.documentTags
  if (!Array.isArray(rows)) return null
  for (const row of rows) {
    if (hasExactColumns(row, LEGACY_DOCUMENT_TAG_COLUMNS)) generations.add('v6')
    else if (hasExactColumns(row, V7_DOCUMENT_TAG_COLUMNS)) generations.add('v7')
    else return null
  }
  if (generations.size > 1) return null
  const inferred = generations.values().next().value as DocumentTagsSnapshotGeneration | undefined
  if (marker !== undefined && inferred !== undefined && marker !== (inferred === 'v7' ? 7 : 6)) return null
  if (marker === 7) return 'v7'
  if (marker === 6) return 'v6'
  // An empty unmarked snapshot predates the explicit marker. It has no
  // physical rows whose provenance could be restored, so treating it as v6
  // is the conservative legacy interpretation.
  return inferred ?? 'v6'
}

function isEmbeddingRow(row: unknown): row is Record<string, unknown> {
  return hasExactColumns(row, EMBEDDING_COLUMNS)
    && isNonEmptyString(row.document_id)
    && typeof row.content_hash === 'string'
    && typeof row.model === 'string'
    && isSerializedBufferMarker(row.embedding)
    && isSafeInteger(row.indexed_at)
}

function isMigrationRow(row: unknown): row is Record<string, unknown> {
  return hasExactColumns(row, MIGRATION_COLUMNS)
    && typeof row.path === 'string'
    && (row.path.startsWith('@deleted/')
      ? isNonEmptyString(row.path.slice('@deleted/'.length))
      : validRelativePath(row.path))
    && (row.document_id === null || isNonEmptyString(row.document_id))
    && typeof row.original_path === 'string'
    && (row.original_path === '' || validRelativePath(row.original_path))
    && typeof row.status === 'string' && MIGRATION_STATUSES.has(row.status)
    && typeof row.source_hash === 'string'
    && typeof row.error === 'string'
    && isSafeInteger(row.updated_at)
    && typeof row.frontmatter_backup === 'string'
    && typeof row.cleaned_hash === 'string'
}

function isStableUniqueStrings(value: unknown, pathValues = false): value is string[] {
  return Array.isArray(value)
    && value.every(item => isNonEmptyString(item)
      && (!pathValues || validRelativePath(item)))
    && value.every((item, index) => index === 0 || value[index - 1] < item)
}

function isStableUniquePositiveIntegers(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.every(isPositiveSafeInteger)
    && value.every((item, index) => index === 0 || value[index - 1] < item)
}

export function isSerializedMetadataSnapshot(
  snapshot: unknown,
): snapshot is SerializedMetadataSnapshot {
  if (!hasSnapshotColumns(snapshot)) return false
  const item = snapshot as Partial<SerializedMetadataSnapshot>
  const isArrayOf = (
    value: unknown,
    check: (element: unknown) => boolean,
  ): boolean => Array.isArray(value) && value.every(check)
  if (!isStableUniqueStrings(item.paths, true)
    || !isStableUniqueStrings(item.documentIds)
    || !isStableUniquePositiveIntegers(item.tagIds)
    || !isStableUniquePositiveIntegers(item.preexistingTagIds)
    || !isArrayOf(item.documents, isDocumentRow)
    || !isArrayOf(item.tags, isTagRow)
    || !isArrayOf(item.documentTags, isDocumentTagRow)
    || !isArrayOf(item.embeddings, isEmbeddingRow)
    || !isArrayOf(item.migrations, isMigrationRow)) {
    return false
  }
  const generation = getDocumentTagsSnapshotGeneration(snapshot)
  if (!generation) return false
  const parsed = item as SerializedMetadataSnapshot

  const documentIds = new Set(parsed.documents.map(row => row.id as string))
  const documentPaths = new Set(parsed.documents.map(row => row.path as string))
  const tagIds = new Set(parsed.tags.map(row => row.id as number))
  const normalizedTagNames = new Set(parsed.tags.map(row => row.normalized_name as string))
  if (documentIds.size !== parsed.documents.length
    || documentPaths.size !== parsed.documents.length
    || tagIds.size !== parsed.tags.length
    || normalizedTagNames.size !== parsed.tags.length
    || !setEquals(new Set(parsed.documentIds), documentIds)
    || !setEquals(new Set(parsed.tagIds), tagIds)
    || !parsed.documents.every(row =>
      parsed.paths.includes(row.path as string))) {
    return false
  }
  const documentTagKeys = new Set<string>()
  const associationIds = new Set<number>()
  for (const row of parsed.documentTags) {
    if (!documentIds.has(row.document_id as string)
      || (!tagIds.has(row.tag_id as number)
        && !parsed.preexistingTagIds.includes(row.tag_id as number))) {
      return false
    }
    const key = `${row.document_id}\0${row.tag_id}`
    if (documentTagKeys.has(key)) return false
    documentTagKeys.add(key)
    if (generation === 'v7') {
      const associationId = row.association_id
      if (!isPositiveSafeInteger(associationId) || associationIds.has(associationId)) return false
      associationIds.add(associationId)
    }
  }
  const embeddingIds = new Set<string>()
  for (const row of parsed.embeddings) {
    const id = row.document_id as string
    if (!documentIds.has(id) || embeddingIds.has(id)) return false
    embeddingIds.add(id)
  }
  const migrationPaths = new Set<string>()
  for (const row of parsed.migrations) {
    const migrationPath = row.path as string
    const migrationDocumentId = row.document_id as string | null
    const deletedId = migrationPath.startsWith('@deleted/')
      ? migrationPath.slice('@deleted/'.length)
      : null
    if (migrationPaths.has(migrationPath)
      || (migrationDocumentId !== null
        && !documentIds.has(migrationDocumentId))
      || (deletedId !== null && !documentIds.has(deletedId))) {
      return false
    }
    migrationPaths.add(migrationPath)
  }
  return true
}

export function hasValidSnapshotRowSchema(
  snapshot: unknown,
): snapshot is SerializedMetadataSnapshot {
  if (!hasSnapshotColumns(snapshot)) return false
  const item = snapshot as Partial<SerializedMetadataSnapshot>
  return Array.isArray(item.paths)
    && item.paths.every(value =>
      typeof value === 'string' && validRelativePath(value))
    && Array.isArray(item.documentIds)
    && item.documentIds.every(isNonEmptyString)
    && Array.isArray(item.tagIds)
    && item.tagIds.every(isPositiveSafeInteger)
    && Array.isArray(item.preexistingTagIds)
    && item.preexistingTagIds.every(isPositiveSafeInteger)
    && Array.isArray(item.documents) && item.documents.every(isDocumentRow)
    && Array.isArray(item.tags) && item.tags.every(isTagRow)
    && Array.isArray(item.documentTags)
    && item.documentTags.every(isDocumentTagRow)
    && Array.isArray(item.embeddings)
    && item.embeddings.every(isEmbeddingRow)
    && Array.isArray(item.migrations)
    && item.migrations.every(isMigrationRow)
    && getDocumentTagsSnapshotGeneration(snapshot) !== null
}

function setEquals(a: Set<unknown>, b: Set<unknown>): boolean {
  if (a.size !== b.size) return false
  for (const value of a) if (!b.has(value)) return false
  return true
}

/**
 * Trust boundary for a persisted delete-rollback snapshot (round-8 P0).
 * `restoreDocumentMetadataMutation` deletes every row matching the
 * snapshot's paths/ids and re-inserts the snapshot rows verbatim — so a
 * forged journal could delete or replace metadata anywhere in the vault
 * unless the snapshot is proven to describe ONLY the folder being
 * restored (`destRel`). Every constraint below is required; any failure
 * makes the journal unparseable so recovery never touches the DB:
 *
 *   * paths all sit inside the destRel subtree;
 *   * documents[].path ∈ paths and documents[].id ∈ documentIds, and
 *     set(documentIds) === set(documents[].id) exactly (a deleted id
 *     always carries its row, and no foreign id is deletable);
 *   * document_tags / embeddings reference only those documentIds (and
 *     tag_ids only the declared tags);
 *   * set(tags[].id) === set(tagIds) exactly;
 *   * migrations reference only the same paths / ids;
 *   * every row carries exactly its table's columns.
 */
export function isValidDeleteRollbackSnapshot(snapshot: unknown, destRel: string): snapshot is SerializedMetadataSnapshot {
  if (!isSerializedMetadataSnapshot(snapshot)) return false
  const item = snapshot

  const paths = item.paths as string[]
  const documentIds = item.documentIds as string[]
  const tagIds = item.tagIds as number[]
  const documents = item.documents as Record<string, unknown>[]
  const tags = item.tags as Record<string, unknown>[]
  const documentTags = item.documentTags as Record<string, unknown>[]
  const embeddings = item.embeddings as Record<string, unknown>[]
  const migrations = item.migrations as Record<string, unknown>[]

  // Every path is inside the restored folder's subtree — never a
  // sibling or an unrelated document.
  const inSubtree = (p: unknown): boolean => typeof p === 'string' && p.startsWith(`${destRel}/`)
  if (!paths.every(inSubtree)) return false

  // documentIds and documents[].id are the SAME set; every document
  // path is one of the declared (subtree) paths.
  const pathSet = new Set(paths)
  const idSet = new Set(documentIds)
  const documentIdSet = new Set(documents.map((row) => row.id))
  if (!setEquals(idSet, documentIdSet)) return false
  if (!documents.every((row) => typeof row.id === 'string' && typeof row.path === 'string' && pathSet.has(row.path) && inSubtree(row.path))) return false

  // tags[].id is exactly the declared tagIds.
  const tagIdSet = new Set(tagIds)
  if (!setEquals(new Set(tags.map((row) => row.id)), tagIdSet)) return false

  // document_tags / embeddings reference only declared ids.
  if (!documentTags.every((row) => typeof row.document_id === 'string' && idSet.has(row.document_id)
    && typeof row.tag_id === 'number' && tagIdSet.has(row.tag_id))) return false
  if (!embeddings.every((row) => typeof row.document_id === 'string' && idSet.has(row.document_id))) return false

  // migrations reference only this transaction's paths / ids. A
  // migration path is either a subtree path or the `@deleted/<id>`
  // tombstone of a declared id; document_id (when set) is declared;
  // original_path (when non-empty) is a subtree path.
  for (const row of migrations) {
    const mPath = row.path
    const okPath = inSubtree(mPath) || (typeof mPath === 'string' && mPath.startsWith('@deleted/') && idSet.has(mPath.slice('@deleted/'.length)))
    if (!okPath) return false
    if (row.document_id !== null && row.document_id !== undefined) {
      if (typeof row.document_id !== 'string' || !idSet.has(row.document_id)) return false
    }
    if (row.original_path !== '' && row.original_path !== undefined && !inSubtree(row.original_path)) return false
  }
  return true
}

/** Enumerate EVERY regular file (with content hash) AND every
 * subdirectory under dirAbs — the journal must cover exactly what the
 * mover will move and recreate: markdown, images, PDFs, any attachment,
 * and empty directories (visible vault state). A symlink/junction or
 * special entry cannot move create-only (link(2) would FOLLOW it
 * outside the tree): fail closed before anything is journaled or
 * moved. */
export async function listPhysicalMoveEntries(
  dirAbs: string,
  identityFor?: (relativeFilePath: string) => { documentId: string; documentPath: string } | null,
  /** Logical path of `dirAbs` in the content tree. Supplying this lets the
   *  owner classify canonical managed-Diary children even when a legacy
   *  metadata row is absent (for example, during rollback recovery). */
  logicalRoot?: string,
): Promise<FolderMoveEnumeration> {
  const rootIdentity = await captureDurableDirectoryIdentity(dirAbs)
  const entries: FolderMoveJournalEntry[] = []
  const directories: string[] = []
  const directoryGenerations: FolderMoveEnumeration['directoryGenerations'] = []
  const walk = async (dir: string, rel: string): Promise<void> => {
    const dirents = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of dirents) {
      const entryRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      const entryAbs = path.join(dir, entry.name)
      const stat = await fs.lstat(entryAbs, { bigint: true })
      if (entry.isDirectory() && stat.isDirectory() && !stat.isSymbolicLink()) {
        directories.push(entryRel)
        const directoryIdentity =
          await captureDurableDirectoryIdentity(entryAbs)
        directoryGenerations.push({
          relativeDirectoryPath: entryRel,
          sourceDev: directoryIdentity.dev,
          sourceIno: directoryIdentity.ino,
          sourceBirthtimeNs: directoryIdentity.birthtimeNs,
        })
        await walk(entryAbs, entryRel)
        const after = await fs.lstat(entryAbs, { bigint: true })
        if (!matchesDurableDirectoryIdentity(after, directoryIdentity)) {
          throw new Error('folder move source changed during durable enumeration')
        }
      } else if (entry.isFile() && stat.isFile() && !stat.isSymbolicLink()) {
        const identity = identityFor?.(entryRel)
        const derivedLogicalPath = logicalRoot !== undefined && entryRel.endsWith('.md')
          ? (logicalRoot ? `${logicalRoot}/${entryRel.slice(0, -'.md'.length)}` : entryRel.slice(0, -'.md'.length))
          : identity?.documentPath
        if (derivedLogicalPath && isManagedDiaryPath(derivedLogicalPath.replace(/\.md$/, ''))) {
          // Classification is deliberately before fs.readFile: encrypted
          // Diary bytes must not enter this generic hash/journal owner.
          throw new ManagedDiaryFolderMoveUnsupportedError(derivedLogicalPath)
        }
        const raw = await fs.readFile(entryAbs)
        const item: FolderMoveJournalEntry = {
          relativeFilePath: entryRel,
          sourceHash: sha256HexBuffer(raw),
          sourceDev: stat.dev.toString(),
          sourceIno: stat.ino.toString(),
        }
        if (identity) {
          item.documentId = identity.documentId
          item.documentPath = identity.documentPath
        }
        entries.push(item)
      } else {
        throw new UnsupportedDirectoryMoveError(`unsupported entry inside the moved folder: ${entryRel}`)
      }
    }
  }
  await walk(dirAbs, '')
  const rootAfter = await fs.lstat(dirAbs, { bigint: true })
  if (!matchesDurableDirectoryIdentity(rootAfter, rootIdentity)) {
    throw new Error('folder move source changed during durable enumeration')
  }
  const codeUnitCompare = (left: string, right: string): number =>
    left < right ? -1 : left > right ? 1 : 0
  entries.sort((a, b) =>
    codeUnitCompare(a.relativeFilePath, b.relativeFilePath))
  directories.sort(codeUnitCompare)
  directoryGenerations.sort((a, b) =>
    codeUnitCompare(a.relativeDirectoryPath, b.relativeDirectoryPath))
  return { entries, directories, directoryGenerations }
}

// ---- v3 markdown identity schema enforcement (round-10 F6) ----

/** Round-10 F6: every journal entry's identity pairing must be exact.
 *
 *   * Markdown entries (.md) MUST carry BOTH `documentId` and
 *     `documentPath`. The `documentPath` must equal the journaled
 *     subtree root + this entry's relative path without its `.md`
 *     extension — so an attacker cannot bind a foreign identity to a
 *     physical attachment (image.bin → documentPath="...") and get
 *     the rollback / recovery to move metadata that doesn't belong to
 *     the bytes on disk.
 *
 *   * Attachment entries (non-.md) MUST NOT carry either field —
 *     image.bin with a documentId would let a malicious journal claim
 *     metadata ownership of a non-markdown file.
 *
 * Returns null on success or a reason string on failure. */
export function validateJournalEntriesV3(
  entries: readonly FolderMoveJournalEntry[],
  srcRel: string,
): string | null {
  for (const entry of entries) {
    const rel = entry.relativeFilePath
    const isMarkdown = rel.endsWith('.md')
    const hasDocumentId = entry.documentId !== undefined && entry.documentId !== null && entry.documentId !== ''
    const hasDocumentPath = entry.documentPath !== undefined && entry.documentPath !== null && entry.documentPath !== ''
    if (isMarkdown) {
      if (!hasDocumentId || !hasDocumentPath) {
        return `markdown entry missing identity: ${rel}`
      }
      // documentPath must equal srcRel + "/" + rel without .md
      const expectedPath = `${srcRel}/${rel.slice(0, -'.md'.length)}`
      if (entry.documentPath !== expectedPath) {
        return `markdown entry documentPath mismatch: ${rel} declared ${entry.documentPath} expected ${expectedPath}`
      }
    } else {
      if (hasDocumentId || hasDocumentPath) {
        return `attachment carrying markdown identity: ${rel}`
      }
    }
  }
  return null
}

// ---- v3 directory-manifest validation (round-9 F6) ----

/** Reserved path segments that no journaled file or directory is
 * allowed to claim (round-10 F9). These names belong to vault internals
 * — moving them through a folder-move journal could let an attacker
 * bind a Nuvyn identity to an internal artifact or shadow a real
 * document. */
export const RESERVED_PATH_SEGMENTS = [
  '.git',
  'node_modules',
  '.nuvyn-journal-',
  '.nuvyn-folder-gate-',
  '.nuvyn-rename-',
  '.nuvyn-staged-',
  '.nuvyn-delete-inflight-',
  '.nuvyn-quarantine-reuse-',
  '.nuvyn-delete-manifest-',
  'metadata.sqlite',
]

/** Validate a v3 `directories` manifest: must be non-null, sorted, no
 * duplicates, every file's parent and every directory's ancestor must
 * be declared, and no path can be simultaneously a file and a
 * directory. Returns null on success or a reason string on failure. */
export function validateDirectoryManifest(
  directories: string[],
  entryRels: string[],
  reservedPrefixes: string[] = [],
): string | null {
  // Must be present (even if empty).
  if (!Array.isArray(directories)) return 'directories missing'
  // No duplicates; canonical sorted order.
  if (new Set(directories).size !== directories.length) return 'duplicate directory'
  const sorted = [...directories].sort((a, b) => a.localeCompare(b))
  for (let i = 0; i < directories.length; i++) {
    if (directories[i] !== sorted[i]) return 'directories not sorted'
  }
  const dirSet = new Set(directories)
  const allReserved = [...RESERVED_PATH_SEGMENTS, ...reservedPrefixes]
  // Every directory entry must be a valid relative path.
  for (const dir of directories) {
    if (!dir || dir.startsWith('/') || dir.endsWith('/') || dir.includes('\\') || dir.includes('\0')) return `invalid directory path: ${dir}`
    const segments = dir.split('/')
    if (segments.some((s) => s.length === 0 || s === '.' || s === '..')) return `invalid directory path: ${dir}`
    // Reserved names.
    for (const prefix of allReserved) {
      if (segments.some((s) => s === prefix || s.startsWith(prefix))) return `reserved directory segment: ${dir}`
    }
  }
  // No file path is also a directory path; and no file path is reserved.
  for (const fileRel of entryRels) {
    if (dirSet.has(fileRel)) return `file path also listed as directory: ${fileRel}`
    const segments = fileRel.split('/')
    if (segments.some((s) => s.length === 0 || s === '.' || s === '..')) return `invalid file path: ${fileRel}`
    for (const prefix of allReserved) {
      if (segments.some((s) => s === prefix || s.startsWith(prefix))) return `reserved file segment: ${fileRel}`
    }
  }
  // Every file's parent directories must be declared.
  for (const fileRel of entryRels) {
    const parts = fileRel.split('/')
    for (let i = 1; i < parts.length; i++) {
      const ancestor = parts.slice(0, i).join('/')
      if (!dirSet.has(ancestor)) return `missing file parent directory: ${ancestor} (required by ${fileRel})`
    }
  }
  // Every directory's ancestor must be declared (ancestor closure).
  for (const dir of directories) {
    const parts = dir.split('/')
    for (let i = 1; i < parts.length; i++) {
      const ancestor = parts.slice(0, i).join('/')
      if (!dirSet.has(ancestor)) return `missing directory ancestor: ${ancestor} (required by ${dir})`
    }
  }
  // No directory is listed under a file path.
  for (const dir of directories) {
    for (const fileRel of entryRels) {
      if (dir.startsWith(`${fileRel}/`)) return `directory ${dir} is underneath file ${fileRel}`
    }
  }
  return null
}

/** Verify a snapshot's Markdown document entries each have at least
 * one corresponding physical Markdown entry in the journal — and the
 * physical entry binds the EXACT documentId AND documentPath the
 * snapshot declares. Round-10 F7: a snapshot document claiming a path
 * without any journal entry backing it cannot be verified, AND a
 * physical entry whose identity does not match the snapshot row is a
 * forged journal. The journal must be quarantined. */
export function validateSnapshotPhysicalEntries(
  snapshot: SerializedMetadataSnapshot,
  entries: FolderMoveJournalEntry[],
  destRel: string,
  options: {
    physicalDocumentIds?: readonly string[]
  } = {},
): string | null {
  // Index physical entries by the documentPath they claim. Each md
  // physical entry is keyed by both documentId and documentPath so the
  // snapshot must match BOTH, not just one.
  const byDocId = new Map<string, FolderMoveJournalEntry>()
  const byDocPath = new Map<string, FolderMoveJournalEntry>()
  for (const entry of entries) {
    if (entry.documentId !== undefined && entry.documentPath !== undefined) {
      byDocId.set(entry.documentId, entry)
      byDocPath.set(entry.documentPath, entry)
    }
  }
  const snapshotDocumentsById = new Map(
    snapshot.documents.map((document) => [String(document.id), document]),
  )
  const physicalDocumentIds = options.physicalDocumentIds
    ? new Set(options.physicalDocumentIds)
    : new Set(snapshot.documents.map((document) => String(document.id)))
  for (const documentId of physicalDocumentIds) {
    const doc = snapshotDocumentsById.get(documentId)
    if (!doc) {
      return `physical document id is absent from snapshot: ${documentId}`
    }
    const docPath = doc.path as string
    const docId = doc.id as string
    if (!docPath.startsWith(`${destRel}/`)) return `snapshot document path outside destRel: ${docPath}`
    // For each (id, path) the snapshot declares, BOTH lookups must
    // succeed AND they must resolve to the SAME physical entry —
    // the entry that binds this id to this path.
    const byId = byDocId.get(docId)
    const byPath = byDocPath.get(docPath)
    if (!byId && !byPath) {
      return `snapshot document has no physical entry: ${docPath} (${docId})`
    }
    if (!byId) return `snapshot document id has no physical entry: ${docId}`
    if (!byPath) return `snapshot document path has no physical entry: ${docPath}`
    if (byId !== byPath) return `snapshot document identity/path binding disagrees with journal: ${docPath} (${docId})`
    if (byId.documentId !== docId) return `snapshot document id disagrees with journal: ${docId} vs ${byId.documentId}`
    if (byId.documentPath !== docPath) return `snapshot document path disagrees with journal: ${docPath} vs ${byId.documentPath}`
  }
  for (const entry of entries) {
    if (entry.documentId !== undefined
      && !physicalDocumentIds.has(entry.documentId)) {
      return `journal document id is absent from physicalDocumentIds: ${entry.documentId}`
    }
  }
  return null
}

function stableStrings(values: Iterable<string>): string[] {
  return [...new Set(values)].sort()
}

function stableNumbers(values: Iterable<number>): number[] {
  return [...new Set(values)].sort((left, right) => left - right)
}

function snapshotMigrationPaths(
  snapshot: SerializedMetadataSnapshot,
  key: 'path' | 'original_path',
): string[] {
  return snapshot.migrations.flatMap((row) =>
    typeof row[key] === 'string' && row[key].length > 0
      ? [row[key] as string]
      : [])
}

/** Construct the immutable union that both the Round-17B CAS read and
 * strict restore write must use. The value is persisted in the journal;
 * recovery recomputes it and requires exact stable-array equality. */
export function buildMetadataOwnershipFootprint(
  snapshot: SerializedMetadataSnapshot,
  expectedCurrentSnapshot: SerializedMetadataSnapshot,
  physicalDocumentIds: readonly string[],
): FolderMoveMetadataOwnershipFootprint {
  const snapshots = [snapshot, expectedCurrentSnapshot]
  return {
    paths: stableStrings(snapshots.flatMap(item => item.paths)),
    documentIds: stableStrings([
      ...snapshots.flatMap(item => item.documentIds),
      ...physicalDocumentIds,
    ]),
    tagIds: stableNumbers([
      ...snapshots.flatMap(item => item.tagIds),
      ...snapshots.flatMap(item =>
        item.documentTags.map(row => Number(row.tag_id))),
    ]),
    migrationPaths: stableStrings(
      snapshots.flatMap(item => snapshotMigrationPaths(item, 'path')),
    ),
    migrationOriginalPaths: stableStrings(
      snapshots.flatMap(item => snapshotMigrationPaths(item, 'original_path')),
    ),
  }
}

function stringArraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index])
}

function numberArraysEqual(
  left: readonly number[],
  right: readonly number[],
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index])
}

function validStableStringArray(
  value: unknown,
  options: { allowTombstones?: boolean } = {},
): value is string[] {
  if (!Array.isArray(value)
    || !value.every(item => typeof item === 'string' && item.length > 0)) {
    return false
  }
  const values = value as string[]
  if (!stringArraysEqual(values, stableStrings(values))) return false
  return values.every(item =>
    options.allowTombstones && item.startsWith('@deleted/')
      ? validRelativePath(item.slice('@deleted/'.length))
      : validRelativePath(item))
}

function validStableNumberArray(value: unknown): value is number[] {
  if (!Array.isArray(value)
    || !value.every(item => typeof item === 'number'
      && Number.isSafeInteger(item)
      && item >= 0)) {
    return false
  }
  return numberArraysEqual(value as number[], stableNumbers(value as number[]))
}

function pathWithinPrefix(value: string, prefix: string): boolean {
  return value === prefix || value.startsWith(`${prefix}/`)
}

function validateSnapshotClosure(
  snapshot: SerializedMetadataSnapshot,
  label: string,
): string | null {
  const paths = new Set(snapshot.paths)
  if (paths.size !== snapshot.paths.length
    || snapshot.paths.some(item => !validRelativePath(item))) {
    return `${label}.paths must be unique valid metadata paths`
  }
  const documentIds = new Set(snapshot.documentIds)
  const documentRows = snapshot.documents.map(row => String(row.id))
  if (documentIds.size !== snapshot.documentIds.length
    || !setEquals(documentIds, new Set(documentRows))) {
    return `${label}.documentIds does not equal documents[].id`
  }
  const documentPaths = new Set<string>()
  for (const row of snapshot.documents) {
    const documentPath = row.path
    if (typeof row.id !== 'string' || row.id.length === 0
      || typeof documentPath !== 'string'
      || !paths.has(documentPath)
      || documentPaths.has(documentPath)) {
      return `${label} contains an invalid or duplicate document path`
    }
    documentPaths.add(documentPath)
  }
  const tagIds = new Set(snapshot.tagIds)
  const tagRows = snapshot.tags.map(row => Number(row.id))
  if (tagIds.size !== snapshot.tagIds.length
    || !setEquals(tagIds, new Set(tagRows))) {
    return `${label}.tagIds does not equal tags[].id`
  }
  for (const row of snapshot.documentTags) {
    const documentId = String(row.document_id)
    const tagId = Number(row.tag_id)
    if (!documentIds.has(documentId)) {
      return `${label} document_tag document_id is outside snapshot documentIds: ${documentId}`
    }
    if (!tagIds.has(tagId)) {
      return `${label} document_tag tag_id is outside snapshot tagIds: ${tagId}`
    }
  }
  for (const row of snapshot.embeddings) {
    const documentId = String(row.document_id)
    if (!documentIds.has(documentId)) {
      return `${label} embedding document_id is outside snapshot documentIds: ${documentId}`
    }
  }
  return null
}

function canonicalSerializedRow(row: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(row)
      .sort()
      .map(key => [key, row[key]]),
  )
}

function isRound17BReferenceProof(
  value: unknown,
): value is FolderMoveReferenceJournalProof {
  if (!value || typeof value !== 'object') return false
  const proof = value as Partial<FolderMoveReferenceJournalProof>
  if (typeof proof.relativePath !== 'string'
    || path.basename(proof.relativePath) !== proof.relativePath
    || !isRecoveryMarkerName(proof.relativePath, 'journal')
    || proof.operation !== 'folder-rename-references'
    || !Array.isArray(proof.references)) {
    return false
  }
  const SHA256 = /^[0-9a-f]{64}$/
  const hasBinding = proof.transactionId !== undefined
    || proof.journalHash !== undefined
    || proof.srcRel !== undefined
    || proof.destRel !== undefined
  if (hasBinding
    && (typeof proof.transactionId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(proof.transactionId)
      || typeof proof.journalHash !== 'string'
      || !SHA256.test(proof.journalHash)
      || typeof proof.srcRel !== 'string' || !validRelativePath(proof.srcRel)
      || typeof proof.destRel !== 'string' || !validRelativePath(proof.destRel)
      || proof.srcRel === proof.destRel)) return false
  return proof.references.every(item =>
    item && typeof item === 'object'
    && typeof item.documentId === 'string' && item.documentId.length > 0
    && typeof item.sourcePath === 'string' && validRelativePath(item.sourcePath)
    && typeof item.writePath === 'string' && validRelativePath(item.writePath)
    && typeof item.beforeHash === 'string' && SHA256.test(item.beforeHash)
    && typeof item.afterHash === 'string' && SHA256.test(item.afterHash)
    && (!hasBinding
      || (typeof item.beforePayload === 'string'
        && path.basename(item.beforePayload) === item.beforePayload
        && typeof item.afterPayload === 'string'
        && path.basename(item.afterPayload) === item.afterPayload)))
}

function referenceRowsEqual(
  left: FolderMoveReferenceJournalProof['references'],
  right: FolderMoveReferenceJournalProof['references'],
): boolean {
  const canonical = (
    values: FolderMoveReferenceJournalProof['references'],
  ): string[] => values.map(item => JSON.stringify([
    item.documentId,
    item.sourcePath,
    item.writePath,
    item.beforeHash,
    item.afterHash,
  ])).sort()
  return stringArraysEqual(canonical(left), canonical(right))
}

function referenceProvesDocument(
  references: ReadonlyArray<
    FolderMoveReferenceJournalProof['references'][number]
  >,
  documentId: string,
  documentPath: string,
): boolean {
  return references.some(reference =>
    reference.documentId === documentId
    && (reference.sourcePath === documentPath
      || reference.writePath === documentPath))
}

/** Synchronous Round-17B trust-boundary validation. Execution supplies
 * the separately parsed companion reference journal when any metadata
 * document lies outside both folder endpoints. */
export function validateRound17SnapshotRestoreDisposition(
  journal: FolderMoveJournalV4,
  disposition: FolderMoveSnapshotRestoreDisposition,
  context: {
    referenceJournal?: ParsedFolderRenameReferenceJournal
    ownerJournal?: string
    ownerTransactionId?: string
  } = {},
): string | null {
  if (!hasValidSnapshotRowSchema(disposition.snapshot)
    || !hasValidSnapshotRowSchema(disposition.expectedCurrentSnapshot)
    || !Array.isArray(disposition.physicalDocumentIds)
    || !Array.isArray(disposition.metadataOnlyDocumentProofs)
    || !disposition.ownershipFootprint) {
    return 'round17 snapshot-restore journal lacks durable metadata provenance'
  }
  const restoreClosure = validateSnapshotClosure(disposition.snapshot, 'snapshot')
  if (restoreClosure) return restoreClosure
  const expectedClosure = validateSnapshotClosure(
    disposition.expectedCurrentSnapshot,
    'expectedCurrentSnapshot',
  )
  if (expectedClosure) return expectedClosure
  const referencedRestoreTagIds = new Set(
    disposition.snapshot.documentTags.map(row => Number(row.tag_id)),
  )
  const expectedTagById = new Map(
    disposition.expectedCurrentSnapshot.tags.map(row => [
      Number(row.id),
      row,
    ]),
  )
  for (const tag of disposition.snapshot.tags) {
    const tagId = Number(tag.id)
    if (referencedRestoreTagIds.has(tagId)) continue
    const expectedTag = expectedTagById.get(tagId)
    if (!disposition.snapshot.preexistingTagIds.includes(tagId)
      || !expectedTag
      || canonicalSerializedRow(tag)
        !== canonicalSerializedRow(expectedTag)) {
      return `snapshot unreferenced tag lacks matching expected-current preexisting proof: ${tagId}`
    }
  }
  const physicalDocumentIds = stableStrings(disposition.physicalDocumentIds)
  if (!stringArraysEqual(disposition.physicalDocumentIds, physicalDocumentIds)
    || !disposition.physicalDocumentIds.every(id => id.length > 0)) {
    return 'physicalDocumentIds must be unique and stably sorted'
  }
  const footprint = disposition.ownershipFootprint
  if (!validStableStringArray(footprint.paths)
    || !validStableStringArray(footprint.documentIds)
    || !validStableNumberArray(footprint.tagIds)
    || !validStableStringArray(footprint.migrationPaths, {
      allowTombstones: true,
    })
    || !validStableStringArray(footprint.migrationOriginalPaths)) {
    return 'ownershipFootprint contains invalid or unstable ownership keys'
  }
  const expectedFootprint = buildMetadataOwnershipFootprint(
    disposition.snapshot,
    disposition.expectedCurrentSnapshot,
    disposition.physicalDocumentIds,
  )
  for (const key of ['paths', 'documentIds', 'migrationPaths', 'migrationOriginalPaths'] as const) {
    if (!stringArraysEqual(footprint[key], expectedFootprint[key])) {
      return `ownershipFootprint.${key} does not equal the snapshot union`
    }
  }
  if (!numberArraysEqual(footprint.tagIds, expectedFootprint.tagIds)) {
    return 'ownershipFootprint.tagIds does not equal the snapshot union'
  }

  const proofKeys = new Set<string>()
  for (const proof of disposition.metadataOnlyDocumentProofs) {
    if (!proof || typeof proof !== 'object'
      || typeof proof.documentId !== 'string' || proof.documentId.length === 0
      || typeof proof.path !== 'string' || !validRelativePath(proof.path)
      || (proof.reason !== 'source-prefix'
        && proof.reason !== 'destination-prefix'
        && proof.reason !== 'reference-journal')) {
      return 'metadataOnlyDocumentProofs contains an invalid proof'
    }
    const key = `${proof.documentId}\0${proof.path}`
    if (proofKeys.has(key)) {
      return `snapshot metadata-only document has duplicate provenance: ${proof.path}`
    }
    proofKeys.add(key)
    if (proof.reason === 'source-prefix'
      && !pathWithinPrefix(proof.path, journal.srcRel)) {
      return `metadata-only document proof is outside source prefix: ${proof.path}`
    }
    if (proof.reason === 'destination-prefix'
      && !pathWithinPrefix(proof.path, journal.destRel)) {
      return `metadata-only document proof is outside destination prefix: ${proof.path}`
    }
  }

  const physicalIds = new Set(disposition.physicalDocumentIds)
  const restoreDocuments = new Map(
    disposition.snapshot.documents.map(row => [String(row.id), String(row.path)]),
  )
  for (const [documentId, documentPath] of restoreDocuments) {
    if (physicalIds.has(documentId)) continue
    if (!proofKeys.has(`${documentId}\0${documentPath}`)) {
      return `snapshot metadata-only document lacks durable transaction provenance: ${documentPath}`
    }
  }
  for (const proof of disposition.metadataOnlyDocumentProofs) {
    if (restoreDocuments.get(proof.documentId) !== proof.path
      || physicalIds.has(proof.documentId)) {
      return `metadata-only document proof does not match one restore row: ${proof.path}`
    }
  }
  const physicalError = validateSnapshotPhysicalEntries(
    disposition.snapshot,
    journal.entries as unknown as FolderMoveJournalEntry[],
    journal.destRel,
    { physicalDocumentIds: disposition.physicalDocumentIds },
  )
  if (physicalError) return `snapshot physical entries are invalid: ${physicalError}`
  for (const id of disposition.physicalDocumentIds) {
    if (!footprint.documentIds.includes(id)) {
      return `physical document id is absent from ownership footprint: ${id}`
    }
  }

  if (!disposition.createdMetadataIds
    || !validStableStringArray(disposition.createdMetadataIds.documentIds)
    || !validStableNumberArray(disposition.createdMetadataIds.tagIds)) {
    return 'createdMetadataIds contains invalid or unstable identifiers'
  }
  const expectedCreatedDocumentIds = stableStrings(
    disposition.expectedCurrentSnapshot.documentIds.filter(id =>
      !disposition.snapshot.documentIds.includes(id)),
  )
  const expectedCreatedTagIds = stableNumbers(
    disposition.expectedCurrentSnapshot.tagIds.filter(id =>
      !disposition.snapshot.preexistingTagIds.includes(id)),
  )
  if (!stringArraysEqual(
    disposition.createdMetadataIds.documentIds,
    expectedCreatedDocumentIds,
  )) {
    return 'createdMetadataIds.documentIds does not equal the expected-current delta'
  }
  if (!numberArraysEqual(
    disposition.createdMetadataIds.tagIds,
    expectedCreatedTagIds,
  )) {
    return 'createdMetadataIds.tagIds does not equal the expected-current delta'
  }

  const referenceProofs = disposition.metadataOnlyDocumentProofs
    .filter(proof => proof.reason === 'reference-journal')
  const expectedOnlyReferenceDocuments =
    disposition.expectedCurrentSnapshot.documents
      .filter(row =>
        !restoreDocuments.has(String(row.id))
        && !pathWithinPrefix(String(row.path), journal.srcRel)
        && !pathWithinPrefix(String(row.path), journal.destRel))
      .map(row => ({
        documentId: String(row.id),
        path: String(row.path),
      }))
  if (referenceProofs.length > 0
    || expectedOnlyReferenceDocuments.length > 0) {
    if (!isRound17BReferenceProof(disposition.referenceJournal)) {
      return 'snapshot companion reference journal proof is invalid'
    }
    const companion = context.referenceJournal
    if (!companion) return 'companion reference journal is required'
    if (companion.op !== disposition.referenceJournal.operation
      || companion.srcRel !== journal.destRel
      || companion.destRel !== journal.srcRel
      || !Array.isArray(companion.referenceIdentities)
      || !referenceRowsEqual(
        companion.referenceIdentities,
        disposition.referenceJournal.references,
      )) {
      return 'companion reference journal identity/path/hash proof does not match'
    }
    const hasTransactionBinding =
      disposition.referenceJournal.transactionId !== undefined
      || disposition.referenceJournal.journalHash !== undefined
    if (hasTransactionBinding
      && companion.metadataDisposition?.kind !== 'folder-snapshot-owned') {
      return 'snapshot reference companion is not durably owned'
    }
    if (companion.metadataDisposition?.kind === 'folder-snapshot-owned') {
      if (disposition.referenceJournal.transactionId
          !== companion.transactionId
        || disposition.referenceJournal.journalHash
          !== companion.descriptorHash
        || disposition.referenceJournal.srcRel !== companion.srcRel
        || disposition.referenceJournal.destRel !== companion.destRel
        || companion.metadataDisposition.ownerJournal
          !== context.ownerJournal
        || companion.metadataDisposition.ownerTransactionId
          !== context.ownerTransactionId
        || companion.metadataDisposition.ownerDescriptorHash
          !== companion.descriptorHash) {
        return 'snapshot reference companion transaction binding does not match owner'
      }
      for (const proof of disposition.referenceJournal.references) {
        const operations = companion.references.filter(operation =>
          operation.path === proof.writePath)
        if (operations.length !== 1
          || proof.beforePayload !== operations[0].beforePayload
          || proof.afterPayload !== operations[0].afterPayload) {
          return 'snapshot reference companion payload binding does not match operation'
        }
      }
    }
    for (const proof of referenceProofs) {
      if (!referenceProvesDocument(
        disposition.referenceJournal.references,
        proof.documentId,
        proof.path,
      )) {
        return `reference metadata proof is absent from companion journal: ${proof.path}`
      }
    }
    for (const document of expectedOnlyReferenceDocuments) {
      if (!referenceProvesDocument(
        disposition.referenceJournal.references,
        document.documentId,
        document.path,
      )) {
        return `expected-current metadata document lacks durable transaction provenance: ${document.path}`
      }
    }
  } else if (disposition.referenceJournal !== undefined) {
    return 'snapshot carries an unused companion reference journal proof'
  }

  const durableTagOwnerIds = new Set([
    ...disposition.physicalDocumentIds,
    ...disposition.createdMetadataIds.documentIds,
    ...disposition.metadataOnlyDocumentProofs.map(proof => proof.documentId),
  ])
  const expectedDocumentById = new Map(
    disposition.expectedCurrentSnapshot.documents.map(row => [
      String(row.id),
      String(row.path),
    ]),
  )
  for (const documentId of disposition.createdMetadataIds.documentIds) {
    const documentPath = expectedDocumentById.get(documentId)
    if (documentPath === undefined
      || restoreDocuments.has(documentId)
      || (!pathWithinPrefix(documentPath, journal.srcRel)
        && !pathWithinPrefix(documentPath, journal.destRel)
        && !referenceProvesDocument(
          disposition.referenceJournal?.references ?? [],
          documentId,
          documentPath,
        ))) {
      return `created document lacks durable transaction provenance: ${documentPath ?? documentId}`
    }
  }
  for (const tagId of disposition.createdMetadataIds.tagIds) {
    const provenByDurableDocument =
      disposition.expectedCurrentSnapshot.documentTags.some(row =>
        Number(row.tag_id) === tagId
        && durableTagOwnerIds.has(String(row.document_id)))
    if (!provenByDurableDocument) {
      return `created tag lacks durable transaction provenance: ${tagId}`
    }
  }

  const durableReferencePaths = new Set(
    disposition.referenceJournal?.references.flatMap(item => [
      item.sourcePath,
      item.writePath,
    ]) ?? [],
  )
  const migrationRows = [
    ...disposition.snapshot.migrations,
    ...disposition.expectedCurrentSnapshot.migrations,
  ]
  for (const row of migrationRows) {
    const documentId = typeof row.document_id === 'string'
      ? row.document_id
      : null
    const keys = [row.path, row.original_path]
      .filter((value): value is string =>
        typeof value === 'string' && value.length > 0)
    const ownedByDocument = documentId !== null
      && footprint.documentIds.includes(documentId)
    const ownedByPath = keys.every((key) =>
      key.startsWith('@deleted/')
        ? footprint.documentIds.includes(key.slice('@deleted/'.length))
        : pathWithinPrefix(key, journal.srcRel)
          || pathWithinPrefix(key, journal.destRel)
          || durableReferencePaths.has(key))
    if (!ownedByDocument && !ownedByPath) {
      return `migration ownership lacks durable transaction provenance: ${keys[0] ?? documentId ?? 'unknown'}`
    }
  }
  return null
}

// =================== round-11 v4 phase-machine surface ===================

/** Schema version for the phase-machine folder-move journal. The route
 * persists exactly this number; the Recovery parser accepts 1, 2, 3
 * (legacy) and 4. v1–v3 quarantine when their weak generation proof
 * is insufficient — v4 is the only version that drives the full
 * prepared → gate-created → files-landed → metadata-committed
 * state machine. */
export const FOLDER_MOVE_JOURNAL_VERSION = 4 as const

/** Folder-move transaction phase. The journal is the ONLY source of
 * truth for the current phase; absence-of-marker, presence-of-marker,
 * source-doesn't-exist, etc. are NEVER used to infer phase. */
export type FolderMovePhase =
  | 'prepared'
  | 'gate-created'
  | 'files-landed'
  | 'metadata-committed'

/** Generation proof for a single physical file: (device, inode,
 * content-hash). All three must match before any link(2) /
 * restore-from-staging syscall. */
export type FileGeneration = {
  dev: string
  ino: string
  hash: string
}

/** Generation proof for a directory: (device, inode). The directory
 * must be empty AND carry this proof to be considered a "gate" the
 * route created. */
export type DirectoryGeneration = {
  dev: string
  ino: string
  birthtimeNs: string
}

/** v4 per-file entry. Markdown entries MAY carry (documentId,
 * documentPath) — same as v3 — and v4 adds mandatory (sourceDev,
 * sourceIno, sourceHash) so byte-identical external replacements are
 * still detectable. */
export type FolderMoveJournalEntryV4 = {
  relativeFilePath: string
  sourceDev: string
  sourceIno: string
  sourceHash: string
  documentId?: string
  documentPath?: string
}

export type FolderMoveGateProof = {
  /** Strict basename of the marker stored inside the destination gate. */
  markerName: string
  /** 32 unpredictable random bytes encoded as lowercase hex. */
  secret: string
}

const GATE_MARKER_RE = /^\.nuvyn-folder-gate-[0-9a-f-]{36}$/
const GATE_SECRET_RE = /^[0-9a-f]{64}$/

export function isFolderMoveGateMarkerName(value: unknown): value is string {
  return typeof value === 'string'
    && path.basename(value) === value
    && GATE_MARKER_RE.test(value)
}

export function createFolderMoveGateProof(): FolderMoveGateProof {
  return {
    markerName: `.nuvyn-folder-gate-${randomUUID()}`,
    secret: randomBytes(32).toString('hex'),
  }
}

export function validateFolderMoveGateProof(
  proof: unknown,
): proof is FolderMoveGateProof {
  if (!proof || typeof proof !== 'object') return false
  const item = proof as Partial<FolderMoveGateProof>
  return isFolderMoveGateMarkerName(item.markerName)
    && typeof item.secret === 'string'
    && GATE_SECRET_RE.test(item.secret)
}

/** v4 journal — the durable, single-source-of-truth record of a
 * folder-move transaction. New journals bind the destination gate to
 * an unpredictable durable marker in addition to directory and entry
 * generations. Legacy v4 journals may omit `gateProof`. */
export type FolderMoveJournalV4 = {
  version: typeof FOLDER_MOVE_JOURNAL_VERSION
  op: 'folder-rename' | 'folder-move'
  phase: FolderMovePhase
  srcRel: string
  destRel: string
  strategy: import('./documentFileLifecycle.js').FolderMoveJournalStrategy
  sourceDev: string
  sourceIno: string
  sourceBirthtimeNs?: string
  /**
   * phase=prepared: MUST be undefined.
   * phase=gate-created, files-landed, metadata-committed: REQUIRED
   * — the route persists the destination's (dev, ino) immediately
   * after `mkdir` so recovery can prove ownership without reading
   * any token file inside the destination.
   */
  destDev?: string
  destIno?: string
  destBirthtimeNs?: string
  gateProof?: FolderMoveGateProof
  emptyTree?: true
  entries: FolderMoveJournalEntryV4[]
  directories: string[]
  /**
   * Dev/ino proof captured at journal-write time for every directory
   * in `directories`. Required when the route writes a new journal;
   * legacy on-disk v4 journals without this field are accepted for
   * read-only paths but are classified 'weak' (round-17 P0-3).
   */
  directoryGenerations?: import('./folderMoveDirectoryOwnership.js').FolderMoveDirectoryEntry[]
  /**
   * Replayable moves create new destination directory generations.
   * Persist them while phase=gate-created, before any file landing.
   */
  destinationDirectoryGenerations?: import('./folderMoveDirectoryOwnership.js').FolderMoveDirectoryEntry[]
  metadataDisposition: FolderMoveMetadataDisposition
}

/** Validate the v4 phase shape: prepared MUST NOT carry destination
 * generation; gate-created and onward MUST carry a well-formed
 * destDev/destIno. Returns null on success, a reason string on
 * failure. */
export function validateFolderMovePhaseShape(
  journal: FolderMoveJournalV4,
): string | null {
  const hasDestinationGeneration =
    typeof journal.destDev === 'string'
    && /^\d+$/.test(journal.destDev)
    && typeof journal.destIno === 'string'
    && /^[1-9]\d*$/.test(journal.destIno)
    && typeof journal.destBirthtimeNs === 'string'
    && /^[1-9]\d*$/.test(journal.destBirthtimeNs)

  if (journal.phase === 'prepared') {
    if (journal.destDev !== undefined || journal.destIno !== undefined
      || journal.destBirthtimeNs !== undefined) {
      return 'prepared journal must not carry destination generation'
    }
    return null
  }

  if (!hasDestinationGeneration) {
    return `${journal.phase} journal is missing destination generation`
  }
  return null
}

const SHA256_RE = /^[0-9a-f]{64}$/
const DECIMAL_RE = /^\d+$/
const POSITIVE_DECIMAL_RE = /^[1-9]\d*$/

export function validateSourceDirectoryGeneration(
  journal: FolderMoveJournalV4,
): string | null {
  if (!DECIMAL_RE.test(journal.sourceDev)) {
    return 'sourceDev must be a decimal string'
  }
  if (!POSITIVE_DECIMAL_RE.test(journal.sourceIno)) {
    return 'sourceIno must be a positive decimal string'
  }
  if (typeof journal.sourceBirthtimeNs !== 'string'
    || !POSITIVE_DECIMAL_RE.test(journal.sourceBirthtimeNs)) {
    return 'sourceBirthtimeNs must be a positive decimal string'
  }
  return null
}

function validRelativePath(value: string): boolean {
  if (!value
    || value.startsWith('/')
    || value.endsWith('/')
    || value.includes('\\')
    || value.includes('\0')) {
    return false
  }
  return value
    .split('/')
    .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

/** Validate the per-entry shape of a v4 journal. Mandatory fields:
 *   * relativeFilePath: valid relative path, no duplicates within
 *     the journal
 *   * sourceHash: 64-char lowercase hex
 *   * sourceDev: non-negative decimal string
 *   * sourceIno: positive decimal string
 * Markdown entries MUST carry (documentId, documentPath) where
 * documentPath = srcRel + '/' + rel.slice(0, -'.md'.length).
 * Attachments MUST NOT carry either field.
 * When `skipDocumentPathValidation` is true, the documentPath
 * identity check against srcRel is skipped (used for snapshot-restore
 * journals where srcRel is a staging name, not a real folder path). */
export function validateJournalEntriesV4(
  entries: readonly FolderMoveJournalEntryV4[],
  srcRel: string,
  skipDocumentPathValidation = false,
): string | null {
  if (!Array.isArray(entries)) {
    return 'entries must be an array'
  }

  const paths = new Set<string>()
  const documentIds = new Set<string>()
  const documentPaths = new Set<string>()

  for (const entry of entries) {
    if (!validRelativePath(entry.relativeFilePath)) {
      return `invalid physical entry path: ${entry.relativeFilePath}`
    }
    if (paths.has(entry.relativeFilePath)) {
      return `duplicate physical entry path: ${entry.relativeFilePath}`
    }
    paths.add(entry.relativeFilePath)

    if (!SHA256_RE.test(entry.sourceHash)) {
      return `invalid sourceHash: ${entry.relativeFilePath}`
    }
    if (!DECIMAL_RE.test(entry.sourceDev)) {
      return `invalid sourceDev: ${entry.relativeFilePath}`
    }
    if (!POSITIVE_DECIMAL_RE.test(entry.sourceIno)) {
      return `invalid sourceIno: ${entry.relativeFilePath}`
    }

    const markdown = entry.relativeFilePath.endsWith('.md')
    const hasId = typeof entry.documentId === 'string' && entry.documentId.length > 0
    const hasPath = typeof entry.documentPath === 'string' && entry.documentPath.length > 0

    if (markdown) {
      const metadataAbsentFromRestoreTarget =
        skipDocumentPathValidation && !hasId && !hasPath
      if ((!hasId || !hasPath) && !metadataAbsentFromRestoreTarget) {
        return `markdown entry missing identity: ${entry.relativeFilePath}`
      }
      if (metadataAbsentFromRestoreTarget) continue
      if (!skipDocumentPathValidation) {
        const expectedDocumentPath = `${srcRel}/${entry.relativeFilePath.slice(0, -'.md'.length)}`
        if (entry.documentPath !== expectedDocumentPath) {
          return `markdown entry documentPath mismatch: ${entry.relativeFilePath}; expected ${expectedDocumentPath}, received ${entry.documentPath}`
        }
      }
      if (documentIds.has(entry.documentId as string)) {
        return `duplicate documentId: ${entry.documentId}`
      }
      if (documentPaths.has(entry.documentPath as string)) {
        return `duplicate documentPath: ${entry.documentPath}`
      }
      documentIds.add(entry.documentId as string)
      documentPaths.add(entry.documentPath as string)
    } else if (entry.documentId !== undefined || entry.documentPath !== undefined) {
      return `attachment carrying markdown identity: ${entry.relativeFilePath}`
    }
  }
  return null
}

// ---- round-11 F10 reserved-path exact/prefix split ----

/** Exact reserved segment names. Matched with `===` only. `.gitignore`
 * and `.github` are NOT reserved; `metadata.sqlite.bak` is NOT
 * reserved. */
export const RESERVED_EXACT_SEGMENTS = new Set<string>([
  '.git',
  'node_modules',
  'metadata.sqlite',
])

/** Reserved segment prefixes. Matched with `startsWith`. A segment
 * `.nuvyn-journal-anything` is reserved; `.nuvyn-journal` without a
 * trailing dash is also caught (every reserved prefix has the dash). */
export const RESERVED_PREFIX_SEGMENTS: readonly string[] = [
  '.nuvyn-journal-',
  '.nuvyn-folder-gate-',
  '.nuvyn-rename-',
  '.nuvyn-staged-',
  '.nuvyn-delete-inflight-',
  '.nuvyn-quarantine-reuse-',
  '.nuvyn-delete-manifest-',
]

/** A single path segment is reserved if it equals an exact reserved
 * name OR starts with a reserved prefix. */
export function isReservedPhysicalSegment(segment: string): boolean {
  if (RESERVED_EXACT_SEGMENTS.has(segment)) return true
  return RESERVED_PREFIX_SEGMENTS.some((prefix) => segment.startsWith(prefix))
}

// ---- round-12 v4 provenance validation (trust boundary) ---------------

/** Validate a v4 journal's structural invariants BEFORE any path
 * resolution or filesystem access. Returns null on success, a reason
 * string on failure.
 *
 * Must run BEFORE resolve(contentDir, srcRel/destRel):
 *
 *   * srcRel !== destRel (no-op move);
 *   * srcRel/destRel are valid relative paths with no `.` / `..` segments;
 *   * entries use only valid relative file paths (same constraint).
 *
 * Does NOT validate vault containment (that happens after resolve in
 * recovery), but rejects clearly malformed journals that would allow
 * path traversal attacks if resolved against contentDir. */
export function validateFolderMoveJournalV4Provenance(
  journal: FolderMoveJournalV4,
): string | null {
  // srcRel and destRel must differ — a no-op move is always a bug.
  if (journal.srcRel === journal.destRel) {
    return 'srcRel must not equal destRel'
  }

  // Both must be valid relative paths with no dots.
  for (const key of ['srcRel', 'destRel'] as const) {
    const value = journal[key]
    if (!validRelativePath(value)) {
      return `invalid ${key}: ${value}`
    }
  }

  // Per-entry paths must also be valid relative paths.
  for (const entry of journal.entries) {
    if (!validRelativePath(entry.relativeFilePath)) {
      return `invalid entry path: ${entry.relativeFilePath}`
    }
  }

  // Directory manifest must contain only valid relative paths.
  for (const dir of journal.directories) {
    if (!validRelativePath(dir)) {
      return `invalid directory entry: ${dir}`
    }
  }

  return null
}

import { randomUUID } from 'node:crypto'
import type { Database as DatabaseT } from 'better-sqlite3'
import matter from 'gray-matter'
import {
  normalizeAndDedupeTags,
  TagNormalizationError,
  type NormalizedTag,
} from '../shared/tagNormalization.js'
import {
  classifyDiaryPath,
} from '../shared/diaryProtocol.js'
import { type DiaryMoodId } from '../shared/diaryMood.js'
import { isConfiguredDiaryMoodId } from './diaryMoodIcons.js'
import { normalizeLogicalContentPath } from './paths.js'
import { MetadataVersionError, nextMetadataBatchUpdatedAt, nextMetadataUpdatedAt } from './metadataVersion.js'

export interface DocumentMetadata {
  id: string
  path: string
  title: string
  summary: string
  tags: string[]
  /** Live metadata may preserve a future opaque ID; null means unset. */
  mood: string | null
  createdAt: number
  updatedAt: number
}

export interface SaveDocumentMetadata {
  id?: string
  path: string
  title: string
  summary?: string
  tags?: string[]
  /** Full writers may carry an opaque stored value for fixtures/recovery. */
  mood?: string | null
  createdAt?: number
  updatedAt?: number
}

export type DocumentMetadataChange =
  | { field: 'title'; value: string }
  | { field: 'summary'; value: string }
  | { field: 'tags'; values: string[] }
  | { field: 'mood'; value: DiaryMoodId | null }

export interface PatchDocumentMetadata {
  path: string
  changes: readonly DocumentMetadataChange[]
  expectedUpdatedAt?: number
}

export type DocumentMetadataErrorCode =
  | 'METADATA_NOT_FOUND'
  | 'METADATA_ALREADY_EXISTS'
  | 'METADATA_VERSION_CONFLICT'
  | 'INVALID_METADATA_CHANGE'
  | 'INVALID_MOOD'
  | 'INVALID_TAG'
  | 'TAG_LIMIT_EXCEEDED'
  | 'METADATA_VERSION_OVERFLOW'

export class DocumentMetadataError extends Error {
  readonly code: DocumentMetadataErrorCode

  constructor(code: DocumentMetadataErrorCode, message: string) {
    super(message)
    this.name = 'DocumentMetadataError'
    this.code = code
  }
}

/**
 * Exact rollback image for the SQLite-owned document metadata graph.
 *
 * This intentionally snapshots rows instead of hydrated business objects:
 * rollback must preserve stable document/tag identities and migration
 * tombstones exactly, including the meaningful state "metadata exists while
 * the Markdown file does not".
 */
export type DocumentMetadataDatabaseSnapshot = {
  documents: Record<string, unknown>[]
  tags: Record<string, unknown>[]
  documentTags: Record<string, unknown>[]
  embeddings: Record<string, unknown>[]
  migrations: Record<string, unknown>[]
}

export type DocumentMetadataMutationSnapshot = DocumentMetadataDatabaseSnapshot & {
  paths: string[]
  documentIds: string[]
  tagIds: number[]
  preexistingTagIds: number[]
}

export type DocumentMetadataOwnershipFootprint = {
  paths: string[]
  documentIds: string[]
  tagIds: number[]
  migrationPaths: string[]
  migrationOriginalPaths: string[]
}

export type CreatedDocumentMetadataIds = {
  documentIds: string[]
  tagIds: number[]
}

export function snapshotDocumentMetadataDatabase(db: DatabaseT): DocumentMetadataDatabaseSnapshot {
  return {
    documents: db.prepare('SELECT * FROM documents ORDER BY id').all() as Record<string, unknown>[],
    tags: db.prepare('SELECT * FROM tags ORDER BY id').all() as Record<string, unknown>[],
    documentTags: db.prepare('SELECT * FROM document_tags ORDER BY document_id, tag_id').all() as Record<string, unknown>[],
    embeddings: db.prepare('SELECT * FROM document_embeddings ORDER BY document_id').all() as Record<string, unknown>[],
    migrations: db.prepare('SELECT * FROM metadata_migrations ORDER BY path').all() as Record<string, unknown>[],
  }
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ')
}

/** Capture only the metadata graph owned by the paths in one file mutation. */
export function snapshotDocumentMetadataMutation(
  db: DatabaseT,
  inputPaths: readonly string[],
): DocumentMetadataMutationSnapshot {
  const paths = [...new Set(inputPaths)]
  const preexistingTagIds = (db.prepare('SELECT id FROM tags').all() as Array<{ id: number }>).map((row) => row.id)
  if (!paths.length) return { paths, documentIds: [], tagIds: [], preexistingTagIds, documents: [], tags: [], documentTags: [], embeddings: [], migrations: [] }
  const documents = db.prepare(`SELECT * FROM documents WHERE path IN (${placeholders(paths)}) ORDER BY id`)
    .all(...paths) as Record<string, unknown>[]
  const documentIds = documents.map((row) => String(row.id))
  const documentTags = documentIds.length
    ? db.prepare(`SELECT * FROM document_tags WHERE document_id IN (${placeholders(documentIds)}) ORDER BY document_id, tag_id`).all(...documentIds) as Record<string, unknown>[]
    : []
  const tagIds = [...new Set(documentTags.map((row) => Number(row.tag_id)))]
  const tags = tagIds.length
    ? db.prepare(`SELECT * FROM tags WHERE id IN (${placeholders(tagIds)}) ORDER BY id`).all(...tagIds) as Record<string, unknown>[]
    : []
  const embeddings = documentIds.length
    ? db.prepare(`SELECT * FROM document_embeddings WHERE document_id IN (${placeholders(documentIds)}) ORDER BY document_id`).all(...documentIds) as Record<string, unknown>[]
    : []
  const migrationClauses = paths.map(() => 'path = ?').concat(paths.map(() => 'original_path = ?'), documentIds.map(() => 'path = ?'), documentIds.map(() => 'document_id = ?'))
  const migrationArgs = [...paths, ...paths, ...documentIds.map((id) => `@deleted/${id}`), ...documentIds]
  const migrations = migrationClauses.length
    ? db.prepare(`SELECT * FROM metadata_migrations WHERE ${migrationClauses.join(' OR ')} ORDER BY path`).all(...migrationArgs) as Record<string, unknown>[]
    : []
  return { paths, documentIds, tagIds, preexistingTagIds, documents, tags, documentTags, embeddings, migrations }
}

/** Expand folder prefixes to the exact rows they currently own, including
 * recovery-only migration rows for files that do not exist on disk. */
export function snapshotDocumentMetadataPrefixMutation(
  db: DatabaseT,
  prefixes: readonly string[],
  extraPaths: readonly string[] = [],
): DocumentMetadataMutationSnapshot {
  const normalized = [...new Set(prefixes)]
  const matched = new Set(extraPaths)
  for (const prefix of normalized) {
    const like = `${prefix}/%`
    for (const row of db.prepare('SELECT path FROM documents WHERE path = ? OR path LIKE ?').all(prefix, like) as Array<{ path: string }>) {
      matched.add(row.path)
    }
    for (const row of db.prepare(`SELECT path, original_path FROM metadata_migrations
      WHERE path = ? OR path LIKE ? OR original_path = ? OR original_path LIKE ?`).all(prefix, like, prefix, like) as Array<{ path: string; original_path: string }>) {
      if (!row.path.startsWith('@deleted/')) matched.add(row.path)
      if (row.original_path) matched.add(row.original_path)
    }
  }
  return snapshotDocumentMetadataMutation(db, [...matched])
}

/** round-11 v4 / F1: ownership CAS requires reading live rows by BOTH
 * path AND documentId AND tagId. The previous CAS only read by path,
 * so a snapshot whose `documentId` was already bound to an unrelated
 * path in the live DB would not be detected — a forged journal could
 * rebind that id onto the new folder. This snapshot returns a union
 * of all three reads, with deduplication by primary key. */
export function snapshotDocumentMetadataOwnership(
  db: DatabaseT,
  paths: readonly string[],
  documentIds: readonly string[],
  tagIds: readonly number[],
  explicitFootprint?: DocumentMetadataOwnershipFootprint,
): DocumentMetadataMutationSnapshot {
  const uniquePaths = [...new Set(explicitFootprint?.paths ?? paths)].sort()
  const uniqueDocumentIds = [...new Set(documentIds.filter((id) => typeof id === 'string' && id.length > 0))]
  const uniqueTagIds = [...new Set(tagIds.filter((id) => typeof id === 'number'))]

  const documentClauses: string[] = []
  const documentArgs: unknown[] = []
  if (uniquePaths.length > 0) {
    documentClauses.push(`path IN (${placeholders(uniquePaths)})`)
    documentArgs.push(...uniquePaths)
  }
  if (uniqueDocumentIds.length > 0) {
    documentClauses.push(`id IN (${placeholders(uniqueDocumentIds)})`)
    documentArgs.push(...uniqueDocumentIds)
  }
  const documents = documentClauses.length > 0
    ? db.prepare(`SELECT * FROM documents WHERE ${documentClauses.join(' OR ')} ORDER BY id`).all(...documentArgs) as Record<string, unknown>[]
    : []
  const ownedDocumentIds = [...new Set([
    ...(explicitFootprint?.documentIds ?? uniqueDocumentIds),
    ...documents.map(row => String(row.id)),
  ])].sort()

  const documentTags = ownedDocumentIds.length > 0
    ? db.prepare(`SELECT * FROM document_tags WHERE document_id IN (${placeholders(ownedDocumentIds)}) ORDER BY document_id, tag_id`).all(...ownedDocumentIds) as Record<string, unknown>[]
    : []

  const embeddings = ownedDocumentIds.length > 0
    ? db.prepare(`SELECT * FROM document_embeddings WHERE document_id IN (${placeholders(ownedDocumentIds)}) ORDER BY document_id`).all(...ownedDocumentIds) as Record<string, unknown>[]
    : []

  const ownedTagIds = [...new Set([
    ...(explicitFootprint?.tagIds ?? uniqueTagIds),
    ...documentTags.map(row => Number(row.tag_id)),
  ])].sort((left, right) => left - right)
  const tags = ownedTagIds.length > 0
    ? db.prepare(`SELECT * FROM tags WHERE id IN (${placeholders(ownedTagIds)}) ORDER BY id`).all(...ownedTagIds) as Record<string, unknown>[]
    : []

  const migrationClauses: string[] = []
  const migrationArgs: unknown[] = []
  const migrationPaths = [...new Set(
    explicitFootprint?.migrationPaths ?? uniquePaths,
  )].sort()
  const migrationOriginalPaths = [...new Set(
    explicitFootprint?.migrationOriginalPaths ?? uniquePaths,
  )].sort()
  if (migrationPaths.length > 0) {
    migrationClauses.push(`path IN (${placeholders(migrationPaths)})`)
    migrationArgs.push(...migrationPaths)
  }
  if (migrationOriginalPaths.length > 0) {
    migrationClauses.push(`original_path IN (${placeholders(migrationOriginalPaths)})`)
    migrationArgs.push(...migrationOriginalPaths)
  }
  if (ownedDocumentIds.length > 0) {
    const tombstones = ownedDocumentIds.map((id) => `@deleted/${id}`)
    migrationClauses.push(`path IN (${placeholders(tombstones)})`)
    migrationArgs.push(...tombstones)
    migrationClauses.push(`document_id IN (${placeholders(ownedDocumentIds)})`)
    migrationArgs.push(...ownedDocumentIds)
  }
  const migrations = migrationClauses.length > 0
    ? db.prepare(`SELECT * FROM metadata_migrations WHERE ${migrationClauses.join(' OR ')} ORDER BY path`).all(...migrationArgs) as Record<string, unknown>[]
    : []

  const preexistingTagIds = (db.prepare('SELECT id FROM tags ORDER BY id').all() as Array<{ id: number }>).map((row) => row.id)

  return {
    paths: uniquePaths,
    // Snapshot row identity sets describe rows that actually exist.
    // Requested-but-absent ownership keys live in the separately
    // persisted Round-17B footprint.
    documentIds: documents.map(row => String(row.id)).sort(),
    tagIds: tags.map(row => Number(row.id)).sort((left, right) => left - right),
    preexistingTagIds,
    documents,
    documentTags,
    embeddings,
    tags,
    migrations,
  }
}

export function snapshotDocumentMetadataMutationCurrentOwnership(
  db: DatabaseT,
  target: DocumentMetadataMutationSnapshot,
): DocumentMetadataMutationSnapshot {
  return snapshotDocumentMetadataOwnership(
    db,
    target.paths,
    target.documentIds,
    target.tagIds,
  )
}

function canonicalValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    return { __type: 'bytes', base64: value.toString('base64') }
  }
  if (value instanceof Uint8Array) {
    return {
      __type: 'bytes',
      base64: Buffer.from(value).toString('base64'),
    }
  }
  if (value === undefined) return { __type: 'undefined' }
  if (typeof value === 'bigint') {
    return { __type: 'bigint', decimal: value.toString() }
  }
  if (typeof value === 'number' && Object.is(value, -0)) {
    return { __type: 'number', value: '-0' }
  }
  return value
}

function canonicalRecord(row: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(row)
      .sort()
      .map((key) => [key, canonicalValue(row[key])]),
  )
}

function canonicalRows(rows: readonly Record<string, unknown>[]): string[] {
  return rows.map(canonicalRecord).sort()
}

function rowsExactlyEqual(
  current: readonly Record<string, unknown>[],
  expected: readonly Record<string, unknown>[],
): boolean {
  const currentRows = canonicalRows(current)
  const expectedRows = canonicalRows(expected)
  return currentRows.length === expectedRows.length
    && currentRows.every((row, index) => row === expectedRows[index])
}

function hasAssociationIdentity(row: Record<string, unknown>): boolean {
  return Object.hasOwn(row, 'association_id')
}

function logicalDocumentTagRowsExactlyEqual(
  current: readonly Record<string, unknown>[],
  expected: readonly Record<string, unknown>[],
): boolean {
  // A legacy v6 snapshot has no physical identity. Its CAS comparison is
  // therefore logical, while a v7 snapshot compares the exact physical row.
  if (!expected.some((row) => !hasAssociationIdentity(row))) {
    return rowsExactlyEqual(current, expected)
  }
  const key = (row: Record<string, unknown>) => `${String(row.document_id)}\0${String(row.tag_id)}`
  const currentKeys = current.map(key).sort()
  const expectedKeys = expected.map(key).sort()
  return currentKeys.length === expectedKeys.length
    && currentKeys.every((value, index) => value === expectedKeys[index])
}

/**
 * Normalize a legacy v6 snapshot only at the recovery boundary. An existing
 * live logical row may keep its current v7 association_id; a missing row is
 * left without an ID so SQLite allocates a new one. No historical ID is
 * guessed or manufactured.
 */
function normalizeLegacySnapshotAssociationIds(
  db: DatabaseT,
  snapshot: DocumentMetadataMutationSnapshot,
): DocumentMetadataMutationSnapshot {
  if (!snapshot.documentTags.length || snapshot.documentTags.some(hasAssociationIdentity)) return snapshot
  const documentIds = [...new Set(snapshot.documentTags.map((row) => String(row.document_id)))]
  const currentRows = documentIds.length
    ? db.prepare(`
        SELECT association_id, document_id, tag_id
        FROM document_tags
        WHERE document_id IN (${placeholders(documentIds)})
      `).all(...documentIds) as Array<{ association_id: number; document_id: string; tag_id: number }>
    : []
  const currentByKey = new Map(currentRows.map((row) => [
    `${row.document_id}\0${row.tag_id}`,
    row.association_id,
  ]))
  return {
    ...snapshot,
    documentTags: snapshot.documentTags.map((row) => {
      const associationId = currentByKey.get(`${String(row.document_id)}\0${String(row.tag_id)}`)
      return associationId === undefined ? row : { ...row, association_id: associationId }
    }),
  }
}

export function metadataSnapshotsExactlyEqual(
  current: DocumentMetadataMutationSnapshot,
  expected: DocumentMetadataMutationSnapshot,
): boolean {
  return rowsExactlyEqual(current.documents, expected.documents)
    && rowsExactlyEqual(current.tags, expected.tags)
    && logicalDocumentTagRowsExactlyEqual(current.documentTags, expected.documentTags)
    && rowsExactlyEqual(current.embeddings, expected.embeddings)
    && rowsExactlyEqual(current.migrations, expected.migrations)
}

function liveRowsAreExpectedSubset(
  live: readonly Record<string, unknown>[],
  expected: readonly Record<string, unknown>[],
): boolean {
  const expectedRows = new Set(expected.map(canonicalRecord))
  return live.every((row) => expectedRows.has(canonicalRecord(row)))
}

/** Every live row in the restore footprint must be byte-for-byte the
 * row captured by the snapshot. Missing expected rows are allowed:
 * rollback restores them. Added or column-drifted live rows reject the
 * restore before it can overwrite an external transaction. */
export function validateSnapshotOwnership(
  current: DocumentMetadataMutationSnapshot,
  expected: DocumentMetadataMutationSnapshot,
): boolean {
  return liveRowsAreExpectedSubset(current.documents, expected.documents)
    && liveRowsAreExpectedSubset(current.tags, expected.tags)
    && (expected.documentTags.some((row) => !hasAssociationIdentity(row))
      ? current.documentTags.every((row) => expected.documentTags.some((expectedRow) =>
          row.document_id === expectedRow.document_id
          && row.tag_id === expectedRow.tag_id))
      : liveRowsAreExpectedSubset(current.documentTags, expected.documentTags))
    && liveRowsAreExpectedSubset(current.embeddings, expected.embeddings)
    && liveRowsAreExpectedSubset(current.migrations, expected.migrations)
}

function insertRows(db: DatabaseT, table: string, rows: Record<string, unknown>[]): void {
  if (!rows.length) return
  const columns = Object.keys(rows[0])
  const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((column) => `@${column}`).join(', ')})`
  const insert = db.prepare(sql)
  for (const row of rows) insert.run(row)
}

/** Insert v6/v7 durable rows without turning a mixed normalized snapshot into
 * a full-ID rewrite. A v6 row without association_id deliberately lets
 * SQLite allocate a fresh v7 identity; a proven live v7 row keeps its ID. */
function insertDocumentTagRows(db: DatabaseT, rows: Record<string, unknown>[]): void {
  insertRows(db, 'document_tags', rows.filter(hasAssociationIdentity))
  insertRows(db, 'document_tags', rows.filter((row) => !hasAssociationIdentity(row)))
}

export function restoreDocumentMetadataDatabase(
  db: DatabaseT,
  snapshot: DocumentMetadataDatabaseSnapshot,
): void {
  db.transaction(() => {
    db.exec(`
      DELETE FROM metadata_migrations;
      DELETE FROM document_tags;
      DELETE FROM document_embeddings;
      DELETE FROM documents;
      DELETE FROM tags;
    `)
    insertRows(db, 'documents', snapshot.documents)
    insertRows(db, 'tags', snapshot.tags)
    insertDocumentTagRows(db, snapshot.documentTags)
    insertRows(db, 'document_embeddings', snapshot.embeddings)
    insertRows(db, 'metadata_migrations', snapshot.migrations)
  })()
}

/** Restore one locked mutation footprint without touching unrelated commits. */
export function restoreDocumentMetadataMutation(
  db: DatabaseT,
  snapshot: DocumentMetadataMutationSnapshot,
): void {
  db.transaction(() => {
    const effectiveSnapshot = normalizeLegacySnapshotAssociationIds(db, snapshot)
    const currentDocuments = snapshot.paths.length
      ? db.prepare(`SELECT id FROM documents WHERE path IN (${placeholders(snapshot.paths)})`).all(...snapshot.paths) as Array<{ id: string }>
      : []
    const affectedIds = [...new Set([...snapshot.documentIds, ...currentDocuments.map((row) => row.id)])]
    if (affectedIds.length) {
      db.prepare(`DELETE FROM document_tags WHERE document_id IN (${placeholders(affectedIds)})`).run(...affectedIds)
      db.prepare(`DELETE FROM document_embeddings WHERE document_id IN (${placeholders(affectedIds)})`).run(...affectedIds)
      db.prepare(`DELETE FROM documents WHERE id IN (${placeholders(affectedIds)})`).run(...affectedIds)
    }
    if (snapshot.paths.length || affectedIds.length) {
      const clauses = snapshot.paths.map(() => 'path = ?').concat(snapshot.paths.map(() => 'original_path = ?'), affectedIds.map(() => 'path = ?'), affectedIds.map(() => 'document_id = ?'))
      db.prepare(`DELETE FROM metadata_migrations WHERE ${clauses.join(' OR ')}`)
        .run(...snapshot.paths, ...snapshot.paths, ...affectedIds.map((id) => `@deleted/${id}`), ...affectedIds)
    }
    insertRows(db, 'documents', effectiveSnapshot.documents)
    for (const tag of effectiveSnapshot.tags) {
      const columns = Object.keys(tag)
      db.prepare(`INSERT OR IGNORE INTO tags (${columns.join(', ')}) VALUES (${columns.map((key) => `@${key}`).join(', ')})`).run(tag)
    }
    insertDocumentTagRows(db, effectiveSnapshot.documentTags)
    insertRows(db, 'document_embeddings', effectiveSnapshot.embeddings)
    insertRows(db, 'metadata_migrations', effectiveSnapshot.migrations)

    // Tags created solely by the failed mutation are safe to remove only
    // when no successful document currently references them.
    const createdTagIds = (db.prepare('SELECT id FROM tags').all() as Array<{ id: number }>)
      .map((row) => row.id)
      .filter((id) => !snapshot.preexistingTagIds.includes(id))
    if (createdTagIds.length) {
      db.prepare(`DELETE FROM tags WHERE id IN (${placeholders(createdTagIds)}) AND id NOT IN (SELECT DISTINCT tag_id FROM document_tags)`)
        .run(...createdTagIds)
    }
  })()
}

/** Round-17B restore: the delete/update set is exactly the durable
 * footprint that the CAS read. A live path owner outside that set is
 * contention, never a reason to grow `affectedIds`. */
export function restoreDocumentMetadataMutationWithinFootprint(
  db: DatabaseT,
  snapshot: DocumentMetadataMutationSnapshot,
  ownershipFootprint: DocumentMetadataOwnershipFootprint,
  createdMetadataIds: CreatedDocumentMetadataIds = {
    documentIds: [],
    tagIds: [],
  },
): void {
  db.transaction(() => {
    const effectiveSnapshot = normalizeLegacySnapshotAssociationIds(db, snapshot)
    const footprintDocumentIds = [...new Set(
      ownershipFootprint.documentIds,
    )].sort()
    const footprintPaths = [...new Set(ownershipFootprint.paths)].sort()
    const currentDocuments = footprintPaths.length || footprintDocumentIds.length
      ? db.prepare(`
          SELECT id, path
          FROM documents
          WHERE ${
            [
              footprintPaths.length
                ? `path IN (${placeholders(footprintPaths)})`
                : null,
              footprintDocumentIds.length
                ? `id IN (${placeholders(footprintDocumentIds)})`
                : null,
            ].filter(Boolean).join(' OR ')
          }
          ORDER BY id
        `).all(
          ...footprintPaths,
          ...footprintDocumentIds,
        ) as Array<{ id: string; path: string }>
      : []
    const idSet = new Set(footprintDocumentIds)
    const pathSet = new Set(footprintPaths)
    for (const row of currentDocuments) {
      if (!idSet.has(row.id) || !pathSet.has(row.path)) {
        throw new Error(
          `metadata ownership: live path owner is outside durable footprint: ${row.path} (${row.id})`,
        )
      }
    }
    if (footprintDocumentIds.length) {
      db.prepare(`DELETE FROM document_tags WHERE document_id IN (${placeholders(footprintDocumentIds)})`)
        .run(...footprintDocumentIds)
      db.prepare(`DELETE FROM document_embeddings WHERE document_id IN (${placeholders(footprintDocumentIds)})`)
        .run(...footprintDocumentIds)
      db.prepare(`DELETE FROM documents WHERE id IN (${placeholders(footprintDocumentIds)})`)
        .run(...footprintDocumentIds)
    }
    const migrationClauses: string[] = []
    const migrationArgs: unknown[] = []
    if (ownershipFootprint.migrationPaths.length) {
      migrationClauses.push(`path IN (${placeholders(ownershipFootprint.migrationPaths)})`)
      migrationArgs.push(...ownershipFootprint.migrationPaths)
    }
    if (ownershipFootprint.migrationOriginalPaths.length) {
      migrationClauses.push(`original_path IN (${placeholders(ownershipFootprint.migrationOriginalPaths)})`)
      migrationArgs.push(...ownershipFootprint.migrationOriginalPaths)
    }
    if (footprintDocumentIds.length) {
      migrationClauses.push(`document_id IN (${placeholders(footprintDocumentIds)})`)
      migrationArgs.push(...footprintDocumentIds)
      const tombstones = footprintDocumentIds.map(id => `@deleted/${id}`)
      migrationClauses.push(`path IN (${placeholders(tombstones)})`)
      migrationArgs.push(...tombstones)
    }
    if (migrationClauses.length) {
      db.prepare(`DELETE FROM metadata_migrations WHERE ${migrationClauses.join(' OR ')}`)
        .run(...migrationArgs)
    }

    insertRows(db, 'documents', effectiveSnapshot.documents)
    for (const tag of effectiveSnapshot.tags) {
      const columns = Object.keys(tag)
      db.prepare(`INSERT OR IGNORE INTO tags (${columns.join(', ')}) VALUES (${columns.map(key => `@${key}`).join(', ')})`)
        .run(tag)
    }
    insertDocumentTagRows(db, effectiveSnapshot.documentTags)
    insertRows(db, 'document_embeddings', effectiveSnapshot.embeddings)
    insertRows(db, 'metadata_migrations', effectiveSnapshot.migrations)

    const createdTagIds = [...new Set(createdMetadataIds.tagIds)]
    if (createdTagIds.length) {
      db.prepare(`
        DELETE FROM tags
        WHERE id IN (${placeholders(createdTagIds)})
          AND id NOT IN (SELECT DISTINCT tag_id FROM document_tags)
      `).run(...createdTagIds)
    }
  })()
}

/** Round-10 F8: a restore whose ownership validation and the actual
 * restore happen in the SAME SQLite IMMEDIATE transaction. The
 * `expect` callback runs INSIDE the transaction with a fresh snapshot
 * of the live rows the restore is about to overwrite; if it returns
 * false (or throws) the entire transaction is rolled back and the
 * metadata stays unchanged. Concurrent writers cannot race the
 * restore: better-sqlite3 IMMEDIATE acquires a RESERVED lock before
 * any reads, so the rows the validator observes are exactly the rows
 * the restore writes against. The callback must be synchronous. */
export function restoreDocumentMetadataMutationCAS(
  db: DatabaseT,
  snapshot: DocumentMetadataMutationSnapshot,
  expect?: (current: DocumentMetadataMutationSnapshot) => boolean,
  options?: {
    ownershipFootprint: DocumentMetadataOwnershipFootprint
    createdMetadataIds?: CreatedDocumentMetadataIds
  },
): void {
  const tx = db.transaction(() => {
    if (expect) {
      // round-11 v4: read by BOTH path AND documentId AND tagId so
      // a forged journal that reuses a live id on an unrelated path
      // is detected.
      const current = snapshotDocumentMetadataOwnership(
        db,
        options?.ownershipFootprint.paths ?? snapshot.paths,
        options?.ownershipFootprint.documentIds ?? snapshot.documentIds,
        options?.ownershipFootprint.tagIds ?? snapshot.tagIds,
        options?.ownershipFootprint,
      )
      let ok = false
      try {
        ok = expect(current)
      } catch (error) {
        // bubble to roll back the transaction
        throw error
      }
      if (!ok) throw new Error('metadata ownership: live rows do not match the restore-time expectation')
    }
    if (options) {
      restoreDocumentMetadataMutationWithinFootprint(
        db,
        snapshot,
        options.ownershipFootprint,
        options.createdMetadataIds,
      )
    } else {
      restoreDocumentMetadataMutation(db, snapshot)
    }
  })
  // better-sqlite3's .immediate variant opens the transaction with
  // BEGIN IMMEDIATE — a write lock acquired up front, so the snapshot
  // the validator reads cannot change between the validation and the
  // restore.
  tx.immediate()
}

export type MetadataRestoreCASResult =
  | { kind: 'restored-now' }
  | { kind: 'already-restored' }
  | { kind: 'conflict'; reason: string }

/**
 * A crash-idempotent three-state restore transition.  Both comparisons and
 * the optional mutation run under the same BEGIN IMMEDIATE transaction.
 */
export function restoreDocumentMetadataMutationCASIdempotent(
  db: DatabaseT,
  restoreSnapshot: DocumentMetadataMutationSnapshot,
  expectedCurrentSnapshot: DocumentMetadataMutationSnapshot,
  options?: {
    ownershipFootprint: DocumentMetadataOwnershipFootprint
    createdMetadataIds?: CreatedDocumentMetadataIds
  },
): MetadataRestoreCASResult {
  const tx = db.transaction((): MetadataRestoreCASResult => {
    const readCurrent = (): DocumentMetadataMutationSnapshot =>
      snapshotDocumentMetadataOwnership(
        db,
        options?.ownershipFootprint.paths ?? restoreSnapshot.paths,
        options?.ownershipFootprint.documentIds ?? restoreSnapshot.documentIds,
        options?.ownershipFootprint.tagIds ?? restoreSnapshot.tagIds,
        options?.ownershipFootprint,
      )
    const current = readCurrent()
    const effectiveRestoreSnapshot = normalizeLegacySnapshotAssociationIds(db, restoreSnapshot)
    const effectiveExpectedSnapshot = normalizeLegacySnapshotAssociationIds(db, expectedCurrentSnapshot)
    if (metadataSnapshotsExactlyEqual(current, effectiveRestoreSnapshot)) {
      return { kind: 'already-restored' }
    }
    if (!metadataSnapshotsExactlyEqual(current, effectiveExpectedSnapshot)) {
      return {
        kind: 'conflict',
        reason: 'live metadata graph matches neither expected-current nor restore snapshot',
      }
    }
    if (options) {
      restoreDocumentMetadataMutationWithinFootprint(
        db,
        effectiveRestoreSnapshot,
        options.ownershipFootprint,
        options.createdMetadataIds,
      )
    } else {
      restoreDocumentMetadataMutation(db, effectiveRestoreSnapshot)
    }
    if (!metadataSnapshotsExactlyEqual(readCurrent(), effectiveRestoreSnapshot)) {
      throw new Error('metadata restore transaction did not produce the durable restore snapshot')
    }
    return { kind: 'restored-now' }
  })
  return tx.immediate()
}

function dateMs(value: unknown, fallback: number): number {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime()
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

type DocumentRow = {
  id: string
  path: string
  title: string
  summary: string
  mood: string | null
  created_at: number
  updated_at: number
}

function normalizeTags(values: readonly unknown[]): NormalizedTag[] {
  try {
    return normalizeAndDedupeTags(values)
  } catch (error) {
    if (error instanceof TagNormalizationError) {
      const code: DocumentMetadataErrorCode = error.code === 'TAG_LIMIT_EXCEEDED'
        ? 'TAG_LIMIT_EXCEEDED'
        : 'INVALID_TAG'
      throw new DocumentMetadataError(code, error.message)
    }
    throw error
  }
}

function assertMetadataPathTitle(path: string, title: string): void {
  if (!path) throw new DocumentMetadataError('INVALID_METADATA_CHANGE', 'metadata path is required')
  if (!title) throw new DocumentMetadataError('INVALID_METADATA_CHANGE', 'metadata title is required')
}

function safeTimestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DocumentMetadataError('INVALID_METADATA_CHANGE', `${label} must be a non-negative safe integer`)
  }
  return value
}

const MAX_STORED_MOOD_LENGTH = 128

/**
 * Validate a value already crossing a generic metadata/recovery boundary.
 * Unlike an explicit user Mood write, this deliberately does not consult the
 * current registry: a future Mood ID must survive an older server intact.
 */
function normalizeStoredMood(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_STORED_MOOD_LENGTH) {
    throw new DocumentMetadataError('INVALID_MOOD', 'stored mood must be null or a non-empty string of at most 128 characters')
  }
  return value
}

function assertConfiguredMood(db: DatabaseT, value: unknown): asserts value is DiaryMoodId | null {
  if (value !== null && !isConfiguredDiaryMoodId(db, value)) {
    throw new DocumentMetadataError('INVALID_MOOD', 'mood must be one of the configured mood icons or null')
  }
}

function isMoodMutationPath(path: string): boolean {
  const logicalPath = normalizeLogicalContentPath(path)
  return logicalPath !== null && classifyDiaryPath(logicalPath) === 'managed'
}

function insertOrGetTags(db: DatabaseT, tags: readonly NormalizedTag[]): void {
  const insert = db.prepare(`
    INSERT INTO tags (name, normalized_name) VALUES (?, ?)
    ON CONFLICT(normalized_name) DO NOTHING
  `)
  const select = db.prepare('SELECT id FROM tags WHERE normalized_name = ?')
  for (const tag of tags) {
    insert.run(tag.displayName, tag.normalizedName)
    if (!select.get(tag.normalizedName)) {
      throw new DocumentMetadataError('INVALID_TAG', 'tag identity row was not created')
    }
  }
}

function replaceDocumentTags(db: DatabaseT, documentId: string, tags: readonly NormalizedTag[]): void {
  db.prepare('DELETE FROM document_tags WHERE document_id = ?').run(documentId)
  const insertAssociation = db.prepare(`
    INSERT INTO document_tags (document_id, tag_id)
    SELECT ?, id FROM tags WHERE normalized_name = ?
  `)
  for (const tag of tags) insertAssociation.run(documentId, tag.normalizedName)
}

export type DocumentTagSetDiff = {
  unchangedAssociationIds: number[]
  addedAssociationIds: number[]
  removedAssociationIds: number[]
}

/**
 * Ordinary existing-document tag writes preserve the physical identity of
 * every logical association that remains requested.  This is deliberately a
 * separate primitive from replaceDocumentTags(), which remains a full
 * snapshot/fixture/recovery writer.
 */
export function applyDocumentTagsSetDiff(
  db: DatabaseT,
  documentId: string,
  tags: readonly NormalizedTag[],
): DocumentTagSetDiff {
  insertOrGetTags(db, tags)
  const current = db.prepare(`
    SELECT dt.association_id AS associationId,
           dt.tag_id AS tagId,
           t.normalized_name AS normalizedName
    FROM document_tags dt
    JOIN tags t ON t.id = dt.tag_id
    WHERE dt.document_id = ?
    ORDER BY dt.association_id
  `).all(documentId) as Array<{
    associationId: number
    tagId: number
    normalizedName: string
  }>
  const requestedIds = new Map<string, number>()
  const selectTagId = db.prepare('SELECT id FROM tags WHERE normalized_name = ?')
  for (const tag of tags) {
    const row = selectTagId.get(tag.normalizedName) as { id: number } | undefined
    if (!row) throw new DocumentMetadataError('INVALID_TAG', 'tag identity row was not created')
    requestedIds.set(tag.normalizedName, row.id)
  }

  const currentByIdentity = new Map(current.map((row) => [row.normalizedName, row]))
  const unchangedAssociationIds: number[] = []
  const removedAssociationIds: number[] = []
  for (const row of current) {
    if (requestedIds.has(row.normalizedName)) unchangedAssociationIds.push(row.associationId)
    else {
      db.prepare('DELETE FROM document_tags WHERE association_id = ?').run(row.associationId)
      removedAssociationIds.push(row.associationId)
    }
  }

  const addedAssociationIds: number[] = []
  const insert = db.prepare('INSERT INTO document_tags (document_id, tag_id) VALUES (?, ?)')
  for (const [normalizedName, tagId] of requestedIds) {
    if (currentByIdentity.has(normalizedName)) continue
    const result = insert.run(documentId, tagId)
    addedAssociationIds.push(Number(result.lastInsertRowid))
  }

  return {
    unchangedAssociationIds,
    addedAssociationIds,
    removedAssociationIds,
  }
}

function currentTagIdentities(db: DatabaseT, documentId: string): string[] {
  return (db.prepare(`
    SELECT t.normalized_name AS normalizedName
    FROM tags t JOIN document_tags dt ON dt.tag_id = t.id
    WHERE dt.document_id = ? ORDER BY t.normalized_name
  `).all(documentId) as Array<{ normalizedName: string }>).map((row) => row.normalizedName)
}

function sameIdentitySet(left: readonly string[], right: readonly string[]): boolean {
  const a = [...new Set(left)].sort()
  const b = [...new Set(right)].sort()
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function hydrate(db: DatabaseT, row: DocumentRow): DocumentMetadata {
  const tags = db.prepare(`
    SELECT t.name FROM tags t
    JOIN document_tags dt ON dt.tag_id = t.id
    WHERE dt.document_id = ? ORDER BY t.normalized_name
  `).all(row.id) as Array<{ name: string }>
  return {
    id: row.id,
    path: row.path,
    title: row.title,
    summary: row.summary,
    tags: tags.map((item) => item.name),
    mood: row.mood ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function getDocumentMetadata(db: DatabaseT, path: string): DocumentMetadata | null {
  const row = db.prepare(
    'SELECT id, path, title, summary, mood, created_at, updated_at FROM documents WHERE path = ?',
  ).get(path) as DocumentRow | undefined
  return row ? hydrate(db, row) : null
}

/** Look a document up by its STABLE identity instead of its path —
 *  the path is a moving attribute (another window may rename at any
 *  time) while the id survives every rename. Draft recovery uses this
 *  to re-validate a document's CURRENT server path when its draft
 *  family has emptied out of IndexedDB: only a by-identity server
 *  query is authoritative there, never a cached tree / tab / posts
 *  path. `updatedAt` doubles as the version token a caller can carry
 *  alongside the path. */
export function getDocumentMetadataById(db: DatabaseT, id: string): DocumentMetadata | null {
  const row = db.prepare(
    'SELECT id, path, title, summary, mood, created_at, updated_at FROM documents WHERE id = ?',
  ).get(id) as DocumentRow | undefined
  return row ? hydrate(db, row) : null
}

/**
 * Return the stable identity encoded by the delete quarantine for `path`.
 * A tombstone is only an identity proof when it was produced by the existing
 * document lifecycle (`@deleted/<document-id>` plus the original path); an
 * arbitrary path match is deliberately not sufficient for historical
 * rehydration.
 */
export function getDocumentTombstoneIdentity(
  db: DatabaseT,
  path: string,
): string | null {
  const hasIdentityTombstones = db.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'history_metadata_document_tombstones'
  `).get()
  if (hasIdentityTombstones) {
    const row = db.prepare(`
      SELECT document_id
      FROM history_metadata_document_tombstones
      WHERE original_path = ?
      ORDER BY deleted_at DESC, document_id DESC
      LIMIT 1
    `).get(path) as { document_id: string } | undefined
    if (row?.document_id) return row.document_id
  }
  const rows = db.prepare(`
    SELECT path
    FROM metadata_migrations
    WHERE original_path = ? AND path LIKE '@deleted/%'
    ORDER BY updated_at DESC, path DESC
  `).all(path) as Array<{ path: string }>
  for (const row of rows) {
    const identity = row.path.slice('@deleted/'.length)
    if (identity.length > 0) return identity
  }
  return null
}

export function listDocumentMetadata(db: DatabaseT): DocumentMetadata[] {
  const rows = db.prepare(
    'SELECT id, path, title, summary, mood, created_at, updated_at FROM documents ORDER BY path',
  ).all() as DocumentRow[]
  return rows.map((row) => hydrate(db, row))
}

/** Create/import a metadata row inside an already-open SQLite transaction. */
export function createDocumentMetadataWithinTransaction(
  db: DatabaseT,
  input: SaveDocumentMetadata,
  now = Date.now(),
): DocumentMetadata {
  const path = input.path.trim()
  const title = input.title.trim()
  assertMetadataPathTitle(path, title)

  if (db.prepare('SELECT 1 FROM documents WHERE path = ?').get(path)) {
    throw new DocumentMetadataError('METADATA_ALREADY_EXISTS', `metadata already exists: ${path}`)
  }
  const id = input.id ?? randomUUID()
  const createdAt = safeTimestamp(Math.trunc(input.createdAt ?? now), 'metadata createdAt')
  const updatedAt = safeTimestamp(Math.trunc(input.updatedAt ?? now), 'metadata updatedAt')
  const tags = normalizeTags(input.tags ?? [])
  const mood = normalizeStoredMood(input.mood)
  db.prepare(`
    INSERT INTO documents (id, path, title, summary, mood, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, path, title, input.summary?.trim() ?? '', mood, createdAt, updatedAt)
  insertOrGetTags(db, tags)
  replaceDocumentTags(db, id, tags)

  return getDocumentMetadata(db, path)!
}

/** Create/import a metadata row. Existing-row ordinary updates use patchDocumentMetadata. */
export function createDocumentMetadata(db: DatabaseT, input: SaveDocumentMetadata): DocumentMetadata {
  const tx = db.transaction(() => createDocumentMetadataWithinTransaction(db, input))
  return tx.immediate()
}

/**
 * Compatibility full writer for recovery/fixtures. Ordinary production
 * callers must use createDocumentMetadata or patchDocumentMetadata.
 */
export function saveDocumentMetadata(db: DatabaseT, input: SaveDocumentMetadata): DocumentMetadata {
  const path = input.path.trim()
  const title = input.title.trim()
  assertMetadataPathTitle(path, title)
  const tx = db.transaction(() => {
    const existing = getDocumentMetadata(db, path)
    const now = Date.now()
    const id = existing?.id ?? input.id ?? randomUUID()
    const createdAt = safeTimestamp(Math.trunc(input.createdAt ?? existing?.createdAt ?? now), 'metadata createdAt')
    const updatedAt = safeTimestamp(Math.trunc(input.updatedAt ?? now), 'metadata updatedAt')
    const tags = normalizeTags(input.tags ?? existing?.tags ?? [])
    const mood = normalizeStoredMood(input.mood === undefined ? existing?.mood : input.mood)
    db.prepare(`
      INSERT INTO documents (id, path, title, summary, mood, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        title = excluded.title,
        summary = excluded.summary,
        mood = excluded.mood,
        updated_at = excluded.updated_at
    `).run(id, path, title, input.summary?.trim() ?? existing?.summary ?? '', mood, createdAt, updatedAt)
    insertOrGetTags(db, tags)
    replaceDocumentTags(db, id, tags)
    return getDocumentMetadata(db, path)!
  })
  return tx.immediate()
}

function assertPatchChanges(changes: readonly DocumentMetadataChange[]): void {
  if (!Array.isArray(changes) || changes.length === 0) {
    throw new DocumentMetadataError('INVALID_METADATA_CHANGE', 'at least one metadata field change is required')
  }
  const seen = new Set<string>()
  for (const change of changes) {
    if (!change || typeof change !== 'object' || !('field' in change)) {
      throw new DocumentMetadataError('INVALID_METADATA_CHANGE', 'invalid metadata field change')
    }
    if (change.field !== 'title' && change.field !== 'summary' && change.field !== 'tags' && change.field !== 'mood') {
      throw new DocumentMetadataError('INVALID_METADATA_CHANGE', 'unknown metadata field')
    }
    if (seen.has(change.field)) {
      throw new DocumentMetadataError('INVALID_METADATA_CHANGE', `duplicate metadata field: ${change.field}`)
    }
    seen.add(change.field)
  }
}

export function patchDocumentMetadataWithinTransaction(
  db: DatabaseT,
  input: PatchDocumentMetadata,
  now = Date.now(),
): DocumentMetadata {
  const path = input.path.trim()
  if (!path) throw new DocumentMetadataError('INVALID_METADATA_CHANGE', 'metadata path is required')
  assertPatchChanges(input.changes)
  const tagChange = input.changes.find((change): change is Extract<DocumentMetadataChange, { field: 'tags' }> => change.field === 'tags')
  const moodChange = input.changes.find((change): change is Extract<DocumentMetadataChange, { field: 'mood' }> => change.field === 'mood')
  let normalizedTags: NormalizedTag[] | null = null
  if (tagChange) normalizedTags = normalizeTags(tagChange.values)
  if (moodChange) {
    if (!isMoodMutationPath(path)) {
      throw new DocumentMetadataError('INVALID_MOOD', 'mood is only available for canonical managed Diary dates')
    }
    assertConfiguredMood(db, moodChange.value)
  }
  if ((tagChange || moodChange) && (!Number.isSafeInteger(input.expectedUpdatedAt) || input.expectedUpdatedAt! < 0)) {
    throw new DocumentMetadataError('INVALID_METADATA_CHANGE', 'expectedUpdatedAt is required for explicit tags or mood changes')
  }

  const current = getDocumentMetadata(db, path)
  if (!current) throw new DocumentMetadataError('METADATA_NOT_FOUND', `metadata does not exist: ${path}`)
  if ((tagChange || moodChange) && input.expectedUpdatedAt !== current.updatedAt) {
    throw new DocumentMetadataError('METADATA_VERSION_CONFLICT', 'metadata version is stale')
  }

  let nextTitle = current.title
  let nextSummary = current.summary
  let nextMood = current.mood
  for (const change of input.changes) {
    if (change.field === 'title') {
      if (typeof change.value !== 'string' || !change.value.trim() || change.value.length > 200) {
        throw new DocumentMetadataError('INVALID_METADATA_CHANGE', 'title must be a non-empty string of at most 200 characters')
      }
      nextTitle = change.value.trim()
    } else if (change.field === 'summary') {
      if (typeof change.value !== 'string' || change.value.length > 2000) {
        throw new DocumentMetadataError('INVALID_METADATA_CHANGE', 'summary must be a string of at most 2000 characters')
      }
      nextSummary = change.value.trim()
    } else if (change.field === 'mood') {
      // The canonical value was validated before reading the live row. Keep
      // null as the explicit clear operation and never normalize IDs here.
      nextMood = change.value
    } else {
      // The normalized tag set is kept separately so an explicit request
      // can be compared by identity before associations are rewritten.
    }
  }

  const titleChanged = nextTitle !== current.title
  const summaryChanged = nextSummary !== current.summary
  const tagsChanged = normalizedTags !== null
    && !sameIdentitySet(currentTagIdentities(db, current.id), normalizedTags.map((tag) => tag.normalizedName))
  const moodChanged = moodChange !== undefined && nextMood !== current.mood
  if (!titleChanged && !summaryChanged && !tagsChanged && !moodChanged) return current

  let updatedAt: number
  try {
    updatedAt = nextMetadataUpdatedAt(current.updatedAt, now)
  } catch (error) {
    if (error instanceof MetadataVersionError) {
      throw new DocumentMetadataError('METADATA_VERSION_OVERFLOW', error.message)
    }
    throw error
  }
  db.prepare(`
    UPDATE documents SET title = ?, summary = ?, mood = ?, updated_at = ? WHERE id = ?
  `).run(nextTitle, nextSummary, nextMood, updatedAt, current.id)
  if (tagsChanged && normalizedTags) {
    applyDocumentTagsSetDiff(db, current.id, normalizedTags)
  }
  return getDocumentMetadata(db, path)!
}

export function patchDocumentMetadata(db: DatabaseT, input: PatchDocumentMetadata): DocumentMetadata {
  const tx = db.transaction(() => patchDocumentMetadataWithinTransaction(db, input))
  return tx.immediate()
}

export type RestoreDocumentMetadataFieldsCASInput = {
  path: string
  documentId: string
  generationId: string
  expectedUpdatedAt: number
  title: string
  summary: string
  tags: string[]
  /** Opaque historical value; omitted by v1 restores to preserve live mood. */
  mood?: string | null
}

/**
 * Apply a trusted historical generic metadata image to the current live
 * metadata owner. This is intentionally a semantic field restore rather than
 * a row/snapshot replacement: `updatedAt` is a fresh current version and the
 * stable document identity/path are checked under the same BEGIN IMMEDIATE
 * transaction as the field update.
 */
export function restoreDocumentMetadataFieldsCASWithinTransaction(
  db: DatabaseT,
  input: RestoreDocumentMetadataFieldsCASInput,
  now = Date.now(),
): DocumentMetadata {
  const path = input.path.trim()
  const current = getDocumentMetadata(db, path)
  if (!current
    || current.id !== input.documentId
    || input.generationId !== input.documentId
    || current.updatedAt !== input.expectedUpdatedAt) {
    throw new DocumentMetadataError(
      'METADATA_VERSION_CONFLICT',
      `metadata identity or version is stale: ${path}`,
    )
  }
  // Historical restore is a real current-version event even when the
  // restored field values happen to equal the current live values. Keep
  // ordinary PATCH no-op semantics unchanged; this dedicated seam must
  // still mint a fresh CAS version because the body revision changed.
  const title = input.title.trim()
  const summary = input.summary.trim()
  if (!title || title.length > 200) {
    throw new DocumentMetadataError('INVALID_METADATA_CHANGE', 'title must be a non-empty string of at most 200 characters')
  }
  if (summary.length > 2000) {
    throw new DocumentMetadataError('INVALID_METADATA_CHANGE', 'summary must be a string of at most 2000 characters')
  }
  const tags = normalizeTags(input.tags)
  const mood = normalizeStoredMood(input.mood === undefined ? current.mood : input.mood)
  const tagsChanged = !sameIdentitySet(
    currentTagIdentities(db, current.id),
    tags.map((tag) => tag.normalizedName),
  )
  let updatedAt: number
  try {
    updatedAt = nextMetadataUpdatedAt(current.updatedAt, now)
  } catch (error) {
    if (error instanceof MetadataVersionError) {
      throw new DocumentMetadataError('METADATA_VERSION_OVERFLOW', error.message)
    }
    throw error
  }
  db.prepare(`
    UPDATE documents SET title = ?, summary = ?, mood = ?, updated_at = ? WHERE id = ?
  `).run(title, summary, mood, updatedAt, current.id)
  if (tagsChanged) applyDocumentTagsSetDiff(db, current.id, tags)
  return getDocumentMetadata(db, path)!
}

export function restoreDocumentMetadataFieldsCAS(
  db: DatabaseT,
  input: RestoreDocumentMetadataFieldsCASInput,
  now = Date.now(),
): DocumentMetadata {
  const tx = db.transaction(() => restoreDocumentMetadataFieldsCASWithinTransaction(db, input, now))
  return tx.immediate()
}

/** Read/import an absent row without rebuilding an existing row's associations. */
export function observeDocumentMetadata(
  db: DatabaseT,
  path: string,
  raw: string,
  mtimeMs: number,
): DocumentMetadata {
  const existing = getDocumentMetadata(db, path)
  if (existing) return existing
  const parsed = matter(raw)
  const fallbackTitle = path.split('/').pop()!
  const heading = /^#\s+(.+)$/m.exec(parsed.content)?.[1]?.trim()
  const title = typeof parsed.data.title === 'string' && parsed.data.title.trim()
    ? parsed.data.title.trim()
    : heading || fallbackTitle
  const tags = Array.isArray(parsed.data.tags) ? parsed.data.tags : []
  const legacyUpdatedAt = dateMs(parsed.data.updated, mtimeMs)
  return createDocumentMetadata(db, {
    path,
    title,
    summary: typeof parsed.data.summary === 'string' ? parsed.data.summary : '',
    tags: tags as string[],
    createdAt: dateMs(parsed.data.created ?? parsed.data.date, mtimeMs),
    updatedAt: Math.max(legacyUpdatedAt, mtimeMs),
  })
}

/** Advance the version for a known committed body/path/lifecycle mutation. */
export function touchDocumentMetadata(db: DatabaseT, path: string, now = Date.now()): DocumentMetadata {
  const tx = db.transaction(() => {
    const current = getDocumentMetadata(db, path)
    if (!current) throw new DocumentMetadataError('METADATA_NOT_FOUND', `metadata does not exist: ${path}`)
    let updatedAt: number
    try { updatedAt = nextMetadataUpdatedAt(current.updatedAt, now) }
    catch (error) {
      if (error instanceof MetadataVersionError) throw new DocumentMetadataError('METADATA_VERSION_OVERFLOW', error.message)
      throw error
    }
    db.prepare('UPDATE documents SET updated_at = ? WHERE id = ?').run(updatedAt, current.id)
    return getDocumentMetadata(db, path)!
  })
  return tx.immediate()
}

/**
 * Record a mutation that has already committed in the file/lifecycle layer.
 * Existing database-owned metadata is only versioned here; it is never
 * reconstructed from the file's stale Frontmatter tags.
 */
export function recordCommittedDocumentMutation(
  db: DatabaseT,
  path: string,
  raw: string,
  mtimeMs: number,
  now = Date.now(),
): DocumentMetadata {
  return getDocumentMetadata(db, path)
    ? touchDocumentMetadata(db, path, now)
    : observeDocumentMetadata(db, path, raw, mtimeMs)
}

/** Import legacy Frontmatter once, then keep database-owned fields unchanged on body writes. */
export function ensureDocumentMetadata(
  db: DatabaseT,
  path: string,
  raw: string,
  mtimeMs: number,
  updatedAt = mtimeMs,
): DocumentMetadata {
  // `updatedAt` remains accepted for compatibility with existing callers,
  // but observing an existing row never treats a file timestamp as a
  // committed metadata mutation.
  void updatedAt
  return observeDocumentMetadata(db, path, raw, mtimeMs)
}

export function moveDocumentMetadata(db: DatabaseT, fromPath: string, toPath: string): boolean {
  return db.transaction(() => {
    const source = db.prepare('SELECT id, updated_at FROM documents WHERE path = ?').get(fromPath) as { id: string; updated_at: number } | undefined
    if (!source) return false
    const timestamp = nextMetadataUpdatedAt(source.updated_at, Date.now())
    const result = db.prepare(
      'UPDATE documents SET path = ?, updated_at = ? WHERE path = ?',
    ).run(toPath, timestamp, fromPath)
    db.prepare(`
      UPDATE metadata_migrations SET path = ?, document_id = ?, updated_at = ?
      WHERE document_id = ? OR (document_id IS NULL AND path = ?)
    `).run(toPath, source.id, timestamp, source.id, fromPath)
    return result.changes > 0
  })()
}

function quarantineMigrationAtPath(
  db: DatabaseT,
  path: string,
  documentId?: string,
  timestamp = Date.now(),
): void {
  const row = db.prepare('SELECT path FROM metadata_migrations WHERE path = ?').get(path)
  if (!row) return
  const tombstone = `@deleted/${documentId ?? randomUUID()}`
  db.prepare(`
    UPDATE metadata_migrations
    SET path = ?, original_path = CASE WHEN original_path = '' THEN path ELSE original_path END,
        document_id = NULL, status = 'orphaned', updated_at = ?
    WHERE path = ?
  `).run(tombstone, timestamp, path)
}

/**
 * Preserve the stable identity of a deleted live document for the history
 * metadata bridge. This is provenance only; the documents/tags tables remain
 * the sole live metadata owner. The table is introduced by the history
 * metadata migration, so older test databases can continue using the legacy
 * migration quarantine fallback below.
 */
function recordHistoryMetadataTombstone(
  db: DatabaseT,
  documentId: string,
  originalPath: string,
  deletedAt = Date.now(),
): void {
  const table = db.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'history_metadata_document_tombstones'
  `).get()
  if (!table) return
  db.prepare(`
    INSERT INTO history_metadata_document_tombstones (document_id, original_path, deleted_at)
    VALUES (?, ?, ?)
    ON CONFLICT(document_id) DO UPDATE SET
      original_path = excluded.original_path,
      deleted_at = excluded.deleted_at
  `).run(documentId, originalPath, deletedAt)
}

/** Atomically isolate a stale destination generation and move the source identity. */
export function moveDocumentMetadataReplacingDestination(
  db: DatabaseT,
  fromPath: string,
  toPath: string,
): boolean {
  return db.transaction(() => {
    const source = db.prepare('SELECT id, updated_at FROM documents WHERE path = ?').get(fromPath) as { id: string; updated_at: number } | undefined
    if (!source) return false
    const destination = db.prepare('SELECT id FROM documents WHERE path = ?').get(toPath) as { id: string } | undefined
    if (destination) recordHistoryMetadataTombstone(db, destination.id, toPath)
    quarantineMigrationAtPath(db, toPath, destination?.id)
    if (destination) db.prepare('DELETE FROM documents WHERE id = ?').run(destination.id)
    const timestamp = nextMetadataUpdatedAt(source.updated_at, Date.now())
    db.prepare('UPDATE documents SET path = ?, updated_at = ? WHERE id = ?').run(toPath, timestamp, source.id)
    db.prepare('UPDATE metadata_migrations SET path = ?, updated_at = ? WHERE document_id = ?')
      .run(toPath, timestamp, source.id)
    return true
  })()
}

export function deleteDocumentMetadata(db: DatabaseT, path: string): boolean {
  return db.transaction(() => {
    const document = db.prepare('SELECT id FROM documents WHERE path = ?').get(path) as { id: string } | undefined
    if (document) recordHistoryMetadataTombstone(db, document.id, path)
    quarantineMigrationAtPath(db, path, document?.id)
    const result = document
      ? db.prepare('DELETE FROM documents WHERE id = ?').run(document.id)
      : { changes: 0 }
    return result.changes > 0
  })()
}

/**
 * Reject operations that would (a) collapse source and destination to the same
 * prefix, (b) move a folder into one of its own descendants — which would
 * rewrite the prefix row onto a path that another descendant is also being
 * rewritten from — or (c) overwrite an unrelated existing path.
 *
 * Without this guard the UPDATE loop would either fail mid-transaction (the
 * SQLite UNIQUE(path) violation rolls back the whole rename and leaves the
 * filesystem in a state where the folder has already moved but the metadata
 * hasn't) or silently overwrite an unrelated row.
 */
function assertPrefixMoveSafe(fromPrefix: string, toPrefix: string, planned: Array<{ id: string; nextPath: string }>, db: DatabaseT): void {
  if (toPrefix === fromPrefix) {
    throw new Error(`metadata prefix move source and destination are identical: ${fromPrefix}`)
  }
  if (toPrefix.startsWith(`${fromPrefix}/`)) {
    throw new Error(`cannot move metadata prefix into its own subtree: ${fromPrefix} -> ${toPrefix}`)
  }
  const sourceIds = new Set(planned.map((row) => row.id))
  const seenNext = new Set<string>()
  const lookup = db.prepare('SELECT id FROM documents WHERE path = ?')
  for (const { nextPath } of planned) {
    if (seenNext.has(nextPath)) {
      throw new Error(`metadata prefix move duplicate destination: ${nextPath}`)
    }
    const existing = lookup.get(nextPath) as { id: string } | undefined
    if (existing && !sourceIds.has(existing.id)) {
      throw new Error(`metadata prefix move collides with existing path: ${nextPath}`)
    }
    seenNext.add(nextPath)
  }
}

function movePrefixPath(
  value: unknown,
  fromPrefix: string,
  toPrefix: string,
): unknown {
  if (typeof value !== 'string') return value
  if (value === fromPrefix) return toPrefix
  if (value.startsWith(`${fromPrefix}/`)) {
    return toPrefix + value.slice(fromPrefix.length)
  }
  return value
}

export function moveDocumentMetadataPrefix(
  db: DatabaseT,
  fromPrefix: string,
  toPrefix: string,
  transactionTimestamp?: number,
): number {
  return db.transaction(() => {
    const rows = db.prepare(
      'SELECT id, path, updated_at FROM documents WHERE path = ? OR path LIKE ? ORDER BY length(path)',
    ).all(fromPrefix, `${fromPrefix}/%`) as Array<{ id: string; path: string; updated_at: number }>
    const planned = rows.map((row) => ({
      id: row.id,
      fromPath: row.path,
      nextPath: toPrefix + row.path.slice(fromPrefix.length),
    }))
    assertPrefixMoveSafe(fromPrefix, toPrefix, planned, db)
    const movedDocumentIds = planned.map((row) => row.id)
    const migrationClauses = [
      'path = ?',
      'path LIKE ?',
      'original_path = ?',
      'original_path LIKE ?',
    ]
    const migrationArgs: unknown[] = [
      fromPrefix,
      `${fromPrefix}/%`,
      fromPrefix,
      `${fromPrefix}/%`,
    ]
    if (movedDocumentIds.length > 0) {
      migrationClauses.push(
        `document_id IN (${placeholders(movedDocumentIds)})`,
      )
      migrationArgs.push(...movedDocumentIds)
    }
    const migrationRows = db.prepare(`
      SELECT *
      FROM metadata_migrations
      WHERE ${migrationClauses.join(' OR ')}
      ORDER BY path
    `).all(...migrationArgs) as Record<string, unknown>[]
    const plannedMigrations = migrationRows.map((row) => ({
      row,
      fromPath: String(row.path),
      nextPath: String(movePrefixPath(row.path, fromPrefix, toPrefix)),
      nextOriginalPath: String(
        movePrefixPath(row.original_path, fromPrefix, toPrefix) ?? '',
      ),
    }))
    const finalMigrationPaths = new Set<string>()
    for (const migration of plannedMigrations) {
      if (finalMigrationPaths.has(migration.nextPath)) {
        throw new Error(
          `metadata migration destination collision: ${migration.nextPath}`,
        )
      }
      finalMigrationPaths.add(migration.nextPath)
    }
    const movingMigrationPaths = new Set(
      plannedMigrations.map((migration) => migration.fromPath),
    )
    const lookupMigration = db.prepare(
      'SELECT path FROM metadata_migrations WHERE path = ?',
    )
    for (const migration of plannedMigrations) {
      const existing = lookupMigration.get(migration.nextPath) as
        | { path: string }
        | undefined
      if (existing && !movingMigrationPaths.has(existing.path)) {
        throw new Error(
          `metadata migration destination collides with existing path: ${
            migration.nextPath
          }`,
        )
      }
    }

    const batchTimestamp = transactionTimestamp ?? nextMetadataBatchUpdatedAt(
      rows.map((row) => Number(row.updated_at)),
      Date.now(),
    )
    const update = db.prepare('UPDATE documents SET path = ?, updated_at = ? WHERE id = ?')
    const now = batchTimestamp
    for (const { id, nextPath } of planned) {
      const current = rows.find((row) => row.id === id)
      if (!current) throw new Error(`metadata row disappeared during prefix move: ${id}`)
      // New journals mint `now` strictly above every current row. Legacy
      // journals replay their persisted timestamp verbatim so recovery stays
      // deterministic and matches the durable committed snapshot.
      update.run(nextPath, now, id)
    }

    const movingNamespace = `@moving/${randomUUID()}`
    const moveToTemporary = db.prepare(`
      UPDATE metadata_migrations
      SET path = ?
      WHERE path = ?
    `)
    const finishMigration = db.prepare(`
      UPDATE metadata_migrations
      SET path = ?, original_path = ?, updated_at = ?
      WHERE path = ?
    `)
    const updateMigrationOriginalPath = db.prepare(`
      UPDATE metadata_migrations
      SET original_path = ?, updated_at = ?
      WHERE path = ?
    `)
    const temporaryPaths = new Map<string, string>()
    let movingIndex = 0
    for (const migration of plannedMigrations) {
      if (migration.nextPath === migration.fromPath) continue
      const temporaryPath = `${movingNamespace}/${movingIndex++}`
      moveToTemporary.run(temporaryPath, migration.fromPath)
      temporaryPaths.set(migration.fromPath, temporaryPath)
    }
    for (const migration of plannedMigrations) {
      const temporaryPath = temporaryPaths.get(migration.fromPath)
      if (temporaryPath) {
        finishMigration.run(
          migration.nextPath,
          migration.nextOriginalPath,
          now,
          temporaryPath,
        )
      } else if (migration.nextOriginalPath
        !== String(migration.row.original_path ?? '')) {
        updateMigrationOriginalPath.run(
          migration.nextOriginalPath,
          now,
          migration.fromPath,
        )
      }
    }
    return rows.length
  })()
}

export function deleteDocumentMetadataPrefix(
  db: DatabaseT,
  prefix: string,
  transactionTimestamp = Date.now(),
): number {
  return db.transaction(() => {
    const documents = db.prepare(
      'SELECT id, path FROM documents WHERE path = ? OR path LIKE ?',
    ).all(prefix, `${prefix}/%`) as Array<{ id: string; path: string }>
    for (const document of documents) {
      recordHistoryMetadataTombstone(db, document.id, document.path, transactionTimestamp)
      quarantineMigrationAtPath(
        db,
        document.path,
        document.id,
        transactionTimestamp,
      )
    }
    const result = db.prepare('DELETE FROM documents WHERE path = ? OR path LIKE ?')
      .run(prefix, `${prefix}/%`)
    return result.changes
  })()
}

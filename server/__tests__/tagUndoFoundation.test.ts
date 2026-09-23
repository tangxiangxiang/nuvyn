import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { applyMigrations } from '../db'
import {
  applyDocumentTagsSetDiff,
  getDocumentMetadata,
  restoreDocumentMetadataMutation,
  saveDocumentMetadata,
  snapshotDocumentMetadataMutation,
} from '../documentMetadata'
import {
  getDocumentTagsSnapshotGeneration,
  hasValidSnapshotRowSchema,
  isSerializedMetadataSnapshot,
  reviveMetadataSnapshot,
  serializeMetadataSnapshot,
} from '../folderMoveTransaction'
import {
  getTagUndoFoundationHealth,
  initializeTagUndoFoundationHealth,
  resetTagUndoFoundationHealthForTesting,
} from '../tagUndoHealth'

function migratedDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  return db
}

function legacyV6Db(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applyMigrations(db, 6)
  return db
}

function brokenLegacyV6Db(): Database.Database {
  const db = legacyV6Db()
  db.exec(`
    DROP TABLE document_tags;
    CREATE TABLE document_tags (document_id TEXT NOT NULL);
  `)
  return db
}

function publishedV7Db(): Database.Database {
  const db = legacyV6Db()
  db.exec(readFileSync(new URL('../migrations/0007_tag_management_undo.sql', import.meta.url), 'utf8'))
  db.prepare('DELETE FROM schema_version').run()
  db.prepare('INSERT INTO schema_version (version) VALUES (7)').run()
  return db
}

type SyntheticRecordOverrides = Partial<{
  record_id: string
  kind: 'rename' | 'merge' | 'remove'
  display_only: number
  operation_json: string
  source_tag_id: number
  source_after_exists: number
  source_after_name: string | null
  source_after_normalized_name: string | null
  destination_tag_id: number | null
  destination_before_name: string | null
  destination_before_normalized_name: string | null
  destination_after_name: string | null
  destination_after_normalized_name: string | null
  lifecycle: 'latest' | 'consumed' | 'terminal'
  terminal_code: string | null
  undo_operation_id: string | null
  undo_result_id: string | null
  consumed_at: number | null
  association_remove_count: number
  association_add_count: number
  version_update_count: number
  database_generation: string
}>

function insertSyntheticUndoRecord(
  db: Database.Database,
  overrides: SyntheticRecordOverrides = {},
): string {
  const kind = overrides.kind ?? 'remove'
  const kindDefaults = kind === 'rename'
    ? {
        display_only: 0,
        operation_json: JSON.stringify({ kind: 'rename', sourceTagId: 1, destinationName: 'JavaScript' }),
        source_after_exists: 1,
        source_after_name: 'JavaScript',
        source_after_normalized_name: 'javascript',
        destination_tag_id: null,
        destination_before_name: null,
        destination_before_normalized_name: null,
        destination_after_name: null,
        destination_after_normalized_name: null,
      }
    : kind === 'merge'
      ? {
          display_only: 0,
          operation_json: JSON.stringify({ kind: 'merge', sourceTagId: 1, destinationTagId: 2 }),
          source_after_exists: 0,
          source_after_name: null,
          source_after_normalized_name: null,
          destination_tag_id: 2,
          destination_before_name: 'Backend',
          destination_before_normalized_name: 'backend',
          destination_after_name: 'Backend',
          destination_after_normalized_name: 'backend',
        }
      : {
          display_only: 0,
          operation_json: JSON.stringify({ kind: 'remove', sourceTagId: 1 }),
          source_after_exists: 0,
          source_after_name: null,
          source_after_normalized_name: null,
          destination_tag_id: null,
          destination_before_name: null,
          destination_before_normalized_name: null,
          destination_after_name: null,
          destination_after_normalized_name: null,
        }
  const lifecycleDefaults = overrides.lifecycle === 'consumed'
    ? { terminal_code: null, undo_operation_id: 'undo-op-1', undo_result_id: 'undo-result-1', consumed_at: 2 }
    : overrides.lifecycle === 'terminal'
      ? { terminal_code: 'UNDO_TERMINAL', undo_operation_id: null, undo_result_id: null, consumed_at: null }
      : { terminal_code: null, undo_operation_id: null, undo_result_id: null, consumed_at: null }
  const recordId = overrides.record_id ?? `record-${Math.random().toString(16).slice(2)}`
  const row = {
    record_id: recordId,
    original_operation_id: `operation-${recordId}`,
    original_result_id: `result-${recordId}`,
    kind,
    identity_contract_version: 'tag-identity-v1',
    record_contract_version: 'tag-undo-record-v1',
    database_generation: (db.prepare('SELECT database_generation FROM tag_undo_state').get() as { database_generation: string }).database_generation,
    committed_at: 1,
    source_tag_id: 1,
    source_before_name: 'Java',
    source_before_normalized_name: 'java',
    association_remove_count: 0,
    association_add_count: 0,
    version_update_count: 0,
    lifecycle: 'latest' as const,
    ...kindDefaults,
    ...lifecycleDefaults,
    ...overrides,
  }
  db.prepare(`
    INSERT INTO tag_undo_records (
      record_id, original_operation_id, original_result_id, kind, display_only,
      identity_contract_version, record_contract_version, database_generation,
      operation_json, committed_at, source_tag_id, source_before_name,
      source_before_normalized_name, source_after_exists, source_after_name,
      source_after_normalized_name, destination_tag_id, destination_before_name,
      destination_before_normalized_name, destination_after_name,
      destination_after_normalized_name, lifecycle, terminal_code,
      undo_operation_id, undo_result_id, consumed_at, association_remove_count,
      association_add_count, version_update_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.record_id, row.original_operation_id, row.original_result_id, row.kind,
    row.display_only, row.identity_contract_version, row.record_contract_version,
    row.database_generation, row.operation_json, row.committed_at,
    row.source_tag_id, row.source_before_name, row.source_before_normalized_name,
    row.source_after_exists, row.source_after_name, row.source_after_normalized_name,
    row.destination_tag_id, row.destination_before_name,
    row.destination_before_normalized_name, row.destination_after_name,
    row.destination_after_normalized_name, row.lifecycle, row.terminal_code,
    row.undo_operation_id, row.undo_result_id, row.consumed_at,
    row.association_remove_count, row.association_add_count,
    row.version_update_count,
  )
  return row.record_id
}

function pointFoundationStateAt(db: Database.Database, recordId: string): void {
  db.prepare('UPDATE tag_undo_state SET current_record_id = ?, updated_at = 2 WHERE state_id = 1').run(recordId)
}

function seedDocument(db: Database.Database, tags: string[] = ['Backend']): void {
  saveDocumentMetadata(db, {
    id: 'doc-1',
    path: 'notes/one',
    title: 'One',
    tags,
    createdAt: 1,
    updatedAt: 10,
  })
}

describe('T2.1-0 migration and foundation health', () => {
  it('rebuilds a populated v6 association graph with explicit unique IDs', () => {
    const db = legacyV6Db()
    db.exec(`
      INSERT INTO documents (id, path, title, summary, created_at, updated_at)
      VALUES ('a', 'notes/a', 'A', '', 1, 10), ('b', 'notes/b', 'B', '', 2, 20);
      INSERT INTO tags (id, name, normalized_name)
      VALUES (7, 'Java', 'java'), (9, 'Python', 'python');
      INSERT INTO document_tags (document_id, tag_id)
      VALUES ('a', 7), ('a', 9), ('b', 7);
    `)

    applyMigrations(db)

    expect((db.prepare('SELECT version FROM schema_version').get() as { version: number }).version).toBe(36)
    expect(db.prepare('SELECT document_id, tag_id FROM document_tags ORDER BY document_id, tag_id').all()).toEqual([
      { document_id: 'a', tag_id: 7 },
      { document_id: 'a', tag_id: 9 },
      { document_id: 'b', tag_id: 7 },
    ])
    const associations = db.prepare('SELECT association_id FROM document_tags ORDER BY association_id').all() as Array<{ association_id: number }>
    expect(associations).toHaveLength(3)
    expect(new Set(associations.map((row) => row.association_id)).size).toBe(3)
    expect(associations.every((row) => row.association_id > 0)).toBe(true)
    expect(() => db.prepare('INSERT INTO document_tags (document_id, tag_id) VALUES (?, ?)').run('a', 7)).toThrow()
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok')
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'document_tags'").all()).toEqual(expect.arrayContaining([
      { name: 'idx_document_tags_tag' },
      { name: 'idx_document_tags_document' },
    ]))
  })

  it('is idempotent and exposes a healthy foundation without activating Undo', () => {
    const db = migratedDb()
    const before = db.prepare('SELECT * FROM tag_undo_state').all()
    applyMigrations(db)
    expect(db.prepare('SELECT * FROM tag_undo_state').all()).toEqual(before)

    const health = initializeTagUndoFoundationHealth(db)
    expect(health).toMatchObject({ state: 'healthy', schemaVersion: 36 })
    expect(getTagUndoFoundationHealth(db)).toEqual(health)
    expect(db.prepare('SELECT COUNT(*) AS count FROM tag_undo_records').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT current_record_id FROM tag_undo_state').get()).toEqual({ current_record_id: null })
    resetTagUndoFoundationHealthForTesting(db)
    db.close()
  })

  it('fails foundation health closed when the singleton is malformed', () => {
    const db = migratedDb()
    db.prepare('UPDATE tag_undo_state SET database_generation = ? WHERE state_id = 1').run('bad')
    expect(initializeTagUndoFoundationHealth(db)).toMatchObject({
      state: 'unavailable',
      code: 'TAG_UNDO_FOUNDATION_UNHEALTHY',
    })
    db.close()
  })

  it('rolls back a failed 0007 rebuild without changing the v6 database', () => {
    const db = brokenLegacyV6Db()
    expect(() => applyMigrations(db)).toThrow()
    expect((db.prepare('SELECT version FROM schema_version').get() as { version: number }).version).toBe(6)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'document_tags'").get()).toEqual({ name: 'document_tags' })
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'document_tags_phase21'").get()).toBeUndefined()
    db.close()
  })

  it('retries 0007 successfully after a rolled-back v6 source defect is repaired', () => {
    const db = brokenLegacyV6Db()
    expect(() => applyMigrations(db)).toThrow()
    expect((db.prepare('SELECT version FROM schema_version').get() as { version: number }).version).toBe(6)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'document_tags_phase21'").get()).toBeUndefined()

    db.exec(`
      DROP TABLE document_tags;
      CREATE TABLE document_tags (
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY (document_id, tag_id)
      );
      CREATE INDEX idx_document_tags_tag ON document_tags(tag_id, document_id);
      INSERT INTO documents (id, path, title, summary, created_at, updated_at)
      VALUES ('retry-doc', 'notes/retry', 'Retry', '', 1, 1);
      INSERT INTO tags (id, name, normalized_name) VALUES (7, 'Java', 'java');
      INSERT INTO document_tags (document_id, tag_id) VALUES ('retry-doc', 7);
    `)

    applyMigrations(db)

    expect((db.prepare('SELECT version FROM schema_version').get() as { version: number }).version).toBe(36)
    expect(db.prepare('SELECT document_id, tag_id FROM document_tags').all()).toEqual([
      { document_id: 'retry-doc', tag_id: 7 },
    ])
    expect(db.prepare('SELECT association_id FROM document_tags').get()).toEqual({ association_id: 1 })
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok')
    db.close()
  })
})

describe('T2.1-0 forward repair migration and lifecycle contract', () => {
  it('repairs an already-applied v7 database without editing 0007 history', () => {
    const db = publishedV7Db()
    const recordId = insertSyntheticUndoRecord(db, { record_id: 'v7-latest' })
    pointFoundationStateAt(db, recordId)
    const beforeRecord = db.prepare('SELECT * FROM tag_undo_records').all()
    const beforeState = db.prepare('SELECT * FROM tag_undo_state').all()

    applyMigrations(db)

    expect((db.prepare('SELECT version FROM schema_version').get() as { version: number }).version).toBe(36)
    expect(db.prepare('SELECT * FROM tag_undo_records').all()).toEqual(beforeRecord)
    expect(db.prepare('SELECT * FROM tag_undo_state').all()).toEqual(beforeState)
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    db.close()
  })

  it('preserves a valid consumed parent, children, and singleton pointer across v7 to v8', () => {
    const db = publishedV7Db()
    const recordId = insertSyntheticUndoRecord(db, {
      record_id: 'v7-consumed',
      kind: 'merge',
      lifecycle: 'consumed',
      association_remove_count: 1,
    })
    db.prepare(`
      INSERT INTO tag_undo_association_deltas (
        record_id, effect, association_id, document_id, tag_id
      ) VALUES (?, 'removed-source', 51, 'doc-1', 1)
    `).run(recordId)
    pointFoundationStateAt(db, recordId)
    const before = {
      records: db.prepare('SELECT * FROM tag_undo_records').all(),
      deltas: db.prepare('SELECT * FROM tag_undo_association_deltas').all(),
      state: db.prepare('SELECT * FROM tag_undo_state').all(),
    }

    applyMigrations(db)

    expect(db.prepare('SELECT * FROM tag_undo_records').all()).toEqual(before.records)
    expect(db.prepare('SELECT * FROM tag_undo_association_deltas').all()).toEqual(before.deltas)
    expect(db.prepare('SELECT * FROM tag_undo_state').all()).toEqual(before.state)
    db.close()
  })

  it('rolls back 0008 when an existing v7 durable row violates the repaired lifecycle', () => {
    const db = publishedV7Db()
    db.pragma('ignore_check_constraints = ON')
    insertSyntheticUndoRecord(db, {
      record_id: 'v7-invalid-consumed',
      lifecycle: 'consumed',
      terminal_code: 'illegal-terminal-code',
    })
    db.pragma('ignore_check_constraints = OFF')

    expect(() => applyMigrations(db)).toThrow()
    expect((db.prepare('SELECT version FROM schema_version').get() as { version: number }).version).toBe(7)
    expect(db.prepare('SELECT record_id, terminal_code FROM tag_undo_records').all()).toEqual([{
      record_id: 'v7-invalid-consumed',
      terminal_code: 'illegal-terminal-code',
    }])
    expect(db.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name = \'tag_undo_records_repair\'').get()).toBeUndefined()
    db.close()
  })

  const validLifecycles = [
    ['latest', { lifecycle: 'latest' as const }],
    ['consumed', { lifecycle: 'consumed' as const }],
    ['terminal', { lifecycle: 'terminal' as const }],
  ] as const

  it.each(validLifecycles)('%s lifecycle is representable in the repaired schema', (_label, overrides) => {
    const db = migratedDb()
    const recordId = insertSyntheticUndoRecord(db, overrides)
    pointFoundationStateAt(db, recordId)
    expect(initializeTagUndoFoundationHealth(db)).toMatchObject({ state: 'healthy', schemaVersion: 36 })
    db.close()
  })

  const invalidLifecycles: Array<[string, SyntheticRecordOverrides]> = [
    ['latest with terminal_code', { lifecycle: 'latest', terminal_code: 'not-allowed' }],
    ['consumed with terminal_code', { lifecycle: 'consumed', terminal_code: 'not-allowed' }],
    ['terminal without terminal_code', { lifecycle: 'terminal', terminal_code: null }],
    ['terminal with undo_operation_id', { lifecycle: 'terminal', undo_operation_id: 'undo-op' }],
    ['terminal with consumed_at', { lifecycle: 'terminal', consumed_at: 3 }],
    ['consumed without undo_result_id', { lifecycle: 'consumed', undo_result_id: null }],
  ]

  it.each(invalidLifecycles)('%s is rejected by the repaired schema', (_label, overrides) => {
    const db = migratedDb()
    expect(() => insertSyntheticUndoRecord(db, overrides)).toThrow()
    db.close()
  })
})

describe('T2.1-0 foundation health bounded state and record contract', () => {
  it('accepts an empty singleton foundation', () => {
    const db = migratedDb()
    expect(initializeTagUndoFoundationHealth(db)).toMatchObject({ state: 'healthy', schemaVersion: 36 })
    db.close()
  })

  it('accepts one retained latest record with the matching pointer', () => {
    const db = migratedDb()
    const recordId = insertSyntheticUndoRecord(db, { record_id: 'health-latest' })
    pointFoundationStateAt(db, recordId)
    expect(initializeTagUndoFoundationHealth(db).state).toBe('healthy')
    db.close()
  })

  it('accepts consumed and terminal retained records without treating them as corruption', () => {
    for (const lifecycle of ['consumed', 'terminal'] as const) {
      const db = migratedDb()
      const recordId = insertSyntheticUndoRecord(db, { lifecycle, record_id: `health-${lifecycle}` })
      pointFoundationStateAt(db, recordId)
      expect(initializeTagUndoFoundationHealth(db).state).toBe('healthy')
      db.close()
    }
  })

  it('fails closed when more than one durable parent is retained', () => {
    const db = migratedDb()
    const first = insertSyntheticUndoRecord(db, { record_id: 'health-first' })
    insertSyntheticUndoRecord(db, { record_id: 'health-second' })
    pointFoundationStateAt(db, first)
    expect(initializeTagUndoFoundationHealth(db).state).toBe('unavailable')
    db.close()
  })

  it('fails closed when two latest parents exist', () => {
    const db = migratedDb()
    const first = insertSyntheticUndoRecord(db, { record_id: 'health-latest-a' })
    insertSyntheticUndoRecord(db, { record_id: 'health-latest-b' })
    pointFoundationStateAt(db, first)
    expect(initializeTagUndoFoundationHealth(db).state).toBe('unavailable')
    db.close()
  })

  it('fails closed when a latest parent has no current pointer', () => {
    const db = migratedDb()
    insertSyntheticUndoRecord(db, { record_id: 'health-unpointed' })
    expect(initializeTagUndoFoundationHealth(db).state).toBe('unavailable')
    db.close()
  })

  it('fails closed when the current pointer is missing', () => {
    const db = migratedDb()
    db.pragma('foreign_keys = OFF')
    db.prepare('UPDATE tag_undo_state SET current_record_id = ? WHERE state_id = 1').run('missing-record')
    expect(initializeTagUndoFoundationHealth(db).state).toBe('unavailable')
    db.close()
  })

  it('fails closed when a second retained parent is unrelated to the current pointer', () => {
    const db = migratedDb()
    const first = insertSyntheticUndoRecord(db, { record_id: 'health-current' })
    insertSyntheticUndoRecord(db, { record_id: 'health-unrelated' })
    pointFoundationStateAt(db, first)
    expect(initializeTagUndoFoundationHealth(db).state).toBe('unavailable')
    db.close()
  })

  it('fails closed on generation mismatch and count mismatch', () => {
    const generationDb = migratedDb()
    const generationRecord = insertSyntheticUndoRecord(generationDb, { record_id: 'health-generation' })
    pointFoundationStateAt(generationDb, generationRecord)
    generationDb.prepare('UPDATE tag_undo_records SET database_generation = ? WHERE record_id = ?').run('deadbeef', generationRecord)
    expect(initializeTagUndoFoundationHealth(generationDb).state).toBe('unavailable')
    generationDb.close()

    const countDb = migratedDb()
    const countRecord = insertSyntheticUndoRecord(countDb, { record_id: 'health-count' })
    pointFoundationStateAt(countDb, countRecord)
    countDb.prepare('UPDATE tag_undo_records SET association_remove_count = 1 WHERE record_id = ?').run(countRecord)
    expect(initializeTagUndoFoundationHealth(countDb).state).toBe('unavailable')
    countDb.close()
  })

  it('rejects invalid child ownership and kind-specific delta contracts', () => {
    const orphanDb = migratedDb()
    orphanDb.pragma('foreign_keys = OFF')
    orphanDb.prepare(`
      INSERT INTO tag_undo_association_deltas (
        record_id, effect, association_id, document_id, tag_id
      ) VALUES ('orphan', 'removed-source', 1, 'doc-1', 1)
    `).run()
    expect(initializeTagUndoFoundationHealth(orphanDb).state).toBe('unavailable')
    orphanDb.close()

    const renameDb = migratedDb()
    const renameRecord = insertSyntheticUndoRecord(renameDb, { kind: 'rename', record_id: 'health-rename-delta' })
    pointFoundationStateAt(renameDb, renameRecord)
    renameDb.prepare(`
      INSERT INTO tag_undo_association_deltas (
        record_id, effect, association_id, document_id, tag_id
      ) VALUES (?, 'removed-source', 1, 'doc-1', 1)
    `).run(renameRecord)
    expect(initializeTagUndoFoundationHealth(renameDb).state).toBe('unavailable')
    renameDb.close()
  })

  it('rejects missing Merge destination data and illegal Remove destination data', () => {
    const mergeDb = migratedDb()
    const mergeRecord = insertSyntheticUndoRecord(mergeDb, {
      kind: 'merge',
      record_id: 'health-merge-missing-destination',
      destination_tag_id: null,
      destination_before_name: null,
      destination_before_normalized_name: null,
      destination_after_name: null,
      destination_after_normalized_name: null,
    })
    pointFoundationStateAt(mergeDb, mergeRecord)
    expect(initializeTagUndoFoundationHealth(mergeDb).state).toBe('unavailable')
    mergeDb.close()

    const removeDb = migratedDb()
    const removeRecord = insertSyntheticUndoRecord(removeDb, {
      kind: 'remove',
      record_id: 'health-remove-illegal-destination',
      destination_tag_id: 2,
      destination_before_name: 'Backend',
      destination_before_normalized_name: 'backend',
      destination_after_name: 'Backend',
      destination_after_normalized_name: 'backend',
    })
    pointFoundationStateAt(removeDb, removeRecord)
    expect(initializeTagUndoFoundationHealth(removeDb).state).toBe('unavailable')
    removeDb.close()
  })

  it('rejects malformed normalized operation JSON', () => {
    const db = migratedDb()
    const recordId = insertSyntheticUndoRecord(db, { record_id: 'health-malformed-json', operation_json: 'not-json' })
    pointFoundationStateAt(db, recordId)
    expect(initializeTagUndoFoundationHealth(db).state).toBe('unavailable')
    db.close()
  })
})

describe('T2.1-0 ordinary association provenance', () => {
  it('preserves unchanged IDs, inserts only additions, and deletes only removals', () => {
    const db = migratedDb()
    seedDocument(db, ['Backend', 'Python'])
    const backendBefore = db.prepare("SELECT association_id FROM document_tags dt JOIN tags t ON t.id = dt.tag_id WHERE dt.document_id = 'doc-1' AND t.normalized_name = 'backend'").get() as { association_id: number }
    const pythonBefore = db.prepare("SELECT association_id FROM document_tags dt JOIN tags t ON t.id = dt.tag_id WHERE dt.document_id = 'doc-1' AND t.normalized_name = 'python'").get() as { association_id: number }

    const diff = applyDocumentTagsSetDiff(db, 'doc-1', [
      { displayName: 'Backend', normalizedName: 'backend' },
      { displayName: 'Vue', normalizedName: 'vue' },
    ])
    expect(diff.unchangedAssociationIds).toEqual([backendBefore.association_id])
    expect(diff.removedAssociationIds).toEqual([pythonBefore.association_id])
    expect(diff.addedAssociationIds).toHaveLength(1)
    expect(db.prepare("SELECT association_id FROM document_tags dt JOIN tags t ON t.id = dt.tag_id WHERE dt.document_id = 'doc-1' AND t.normalized_name = 'backend'").get()).toEqual(backendBefore)
    expect(db.prepare("SELECT association_id FROM document_tags dt JOIN tags t ON t.id = dt.tag_id WHERE dt.document_id = 'doc-1' AND t.normalized_name = 'vue'").get()).toEqual({ association_id: diff.addedAssociationIds[0] })
    db.close()
  })

  it('does no association rewrite for an identical set and allocates a new ID after delete/re-add', () => {
    const db = migratedDb()
    seedDocument(db, ['Backend'])
    const before = db.prepare('SELECT association_id FROM document_tags WHERE document_id = ?').get('doc-1') as { association_id: number }
    const noOp = applyDocumentTagsSetDiff(db, 'doc-1', [{ displayName: 'Backend', normalizedName: 'backend' }])
    expect(noOp).toEqual({
      unchangedAssociationIds: [before.association_id],
      addedAssociationIds: [],
      removedAssociationIds: [],
    })
    expect(db.prepare('SELECT association_id FROM document_tags WHERE document_id = ?').get('doc-1')).toEqual(before)

    applyDocumentTagsSetDiff(db, 'doc-1', [])
    const readded = applyDocumentTagsSetDiff(db, 'doc-1', [{ displayName: 'Backend', normalizedName: 'backend' }])
    expect(readded.addedAssociationIds[0]).toBeGreaterThan(before.association_id)
    expect(readded.addedAssociationIds[0]).not.toBe(before.association_id)
    db.close()
  })
})

describe('T2.1-0 v6/v7 durable metadata snapshot compatibility', () => {
  it('accepts exact legacy v6 and marked v7 rows, but rejects mixed rows', () => {
    const base = {
      paths: ['notes/one'],
      documentIds: ['doc-1'],
      tagIds: [1],
      preexistingTagIds: [1],
      documents: [{ id: 'doc-1', path: 'notes/one', title: 'One', summary: '', created_at: 1, updated_at: 10 }],
      tags: [{ id: 1, name: 'Backend', normalized_name: 'backend' }],
      embeddings: [],
      migrations: [],
    }
    const v6 = { ...base, documentTags: [{ document_id: 'doc-1', tag_id: 1 }] }
    const v7 = { ...base, documentTagsVersion: 7 as const, documentTags: [{ association_id: 51, document_id: 'doc-1', tag_id: 1 }] }
    const mixed = { ...base, documentTags: [...v6.documentTags, ...v7.documentTags] }

    expect(isSerializedMetadataSnapshot(v6)).toBe(true)
    expect(hasValidSnapshotRowSchema(v6)).toBe(true)
    expect(getDocumentTagsSnapshotGeneration(v6)).toBe('v6')
    expect(isSerializedMetadataSnapshot(v7)).toBe(true)
    expect(getDocumentTagsSnapshotGeneration(v7)).toBe('v7')
    expect(isSerializedMetadataSnapshot(mixed)).toBe(false)
    expect(getDocumentTagsSnapshotGeneration(mixed)).toBeNull()
  })

  it('preserves an existing v7 ID and allocates a new ID for a missing v6 row', () => {
    const db = migratedDb()
    db.prepare("INSERT INTO documents (id, path, title, summary, created_at, updated_at) VALUES ('doc-1', 'notes/one', 'One', '', 1, 10)").run()
    db.prepare("INSERT INTO tags (id, name, normalized_name) VALUES (1, 'Backend', 'backend')").run()
    db.prepare("INSERT INTO document_tags (association_id, document_id, tag_id) VALUES (51, 'doc-1', 1)").run()
    const v6Snapshot = {
      paths: ['notes/one'],
      documentIds: ['doc-1'],
      tagIds: [1],
      preexistingTagIds: [1],
      documents: [{ id: 'doc-1', path: 'notes/one', title: 'One', summary: '', created_at: 1, updated_at: 10 }],
      tags: [{ id: 1, name: 'Backend', normalized_name: 'backend' }],
      documentTags: [{ document_id: 'doc-1', tag_id: 1 }],
      embeddings: [],
      migrations: [],
    }
    restoreDocumentMetadataMutation(db, reviveMetadataSnapshot(v6Snapshot))
    expect(db.prepare('SELECT association_id FROM document_tags').get()).toEqual({ association_id: 51 })

    db.prepare('DELETE FROM documents WHERE id = ?').run('doc-1')
    restoreDocumentMetadataMutation(db, reviveMetadataSnapshot(v6Snapshot))
    const restored = db.prepare('SELECT association_id FROM document_tags').get() as { association_id: number }
    expect(restored.association_id).toBeGreaterThan(51)
    db.close()
  })

  it('handles a v6 snapshot with both proven live and missing associations', () => {
    const db = migratedDb()
    db.exec(`
      INSERT INTO documents (id, path, title, summary, created_at, updated_at)
      VALUES ('doc-1', 'notes/one', 'One', '', 1, 10);
      INSERT INTO tags (id, name, normalized_name) VALUES (1, 'Backend', 'backend');
      INSERT INTO document_tags (association_id, document_id, tag_id)
      VALUES (51, 'doc-1', 1);
    `)
    const v6Snapshot = {
      paths: ['notes/one', 'notes/two'],
      documentIds: ['doc-1', 'doc-2'],
      tagIds: [1],
      preexistingTagIds: [1],
      documents: [
        { id: 'doc-1', path: 'notes/one', title: 'One', summary: '', created_at: 1, updated_at: 10 },
        { id: 'doc-2', path: 'notes/two', title: 'Two', summary: '', created_at: 2, updated_at: 20 },
      ],
      tags: [{ id: 1, name: 'Backend', normalized_name: 'backend' }],
      documentTags: [
        { document_id: 'doc-1', tag_id: 1 },
        { document_id: 'doc-2', tag_id: 1 },
      ],
      embeddings: [],
      migrations: [],
    }

    restoreDocumentMetadataMutation(db, reviveMetadataSnapshot(v6Snapshot))
    expect(db.prepare('SELECT association_id FROM document_tags WHERE document_id = ?').get('doc-1')).toEqual({ association_id: 51 })
    const newAssociation = db.prepare('SELECT association_id FROM document_tags WHERE document_id = ?').get('doc-2') as { association_id: number }
    expect(newAssociation.association_id).toBeGreaterThan(51)
    db.close()
  })

  it('marks new durable snapshots as v7 with explicit physical identity', () => {
    const db = migratedDb()
    seedDocument(db)
    const serialized = serializeMetadataSnapshot(snapshotDocumentMetadataMutation(db, ['notes/one']))
    expect(serialized.documentTagsVersion).toBe(7)
    expect(getDocumentTagsSnapshotGeneration(serialized)).toBe('v7')
    expect(serialized.documentTags[0]).toHaveProperty('association_id')
    db.close()
  })
})

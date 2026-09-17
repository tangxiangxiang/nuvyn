import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyMigrations } from '../db'
import {
  __setTagIdentityMigrationFailureForTesting,
  getTagIdentityHealth,
  initializeTagIdentityAndHealth,
  refreshTagIdentityHealth,
  resetTagIdentityHealthForTesting,
  runTagIdentityMigrationForTesting,
  TAG_IDENTITY_MIGRATION_KEY,
} from '../tagIdentityMigration'
import { normalizeTagIdentity } from '../../shared/tagNormalization'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
})

afterEach(() => {
  __setTagIdentityMigrationFailureForTesting(null)
  resetTagIdentityHealthForTesting(db)
  db.close()
})

function metadataReport() {
  return { scanned: 0, imported: 0, verified: 0, skipped: 0, failed: 0, pruned: 0 }
}

function marker(): Record<string, unknown> | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(TAG_IDENTITY_MIGRATION_KEY) as
    | { value: string }
    | undefined
  return row ? JSON.parse(row.value) as Record<string, unknown> : null
}

function seedDocuments(values: Array<{ id: string; updatedAt: number }>): void {
  const insert = db.prepare(`
    INSERT INTO documents (id, path, title, summary, created_at, updated_at)
    VALUES (?, ?, ?, '', ?, ?)
  `)
  for (const value of values) insert.run(value.id, value.id, value.id, value.updatedAt, value.updatedAt)
}

function seedCollision(): void {
  seedDocuments([{ id: 'a', updatedAt: 100 }, { id: 'b', updatedAt: 200 }])
  db.exec(`
    INSERT INTO tags (id, name, normalized_name) VALUES
      (3, 'Java', 'Java'),
      (8, '#java', '#java'),
      (11, 'JAVA', 'JAVA');
    INSERT INTO document_tags (document_id, tag_id) VALUES
      ('a', 3), ('a', 8), ('b', 8), ('b', 11);
  `)
}

function seedJavaAndHashJavaDifferentDocuments(): void {
  seedDocuments([{ id: 'survivor-only', updatedAt: 100 }, { id: 'loser-only', updatedAt: 200 }])
  db.exec(`
    INSERT INTO tags (id, name, normalized_name) VALUES
      (3, 'Java', 'java'),
      (8, '#java', '#java');
    INSERT INTO document_tags (document_id, tag_id) VALUES
      ('survivor-only', 3), ('loser-only', 8);
  `)
}

function snapshot() {
  return {
    tags: db.prepare('SELECT * FROM tags ORDER BY id').all(),
    associations: db.prepare('SELECT * FROM document_tags ORDER BY document_id, tag_id').all(),
    documents: db.prepare('SELECT * FROM documents ORDER BY id').all(),
  }
}

function logicalMemberships(): Set<string> {
  const identities = new Map(
    (db.prepare('SELECT id, name FROM tags').all() as Array<{ id: number; name: string }>)
      .map((row) => [row.id, normalizeTagIdentity(row.name)] as const),
  )
  return new Set(
    (db.prepare('SELECT document_id, tag_id FROM document_tags').all() as Array<{ document_id: string; tag_id: number }>)
      .map((row) => `${row.document_id}\u0000${identities.get(row.tag_id)}`),
  )
}

function updatedAt(id: string): number {
  return (db.prepare('SELECT updated_at FROM documents WHERE id = ?').get(id) as { updated_at: number }).updated_at
}

describe('T2-0 tag identity migration', () => {
  it('handles a fresh clean database without unnecessary mutations', () => {
    const before = snapshot()
    const result = runTagIdentityMigrationForTesting(db)

    expect(result).toEqual({
      complete: true,
      report: {
        rowsScanned: 0,
        logicalGroups: 0,
        collisionGroups: 0,
        survivors: 0,
        associationsMoved: 0,
        associationsCollapsed: 0,
        tagRowsDeleted: 0,
        displayRowsChanged: 0,
        identityRowsChanged: 0,
        documentsVersioned: 0,
      },
    })
    expect(snapshot()).toEqual(before)
    expect(marker()).toMatchObject({ status: 'complete' })
  })

  it('consolidates java, #java, and JAVA with exact report counts and logical membership preservation', () => {
    seedCollision()
    const beforeMembership = logicalMemberships()
    const result = runTagIdentityMigrationForTesting(db)

    expect(result.complete).toBe(true)
    expect(result.report).toEqual({
      rowsScanned: 3,
      logicalGroups: 1,
      collisionGroups: 1,
      survivors: 1,
      associationsMoved: 1,
      associationsCollapsed: 2,
      tagRowsDeleted: 2,
      displayRowsChanged: 0,
      identityRowsChanged: 1,
      documentsVersioned: 2,
    })
    expect(db.prepare('SELECT id, name, normalized_name FROM tags').all()).toEqual([
      { id: 3, name: 'Java', normalized_name: 'java' },
    ])
    expect(db.prepare('SELECT document_id, tag_id FROM document_tags ORDER BY document_id').all()).toEqual([
      { document_id: 'a', tag_id: 3 },
      { document_id: 'b', tag_id: 3 },
    ])
    expect(logicalMemberships()).toEqual(beforeMembership)
    expect(updatedAt('a')).toBeGreaterThan(100)
    expect(updatedAt('b')).toBeGreaterThan(200)
    expect(updatedAt('a')).toBe(updatedAt('b'))
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(db.prepare("SELECT normalized_name FROM tags WHERE normalized_name LIKE '__nuvyn_t20_stage_%'").all()).toEqual([])
  })

  it('does not version a survivor-only document when only a losing association moves', () => {
    seedJavaAndHashJavaDifferentDocuments()
    const result = runTagIdentityMigrationForTesting(db)

    expect(result.report.documentsVersioned).toBe(1)
    expect(updatedAt('survivor-only')).toBe(100)
    expect(updatedAt('loser-only')).toBeGreaterThan(200)
    expect(db.prepare('SELECT document_id, tag_id FROM document_tags ORDER BY document_id').all()).toEqual([
      { document_id: 'loser-only', tag_id: 3 },
      { document_id: 'survivor-only', tag_id: 3 },
    ])
  })

  it('versions every document whose hydrated survivor display changes', () => {
    seedDocuments([{ id: 'survivor', updatedAt: 100 }, { id: 'loser', updatedAt: 200 }])
    db.exec(`
      INSERT INTO tags (id, name, normalized_name) VALUES
        (3, '#Java', 'java'),
        (8, '#java', '#java');
      INSERT INTO document_tags (document_id, tag_id) VALUES ('survivor', 3), ('loser', 8);
    `)

    const result = runTagIdentityMigrationForTesting(db)

    expect(result.report.displayRowsChanged).toBe(1)
    expect(result.report.documentsVersioned).toBe(2)
    expect(updatedAt('survivor')).toBeGreaterThan(100)
    expect(updatedAt('loser')).toBeGreaterThan(200)
    expect(db.prepare('SELECT name, normalized_name FROM tags').all()).toEqual([
      { name: 'Java', normalized_name: 'java' },
    ])
  })

  it('repairs a singleton normalized_name without versioning its documents', () => {
    seedDocuments([{ id: 'a', updatedAt: 100 }])
    db.exec(`
      INSERT INTO tags (id, name, normalized_name) VALUES (3, 'Java', 'Java');
      INSERT INTO document_tags (document_id, tag_id) VALUES ('a', 3);
    `)

    const result = runTagIdentityMigrationForTesting(db)

    expect(result.report.identityRowsChanged).toBe(1)
    expect(result.report.displayRowsChanged).toBe(0)
    expect(result.report.documentsVersioned).toBe(0)
    expect(updatedAt('a')).toBe(100)
    expect(db.prepare('SELECT id, name, normalized_name FROM tags').all()).toEqual([
      { id: 3, name: 'Java', normalized_name: 'java' },
    ])
    expect(db.prepare('SELECT document_id, tag_id FROM document_tags').all()).toEqual([
      { document_id: 'a', tag_id: 3 },
    ])
  })

  it('versions same-document overlap exactly once', () => {
    seedDocuments([{ id: 'overlap', updatedAt: 100 }])
    db.exec(`
      INSERT INTO tags (id, name, normalized_name) VALUES (3, 'Java', 'java'), (8, '#java', '#java');
      INSERT INTO document_tags (document_id, tag_id) VALUES ('overlap', 3), ('overlap', 8);
    `)
    const before = updatedAt('overlap')

    const result = runTagIdentityMigrationForTesting(db)

    expect(result.report.documentsVersioned).toBe(1)
    expect(updatedAt('overlap')).toBeGreaterThan(before)
    expect(db.prepare('SELECT document_id, tag_id FROM document_tags').all()).toEqual([
      { document_id: 'overlap', tag_id: 3 },
    ])
  })

  it('versions losing-row-only documents once across many-to-one collapse', () => {
    seedDocuments([
      { id: 'a', updatedAt: 10 },
      { id: 'b', updatedAt: 20 },
      { id: 'c', updatedAt: 30 },
    ])
    db.exec(`
      INSERT INTO tags (id, name, normalized_name) VALUES
        (3, 'Java', 'java'), (8, '#java', '#java'), (11, 'JAVA', 'JAVA'), (14, 'Java  ', 'Java  ');
      INSERT INTO document_tags (document_id, tag_id) VALUES
        ('a', 8), ('a', 11), ('b', 8), ('b', 14), ('c', 11);
    `)

    const result = runTagIdentityMigrationForTesting(db)

    expect(result.report.documentsVersioned).toBe(3)
    expect(updatedAt('a')).toBeGreaterThan(10)
    expect(updatedAt('b')).toBeGreaterThan(20)
    expect(updatedAt('c')).toBeGreaterThan(30)
    expect(db.prepare('SELECT document_id, tag_id FROM document_tags ORDER BY document_id').all()).toEqual([
      { document_id: 'a', tag_id: 3 },
      { document_id: 'b', tag_id: 3 },
      { document_id: 'c', tag_id: 3 },
    ])
  })

  it('uses the lowest tag ID as survivor and its display as the winner', () => {
    seedDocuments([{ id: 'a', updatedAt: 1 }])
    db.exec(`
      INSERT INTO tags (id, name, normalized_name) VALUES (8, 'Java', 'java'), (3, 'JAVA', 'JAVA');
      INSERT INTO document_tags (document_id, tag_id) VALUES ('a', 8);
    `)

    runTagIdentityMigrationForTesting(db)

    expect(db.prepare('SELECT id, name, normalized_name FROM tags').all()).toEqual([
      { id: 3, name: 'JAVA', normalized_name: 'java' },
    ])
    expect(db.prepare('SELECT tag_id FROM document_tags').all()).toEqual([{ tag_id: 3 }])
  })

  it('normalizes orphan collision groups without versioning documents', () => {
    db.exec(`
      INSERT INTO tags (id, name, normalized_name) VALUES (3, 'Java', 'Java'), (8, '#java', '#java');
    `)

    const result = runTagIdentityMigrationForTesting(db)

    expect(result.complete).toBe(true)
    expect(result.report.documentsVersioned).toBe(0)
    expect(db.prepare('SELECT id, name, normalized_name FROM tags').all()).toEqual([
      { id: 3, name: 'Java', normalized_name: 'java' },
    ])
  })

  it.each([
    ['empty', '#'],
    ['control character', 'bad\u0001tag'],
  ])('rejects invalid historical %s tag without deleting it', (_label, name) => {
    db.prepare('INSERT INTO tags (id, name, normalized_name) VALUES (?, ?, ?)').run(3, name, name)
    const before = snapshot()

    const result = runTagIdentityMigrationForTesting(db)

    expect(result.complete).toBe(false)
    expect(result.code).toBe('TAG_IDENTITY_INVALID')
    expect(snapshot()).toEqual(before)
    expect(marker()).toMatchObject({
      status: 'failed',
      errorCode: 'TAG_IDENTITY_INVALID',
      errorReason: expect.any(String),
      report: { rowsScanned: 1, logicalGroups: 0, collisionGroups: 0, survivors: 0 },
    })
    expect((marker() as { errorReason: string }).errorReason).not.toMatch(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u)
  })

  it('preserves report diagnostics when staging fails, without committing them', () => {
    seedCollision()
    const before = snapshot()
    __setTagIdentityMigrationFailureForTesting('after-staging')

    const result = runTagIdentityMigrationForTesting(db)
    const failed = marker() as { report: Record<string, number>; errorReason: string }

    expect(result.complete).toBe(false)
    expect(result.report).toMatchObject({ rowsScanned: 3, logicalGroups: 1, collisionGroups: 1, survivors: 1 })
    expect(failed).toMatchObject({
      report: { rowsScanned: 3, logicalGroups: 1, collisionGroups: 1, survivors: 1 },
      errorReason: 'injected migration failure at after-staging',
    })
    expect(snapshot()).toEqual(before)
  })

  it('preserves post-deletion diagnostics after transaction rollback', () => {
    seedCollision()
    const before = snapshot()
    __setTagIdentityMigrationFailureForTesting('after-tag-deletion')

    runTagIdentityMigrationForTesting(db)
    const failed = marker() as { report: Record<string, number> }

    expect(failed.report).toMatchObject({
      rowsScanned: 3,
      logicalGroups: 1,
      collisionGroups: 1,
      survivors: 1,
      associationsMoved: 1,
      associationsCollapsed: 2,
      tagRowsDeleted: 2,
      displayRowsChanged: 0,
      identityRowsChanged: 0,
      documentsVersioned: 0,
    })
    expect(snapshot()).toEqual(before)
  })

  it('preserves the executed document-version count after rollback', () => {
    seedCollision()
    const before = snapshot()
    __setTagIdentityMigrationFailureForTesting('after-document-version-update')

    runTagIdentityMigrationForTesting(db)
    const failed = marker() as { report: Record<string, number> }

    expect(failed.report).toMatchObject({
      associationsMoved: 1,
      associationsCollapsed: 2,
      tagRowsDeleted: 2,
      identityRowsChanged: 1,
      documentsVersioned: 1,
    })
    expect(snapshot()).toEqual(before)
  })

  it('preserves the full attempt report before the complete marker failure', () => {
    seedCollision()
    const before = snapshot()
    __setTagIdentityMigrationFailureForTesting('before-complete-marker')

    runTagIdentityMigrationForTesting(db)
    const failed = marker() as { status: string; report: Record<string, number> }

    expect(failed.status).toBe('failed')
    expect(failed.report).toEqual({
      rowsScanned: 3,
      logicalGroups: 1,
      collisionGroups: 1,
      survivors: 1,
      associationsMoved: 1,
      associationsCollapsed: 2,
      tagRowsDeleted: 2,
      displayRowsChanged: 0,
      identityRowsChanged: 1,
      documentsVersioned: 2,
    })
    expect(snapshot()).toEqual(before)
    expect(db.prepare("SELECT normalized_name FROM tags WHERE normalized_name LIKE '__nuvyn_t20_stage_%'").all()).toEqual([])
  })

  it('sanitizes and bounds an injected failure reason', () => {
    seedCollision()
    __setTagIdentityMigrationFailureForTesting({
      stage: 'after-staging',
      reason: `first line\nsecond\u0001line ${'x'.repeat(600)}`,
    })

    runTagIdentityMigrationForTesting(db)
    const reason = (marker() as { errorReason: string }).errorReason

    expect(reason.length).toBeLessThanOrEqual(256)
    expect(reason).not.toMatch(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u)
    expect(reason).toContain('first line second line')
  })

  it.each([
    ['non-string', 42],
    ['oversized', 'x'.repeat(257)],
    ['control character', 'safe\u0001reason'],
  ] as const)('fails closed for invalid failed-marker errorReason: %s', (_label, errorReason) => {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(TAG_IDENTITY_MIGRATION_KEY, JSON.stringify({
      contractVersion: 'tag-identity-v1',
      status: 'failed',
      attemptedAt: 1,
      report: {
        rowsScanned: 0,
        logicalGroups: 0,
        collisionGroups: 0,
        survivors: 0,
        associationsMoved: 0,
        associationsCollapsed: 0,
        tagRowsDeleted: 0,
        displayRowsChanged: 0,
        identityRowsChanged: 0,
        documentsVersioned: 0,
      },
      errorCode: 'TAG_IDENTITY_MIGRATION_FAILED',
      errorReason,
    }))
    seedCollision()

    const result = runTagIdentityMigrationForTesting(db)

    expect(result.complete).toBe(false)
    expect(result.code).toBe('TAG_IDENTITY_CONFLICT')
    expect(marker()).toMatchObject({ status: 'failed', errorReason })
    expect(db.prepare('SELECT COUNT(*) AS count FROM tags').get()).toEqual({ count: 3 })
  })

  it('is idempotent after a completed marker and performs no additional mutation', () => {
    seedCollision()
    expect(runTagIdentityMigrationForTesting(db).complete).toBe(true)
    const before = { ...snapshot(), marker: marker() }

    const second = runTagIdentityMigrationForTesting(db)

    expect(second.complete).toBe(true)
    expect(second.report).toEqual((before.marker as { report: unknown }).report)
    expect({ ...snapshot(), marker: marker() }).toEqual(before)
  })

  it('allows a failed startup migration to retry on the next startup initializer', async () => {
    seedCollision()
    __setTagIdentityMigrationFailureForTesting('after-staging')
    expect(runTagIdentityMigrationForTesting(db).complete).toBe(false)
    expect(marker()).toMatchObject({ status: 'failed' })

    __setTagIdentityMigrationFailureForTesting(null)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-t20-retry-'))
    try {
      const health = await initializeTagIdentityAndHealth(db, root, metadataReport())
      expect(health.state).toBe('healthy')
      expect(marker()).toMatchObject({ status: 'complete' })
      expect(db.prepare('SELECT id FROM tags').all()).toEqual([{ id: 3 }])
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    'after-staging',
    'after-association-repoint',
    'after-association-collapse',
    'after-tag-deletion',
    'after-tag-update',
    'after-document-version-update',
    'before-complete-marker',
  ] as const)('rolls back all data when failure is injected at %s', (stage) => {
    seedCollision()
    const before = snapshot()
    __setTagIdentityMigrationFailureForTesting(stage)

    const result = runTagIdentityMigrationForTesting(db)

    expect(result.complete).toBe(false)
    expect(result.code).toBe('TAG_IDENTITY_MIGRATION_FAILED')
    expect(snapshot()).toEqual(before)
    expect(marker()).toMatchObject({ status: 'failed', errorCode: 'TAG_IDENTITY_MIGRATION_FAILED' })
    expect((marker() as { status: string }).status).not.toBe('complete')
  })

  it('refreshes health read-only when the complete marker is present', async () => {
    seedCollision()
    expect(runTagIdentityMigrationForTesting(db).complete).toBe(true)
    const before = { ...snapshot(), marker: marker() }
    __setTagIdentityMigrationFailureForTesting('after-staging')

    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-t20-health-'))
    try {
      const health = await refreshTagIdentityHealth(db, root, metadataReport())
      expect(health.state).toBe('healthy')
      expect({ ...snapshot(), marker: marker() }).toEqual(before)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('keeps runtime health unavailable and the graph untouched for a failed marker', async () => {
    seedCollision()
    __setTagIdentityMigrationFailureForTesting('after-staging')
    expect(runTagIdentityMigrationForTesting(db).complete).toBe(false)
    __setTagIdentityMigrationFailureForTesting(null)
    const before = { ...snapshot(), marker: marker() }

    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-t20-health-'))
    try {
      const health = await refreshTagIdentityHealth(db, root, metadataReport())
      expect(health).toMatchObject({ state: 'unavailable', code: 'TAG_IDENTITY_MIGRATION_FAILED' })
      expect({ ...snapshot(), marker: marker() }).toEqual(before)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('keeps runtime health unavailable and the graph untouched for an absent marker', async () => {
    seedCollision()
    const before = snapshot()
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-t20-health-'))
    try {
      const health = await refreshTagIdentityHealth(db, root, metadataReport())
      expect(health).toMatchObject({ state: 'unavailable', code: 'TAG_IDENTITY_MIGRATION_REQUIRED' })
      expect(marker()).toBeNull()
      expect(snapshot()).toEqual(before)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('reports a malformed runtime marker as an identity conflict without repairing it', async () => {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(TAG_IDENTITY_MIGRATION_KEY, '{"status":"complete"}')
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-t20-health-'))
    try {
      const health = await refreshTagIdentityHealth(db, root, metadataReport())
      expect(health).toMatchObject({ state: 'unavailable', code: 'TAG_IDENTITY_CONFLICT' })
      expect((db.prepare('SELECT value FROM settings WHERE key = ?').get(TAG_IDENTITY_MIGRATION_KEY) as { value: string }).value)
        .toBe('{"status":"complete"}')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('runs the absent-marker migration during startup and then reports healthy', async () => {
    seedCollision()
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-t20-health-'))
    try {
      const health = await initializeTagIdentityAndHealth(db, root, metadataReport())
      expect(health.state).toBe('healthy')
      expect(marker()).toMatchObject({ status: 'complete' })
      expect(db.prepare('SELECT id FROM tags').all()).toEqual([{ id: 3 }])
      expect(getTagIdentityHealth(db).state).toBe('healthy')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('keeps management unavailable when live metadata migration is incomplete', async () => {
    expect(runTagIdentityMigrationForTesting(db).complete).toBe(true)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-t20-health-'))
    try {
      const health = await refreshTagIdentityHealth(db, root, { ...metadataReport(), failed: 1 })
      expect(health).toMatchObject({ state: 'unavailable', code: 'METADATA_MIGRATION_INCOMPLETE' })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('keeps management unavailable when a live Markdown path has no DB owner', async () => {
    expect(runTagIdentityMigrationForTesting(db).complete).toBe(true)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-t20-health-'))
    try {
      await fs.writeFile(path.join(root, 'note.md'), '# Note\n', 'utf8')
      const health = await refreshTagIdentityHealth(db, root, metadataReport())
      expect(health).toMatchObject({ state: 'unavailable', code: 'METADATA_OWNERSHIP_INCOMPLETE' })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('does not bless a completed marker after a canonical identity invariant drifts', async () => {
    expect(runTagIdentityMigrationForTesting(db).complete).toBe(true)
    db.prepare('INSERT INTO tags (id, name, normalized_name) VALUES (?, ?, ?)').run(3, 'Java', 'drifted')
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-t20-health-'))
    try {
      const health = await refreshTagIdentityHealth(db, root, metadataReport())
      expect(health).toMatchObject({ state: 'unavailable', code: 'TAG_IDENTITY_UNHEALTHY' })
      expect(marker()).toMatchObject({ status: 'complete' })
      expect(db.prepare('SELECT normalized_name FROM tags WHERE id = 3').get()).toEqual({ normalized_name: 'drifted' })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

// Migration runner tests. We use an in-memory DB so the test is
// hermetic and doesn't touch the on-disk nuvyn.db. The migration
// file `0001_ai_history.sql` must exist in `server/migrations/` by
// the time this test runs — Task 2 creates both files.
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { applyMigrations } from '../db'

function freshInMemoryDb(): Database.Database {
  return new Database(':memory:')
}

describe('applyMigrations', () => {
  it('applies all migrations on a fresh DB and records the latest version', () => {
    const db = freshInMemoryDb()
    applyMigrations(db)

    const version = (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version
    expect(version).toBeGreaterThanOrEqual(1)
  })

  it('creates the sessions, messages, and settings tables', () => {
    const db = freshInMemoryDb()
    applyMigrations(db)

    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[]).map((r) => r.name)
    expect(tables).toContain('sessions')
    expect(tables).toContain('messages')
    expect(tables).toContain('settings')
    expect(tables).toContain('documents')
    expect(tables).toContain('tags')
    expect(tables).toContain('document_tags')
    expect(tables).not.toContain('document_aliases')
    expect(tables).toContain('document_embeddings')
    expect(tables).toContain('metadata_migrations')
    expect(tables).toContain('schema_version')
  })

  it('creates the (session_id, created_at) index on messages', () => {
    const db = freshInMemoryDb()
    applyMigrations(db)

    const indexes = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='messages'"
    ).all() as { name: string }[]).map((r) => r.name)
    expect(indexes).toContain('idx_messages_session_created')
  })

  it('is idempotent — running twice does not error and does not change the version', () => {
    const db = freshInMemoryDb()
    applyMigrations(db)
    const v1 = (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version
    applyMigrations(db)
    const v2 = (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version
    expect(v2).toBe(v1)
  })
})

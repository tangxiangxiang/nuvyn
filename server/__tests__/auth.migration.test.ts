import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { applyMigrations } from '../db'

const openDatabases: Database.Database[] = []

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  openDatabases.push(db)
  return db
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    if (db.open) db.close()
  }
})

describe('authentication migration', () => {
  it('creates auth tables and indexes on a fresh database', () => {
    const db = freshDb()
    applyMigrations(db)

    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all() as Array<{ name: string }>).map((row) => row.name)
    expect(tables).toEqual(expect.arrayContaining(['users', 'auth_instance', 'auth_sessions']))

    const indexes = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'auth_sessions'",
    ).all() as Array<{ name: string }>).map((row) => row.name)
    expect(indexes).toEqual(expect.arrayContaining([
      'sqlite_autoindex_auth_sessions_1',
      'idx_auth_sessions_user_expiry',
      'idx_auth_sessions_expiry',
    ]))
    expect((db.pragma('foreign_keys') as Array<{ foreign_keys: number }>)[0]?.foreign_keys).toBe(1)
  })

  it('applies authentication migration over a v5 version marker without changing domain data', () => {
    const db = freshDb()
    db.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version (version) VALUES (5);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO settings (key, value) VALUES ('theme', 'dark');
      CREATE TABLE documents (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL UNIQUE
      );
      CREATE TABLE document_tags (
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY (document_id, tag_id)
      );
      CREATE TABLE document_embeddings (
        document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
        content_hash TEXT NOT NULL,
        model TEXT NOT NULL,
        embedding BLOB NOT NULL,
        indexed_at INTEGER NOT NULL
      );
      CREATE TABLE metadata_migrations (
        path TEXT PRIMARY KEY,
        document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
        original_path TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        source_hash TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL,
        frontmatter_backup TEXT NOT NULL DEFAULT '',
        cleaned_hash TEXT NOT NULL DEFAULT ''
      );
      INSERT INTO documents (id, path, title, summary, created_at, updated_at)
      VALUES ('legacy-document', 'inbox/legacy', 'Legacy', 'Existing row', 10, 20);
    `)

    applyMigrations(db)

    expect((db.prepare('SELECT version FROM schema_version').get() as { version: number }).version).toBe(35)
    expect(db.prepare("SELECT value FROM settings WHERE key = 'theme'").get()).toEqual({ value: 'dark' })
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'").get()).toEqual({ name: 'users' })
    expect(db.prepare('SELECT mood FROM documents WHERE id = ?').get('legacy-document')).toEqual({ mood: null })
  })

  it('is safe to apply repeatedly through the migration runner', () => {
    const db = freshDb()
    applyMigrations(db)
    const before = db.prepare('SELECT COUNT(*) AS count FROM sqlite_master WHERE type = \'table\'').get() as { count: number }
    applyMigrations(db)
    const after = db.prepare('SELECT COUNT(*) AS count FROM sqlite_master WHERE type = \'table\'').get() as { count: number }
    expect(after.count).toBe(before.count)
    expect((db.prepare('SELECT version FROM schema_version').get() as { version: number }).version).toBe(35)
  })

  it('enforces singleton, uniqueness, value, and foreign-key constraints', () => {
    const db = freshDb()
    applyMigrations(db)

    const now = 1_700_000_000_000
    db.prepare(`
      INSERT INTO users (username, username_normalized, password_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('admin', 'admin', 'test-hash', now, now)
    db.prepare(`
      INSERT INTO users (username, username_normalized, password_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('owner', 'owner', 'test-hash', now, now)

    expect(() => db.prepare(`
      INSERT INTO users (username, username_normalized, password_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('ADMIN', 'admin', 'test-hash', now, now)).toThrow()

    db.prepare('INSERT INTO auth_instance (id, owner_user_id, created_at, updated_at) VALUES (1, 1, ?, ?)').run(now, now)
    expect(() => db.prepare('INSERT INTO auth_instance (id, owner_user_id, created_at, updated_at) VALUES (1, 2, ?, ?)').run(now, now)).toThrow()
    expect(() => db.prepare('INSERT INTO auth_instance (id, owner_user_id, created_at, updated_at) VALUES (2, 2, ?, ?)').run(now, now)).toThrow()

    db.prepare(`
      INSERT INTO auth_sessions (user_id, token_hash, created_at, expires_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(1, 'hash-1', now, now + 1_000, now)
    expect(() => db.prepare(`
      INSERT INTO auth_sessions (user_id, token_hash, created_at, expires_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(1, 'hash-1', now, now + 1_000, now)).toThrow()
    expect(() => db.prepare(`
      INSERT INTO auth_sessions (user_id, token_hash, created_at, expires_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(1, 'hash-2', now, now + 1_000, now)).not.toThrow()
    expect(() => db.prepare(`
      INSERT INTO users (username, username_normalized, password_hash, disabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('disabled', 'disabled', 'test-hash', 2, now, now)).toThrow()
    expect(() => db.prepare(`
      INSERT INTO auth_sessions (user_id, token_hash, created_at, expires_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(999, 'hash-missing-user', now, now + 1_000, now)).toThrow()
  })
})

import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { applyMigrations, LATEST_SCHEMA_VERSION } from '../db'

type Fixture = {
  ownerId: number
  eventId: string
  taskId: string
  seriesId: string
  taskCiphertext: Buffer
  eventCiphertext: Buffer
  occurrenceCiphertext: Buffer
  skippedOccurrenceCiphertext: Buffer
}

function databaseAt(version: 49 | 50) {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applyMigrations(db, version)
  const now = 1_800_000_000_000
  const ownerId = Number(db.prepare(`INSERT INTO users
    (username, username_normalized, password_hash, disabled, created_at, updated_at)
    VALUES (?, ?, ?, 0, ?, ?)`).run(`owner-${version}`, `owner-${version}`, 'test-hash', now, now).lastInsertRowid)
  const eventId = randomUUID()
  const taskId = randomUUID()
  const seriesId = randomUUID()
  const eventCiphertext = Buffer.from('encrypted event payload')
  const taskCiphertext = Buffer.from('encrypted one-off todo payload including completion time')
  const occurrenceCiphertext = Buffer.from('encrypted completed recurring todo occurrence')
  const skippedOccurrenceCiphertext = Buffer.from('encrypted skipped recurring todo occurrence')

  db.prepare(`INSERT INTO diary_events
    (owner_user_id, id, start_date, end_date, recurrence, encrypted_fields, created_at, updated_at, version)
    VALUES (?, ?, '2026-11-21', '2026-11-21', 'none', ?, ?, ?, 1)`)
    .run(ownerId, eventId, eventCiphertext, now, now)
  db.prepare(`INSERT INTO diary_tasks
    (owner_user_id, id, due_date, encrypted_fields, created_at, updated_at, version)
    VALUES (?, ?, '2026-11-21', ?, ?, ?, 3)`)
    .run(ownerId, taskId, taskCiphertext, now, now)
  db.prepare(`INSERT INTO diary_task_series
    (owner_user_id, id, start_date, effective_from, until_date, encrypted_fields, created_at, updated_at, version)
    VALUES (?, ?, '2026-11-16', '2026-11-16', NULL, ?, ?, ?, 2)`)
    .run(ownerId, seriesId, Buffer.from('encrypted recurring todo rule'), now, now)
  db.prepare(`INSERT INTO diary_task_occurrences
    (owner_user_id, series_id, occurrence_date, encrypted_fields, version, updated_at)
    VALUES (?, ?, '2026-11-18', ?, 2, ?)`)
    .run(ownerId, seriesId, occurrenceCiphertext, now)
  db.prepare(`INSERT INTO diary_task_occurrences
    (owner_user_id, series_id, occurrence_date, encrypted_fields, version, updated_at)
    VALUES (?, ?, '2026-11-19', ?, 4, ?)`)
    .run(ownerId, seriesId, skippedOccurrenceCiphertext, now)

  if (version === 49) {
    db.prepare(`INSERT INTO diary_task_event_links (owner_user_id, task_id, event_id, created_at)
      VALUES (?, ?, ?, ?)`)
      .run(ownerId, taskId, eventId, now)
  } else {
    db.prepare(`INSERT INTO diary_task_event_links
      (owner_user_id, task_id, event_id, occurrence_date, created_at)
      VALUES (?, ?, ?, '2026-11-21', ?)`)
      .run(ownerId, taskId, eventId, now)
  }

  return { db, fixture: { ownerId, eventId, taskId, seriesId, taskCiphertext, eventCiphertext, occurrenceCiphertext, skippedOccurrenceCiphertext } satisfies Fixture }
}

describe('remove Diary Event-Todo association migration', () => {
  it.each([49, 50] as const)('preserves Events and Todo data when upgrading from schema %i', version => {
    const { db, fixture } = databaseAt(version)
    try {
      applyMigrations(db)

      expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: LATEST_SCHEMA_VERSION })
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'diary_task_event_links'").get()).toBeUndefined()
      expect(db.prepare('SELECT id, start_date, encrypted_fields, version FROM diary_events WHERE owner_user_id = ? AND id = ?')
        .get(fixture.ownerId, fixture.eventId)).toEqual({
          id: fixture.eventId, start_date: '2026-11-21', encrypted_fields: fixture.eventCiphertext, version: 1,
        })
      expect(db.prepare('SELECT id, due_date, encrypted_fields, version FROM diary_tasks WHERE owner_user_id = ? AND id = ?')
        .get(fixture.ownerId, fixture.taskId)).toEqual({
          id: fixture.taskId, due_date: '2026-11-21', encrypted_fields: fixture.taskCiphertext, version: 3,
        })
      expect(db.prepare('SELECT id FROM diary_task_series WHERE owner_user_id = ? AND id = ?')
        .get(fixture.ownerId, fixture.seriesId)).toEqual({ id: fixture.seriesId })
      expect(db.prepare(`SELECT occurrence_date, encrypted_fields, version FROM diary_task_occurrences
        WHERE owner_user_id = ? AND series_id = ? ORDER BY occurrence_date`)
        .all(fixture.ownerId, fixture.seriesId)).toEqual([
        { occurrence_date: '2026-11-18', encrypted_fields: fixture.occurrenceCiphertext, version: 2 },
        { occurrence_date: '2026-11-19', encrypted_fields: fixture.skippedOccurrenceCiphertext, version: 4 },
      ])
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_diary_task_event_links_%'").all()).toEqual([])
      expect(db.pragma('foreign_key_check')).toEqual([])

      applyMigrations(db)
      expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: LATEST_SCHEMA_VERSION })
      expect(db.pragma('foreign_key_check')).toEqual([])
    } finally {
      db.close()
    }
  })

  it('rolls back the association table drop if recording the migration version fails', () => {
    const { db } = databaseAt(50)
    try {
      db.exec(`CREATE TRIGGER fail_migration_version_update BEFORE DELETE ON schema_version
        BEGIN SELECT RAISE(ABORT, 'test migration rollback'); END`)

      expect(() => applyMigrations(db)).toThrow('test migration rollback')
      expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 50 })
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'diary_task_event_links'").get())
        .toEqual({ name: 'diary_task_event_links' })
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_diary_task_event_links_event_occurrence'").get())
        .toEqual({ name: 'idx_diary_task_event_links_event_occurrence' })
    } finally {
      db.close()
    }
  })

  it('starts fresh databases at the latest schema and is safe to initialize repeatedly', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    try {
      applyMigrations(db)
      applyMigrations(db)
      expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: LATEST_SCHEMA_VERSION })
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'diary_task_event_links'").get()).toBeUndefined()
      expect(db.pragma('foreign_key_check')).toEqual([])
    } finally {
      db.close()
    }
  })
})

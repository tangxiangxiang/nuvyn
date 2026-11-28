import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { applyMigrations, LATEST_SCHEMA_VERSION } from '../db'

describe('Diary Life Period migration', () => {
  it('preserves existing encrypted Events and permits a nullable end date', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    try {
      applyMigrations(db, 56)
      const now = 1_800_000_000_000
      const ownerId = Number(db.prepare(`INSERT INTO users
        (username, username_normalized, password_hash, disabled, created_at, updated_at)
        VALUES ('period-migration-owner', 'period-migration-owner', 'test-hash', 0, ?, ?)`)
        .run(now, now).lastInsertRowid)
      const eventId = randomUUID()
      const ciphertext = Buffer.from('existing encrypted event payload')
      db.prepare(`INSERT INTO diary_events
        (owner_user_id, id, start_date, end_date, recurrence, encrypted_fields, created_at, updated_at, version)
        VALUES (?, ?, '2024-02-29', '2024-03-02', 'none', ?, ?, ?, 4)`)
        .run(ownerId, eventId, ciphertext, now, now)

      applyMigrations(db)

      expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: LATEST_SCHEMA_VERSION })
      expect(db.prepare(`SELECT owner_user_id, id, start_date, end_date, recurrence, encrypted_fields, created_at, updated_at, version
        FROM diary_events WHERE owner_user_id = ? AND id = ?`).get(ownerId, eventId)).toEqual({
        owner_user_id: ownerId,
        id: eventId,
        start_date: '2024-02-29',
        end_date: '2024-03-02',
        recurrence: 'none',
        encrypted_fields: ciphertext,
        created_at: now,
        updated_at: now,
        version: 4,
      })
      expect(db.pragma('foreign_key_check')).toEqual([])

      db.prepare(`INSERT INTO diary_events
        (owner_user_id, id, start_date, end_date, recurrence, encrypted_fields, created_at, updated_at, version)
        VALUES (?, ?, '2024-02-29', NULL, 'none', ?, ?, ?, 1)`)
        .run(ownerId, randomUUID(), Buffer.from('new encrypted period'), now, now)
    } finally {
      db.close()
    }
  })
})

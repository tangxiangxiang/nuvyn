import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { applyMigrations, LATEST_SCHEMA_VERSION } from '../db'

function createOwnerAndEvent(db: Database.Database, endDate: string | null = null) {
  const now = 1_800_000_000_000
  const username = `period-migration-${randomUUID()}`
  const ownerId = Number(db.prepare(`INSERT INTO users
    (username, username_normalized, password_hash, disabled, created_at, updated_at)
    VALUES (?, ?, 'test-hash', 0, ?, ?)`)
    .run(username, username, now, now).lastInsertRowid)
  const eventId = randomUUID()
  const ciphertext = Buffer.from('existing encrypted event payload')
  db.prepare(`INSERT INTO diary_events
    (owner_user_id, id, start_date, end_date, recurrence, encrypted_fields, created_at, updated_at, version)
    VALUES (?, ?, '2024-02-29', ?, 'none', ?, ?, ?, 4)`)
    .run(ownerId, eventId, endDate, ciphertext, now, now)
  return { ownerId, eventId, ciphertext, now }
}

describe('Diary Life Period migration', () => {
  it('preserves existing encrypted Events from v56 and permits a nullable end date through v58', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    try {
      applyMigrations(db, 56)
      const fixture = createOwnerAndEvent(db, '2024-03-02')
      const dayAttachmentId = randomUUID()
      const diaryAttachmentMetadata = Buffer.from('existing encrypted Diary attachment metadata')
      db.prepare(`INSERT INTO diary_day_attachments
        (id, owner_user_id, day_date, encrypted_metadata, status, display_order, created_at)
        VALUES (?, ?, '2024-02-29', ?, 'attached', 0, ?)`)
        .run(dayAttachmentId, fixture.ownerId, diaryAttachmentMetadata, fixture.now)

      applyMigrations(db)

      expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: LATEST_SCHEMA_VERSION })
      expect(db.prepare(`SELECT owner_user_id, id, start_date, end_date, recurrence, encrypted_fields, created_at, updated_at, version
        FROM diary_events WHERE owner_user_id = ? AND id = ?`).get(fixture.ownerId, fixture.eventId)).toEqual({
        owner_user_id: fixture.ownerId,
        id: fixture.eventId,
        start_date: '2024-02-29',
        end_date: '2024-03-02',
        recurrence: 'none',
        encrypted_fields: fixture.ciphertext,
        created_at: fixture.now,
        updated_at: fixture.now,
        version: 4,
      })
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'diary_event_attachments'").get()).toBeUndefined()
      expect(db.prepare('SELECT owner_user_id, day_date, encrypted_metadata, status FROM diary_day_attachments WHERE id = ?').get(dayAttachmentId)).toEqual({
        owner_user_id: fixture.ownerId,
        day_date: '2024-02-29',
        encrypted_metadata: diaryAttachmentMetadata,
        status: 'attached',
      })
      expect(db.pragma('foreign_key_check')).toEqual([])

      db.prepare(`INSERT INTO diary_events
        (owner_user_id, id, start_date, end_date, recurrence, encrypted_fields, created_at, updated_at, version)
        VALUES (?, ?, '2024-02-29', NULL, 'none', ?, ?, ?, 1)`)
        .run(fixture.ownerId, randomUUID(), Buffer.from('new encrypted period'), fixture.now, fixture.now)
    } finally {
      db.close()
    }
  })

  it('upgrades an empty v57 Event attachment table to v58', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    try {
      applyMigrations(db, 57)
      expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 57 })
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'diary_event_attachments'").get()).toBeDefined()

      applyMigrations(db)

      expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 58 })
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'diary_event_attachments'").get()).toBeUndefined()
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE name IN (
        'idx_diary_event_attachments_event', 'idx_diary_event_attachments_expiry',
        'idx_diary_event_attachments_stage_session', 'diary_events_mark_attachments_deleting'
      )`).all()).toEqual([])
      expect(db.pragma('foreign_key_check')).toEqual([])
    } finally {
      db.close()
    }
  })

  it.each(['staged', 'attached', 'deleting'] as const)(
    'blocks v57 to v58 when a %s Event attachment record needs explicit cleanup',
    status => {
      const db = new Database(':memory:')
      db.pragma('foreign_keys = ON')
      try {
        applyMigrations(db, 57)
        const fixture = createOwnerAndEvent(db)
        const stageId = randomUUID()
        const attachmentId = randomUUID()
        const eventId = status === 'attached' ? fixture.eventId : null
        const stageEventId = status === 'staged' ? fixture.eventId : null
        const expiresAt = status === 'staged' ? fixture.now + 60_000 : null
        const requestKey = status === 'staged' ? randomUUID() : null
        const sessionId = status === 'staged' ? stageId : null
        db.prepare(`INSERT INTO diary_event_attachments
          (id, owner_user_id, event_id, stage_event_id, encrypted_metadata, status,
            display_order, created_at, expires_at, request_key, stage_session_id)
          VALUES (?, ?, ?, ?, X'00', ?, 0, ?, ?, ?, ?)`)
          .run(attachmentId, fixture.ownerId, eventId, stageEventId, status, fixture.now, expiresAt, requestKey, sessionId)

        expect(() => applyMigrations(db)).toThrow(/Cannot remove Diary Event attachments while records exist/)
        expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 57 })
        expect(db.prepare('SELECT id, status FROM diary_event_attachments WHERE id = ?').get(attachmentId)).toEqual({ id: attachmentId, status })
        expect(db.prepare('SELECT encrypted_fields FROM diary_events WHERE id = ?').get(fixture.eventId)).toEqual({ encrypted_fields: fixture.ciphertext })
        expect(db.pragma('foreign_key_check')).toEqual([])

        // This models the operator completing export and cleanup in v57;
        // the failed migration left the database intact and can be retried.
        db.prepare('DELETE FROM diary_event_attachments WHERE id = ?').run(attachmentId)
        applyMigrations(db)
        expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 58 })
        expect(db.pragma('foreign_key_check')).toEqual([])
      } finally {
        db.close()
      }
    },
  )
})

import type { Database } from 'better-sqlite3'
import type { DiaryBodyOperation } from './diaryAccess/service.js'
import { parseDay, parseEvent, type DiaryDay, type DiaryEvent, type DayFields, type EventFields } from '../shared/diaryLife.js'
import { MAX_DIARY_DAY_ATTACHMENTS } from '../shared/diaryAttachments.js'
import { DiaryAttachmentError, listDiaryDayAttachments } from './diaryAttachments/service.js'

export class DiaryConflict extends Error {}
type Row = { id: string; date: string; start_date: string; end_date: string; recurrence: string; encrypted_fields: Buffer; version: number; created_at: number; updated_at: number }
export function diaryLifeStore(db: Database, owner: number, operation: DiaryBodyOperation) {
  const crypto = operation.life
  if (!crypto) throw new Error('Diary crypto unavailable')
  const identity = (kind: string, id: string, version: number) => JSON.stringify([owner, kind, id, version])
  const deletedVersion = (kind: string, id: string) => (db.prepare('SELECT version FROM diary_deleted_records WHERE owner_user_id = ? AND kind = ? AND id = ?').get(owner, kind, id) as { version: number } | undefined)?.version ?? 0
  function day(row: Row): DiaryDay {
    const fields = parseDay(crypto!.decrypt(row.encrypted_fields, identity('day', row.date, row.version)))
    if (!fields) throw new Error('Invalid Diary day')
    return { ...fields, date: row.date, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at }
  }
  function event(row: Row): DiaryEvent {
    const fields = parseEvent(crypto!.decrypt(row.encrypted_fields, identity('event', row.id, row.version)))
    if (!fields || fields.startDate !== row.start_date || fields.endDate !== row.end_date || fields.recurrence !== row.recurrence) throw new Error('Invalid Diary event')
    return { ...fields, id: row.id, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at }
  }
  return {
    dayVersion(date: string) { return this.getDay(date)?.version ?? deletedVersion('day', date) },
    getDay(date: string) {
      const row = db.prepare('SELECT * FROM diary_days WHERE owner_user_id = ? AND date = ?').get(owner, date) as Row | undefined
      return row ? day(row) : null
    },
    days(start: string, end: string) {
      return (db.prepare('SELECT * FROM diary_days WHERE owner_user_id = ? AND date BETWEEN ? AND ? ORDER BY date').all(owner, start, end) as Row[]).map(row => ({
        ...day(row),
        hasAttachments: (db.prepare(`SELECT 1 AS found FROM diary_day_attachments
          WHERE owner_user_id = ? AND day_date = ? AND status = 'attached' LIMIT 1`).get(owner, row.date) !== undefined),
      }))
    },
    dayAttachments(date: string) {
      return listDiaryDayAttachments(db, owner, date, operation)
    },
    putDay(date: string, fields: DayFields, expected: number, requestedAttachmentIds?: string[]) {
      operation.assertCurrent()
      const now = Date.now()
      const payload = crypto.encrypt(fields, identity('day', date, expected + 1))
      db.transaction(() => {
        const row = db.prepare('SELECT version FROM diary_days WHERE owner_user_id = ? AND date = ?').get(owner, date) as { version: number } | undefined
        if ((row?.version ?? deletedVersion('day', date)) !== expected) throw new DiaryConflict()
        const currentIds = (db.prepare(`SELECT id FROM diary_day_attachments
          WHERE owner_user_id = ? AND day_date = ? AND status = 'attached' ORDER BY display_order, created_at, id`).all(owner, date) as Array<{ id: string }>).map(item => item.id)
        const attachmentIds = requestedAttachmentIds ?? currentIds
        if (attachmentIds.length > MAX_DIARY_DAY_ATTACHMENTS || new Set(attachmentIds).size !== attachmentIds.length) throw new DiaryAttachmentError('invalid', 400)
        const wanted = new Set(attachmentIds)
        for (const id of attachmentIds) {
          const attachment = db.prepare(`SELECT day_date, status FROM diary_day_attachments
            WHERE owner_user_id = ? AND id = ?`).get(owner, id) as { day_date: string; status: string } | undefined
          if (!attachment || attachment.day_date !== date || !['attached', 'staged'].includes(attachment.status)) throw new DiaryAttachmentError('conflict', 409)
        }
        for (const id of currentIds) {
          if (!wanted.has(id)) db.prepare("UPDATE diary_day_attachments SET status = 'deleting', expires_at = NULL WHERE owner_user_id = ? AND id = ? AND status = 'attached'").run(owner, id)
        }
        attachmentIds.forEach((id, index) => {
          db.prepare(`UPDATE diary_day_attachments SET status = 'attached', display_order = ?, expires_at = NULL
            WHERE owner_user_id = ? AND id = ? AND day_date = ? AND status IN ('staged', 'attached')`)
            .run(index, owner, id, date)
        })
        db.prepare(`INSERT INTO diary_days VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(owner_user_id, date)
          DO UPDATE SET encrypted_fields = excluded.encrypted_fields, updated_at = excluded.updated_at, version = excluded.version`)
          .run(owner, date, payload, now, now, expected + 1)
        db.prepare("DELETE FROM diary_deleted_records WHERE owner_user_id = ? AND kind = 'day' AND id = ?").run(owner, date)
      })()
      return this.getDay(date)!
    },
    getEvent(id: string) {
      const row = db.prepare('SELECT * FROM diary_events WHERE owner_user_id = ? AND id = ?').get(owner, id) as Row | undefined
      return row ? event(row) : null
    },
    events(start: string, end: string, offset = 0) {
      const rows = db.prepare(`SELECT * FROM diary_events WHERE owner_user_id = ?
        AND ((start_date <= ? AND end_date >= ?) OR recurrence = 'yearly') ORDER BY id LIMIT 201 OFFSET ?`)
        .all(owner, end, start, offset) as Row[]
      return { items: rows.slice(0, 200).map(event), next: rows.length > 200 ? offset + 200 : null }
    },
    allEvents(offset = 0) {
      const rows = db.prepare(`SELECT * FROM diary_events WHERE owner_user_id = ?
        ORDER BY start_date DESC, id DESC LIMIT 201 OFFSET ?`)
        .all(owner, offset) as Row[]
      return { items: rows.slice(0, 200).map(event), next: rows.length > 200 ? offset + 200 : null }
    },
    putEvent(id: string, fields: EventFields, expected: number) {
      operation.assertCurrent()
      const now = Date.now()
      const payload = crypto.encrypt(fields, identity('event', id, expected + 1))
      db.transaction(() => {
        const row = db.prepare('SELECT version FROM diary_events WHERE owner_user_id = ? AND id = ?').get(owner, id) as { version: number } | undefined
        if ((row?.version ?? deletedVersion('event', id)) !== expected) throw new DiaryConflict()
        db.prepare(`INSERT INTO diary_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(owner_user_id, id) DO UPDATE SET start_date = excluded.start_date, end_date = excluded.end_date,
          recurrence = excluded.recurrence, encrypted_fields = excluded.encrypted_fields,
          updated_at = excluded.updated_at, version = excluded.version`)
          .run(owner, id, fields.startDate, fields.endDate, fields.recurrence, payload, now, now, expected + 1)
        db.prepare("DELETE FROM diary_deleted_records WHERE owner_user_id = ? AND kind = 'event' AND id = ?").run(owner, id)
      })()
      return this.getEvent(id)!
    },
    remove(kind: 'day' | 'event', id: string, version: number) {
      operation.assertCurrent()
      const table = kind === 'day' ? 'diary_days' : 'diary_events'
      const column = kind === 'day' ? 'date' : 'id'
      db.transaction(() => {
        if (kind === 'day') {
          db.prepare(`UPDATE diary_day_attachments SET status = 'deleting', expires_at = NULL
            WHERE owner_user_id = ? AND day_date = ? AND status IN ('staged', 'attached')`).run(owner, id)
        }
        const result = db.prepare(`DELETE FROM ${table} WHERE owner_user_id = ? AND ${column} = ? AND version = ?`).run(owner, id, version)
        if (!result.changes) throw new DiaryConflict()
        db.prepare('INSERT INTO diary_deleted_records VALUES (?, ?, ?, ?) ON CONFLICT(owner_user_id, kind, id) DO UPDATE SET version = excluded.version').run(owner, kind, id, version + 1)
      })()
    },
  }
}

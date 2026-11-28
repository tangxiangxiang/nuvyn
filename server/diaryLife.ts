import type { Database } from 'better-sqlite3'
import type { DiaryBodyOperation } from './diaryAccess/service.js'
import { displayEventTitle, nextOccurrence, occursOn, parseDay, parseEvent, parseLegacySchedule, type DiaryDay, type DiaryEvent, type DiaryEventSearchItem, type DiaryEventSearchPage, type DiarySearchItem, type DiarySearchPage, type DayFields, type EventFields } from '../shared/diaryLife.js'
import { formatLunarRule } from '../shared/lunarCalendar.js'
import { isDiaryAttachmentMimeType, MAX_DIARY_DAY_ATTACHMENTS } from '../shared/diaryAttachments.js'
import { DiaryAttachmentError, listDiaryDayAttachments } from './diaryAttachments/service.js'
import { decodeDiarySearchCursor, diarySearchSnippet, encodeDiarySearchCursor, type DiarySearchCursor } from './diarySearch.js'

export class DiaryConflict extends Error {}
type Row = { id: string; date: string; start_date: string; end_date: string | null; recurrence: string; encrypted_fields: Buffer; version: number; created_at: number; updated_at: number }
const SEARCH_SCAN_LIMIT = 1000
const EVENT_TYPE_LABEL: Record<EventFields['type'], string> = {
  birthday: '生日',
  anniversary: '纪念日',
  milestone: '人生时刻',
  period: '人生阶段',
}

function eventSearchTargetDate(value: DiaryEvent, today: string): string | null {
  if (value.type === 'period') return value.startDate
  if (value.recurrence === 'none') return value.startDate
  if (occursOn(value, today)) return today
  return nextOccurrence(value, today)
}

function eventSearchSubtitle(value: DiaryEvent, targetDate: string | null): string {
  const label = value.legacySchedule ? '旧重要日程' : EVENT_TYPE_LABEL[value.type]
  if (!targetDate) return `${label} · 暂无可定位日期`
  const lunar = value.dateRule?.calendar === 'chinese' ? formatLunarRule(value.dateRule) : null
  return [label, lunar, targetDate].filter(Boolean).join(' · ')
}
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
    const plaintext = crypto!.decrypt(row.encrypted_fields, identity('event', row.id, row.version))
    const fields = parseEvent(plaintext) ?? parseLegacySchedule(plaintext)
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
    async searchDays(query: string, limit: number, cursor: string | null, signal?: AbortSignal): Promise<DiarySearchPage> {
      operation.assertCurrent()
      if (signal?.aborted) return { items: [], nextCursor: null }
      const normalizedQuery = query.toLowerCase()
      const exactDate = /^\d{4}-\d{2}-\d{2}$/.test(query) ? query : null
      const statement = db.prepare(`SELECT date, encrypted_fields, version FROM diary_days WHERE owner_user_id = ? ${cursor ? 'AND date < ?' : ''} ORDER BY date DESC`)
      const rows = (cursor ? statement.iterate(owner, cursor) : statement.iterate(owner)) as Iterable<{ date: string; encrypted_fields: Buffer; version: number }>
      const items: DiarySearchItem[] = []
      let scanned = 0
      let lastReturnedDate: string | null = null
      for (const row of rows) {
        operation.assertCurrent()
        if (signal?.aborted) return { items: [], nextCursor: null }
        const fields = parseDay(crypto!.decrypt(row.encrypted_fields, identity('day', row.date, row.version)))
        if (!fields) throw new Error('Invalid Diary day')
        const entryIndex = fields.entries.findIndex(entry => entry.toLowerCase().includes(normalizedQuery))
        if (entryIndex >= 0) {
          const text = fields.entries[entryIndex]!.replace(/\s+/g, ' ').trim()
          const matchAt = text.toLowerCase().indexOf(normalizedQuery)
          const contextBefore = Math.min(56, Math.max(0, 160 - normalizedQuery.length))
          const start = Math.max(0, matchAt - contextBefore)
          const end = Math.min(text.length, Math.max(start + 160, matchAt + normalizedQuery.length))
          const snippet = `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
          items.push({
            date: row.date,
            ...(fields.entryIds?.[entryIndex] ? { entryId: fields.entryIds[entryIndex] } : { entryIndex }),
            snippet,
            match: 'entry',
          })
        } else if (exactDate && row.date === exactDate) {
          items.push({ date: row.date, snippet: '', match: 'date' })
        }
        scanned += 1
        if (items.length > limit) {
          items.pop()
          lastReturnedDate = items.at(-1)?.date ?? null
          break
        }
        if (scanned % 100 === 0) {
          await new Promise<void>(resolve => setImmediate(resolve))
          operation.assertCurrent()
          if (signal?.aborted) return { items: [], nextCursor: null }
        }
      }
      return { items, nextCursor: lastReturnedDate }
    },
    async searchEvents(query: string, limit: number, cursor: string | null, today: string, signal?: AbortSignal): Promise<DiaryEventSearchPage> {
      operation.assertCurrent()
      if (signal?.aborted) return { items: [], nextCursor: null }
      const normalizedQuery = query.trim().toLowerCase()
      let phase: DiarySearchCursor['phase'] = 'title'
      let afterId: string | null = null
      if (cursor !== null) {
        const parsed = decodeDiarySearchCursor(db, cursor, { owner, scope: 'events', query })
        phase = parsed.phase
        afterId = parsed.afterId
      }
      const items: DiaryEventSearchItem[] = []
      let scanned = 0
      let exhausted = false

      while (items.length < limit && scanned < SEARCH_SCAN_LIMIT && !exhausted) {
        const batchLimit = Math.min(100, SEARCH_SCAN_LIMIT - scanned)
        const rows = (afterId === null
          ? db.prepare('SELECT * FROM diary_events WHERE owner_user_id = ? ORDER BY id DESC LIMIT ?').all(owner, batchLimit)
          : db.prepare('SELECT * FROM diary_events WHERE owner_user_id = ? AND id < ? ORDER BY id DESC LIMIT ?').all(owner, afterId, batchLimit)) as Row[]

        if (!rows.length) {
          if (phase === 'title') {
            phase = 'description'
            afterId = null
            continue
          }
          exhausted = true
          break
        }

        for (const row of rows) {
          operation.assertCurrent()
          if (signal?.aborted) return { items: [], nextCursor: null }
          const value = event(row)
          const targetDate = eventSearchTargetDate(value, today)
          const title = displayEventTitle(value, targetDate)
          const titleMatch = title.toLowerCase().includes(normalizedQuery) || value.title.toLowerCase().includes(normalizedQuery)
          const descriptionMatch = value.description.toLowerCase().includes(normalizedQuery)
          const match = phase === 'title' ? titleMatch : !titleMatch && descriptionMatch
          afterId = row.id
          scanned += 1
          if (match) {
            items.push({
              id: value.id,
              title,
              emoji: value.emoji,
              type: value.type,
              targetDate,
              subtitle: eventSearchSubtitle(value, targetDate),
              snippet: phase === 'description' ? diarySearchSnippet(value.description, query) : '',
              match: phase,
            })
            if (items.length >= limit) break
          }
          if (scanned % 100 === 0) {
            await new Promise<void>(resolve => setImmediate(resolve))
            operation.assertCurrent()
            if (signal?.aborted) return { items: [], nextCursor: null }
          }
        }

        if (items.length >= limit) break
        if (rows.length < batchLimit || scanned >= SEARCH_SCAN_LIMIT) {
          if (phase === 'title' && rows.length < batchLimit) {
            phase = 'description'
            afterId = null
          } else if (phase === 'description' && rows.length < batchLimit) {
            exhausted = true
          }
        }
      }

      const nextCursor = exhausted ? null : encodeDiarySearchCursor(db, {
        v: 1,
        owner,
        scope: 'events',
        query,
        phase,
        afterId,
      })
      return { items, nextCursor }
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
        const placedImageIds = new Set((fields.imageGroups ?? []).flatMap(group => group.attachmentIds))
        if ([...placedImageIds].some(id => !wanted.has(id))) throw new DiaryAttachmentError('conflict', 409)
        for (const id of attachmentIds) {
          const attachment = db.prepare(`SELECT day_date, status, encrypted_metadata FROM diary_day_attachments
            WHERE owner_user_id = ? AND id = ?`).get(owner, id) as { day_date: string; status: string; encrypted_metadata: Buffer } | undefined
          if (!attachment || attachment.day_date !== date || !['attached', 'staged'].includes(attachment.status)) throw new DiaryAttachmentError('conflict', 409)
          if (placedImageIds.has(id)) {
            const metadata = operation.attachments!.decryptMetadata(attachment.encrypted_metadata, { owner, date, id })
            const mimeType = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
              ? (metadata as Record<string, unknown>).mimeType
              : null
            if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
              || !isDiaryAttachmentMimeType(mimeType) || !mimeType.startsWith('image/')) {
              throw new DiaryAttachmentError('invalid', 400)
            }
          }
        }
        for (const id of currentIds) {
          if (!wanted.has(id)) db.prepare("UPDATE diary_day_attachments SET status = 'deleting', expires_at = NULL, stage_session_id = NULL WHERE owner_user_id = ? AND id = ? AND status = 'attached'").run(owner, id)
        }
        attachmentIds.forEach((id, index) => {
          db.prepare(`UPDATE diary_day_attachments SET status = 'attached', display_order = ?, expires_at = NULL, stage_session_id = NULL
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
        AND ((start_date <= ? AND end_date >= ?) OR recurrence = 'yearly' OR start_date BETWEEN ? AND ?)
        ORDER BY id LIMIT 201 OFFSET ?`)
        .all(owner, end, start, start, end, offset) as Row[]
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
      db.transaction(() => {
        const row = db.prepare('SELECT version FROM diary_events WHERE owner_user_id = ? AND id = ?').get(owner, id) as { version: number } | undefined
        if ((row?.version ?? deletedVersion('event', id)) !== expected) throw new DiaryConflict()
        const payload = crypto.encrypt(fields, identity('event', id, expected + 1))
        db.prepare(`INSERT INTO diary_events (owner_user_id, id, start_date, end_date, recurrence, encrypted_fields, created_at, updated_at, version)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          db.prepare(`UPDATE diary_day_attachments SET status = 'deleting', expires_at = NULL, stage_session_id = NULL
            WHERE owner_user_id = ? AND day_date = ? AND status IN ('staged', 'attached')`).run(owner, id)
        }
        const result = db.prepare(`DELETE FROM ${table} WHERE owner_user_id = ? AND ${column} = ? AND version = ?`).run(owner, id, version)
        if (!result.changes) throw new DiaryConflict()
        db.prepare('INSERT INTO diary_deleted_records VALUES (?, ?, ?, ?) ON CONFLICT(owner_user_id, kind, id) DO UPDATE SET version = excluded.version').run(owner, kind, id, version + 1)
      })()
    },
  }
}

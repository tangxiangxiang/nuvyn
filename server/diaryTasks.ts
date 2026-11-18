import type { Database } from 'better-sqlite3'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { Temporal } from '@js-temporal/polyfill'
import type { DiaryBodyOperation } from './diaryAccess/service.js'
import { civilDate } from '../shared/diaryLife.js'
import { parseTaskFields, parseTaskOccurrenceState, parseTaskSeriesFields, type DiaryRecurringTaskOccurrence, type DiaryTask, type DiaryTaskItemPage, type DiaryTaskListItem, type DiaryTaskPage, type DiaryTaskSeries, type OneOffTaskFields, type TaskOccurrenceState, type TaskSeriesFields } from '../shared/diaryTasks.js'
import { taskRecurrenceDates, taskRecurrenceOccursOn } from '../shared/diaryTaskRecurrence.js'
import { DiaryConflict } from './diaryLife.js'

export class DiaryTaskNotFound extends Error {}
export class DiaryTaskCursorError extends Error {}
export class DiaryTaskListChanged extends Error {}
export class DiaryTaskExpansionLimit extends Error {}
export class DiaryTaskRecurrenceError extends Error {}
export class DiaryTaskHistoryProtectedError extends Error {}

const PAGE_SIZE = 200
const MAX_CURSOR_LENGTH = 1024
const MAX_REVISION = Number.MAX_SAFE_INTEGER
const TASK_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/

type TaskListQuery =
  | { type: 'list'; completed?: boolean }
  | { type: 'range'; start: string; end: string }

type TaskCursorPayload = {
  v: 1
  owner: number
  revision: number
  dueDate: string | null
  id: string
  query: TaskListQuery
}

type TaskRow = {
  id: string
  due_date: string | null
  encrypted_fields: Buffer
  version: number
  created_at: number
  updated_at: number
}

type TaskSeriesRow = {
  id: string
  start_date: string
  effective_from: string
  until_date: string | null
  encrypted_fields: Buffer
  version: number
  created_at: number
  updated_at: number
}

type TaskOccurrenceRow = {
  series_id: string
  occurrence_date: string
  encrypted_fields: Buffer
  version: number
  updated_at: number
}

type TaskItemQuery =
  | { type: 'list'; start: string; end: string; status?: 'open' | 'completed' }
  | { type: 'range'; start: string; end: string }

type TaskItemCursorPayload = {
  v: 1
  owner: number
  revision: number
  dueDate: string | null
  id: string
  query: TaskItemQuery
}

export function diaryTaskStore(db: Database, owner: number, operation: DiaryBodyOperation) {
  const crypto = operation.life
  if (!crypto) throw new Error('Diary crypto unavailable')
  const identity = (id: string, version: number) => JSON.stringify([owner, 'task', id, version])
  const seriesIdentity = (id: string, version: number) => JSON.stringify([owner, 'task-series', id, version])
  const occurrenceIdentity = (seriesId: string, date: string, version: number) => JSON.stringify([owner, 'task-occurrence', seriesId, date, version])
  const deletedVersion = (id: string) => (db.prepare(
    'SELECT version FROM diary_task_deleted_records WHERE owner_user_id = ? AND id = ?',
  ).get(owner, id) as { version: number } | undefined)?.version ?? 0
  const deletedSeriesVersion = (id: string) => (db.prepare(
    'SELECT version FROM diary_task_series_deleted_records WHERE owner_user_id = ? AND id = ?',
  ).get(owner, id) as { version: number } | undefined)?.version ?? 0

  function task(row: TaskRow): DiaryTask {
    const decoded = crypto!.decrypt(row.encrypted_fields, identity(row.id, row.version))
    const fields = parseTaskFields(decoded)
    const completedAt = decoded && typeof decoded === 'object' && !Array.isArray(decoded)
      ? (decoded as Record<string, unknown>).completedAt
      : undefined
    if (!fields || fields.dueDate !== row.due_date
      || !(completedAt === null || (Number.isSafeInteger(completedAt) && (completedAt as number) >= 0))) {
      throw new Error('Invalid Diary task')
    }
    return {
      ...fields,
      id: row.id,
      completedAt: completedAt as number | null,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  function readTaskRow(id: string): TaskRow | undefined {
    return db.prepare('SELECT * FROM diary_tasks WHERE owner_user_id = ? AND id = ?').get(owner, id) as TaskRow | undefined
  }

  function readSeriesRow(id: string): TaskSeriesRow | undefined {
    return db.prepare('SELECT * FROM diary_task_series WHERE owner_user_id = ? AND id = ?').get(owner, id) as TaskSeriesRow | undefined
  }

  function readOccurrenceRow(seriesId: string, date: string): TaskOccurrenceRow | undefined {
    return db.prepare(`SELECT * FROM diary_task_occurrences
      WHERE owner_user_id = ? AND series_id = ? AND occurrence_date = ?`).get(owner, seriesId, date) as TaskOccurrenceRow | undefined
  }

  function series(row: TaskSeriesRow): DiaryTaskSeries {
    const decoded = crypto!.decrypt(row.encrypted_fields, seriesIdentity(row.id, row.version))
    const fields = parseTaskSeriesFields(decoded)
    if (!fields || fields.recurrence.startDate !== row.start_date
      || fields.recurrence.untilDate !== row.until_date
      || row.effective_from < row.start_date
      || (row.until_date !== null && row.until_date < row.effective_from)) throw new Error('Invalid Diary task series')
    return { ...fields, id: row.id, effectiveFrom: row.effective_from, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at }
  }

  function occurrenceState(row: TaskOccurrenceRow | undefined, seriesId: string, date: string): { state: TaskOccurrenceState; version: number; updatedAt: number } {
    if (!row) return { state: { status: 'pending', completedAt: null }, version: 0, updatedAt: 0 }
    const decoded = crypto!.decrypt(row.encrypted_fields, occurrenceIdentity(seriesId, date, row.version))
    const state = parseTaskOccurrenceState(decoded)
    if (!state) throw new Error('Invalid Diary task occurrence')
    return { state, version: row.version, updatedAt: row.updated_at }
  }

  function recurringOccurrence(row: TaskSeriesRow, date: string, occurrenceRow?: TaskOccurrenceRow): DiaryRecurringTaskOccurrence {
    const currentSeries = series(row)
    const currentOccurrence = occurrenceState(occurrenceRow, row.id, date)
    const id = `${row.id}:${date}`
    return {
      kind: 'recurring',
      id,
      seriesId: row.id,
      occurrenceDate: date,
      title: currentSeries.title,
      description: currentSeries.description,
      dueDate: date,
      dueTime: currentSeries.dueTime,
      effectiveFrom: row.effective_from,
      recurrence: currentSeries.recurrence,
      seriesVersion: row.version,
      occurrenceVersion: currentOccurrence.version,
      version: currentOccurrence.version,
      completedAt: currentOccurrence.state.completedAt,
      skipped: currentOccurrence.state.status === 'skipped',
      createdAt: row.created_at,
      updatedAt: currentOccurrence.updatedAt || row.updated_at,
    }
  }

  function listRevision(): number {
    return (db.prepare('SELECT revision FROM diary_task_list_revisions WHERE owner_user_id = ?')
      .get(owner) as { revision: number } | undefined)?.revision ?? 0
  }

  function advanceListRevision(): void {
    const result = db.prepare(`INSERT INTO diary_task_list_revisions (owner_user_id, revision) VALUES (?, 1)
      ON CONFLICT(owner_user_id) DO UPDATE SET revision = revision + 1
      WHERE revision < ?`).run(owner, MAX_REVISION)
    if (!result.changes) throw new Error('Diary task list revision exhausted')
  }

  function cursorSecret(): Buffer {
    const row = db.prepare('SELECT secret FROM diary_task_list_cursor_key WHERE id = 1').get() as { secret: Buffer } | undefined
    if (!row || !Buffer.isBuffer(row.secret) || row.secret.length !== 32) {
      throw new Error('Diary task cursor signing key is unavailable')
    }
    return row.secret
  }

  function hasExactKeys(value: unknown, expected: string[]): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const actual = Object.keys(value).sort()
    const expectedSorted = [...expected].sort()
    return actual.length === expectedSorted.length && actual.every((key, index) => key === expectedSorted[index])
  }

  function cursorMatchesQuery(value: unknown, query: TaskListQuery): boolean {
    if (query.type === 'list') {
      if (query.completed === undefined) return hasExactKeys(value, ['type']) && value.type === 'list'
      return hasExactKeys(value, ['type', 'completed'])
        && value.type === 'list'
        && value.completed === query.completed
    }
    return hasExactKeys(value, ['type', 'start', 'end'])
      && value.type === 'range'
      && value.start === query.start
      && value.end === query.end
  }

  function decodeCursor(cursor: string, query: TaskListQuery): TaskCursorPayload {
    if (!cursor || cursor.length > MAX_CURSOR_LENGTH) throw new DiaryTaskCursorError()
    const parts = cursor.split('.')
    if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]!) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1]!)) {
      throw new DiaryTaskCursorError()
    }
    const encodedPayload = parts[0]!
    const payloadBytes = Buffer.from(encodedPayload, 'base64url')
    const suppliedSignature = Buffer.from(parts[1]!, 'base64url')
    if (payloadBytes.toString('base64url') !== encodedPayload
      || suppliedSignature.toString('base64url') !== parts[1]!
      || suppliedSignature.length !== 32) throw new DiaryTaskCursorError()
    const expectedSignature = createHmac('sha256', cursorSecret()).update(encodedPayload).digest()
    if (!timingSafeEqual(suppliedSignature, expectedSignature)) throw new DiaryTaskCursorError()

    let payload: unknown
    try {
      payload = JSON.parse(payloadBytes.toString('utf8'))
    } catch {
      throw new DiaryTaskCursorError()
    }
    if (!hasExactKeys(payload, ['v', 'owner', 'revision', 'dueDate', 'id', 'query'])) throw new DiaryTaskCursorError()
    const dueDate = payload.dueDate
    if (payload.v !== 1
      || payload.owner !== owner
      || !Number.isSafeInteger(payload.revision)
      || (payload.revision as number) < 0
      || !(dueDate === null || (typeof dueDate === 'string' && civilDate(dueDate)))
      || typeof payload.id !== 'string'
      || !TASK_ID_PATTERN.test(payload.id)
      || !cursorMatchesQuery(payload.query, query)) throw new DiaryTaskCursorError()
    if (query.type === 'range' && (dueDate === null || dueDate < query.start || dueDate > query.end)) {
      throw new DiaryTaskCursorError()
    }
    return payload as TaskCursorPayload
  }

  function encodeCursor(revision: number, lastTask: DiaryTask, query: TaskListQuery): string {
    const payload: TaskCursorPayload = {
      v: 1,
      owner,
      revision,
      dueDate: lastTask.dueDate,
      id: lastTask.id,
      query,
    }
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const signature = createHmac('sha256', cursorSecret()).update(encodedPayload).digest('base64url')
    return `${encodedPayload}.${signature}`
  }

  function listPage(query: TaskListQuery, cursor?: string): DiaryTaskPage {
    operation.assertCurrent()
    return db.transaction(() => {
      const parsedCursor = cursor === undefined ? null : decodeCursor(cursor, query)
      const revision = listRevision()
      if (parsedCursor && parsedCursor.revision !== revision) throw new DiaryTaskListChanged()

      if (query.type === 'list' && query.completed !== undefined) {
        const matches: DiaryTask[] = []
        let position: Pick<TaskCursorPayload, 'dueDate' | 'id'> | null = parsedCursor
        let exhausted = false
        while (matches.length <= PAGE_SIZE && !exhausted) {
          const rows = listRowsAfter(position, PAGE_SIZE + 1)
          if (!rows.length) break
          for (const row of rows) {
            const item = task(row)
            position = { dueDate: row.due_date, id: row.id }
            if ((item.completedAt !== null) === query.completed) matches.push(item)
            if (matches.length > PAGE_SIZE) break
          }
          exhausted = rows.length < PAGE_SIZE + 1
        }
        const items = matches.slice(0, PAGE_SIZE)
        const lastTask = items.at(-1)
        if (matches.length <= PAGE_SIZE || !lastTask) return { items, nextCursor: null }
        return { items, nextCursor: encodeCursor(revision, lastTask, query) }
      }

      let rows: TaskRow[]
      if (query.type === 'list') {
        rows = listRowsAfter(parsedCursor, PAGE_SIZE + 1)
      } else if (parsedCursor === null) {
        rows = db.prepare(`SELECT * FROM diary_tasks WHERE owner_user_id = ? AND due_date BETWEEN ? AND ?
          ORDER BY due_date, id LIMIT ?`).all(owner, query.start, query.end, PAGE_SIZE + 1) as TaskRow[]
      } else {
        rows = db.prepare(`SELECT * FROM diary_tasks WHERE owner_user_id = ? AND due_date BETWEEN ? AND ?
          AND (due_date > ? OR (due_date = ? AND id > ?))
          ORDER BY due_date, id LIMIT ?`)
          .all(owner, query.start, query.end, parsedCursor.dueDate, parsedCursor.dueDate, parsedCursor.id, PAGE_SIZE + 1) as TaskRow[]
      }

      const items = rows.slice(0, PAGE_SIZE).map(task)
      const lastTask = items.at(-1)
      if (rows.length <= PAGE_SIZE || !lastTask) return { items, nextCursor: null }
      return { items, nextCursor: encodeCursor(revision, lastTask, query) }
    })()
  }

  function cursorMatchesItemQuery(value: unknown, query: TaskItemQuery): boolean {
    if (query.type === 'range') {
      return hasExactKeys(value, ['type', 'start', 'end']) && value.type === 'range'
        && value.start === query.start && value.end === query.end
    }
    return query.status === undefined
      ? hasExactKeys(value, ['type', 'start', 'end']) && value.type === 'list' && value.start === query.start && value.end === query.end
      : hasExactKeys(value, ['type', 'start', 'end', 'status']) && value.type === 'list'
        && value.start === query.start && value.end === query.end && value.status === query.status
  }

  function decodeItemCursor(cursor: string, query: TaskItemQuery): TaskItemCursorPayload {
    if (!cursor || cursor.length > MAX_CURSOR_LENGTH) throw new DiaryTaskCursorError()
    const parts = cursor.split('.')
    if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]!) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1]!)) throw new DiaryTaskCursorError()
    const encodedPayload = parts[0]!
    const payloadBytes = Buffer.from(encodedPayload, 'base64url')
    const suppliedSignature = Buffer.from(parts[1]!, 'base64url')
    if (payloadBytes.toString('base64url') !== encodedPayload || suppliedSignature.toString('base64url') !== parts[1]!
      || suppliedSignature.length !== 32) throw new DiaryTaskCursorError()
    const expectedSignature = createHmac('sha256', cursorSecret()).update(encodedPayload).digest()
    if (!timingSafeEqual(suppliedSignature, expectedSignature)) throw new DiaryTaskCursorError()
    let payload: unknown
    try { payload = JSON.parse(payloadBytes.toString('utf8')) } catch { throw new DiaryTaskCursorError() }
    if (!hasExactKeys(payload, ['v', 'owner', 'revision', 'dueDate', 'id', 'query'])) throw new DiaryTaskCursorError()
    if (payload.v !== 1 || payload.owner !== owner || !Number.isSafeInteger(payload.revision)
      || (payload.revision as number) < 0
      || !(payload.dueDate === null || (typeof payload.dueDate === 'string' && civilDate(payload.dueDate)))
      || typeof payload.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?::\d{4}-\d{2}-\d{2})?$/.test(payload.id)
      || !cursorMatchesItemQuery(payload.query, query)) throw new DiaryTaskCursorError()
    if (query.type === 'range' && (payload.dueDate === null || payload.dueDate < query.start || payload.dueDate > query.end)) throw new DiaryTaskCursorError()
    return payload as TaskItemCursorPayload
  }

  function encodeItemCursor(revision: number, item: DiaryTaskListItem, query: TaskItemQuery): string {
    const payload: TaskItemCursorPayload = { v: 1, owner, revision, dueDate: item.dueDate, id: item.id, query }
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const signature = createHmac('sha256', cursorSecret()).update(encodedPayload).digest('base64url')
    return `${encodedPayload}.${signature}`
  }

  function recurringItems(start: string, end: string, status?: 'open' | 'completed'): DiaryRecurringTaskOccurrence[] {
    const rows = db.prepare(`SELECT * FROM diary_task_series WHERE owner_user_id = ?
      AND effective_from <= ? AND (until_date IS NULL OR until_date >= ?) ORDER BY effective_from, id LIMIT 10001`)
      .all(owner, end, start) as TaskSeriesRow[]
    if (rows.length > 10000) throw new DiaryTaskExpansionLimit()
    const stateRows = db.prepare(`SELECT * FROM diary_task_occurrences WHERE owner_user_id = ?
      AND occurrence_date BETWEEN ? AND ? LIMIT 10001`).all(owner, start, end) as TaskOccurrenceRow[]
    if (stateRows.length > 10000) throw new DiaryTaskExpansionLimit()
    const states = new Map(stateRows.map(row => [`${row.series_id}:${row.occurrence_date}`, row]))
    const items: DiaryRecurringTaskOccurrence[] = []
    for (const row of rows) {
      const current = series(row)
      const dates = taskRecurrenceDates(current.recurrence, start, end, row.effective_from, 367)
      for (const date of dates) {
        const item = recurringOccurrence(row, date, states.get(`${row.id}:${date}`))
        if (status === 'completed' && item.completedAt === null) continue
        if (status === 'open' && (item.completedAt !== null || item.skipped)) continue
        items.push(item)
        if (items.length > 10000) throw new DiaryTaskExpansionLimit()
      }
    }
    return items
  }

  function compareTaskItems(left: DiaryTaskListItem, right: DiaryTaskListItem): number {
    return (left.dueDate ?? '9999-12-31').localeCompare(right.dueDate ?? '9999-12-31') || left.id.localeCompare(right.id)
  }

  function itemPage(query: TaskItemQuery, cursor?: string): DiaryTaskItemPage {
    operation.assertCurrent()
    return db.transaction(() => {
      const parsedCursor = cursor === undefined ? null : decodeItemCursor(cursor, query)
      const revision = listRevision()
      if (parsedCursor && parsedCursor.revision !== revision) throw new DiaryTaskListChanged()
      const after = parsedCursor ? { dueDate: parsedCursor.dueDate, id: parsedCursor.id } : null
      let oneOffRows: TaskRow[] = []
      if (query.type === 'range') {
        oneOffRows = after === null
          ? db.prepare(`SELECT * FROM diary_tasks WHERE owner_user_id = ? AND due_date BETWEEN ? AND ? ORDER BY due_date, id LIMIT ?`)
            .all(owner, query.start, query.end, PAGE_SIZE + 1) as TaskRow[]
          : db.prepare(`SELECT * FROM diary_tasks WHERE owner_user_id = ? AND due_date BETWEEN ? AND ?
            AND (due_date > ? OR (due_date = ? AND id > ?)) ORDER BY due_date, id LIMIT ?`)
            .all(owner, query.start, query.end, after.dueDate, after.dueDate, after.id, PAGE_SIZE + 1) as TaskRow[]
      } else {
        let position = after
        const matches: TaskRow[] = []
        let exhausted = false
        while (matches.length <= PAGE_SIZE && !exhausted) {
          const batch = listRowsAfter(position, PAGE_SIZE + 1)
          if (!batch.length) break
          for (const row of batch) {
            position = { dueDate: row.due_date, id: row.id }
            const item = task(row)
            const isCompleted = item.completedAt !== null
            if (query.status === undefined || (query.status === 'completed') === isCompleted) matches.push(row)
            if (matches.length > PAGE_SIZE) break
          }
          exhausted = batch.length < PAGE_SIZE + 1
        }
        oneOffRows = matches
      }
      const oneOffItems = oneOffRows.map(row => ({ ...task(row), kind: 'one-off' as const }))
      const recurrenceStatus = query.type === 'list' ? query.status : undefined
      const recurring = recurringItems(query.start, query.end, recurrenceStatus)
        .filter(item => after === null || compareTaskItems(item, { id: after.id, dueDate: after.dueDate } as DiaryTaskListItem) > 0)
      const items = [...oneOffItems, ...recurring].sort(compareTaskItems).slice(0, PAGE_SIZE + 1)
      const hasMore = items.length > PAGE_SIZE || oneOffRows.length > PAGE_SIZE
      const pageItems = items.slice(0, PAGE_SIZE)
      const last = pageItems.at(-1)
      return {
        items: pageItems,
        nextCursor: hasMore && last ? encodeItemCursor(revision, last, query) : null,
      }
    })()
  }

  function writeSeries(id: string, fields: TaskSeriesFields, effectiveFrom: string, expected: number): DiaryTaskSeries {
    if (!civilDate(effectiveFrom) || effectiveFrom < fields.recurrence.startDate
      || (fields.recurrence.untilDate !== null && fields.recurrence.untilDate < effectiveFrom)
      || !taskRecurrenceOccursOn(fields.recurrence, effectiveFrom, effectiveFrom)) throw new DiaryTaskRecurrenceError()
    const now = Date.now()
    const nextVersion = expected + 1
    const encrypted = crypto!.encrypt(fields, seriesIdentity(id, nextVersion))
    const row = readSeriesRow(id)
    if ((row?.version ?? deletedSeriesVersion(id)) !== expected) throw new DiaryConflict()
    db.prepare(`INSERT INTO diary_task_series (owner_user_id, id, start_date, effective_from, until_date, encrypted_fields, created_at, updated_at, version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(owner_user_id, id) DO UPDATE SET start_date = excluded.start_date, effective_from = excluded.effective_from,
        until_date = excluded.until_date, encrypted_fields = excluded.encrypted_fields,
        updated_at = excluded.updated_at, version = excluded.version`)
      .run(owner, id, fields.recurrence.startDate, effectiveFrom, fields.recurrence.untilDate,
        encrypted, row?.created_at ?? now, now, nextVersion)
    db.prepare('DELETE FROM diary_task_series_deleted_records WHERE owner_user_id = ? AND id = ?').run(owner, id)
    return series(readSeriesRow(id)!)
  }

  function replaceSeries(id: string, newId: string, effectiveDate: string, fields: TaskSeriesFields, expected: number): DiaryTaskSeries {
    operation.assertCurrent()
    const source = readSeriesRow(id)
    if (!source) {
      if (deletedSeriesVersion(id) > 0) throw new DiaryConflict()
      throw new DiaryTaskNotFound()
    }
    if (source.version !== expected) throw new DiaryConflict()
    const previous = series(source)
    if (!taskRecurrenceOccursOn(previous.recurrence, effectiveDate, source.effective_from)) throw new DiaryTaskRecurrenceError()
    return db.transaction(() => {
      const recordedStates = db.prepare(`SELECT * FROM diary_task_occurrences WHERE owner_user_id = ? AND series_id = ?
        ORDER BY occurrence_date`).all(owner, id) as TaskOccurrenceRow[]
      const stateRowsFromEffectiveDate = recordedStates.filter(row => row.occurrence_date >= effectiveDate)
      const preservesContent = fields.title === previous.title
        && fields.description === previous.description
        && fields.dueTime === previous.dueTime

      if (effectiveDate === source.effective_from) {
        // A finite end may be the only surviving evidence that this Series was
        // already split (including splits made before this protection shipped).
        // Never let an edit silently reopen that boundary.
        if (source.until_date !== null && (fields.recurrence.untilDate === null
          || fields.recurrence.untilDate > source.until_date)) throw new DiaryTaskHistoryProtectedError()
        if (!preservesContent && recordedStates.length) throw new DiaryTaskHistoryProtectedError()
        if (recordedStates.some(row => !taskRecurrenceOccursOn(fields.recurrence, row.occurrence_date, source.effective_from))) {
          throw new DiaryTaskHistoryProtectedError()
        }
        const updated = writeSeries(id, fields, source.effective_from, expected)
        advanceListRevision()
        return updated
      }
      if (!TASK_ID_PATTERN.test(newId) || newId === id || readSeriesRow(newId) || deletedSeriesVersion(newId) > 0) throw new DiaryConflict()
      // Existing finite Series can represent a historical split boundary even
      // when no explicit predecessor/successor link exists. Keep new segments
      // inside that known boundary rather than guessing which Series follows.
      if (source.until_date !== null && (fields.recurrence.untilDate === null
        || fields.recurrence.untilDate > source.until_date)) throw new DiaryTaskHistoryProtectedError()
      if (stateRowsFromEffectiveDate.length && !preservesContent) throw new DiaryTaskHistoryProtectedError()
      const newSeriesEffectiveFrom = effectiveDate
      if (stateRowsFromEffectiveDate.some(stateRow => !taskRecurrenceOccursOn(fields.recurrence, stateRow.occurrence_date, newSeriesEffectiveFrom))) {
        throw new DiaryTaskHistoryProtectedError()
      }
      const previousDay = Temporal.PlainDate.from(effectiveDate).subtract({ days: 1 }).toString()
      const closedRule = { ...previous, recurrence: { ...previous.recurrence, untilDate: previousDay } }
      const closeEncrypted = crypto!.encrypt(closedRule, seriesIdentity(id, expected + 1))
      const closeResult = db.prepare(`UPDATE diary_task_series SET until_date = ?, encrypted_fields = ?, updated_at = ?, version = ?
        WHERE owner_user_id = ? AND id = ? AND version = ?`)
        .run(previousDay, closeEncrypted, Date.now(), expected + 1, owner, id, expected)
      if (!closeResult.changes) throw new DiaryConflict()
      const newSeries = writeSeries(newId, fields, effectiveDate, 0)

      // Preserve recorded state for future dates that remain occurrences under
      // the edited rule, re-encrypting for the new series identity.
      for (const stateRow of stateRowsFromEffectiveDate) {
        const state = occurrenceState(stateRow, id, stateRow.occurrence_date).state
        const encrypted = crypto!.encrypt(state, occurrenceIdentity(newId, stateRow.occurrence_date, stateRow.version))
        db.prepare(`INSERT INTO diary_task_occurrences (owner_user_id, series_id, occurrence_date, encrypted_fields, version, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)`)
          .run(owner, newId, stateRow.occurrence_date, encrypted, stateRow.version, stateRow.updated_at)
      }
      advanceListRevision()
      return newSeries
    })()
  }

  function transitionOccurrence(seriesId: string, date: string, expected: number, action: 'complete' | 'reopen' | 'skip'): DiaryRecurringTaskOccurrence {
    operation.assertCurrent()
    const source = readSeriesRow(seriesId)
    if (!source) {
      if (deletedSeriesVersion(seriesId) > 0) throw new DiaryConflict()
      throw new DiaryTaskNotFound()
    }
    const currentSeries = series(source)
    if (!civilDate(date) || !taskRecurrenceOccursOn(currentSeries.recurrence, date, source.effective_from)) throw new DiaryTaskRecurrenceError()
    return db.transaction(() => {
      const row = readOccurrenceRow(seriesId, date)
      const current = occurrenceState(row, seriesId, date)
      if (current.version !== expected) throw new DiaryConflict()
      const nextStatus: TaskOccurrenceState['status'] = action === 'complete' ? 'completed' : action === 'skip' ? 'skipped' : 'pending'
      if (current.state.status === nextStatus || (action === 'skip' && current.state.status === 'completed')) throw new DiaryConflict()
      const nextState: TaskOccurrenceState = { status: nextStatus, completedAt: nextStatus === 'completed' ? Date.now() : null }
      const nextVersion = expected + 1
      const encrypted = crypto!.encrypt(nextState, occurrenceIdentity(seriesId, date, nextVersion))
      db.prepare(`INSERT INTO diary_task_occurrences (owner_user_id, series_id, occurrence_date, encrypted_fields, version, updated_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(owner_user_id, series_id, occurrence_date) DO UPDATE SET
          encrypted_fields = excluded.encrypted_fields, version = excluded.version, updated_at = excluded.updated_at`)
        .run(owner, seriesId, date, encrypted, nextVersion, Date.now())
      advanceListRevision()
      return recurringOccurrence(source, date, readOccurrenceRow(seriesId, date))
    })()
  }

  function listRowsAfter(position: Pick<TaskCursorPayload, 'dueDate' | 'id'> | null, limit: number): TaskRow[] {
    if (position === null) {
      return db.prepare(`SELECT * FROM diary_tasks WHERE owner_user_id = ?
        ORDER BY due_date IS NULL, due_date, id LIMIT ?`).all(owner, limit) as TaskRow[]
    }
    if (position.dueDate === null) {
      return db.prepare(`SELECT * FROM diary_tasks WHERE owner_user_id = ? AND due_date IS NULL AND id > ?
        ORDER BY due_date IS NULL, due_date, id LIMIT ?`).all(owner, position.id, limit) as TaskRow[]
    }
    return db.prepare(`SELECT * FROM diary_tasks WHERE owner_user_id = ?
      AND (due_date IS NULL OR due_date > ? OR (due_date = ? AND id > ?))
      ORDER BY due_date IS NULL, due_date, id LIMIT ?`)
      .all(owner, position.dueDate, position.dueDate, position.id, limit) as TaskRow[]
  }

  function transition(id: string, expected: number, completed: boolean): DiaryTask {
    operation.assertCurrent()
    db.transaction(() => {
      const row = readTaskRow(id)
      if (!row) {
        if (deletedVersion(id) > 0) throw new DiaryConflict()
        throw new DiaryTaskNotFound()
      }
      if (row.version !== expected) throw new DiaryConflict()
      const current = task(row)
      if ((current.completedAt !== null) === completed) throw new DiaryConflict()
      const completedAt = completed ? Date.now() : null
      const nextVersion = row.version + 1
      const encrypted = crypto!.encrypt({
        title: current.title,
        description: current.description,
        startDate: current.startDate,
        startTime: current.startTime,
        dueDate: current.dueDate,
        dueTime: current.dueTime,
        completedAt,
      }, identity(id, nextVersion))
      const result = db.prepare(`UPDATE diary_tasks SET encrypted_fields = ?, updated_at = ?, version = ?
        WHERE owner_user_id = ? AND id = ? AND version = ?`)
        .run(encrypted, Date.now(), nextVersion, owner, id, expected)
      if (!result.changes) throw new DiaryConflict()
      advanceListRevision()
    })()
    const updated = readTaskRow(id)
    if (!updated) throw new DiaryConflict()
    return task(updated)
  }

  return {
    getTask(id: string): DiaryTask | null {
      operation.assertCurrent()
      const row = readTaskRow(id)
      return row ? task(row) : null
    },
    listTasks(cursor?: string, completed?: boolean): DiaryTaskPage {
      return listPage({ type: 'list', ...(completed === undefined ? {} : { completed }) }, cursor)
    },
    tasksInRange(start: string, end: string, cursor?: string): DiaryTaskPage {
      return listPage({ type: 'range', start, end }, cursor)
    },
    putTask(id: string, fields: OneOffTaskFields, expected: number): DiaryTask {
      operation.assertCurrent()
      const now = Date.now()
      db.transaction(() => {
        const row = readTaskRow(id)
        if ((row?.version ?? deletedVersion(id)) !== expected) throw new DiaryConflict()
        const completedAt = row ? task(row).completedAt : null
        const nextVersion = expected + 1
        const encrypted = crypto!.encrypt({ ...fields, completedAt }, identity(id, nextVersion))
        db.prepare(`INSERT INTO diary_tasks (owner_user_id, id, due_date, encrypted_fields, created_at, updated_at, version)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(owner_user_id, id) DO UPDATE SET due_date = excluded.due_date,
            encrypted_fields = excluded.encrypted_fields, updated_at = excluded.updated_at, version = excluded.version`)
          .run(owner, id, fields.dueDate, encrypted, row?.created_at ?? now, now, nextVersion)
        db.prepare('DELETE FROM diary_task_deleted_records WHERE owner_user_id = ? AND id = ?').run(owner, id)
        advanceListRevision()
      })()
      const saved = readTaskRow(id)
      if (!saved) throw new DiaryConflict()
      return task(saved)
    },
    completeTask(id: string, expected: number): DiaryTask {
      return transition(id, expected, true)
    },
    reopenTask(id: string, expected: number): DiaryTask {
      return transition(id, expected, false)
    },
    removeTask(id: string, expected: number): number {
      operation.assertCurrent()
      let deletedVersionValue = 0
      db.transaction(() => {
        const row = readTaskRow(id)
        if (!row) {
          if (deletedVersion(id) > 0) throw new DiaryConflict()
          throw new DiaryTaskNotFound()
        }
        if (row.version !== expected) throw new DiaryConflict()
        const result = db.prepare('DELETE FROM diary_tasks WHERE owner_user_id = ? AND id = ? AND version = ?')
          .run(owner, id, expected)
        if (!result.changes) throw new DiaryConflict()
        deletedVersionValue = row.version + 1
        db.prepare(`INSERT INTO diary_task_deleted_records (owner_user_id, id, version) VALUES (?, ?, ?)
          ON CONFLICT(owner_user_id, id) DO UPDATE SET version = excluded.version`)
          .run(owner, id, deletedVersionValue)
        advanceListRevision()
      })()
      return deletedVersionValue
    },
    getSeries(id: string): DiaryTaskSeries | null {
      operation.assertCurrent()
      const row = readSeriesRow(id)
      return row ? series(row) : null
    },
    putSeries(id: string, fields: TaskSeriesFields, expected: number): DiaryTaskSeries {
      operation.assertCurrent()
      return db.transaction(() => {
        const saved = writeSeries(id, fields, fields.recurrence.startDate, expected)
        advanceListRevision()
        return saved
      })()
    },
    updateSeriesFrom(id: string, newId: string, effectiveDate: string, fields: TaskSeriesFields, expected: number): DiaryTaskSeries {
      return replaceSeries(id, newId, effectiveDate, fields, expected)
    },
    stopSeries(id: string, effectiveDate: string, expected: number): DiaryTaskSeries {
      operation.assertCurrent()
      return db.transaction(() => {
        operation.assertCurrent()
        const row = readSeriesRow(id)
        if (!row) {
          if (deletedSeriesVersion(id) > 0) throw new DiaryConflict()
          throw new DiaryTaskNotFound()
        }
        if (row.version !== expected) throw new DiaryConflict()
        const current = series(row)
        if (!taskRecurrenceOccursOn(current.recurrence, effectiveDate, row.effective_from)
          || current.recurrence.untilDate === effectiveDate) throw new DiaryTaskRecurrenceError()
        const laterOccurrence = db.prepare(`SELECT 1 FROM diary_task_occurrences
          WHERE owner_user_id = ? AND series_id = ? AND occurrence_date > ? LIMIT 1`)
          .get(owner, id, effectiveDate)
        if (laterOccurrence) throw new DiaryTaskHistoryProtectedError()

        const fields: TaskSeriesFields = { title: current.title, description: current.description, dueTime: current.dueTime,
          recurrence: { ...current.recurrence, untilDate: effectiveDate } }
        const encrypted = crypto!.encrypt(fields, seriesIdentity(id, expected + 1))
        const result = db.prepare(`UPDATE diary_task_series SET until_date = ?, encrypted_fields = ?, updated_at = ?, version = ?
          WHERE owner_user_id = ? AND id = ? AND version = ?`)
          .run(effectiveDate, encrypted, Date.now(), expected + 1, owner, id, expected)
        if (!result.changes) throw new DiaryConflict()
        advanceListRevision()
        return series(readSeriesRow(id)!)
      }).immediate()
    },
    removeSeries(id: string, expected: number): number {
      operation.assertCurrent()
      return db.transaction(() => {
        const row = readSeriesRow(id)
        if (!row) {
          if (deletedSeriesVersion(id) > 0) throw new DiaryConflict()
          throw new DiaryTaskNotFound()
        }
        if (row.version !== expected) throw new DiaryConflict()
        const result = db.prepare('DELETE FROM diary_task_series WHERE owner_user_id = ? AND id = ? AND version = ?')
          .run(owner, id, expected)
        if (!result.changes) throw new DiaryConflict()
        const nextVersion = row.version + 1
        db.prepare(`INSERT INTO diary_task_series_deleted_records (owner_user_id, id, version) VALUES (?, ?, ?)
          ON CONFLICT(owner_user_id, id) DO UPDATE SET version = excluded.version`).run(owner, id, nextVersion)
        advanceListRevision()
        return nextVersion
      })()
    },
    occurrence(seriesId: string, date: string): DiaryRecurringTaskOccurrence | null {
      operation.assertCurrent()
      const row = readSeriesRow(seriesId)
      if (!row) return null
      if (!taskRecurrenceOccursOn(series(row).recurrence, date, row.effective_from)) throw new DiaryTaskRecurrenceError()
      return recurringOccurrence(row, date, readOccurrenceRow(seriesId, date))
    },
    completeOccurrence(seriesId: string, date: string, expected: number): DiaryRecurringTaskOccurrence {
      return transitionOccurrence(seriesId, date, expected, 'complete')
    },
    reopenOccurrence(seriesId: string, date: string, expected: number): DiaryRecurringTaskOccurrence {
      return transitionOccurrence(seriesId, date, expected, 'reopen')
    },
    skipOccurrence(seriesId: string, date: string, expected: number): DiaryRecurringTaskOccurrence {
      return transitionOccurrence(seriesId, date, expected, 'skip')
    },
    taskItemsInRange(start: string, end: string, cursor?: string): DiaryTaskItemPage {
      return itemPage({ type: 'range', start, end }, cursor)
    },
    listTaskItems(start: string, end: string, cursor?: string, status?: 'open' | 'completed'): DiaryTaskItemPage {
      return itemPage({ type: 'list', start, end, ...(status === undefined ? {} : { status }) }, cursor)
    },
  }
}

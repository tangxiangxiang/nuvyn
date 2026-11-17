import type { Database } from 'better-sqlite3'
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { DiaryBodyOperation } from './diaryAccess/service.js'
import { civilDate } from '../shared/diaryLife.js'
import { parseTaskFields, type DiaryTask, type DiaryTaskPage, type TaskFields } from '../shared/diaryTasks.js'
import { DiaryConflict } from './diaryLife.js'

export class DiaryTaskNotFound extends Error {}
export class DiaryTaskCursorError extends Error {}
export class DiaryTaskListChanged extends Error {}

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

export function diaryTaskStore(db: Database, owner: number, operation: DiaryBodyOperation) {
  const crypto = operation.life
  if (!crypto) throw new Error('Diary crypto unavailable')
  const identity = (id: string, version: number) => JSON.stringify([owner, 'task', id, version])
  const deletedVersion = (id: string) => (db.prepare(
    'SELECT version FROM diary_task_deleted_records WHERE owner_user_id = ? AND id = ?',
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
    putTask(id: string, fields: TaskFields, expected: number): DiaryTask {
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
  }
}

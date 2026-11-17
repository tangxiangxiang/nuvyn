import type { Database } from 'better-sqlite3'
import type { DiaryBodyOperation } from './diaryAccess/service.js'
import { parseTaskFields, type DiaryTask, type TaskFields } from '../shared/diaryTasks.js'
import { DiaryConflict } from './diaryLife.js'

export class DiaryTaskNotFound extends Error {}

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
    listTasks(offset = 0): { items: DiaryTask[]; next: number | null } {
      operation.assertCurrent()
      const rows = db.prepare(`SELECT * FROM diary_tasks WHERE owner_user_id = ?
        ORDER BY due_date IS NULL, due_date, id LIMIT 201 OFFSET ?`).all(owner, offset) as TaskRow[]
      return { items: rows.slice(0, 200).map(task), next: rows.length > 200 ? offset + 200 : null }
    },
    tasksInRange(start: string, end: string, offset = 0): { items: DiaryTask[]; next: number | null } {
      operation.assertCurrent()
      const rows = db.prepare(`SELECT * FROM diary_tasks WHERE owner_user_id = ? AND due_date BETWEEN ? AND ?
        ORDER BY due_date, id LIMIT 201 OFFSET ?`).all(owner, start, end, offset) as TaskRow[]
      return { items: rows.slice(0, 200).map(task), next: rows.length > 200 ? offset + 200 : null }
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
      })()
      return deletedVersionValue
    },
  }
}

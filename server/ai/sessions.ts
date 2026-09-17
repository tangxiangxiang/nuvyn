// Sessions service. Pure functions of (db, ...args) — no closures
// over module-level state, no classes. Trivial to test by passing
// an in-memory DB. The `rowToSession` mapper handles the SQL
// snake_case → TS camelCase translation.
import type { Database as DatabaseT } from 'better-sqlite3'
import type { Session } from '../../src/lib/ai-api.js'

function rowToSession(r: any): Session {
  return {
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export function listSessions(db: DatabaseT): Session[] {
  const rows = db.prepare('SELECT id, title, created_at, updated_at FROM sessions ORDER BY updated_at DESC').all()
  return rows.map(rowToSession)
}

export function getSession(db: DatabaseT, id: number): Session | null {
  const row = db.prepare('SELECT id, title, created_at, updated_at FROM sessions WHERE id = ?').get(id)
  return row ? rowToSession(row) : null
}

export function createSession(db: DatabaseT): Session {
  const now = Date.now()
  const info = db.prepare(
    'INSERT INTO sessions (title, created_at, updated_at) VALUES (?, ?, ?)'
  ).run('', now, now)
  return { id: Number(info.lastInsertRowid), title: '', createdAt: now, updatedAt: now }
}

export function deleteSession(db: DatabaseT, id: number): boolean {
  // Single transaction: delete the session, and if it was the
  // active one, clear the pointer too. Without the transaction, a
  // crash between the two statements could leave the active pointer
  // referencing a non-existent session.
  return db.transaction(() => {
    const existing = db.prepare('SELECT id FROM sessions WHERE id = ?').get(id)
    if (!existing) return false
    if (getActiveSessionId(db) === id) {
      setActiveSessionId(db, null)
    }
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
    return true
  })()
}

export function renameSession(db: DatabaseT, id: number, title: string): Session | null {
  // Trim first; if empty after trim, this is a no-op and we return
  // the existing row (the caller will see no change and can show a
  // validation message). The interface is "rename to a non-empty
  // trimmed string" — empty input is rejected silently rather than
  // throwing, so the picker UI's inline edit can be lazy.
  const trimmed = title.trim()
  const existing = getSession(db, id)
  if (!existing) return null
  if (trimmed.length === 0) return existing
  db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(trimmed, id)
  return getSession(db, id)
}

const ACTIVE_KEY = 'nuvyn.ai.activeSessionId'

export function getActiveSessionId(db: DatabaseT): number | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(ACTIVE_KEY) as
    | { value: string }
    | undefined
  if (!row) return null
  const n = Number(row.value)
  return Number.isFinite(n) ? n : null
}

export function setActiveSessionId(db: DatabaseT, id: number | null): void {
  if (id === null) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(ACTIVE_KEY)
    return
  }
  // Upsert: insert, or replace the existing row's value on conflict.
  // SQLite supports `ON CONFLICT ... DO UPDATE` since 3.24.
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(ACTIVE_KEY, String(id))
}

// Sessions service. Pure functions of (db, ...args) — no closures
// over module-level state, no classes. Trivial to test by passing
// an in-memory DB. The `rowToSession` mapper handles the SQL
// snake_case → TS camelCase translation.
import type { Database as DatabaseT } from 'better-sqlite3'
import type { AiThreadScope, Session } from '../../src/lib/ai-api.js'

function threadKey(scope: AiThreadScope): string {
  const identity = scope.kind === 'document' ? scope.documentId : ''
  return JSON.stringify([scope.kind, scope.vaultId, identity])
}

export function parseAiThreadScope(value: unknown): AiThreadScope | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (typeof input.vaultId !== 'string' || !input.vaultId.trim() || input.vaultId.length > 512) return null
  const vaultId = input.vaultId.trim()
  if (input.kind === 'workspace') return { kind: 'workspace', vaultId }
  if (input.kind === 'document') {
    if (typeof input.documentId !== 'string' || !input.documentId.trim() || input.documentId.length > 512) return null
    if (typeof input.path !== 'string' || !input.path.trim() || input.path.length > 1024) return null
    if (typeof input.title !== 'string' || input.title.length > 512) return null
    return {
      kind: 'document',
      vaultId,
      documentId: input.documentId.trim(),
      path: input.path.trim(),
      title: input.title.trim(),
    }
  }
  return null
}

function rowToSession(r: any): Session {
  return {
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export interface AiThreadRecord {
  session: Session
  compactSummary: string
  compactedThroughMessageId: number
}

export interface AiThreadCompactionState {
  compactSummary: string
  compactedThroughMessageId: number
}

function rowToAiThread(r: any): AiThreadRecord {
  return {
    session: rowToSession(r),
    compactSummary: r.compact_summary,
    compactedThroughMessageId: r.compacted_through_message_id,
  }
}

const THREAD_COLUMNS = `
  id, title, created_at, updated_at, compact_summary, compacted_through_message_id
`

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

/** Read one scoped conversation without creating it. */
export function getAiThread(db: DatabaseT, scope: AiThreadScope): AiThreadRecord | null {
  const row = db.prepare(`SELECT ${THREAD_COLUMNS} FROM sessions WHERE thread_key = ?`)
    .get(threadKey(scope))
  return row ? rowToAiThread(row) : null
}

export function getAiThreadCompactionState(
  db: DatabaseT,
  sessionId: number,
): AiThreadCompactionState | null {
  const row = db.prepare(`
    SELECT thread_kind, compact_summary, compacted_through_message_id
    FROM sessions
    WHERE id = ?
  `).get(sessionId) as {
    thread_kind: string
    compact_summary: string
    compacted_through_message_id: number
  } | undefined
  if (!row || row.thread_kind === 'legacy') return null
  return {
    compactSummary: row.compact_summary,
    compactedThroughMessageId: row.compacted_through_message_id,
  }
}

/**
 * Return the unique thread for a note/workspace, creating it on the first
 * message. Old unscoped sessions are left untouched and are not adopted by
 * a document because their original note identity was never persisted.
 */
export function ensureAiThread(db: DatabaseT, scope: AiThreadScope): AiThreadRecord {
  const key = threadKey(scope)
  const now = Date.now()
  const documentId = scope.kind === 'document' ? scope.documentId : null
  const contextPath = scope.kind === 'document' ? scope.path : null
  const contextTitle = scope.kind === 'document' ? scope.title : null

  return db.transaction(() => {
    db.prepare(`
      INSERT OR IGNORE INTO sessions (
        title, created_at, updated_at, thread_key, thread_kind,
        vault_id, document_id, context_path, context_title
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(contextTitle ?? '', now, now, key, scope.kind, scope.vaultId, documentId, contextPath, contextTitle)
    db.prepare(`
      UPDATE sessions
      SET context_path = ?, context_title = ?, updated_at = ?
      WHERE thread_key = ?
    `).run(contextPath, contextTitle, now, key)
    const row = db.prepare(`SELECT ${THREAD_COLUMNS} FROM sessions WHERE thread_key = ?`).get(key)
    if (!row) throw new Error('AI thread could not be created')
    return rowToAiThread(row)
  })()
}

/** Persist one compaction checkpoint without changing the raw messages. */
export function saveAiThreadCompaction(
  db: DatabaseT,
  sessionId: number,
  expectedThroughMessageId: number,
  throughMessageId: number,
  compactSummary: string,
): boolean {
  const result = db.prepare(`
    UPDATE sessions
    SET compact_summary = ?, compacted_through_message_id = ?
    WHERE id = ? AND thread_kind != 'legacy' AND compacted_through_message_id = ?
  `).run(compactSummary, throughMessageId, sessionId, expectedThroughMessageId)
  return result.changes === 1
}

/** Permanently clear exactly the conversation attached to this scope. */
export function clearAiThread(db: DatabaseT, scope: AiThreadScope): boolean {
  const thread = getAiThread(db, scope)
  return thread ? deleteSession(db, thread.session.id) : false
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

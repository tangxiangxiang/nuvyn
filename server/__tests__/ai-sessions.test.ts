// Unit tests for the sessions service. We construct a fresh
// in-memory DB per test (with migrations applied) and pass it
// directly — no mocking needed because the service takes db as its
// first argument.
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { applyMigrations } from '../db'
import * as sessions from '../ai/sessions'
import * as messages from '../ai/messages'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  return db
}

describe('sessions service', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  describe('listSessions', () => {
    it('returns an empty array on a fresh DB', () => {
      expect(sessions.listSessions(db)).toEqual([])
    })

    it('returns sessions ordered by updated_at DESC (newest first)', () => {
      const a = sessions.createSession(db) // updated_at = now
      // Manually set updated_at to a known order so we don't depend on clock granularity
      db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(1000, a.id)
      const b = sessions.createSession(db)
      db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(2000, b.id)
      const c = sessions.createSession(db)
      db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(3000, c.id)

      const list = sessions.listSessions(db)
      expect(list.map((s) => s.id)).toEqual([c.id, b.id, a.id])
    })
  })

  describe('getSession', () => {
    it('returns null for a non-existent id', () => {
      expect(sessions.getSession(db, 999)).toBeNull()
    })

    it('returns the row for an existing id', () => {
      const created = sessions.createSession(db)
      const got = sessions.getSession(db, created.id)
      expect(got).toEqual(created)
    })
  })

  describe('createSession', () => {
    it('returns a session with empty title and matching created_at/updated_at', () => {
      const before = Date.now()
      const s = sessions.createSession(db)
      const after = Date.now()

      expect(s.id).toBeGreaterThan(0)
      expect(s.title).toBe('')
      expect(s.createdAt).toBeGreaterThanOrEqual(before)
      expect(s.createdAt).toBeLessThanOrEqual(after)
      expect(s.updatedAt).toBe(s.createdAt)
    })

    it('does NOT auto-set the active session (callers decide)', () => {
      sessions.createSession(db)
      expect(sessions.getActiveSessionId(db)).toBeNull()
    })
  })

  describe('deleteSession', () => {
    it('returns false for a non-existent id', () => {
      expect(sessions.deleteSession(db, 999)).toBe(false)
    })

    it('returns true and removes the row for an existing id', () => {
      const s = sessions.createSession(db)
      expect(sessions.deleteSession(db, s.id)).toBe(true)
      expect(sessions.getSession(db, s.id)).toBeNull()
    })

    it('clears the active session if the deleted session was active', () => {
      const s = sessions.createSession(db)
      sessions.setActiveSessionId(db, s.id)
      sessions.deleteSession(db, s.id)
      expect(sessions.getActiveSessionId(db)).toBeNull()
    })

    it('leaves the active session alone when deleting a different session', () => {
      const a = sessions.createSession(db)
      const b = sessions.createSession(db)
      sessions.setActiveSessionId(db, a.id)
      sessions.deleteSession(db, b.id)
      expect(sessions.getActiveSessionId(db)).toBe(a.id)
    })
  })

  describe('document AI threads', () => {
    const noteScope = {
      kind: 'document' as const,
      vaultId: 'vault-a',
      documentId: 'document-1',
      path: 'guides/mysql-recovery.md',
      title: 'MySQL recovery',
    }

    it('reuses one thread for a document when its path or title changes', () => {
      const first = sessions.ensureAiThread(db, noteScope)
      const renamed = sessions.ensureAiThread(db, {
        ...noteScope,
        path: 'archive/mysql-recovery.md',
        title: 'MySQL recovery archive',
      })

      expect(renamed.session.id).toBe(first.session.id)
      expect(sessions.listSessions(db)).toHaveLength(1)
      expect(db.prepare('SELECT context_path, context_title FROM sessions WHERE id = ?')
        .get(first.session.id)).toEqual({
        context_path: 'archive/mysql-recovery.md',
        context_title: 'MySQL recovery archive',
      })
    })

    it('isolates a document thread by vault and preserves raw messages when compacting', () => {
      const first = sessions.ensureAiThread(db, noteScope)
      const otherVault = sessions.ensureAiThread(db, { ...noteScope, vaultId: 'vault-b' })
      const userMessage = messages.appendMessage(db, first.session.id, 'user', 'Keep this message')

      expect(otherVault.session.id).not.toBe(first.session.id)
      expect(userMessage.ok).toBe(true)
      expect(sessions.saveAiThreadCompaction(db, first.session.id, 0, userMessage.ok ? userMessage.message.id : 1, 'Summary'))
        .toBe(true)
      expect(sessions.saveAiThreadCompaction(db, first.session.id, 0, 999, 'Stale summary')).toBe(false)
      expect(messages.listMessages(db, first.session.id)?.map((message) => message.content))
        .toEqual(['Keep this message'])
    })

    it('clears only the selected document thread and its raw messages', () => {
      const first = sessions.ensureAiThread(db, noteScope)
      const other = sessions.ensureAiThread(db, { ...noteScope, documentId: 'document-2' })
      messages.appendMessage(db, first.session.id, 'user', 'First note')
      messages.appendMessage(db, other.session.id, 'user', 'Second note')

      expect(sessions.clearAiThread(db, noteScope)).toBe(true)
      expect(sessions.getAiThread(db, noteScope)).toBeNull()
      expect(messages.listMessages(db, first.session.id)).toBeNull()
      expect(sessions.getAiThread(db, { ...noteScope, documentId: 'document-2' })?.session.id)
        .toBe(other.session.id)
      expect(messages.listMessages(db, other.session.id)?.map((message) => message.content))
        .toEqual(['Second note'])
    })

    it('does not compact legacy sessions', () => {
      const legacy = sessions.createSession(db)

      expect(sessions.getAiThreadCompactionState(db, legacy.id)).toBeNull()
      expect(sessions.saveAiThreadCompaction(db, legacy.id, 0, 1, 'Summary')).toBe(false)
    })
  })
})

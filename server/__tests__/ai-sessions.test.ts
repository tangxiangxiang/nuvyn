// Unit tests for the sessions service. We construct a fresh
// in-memory DB per test (with migrations applied) and pass it
// directly — no mocking needed because the service takes db as its
// first argument.
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { applyMigrations } from '../db'
import * as sessions from '../ai/sessions'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
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
})

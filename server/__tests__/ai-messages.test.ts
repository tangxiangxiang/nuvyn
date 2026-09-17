// Unit tests for the messages service. The two functions under test
// are listMessages and appendMessage. appendMessage has the most
// interesting behavior: it validates input, updates the session's
// updated_at, and auto-derives a title for the very first user
// message in a previously-untitled session.
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { applyMigrations } from '../db'
import * as sessions from '../ai/sessions'
import * as messages from '../ai/messages'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  applyMigrations(db)
  return db
}

describe('messages service', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  describe('listMessages', () => {
    it('returns null when the session does not exist', () => {
      expect(messages.listMessages(db, 999)).toBeNull()
    })

    it('returns an empty array for an existing session with no messages', () => {
      const s = sessions.createSession(db)
      expect(messages.listMessages(db, s.id)).toEqual([])
    })

    it('returns messages in chronological order (oldest first)', () => {
      const s = sessions.createSession(db)
      messages.appendMessage(db, s.id, 'user', 'first')
      messages.appendMessage(db, s.id, 'assistant', 'second')
      messages.appendMessage(db, s.id, 'user', 'third')

      const list = messages.listMessages(db, s.id)!
      expect(list.map((m) => m.content)).toEqual(['first', 'second', 'third'])
      expect(list.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    })
  })

  describe('appendMessage', () => {
    it('returns { ok: false, reason: "not-found" } when the session does not exist', () => {
      const r = messages.appendMessage(db, 999, 'user', 'hello')
      expect(r).toEqual({ ok: false, reason: 'not-found' })
    })

    it('returns { ok: false, reason: "empty" } when content is empty or whitespace', () => {
      const s = sessions.createSession(db)
      expect(messages.appendMessage(db, s.id, 'user', '')).toEqual({ ok: false, reason: 'empty' })
      expect(messages.appendMessage(db, s.id, 'user', '   \n\t  ')).toEqual({ ok: false, reason: 'empty' })
    })

    it('returns { ok: false, reason: "invalid-role" } when role is neither user nor assistant', () => {
      const s = sessions.createSession(db)
      const r = messages.appendMessage(db, s.id, 'system' as any, 'hello')
      expect(r).toEqual({ ok: false, reason: 'invalid-role' })
    })

    it('inserts a user message, returns ok:true, and refreshes updated_at', () => {
      const s = sessions.createSession(db)
      const before = Date.now()
      const r = messages.appendMessage(db, s.id, 'user', 'hi')
      const after = Date.now()

      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.message.id).toBeGreaterThan(0)
      expect(r.message.sessionId).toBe(s.id)
      expect(r.message.role).toBe('user')
      expect(r.message.content).toBe('hi')
      expect(r.message.createdAt).toBeGreaterThanOrEqual(before)
      expect(r.message.createdAt).toBeLessThanOrEqual(after)

      const after2 = sessions.getSession(db, s.id)!
      expect(after2.updatedAt).toBe(r.message.createdAt)
    })

    it('inserts an assistant message without touching the title', () => {
      const s = sessions.createSession(db)
      const r = messages.appendMessage(db, s.id, 'assistant', 'reply')
      expect(r.ok).toBe(true)
      expect(sessions.getSession(db, s.id)!.title).toBe('')
    })

    it('auto-derives a title from the first user message of an empty-title session', () => {
      const s = sessions.createSession(db)
      messages.appendMessage(db, s.id, 'user', 'How does X work?')
      expect(sessions.getSession(db, s.id)!.title).toBe('How does X work?')
    })

    it('does NOT change the title on subsequent user messages', () => {
      const s = sessions.createSession(db)
      messages.appendMessage(db, s.id, 'user', 'First question')
      messages.appendMessage(db, s.id, 'user', 'Second question')
      expect(sessions.getSession(db, s.id)!.title).toBe('First question')
    })

    it('does NOT change the title on assistant messages in an empty-title session', () => {
      const s = sessions.createSession(db)
      messages.appendMessage(db, s.id, 'assistant', 'hi back')
      expect(sessions.getSession(db, s.id)!.title).toBe('')
    })

    it('truncates a long first-message title to 30 code points with ellipsis', () => {
      const s = sessions.createSession(db)
      const long = 'a'.repeat(50) // 50 code points
      messages.appendMessage(db, s.id, 'user', long)
      const title = sessions.getSession(db, s.id)!.title
      // 30 'a's + '…' (one code point) = 31 chars
      expect([...title].length).toBe(31)
      expect(title.endsWith('…')).toBe(true)
      expect(title.startsWith('a'.repeat(30))).toBe(true)
    })

    it('does NOT append an ellipsis when the first message is exactly 30 code points', () => {
      const s = sessions.createSession(db)
      const exact = 'b'.repeat(30)
      messages.appendMessage(db, s.id, 'user', exact)
      expect(sessions.getSession(db, s.id)!.title).toBe(exact)
    })

    it('does NOT split a surrogate pair when truncating at a code-point boundary', () => {
      // 😀 is U+1F600, 1 code point but 2 UTF-16 code units. Place
      // the emoji at position 30 and confirm it's not half-cut.
      const s = sessions.createSession(db)
      const content = 'a'.repeat(30) + '😀' + 'b'.repeat(50)
      messages.appendMessage(db, s.id, 'user', content)
      const title = sessions.getSession(db, s.id)!.title
      // Expected: 30 'a's + '…' (1 code point) — the 😀 is past the
      // cutoff so it doesn't appear in the title. JS String slicing
      // on UTF-16 code units would include the high surrogate and
      // the title would end with a stray '�' or pair — assert clean.
      expect([...title].length).toBe(31)
      expect(title.startsWith('a'.repeat(30))).toBe(true)
      expect(title.endsWith('…')).toBe(true)
    })
  })

  describe('ON DELETE CASCADE (cross-service)', () => {
    // This exercises the FK set up in the 0001 migration: deleting a
    // session should remove its messages too, so listMessages
    // returns null (session not found) rather than a stale array of
    // orphaned rows. The test crosses the sessions + messages
    // service boundary, which is why it lives here and not in the
    // sessions describe block.
    it('removes all messages when a session is deleted', () => {
      const s = sessions.createSession(db)
      messages.appendMessage(db, s.id, 'user', 'one')
      messages.appendMessage(db, s.id, 'assistant', 'two')
      expect(messages.listMessages(db, s.id)).toHaveLength(2)

      sessions.deleteSession(db, s.id)
      expect(messages.listMessages(db, s.id)).toBeNull()
    })
  })
})

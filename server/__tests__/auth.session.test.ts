import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { applyMigrations } from '../db'
import { parsePublicOrigin, SESSION_LIFETIME_MS } from '../auth/config'
import {
  SESSION_TOKEN_BYTES,
  createSession,
  deleteExpiredSessions,
  findSessionByRawToken,
  generateSessionToken,
  hashSessionToken,
  revokeAllSessions,
  revokeSession,
  selectSessionToken,
  touchSessionLastSeen,
  type CreateSessionOptions,
} from '../auth/session'
const openDatabases: Database.Database[] = []

function databaseWithUser(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  const now = 1_700_000_000_000
  db.prepare(`
    INSERT INTO users (username, username_normalized, password_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run('admin', 'admin', 'test-hash', now, now)
  db.prepare(`
    INSERT INTO auth_instance (id, owner_user_id, created_at, updated_at)
    VALUES (1, 1, ?, ?)
  `).run(now, now)
  openDatabases.push(db)
  return db
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    if (db.open) db.close()
  }
})

describe('authentication session primitives', () => {
  it('generates high-entropy tokens and stores only their SHA-256 hash', () => {
    const first = generateSessionToken()
    const second = generateSessionToken()
    expect(first).not.toBe(second)
    expect(Buffer.from(first, 'base64url')).toHaveLength(SESSION_TOKEN_BYTES)
    expect(hashSessionToken(first)).toBe(hashSessionToken(first))
    expect(hashSessionToken(first)).not.toBe(first)

    const db = databaseWithUser()
    const created = createSession(db, 1, { now: 1_700_000_000_000 })
    const injected = createSession(db, 1, {
      now: 1_700_000_000_000,
      token: 'caller-controlled-token',
      lifetimeMs: 1,
    } as unknown as CreateSessionOptions)
    const row = db.prepare('SELECT token_hash FROM auth_sessions WHERE id = ?').get(created.session.id) as { token_hash: string }
    expect(row.token_hash).toBe(created.tokenHash)
    expect(row.token_hash).not.toBe(created.rawToken)
    expect(row.token_hash).not.toContain(created.rawToken)
    expect(injected.rawToken).not.toBe('caller-controlled-token')
    expect(injected.session.expiresAt - injected.session.createdAt).toBe(SESSION_LIFETIME_MS)
  })

  it('finds valid sessions and distinguishes wrong, expired, revoked, and disabled owners', () => {
    const db = databaseWithUser()
    const now = 1_700_000_000_000
    const valid = createSession(db, 1, { now })
    expect(findSessionByRawToken(db, valid.rawToken, now + 1).status).toBe('valid')
    expect(findSessionByRawToken(db, 'wrong-token', now).status).toBe('missing')

    const expired = createSession(db, 1, { now: now - SESSION_LIFETIME_MS - 1 })
    expect(findSessionByRawToken(db, expired.rawToken, now).status).toBe('expired')

    const revoked = createSession(db, 1, { now })
    expect(revokeSession(db, revoked.rawToken, now + 5)).toBe(true)
    expect(findSessionByRawToken(db, revoked.rawToken, now + 5).status).toBe('revoked')

    db.prepare('UPDATE users SET disabled = 1 WHERE id = 1').run()
    expect(findSessionByRawToken(db, valid.rawToken, now + 1).status).toBe('disabled-owner')
  })

  it('requires the configured singleton owner for session lookup', () => {
    const db = databaseWithUser()
    const now = 1_700_000_000_000
    db.prepare(`
      INSERT INTO users (username, username_normalized, password_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('second-user', 'second-user', 'test-hash', now, now)

    const owner = createSession(db, 1, { now })
    const nonOwner = createSession(db, 2, { now })
    expect(findSessionByRawToken(db, owner.rawToken, now + 1).status).toBe('valid')
    expect(findSessionByRawToken(db, nonOwner.rawToken, now + 1).status).toBe('missing')

    db.prepare('DELETE FROM auth_instance WHERE id = 1').run()
    expect(findSessionByRawToken(db, owner.rawToken, now + 1).status).toBe('missing')
  })

  it('keeps fixed expiry while coarse last-seen updates advance observability only', () => {
    const db = databaseWithUser()
    const now = 1_700_000_000_000
    const created = createSession(db, 1, { now })
    const before = db.prepare('SELECT expires_at, last_seen_at FROM auth_sessions WHERE id = ?').get(created.session.id) as { expires_at: number; last_seen_at: number }

    expect(created.session.expiresAt - created.session.createdAt).toBe(SESSION_LIFETIME_MS)
    expect(before.expires_at - created.session.createdAt).toBe(SESSION_LIFETIME_MS)
    expect(touchSessionLastSeen(db, created.session.id, now + 3_600_001, 3_600_000)).toBe(true)
    const after = db.prepare('SELECT expires_at, last_seen_at FROM auth_sessions WHERE id = ?').get(created.session.id) as { expires_at: number; last_seen_at: number }
    expect(after.expires_at).toBe(before.expires_at)
    expect(after.last_seen_at).toBe(now + 3_600_001)
    expect(touchSessionLastSeen(db, created.session.id, now + 3_600_001, 3_600_000)).toBe(false)
  })

  it('revokes all sessions for one owner and cleans only expired rows', () => {
    const db = databaseWithUser()
    const now = 1_700_000_000_000
    const first = createSession(db, 1, { now })
    const second = createSession(db, 1, { now })
    expect(revokeAllSessions(db, 1, now + 2)).toBe(2)
    expect(findSessionByRawToken(db, first.rawToken, now + 2).status).toBe('revoked')
    expect(findSessionByRawToken(db, second.rawToken, now + 2).status).toBe('revoked')

    const expired = createSession(db, 1, { now: now - SESSION_LIFETIME_MS - 10 })
    const active = createSession(db, 1, { now })
    expect(deleteExpiredSessions(db, now)).toBe(1)
    expect(findSessionByRawToken(db, expired.rawToken, now).status).toBe('missing')
    expect(findSessionByRawToken(db, active.rawToken, now).status).toBe('valid')
  })

  it('accepts only the cookie selected by the active public-origin profile', () => {
    const secure = parsePublicOrigin('https://example.com')
    const local = parsePublicOrigin('http://127.0.0.1:3000')
    const secureToken = selectSessionToken({
      '__Host-nuvyn_session': 'secure-token',
      nuvyn_session: 'local-token',
    }, secure)
    const localToken = selectSessionToken({
      '__Host-nuvyn_session': 'secure-token',
      nuvyn_session: 'local-token',
    }, local)
    expect(secureToken).toBe('secure-token')
    expect(localToken).toBe('local-token')
    expect(selectSessionToken({ nuvyn_session: 'local-token' }, secure)).toBeNull()
    expect(selectSessionToken({ '__Host-nuvyn_session': 'secure-token' }, local)).toBeNull()
  })

})

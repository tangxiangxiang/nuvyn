import { createHash, randomBytes } from 'node:crypto'
import type { Database as DatabaseT } from 'better-sqlite3'
import {
  SESSION_LAST_SEEN_UPDATE_INTERVAL_MS,
  SESSION_LIFETIME_MS,
  type AuthConfig,
} from './config.js'

export const SESSION_TOKEN_BYTES = 32

export type AuthSessionRecord = {
  readonly id: number
  readonly userId: number
  readonly tokenHash: string
  readonly createdAt: number
  readonly expiresAt: number
  readonly lastSeenAt: number
  readonly revokedAt: number | null
}

export type SessionLookupStatus =
  | 'valid'
  | 'missing'
  | 'expired'
  | 'revoked'
  | 'disabled-owner'

export type SessionLookupResult = {
  readonly status: SessionLookupStatus
  readonly session?: AuthSessionRecord
  readonly user?: {
    readonly id: number
    readonly username: string
    readonly disabled: boolean
  }
}

export type CreateSessionOptions = {
  now?: number
}

export type CreatedSession = {
  readonly rawToken: string
  readonly tokenHash: string
  readonly session: AuthSessionRecord
}

type SessionRow = {
  id: number
  user_id: number
  token_hash: string
  created_at: number
  expires_at: number
  last_seen_at: number
  revoked_at: number | null
}

type JoinedSessionRow = SessionRow & {
  username: string
  disabled: number
}

function mapSession(row: SessionRow): AuthSessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  }
}

/** Generate a cookie-safe opaque token; the raw value is never a DB value. */
export function generateSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url')
}

/** Canonical deterministic hash used as the SQLite lookup key. */
export function hashSessionToken(rawToken: string): string {
  if (typeof rawToken !== 'string' || rawToken.length === 0) return ''
  return createHash('sha256').update(rawToken, 'utf8').digest('hex')
}

export function createSession(
  db: DatabaseT,
  userId: number,
  optionsOrNow: CreateSessionOptions | number = {},
): CreatedSession {
  const options = typeof optionsOrNow === 'number'
    ? { now: optionsOrNow }
    : optionsOrNow
  const now = options.now ?? Date.now()
  if (!Number.isFinite(now)) {
    throw new RangeError('session timestamps must be finite')
  }

  const rawToken = generateSessionToken()
  const tokenHash = hashSessionToken(rawToken)
  const expiresAt = now + SESSION_LIFETIME_MS
  const result = db.prepare(
    `INSERT INTO auth_sessions (
       user_id, token_hash, created_at, expires_at, last_seen_at, revoked_at
     ) VALUES (?, ?, ?, ?, ?, NULL)`,
  ).run(userId, tokenHash, now, expiresAt, now)

  return {
    rawToken,
    tokenHash,
    session: {
      id: Number(result.lastInsertRowid),
      userId,
      tokenHash,
      createdAt: now,
      expiresAt,
      lastSeenAt: now,
      revokedAt: null,
    },
  }
}

/** Resolve a raw cookie token without ever querying SQLite by raw value. */
export function findSessionByRawToken(
  db: DatabaseT,
  rawToken: string,
  now = Date.now(),
): SessionLookupResult {
  const tokenHash = hashSessionToken(rawToken)
  if (!tokenHash) return { status: 'missing' }

  const row = db.prepare(
    `SELECT
       s.id, s.user_id, s.token_hash, s.created_at, s.expires_at,
       s.last_seen_at, s.revoked_at, u.username, u.disabled
     FROM auth_sessions s
     JOIN users u ON u.id = s.user_id
     JOIN auth_instance ai
       ON ai.id = 1
      AND ai.owner_user_id = u.id
     WHERE s.token_hash = ?
     LIMIT 1`,
  ).get(tokenHash) as JoinedSessionRow | undefined
  if (!row || !row.username) return { status: 'missing' }

  const session = mapSession(row)
  const user = {
    id: row.user_id,
    username: row.username,
    disabled: row.disabled === 1,
  }
  if (session.revokedAt !== null) return { status: 'revoked', session, user }
  if (session.expiresAt <= now) return { status: 'expired', session, user }
  if (user.disabled) return { status: 'disabled-owner', session, user }
  return { status: 'valid', session, user }
}

/** Resolve an authentication session by its server-owned identity. This is
 * intentionally unavailable to clients: it is the narrow revalidation seam
 * used by long-running authenticated operations before they mint a derived
 * capability after an async KDF boundary. */
export function findSessionById(
  db: DatabaseT,
  sessionId: number,
  now = Date.now(),
): SessionLookupResult {
  if (!Number.isSafeInteger(sessionId) || sessionId < 1) return { status: 'missing' }
  const row = db.prepare(
    `SELECT
       s.id, s.user_id, s.token_hash, s.created_at, s.expires_at,
       s.last_seen_at, s.revoked_at, u.username, u.disabled
     FROM auth_sessions s
     JOIN users u ON u.id = s.user_id
     JOIN auth_instance ai
       ON ai.id = 1
      AND ai.owner_user_id = u.id
     WHERE s.id = ?
     LIMIT 1`,
  ).get(sessionId) as JoinedSessionRow | undefined
  if (!row || !row.username) return { status: 'missing' }
  const session = mapSession(row)
  const user = {
    id: row.user_id,
    username: row.username,
    disabled: row.disabled === 1,
  }
  if (session.revokedAt !== null) return { status: 'revoked', session, user }
  if (session.expiresAt <= now) return { status: 'expired', session, user }
  if (user.disabled) return { status: 'disabled-owner', session, user }
  return { status: 'valid', session, user }
}

export const lookupSessionByRawToken = findSessionByRawToken

export function revokeSession(
  db: DatabaseT,
  rawToken: string,
  now = Date.now(),
): boolean {
  const tokenHash = hashSessionToken(rawToken)
  if (!tokenHash) return false
  const result = db.prepare(
    `UPDATE auth_sessions
     SET revoked_at = COALESCE(revoked_at, ?)
     WHERE token_hash = ? AND revoked_at IS NULL`,
  ).run(now, tokenHash)
  return result.changes > 0
}

export function revokeSessionById(
  db: DatabaseT,
  sessionId: number,
  now = Date.now(),
): boolean {
  const result = db.prepare(
    `UPDATE auth_sessions
     SET revoked_at = COALESCE(revoked_at, ?)
     WHERE id = ? AND revoked_at IS NULL`,
  ).run(now, sessionId)
  return result.changes > 0
}

export function revokeAllSessions(
  db: DatabaseT,
  userId: number,
  now = Date.now(),
): number {
  const result = db.prepare(
    `UPDATE auth_sessions
     SET revoked_at = COALESCE(revoked_at, ?)
     WHERE user_id = ? AND revoked_at IS NULL`,
  ).run(now, userId)
  return result.changes
}

/** Remove only sessions whose fixed absolute lifetime has elapsed. */
export function deleteExpiredSessions(db: DatabaseT, now = Date.now()): number {
  const result = db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now)
  return result.changes
}

/**
 * Coarsely update observability metadata without ever extending expiry. The
 * caller supplies `now` so middleware/tests do not need wall-clock sleeps.
 */
export function touchSessionLastSeen(
  db: DatabaseT,
  sessionId: number,
  now = Date.now(),
  minimumIntervalMs = SESSION_LAST_SEEN_UPDATE_INTERVAL_MS,
): boolean {
  if (!Number.isFinite(now) || !Number.isFinite(minimumIntervalMs) || minimumIntervalMs < 0) {
    throw new RangeError('session timestamps must be finite')
  }
  const result = db.prepare(
    `UPDATE auth_sessions
     SET last_seen_at = ?
     WHERE id = ?
       AND revoked_at IS NULL
       AND expires_at > ?
       AND last_seen_at <= ?`,
  ).run(now, sessionId, now, now - minimumIntervalMs)
  return result.changes > 0
}

/**
 * Select the only cookie name accepted by the current origin profile. The
 * alternate secure/local name is intentionally never a fallback.
 */
export function selectSessionToken(
  cookies: Readonly<Record<string, string | undefined>>,
  config: Pick<AuthConfig, 'cookie'>,
): string | null {
  const canonical = cookies[config.cookie.name]
  return typeof canonical === 'string' && canonical.length > 0 ? canonical : null
}

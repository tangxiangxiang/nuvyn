import type { Database as DatabaseT } from 'better-sqlite3'
import {
  BootstrapState,
} from './bootstrap.js'
import {
  KdfGuardError,
  type KdfGuard,
} from './kdfGuard.js'
import {
  hashPassword,
  isValidPassword,
  normalizeUsername,
  validatePassword,
  verifyPassword,
} from './password.js'
import {
  createSession,
  deleteExpiredSessions,
  findSessionByRawToken,
  revokeSession,
  touchSessionLastSeen,
  type CreatedSession,
  type AuthSessionRecord,
  type SessionLookupResult,
} from './session.js'
import { SESSION_LAST_SEEN_UPDATE_INTERVAL_MS } from './config.js'
import { AuthRateLimiter } from './rateLimit.js'

// Generated once from non-credential random material at the approved
// production scrypt cost. The source password is intentionally not retained;
// the result is only a false target for unknown-user timing equalization.
export const DUMMY_PASSWORD_HASH = 'scrypt$v1$N=32768,r=8,p=1$vxB7driim0d14ZL4x7e7xA$ii4iR3nQJbaXGQ4irXtmyqVBqk4KFukoTQxVsx-VKQw'

export type SafeUser = {
  readonly id: number
  readonly username: string
}

export type AuthServiceErrorCode =
  | 'validation-error'
  | 'bootstrap-invalid'
  | 'already-initialized'
  | 'invalid-credentials'
  | 'auth-rate-limited'
  | 'auth-unavailable'

export class AuthServiceError extends Error {
  readonly code: AuthServiceErrorCode
  readonly status: 400 | 401 | 409 | 429 | 500
  readonly retryAfterMs?: number

  constructor(
    code: AuthServiceErrorCode,
    status: 400 | 401 | 409 | 429 | 500,
    message: string,
    retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'AuthServiceError'
    this.code = code
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

export type AuthServiceDependencies = {
  readonly db: DatabaseT
  readonly bootstrap: BootstrapState
  readonly loginLimiter: AuthRateLimiter
  readonly setupLimiter: AuthRateLimiter
  readonly kdfGuard: KdfGuard
  readonly now?: () => number
  readonly dummyPasswordHash?: string
  readonly sessionLastSeenUpdateIntervalMs?: number
  readonly sessionPruneIntervalMs?: number
}

/**
 * Expired-session cleanup is request-triggered housekeeping, not a scheduler.
 * Keeping it process-local prevents every authenticated request from issuing a
 * database DELETE while still allowing active instances to remove stale rows.
 */
export const SESSION_EXPIRED_PRUNE_INTERVAL_MS = 30 * 60 * 1000

type OwnerRow = {
  id: number
  username: string
  username_normalized: string
  password_hash: string
  disabled: number
}

function safeUser(row: OwnerRow): SafeUser {
  return { id: row.id, username: row.username }
}

function ownerRow(db: DatabaseT): OwnerRow | undefined {
  return db.prepare(`
    SELECT u.id, u.username, u.username_normalized, u.password_hash, u.disabled
    FROM auth_instance ai
    JOIN users u ON u.id = ai.owner_user_id
    WHERE ai.id = 1
    LIMIT 1
  `).get() as OwnerRow | undefined
}

function isKdfFailure(error: unknown): error is KdfGuardError {
  return error instanceof KdfGuardError
}

function kdfUnavailable(error: unknown): AuthServiceError {
  if (isKdfFailure(error)) {
    return new AuthServiceError(
      'auth-rate-limited',
      429,
      'Authentication is temporarily busy. Please try again shortly.',
      1_000,
    )
  }
  return new AuthServiceError('auth-unavailable', 500, 'Authentication is temporarily unavailable.')
}

function retryAfterError(retryAfterMs: number): AuthServiceError {
  return new AuthServiceError(
    'auth-rate-limited',
    429,
    'Too many authentication attempts. Please try again later.',
    retryAfterMs,
  )
}

function throwLoginFailure(limiter: AuthRateLimiter, normalized: string | null): never {
  const failure = limiter.recordFailure(normalized ?? '<invalid-username>')
  if (failure.retryAfterMs > 0) throw retryAfterError(failure.retryAfterMs)
  throw new AuthServiceError('invalid-credentials', 401, 'Invalid username or password.')
}

export class AuthService {
  readonly db: DatabaseT
  readonly bootstrap: BootstrapState
  readonly loginLimiter: AuthRateLimiter
  readonly setupLimiter: AuthRateLimiter
  readonly kdfGuard: KdfGuard
  readonly now: () => number
  readonly dummyPasswordHash: string
  readonly sessionLastSeenUpdateIntervalMs: number
  readonly sessionPruneIntervalMs: number
  private lastExpiredSessionPruneAt = Number.NEGATIVE_INFINITY
  private expiredSessionPruneScheduled = false

  constructor(dependencies: AuthServiceDependencies) {
    this.db = dependencies.db
    this.bootstrap = dependencies.bootstrap
    this.loginLimiter = dependencies.loginLimiter
    this.setupLimiter = dependencies.setupLimiter
    this.kdfGuard = dependencies.kdfGuard
    this.now = dependencies.now ?? Date.now
    this.dummyPasswordHash = dependencies.dummyPasswordHash ?? DUMMY_PASSWORD_HASH
    this.sessionLastSeenUpdateIntervalMs = dependencies.sessionLastSeenUpdateIntervalMs
      ?? SESSION_LAST_SEEN_UPDATE_INTERVAL_MS
    this.sessionPruneIntervalMs = dependencies.sessionPruneIntervalMs
      ?? SESSION_EXPIRED_PRUNE_INTERVAL_MS
  }

  ownerExists(): boolean {
    return ownerRow(this.db) !== undefined
  }

  status(rawToken: string | null): {
    authenticated: boolean
    setupRequired: boolean
    user?: SafeUser
    session?: SessionLookupResult
  } {
    const owner = ownerRow(this.db)
    if (!owner) return { authenticated: false, setupRequired: true }
    if (!rawToken) return { authenticated: false, setupRequired: false }
    const session = findSessionByRawToken(this.db, rawToken, this.now())
    if (session.status !== 'valid' || !session.user) {
      return { authenticated: false, setupRequired: false, session }
    }
    return { authenticated: true, setupRequired: false, user: safeUser(owner), session }
  }

  /**
   * Maintain an already-authenticated session without performing another raw
   * token lookup. A due last_seen update is authentication-critical: if the
   * row can no longer be updated, the middleware must stop before the handler.
   * Expired-row pruning is deliberately best effort and throttled per runtime.
   */
  maintainAuthenticatedSession(session: AuthSessionRecord): void {
    const now = this.now()
    if (now - session.lastSeenAt >= this.sessionLastSeenUpdateIntervalMs) {
      const touched = touchSessionLastSeen(
        this.db,
        session.id,
        now,
        this.sessionLastSeenUpdateIntervalMs,
      )
      if (!touched) throw new Error('authenticated session maintenance failed')
    }

    this.maybePruneExpiredSessions(now)
  }

  /**
   * Schedule throttled housekeeping outside the authentication/handler
   * decision. The gate advances before the deferred write so concurrent
   * requests cannot enqueue unbounded DELETE work.
   */
  maybePruneExpiredSessions(now = this.now()): void {
    if (this.expiredSessionPruneScheduled
      || now - this.lastExpiredSessionPruneAt < this.sessionPruneIntervalMs) return
    this.lastExpiredSessionPruneAt = now
    this.expiredSessionPruneScheduled = true
    queueMicrotask(() => {
      this.expiredSessionPruneScheduled = false
      try {
        deleteExpiredSessions(this.db, now)
      } catch {
        // Housekeeping must not turn an otherwise authenticated request into
        // a user-visible failure. Authentication lookup/touch errors are
        // handled separately by the caller.
      }
    })
  }

  async setup(input: {
    bootstrapToken: unknown
    username: unknown
    password: unknown
    signal?: AbortSignal
  }): Promise<{ user: SafeUser; session: CreatedSession }> {
    if (this.ownerExists()) {
      throw new AuthServiceError('already-initialized', 409, 'Nuvyn is already initialized.')
    }
    const setupRetryAfterMs = this.setupLimiter.retryAfter('setup', this.now())
    if (setupRetryAfterMs > 0) throw retryAfterError(setupRetryAfterMs)
    if (typeof input.username !== 'string' || typeof input.password !== 'string') {
      throw new AuthServiceError('validation-error', 400, 'Bootstrap token, username, and password are required.')
    }

    let username: string
    try {
      username = normalizeUsername(input.username)
      validatePassword(input.password)
    } catch {
      throw new AuthServiceError('validation-error', 400, 'Invalid username or password.')
    }

    if (typeof input.bootstrapToken !== 'string' || !this.bootstrap.verify(input.bootstrapToken)) {
      const failure = this.setupLimiter.recordFailure('setup')
      if (failure.retryAfterMs > 0) throw retryAfterError(failure.retryAfterMs)
      throw new AuthServiceError('bootstrap-invalid', 401, 'Bootstrap token is invalid.')
    }

    let passwordHash: string
    try {
      passwordHash = await hashPassword(input.password, { guard: this.kdfGuard, signal: input.signal })
    } catch (error) {
      throw kdfUnavailable(error)
    }

    const now = this.now()
    let owner: OwnerRow
    try {
      const transaction = this.db.transaction(() => {
        if (ownerRow(this.db)) throw new AuthServiceError('already-initialized', 409, 'Nuvyn is already initialized.')
        const result = this.db.prepare(`
          INSERT INTO users (
            username, username_normalized, password_hash, disabled, created_at, updated_at
          ) VALUES (?, ?, ?, 0, ?, ?)
        `).run(username, username, passwordHash, now, now)
        const userId = Number(result.lastInsertRowid)
        this.db.prepare(`
          INSERT INTO auth_instance (id, owner_user_id, created_at, updated_at)
          VALUES (1, ?, ?, ?)
        `).run(userId, now, now)
        const created = ownerRow(this.db)
        if (!created) throw new Error('owner transaction did not create an owner')
        return created
      })
      owner = transaction.immediate()
    } catch (error) {
      if (error instanceof AuthServiceError) throw error
      // A concurrent transaction can win between the explicit owner check and
      // SQLite's insert. Re-read the singleton and expose only the safe 409.
      if (ownerRow(this.db)) {
        throw new AuthServiceError('already-initialized', 409, 'Nuvyn is already initialized.')
      }
      throw new AuthServiceError('auth-unavailable', 500, 'Authentication is temporarily unavailable.')
    }

    // The setup capability closes at the owner commit boundary, before any
    // session/cookie work that could throw.
    this.bootstrap.markOwnerCommitted()
    this.setupLimiter.reset('setup')
    let session: CreatedSession
    try {
      session = createSession(this.db, owner.id, { now })
    } catch {
      throw new AuthServiceError('auth-unavailable', 500, 'Authentication is temporarily unavailable.')
    }
    return { user: safeUser(owner), session }
  }

  async login(input: { username: unknown; password: unknown; signal?: AbortSignal }): Promise<{ user: SafeUser; session: CreatedSession }> {
    if (typeof input.username !== 'string' || typeof input.password !== 'string') {
      throw new AuthServiceError('validation-error', 400, 'Username and password are required.')
    }

    let normalized: string | null = null
    try {
      normalized = normalizeUsername(input.username)
    } catch {
      // Keep malformed username failures generic; callers still receive the
      // same public credential response as an unknown owner.
    }

    // Do not let malformed-length passwords reach verifyPassword/scrypt. Keep
    // this response on the same generic failure path as a bad credential; a
    // valid-length unknown user continues to receive dummy-hash equalization.
    if (!isValidPassword(input.password)) {
      throwLoginFailure(this.loginLimiter, normalized)
    }

    const owner = ownerRow(this.db)
    const candidate = normalized && owner && owner.username_normalized === normalized ? owner : undefined
    let verified = false
    try {
      verified = candidate
        ? await verifyPassword(input.password, candidate.password_hash, { guard: this.kdfGuard, signal: input.signal })
        : await verifyPassword(input.password, this.dummyPasswordHash, { guard: this.kdfGuard, signal: input.signal })
    } catch (error) {
      throw kdfUnavailable(error)
    }

    if (!candidate || !verified || candidate.disabled === 1) {
      throwLoginFailure(this.loginLimiter, normalized)
    }

    this.loginLimiter.reset(normalized!)
    let session: CreatedSession
    try {
      session = createSession(this.db, candidate.id, { now: this.now() })
    } catch {
      throw new AuthServiceError('auth-unavailable', 500, 'Authentication is temporarily unavailable.')
    }
    return { user: safeUser(candidate), session }
  }

  logout(rawToken: string | null): void {
    if (!rawToken) return
    const lookup = findSessionByRawToken(this.db, rawToken, this.now())
    if (lookup.session && lookup.status !== 'revoked') {
      revokeSession(this.db, rawToken, this.now())
    }
  }
}

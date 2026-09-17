import Database from 'better-sqlite3'
import { __setDbForTesting, applyMigrations } from '../../db.js'
import { parsePublicOrigin, type AuthConfig } from '../../auth/config.js'
import type { KdfGuard } from '../../auth/kdfGuard.js'
import { createAuthRuntime, installAuthRuntimeForTesting, resetAuthRuntimeForTesting, type AuthRuntime } from '../../auth/runtime.js'
import type { RateLimiterOptions } from '../../auth/rateLimit.js'
import { DUMMY_PASSWORD_HASH } from '../../auth/service.js'
import { createSession, type CreatedSession } from '../../auth/session.js'
import { DIARY_ACCESS_CAPABILITY_HEADER } from '../../diaryAccess/service.js'

export const TEST_SETUP_TOKEN = 'phase-2-test-token-0123456789abcdef'

export type AuthTestContext = {
  readonly db: Database.Database
  readonly runtime: AuthRuntime
  readonly logs: string[]
  readonly ownsDb: boolean
}

export type AuthenticatedTestContext = AuthTestContext & {
  readonly userId: number
  readonly username: string
  readonly rawToken: string
  readonly session: CreatedSession['session']
  readonly cookie: string
}

export type AuthTestContextOptions = {
  db?: Database.Database
  origin?: string
  setupToken?: string
  revokeSessionsOnStart?: boolean
  now?: () => number
  logger?: (message: string) => void
  rateLimiterOptions?: RateLimiterOptions
  fallbackBootstrap?: boolean
  kdfGuard?: KdfGuard
}

export function createAuthTestContext(options: AuthTestContextOptions = {}): AuthTestContext {
  const ownsDb = options.db === undefined
  const db = options.db ?? new Database(':memory:')
  if (!ownsDb) __setDbForTesting(db)
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  const logs: string[] = []
  const config: AuthConfig = {
    ...parsePublicOrigin(options.origin ?? 'http://127.0.0.1:3000'),
    revokeSessionsOnStart: options.revokeSessionsOnStart ?? false,
  }
  const runtime = createAuthRuntime({
    db,
    config,
    env: options.fallbackBootstrap
      ? {}
      : { NUVYN_SETUP_TOKEN: options.setupToken ?? TEST_SETUP_TOKEN },
    logger: (message) => {
      logs.push(message)
      options.logger?.(message)
    },
    now: options.now,
    rateLimiterOptions: options.rateLimiterOptions,
    kdfGuard: options.kdfGuard,
  })
  installAuthRuntimeForTesting(runtime)
  return { db, runtime, logs, ownsDb }
}

export function closeAuthTestContext(context: AuthTestContext): void {
  resetAuthRuntimeForTesting()
  if (!context.ownsDb) __setDbForTesting(null)
  if (context.ownsDb && context.db.open) context.db.close()
}

/**
 * Install the real Phase 2 auth runtime against a caller-owned database and
 * seed one singleton owner/session using the production session primitive.
 * Application route tests can therefore share their metadata DB with auth
 * instead of accidentally exercising a second unrelated database.
 */
export function createAuthenticatedTestContext(
  options: AuthTestContextOptions & {
    username?: string
    passwordHash?: string
  } = {},
): AuthenticatedTestContext {
  const context = createAuthTestContext(options)
  const username = options.username ?? 'test-owner'
  const now = options.now?.() ?? Date.now()
  const owner = context.db.prepare(`
    INSERT INTO users (
      username, username_normalized, password_hash, disabled, created_at, updated_at
    ) VALUES (?, ?, ?, 0, ?, ?)
  `).run(
    username,
    username.toLowerCase(),
    options.passwordHash ?? DUMMY_PASSWORD_HASH,
    now,
    now,
  )
  const userId = Number(owner.lastInsertRowid)
  context.db.prepare(`
    INSERT INTO auth_instance (id, owner_user_id, created_at, updated_at)
    VALUES (1, ?, ?, ?)
  `).run(userId, now, now)
  const created = createSession(context.db, userId, { now })
  return {
    ...context,
    userId,
    username,
    rawToken: created.rawToken,
    session: created.session,
    cookie: `${context.runtime.config.cookie.name}=${created.rawToken}`,
  }
}

/** Alias named after the operation most application tests need to express. */
export function installAuthenticatedTestRuntime(
  db: Database.Database,
  options?: Omit<AuthTestContextOptions, 'db'> & { username?: string; passwordHash?: string },
): AuthenticatedTestContext
export function installAuthenticatedTestRuntime(
  options?: AuthTestContextOptions & { username?: string; passwordHash?: string },
): AuthenticatedTestContext
export function installAuthenticatedTestRuntime(
  dbOrOptions: Database.Database | (AuthTestContextOptions & { username?: string; passwordHash?: string }) = {},
  options: Omit<AuthTestContextOptions, 'db'> & { username?: string; passwordHash?: string } = {},
): AuthenticatedTestContext {
  if (dbOrOptions instanceof Database) {
    return createAuthenticatedTestContext({ ...options, db: dbOrOptions })
  }
  return createAuthenticatedTestContext(dbOrOptions)
}

export const createAuthenticatedSession = createAuthenticatedTestContext

export function authCookieHeader(context: Pick<AuthenticatedTestContext, 'cookie'>): string {
  return context.cookie
}

export function authenticatedRequest(
  context: Pick<AuthenticatedTestContext, 'cookie'>,
  path: string,
  init: Parameters<typeof jsonRequest>[1] = { method: 'GET' },
): Request {
  return jsonRequest(path, { ...init, cookie: context.cookie })
}

/** Add only the real session cookie while preserving an existing Request's
 * method, body, content type, conditional headers, and streaming semantics. */
export function withAuthCookie(
  context: Pick<AuthenticatedTestContext, 'cookie'>,
  request: Request,
): Request {
  const headers = new Headers(request.headers)
  headers.set('Cookie', context.cookie)
  return new Request(request, { headers })
}

/** Establish the process-local Diary capability for a route test that is
 * intentionally exercising an unlocked managed Diary body. */
export async function unlockDiaryAccessForTesting(
  context: AuthenticatedTestContext,
  password = 'diary-access-test-password',
): Promise<string> {
  const result = await context.runtime.diaryAccess.setup(context.session.id, password)
  return result.capability
}

/** Add the authenticated session cookie and an explicitly supplied Diary
 * capability. Tests that expect the locked boundary should continue using
 * withAuthCookie without this helper. */
export function withDiaryCapability(
  context: Pick<AuthenticatedTestContext, 'cookie'>,
  request: Request,
  capability: string,
): Request {
  const authenticated = withAuthCookie(context, request)
  const headers = new Headers(authenticated.headers)
  headers.set(DIARY_ACCESS_CAPABILITY_HEADER, capability)
  return new Request(authenticated, { headers })
}

export function jsonRequest(
  path: string,
  init: { method: string; body?: unknown; origin?: string; cookie?: string; contentType?: string },
): Request {
  const headers = new Headers()
  if (init.origin !== undefined) headers.set('Origin', init.origin)
  if (init.cookie !== undefined) headers.set('Cookie', init.cookie)
  if (init.body !== undefined) {
    if (init.contentType !== '') headers.set('Content-Type', init.contentType ?? 'application/json')
  }
  return new Request(`http://localhost${path}`, {
    method: init.method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
}

export function cookieFromResponse(response: Response): string {
  const setCookie = response.headers.get('set-cookie')
  if (!setCookie) throw new Error('response did not set a cookie')
  return setCookie.split(';', 1)[0]
}

export function countRows(db: Database.Database, table: string): number {
  if (!/^[a-z_]+$/.test(table)) throw new Error('unsafe table name in test')
  return Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count)
}

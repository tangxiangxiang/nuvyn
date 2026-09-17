import type { Database as DatabaseT } from 'better-sqlite3'
import {
  BootstrapState,
  type AuthLogger,
} from './bootstrap.js'
import {
  defaultKdfGuard,
  type KdfGuard,
} from './kdfGuard.js'
import {
  AuthRateLimiter,
  SETUP_BASE_RETRY_MS,
  SETUP_FAILURE_THRESHOLD,
  SETUP_FAILURE_WINDOW_MS,
  SETUP_MAX_DELAY_MS,
  SETUP_MAX_BUCKETS,
  type RateLimiterOptions,
} from './rateLimit.js'
import type { AuthConfig } from './config.js'
import { AuthService } from './service.js'
import { DiaryAccessService } from '../diaryAccess/service.js'
import { findSessionById } from './session.js'
import { readCanonicalEnv } from '../env.js'

export type AuthRuntime = {
  readonly db: DatabaseT
  readonly config: AuthConfig
  readonly bootstrap: BootstrapState
  readonly loginLimiter: AuthRateLimiter
  readonly setupLimiter: AuthRateLimiter
  readonly kdfGuard: KdfGuard
  readonly service: AuthService
  readonly diaryAccess: DiaryAccessService
  readonly diaryUnlockLimiter: AuthRateLimiter
}

export type AuthRuntimeOptions = {
  readonly db: DatabaseT
  readonly config: AuthConfig
  readonly env?: NodeJS.ProcessEnv
  readonly logger?: AuthLogger
  readonly kdfGuard?: KdfGuard
  readonly loginLimiter?: AuthRateLimiter
  readonly setupLimiter?: AuthRateLimiter
  readonly diaryUnlockLimiter?: AuthRateLimiter
  readonly rateLimiterOptions?: RateLimiterOptions
  readonly now?: () => number
  readonly diaryAccessVaultId?: () => string
}

let currentRuntime: AuthRuntime | null = null

export function createAuthRuntime(options: AuthRuntimeOptions): AuthRuntime {
  const logger = options.logger ?? console.log
  const environment = options.env ?? process.env
  const bootstrap = BootstrapState.create({
    db: options.db,
    explicitToken: readCanonicalEnv(environment, 'NUVYN_SETUP_TOKEN'),
    logger,
  })
  const loginLimiter = options.loginLimiter
    ?? new AuthRateLimiter(options.rateLimiterOptions)
  const setupLimiter = options.setupLimiter
    ?? new AuthRateLimiter({
      ...options.rateLimiterOptions,
      windowMs: Math.min(options.rateLimiterOptions?.windowMs ?? SETUP_FAILURE_WINDOW_MS, SETUP_FAILURE_WINDOW_MS),
      threshold: Math.min(options.rateLimiterOptions?.threshold ?? SETUP_FAILURE_THRESHOLD, SETUP_FAILURE_THRESHOLD),
      baseRetryMs: Math.min(options.rateLimiterOptions?.baseRetryMs ?? SETUP_BASE_RETRY_MS, SETUP_MAX_DELAY_MS),
      maxDelayMs: Math.min(options.rateLimiterOptions?.maxDelayMs ?? SETUP_MAX_DELAY_MS, SETUP_MAX_DELAY_MS),
      maxBuckets: Math.min(options.rateLimiterOptions?.maxBuckets ?? SETUP_MAX_BUCKETS, SETUP_MAX_BUCKETS),
    })
  const kdfGuard = options.kdfGuard ?? defaultKdfGuard
  const diaryUnlockLimiter = options.diaryUnlockLimiter
    ?? new AuthRateLimiter(options.rateLimiterOptions)
  const service = new AuthService({
    db: options.db,
    bootstrap,
    loginLimiter,
    setupLimiter,
    kdfGuard,
    now: options.now,
    sessionLastSeenUpdateIntervalMs: options.config.sessionLastSeenUpdateIntervalMs,
  })
  const diaryAccess = new DiaryAccessService({
    db: options.db,
    kdfGuard,
    now: options.now,
    getVaultId: options.diaryAccessVaultId,
    unlockLimiter: diaryUnlockLimiter,
    resolveAuthSession: (sessionId) => {
      const lookup = findSessionById(options.db, sessionId, options.now?.() ?? Date.now())
      return lookup.status === 'valid' && lookup.session
        ? { valid: true, expiresAt: lookup.session.expiresAt }
        : { valid: false }
    },
  })
  const runtime: AuthRuntime = {
    db: options.db,
    config: options.config,
    bootstrap,
    loginLimiter,
    setupLimiter,
    kdfGuard,
    service,
    diaryAccess,
    diaryUnlockLimiter,
  }

  if (options.config.revokeSessionsOnStart) {
    const count = options.db.prepare(`
      UPDATE auth_sessions
      SET revoked_at = COALESCE(revoked_at, ?)
      WHERE revoked_at IS NULL
    `).run(options.now?.() ?? Date.now()).changes
    if (count > 0) logger(`[nuvyn] authentication: revoked ${count} session(s) on startup`)
  }
  return runtime
}

export function initializeAuthRuntime(options: AuthRuntimeOptions): AuthRuntime {
  if (currentRuntime) return currentRuntime
  currentRuntime = createAuthRuntime(options)
  return currentRuntime
}

export function getAuthRuntime(): AuthRuntime | null {
  return currentRuntime
}

export function installAuthRuntimeForTesting(runtime: AuthRuntime): void {
  currentRuntime = runtime
}

export function resetAuthRuntimeForTesting(): void {
  currentRuntime = null
}

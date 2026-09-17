import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import app from '../index.js'
import {
  authenticatedRequest,
  closeAuthTestContext,
  createAuthenticatedTestContext,
  jsonRequest,
  withDiaryCapability,
  type AuthenticatedTestContext,
} from './helpers/auth.js'
import { revokeSessionById } from '../auth/session.js'
import { createSession } from '../auth/session.js'

const PASSWORD = 'diary-access-route-password'

let context: AuthenticatedTestContext

beforeEach(() => {
  context = createAuthenticatedTestContext()
})

afterEach(() => {
  closeAuthTestContext(context)
})

function protectedJson(path: string, body: unknown): Request {
  return jsonRequest(path, {
    method: 'POST',
    origin: context.runtime.config.publicOrigin,
    cookie: context.cookie,
    body,
  })
}

describe('D8.1 Diary access routes', () => {
  it('sets up exactly once, exposes only an opaque capability, and locks it', async () => {
    const initial = await app.fetch(authenticatedRequest(context, '/api/diary/access/status'))
    expect(initial.status).toBe(200)
    expect(await initial.json()).toEqual({ state: 'UNINITIALIZED' })

    const setup = await app.fetch(protectedJson('/api/diary/access/setup', { password: PASSWORD }))
    expect(setup.status).toBe(201)
    const setupBody = await setup.json() as { state: string; capability: string; epoch: number }
    expect(setupBody.state).toBe('UNLOCKED')
    expect(setupBody.capability).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(setupBody.capability).not.toContain(PASSWORD)
    expect(setupBody.epoch).toBeGreaterThan(0)

    const unlocked = await app.fetch(withDiaryCapability(
      context,
      authenticatedRequest(context, '/api/diary/access/status'),
      setupBody.capability,
    ))
    expect(await unlocked.json()).toMatchObject({ state: 'UNLOCKED', epoch: setupBody.epoch })

    const duplicate = await app.fetch(protectedJson('/api/diary/access/setup', { password: PASSWORD }))
    expect(duplicate.status).toBe(409)
    expect(await duplicate.json()).toMatchObject({ code: 'diary-access-invalid-state' })

    const lock = await app.fetch(withDiaryCapability(
      context,
      protectedJson('/api/diary/access/lock', {}),
      setupBody.capability,
    ))
    expect(lock.status).toBe(200)
    expect(await lock.json()).toEqual({ state: 'LOCKED' })

    const locked = await app.fetch(withDiaryCapability(
      context,
      authenticatedRequest(context, '/api/diary/access/status'),
      setupBody.capability,
    ))
    expect(await locked.json()).toEqual({ state: 'LOCKED' })
  })

  it('keeps wrong-password unlock locked and issues a new session-bound capability on success', async () => {
    const setup = await app.fetch(protectedJson('/api/diary/access/setup', { password: PASSWORD }))
    const first = await setup.json() as { capability: string; epoch: number }
    await app.fetch(withDiaryCapability(
      context,
      protectedJson('/api/diary/access/lock', {}),
      first.capability,
    ))

    const wrong = await app.fetch(protectedJson('/api/diary/access/unlock', { password: 'wrong-diary-password' }))
    expect(wrong.status).toBe(401)
    expect(await wrong.json()).toMatchObject({ code: 'diary-access-invalid-password' })

    const correct = await app.fetch(protectedJson('/api/diary/access/unlock', { password: PASSWORD }))
    expect(correct.status).toBe(200)
    const second = await correct.json() as { state: string; capability: string; epoch: number }
    expect(second.state).toBe('UNLOCKED')
    expect(second.capability).not.toBe(first.capability)
    expect(second.epoch).toBeGreaterThan(first.epoch)

    const old = await app.fetch(withDiaryCapability(
      context,
      authenticatedRequest(context, '/api/diary/access/status'),
      first.capability,
    ))
    expect(await old.json()).toEqual({ state: 'LOCKED' })

    const current = await app.fetch(withDiaryCapability(
      context,
      authenticatedRequest(context, '/api/diary/access/status'),
      second.capability,
    ))
    expect(await current.json()).toMatchObject({ state: 'UNLOCKED', epoch: second.epoch })
  })

  it('invalidates the capability before logout completes', async () => {
    const setup = await app.fetch(protectedJson('/api/diary/access/setup', { password: PASSWORD }))
    const { capability } = await setup.json() as { capability: string }
    expect(context.runtime.diaryAccess.isCapabilityValid(context.session.id, capability)).toBe(true)

    const logout = await app.fetch(jsonRequest('/api/auth/logout', {
      method: 'POST',
      origin: context.runtime.config.publicOrigin,
      cookie: context.cookie,
    }))
    expect(logout.status).toBe(204)
    expect(context.runtime.diaryAccess.isCapabilityValid(context.session.id, capability)).toBe(false)
  })

  it('invalidates the capability when the auth boundary observes a revoked session', async () => {
    const setup = await app.fetch(protectedJson('/api/diary/access/setup', { password: PASSWORD }))
    const { capability } = await setup.json() as { capability: string }
    expect(context.runtime.diaryAccess.isCapabilityValid(context.session.id, capability)).toBe(true)

    expect(revokeSessionById(context.db, context.session.id)).toBe(true)
    const status = await app.fetch(withDiaryCapability(
      context,
      authenticatedRequest(context, '/api/diary/access/status'),
      capability,
    ))
    expect(status.status).toBe(401)
    expect(await status.json()).toMatchObject({ code: 'auth-session-required' })
    expect(context.runtime.diaryAccess.isCapabilityValid(context.session.id, capability)).toBe(false)
  })

  it('isolates simultaneous unlock, lock, logout, and cross-session capability use', async () => {
    const setup = await app.fetch(protectedJson('/api/diary/access/setup', { password: PASSWORD }))
    const first = await setup.json() as { capability: string }
    const secondSession = createSession(context.db, context.userId)
    const secondContext = {
      cookie: `${context.runtime.config.cookie.name}=${secondSession.rawToken}`,
    }
    const secondUnlock = await app.fetch(jsonRequest('/api/diary/access/unlock', {
      method: 'POST',
      origin: context.runtime.config.publicOrigin,
      cookie: secondContext.cookie,
      body: { password: PASSWORD },
    }))
    expect(secondUnlock.status).toBe(200)
    const second = await secondUnlock.json() as { capability: string }

    expect(context.runtime.diaryAccess.isCapabilityValid(context.session.id, first.capability)).toBe(true)
    expect(context.runtime.diaryAccess.isCapabilityValid(secondSession.session.id, second.capability)).toBe(true)
    expect(context.runtime.diaryAccess.isCapabilityValid(secondSession.session.id, first.capability)).toBe(false)

    const secondLock = await app.fetch(withDiaryCapability(
      secondContext,
      jsonRequest('/api/diary/access/lock', {
        method: 'POST', origin: context.runtime.config.publicOrigin, cookie: secondContext.cookie,
      }),
      second.capability,
    ))
    expect(secondLock.status).toBe(200)
    expect(context.runtime.diaryAccess.isCapabilityValid(context.session.id, first.capability)).toBe(true)
    expect(context.runtime.diaryAccess.isCapabilityValid(secondSession.session.id, second.capability)).toBe(false)

    const secondAgain = await context.runtime.diaryAccess.unlock(secondSession.session.id, PASSWORD)
    const logout = await app.fetch(jsonRequest('/api/auth/logout', {
      method: 'POST', origin: context.runtime.config.publicOrigin, cookie: context.cookie,
    }))
    expect(logout.status).toBe(204)
    expect(context.runtime.diaryAccess.isCapabilityValid(context.session.id, first.capability)).toBe(false)
    expect(context.runtime.diaryAccess.isCapabilityValid(secondSession.session.id, secondAgain.capability)).toBe(true)
  })

  it('throttles wrong secondary-password guesses per auth session and resets after success', async () => {
    closeAuthTestContext(context)
    let now = 1_700_000_000_000
    context = createAuthenticatedTestContext({
      now: () => now,
      rateLimiterOptions: { threshold: 2, baseRetryMs: 1_000, maxDelayMs: 5_000 },
    })
    await app.fetch(protectedJson('/api/diary/access/setup', { password: PASSWORD }))
    await context.runtime.diaryAccess.lock(context.session.id)

    const firstWrong = await app.fetch(protectedJson('/api/diary/access/unlock', { password: 'wrong-password-one' }))
    const limited = await app.fetch(protectedJson('/api/diary/access/unlock', { password: 'wrong-password-two' }))
    expect(firstWrong.status).toBe(401)
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('1')

    const secondSession = createSession(context.db, context.userId, { now })
    await expect(context.runtime.diaryAccess.unlock(secondSession.session.id, 'wrong-password-three'))
      .rejects.toMatchObject({ status: 401 })

    now += 1_001
    await expect(context.runtime.diaryAccess.unlock(context.session.id, PASSWORD)).resolves.toMatchObject({ state: 'UNLOCKED' })
    await context.runtime.diaryAccess.lock(context.session.id)
    await expect(context.runtime.diaryAccess.unlock(context.session.id, 'wrong-password-again'))
      .rejects.toMatchObject({ status: 401 })
    expect(context.runtime.diaryUnlockLimiter.size).toBeLessThanOrEqual(context.runtime.diaryUnlockLimiter.maxBuckets)
  })
})

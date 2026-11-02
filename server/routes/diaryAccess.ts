import { Hono } from 'hono'
import { getAuthRuntime } from '../auth/runtime.js'
import {
  clearDiaryRememberCookie,
  readDiaryRememberCookie,
  setDiaryRememberCookie,
} from '../diaryAccess/rememberCookie.js'
import {
  DiaryAccessServiceError,
  readDiaryAccessCapability,
} from '../diaryAccess/service.js'

const diaryAccessRoutes = new Hono()

function noStore(c: any): void {
  c.header('Cache-Control', 'no-store')
}

function sessionId(c: any): number {
  return c.get('authSessionId')
}

function runtimeOrError(c: any) {
  const runtime = getAuthRuntime()
  if (runtime) return { runtime, response: null }
  noStore(c)
  return {
    runtime: null,
    response: c.json({ error: 'Diary access is temporarily unavailable.', code: 'diary-access-unavailable' }, 503),
  }
}

function serviceError(c: any, error: unknown): Response {
  noStore(c)
  if (error instanceof DiaryAccessServiceError) {
    if (error.retryAfterMs !== undefined) {
      c.header('Retry-After', String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))))
    }
    return c.json({ error: error.message, code: error.code }, error.status)
  }
  return c.json({ error: 'Diary access is temporarily unavailable.', code: 'diary-access-unavailable' }, 503)
}

diaryAccessRoutes.get('/api/diary/access/status', (c) => {
  const resolved = runtimeOrError(c)
  if (!resolved.runtime) return resolved.response
  try {
    const state = resolved.runtime.diaryAccess.status(
      sessionId(c),
      readDiaryAccessCapability(c.req.raw.headers),
    )
    noStore(c)
    return c.json(state)
  } catch (error) {
    return serviceError(c, error)
  }
})

async function parseAccessPayload(c: any): Promise<{ password: unknown; rememberDevice: boolean }> {
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { password: undefined, rememberDevice: false }
  }
  const payload = body as Record<string, unknown>
  return { password: payload.password, rememberDevice: payload.rememberDevice === true }
}

function respondUnlocked(c: any, runtime: NonNullable<ReturnType<typeof getAuthRuntime>>, session: number, result: {
  state: 'UNLOCKED'; capability: string; epoch: number
}, rememberDevice: boolean, status: 200 | 201 = 200): Response {
  if (rememberDevice) {
    const remembered = runtime.diaryAccess.rememberDevice(session, result.capability)
    setDiaryRememberCookie(c, runtime.config.cookie.secure, remembered)
  } else {
    clearDiaryRememberCookie(c, runtime.config.cookie.secure)
  }
  noStore(c)
  return c.json(result, status)
}

diaryAccessRoutes.post('/api/diary/access/setup', async (c) => {
  const resolved = runtimeOrError(c)
  if (!resolved.runtime) return resolved.response
  try {
    const payload = await parseAccessPayload(c)
    const result = await resolved.runtime.diaryAccess.setup(sessionId(c), payload.password, c.req.raw.signal)
    return respondUnlocked(c, resolved.runtime, sessionId(c), result, payload.rememberDevice, 201)
  } catch (error) {
    return serviceError(c, error)
  }
})

diaryAccessRoutes.post('/api/diary/access/unlock', async (c) => {
  const resolved = runtimeOrError(c)
  if (!resolved.runtime) return resolved.response
  try {
    const payload = await parseAccessPayload(c)
    const result = await resolved.runtime.diaryAccess.unlock(sessionId(c), payload.password, c.req.raw.signal)
    return respondUnlocked(c, resolved.runtime, sessionId(c), result, payload.rememberDevice)
  } catch (error) {
    return serviceError(c, error)
  }
})

// Never expose a restored capability on GET: only an authenticated,
// same-origin POST may exchange the HttpOnly device token for the original
// process-local, session-bound capability.
diaryAccessRoutes.post('/api/diary/access/resume', (c) => {
  const resolved = runtimeOrError(c)
  if (!resolved.runtime) return resolved.response
  try {
    const secure = resolved.runtime.config.cookie.secure
    const result = resolved.runtime.diaryAccess.resumeRememberedDevice(
      sessionId(c),
      readDiaryRememberCookie(c, secure),
    )
    if (result.state !== 'UNLOCKED') clearDiaryRememberCookie(c, secure)
    noStore(c)
    return c.json(result)
  } catch (error) {
    return serviceError(c, error)
  }
})

diaryAccessRoutes.post('/api/diary/access/lock', async (c) => {
  const resolved = runtimeOrError(c)
  if (!resolved.runtime) return resolved.response
  try {
    const result = await resolved.runtime.diaryAccess.lock(sessionId(c))
    clearDiaryRememberCookie(c, resolved.runtime.config.cookie.secure)
    noStore(c)
    return c.json(result)
  } catch (error) {
    return serviceError(c, error)
  }
})

export default diaryAccessRoutes

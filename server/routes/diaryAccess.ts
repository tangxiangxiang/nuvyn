import { Hono } from 'hono'
import { getAuthRuntime } from '../auth/runtime.js'
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

async function parsePassword(c: any): Promise<unknown> {
  const body = await c.req.json().catch(() => null)
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>).password
    : undefined
}

diaryAccessRoutes.post('/api/diary/access/setup', async (c) => {
  const resolved = runtimeOrError(c)
  if (!resolved.runtime) return resolved.response
  try {
    const result = await resolved.runtime.diaryAccess.setup(sessionId(c), await parsePassword(c), c.req.raw.signal)
    noStore(c)
    return c.json(result, 201)
  } catch (error) {
    return serviceError(c, error)
  }
})

diaryAccessRoutes.post('/api/diary/access/unlock', async (c) => {
  const resolved = runtimeOrError(c)
  if (!resolved.runtime) return resolved.response
  try {
    const result = await resolved.runtime.diaryAccess.unlock(sessionId(c), await parsePassword(c), c.req.raw.signal)
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
    noStore(c)
    return c.json(result)
  } catch (error) {
    return serviceError(c, error)
  }
})

export default diaryAccessRoutes

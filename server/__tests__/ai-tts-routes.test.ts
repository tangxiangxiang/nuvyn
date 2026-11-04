import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { applyMigrations } from '../db'
import { createAiProfile, saveAiSpeechSettings } from '../ai/profiles'
import { resetNoteTtsLimitsForTesting } from '../ai/tts'
import { authBoundary } from '../auth/middleware'
import { authenticatedRequest, closeAuthTestContext, createAuthenticatedTestContext } from './helpers/auth'

const { testDbRef } = vi.hoisted(() => ({ testDbRef: { value: null as Database.Database | null } }))

vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>()
  return { ...actual, getDb: () => testDbRef.value! }
})

import aiRoutes from '../ai/routes'

const MASTER_KEY = '6b'.repeat(32)
const originalMasterKey = process.env.NUVYN_MASTER_KEY
const originalMasterKeyFile = process.env.NUVYN_MASTER_KEY_FILE
const originalFetch = globalThis.fetch
let db: Database.Database

type Vars = { authUser: { id: number; username: string }; authSessionId: number }
function authenticatedApp() {
  const app = new Hono<{ Variables: Vars }>()
  app.use('*', async (c, next) => {
    c.set('authUser', { id: 1, username: 'fixture' })
    c.set('authSessionId', 1)
    await next()
  })
  app.route('/api/ai', aiRoutes)
  return app
}

beforeEach(() => {
  process.env.NUVYN_MASTER_KEY = MASTER_KEY
  delete process.env.NUVYN_MASTER_KEY_FILE
  db = new Database(':memory:')
  applyMigrations(db)
  testDbRef.value = db
  resetNoteTtsLimitsForTesting()
})

afterEach(() => {
  db.close()
  testDbRef.value = null
  resetNoteTtsLimitsForTesting()
  globalThis.fetch = originalFetch
  if (originalMasterKey === undefined) delete process.env.NUVYN_MASTER_KEY
  else process.env.NUVYN_MASTER_KEY = originalMasterKey
  if (originalMasterKeyFile === undefined) delete process.env.NUVYN_MASTER_KEY_FILE
  else process.env.NUVYN_MASTER_KEY_FILE = originalMasterKeyFile
})

function request(app: Hono, method: string, pathname: string, body?: unknown) {
  return app.fetch(new Request(`http://localhost${pathname}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }))
}

function configuredSpeech() {
  const profile = createAiProfile(db, {
    name: 'Speech profile',
    provider: 'anthropic',
    apiKey: 'sk-cp-route-test-key',
  })
  return profile
}

describe('Note TTS routes', () => {
  it('accepts the numeric owner identity from a real authenticated session without invalidating it', async () => {
    const context = createAuthenticatedTestContext({ db })
    const app = new Hono()
    app.use('/api/*', authBoundary)
    app.route('/api/ai', aiRoutes)
    try {
      const profile = configuredSpeech()
      const get = await app.fetch(authenticatedRequest(context, '/api/ai/tts/settings', { method: 'GET' }))
      expect(get.status).toBe(200)
      const save = await app.fetch(authenticatedRequest(context, '/api/ai/tts/settings', {
        method: 'PUT', origin: context.runtime.config.allowedOrigins[0],
        body: { profileId: profile.id, privacyConsent: true },
      }))
      expect(save.status).toBe(200)
      globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
        data: { audio: '4944330400000000' }, base_resp: { status_code: 0 },
      }))) as unknown as typeof fetch
      const speech = await app.fetch(authenticatedRequest(context, '/api/ai/tts/synthesize', {
        method: 'POST', origin: context.runtime.config.allowedOrigins[0], body: { text: '正常登录的朗读请求' },
      }))
      expect(speech.status).toBe(200)
      expect(speech.headers.get('content-type')).toBe('audio/mpeg')
      const after = await app.fetch(authenticatedRequest(context, '/api/ai/tts/settings', { method: 'GET' }))
      expect(after.status).toBe(200)
      const anonymous = await request(app, 'GET', '/api/ai/tts/settings')
      expect(anonymous.status).toBe(401)
    } finally {
      closeAuthTestContext(context)
    }
  })

  it('requires authentication for reading and changing speech settings and synthesis', async () => {
    const get = await request(aiRoutes, 'GET', '/tts/settings')
    const put = await request(aiRoutes, 'PUT', '/tts/settings', { profileId: null, privacyConsent: false })
    const post = await request(aiRoutes, 'POST', '/tts/synthesize', { text: 'text' })
    for (const response of [get, put, post]) {
      expect(response.status).toBe(401)
      expect(await response.json()).toMatchObject({ code: 'auth-session-required' })
    }
  })

  it('persists explicit settings, enforces saved consent server-side, and returns MP3 bytes', async () => {
    const profile = configuredSpeech()
    const app = authenticatedApp()
    const settings = await request(app, 'GET', '/api/ai/tts/settings')
    expect(settings.status).toBe(200)
    expect(await settings.json()).toEqual({ profileId: null, privacyConsent: false })

    const blocked = await request(app, 'POST', '/api/ai/tts/synthesize', { text: 'must not be sent' })
    expect(blocked.status).toBe(403)
    expect(await blocked.json()).toMatchObject({ code: 'tts-privacy-consent-required' })

    const save = await request(app, 'PUT', '/api/ai/tts/settings', { profileId: profile.id, privacyConsent: true })
    expect(save.status).toBe(200)
    expect(await save.json()).toEqual({ profileId: profile.id, privacyConsent: true })

    const bytes = Buffer.from('4944330400000000', 'hex')
    const upstream = vi.fn(async () => new Response(JSON.stringify({
      data: { audio: bytes.toString('hex') },
      base_resp: { status_code: 0 },
    }), { status: 200 }))
    globalThis.fetch = upstream as unknown as typeof fetch
    const response = await request(app, 'POST', '/api/ai/tts/synthesize', { text: '已同意的内容' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('audio/mpeg')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
    expect(upstream).toHaveBeenCalledTimes(1)

    const revoke = await request(app, 'PUT', '/api/ai/tts/settings', { profileId: profile.id, privacyConsent: false })
    expect(revoke.status).toBe(200)
    const revoked = await request(app, 'POST', '/api/ai/tts/synthesize', { text: 'now blocked' })
    expect(revoked.status).toBe(403)
    expect(upstream).toHaveBeenCalledTimes(1)
  })

  it('rejects unbound profiles, extra credential fields, and oversized text', async () => {
    const app = authenticatedApp()
    const profile = configuredSpeech()
    saveAiSpeechSettings(db, { profileId: null, privacyConsent: true })
    const missing = await request(app, 'POST', '/api/ai/tts/synthesize', { text: 'no implicit default' })
    expect(missing.status).toBe(503)
    expect(await missing.json()).toMatchObject({ code: 'ai-speech-profile-missing' })

    saveAiSpeechSettings(db, { profileId: profile.id, privacyConsent: true })
    const extra = await request(app, 'POST', '/api/ai/tts/synthesize', { text: 'text', apiKey: 'sk-secret' })
    expect(extra.status).toBe(400)
    expect(await extra.json()).toMatchObject({ code: 'tts-invalid-request' })
    const longText = await request(app, 'POST', '/api/ai/tts/synthesize', { text: '甲'.repeat(801) })
    expect(longText.status).toBe(413)
    expect(await longText.json()).toMatchObject({ code: 'tts-text-too-long' })
  })

  it('does not expose upstream bodies when provider requests fail', async () => {
    const profile = configuredSpeech()
    saveAiSpeechSettings(db, { profileId: profile.id, privacyConsent: true })
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      error: 'secret provider details',
      api_key: 'sk-cp-route-test-key',
    }), { status: 500 })) as unknown as typeof fetch
    const response = await request(authenticatedApp(), 'POST', '/api/ai/tts/synthesize', { text: 'safe text' })
    const body = await response.text()
    expect(response.status).toBe(502)
    expect(body).toContain('tts-provider-error')
    expect(body).not.toContain('secret provider details')
    expect(body).not.toContain('sk-cp-route-test-key')
    expect(body).not.toContain('safe text')
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyMigrations } from '../db'
import { createAiProfile, saveAiSpeechSettings } from '../ai/profiles'
import { acquireNoteTtsSlot, resetNoteTtsLimitsForTesting, noteSpeechParameters, NOTE_TTS_PARAMETERS } from '../ai/tts'
import { noteTtsCache, noteTtsCacheKey } from '../ai/ttsCache'
import { authBoundary } from '../auth/middleware'
import { authenticatedRequest, closeAuthTestContext, createAuthenticatedTestContext } from './helpers/auth'

const { testDbRef, cacheRoot } = vi.hoisted(() => ({ testDbRef: { value: null as Database.Database | null }, cacheRoot: { value: '' } }))

vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>()
  return { ...actual, getDb: () => testDbRef.value!, getDataDir: () => cacheRoot.value }
})

import aiRoutes from '../ai/routes'

const MASTER_KEY = '6b'.repeat(32)
const originalMasterKey = process.env.NUVYN_MASTER_KEY
const originalMasterKeyFile = process.env.NUVYN_MASTER_KEY_FILE
const originalFetch = globalThis.fetch
let db: Database.Database

type Vars = { authUser: { id: number; username: string }; authSessionId: number }
function authenticatedApp(userId = 1) {
  const app = new Hono<{ Variables: Vars }>()
  app.use('*', async (c, next) => {
    c.set('authUser', { id: userId, username: 'fixture' })
    c.set('authSessionId', 1)
    await next()
  })
  app.route('/api/ai', aiRoutes)
  return app
}

beforeEach(() => {
  cacheRoot.value = mkdtempSync(path.join(os.tmpdir(), 'nuvyn-tts-route-'))
  process.env.NUVYN_MASTER_KEY = MASTER_KEY
  delete process.env.NUVYN_MASTER_KEY_FILE
  db = new Database(':memory:')
  applyMigrations(db)
  testDbRef.value = db
  resetNoteTtsLimitsForTesting()
})

afterEach(async () => {
  await noteTtsCache.clear(1)
  rmSync(cacheRoot.value, { recursive: true, force: true })
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
  it('validates and protects persistent pronunciation settings with authentication and Origin checks', async () => {
    const context = createAuthenticatedTestContext({ db })
    const app = new Hono()
    app.use('/api/*', authBoundary)
    app.route('/api/ai', aiRoutes)
    try {
      expect((await request(app, 'GET', '/api/ai/tts/pronunciations')).status).toBe(401)
      expect((await request(app, 'PUT', '/api/ai/tts/pronunciations', [])).status).toBe(401)
      const rules = [{ id: 'tianmu', text: '天姥', pinyin: 'tian1 mu3' }]
      const put = (body: unknown, origin = context.runtime.config.allowedOrigins[0]) => app.fetch(authenticatedRequest(context, '/api/ai/tts/pronunciations', { method: 'PUT', origin, body }))
      expect((await put(rules, 'https://attacker.example')).status).toBe(403)
      expect((await put(rules)).status).toBe(200)
      const get = await app.fetch(authenticatedRequest(context, '/api/ai/tts/pronunciations', { method: 'GET' }))
      expect(get.headers.get('cache-control')).toBe('no-store')
      expect(await get.json()).toEqual(rules)
      expect((await put([...rules, ...rules])).status).toBe(400)
      expect((await put('x'.repeat(100_000))).status).toBe(413)
      expect((await put([])).status).toBe(200)
    } finally { closeAuthTestContext(context) }
  })


  it('validates voices, preserves old-client settings, and reuses the matching voice cache', async () => {
    const profile = configuredSpeech()
    const app = authenticatedApp()
    const settings = '/api/ai/tts/settings'
    const save = (voiceId?: string, privacyConsent = true) => request(app, 'PUT', settings, { profileId: profile.id, privacyConsent, ...(voiceId ? { voiceId } : {}) })
    expect((await save('invalid')).status).toBe(400)
    expect((await save()).status).toBe(200)
    const bytes = Buffer.concat([Buffer.from([255, 251, 144, 0]), Buffer.alloc(413)])
    const upstream = vi.fn(async (_url: unknown, _init: RequestInit) => new Response(JSON.stringify({ data: { audio: bytes.toString('hex') }, base_resp: { status_code: 0 } })))
    globalThis.fetch = upstream as typeof fetch
    const speak = async (voiceId?: string) => {
      const response = await request(app, 'POST', '/api/ai/tts/synthesize', { text: '天姥连天向天横。', ...(voiceId ? { voiceId } : {}) })
      expect(response.status).toBe(200)
      await response.arrayBuffer()
    }
    expect(noteTtsCacheKey('正文', noteSpeechParameters(db, '正文'))).toBe(noteTtsCacheKey('正文', NOTE_TTS_PARAMETERS))
    await speak(); await speak()
    expect(upstream).toHaveBeenCalledTimes(1)
    await save('audiobook_female_1')
    await speak(); await speak()
    expect(upstream).toHaveBeenCalledTimes(2)
    await speak('audiobook_male_1') // Existing task snapshot survives settings changes.
    expect(upstream).toHaveBeenCalledTimes(2)
    await save(undefined, false)
    expect(await (await request(app, 'GET', settings)).json()).toEqual({ profileId: profile.id, privacyConsent: false, voiceId: 'audiobook_female_1' })
    await save('audiobook_male_1')
    await speak()
    expect(upstream).toHaveBeenCalledTimes(2)
    expect(upstream.mock.calls.map((call) => JSON.parse(call[1].body as string).voice_setting.voice_id)).toEqual(['audiobook_male_1', 'audiobook_female_1'])
    expect(JSON.parse(upstream.mock.calls[1]![1].body as string)).toMatchObject({ model: 'speech-2.8-turbo', audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 } })
    expect((await request(app, 'POST', '/api/ai/tts/synthesize', { text: 'test', voiceId: 'arbitrary' })).status).toBe(400)
  })

  it('restricts corrupt dictionary recovery to authenticated same-origin users', async () => {
    const context = createAuthenticatedTestContext({ db })
    const app = new Hono()
    app.use('/api/*', authBoundary)
    app.route('/api/ai', aiRoutes)
    const endpoint = '/api/ai/tts/pronunciations/reset'
    try {
      expect((await request(app, 'POST', endpoint)).status).toBe(401)
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('ai.speech.pronunciations.v1', '{broken')
      const send = (origin: string) => app.fetch(authenticatedRequest(context, endpoint, { method: 'POST', origin }))
      expect((await send('https://attacker.example')).status).toBe(403)
      const error = await app.fetch(authenticatedRequest(context, '/api/ai/tts/pronunciations', { method: 'GET' }))
      expect(await error.json()).toMatchObject({ code: 'tts-pronunciations-corrupt' })
      const recovered = await send(context.runtime.config.allowedOrigins[0]!)
      expect(recovered.status).toBe(200)
      expect(await recovered.json()).toEqual([])
      expect((await send(context.runtime.config.allowedOrigins[0]!)).status).toBe(409)
    } finally { closeAuthTestContext(context) }
  })
  it('uses only effective pronunciation rules for both cached audio and actual MiniMax requests', async () => {
    const profile = configuredSpeech()
    saveAiSpeechSettings(db, { profileId: profile.id, privacyConsent: true })
    const app = authenticatedApp()
    const bytes = Buffer.concat([Buffer.from([255, 251, 144, 0]), Buffer.alloc(413)])
    const upstream = vi.fn(async () => new Response(JSON.stringify({ data: { audio: bytes.toString('hex') }, base_resp: { status_code: 0 } })))
    globalThis.fetch = upstream as unknown as typeof fetch
    const speak = async (text = '梦游天姥吟留别。', target = app) => {
      const response = await request(target, 'POST', '/api/ai/tts/synthesize', { text })
      expect(response.status).toBe(200)
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
    }
    const rule = { id: 'tianmu', text: '天姥', pinyin: 'tian1 mu3' }
    const save = async (rules: unknown) => expect((await request(app, 'PUT', '/api/ai/tts/pronunciations', rules)).status).toBe(200)
    await speak()
    await speak()
    await speak('势拔五岳掩赤城。')
    expect(upstream).toHaveBeenCalledTimes(2)
    await save([rule])
    await Promise.all([speak(), speak()])
    expect(upstream).toHaveBeenCalledTimes(3)
    const body = JSON.parse((upstream.mock.calls[2] as unknown as [string, RequestInit])[1].body as string)
    expect(body).toMatchObject({ text: '梦游天姥吟留别。', pronunciation_dict: { tone: ['天姥/(tian1)(mu3)'] }, model: 'speech-2.8-turbo', voice_setting: { voice_id: 'audiobook_male_1' }, audio_setting: { sample_rate: 32000, format: 'mp3' } })
    expect(JSON.parse((upstream.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).not.toHaveProperty('pronunciation_dict')
    await speak()
    await speak('势拔五岳掩赤城。')
    await save([rule, { id: 'chongqing', text: '重庆', pinyin: 'chong2 qing4' }])
    await speak()
    expect(upstream).toHaveBeenCalledTimes(3)
    await save([{ ...rule, pinyin: 'tian1 lao3' }])
    await speak()
    expect(upstream).toHaveBeenCalledTimes(4)
    await save([])
    await speak()
    expect(upstream).toHaveBeenCalledTimes(4)
    await speak('梦游天姥吟留别。', authenticatedApp(2))
    expect(upstream).toHaveBeenCalledTimes(5)
    await noteTtsCache.clear(2)
  })

  it('keeps in-flight rule snapshots and cache identity stable while the dictionary changes', async () => {
    const profile = configuredSpeech()
    saveAiSpeechSettings(db, { profileId: profile.id, privacyConsent: true })
    const app = authenticatedApp()
    const rule = { id: 'tianmu', text: '天姥', pinyin: 'tian1 mu3' }
    await request(app, 'PUT', '/api/ai/tts/pronunciations', [rule])
    const bytes = Buffer.concat([Buffer.from([255, 251, 144, 0]), Buffer.alloc(413)])
    let release!: () => void
    const started = new Promise<void>((resolve) => { release = resolve })
    let complete!: (response: Response) => void
    const upstream = vi.fn(() => { release(); return new Promise<Response>((resolve) => { complete = resolve }) })
    globalThis.fetch = upstream as unknown as typeof fetch
    const pending = request(app, 'POST', '/api/ai/tts/synthesize', { text: '天姥' })
    await started
    await request(app, 'PUT', '/api/ai/tts/pronunciations', [{ ...rule, pinyin: 'tian1 lao3' }])
    complete(new Response(JSON.stringify({ data: { audio: bytes.toString('hex') }, base_resp: { status_code: 0 } })))
    expect((await pending).status).toBe(200)
    const next = request(app, 'POST', '/api/ai/tts/synthesize', { text: '天姥' })
    await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(2))
    complete(new Response(JSON.stringify({ data: { audio: bytes.toString('hex') }, base_resp: { status_code: 0 } })))
    expect((await next).status).toBe(200)
    expect(upstream.mock.calls.map((call) => JSON.parse((call as unknown as [string, RequestInit])[1].body as string).pronunciation_dict.tone))
      .toEqual([['天姥/(tian1)(mu3)'], ['天姥/(tian1)(lao3)']])
    await request(app, 'PUT', '/api/ai/tts/pronunciations', [rule])
    expect((await request(app, 'POST', '/api/ai/tts/synthesize', { text: '天姥' })).status).toBe(200)
    expect(upstream).toHaveBeenCalledTimes(2)
  })

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
    expect(await settings.json()).toEqual({ profileId: null, privacyConsent: false, voiceId: 'audiobook_male_1' })

    const blocked = await request(app, 'POST', '/api/ai/tts/synthesize', { text: 'must not be sent' })
    expect(blocked.status).toBe(403)
    expect(await blocked.json()).toMatchObject({ code: 'tts-privacy-consent-required' })

    const save = await request(app, 'PUT', '/api/ai/tts/settings', { profileId: profile.id, privacyConsent: true })
    expect(save.status).toBe(200)
    expect(await save.json()).toEqual({ profileId: profile.id, privacyConsent: true, voiceId: 'audiobook_male_1' })

    const bytes = Buffer.concat([Buffer.from([255, 251, 144, 0]), Buffer.alloc(413)])
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

    // Hits bypass synthesis quota/concurrency but still enforce consent below.
    const release = acquireNoteTtsSlot('1')
    try {
      const hit = await request(app, 'POST', '/api/ai/tts/synthesize', { text: '已同意的内容' })
      expect(hit.status).toBe(200)
      expect(hit.headers.get('content-type')).toBe('audio/mpeg')
      expect(Buffer.from(await hit.arrayBuffer())).toEqual(bytes)
      const miss = await request(app, 'POST', '/api/ai/tts/synthesize', { text: 'different' })
      expect(miss.status).toBe(429)
      expect(upstream).toHaveBeenCalledTimes(1)
    } finally { release() }
    expect(await (await request(app, 'GET', '/api/ai/tts/cache')).json()).toMatchObject({ bytes: bytes.length })

    const revoke = await request(app, 'PUT', '/api/ai/tts/settings', { profileId: profile.id, privacyConsent: false })
    expect(revoke.status).toBe(200)
    const revoked = await request(app, 'POST', '/api/ai/tts/synthesize', { text: '已同意的内容' })
    expect(revoked.status).toBe(403)
    expect(upstream).toHaveBeenCalledTimes(1)
  })

  it('protects cache administration with the real authentication and Origin boundary', async () => {
    const context = createAuthenticatedTestContext({ db })
    const app = new Hono()
    app.use('/api/*', authBoundary)
    app.route('/api/ai', aiRoutes)
    try {
      expect((await request(app, 'GET', '/api/ai/tts/cache')).status).toBe(401)
      expect((await request(app, 'DELETE', '/api/ai/tts/cache')).status).toBe(401)
      const denied = await app.fetch(authenticatedRequest(context, '/api/ai/tts/cache', { method: 'DELETE', origin: 'https://attacker.example' }))
      expect(denied.status).toBe(403)
      const clear = await app.fetch(authenticatedRequest(context, '/api/ai/tts/cache', { method: 'DELETE', origin: context.runtime.config.allowedOrigins[0] }))
      expect(clear.status).toBe(200)
      expect(await clear.json()).toMatchObject({ bytes: 0 })
    } finally { closeAuthTestContext(context) }
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

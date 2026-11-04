import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyMigrations } from '../db'
import { createAiProfile, saveAiSpeechSettings } from '../ai/profiles'
import { acquireNoteTtsSlot, NOTE_TTS_LIMITS, resetNoteTtsLimitsForTesting, synthesizeNoteSpeech } from '../ai/tts'

const TEST_MASTER_KEY = '5a'.repeat(32)
const originalMasterKey = process.env.NUVYN_MASTER_KEY
const originalMasterKeyFile = process.env.NUVYN_MASTER_KEY_FILE
let db: Database.Database

beforeEach(() => {
  process.env.NUVYN_MASTER_KEY = TEST_MASTER_KEY
  delete process.env.NUVYN_MASTER_KEY_FILE
  db = new Database(':memory:')
  applyMigrations(db)
  const profile = createAiProfile(db, {
    name: 'Speech fixture',
    provider: 'anthropic',
    apiKey: 'sk-cp-test-subscription-key',
  })
  saveAiSpeechSettings(db, { profileId: profile.id, privacyConsent: true })
  resetNoteTtsLimitsForTesting()
})

afterEach(() => {
  db.close()
  resetNoteTtsLimitsForTesting()
  vi.useRealTimers()
  if (originalMasterKey === undefined) delete process.env.NUVYN_MASTER_KEY
  else process.env.NUVYN_MASTER_KEY = originalMasterKey
  if (originalMasterKeyFile === undefined) delete process.env.NUVYN_MASTER_KEY_FILE
  else process.env.NUVYN_MASTER_KEY_FILE = originalMasterKeyFile
})

const providerResponse = (audioHex = '4944330400000000') => new Response(JSON.stringify({
  data: { audio: audioHex },
  base_resp: { status_code: 0, status_msg: 'success' },
}), { status: 200, headers: { 'content-type': 'application/json' } })

describe('MiniMax Note TTS service', () => {
  it('uses the fixed MiniMax endpoint and speech parameters, then decodes MP3 hex', async () => {
    const fetcher = vi.fn(async () => providerResponse())
    const audio = await synthesizeNoteSpeech(db, '朗读内容', undefined, fetcher as unknown as typeof fetch)

    expect(Buffer.from(audio).toString('hex')).toBe('4944330400000000')
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.minimaxi.com/v1/t2a_v2')
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('error')
    expect(init.headers).toEqual({
      Authorization: 'Bearer sk-cp-test-subscription-key',
      'Content-Type': 'application/json',
    })
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'speech-2.8-turbo',
      text: '朗读内容',
      stream: false,
      voice_setting: { voice_id: 'audiobook_male_1', speed: 1, vol: 1, pitch: 0 },
      audio_setting: { sample_rate: 32_000, bitrate: 128_000, format: 'mp3', channel: 1 },
      language_boost: 'Chinese',
      subtitle_enable: false,
    })
  })

  it('rejects blank and over-limit text before issuing provider requests', async () => {
    const fetcher = vi.fn()
    await expect(synthesizeNoteSpeech(db, ' \t\n', undefined, fetcher as typeof fetch))
      .rejects.toMatchObject({ code: 'tts-empty-text', status: 400 })
    await expect(synthesizeNoteSpeech(db, '甲'.repeat(NOTE_TTS_LIMITS.requestChars + 1), undefined, fetcher as typeof fetch))
      .rejects.toMatchObject({ code: 'tts-text-too-long', status: 413 })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects provider errors and malformed or oversized audio responses', async () => {
    await expect(synthesizeNoteSpeech(db, 'text', undefined, vi.fn(async () => new Response('{}', { status: 503 })) as typeof fetch))
      .rejects.toMatchObject({ code: 'tts-provider-error', status: 502 })
    await expect(synthesizeNoteSpeech(db, 'text', undefined, vi.fn(async () => providerResponse('xyz')) as typeof fetch))
      .rejects.toMatchObject({ code: 'tts-invalid-audio', status: 502 })
    const oversized = vi.fn(async () => new Response('{}', {
      status: 200,
      headers: { 'content-length': String(NOTE_TTS_LIMITS.responseHexChars + 1) },
    }))
    await expect(synthesizeNoteSpeech(db, 'text', undefined, oversized as typeof fetch))
      .rejects.toMatchObject({ code: 'tts-upstream-too-large', status: 502 })
  })

  it('maps client cancellation and provider timeout without exposing provider details', async () => {
    const controller = new AbortController()
    const fetcher = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true })
    }))
    const cancelled = synthesizeNoteSpeech(db, 'text', controller.signal, fetcher as typeof fetch)
    const cancellationAssertion = expect(cancelled).rejects.toMatchObject({ code: 'tts-cancelled', status: 499 })
    controller.abort()
    await cancellationAssertion

    vi.useFakeTimers()
    const hanging = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'AbortError')), { once: true })
    }))
    const timed = synthesizeNoteSpeech(db, 'text', undefined, hanging as typeof fetch)
    const timeoutAssertion = expect(timed).rejects.toMatchObject({ code: 'tts-timeout', status: 504 })
    await vi.advanceTimersByTimeAsync(NOTE_TTS_LIMITS.requestTimeoutMs)
    await timeoutAssertion
  })

  it('limits active requests and request rate per authenticated-user key', () => {
    const release = acquireNoteTtsSlot('user-a', 100_000)
    expect(() => acquireNoteTtsSlot('user-a', 100_000)).toThrowError(expect.objectContaining({ code: 'tts-concurrency-limit' }))
    release()

    const now = Date.now()
    for (let index = 0; index < NOTE_TTS_LIMITS.requestsPerMinute; index += 1) {
      acquireNoteTtsSlot('user-b', now)()
    }
    expect(() => acquireNoteTtsSlot('user-b', now)).toThrowError(expect.objectContaining({ code: 'tts-rate-limit' }))
  })
})

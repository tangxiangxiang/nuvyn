import type { Database } from 'better-sqlite3'
import { AiKeyConfigurationError } from './settings.js'
import { aiSpeechRuntime, AiProfileError } from './profiles.js'

export const NOTE_TTS_LIMITS = {
  requestChars: 800,
  requestBodyBytes: 8 * 1024,
  responseHexChars: 8 * 1024 * 1024,
  requestTimeoutMs: 45_000,
  requestsPerMinute: 60,
  concurrencyPerUser: 1,
} as const

const MINIMAX_TTS_URL = 'https://api.minimaxi.com/v1/t2a_v2'
const TTS_MODEL = 'speech-2.8-turbo'
const TTS_VOICE = 'audiobook_male_1'

export class NoteTtsError extends Error {
  readonly code: string
  readonly status: number
  readonly retryAfterSeconds?: number

  constructor(code: string, message: string, status: number, retryAfterSeconds?: number) {
    super(message)
    this.name = 'NoteTtsError'
    this.code = code
    this.status = status
    this.retryAfterSeconds = retryAfterSeconds
  }
}

type UserTtsWindow = { active: number; requests: number[] }
const userWindows = new Map<string, UserTtsWindow>()

/** Process-local limiter: one active synthesis and a bounded request rate per authenticated user. */
export function acquireNoteTtsSlot(userId: string, now = Date.now()): () => void {
  let window = userWindows.get(userId)
  if (!window) {
    window = { active: 0, requests: [] }
    userWindows.set(userId, window)
  }
  window.requests = window.requests.filter((at) => now - at < 60_000)
  if (window.active >= NOTE_TTS_LIMITS.concurrencyPerUser) {
    throw new NoteTtsError('tts-concurrency-limit', 'Another speech request is already running', 429, 2)
  }
  if (window.requests.length >= NOTE_TTS_LIMITS.requestsPerMinute) {
    const retryAfter = Math.max(1, Math.ceil((window.requests[0]! + 60_000 - now) / 1000))
    throw new NoteTtsError('tts-rate-limit', 'Speech request limit reached', 429, retryAfter)
  }
  window.active += 1
  window.requests.push(now)
  let released = false
  return () => {
    if (released) return
    released = true
    const current = userWindows.get(userId)
    if (current) {
      current.active = Math.max(0, current.active - 1)
      current.requests = current.requests.filter((at) => Date.now() - at < 60_000)
      if (!current.active && !current.requests.length) userWindows.delete(userId)
    }
  }
}

export function resetNoteTtsLimitsForTesting(): void {
  userWindows.clear()
}

function linkedTimeout(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController()
  let timedOut = false
  const onAbort = () => controller.abort(parent?.reason)
  if (parent?.aborted) onAbort()
  else parent?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new DOMException('Request timed out', 'TimeoutError'))
  }, timeoutMs)
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer)
      parent?.removeEventListener('abort', onAbort)
    },
  }
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel()
    throw new NoteTtsError('tts-upstream-too-large', 'Speech provider response exceeded the size limit', 502)
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        throw new NoteTtsError('tts-upstream-too-large', 'Speech provider response exceeded the size limit', 502)
      }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
    return text
  } finally {
    reader.releaseLock()
  }
}

function decodeAudioHex(value: unknown): Uint8Array {
  if (typeof value !== 'string' || value.length < 8 || value.length % 2 !== 0
    || value.length > NOTE_TTS_LIMITS.responseHexChars || !/^[0-9a-f]+$/i.test(value)) {
    throw new NoteTtsError('tts-invalid-audio', 'Speech provider returned invalid audio data', 502)
  }
  return Uint8Array.from(Buffer.from(value, 'hex'))
}

function parseProviderResponse(raw: string): { data?: { audio?: unknown }; base_resp?: { status_code?: unknown } } {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid object')
    return parsed as { data?: { audio?: unknown }; base_resp?: { status_code?: unknown } }
  } catch {
    throw new NoteTtsError('tts-provider-error', 'Speech provider returned an invalid response', 502)
  }
}

export async function synthesizeNoteSpeech(
  db: Database,
  text: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<Uint8Array> {
  const textLength = [...text].length
  if (textLength === 0 || !text.trim()) throw new NoteTtsError('tts-empty-text', 'Text is empty', 400)
  if (textLength > NOTE_TTS_LIMITS.requestChars) {
    throw new NoteTtsError('tts-text-too-long', 'Speech segment exceeds 800 Unicode characters', 413)
  }
  let runtime
  try {
    runtime = aiSpeechRuntime(db)
  } catch (error) {
    if (error instanceof AiProfileError) throw error
    if (error instanceof AiKeyConfigurationError) {
      throw new NoteTtsError(error.code, 'The selected speech credential is unavailable', 503)
    }
    throw error
  }

  const request = linkedTimeout(signal, NOTE_TTS_LIMITS.requestTimeoutMs)
  try {
    if (signal?.aborted) throw new NoteTtsError('tts-cancelled', 'Speech request was cancelled', 499)
    let response: Response
    try {
      response = await fetchImpl(MINIMAX_TTS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${runtime.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: TTS_MODEL,
          text,
          stream: false,
          voice_setting: { voice_id: TTS_VOICE, speed: 1, vol: 1, pitch: 0 },
          audio_setting: { sample_rate: 32_000, bitrate: 128_000, format: 'mp3', channel: 1 },
          language_boost: 'Chinese',
          subtitle_enable: false,
        }),
        signal: request.signal,
        redirect: 'error',
      })
    } catch {
      if (request.timedOut()) throw new NoteTtsError('tts-timeout', 'Speech generation timed out', 504)
      if (signal?.aborted) throw new NoteTtsError('tts-cancelled', 'Speech request was cancelled', 499)
      throw new NoteTtsError('tts-provider-unavailable', 'Speech provider is temporarily unavailable', 502)
    }
    let raw: string
    try {
      raw = await readBoundedText(response, NOTE_TTS_LIMITS.responseHexChars)
    } catch (error) {
      if (error instanceof NoteTtsError) throw error
      if (request.timedOut()) throw new NoteTtsError('tts-timeout', 'Speech generation timed out', 504)
      if (signal?.aborted) throw new NoteTtsError('tts-cancelled', 'Speech request was cancelled', 499)
      throw new NoteTtsError('tts-provider-unavailable', 'Speech provider is temporarily unavailable', 502)
    }
    const result = parseProviderResponse(raw)
    if (!response.ok || result.base_resp?.status_code !== 0) {
      throw new NoteTtsError('tts-provider-error', 'Speech generation failed at the provider', 502)
    }
    return decodeAudioHex(result.data?.audio)
  } finally {
    request.cleanup()
  }
}

export const noteTtsProviderUrlForTesting = (): string => MINIMAX_TTS_URL

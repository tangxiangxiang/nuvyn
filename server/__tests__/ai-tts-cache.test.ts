import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { NOTE_TTS_CACHE_LIMITS, NoteTtsCache, noteTtsCacheKey, validCachedMp3 } from '../ai/ttsCache'
import { NOTE_TTS_PARAMETERS } from '../ai/tts'
import { splitNoteSpeechText } from '../../src/lib/noteSpeechText'

// One complete MPEG-1 Layer III frame (128 kbps, 44.1 kHz); no real provider calls.
const audio = Buffer.concat([Buffer.from([255, 251, 144, 0]), Buffer.alloc(413)])
let root: string
let now: number
let cache: NoteTtsCache
const filename = (user: number, text: string) => {
  const key = noteTtsCacheKey(text)
  return path.join(root, 'cache', 'tts', `user-${user}`, key.slice(0, 2), `${key}.mp3`)
}
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'nuvyn-tts-cache-'))
  now = Date.now()
  cache = new NoteTtsCache(() => root, { ...NOTE_TTS_CACHE_LIMITS }, () => now)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }); vi.restoreAllMocks() })

describe('persistent Note speech cache', () => {
  it('uses all synthesis parameters, but no browser playback rate or document identity', () => {
    const key = noteTtsCacheKey('相同正文')
    expect(key).toMatch(/^[a-f0-9]{64}$/)
    expect(noteTtsCacheKey('相同正文')).toBe(key)
    for (const parameters of [
      { ...NOTE_TTS_PARAMETERS, model: 'another-model' },
      { ...NOTE_TTS_PARAMETERS, voice_setting: { ...NOTE_TTS_PARAMETERS.voice_setting, voice_id: 'other' } },
      { ...NOTE_TTS_PARAMETERS, audio_setting: { ...NOTE_TTS_PARAMETERS.audio_setting, sample_rate: 24000 } },
      { ...NOTE_TTS_PARAMETERS, language_boost: 'English' },
    ]) expect(noteTtsCacheKey('相同正文', parameters)).not.toBe(key)
  })

  it('publishes privately and reuses audio across requests and recreated services, isolated by user', async () => {
    const generate = vi.fn(async () => audio)
    expect(await cache.get(1, '正文', undefined, generate)).toEqual(audio)
    expect((await stat(filename(1, '正文'))).mode & 0o777).toBe(0o600)
    expect(await cache.get(1, '正文', undefined, generate)).toEqual(audio)
    const restarted = new NoteTtsCache(() => root)
    expect(await restarted.get(1, '正文', undefined, generate)).toEqual(audio)
    expect(generate).toHaveBeenCalledTimes(1)
    await restarted.get(2, '正文', undefined, generate)
    expect(generate).toHaveBeenCalledTimes(2)
    expect(await readdir(path.dirname(filename(1, '正文')))).toEqual([path.basename(filename(1, '正文'))])
  })

  it('only synthesizes the changed natural paragraph, including after inserting a new first paragraph', async () => {
    const paragraphs = ['Java 的基本概念。', 'JVM 的作用。', '垃圾回收机制。']
    const generate = vi.fn(async () => audio)
    const read = async (parts: string[]) => {
      for (const segment of splitNoteSpeechText(parts.join('\n\n'))) await cache.get(1, segment, undefined, generate)
    }
    await read(paragraphs)
    expect(generate).toHaveBeenCalledTimes(3)
    await read(paragraphs)
    expect(generate).toHaveBeenCalledTimes(3)
    paragraphs[1] = 'JVM 的内存管理机制。'
    await read(paragraphs)
    expect(generate).toHaveBeenCalledTimes(4)
    await read(['新的开头。', ...paragraphs])
    expect(generate).toHaveBeenCalledTimes(5)
  })

  it('regenerates damaged and expired files, and rejects invalid cache scopes', async () => {
    const generate = vi.fn(async () => audio)
    await cache.get(1, '正文', undefined, generate)
    await writeFile(filename(1, '正文'), 'not mp3')
    await cache.get(1, '正文', undefined, generate)
    now += NOTE_TTS_CACHE_LIMITS.retentionMs + 1000
    await cache.get(1, '正文', undefined, generate)
    expect(generate).toHaveBeenCalledTimes(3)
    await expect(cache.get(-1, '正文', undefined, generate)).rejects.toThrow('Invalid cache scope')
  })

  it('does not cache empty, truncated, JSON, or oversized audio', async () => {
    for (const invalid of [Buffer.alloc(0), Buffer.from('ID3\x04\0\0\0\0'), audio.subarray(0, 100), Buffer.from('{"error":"failure"}'), Buffer.alloc(NOTE_TTS_CACHE_LIMITS.audioBytes + 1)]) {
      expect(validCachedMp3(invalid)).toBe(false)
      await cache.get(1, 'invalid', undefined, async () => invalid)
      await expect(stat(filename(1, 'invalid'))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    expect(validCachedMp3(audio)).toBe(true)
  })

  it('evicts least recently used audio within a per-user quota without touching another user', async () => {
    cache = new NoteTtsCache(() => root, { ...NOTE_TTS_CACHE_LIMITS, bytesPerUser: audio.length * 2 }, () => now)
    await cache.get(1, 'old', undefined, async () => audio)
    await utimes(filename(1, 'old'), new Date(now - 20000), new Date(now - 20000))
    await cache.get(1, 'recent', undefined, async () => audio)
    await cache.get(2, 'private', undefined, async () => audio)
    await cache.get(1, 'new', undefined, async () => audio)
    await expect(stat(filename(1, 'old'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(filename(2, 'private'))).toEqual(audio)
    expect((await cache.usage(1)).bytes).toBe(audio.length * 2)
  })

  it('touches hits for sliding expiration and removes stale temporary files only', async () => {
    await cache.get(1, 'touch', undefined, async () => audio)
    const old = new Date(now - NOTE_TTS_CACHE_LIMITS.retentionMs + 10000)
    await utimes(filename(1, 'touch'), old, old)
    await cache.get(1, 'touch', undefined, async () => { throw new Error('must hit') })
    const bucket = path.dirname(filename(1, 'touch'))
    const temp = path.join(bucket, `${noteTtsCacheKey('touch')}.00000000-0000-0000-0000-000000000000.tmp`)
    await writeFile(temp, audio)
    const stale = new Date(now - NOTE_TTS_CACHE_LIMITS.staleTempMs - 1000)
    await utimes(temp, stale, stale)
    now += 20000
    await cache.usage(1)
    await expect(stat(temp)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(filename(1, 'touch'))).toEqual(audio)
  })

  it('merges simultaneous misses; one cancelled waiter does not cancel the shared synthesis', async () => {
    let resolve!: (audio: Uint8Array) => void
    let started!: () => void
    const ready = new Promise<void>((done) => { started = done })
    const generate = vi.fn((signal: AbortSignal) => new Promise<Uint8Array>((done) => {
      resolve = done
      expect(signal.aborted).toBe(false)
      started()
    }))
    const abort = new AbortController()
    const first = cache.get(1, 'shared', abort.signal, generate)
    const rejected = expect(first).rejects.toMatchObject({ code: 'tts-cancelled' })
    const second = cache.get(1, 'shared', undefined, generate)
    await ready
    abort.abort()
    await rejected
    resolve(audio)
    expect(await second).toEqual(audio)
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('aborts upstream when all waiters cancel, removes failed jobs and allows retry', async () => {
    const abort = new AbortController()
    let started!: () => void
    let upstream!: AbortSignal
    const ready = new Promise<void>((done) => { started = done })
    const first = cache.get(1, 'cancel', abort.signal, (signal) => new Promise((_, reject) => {
      upstream = signal
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      started()
    }))
    const rejected = expect(first).rejects.toMatchObject({ code: 'tts-cancelled' })
    await ready
    abort.abort()
    await rejected
    expect(upstream.aborted).toBe(true)
    await expect(cache.get(1, 'cancel', undefined, async () => { throw new Error('provider failed') })).rejects.toThrow('provider failed')
    expect(await cache.get(1, 'cancel', undefined, async () => audio)).toEqual(audio)
  })

  it('clear is scoped and pending synthesis cannot repopulate cleared data', async () => {
    await cache.get(1, 'saved', undefined, async () => audio)
    await cache.get(2, 'saved', undefined, async () => audio)
    let complete!: (audio: Uint8Array) => void
    let started!: () => void
    const ready = new Promise<void>((done) => { started = done })
    const pending = cache.get(1, 'pending', undefined, () => new Promise((done) => { complete = done; started() }))
    await ready
    expect(await cache.clear(1)).toMatchObject({ bytes: 0 })
    complete(audio)
    expect(await pending).toEqual(audio)
    expect((await cache.usage(1)).bytes).toBe(0)
    expect((await cache.usage(2)).bytes).toBe(audio.length)
  })

  it('degrades safely on directory/write failure and refuses symlink escapes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const outside = path.join(root, 'outside')
    await mkdir(outside)
    await symlink(outside, path.join(root, 'cache'))
    const generate = vi.fn(async () => audio)
    expect(await cache.get(1, 'private', undefined, generate)).toEqual(audio)
    expect(await readdir(outside)).toEqual([])
    expect(generate).toHaveBeenCalledTimes(1)
    await rm(path.join(root, 'cache'))
    await writeFile(path.join(root, 'cache'), 'blocked directory')
    expect(await cache.get(1, 'private', undefined, generate)).toEqual(audio)
  })

  it('refuses symlink cache files without reading or deleting their targets', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await cache.get(1, 'first', undefined, async () => audio)
    const victim = path.join(root, 'victim')
    await writeFile(victim, audio)
    const target = filename(1, 'first')
    await rm(target)
    await symlink(victim, target)
    const generate = vi.fn(async () => audio)
    await cache.get(1, 'first', undefined, generate)
    expect(generate).toHaveBeenCalledTimes(1)
    expect(await readFile(victim)).toEqual(audio)
    await cache.clear(1)
    expect(await readFile(victim)).toEqual(audio)
  })

  it('returns valid synthesis even when persistence fails after a successful cache lookup', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await cache.usage(1)
    const bytes = await cache.get(1, 'write-failure', undefined, async () => {
      const bucket = path.dirname(filename(1, 'write-failure'))
      await rm(bucket, { recursive: true })
      await writeFile(bucket, 'not a directory')
      return audio
    })
    expect(bytes).toEqual(audio)
    await expect(stat(filename(1, 'write-failure'))).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it('bounds tiny-file count as well as bytes and bounds in-flight cache work', async () => {
    cache = new NoteTtsCache(() => root, { ...NOTE_TTS_CACHE_LIMITS, filesPerUser: 1, pendingPerUser: 1, waitersPerKey: 1 }, () => now)
    await cache.get(1, 'old', undefined, async () => audio)
    await cache.get(1, 'new', undefined, async () => audio)
    await expect(stat(filename(1, 'old'))).rejects.toMatchObject({ code: 'ENOENT' })
    let finish!: (bytes: Uint8Array) => void
    let started!: () => void
    const ready = new Promise<void>((done) => { started = done })
    const first = cache.get(1, 'busy', undefined, () => new Promise((done) => { finish = done; started() }))
    await ready
    await expect(cache.get(1, 'other', undefined, async () => audio)).rejects.toMatchObject({ status: 429 })
    await expect(cache.get(1, 'busy', undefined, async () => audio)).rejects.toMatchObject({ status: 429 })
    finish(audio)
    await first
  })
})

import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, opendir, realpath, unlink } from 'node:fs/promises'
import path from 'node:path'
import { getDataDir } from '../db.js'
import { NOTE_TTS_LIMITS, NOTE_TTS_PARAMETERS, NoteTtsError, type NoteTtsParameters } from './tts.js'

export const NOTE_TTS_CACHE_LIMITS = {
  bytesPerUser: 512 * 1024 * 1024,
  retentionMs: 30 * 24 * 60 * 60 * 1000,
  maintenanceMs: 5 * 60 * 1000,
  staleTempMs: 60 * 60 * 1000,
  // Also bound directory traversal and tiny-file overhead, independently of bytes.
  filesPerUser: 4096,
  scanEntries: 8192,
  audioBytes: NOTE_TTS_LIMITS.responseHexChars / 2,
  pendingPerUser: 16,
  waitersPerKey: 32,
} as const

export function noteTtsCacheKey(text: string, parameters: unknown = NOTE_TTS_PARAMETERS): string {
  return createHash('sha256').update(JSON.stringify({ version: 1, provider: 'minimax', parameters, text })).digest('hex')
}

/** Basic MPEG frame validation, including optional bounded ID3v2 header. Not a decoder. */
export function validCachedMp3(bytes: Uint8Array): boolean {
  if (bytes.length < 4 || bytes.length > NOTE_TTS_CACHE_LIMITS.audioBytes) return false
  let offset = 0
  if (Buffer.from(bytes.subarray(0, 3)).toString() === 'ID3') {
    if (bytes.length < 10 || bytes[3]! < 2 || bytes[3]! > 4) return false
    const size = bytes.subarray(6, 10)
    if (size.some((n) => n > 127)) return false
    offset = 10 + size.reduce((n, part) => n * 128 + part, 0) + (bytes[5]! & 0x10 ? 10 : 0)
  }
  const a = bytes[offset], b = bytes[offset + 1], c = bytes[offset + 2]
  if (a !== 255 || b === undefined || c === undefined || (b & 224) !== 224) return false
  const version = (b >> 3) & 3
  if (version === 1 || (b & 6) !== 2) return false // Layer III only
  const rateIndex = (c >> 2) & 3, bitrateIndex = c >> 4
  if (rateIndex === 3 || bitrateIndex === 0 || bitrateIndex === 15) return false
  const bitrate = (version === 3
    ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
    : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160])[bitrateIndex]!
  const rate = [44100, 48000, 32000][rateIndex]! / (version === 3 ? 1 : version === 2 ? 2 : 4)
  return bytes.length - offset >= Math.floor((version === 3 ? 144000 : 72000) * bitrate / rate) + ((c >> 1) & 1)
}

type Entry = { file: string; size: number; accessed: number }
type Job = { controller: AbortController; promise: Promise<Uint8Array>; waiters: number }
type Scope = { queue: Promise<unknown>; epoch: number; maintained: number; pending: number; inventory: Map<string, Entry> | null }
type CacheLimits = { [K in keyof typeof NOTE_TTS_CACHE_LIMITS]: number }

/** Single-process coordination; disk data survives process recreation. No document metadata. */
export class NoteTtsCache {
  private scopes = new Map<number, Scope>()
  private jobs = new Map<string, Job>()
  private warned = false
  private dataDir: () => string
  private limits: CacheLimits
  private now: () => number
  constructor(dataDir: () => string = getDataDir, limits: CacheLimits = { ...NOTE_TTS_CACHE_LIMITS }, now = Date.now) {
    this.dataDir = dataDir
    this.limits = limits
    this.now = now
  }

  private scope(user: number): Scope {
    if (!Number.isSafeInteger(user) || user <= 0) throw new Error('Invalid cache scope')
    let scope = this.scopes.get(user)
    if (!scope) { scope = { queue: Promise.resolve(), epoch: 0, maintained: -Infinity, pending: 0, inventory: null }; this.scopes.set(user, scope) }
    return scope
  }

  private locked<T>(scope: Scope, action: () => Promise<T>): Promise<T> {
    const result = scope.queue.then(action)
    scope.queue = result.catch(() => {})
    return result
  }

  private warn() {
    if (!this.warned) { this.warned = true; console.warn('[note-tts-cache] Cache unavailable; continuing without persistence') }
  }

  private async directory(user: number, bucket?: string): Promise<string> {
    // Trust only the configured data root. Every cache descendant must be a real directory.
    const root = await realpath(this.dataDir())
    let current = root
    for (const part of ['cache', 'tts', `user-${user}`, ...(bucket ? [bucket] : [])]) {
      current = path.join(current, part)
      try { await mkdir(current, { mode: 0o700 }) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      if (!(await lstat(current)).isDirectory() || await realpath(current) !== current) throw new Error('Unsafe cache directory')
    }
    return current
  }

  private async entries(user: number): Promise<Entry[]> {
    const root = await this.directory(user)
    const entries: Entry[] = []
    let visited = 0
    const buckets = await opendir(root)
    for await (const bucket of buckets) {
      if (++visited > this.limits.scanEntries) throw new Error('Cache traversal limit')
      if (!/^[0-9a-f]{2}$/.test(bucket.name) || !bucket.isDirectory()) continue
      const dir = await this.directory(user, bucket.name)
      for await (const file of await opendir(dir)) {
        if (++visited > this.limits.scanEntries) throw new Error('Cache traversal limit')
        if (!file.isFile()) continue
        const filename = path.join(dir, file.name)
        const stat = await lstat(filename)
        if (!stat.isFile()) continue
        if (/^[0-9a-f]{64}\.[0-9a-f-]{36}\.tmp$/.test(file.name)) {
          if (this.now() - stat.mtimeMs > this.limits.staleTempMs) await unlink(filename)
        } else if (/^[0-9a-f]{64}\.mp3$/.test(file.name)) {
          entries.push({ file: filename, size: stat.size, accessed: stat.mtimeMs })
        }
      }
    }
    return entries
  }

  private async maintain(user: number, reserve = 0, refresh = false): Promise<void> {
    const scope = this.scope(user)
    if (refresh || !scope.inventory || this.now() - scope.maintained >= this.limits.maintenanceMs) {
      scope.inventory = new Map((await this.entries(user)).map((entry) => [entry.file, entry]))
      scope.maintained = this.now()
    }
    const entries = [...scope.inventory.values()].sort((a, b) => a.accessed - b.accessed)
    let size = entries.reduce((sum, entry) => sum + entry.size, 0)
    let count = entries.length
    for (const entry of entries) {
      if (this.now() - entry.accessed <= this.limits.retentionMs
        && size + reserve <= this.limits.bytesPerUser && count + (reserve ? 1 : 0) <= this.limits.filesPerUser) continue
      await unlink(entry.file).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
      scope.inventory.delete(entry.file)
      size -= entry.size
      count--
    }
  }

  private async read(user: number, key: string): Promise<Uint8Array | null> {
    const filename = path.join(await this.directory(user, key.slice(0, 2)), `${key}.mp3`)
    let handle
    try {
      handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const stat = await handle.stat()
      if (!stat.isFile()) return null
      if (stat.size > this.limits.audioBytes || this.now() - stat.mtimeMs > this.limits.retentionMs) {
        await unlink(filename)
        this.scope(user).inventory?.delete(filename)
        return null
      }
      const buffer = Buffer.alloc(Math.min(stat.size + 1, this.limits.audioBytes + 1))
      let length = 0
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length)
        if (!bytesRead) break
        length += bytesRead
      }
      const bytes = buffer.subarray(0, length)
      if (!validCachedMp3(bytes)) {
        await unlink(filename)
        this.scope(user).inventory?.delete(filename)
        return null
      }
      const now = new Date(this.now())
      await handle.utimes(now, now).catch(() => this.warn())
      this.scope(user).inventory?.set(filename, { file: filename, size: bytes.length, accessed: this.now() })
      return bytes
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.scope(user).inventory?.delete(filename)
      return null
    } finally { await handle?.close() }
  }

  private async write(user: number, key: string, bytes: Uint8Array): Promise<void> {
    if (!validCachedMp3(bytes) || bytes.length > this.limits.bytesPerUser) return
    await this.maintain(user, bytes.length)
    const dir = await this.directory(user, key.slice(0, 2))
    const final = path.join(dir, `${key}.mp3`)
    const temp = path.join(dir, `${key}.${randomUUID()}.tmp`)
    try {
      const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
      // Hard-link publishes atomically without replacing another complete file.
      try { await link(temp, final) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      const stat = await lstat(final)
      if (stat.isFile()) this.scope(user).inventory?.set(final, { file: final, size: stat.size, accessed: stat.mtimeMs })
    } finally { await unlink(temp).catch(() => {}) }
  }

  async get(user: number, text: string, signal: AbortSignal | undefined, generate: (signal: AbortSignal) => Promise<Uint8Array>, parameters: NoteTtsParameters = NOTE_TTS_PARAMETERS): Promise<Uint8Array> {
    const scope = this.scope(user)
    if (signal?.aborted) throw new NoteTtsError('tts-cancelled', 'Speech request was cancelled', 499)
    const key = noteTtsCacheKey(text, parameters)
    const identity = `${user}:${scope.epoch}:${key}`
    let job = this.jobs.get(identity)
    if (!job) {
      if (scope.pending >= this.limits.pendingPerUser) throw new NoteTtsError('tts-concurrency-limit', 'Too many speech requests', 429, 2)
      scope.pending++
      const controller = new AbortController()
      const epoch = scope.epoch
      const promise = (async () => {
        let cached: Uint8Array | null = null
        try {
          cached = await this.locked(scope, async () => {
            if (this.now() - scope.maintained >= this.limits.maintenanceMs) {
              await this.maintain(user)
              scope.maintained = this.now()
            }
            return this.read(user, key)
          })
        } catch { scope.inventory = null; this.warn() }
        controller.signal.throwIfAborted()
        if (cached) return cached
        const bytes = await generate(controller.signal)
        controller.signal.throwIfAborted()
        try {
          await this.locked(scope, async () => {
            if (!controller.signal.aborted && scope.epoch === epoch) await this.write(user, key, bytes)
          })
        } catch { scope.inventory = null; this.warn() }
        return bytes
      })()
      job = { controller, promise, waiters: 0 }
      this.jobs.set(identity, job)
      void promise.finally(() => {
        scope.pending--
        if (this.jobs.get(identity) === job) this.jobs.delete(identity)
      }).catch(() => {})
    }
    const shared = job
    if (shared.waiters >= this.limits.waitersPerKey) throw new NoteTtsError('tts-concurrency-limit', 'Too many speech requests', 429, 2)
    shared.waiters++
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error?: unknown, bytes?: Uint8Array) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', abort)
        shared.waiters--
        if (!shared.waiters) {
          shared.controller.abort()
          if (this.jobs.get(identity) === shared) this.jobs.delete(identity)
        }
        if (error) reject(error)
        else resolve(bytes!)
      }
      const abort = () => finish(new NoteTtsError('tts-cancelled', 'Speech request was cancelled', 499))
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      shared.promise.then((bytes) => finish(undefined, bytes), (error) => finish(error))
    })
  }

  async usage(user: number): Promise<{ bytes: number; limitBytes: number }> {
    return this.locked(this.scope(user), async () => {
      await this.maintain(user, 0, true)
      return { bytes: [...this.scope(user).inventory!.values()].reduce((sum, entry) => sum + entry.size, 0), limitBytes: this.limits.bytesPerUser }
    })
  }

  async clear(user: number): Promise<{ bytes: number; limitBytes: number }> {
    const scope = this.scope(user)
    ++scope.epoch // Pending synthesis may return to its caller, but cannot repopulate cleared data.
    return this.locked(scope, async () => {
      for (const entry of await this.entries(user)) await unlink(entry.file)
      scope.inventory = new Map()
      scope.maintained = this.now()
      return { bytes: 0, limitBytes: this.limits.bytesPerUser }
    })
  }
}

export const noteTtsCache = new NoteTtsCache()

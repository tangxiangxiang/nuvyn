/**
 * A finite, process-wide scheduler for memory-hard password KDF work.
 *
 * Node's scrypt is asynchronous, but without a separate admission boundary a
 * burst of login/setup requests can still allocate too many worker jobs. The
 * guard limits both active work and waiting work. A running job is allowed to
 * finish when its signal is aborted because the underlying KDF cannot be
 * safely interrupted; queued work is removed before it starts.
 */

export const DEFAULT_KDF_CONCURRENCY = 3
export const DEFAULT_KDF_MAX_QUEUE = 24
export const DEFAULT_KDF_QUEUE_WAIT_MS = 5_000

export type KdfGuardErrorCode =
  | 'kdf-overloaded'
  | 'kdf-queue-timeout'
  | 'kdf-aborted'

export class KdfGuardError extends Error {
  readonly code: KdfGuardErrorCode

  constructor(code: KdfGuardErrorCode, message: string) {
    super(message)
    this.name = 'KdfGuardError'
    this.code = code
  }
}

export class KdfQueueFullError extends KdfGuardError {
  constructor() {
    super('kdf-overloaded', 'password KDF capacity is temporarily exhausted')
    this.name = 'KdfQueueFullError'
  }
}

export class KdfQueueTimeoutError extends KdfGuardError {
  constructor() {
    super('kdf-queue-timeout', 'password KDF queue wait timed out')
    this.name = 'KdfQueueTimeoutError'
  }
}

export class KdfAbortedError extends KdfGuardError {
  constructor() {
    super('kdf-aborted', 'password KDF work was aborted')
    this.name = 'KdfAbortedError'
  }
}

export type KdfGuardOptions = {
  concurrency?: number
  maxQueue?: number
  maxQueueWaitMs?: number
}

type QueueEntry<T> = {
  readonly job: () => Promise<T>
  readonly resolve: (value: T | PromiseLike<T>) => void
  readonly reject: (reason?: unknown) => void
  readonly signal?: AbortSignal
  started: boolean
  timer?: ReturnType<typeof setTimeout>
  abortListener?: () => void
}

function assertPositiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`)
  }
  return value
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof value === 'object'
    && value !== null
    && 'aborted' in value
    && 'addEventListener' in value
}

export class KdfGuard {
  readonly concurrency: number
  readonly maxQueue: number
  readonly maxQueueWaitMs: number

  private active = 0
  private readonly queue: QueueEntry<unknown>[] = []

  constructor(options: KdfGuardOptions = {}) {
    this.concurrency = assertPositiveInteger(
      'concurrency',
      options.concurrency ?? DEFAULT_KDF_CONCURRENCY,
    )
    if (!Number.isInteger(options.maxQueue ?? DEFAULT_KDF_MAX_QUEUE) || (options.maxQueue ?? DEFAULT_KDF_MAX_QUEUE) < 0) {
      throw new RangeError('maxQueue must be a non-negative integer')
    }
    this.maxQueue = options.maxQueue ?? DEFAULT_KDF_MAX_QUEUE
    this.maxQueueWaitMs = assertPositiveInteger(
      'maxQueueWaitMs',
      options.maxQueueWaitMs ?? DEFAULT_KDF_QUEUE_WAIT_MS,
    )
  }

  get activeCount(): number {
    return this.active
  }

  get queuedCount(): number {
    return this.queue.length
  }

  get pendingCount(): number {
    return this.active + this.queue.length
  }

  /**
   * Run a job through the guard. Both `run(signal, job)` and
   * `run(job, signal)` are accepted so callers can use the repository's
   * preferred argument order without creating a second scheduler API.
   */
  run<T>(signal: AbortSignal | undefined, job: () => Promise<T>): Promise<T>
  run<T>(job: () => Promise<T>, signal?: AbortSignal): Promise<T>
  run<T>(
    first: AbortSignal | (() => Promise<T>) | undefined,
    second?: (() => Promise<T>) | AbortSignal,
  ): Promise<T> {
    const signal = typeof first === 'function'
      ? (isAbortSignal(second) ? second : undefined)
      : first
    const job = typeof first === 'function' ? first : second
    if (typeof job !== 'function') {
      return Promise.reject(new TypeError('KDF guard requires an async job'))
    }
    if (signal?.aborted) return Promise.reject(new KdfAbortedError())

    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry<T> = {
        job,
        resolve,
        reject,
        signal,
        started: false,
      }

      if (this.active < this.concurrency) {
        this.start(entry)
        return
      }
      if (this.queue.length >= this.maxQueue) {
        reject(new KdfQueueFullError())
        return
      }

      const abortListener = (): void => {
        if (entry.started) return
        if (this.removeQueued(entry)) reject(new KdfAbortedError())
      }
      entry.abortListener = abortListener
      signal?.addEventListener('abort', abortListener, { once: true })
      if (signal?.aborted) {
        abortListener()
        return
      }

      entry.timer = setTimeout(() => {
        if (entry.started) return
        if (this.removeQueued(entry)) reject(new KdfQueueTimeoutError())
      }, this.maxQueueWaitMs)
      this.queue.push(entry as unknown as QueueEntry<unknown>)
    })
  }

  private removeQueued<T>(entry: QueueEntry<T>): boolean {
    const index = this.queue.indexOf(entry as QueueEntry<unknown>)
    if (index < 0) return false
    this.queue.splice(index, 1)
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    if (entry.abortListener && entry.signal) {
      entry.signal.removeEventListener('abort', entry.abortListener)
    }
    return true
  }

  private start<T>(entry: QueueEntry<T>): void {
    entry.started = true
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    if (entry.abortListener && entry.signal) {
      entry.signal.removeEventListener('abort', entry.abortListener)
    }
    this.active += 1

    void Promise.resolve()
      .then(entry.job)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        this.active -= 1
        this.drain()
      })
      .catch(() => {
        // The job's rejection is delivered to the caller above. This final
        // catch only prevents the internal finally chain from becoming an
        // unhandled rejection when a Promise implementation is unusual.
      })
  }

  private drain(): void {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const entry = this.queue.shift()!
      if (entry.timer !== undefined) clearTimeout(entry.timer)
      if (entry.abortListener && entry.signal) {
        entry.signal.removeEventListener('abort', entry.abortListener)
      }
      if (entry.signal?.aborted) {
        entry.reject(new KdfAbortedError())
        continue
      }
      this.start(entry)
    }
  }
}

/** One shared default budget for all production password KDF callers. */
export const defaultKdfGuard = new KdfGuard()

/** More descriptive alias for callers that want to emphasize sharing. */
export const sharedKdfGuard = defaultKdfGuard

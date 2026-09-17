import { describe, expect, it } from 'vitest'
import {
  AuthRateLimiter,
  AUTH_FAILURE_THRESHOLD,
  AUTH_FAILURE_WINDOW_MS,
  AUTH_MAX_BUCKETS,
  AUTH_MAX_DELAY_MS,
} from '../auth/rateLimit.js'

describe('authentication rate limiter', () => {
  it('uses a five-minute window, bounded exponential retry, reset, and pruning', () => {
    let now = 1_700_000_000_000
    const limiter = new AuthRateLimiter({ now: () => now })
    for (let i = 0; i < AUTH_FAILURE_THRESHOLD - 1; i++) {
      expect(limiter.recordFailure('admin').retryAfterMs).toBe(0)
    }
    expect(limiter.recordFailure('admin').retryAfterMs).toBeGreaterThan(0)
    expect(limiter.recordFailure('admin').retryAfterMs).toBeGreaterThanOrEqual(1_000)
    expect(limiter.recordFailure('admin').retryAfterMs).toBeLessThanOrEqual(AUTH_MAX_DELAY_MS)
    limiter.reset('admin')
    expect(limiter.size).toBe(0)

    limiter.recordFailure('old')
    now += AUTH_FAILURE_WINDOW_MS + 1
    limiter.prune()
    expect(limiter.size).toBe(0)
  })

  it('keeps failure state bounded across untrusted usernames', () => {
    const limiter = new AuthRateLimiter({ maxBuckets: 8 })
    for (let i = 0; i < 100; i++) limiter.recordFailure(`username-${i}`)
    expect(limiter.size).toBeLessThanOrEqual(8)
    expect(limiter.maxBuckets).toBe(8)
    expect(AUTH_MAX_BUCKETS).toBeGreaterThan(8)
  })

  it('does not provide a pre-verification lockout operation', () => {
    const limiter = new AuthRateLimiter({ threshold: 1 })
    limiter.recordFailure('admin')
    // A caller must still perform its credential verification and decide how
    // to map this result; reset remains available after a correct password.
    limiter.reset('admin')
    expect(limiter.size).toBe(0)
  })

  it('reports a read-only remaining penalty instead of restarting cooldown', () => {
    let now = 1_700_000_000_000
    const limiter = new AuthRateLimiter({
      now: () => now,
      windowMs: 10,
      threshold: 2,
      baseRetryMs: 100,
      maxDelayMs: 100,
    })
    expect(limiter.recordFailure('setup').retryAfterMs).toBe(0)
    expect(limiter.recordFailure('setup').retryAfterMs).toBe(100)
    now += 40
    expect(limiter.retryAfter('setup')).toBe(60)
    now += 10
    // The window has elapsed, but the configured penalty is still active.
    expect(limiter.retryAfter('setup')).toBe(50)
    now += 50
    expect(limiter.retryAfter('setup')).toBe(0)
  })

  it('does not carry setup cooldown state across a new runtime limiter', () => {
    let now = 1_700_000_000_000
    const options = {
      now: () => now,
      threshold: 1,
      baseRetryMs: 100,
      maxDelayMs: 100,
    }
    const firstRuntime = new AuthRateLimiter(options)
    expect(firstRuntime.recordFailure('setup').retryAfterMs).toBe(100)
    expect(firstRuntime.retryAfter('setup')).toBe(100)

    const restartedRuntime = new AuthRateLimiter(options)
    expect(restartedRuntime.retryAfter('setup')).toBe(0)
    now += 101
    expect(firstRuntime.retryAfter('setup')).toBe(0)
  })
})

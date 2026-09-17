import { describe, expect, it } from 'vitest'
import {
  KdfAbortedError,
  KdfGuard,
  KdfQueueFullError,
  KdfQueueTimeoutError,
} from '../auth/kdfGuard'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('KdfGuard', () => {
  it('never runs more than the configured number of jobs concurrently', async () => {
    const guard = new KdfGuard({ concurrency: 3, maxQueue: 10, maxQueueWaitMs: 1_000 })
    const gates = Array.from({ length: 6 }, () => deferred<void>())
    let active = 0
    let maxActive = 0

    const jobs = gates.map((gate) => guard.run(undefined, async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await gate.promise
      active -= 1
      return true
    }))

    await Promise.resolve()
    expect(active).toBe(3)
    expect(guard.activeCount).toBe(3)
    expect(guard.queuedCount).toBe(3)
    expect(maxActive).toBe(3)

    gates.slice(0, 3).forEach((gate) => gate.resolve())
    await Promise.resolve()
    expect(guard.activeCount).toBe(3)
    gates.slice(3).forEach((gate) => gate.resolve())
    await expect(Promise.all(jobs)).resolves.toEqual([true, true, true, true, true, true])
    expect(guard.pendingCount).toBe(0)
  })

  it('rejects beyond the finite queue capacity with a deterministic overload error', async () => {
    const guard = new KdfGuard({ concurrency: 1, maxQueue: 2, maxQueueWaitMs: 1_000 })
    const gate = deferred<void>()
    const first = guard.run(undefined, async () => {
      await gate.promise
      return 'first'
    })
    const second = guard.run(undefined, async () => 'second')
    const third = guard.run(undefined, async () => 'third')
    const fourth = guard.run(undefined, async () => 'fourth')

    await expect(fourth).rejects.toBeInstanceOf(KdfQueueFullError)
    expect(guard.queuedCount).toBe(2)
    gate.resolve()
    await expect(Promise.all([first, second, third])).resolves.toEqual(['first', 'second', 'third'])
    expect(guard.pendingCount).toBe(0)
  })

  it('removes an aborted queued job without consuming a slot', async () => {
    const guard = new KdfGuard({ concurrency: 1, maxQueue: 2, maxQueueWaitMs: 1_000 })
    const gate = deferred<void>()
    const first = guard.run(undefined, async () => {
      await gate.promise
      return 'first'
    })
    const controller = new AbortController()
    const aborted = guard.run(controller.signal, async () => 'aborted')
    const remaining = guard.run(undefined, async () => 'remaining')

    controller.abort()
    await expect(aborted).rejects.toBeInstanceOf(KdfAbortedError)
    expect(guard.queuedCount).toBe(1)
    gate.resolve()
    await expect(Promise.all([first, remaining])).resolves.toEqual(['first', 'remaining'])
    expect(guard.pendingCount).toBe(0)
  })

  it('uses the configured maximum queue wait and restores capacity after rejection', async () => {
    const guard = new KdfGuard({ concurrency: 1, maxQueue: 2, maxQueueWaitMs: 10 })
    const gate = deferred<void>()
    const first = guard.run(undefined, async () => {
      await gate.promise
      throw new Error('fake KDF failure')
    })
    const timedOut = guard.run(undefined, async () => 'never')
    await expect(timedOut).rejects.toBeInstanceOf(KdfQueueTimeoutError)
    gate.resolve()
    await expect(first).rejects.toThrow('fake KDF failure')

    await expect(guard.run(undefined, async () => 'available')).resolves.toBe('available')
    expect(guard.pendingCount).toBe(0)
  })

  it('does not pretend a running job is cancellable, but restores capacity after abort', async () => {
    const guard = new KdfGuard({ concurrency: 1, maxQueue: 1, maxQueueWaitMs: 100 })
    const gate = deferred<void>()
    const controller = new AbortController()
    const running = guard.run(controller.signal, async () => {
      await gate.promise
      return 'completed'
    })
    await Promise.resolve()
    controller.abort()
    gate.resolve()
    await expect(running).resolves.toBe('completed')
    await expect(guard.run(undefined, async () => 'next')).resolves.toBe('next')
    expect(guard.pendingCount).toBe(0)
  })

  it('handles a 100-job burst with a hard concurrency cap and bounded admission', async () => {
    const guard = new KdfGuard({ concurrency: 3, maxQueue: 12, maxQueueWaitMs: 1_000 })
    let active = 0
    let maxActive = 0
    const jobs = Array.from({ length: 100 }, (_, index) => guard.run(undefined, async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await Promise.resolve()
      active -= 1
      return index
    }))

    const results = await Promise.allSettled(jobs)
    expect(maxActive).toBeLessThanOrEqual(3)
    expect(results.some((result) => result.status === 'rejected')).toBe(true)
    expect(guard.pendingCount).toBe(0)
  })
})

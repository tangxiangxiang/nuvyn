import { describe, expect, it } from 'vitest'
import {
  documentWriteLockWaitersForTesting,
  pendingDocumentWriteLocksForTesting,
  VAULT_STRUCTURE_LOCK,
  withDocumentWriteLock,
  withVaultStructureLock,
} from '../documentWriteLock'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('withDocumentWriteLock', () => {
  it('serializes the same path and clears the completed entry', async () => {
    const firstStarted = deferred()
    const releaseFirst = deferred()
    const order: string[] = []
    const first = withDocumentWriteLock('a', async () => {
      order.push('first-start')
      firstStarted.resolve()
      await releaseFirst.promise
      order.push('first-end')
    })
    await firstStarted.promise
    const second = withDocumentWriteLock('a', async () => {
      order.push('second')
    })

    await Promise.resolve()
    expect(order).toEqual(['first-start'])
    releaseFirst.resolve()
    await Promise.all([first, second])
    expect(order).toEqual(['first-start', 'first-end', 'second'])
    expect(pendingDocumentWriteLocksForTesting()).toBe(0)
  })

  it('allows different paths to run concurrently', async () => {
    const releaseA = deferred()
    const aStarted = deferred()
    const seen: string[] = []
    const a = withDocumentWriteLock('a', async () => {
      seen.push('a')
      aStarted.resolve()
      await releaseA.promise
    })
    await aStarted.promise
    const b = withDocumentWriteLock('b', async () => {
      seen.push('b')
    })

    await b
    expect(seen).toEqual(['a', 'b'])
    releaseA.resolve()
    await a
    expect(pendingDocumentWriteLocksForTesting()).toBe(0)
  })

  it('does not strand later requests after a rejection', async () => {
    await expect(withDocumentWriteLock('a', async () => {
      throw new Error('failed')
    })).rejects.toThrow('failed')

    await expect(withDocumentWriteLock('a', async () => 'ok')).resolves.toBe('ok')
    expect(pendingDocumentWriteLocksForTesting()).toBe(0)
  })
})

describe('withVaultStructureLock', () => {
  it('serializes membership operations on the reserved structure key', async () => {
    const firstStarted = deferred()
    const releaseFirst = deferred()
    const order: string[] = []
    const first = withVaultStructureLock(async () => {
      order.push('first-start')
      firstStarted.resolve()
      await releaseFirst.promise
      order.push('first-end')
    })
    await firstStarted.promise
    const second = withVaultStructureLock(async () => {
      order.push('second')
    })

    await Promise.resolve()
    expect(order).toEqual(['first-start'])
    releaseFirst.resolve()
    await Promise.all([first, second])
    expect(order).toEqual(['first-start', 'first-end', 'second'])
    expect(pendingDocumentWriteLocksForTesting()).toBe(0)
  })

  it('never shares a key with a document lock, even for the reserved spelling', async () => {
    // Regression: an AI tool call whose unnormalizable path falls back
    // to its raw spelling used to key its document lock with the SAME
    // string as the structure lock it already held — a self-deadlock
    // that also jammed every later membership operation behind the
    // stuck structure lock. The two lock classes now key in separate
    // namespaces, so a document lock on the literal reserved string
    // must run immediately even while the structure lock is held.
    const holderStarted = deferred()
    const releaseHolder = deferred()
    const holder = withVaultStructureLock(async () => {
      holderStarted.resolve()
      await releaseHolder.promise
    })
    await holderStarted.promise

    let innerRan = false
    await withDocumentWriteLock(VAULT_STRUCTURE_LOCK, async () => {
      innerRan = true
    })
    expect(innerRan).toBe(true)

    releaseHolder.resolve()
    await holder
    expect(pendingDocumentWriteLocksForTesting()).toBe(0)
  })

  it('reports queued waiters for deterministic race tests', async () => {
    const holderStarted = deferred()
    const releaseHolder = deferred()
    const holder = withVaultStructureLock(async () => {
      holderStarted.resolve()
      await releaseHolder.promise
    })
    await holderStarted.promise
    expect(documentWriteLockWaitersForTesting(VAULT_STRUCTURE_LOCK)).toBe(0)

    const waiter = withVaultStructureLock(async () => {})
    await Promise.resolve()
    expect(documentWriteLockWaitersForTesting(VAULT_STRUCTURE_LOCK)).toBe(1)

    releaseHolder.resolve()
    await Promise.all([holder, waiter])
    expect(documentWriteLockWaitersForTesting(VAULT_STRUCTURE_LOCK)).toBe(0)
    expect(pendingDocumentWriteLocksForTesting()).toBe(0)
  })
})

import { describe, expect, it } from 'vitest'
import { createDraftRecoveryOperationProtection } from '../useDraftRecoveryOperationProtection'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => { resolve = yes })
  return { promise, resolve }
}

describe('draft recovery operation protection', () => {
  it('keeps an ID protected until every concurrent operation finishes', async () => {
    const protection = createDraftRecoveryOperationProtection()
    const first = deferred()
    const second = deferred()
    const a = protection.run(['recovery-a'], () => first.promise)
    const b = protection.run(['recovery-a'], () => second.promise)
    expect(protection.protectedIds.value.has('recovery-a')).toBe(true)

    first.resolve()
    await a
    expect(protection.protectedIds.value.has('recovery-a')).toBe(true)

    second.resolve()
    await b
    expect(protection.protectedIds.value.has('recovery-a')).toBe(false)
  })
})

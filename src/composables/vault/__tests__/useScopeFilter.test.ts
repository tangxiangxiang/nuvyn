// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

const STORAGE_KEY = 'nuvyn.vault.activeScope'

// The module owns startup scope as a singleton, so load it again for each
// simulated browser refresh rather than mutating its existing refs.
async function freshScope() {
  vi.resetModules()
  const { useScopeFilter } = await import('../useScopeFilter')
  return useScopeFilter()
}

describe('Diary scope bootstrap', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => {
    localStorage.clear()
    vi.resetModules()
  })

  it('does not overwrite a saved Diary preference before access resolution', async () => {
    localStorage.setItem(STORAGE_KEY, 'diary')
    const scope = await freshScope()
    expect(scope.activeScope.value).toBe('note')
    expect(scope.diaryScopeRestorePending.value).toBe(true)
    expect(localStorage.getItem(STORAGE_KEY)).toBe('diary')

    scope.settleDiaryScopeRestore(true)
    await nextTick()
    expect(scope.activeScope.value).toBe('diary')
    expect(scope.diaryScopeRestorePending.value).toBe(false)
    expect(localStorage.getItem(STORAGE_KEY)).toBe('diary')
  })

  it('falls back to Note when remembered Diary authorization is not valid', async () => {
    localStorage.setItem(STORAGE_KEY, 'diary')
    const scope = await freshScope()
    scope.settleDiaryScopeRestore(false)
    await nextTick()
    expect(scope.activeScope.value).toBe('note')
    expect(scope.diaryScopeRestorePending.value).toBe(false)
    expect(localStorage.getItem(STORAGE_KEY)).toBe('note')
  })

  it('does not let a late access response override explicit navigation', async () => {
    localStorage.setItem(STORAGE_KEY, 'diary')
    const scope = await freshScope()
    scope.selectScope('ledger')
    scope.settleDiaryScopeRestore(true)
    await nextTick()
    expect(scope.activeScope.value).toBe('ledger')
    expect(scope.diaryScopeRestorePending.value).toBe(false)
    expect(localStorage.getItem(STORAGE_KEY)).toBe('ledger')
  })

  it('persists a deliberate Note choice even if it matches the safe initial scope', async () => {
    localStorage.setItem(STORAGE_KEY, 'diary')
    const scope = await freshScope()
    scope.selectScope('note')
    await nextTick()
    expect(scope.diaryScopeRestorePending.value).toBe(false)
    expect(localStorage.getItem(STORAGE_KEY)).toBe('note')
  })
})

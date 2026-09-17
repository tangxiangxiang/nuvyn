// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { makeEmptyTab } from '../tabState'
import { readPersistedTabs, useTabPersistence } from '../useTabPersistence'

describe('useTabPersistence', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('fails closed when a caller supplies an empty vault identity', () => {
    const tabs = ref([makeEmptyTab('a')])
    const activePath = ref<string | null>('a')
    expect(() => useTabPersistence(tabs, activePath, '')).toThrow(
      'Vault identity is required for tab persistence.',
    )
    expect(localStorage.getItem('nuvyn:tabs:v1')).toBeNull()
  })

  it('flushes on dispose and prevents a trailing debounce from overwriting a newer owner', async () => {
    const tabs = ref([makeEmptyTab('a')])
    const activePath = ref<string | null>('a')
    const removeListener = vi.spyOn(window, 'removeEventListener')
    const persistence = useTabPersistence(tabs, activePath, 'test-vault')

    tabs.value = [makeEmptyTab('b')]
    activePath.value = 'b'
    await nextTick()
    persistence.dispose()
    expect(readPersistedTabs('test-vault')).toEqual({ v: 1, paths: ['b'], active: 'b' })

    localStorage.setItem('nuvyn:tabs:v1:test-vault', JSON.stringify({
      v: 1,
      paths: ['new-owner'],
      active: 'new-owner',
    }))
    await vi.advanceTimersByTimeAsync(200)

    expect(readPersistedTabs('test-vault')).toEqual({
      v: 1,
      paths: ['new-owner'],
      active: 'new-owner',
    })
    expect(removeListener).toHaveBeenCalledWith('beforeunload', expect.any(Function))
  })
})

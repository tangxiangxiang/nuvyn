import { ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const authState = ref<'authenticated' | 'unauthenticated'>('authenticated')

vi.mock('../../../lib/diary-access-api', () => ({
  getDiaryAccessStatus: vi.fn(),
  lockDiaryAccess: vi.fn(),
  setupDiaryAccess: vi.fn(),
  unlockDiaryAccess: vi.fn(),
}))
vi.mock('../../useAuth', () => ({
  useAuth: () => ({
    state: authState,
    onSessionExpired: (_listener: () => void) => () => {},
  }),
}))

import {
  getDiaryAccessStatus,
  unlockDiaryAccess,
} from '../../../lib/diary-access-api'
import { getDiaryCapability } from '../../../lib/diary-capability'
import {
  resetDiaryAccessSessionForTesting,
  subscribeDiaryTeardown,
  useDiaryAccessSession,
} from '../useDiaryAccessSession'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

describe('D8.1 Diary client transition generation', () => {
  beforeEach(() => {
    authState.value = 'authenticated'
    resetDiaryAccessSessionForTesting()
    vi.mocked(getDiaryAccessStatus).mockReset()
    vi.mocked(unlockDiaryAccess).mockReset()
  })

  it('ignores a stale UNLOCKED status after clear/server lock', async () => {
    const pending = deferred<{ state: 'UNLOCKED'; epoch: number }>()
    vi.mocked(getDiaryAccessStatus).mockReturnValue(pending.promise)
    const access = useDiaryAccessSession()
    const status = access.ensureStatus()
    access.clear()
    pending.resolve({ state: 'UNLOCKED', epoch: 4 })
    await status
    expect(access.isUnlocked.value).toBe(false)
    expect(access.statusResolved.value).toBe(false)
    expect(getDiaryCapability()).toBeNull()
  })

  it('ignores a stale unlock after auth invalidation', async () => {
    const pending = deferred<{ state: 'UNLOCKED'; capability: string; epoch: number }>()
    vi.mocked(unlockDiaryAccess).mockReturnValue(pending.promise)
    const access = useDiaryAccessSession()
    const unlock = access.unlock('secondary password')
    authState.value = 'unauthenticated'
    await Promise.resolve()
    pending.resolve({ state: 'UNLOCKED', capability: 'stale-capability', epoch: 5 })
    await unlock
    expect(access.isUnlocked.value).toBe(false)
    expect(getDiaryCapability()).toBeNull()
  })

  it('lets a newer transition supersede an older unlock result', async () => {
    const older = deferred<{ state: 'UNLOCKED'; capability: string; epoch: number }>()
    const newer = deferred<{ state: 'UNLOCKED'; capability: string; epoch: number }>()
    vi.mocked(unlockDiaryAccess)
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise)
    const access = useDiaryAccessSession()
    const first = access.unlock('old password')
    const second = access.unlock('new password')
    newer.resolve({ state: 'UNLOCKED', capability: 'current-capability', epoch: 2 })
    await second
    older.resolve({ state: 'UNLOCKED', capability: 'stale-capability', epoch: 1 })
    await first
    expect(access.isUnlocked.value).toBe(true)
    expect(access.epoch.value).toBe(2)
    expect(access.statusResolved.value).toBe(true)
    expect(getDiaryCapability()).toBe('current-capability')
  })

  it('keeps status reconciliation resolved after a real lock boundary', async () => {
    vi.mocked(getDiaryAccessStatus).mockResolvedValue({ state: 'UNLOCKED', epoch: 7 })
    const access = useDiaryAccessSession()

    await access.ensureStatus()
    expect(access.statusResolved.value).toBe(true)
    expect(access.isUnlocked.value).toBe(true)

    access.clear()
    expect(access.state.value).toBe('LOCKED')
    expect(access.statusResolved.value).toBe(true)
  })

  it('fences derived holders when status polling observes an external lock', async () => {
    vi.mocked(getDiaryAccessStatus)
      .mockResolvedValueOnce({ state: 'UNLOCKED', epoch: 7 })
      .mockResolvedValueOnce({ state: 'LOCKED' })
    const events: string[] = []
    const unsubscribe = subscribeDiaryTeardown((event) => events.push(event.reason))
    const access = useDiaryAccessSession()

    await access.ensureStatus()
    await access.ensureStatus()

    unsubscribe()
    expect(events).toContain('auth-invalidated')
    expect(access.isUnlocked.value).toBe(false)
    expect(getDiaryCapability()).toBeNull()
  })
})

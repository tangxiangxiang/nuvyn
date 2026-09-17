// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { useHistory, __resetHistoryStateForTesting } from '../composables/vault/useHistory'
import {
  __resetFallbackFileChangesForTesting,
  getFallbackVaultFileChanges,
} from '../composables/vault/context/fileChanges'
import * as api from '../lib/history-api'

vi.mock('../lib/history-api', async () => {
  const actual = await vi.importActual<typeof api>('../lib/history-api')
  return {
    ...actual,
    getCapability: vi.fn(),
    getStatus: vi.fn(),
    getLog: vi.fn(),
  }
})

beforeEach(() => {
  __resetHistoryStateForTesting()
  vi.clearAllMocks()
  vi.mocked(api.getCapability).mockResolvedValue({ gitAvailable: true, repoInitialized: true })
  vi.mocked(api.getStatus).mockResolvedValue({ dirty: [], available: true })
  vi.mocked(api.getLog).mockResolvedValue({ commits: [] })
})

afterEach(() => __resetHistoryStateForTesting())

describe('useHistory document timeline state', () => {
  it('ignores stale Status and Timeline responses after a newer refresh completes', async () => {
    let resolveOldStatus!: (value: { dirty: api.StatusEntry[]; available: boolean }) => void
    let resolveOldLog!: (value: { commits: api.CommitRecord[] }) => void
    vi.mocked(api.getStatus).mockReturnValueOnce(new Promise((resolve) => { resolveOldStatus = resolve }))
    vi.mocked(api.getLog).mockReturnValueOnce(new Promise((resolve) => { resolveOldLog = resolve }))
    const history = useHistory()
    await flushPromises()

    vi.mocked(api.getStatus).mockResolvedValueOnce({
      dirty: [{ path: 'new.md', index: ' ', worktree: 'M' }],
      available: true,
    })
    const newest = {
      sha: 'new', parents: [], author: 'A', date: new Date().toISOString(), subject: 'New', body: '', files: ['new.md'],
    }
    vi.mocked(api.getLog).mockResolvedValueOnce({ commits: [newest] })
    await Promise.all([history.refreshStatus(), history.refreshLog()])

    resolveOldStatus({ dirty: [{ path: 'old.md', index: ' ', worktree: 'M' }], available: true })
    resolveOldLog({ commits: [{ ...newest, sha: 'old', subject: 'Old', files: ['old.md'] }] })
    await flushPromises()
    expect(history.status.value.map((entry) => entry.path)).toEqual(['new.md'])
    expect(history.log.value.map((entry) => entry.sha)).toEqual(['new'])
  })

  it('shares state within the same vault owner', () => {
    const first = useHistory()
    const second = useHistory()
    expect(second.status).toBe(first.status)
    expect(second.log).toBe(first.log)
  })

  it('rebinds when the provider-less vault owner changes', () => {
    const before = useHistory()
    __resetFallbackFileChangesForTesting()
    const after = useHistory()
    expect(after.status).not.toBe(before.status)
  })

  it('hydrates capability, status, and log only once', async () => {
    const history = useHistory()
    await flushPromises()
    await flushPromises()

    expect(history.available.value).toBe(true)
    expect(api.getCapability).toHaveBeenCalledOnce()
    expect(api.getStatus).toHaveBeenCalledOnce()
    expect(api.getLog).toHaveBeenCalledOnce()

    useHistory()
    await flushPromises()
    expect(api.getCapability).toHaveBeenCalledOnce()
  })

  it('exposes Git dirty independently from editor save state', async () => {
    vi.mocked(api.getStatus).mockResolvedValueOnce({
      dirty: [{ path: 'inbox/a.md', index: ' ', worktree: 'M' }],
      available: true,
    })
    const history = useHistory()
    await history.refreshStatus()
    expect(history.dirtyCount.value).toBe(1)
    expect(history.status.value[0]?.worktree).toBe('M')
  })

  it('refreshes Git status after a vault file-change event', async () => {
    const history = useHistory()
    await flushPromises()
    vi.mocked(api.getStatus).mockClear()
    getFallbackVaultFileChanges().publish({
      path: 'inbox/a',
      kind: 'write',
      newMtime: 1,
    })
    await flushPromises()
    expect(api.getStatus).toHaveBeenCalledOnce()
    expect(history.available.value).toBe(true)
  })

  it('retains the existing Timeline and exposes an error when refresh fails', async () => {
    const history = useHistory()
    await flushPromises()
    await flushPromises()
    history.log.value = [{
      sha: 'a'.repeat(40),
      parents: [],
      author: 'A',
      date: new Date().toISOString(),
      subject: 'Existing history',
      body: '',
      files: ['inbox/a.md'],
    }]
    vi.mocked(api.getLog).mockRejectedValueOnce(new Error('offline'))
    await history.refreshLog()
    expect(history.log.value).toHaveLength(1)
    expect(history.logError.value).toEqual({ message: 'offline' })
    expect(history.logLoading.value).toBe(false)
    expect(history.logLoaded.value).toBe(true)
  })
})

// @vitest-environment jsdom
import { computed, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useHistoryCommit } from '../useHistoryCommit'
import type { HistoryState } from '../useHistory'
import * as api from '../../../lib/history-api'
import { useI18n } from '../../useI18n'

const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() }
vi.mock('../../useToast', () => ({ useToast: () => toast }))
vi.mock('../../../lib/history-api', async () => {
  const actual = await vi.importActual<typeof api>('../../../lib/history-api')
  return {
    ...actual,
    createCommit: vi.fn(),
    getContentHashes: vi.fn(),
    getIndexRepairStatus: vi.fn(),
    repairIndex: vi.fn(),
    discardIndexRepair: vi.fn(),
  }
})

const repairTransaction: api.IndexRepairTransaction = {
  token: 'a'.repeat(32),
  status: 'pending',
  head: 'b'.repeat(40),
  paths: ['a.md'],
  expectedIndex: { 'a.md': [{ mode: '100644', oid: 'c'.repeat(40), stage: 0 }] },
}

function history(paths = ['inbox/a.md', 'inbox/b.md']): HistoryState {
  const status = ref(paths.map((path) => ({ path, index: ' ', worktree: 'M' })))
  return {
    capability: ref({ gitAvailable: true, repoInitialized: true }),
    status,
    log: ref([]),
    logLoading: ref(false),
    logLoaded: ref(true),
    logError: ref(null),
    available: ref(true),
    dirtyCount: computed(() => status.value.length),
    refreshCapability: vi.fn(),
    refreshStatus: vi.fn(),
    refreshLog: vi.fn(),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useI18n().setLocale('en')
  vi.mocked(api.getContentHashes).mockImplementation(async (paths) => (
    Object.fromEntries(paths.map((path) => [path, 'a'.repeat(64)]))
  ))
  vi.mocked(api.repairIndex).mockResolvedValue({ repaired: true })
  vi.mocked(api.getIndexRepairStatus).mockResolvedValue([])
  vi.mocked(api.discardIndexRepair).mockResolvedValue(undefined)
})

describe('useHistoryCommit', () => {
  it('registers and settles Repair transactions synchronously for sibling workflows', () => {
    const commit = useHistoryCommit({ history: history(), saveSelected: vi.fn() })
    commit.registerIndexRepair(repairTransaction)

    expect(commit.indexRepairTransactions.value).toEqual([repairTransaction])
    expect(commit.indexRepairPaths.value).toEqual(['a.md'])

    commit.settleIndexRepairPaths(['a.md'])
    expect(commit.indexRepairTransactions.value).toEqual([])
  })

  it('clears a replaced superseded token when the status refresh fails', async () => {
    const superseded = {
      ...repairTransaction,
      token: 'd'.repeat(32),
      status: 'superseded' as const,
    }
    vi.mocked(api.getIndexRepairStatus).mockResolvedValueOnce([superseded])
    const commit = useHistoryCommit({ history: history(), saveSelected: vi.fn() })
    await Promise.resolve()
    await Promise.resolve()
    expect(commit.indexRepairConflictToken.value).toBe(superseded.token)

    const pending = { ...repairTransaction, token: 'e'.repeat(32) }
    vi.mocked(api.getIndexRepairStatus).mockRejectedValueOnce(new Error('temporary failure'))
    commit.registerIndexRepair(pending)

    expect(commit.indexRepairTransactions.value).toEqual([pending])
    expect(commit.indexRepairConflictToken.value).toBeNull()
    expect(commit.indexRepairPaths.value).toEqual(['a.md'])
    await expect(commit.refreshIndexRepairStatus()).resolves.toBe(false)
    expect(commit.indexRepairConflictToken.value).toBeNull()
    expect(commit.indexRepairPaths.value).toEqual(['a.md'])
  })

  it('clears the conflict token when settling its superseded transaction', async () => {
    const superseded = { ...repairTransaction, status: 'superseded' as const }
    vi.mocked(api.getIndexRepairStatus).mockResolvedValueOnce([superseded])
    const commit = useHistoryCommit({ history: history(), saveSelected: vi.fn() })
    await Promise.resolve()
    await Promise.resolve()
    expect(commit.indexRepairConflictToken.value).toBe(superseded.token)

    commit.settleIndexRepairPaths(['a.md'])

    expect(commit.indexRepairTransactions.value).toEqual([])
    expect(commit.indexRepairConflictToken.value).toBeNull()
  })

  it('selects the initial changed set, supports partial selection, and preserves exact .md paths', async () => {
    const h = history()
    const saveSelected = vi.fn().mockResolvedValue(undefined)
    vi.mocked(api.createCommit).mockResolvedValue({ sha: 'abc', filesCommitted: ['inbox/a.md'] })
    const commit = useHistoryCommit({ history: h, saveSelected })
    commit.toggle('inbox/b.md')
    commit.message.value = '  Update A  '

    await commit.submit()

    expect(saveSelected).toHaveBeenCalledWith(['inbox/a.md'])
    expect(api.createCommit).toHaveBeenCalledWith(
      ['inbox/a.md'],
      'Update A',
      { 'inbox/a.md': 'a'.repeat(64) },
    )
    expect(api.createCommit).not.toHaveBeenCalledWith(expect.arrayContaining(['inbox/b.md']), expect.anything())
    expect(h.refreshStatus).toHaveBeenCalledOnce()
    expect(h.refreshLog).toHaveBeenCalledOnce()
    expect(commit.repositoryChangeId.value).toBe(0)
    expect(commit.message.value).toBe('')
    expect(commit.selectedPaths.value.size).toBe(0)
  })

  it('repairs a degraded real index and refreshes Changes', async () => {
    const h = history(['a.md'])
    let repaired = false
    vi.mocked(api.getIndexRepairStatus).mockImplementation(async () => (
      repaired ? [] : [repairTransaction]
    ))
    vi.mocked(api.repairIndex).mockImplementation(async () => {
      repaired = true
      return { repaired: true }
    })
    vi.mocked(api.createCommit).mockResolvedValue({
      sha: 'abc',
      filesCommitted: ['a.md'],
      indexRefreshFailed: true,
      indexRepair: repairTransaction,
    })
    const commit = useHistoryCommit({ history: h, saveSelected: vi.fn() })
    commit.message.value = 'Version'
    await commit.submit()

    await expect(commit.retryIndexRepair()).resolves.toBe(true)

    expect(api.repairIndex).toHaveBeenCalledWith(repairTransaction.token)
    expect(commit.indexRepairPaths.value).toEqual([])
    expect(h.refreshStatus).toHaveBeenCalledTimes(2)
    expect(toast.success).toHaveBeenCalledWith('Git status repaired.')
  })

  it('warns without reporting failure when repaired Index metadata cannot be cleared', async () => {
    const h = history(['a.md'])
    vi.mocked(api.getIndexRepairStatus).mockResolvedValue([repairTransaction])
    vi.mocked(api.repairIndex).mockResolvedValue({
      repaired: true,
      repairStatePersistenceFailed: true,
    })
    const commit = useHistoryCommit({ history: h, saveSelected: vi.fn() })
    await Promise.resolve()
    await Promise.resolve()

    await expect(commit.retryIndexRepair()).resolves.toBe(true)

    expect(h.refreshStatus).toHaveBeenCalledOnce()
    expect(commit.error.value).toBeNull()
    expect(toast.error).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.info).toHaveBeenCalledWith(
      'The Git index was repaired, but the repair record could not be cleared. Current files and staged changes are unaffected.',
      5000,
    )
  })

  it('removes a repaired transaction locally when the status refresh fails', async () => {
    vi.mocked(api.getIndexRepairStatus)
      .mockResolvedValueOnce([repairTransaction])
      .mockRejectedValueOnce(new Error('temporary failure'))
    const commit = useHistoryCommit({ history: history(), saveSelected: vi.fn() })
    await Promise.resolve()
    await Promise.resolve()

    await expect(commit.retryIndexRepair()).resolves.toBe(true)

    expect(commit.indexRepairTransactions.value).toEqual([])
    expect(commit.indexRepairPaths.value).toEqual([])
  })

  it('keeps a repaired transaction locally when its metadata cannot be cleared', async () => {
    vi.mocked(api.getIndexRepairStatus)
      .mockResolvedValueOnce([repairTransaction])
      .mockRejectedValueOnce(new Error('temporary failure'))
    vi.mocked(api.repairIndex).mockResolvedValue({
      repaired: true,
      repairStatePersistenceFailed: true,
    })
    const commit = useHistoryCommit({ history: history(), saveSelected: vi.fn() })
    await Promise.resolve()
    await Promise.resolve()

    await expect(commit.retryIndexRepair()).resolves.toBe(true)

    expect(commit.indexRepairTransactions.value).toEqual([repairTransaction])
    expect(commit.indexRepairPaths.value).toEqual(['a.md'])
  })

  it('restores persisted repair transactions when the Vault is recreated', async () => {
    vi.mocked(api.getIndexRepairStatus).mockResolvedValue([repairTransaction])
    const first = useHistoryCommit({ history: history(), saveSelected: vi.fn() })
    await Promise.resolve()
    await Promise.resolve()
    expect(first.indexRepairPaths.value).toEqual(['a.md'])

    const afterReload = useHistoryCommit({ history: history(), saveSelected: vi.fn() })
    await Promise.resolve()
    await Promise.resolve()
    expect(afterReload.indexRepairTransactions.value).toEqual([repairTransaction])
  })

  it('restores a superseded transaction directly as a dismissible conflict', async () => {
    const superseded = { ...repairTransaction, status: 'superseded' as const }
    vi.mocked(api.getIndexRepairStatus).mockResolvedValue([superseded])
    const commit = useHistoryCommit({ history: history(), saveSelected: vi.fn() })
    await Promise.resolve()
    await Promise.resolve()

    expect(commit.indexRepairConflictToken.value).toBe(superseded.token)
  })

  it('keeps the repair transaction and explains a newer staged-index conflict', async () => {
    let discarded = false
    vi.mocked(api.getIndexRepairStatus).mockImplementation(async () => (
      discarded ? [] : [repairTransaction]
    ))
    vi.mocked(api.discardIndexRepair).mockImplementation(async () => { discarded = true })
    vi.mocked(api.repairIndex).mockRejectedValue(
      new api.HistoryApiError('index changed after repair was requested: a.md', 409),
    )
    const commit = useHistoryCommit({ history: history(), saveSelected: vi.fn() })
    await Promise.resolve()
    await Promise.resolve()

    await expect(commit.retryIndexRepair()).resolves.toBe(false)

    expect(commit.indexRepairPaths.value).toEqual(['a.md'])
    expect(commit.error.value).toBe(
      'The index was changed by another Git operation. Nuvyn did not repair it because that could clear newly staged content.',
    )

    await expect(commit.discardConflictingIndexRepair()).resolves.toBe(true)
    expect(api.discardIndexRepair).toHaveBeenCalledWith(repairTransaction.token)
    expect(commit.indexRepairPaths.value).toEqual([])
    expect(toast.success).toHaveBeenCalledWith(
      'Current staged changes were kept and the repair notice was dismissed.',
    )
  })

  it('reports repair metadata persistence failure without turning it into a discardable conflict', async () => {
    vi.mocked(api.getIndexRepairStatus).mockResolvedValue([repairTransaction])
    vi.mocked(api.repairIndex).mockRejectedValue(
      new api.HistoryApiError(
        'Git Index changed, but the repair record could not be saved',
        409,
        'HISTORY_INDEX_REPAIR_STATE_PERSISTENCE_FAILED',
        { replacementApplied: true, finalHead: 'b'.repeat(40) },
      ),
    )
    const commit = useHistoryCommit({ history: history(), saveSelected: vi.fn() })
    await Promise.resolve()
    await Promise.resolve()

    await expect(commit.retryIndexRepair()).resolves.toBe(false)

    expect(commit.error.value).toBe(
      'The Git index changed, but the new repair record could not be saved. Check Git status manually.',
    )
    expect(commit.indexRepairConflictToken.value).toBeNull()
    expect(commit.indexRepairTransactions.value).toEqual([repairTransaction])
    expect(api.getIndexRepairStatus).toHaveBeenCalledTimes(2)
    expect(toast.error).toHaveBeenCalledWith(commit.error.value)
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.info).not.toHaveBeenCalled()
  })

  it('does not report success when a post-commit external mutation is returned', async () => {
    const h = history(['a.md'])
    vi.mocked(api.createCommit).mockRejectedValue(
      new api.HistoryApiError(
        'replacement committed, but the previous generation changed externally and was quarantined',
        409,
        'HISTORY_POST_COMMIT_EXTERNAL_MUTATION',
        { replacementApplied: true, quarantined: true },
      ),
    )
    const commit = useHistoryCommit({ history: h, saveSelected: vi.fn() })
    commit.message.value = 'Version'

    await expect(commit.submit()).resolves.toBeNull()

    expect(commit.error.value).toContain('previous generation changed externally')
    expect(toast.error).toHaveBeenCalledWith(commit.error.value)
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('removes a discarded transaction locally when the status refresh fails', async () => {
    const superseded = { ...repairTransaction, status: 'superseded' as const }
    vi.mocked(api.getIndexRepairStatus)
      .mockResolvedValueOnce([superseded])
      .mockRejectedValueOnce(new Error('temporary failure'))
    const commit = useHistoryCommit({ history: history(), saveSelected: vi.fn() })
    await Promise.resolve()
    await Promise.resolve()

    await expect(commit.discardConflictingIndexRepair()).resolves.toBe(true)

    expect(commit.indexRepairTransactions.value).toEqual([])
    expect(commit.indexRepairConflictToken.value).toBeNull()
    expect(commit.indexRepairPaths.value).toEqual([])
  })

  it('keeps older pending repair paths after a later successful commit', async () => {
    const h = history(['b.md'])
    vi.mocked(api.getIndexRepairStatus).mockResolvedValue([repairTransaction])
    vi.mocked(api.createCommit).mockResolvedValue({ sha: 'd'.repeat(40), filesCommitted: ['b.md'] })
    const commit = useHistoryCommit({ history: h, saveSelected: vi.fn() })
    await Promise.resolve()
    await Promise.resolve()
    commit.message.value = 'B'

    await commit.submit()

    expect(commit.indexRepairPaths.value).toEqual(['a.md'])
  })

  it('reports a repository operation conflict without attempting a commit retry', async () => {
    const h = history(['a.md'])
    vi.mocked(api.createCommit).mockRejectedValue(
      new api.HistoryApiError('repository operation in progress', 409),
    )
    const commit = useHistoryCommit({ history: h, saveSelected: vi.fn() })
    commit.message.value = 'Version'

    await commit.submit()

    expect(commit.error.value).toBe(
      'A merge, rebase, or similar Git operation is in progress. Complete or cancel it in Git first.',
    )
    expect(api.createCommit).toHaveBeenCalledOnce()
  })

  it('supports select all and clear selection without auto-selecting later status additions', async () => {
    const h = history(['a.md'])
    const commit = useHistoryCommit({ history: h, saveSelected: vi.fn() })
    commit.clearSelection()
    expect(commit.canCommit.value).toBe(false)
    h.status.value = [...h.status.value, { path: 'new.md', index: '?', worktree: '?' }]
    await Promise.resolve()
    expect([...commit.selectedPaths.value]).toEqual([])
    commit.selectAll()
    expect([...commit.selectedPaths.value]).toEqual(['a.md', 'new.md'])
  })

  it('rejects empty and whitespace-only messages and prevents duplicate requests', async () => {
    const h = history(['a.md'])
    let release!: () => void
    const saving = new Promise<void>((resolve) => { release = resolve })
    const commit = useHistoryCommit({ history: h, saveSelected: vi.fn(() => saving) })
    expect(await commit.submit()).toBeNull()
    commit.message.value = '   '
    expect(await commit.submit()).toBeNull()
    expect(api.createCommit).not.toHaveBeenCalled()

    commit.message.value = 'Version'
    const first = commit.submit()
    const duplicate = await commit.submit()
    expect(duplicate).toBeNull()
    release()
    vi.mocked(api.createCommit).mockResolvedValue({ sha: 'abc', filesCommitted: ['a.md'] })
    await first
    expect(api.createCommit).toHaveBeenCalledOnce()
  })

  it('does not commit when save fails and preserves selection and message', async () => {
    const h = history(['a.md'])
    const commit = useHistoryCommit({
      history: h,
      saveSelected: vi.fn().mockRejectedValue(new Error('disk full')),
    })
    commit.message.value = 'Keep me'

    await commit.submit()

    expect(api.createCommit).not.toHaveBeenCalled()
    expect(commit.message.value).toBe('Keep me')
    expect([...commit.selectedPaths.value]).toEqual(['a.md'])
    expect(commit.error.value).toContain('disk full')
    expect(commit.busy.value).toBe(false)
  })

  it('preserves input on commit failure and refreshes stale selections without retrying', async () => {
    const h = history(['a.md', 'b.md'])
    vi.mocked(h.refreshStatus).mockImplementation(async () => {
      h.status.value = [{ path: 'b.md', index: ' ', worktree: 'M' }]
    })
    vi.mocked(api.createCommit).mockRejectedValue(new api.HistoryApiError('selection is stale', 409))
    const commit = useHistoryCommit({ history: h, saveSelected: vi.fn() })
    commit.message.value = 'Retry me'

    await commit.submit()

    expect(api.createCommit).toHaveBeenCalledOnce()
    expect(h.refreshStatus).toHaveBeenCalledOnce()
    expect([...commit.selectedPaths.value]).toEqual(['b.md'])
    expect(commit.message.value).toBe('Retry me')
    expect(commit.error.value).toContain('Review the refreshed list')
  })

  it('keeps the message, selection, and workspace content after a normal commit failure', async () => {
    const h = history(['a.md'])
    const editor = { raw: '# Current', saveStatus: 'idle' }
    const snapshot = { rawMarkdown: '# Historical' }
    const diff = { oldRaw: '# Historical', newRaw: '# Current' }
    vi.mocked(api.createCommit).mockRejectedValue(new Error('author identity missing'))
    const commit = useHistoryCommit({ history: h, saveSelected: vi.fn() })
    commit.message.value = 'Keep everything'

    await commit.submit()

    expect(commit.message.value).toBe('Keep everything')
    expect([...commit.selectedPaths.value]).toEqual(['a.md'])
    expect(editor).toEqual({ raw: '# Current', saveStatus: 'idle' })
    expect(snapshot.rawMarkdown).toBe('# Historical')
    expect(diff).toEqual({ oldRaw: '# Historical', newRaw: '# Current' })
    expect(h.refreshStatus).not.toHaveBeenCalled()
    expect(h.refreshLog).not.toHaveBeenCalled()
  })

  it('updates the shared dirty count while leaving uncommitted files dirty', async () => {
    const h = history(['a.md', 'b.md'])
    vi.mocked(h.refreshStatus).mockImplementation(async () => {
      h.status.value = [{ path: 'b.md', index: ' ', worktree: 'M' }]
    })
    vi.mocked(api.createCommit).mockResolvedValue({ sha: 'abc', filesCommitted: ['a.md'] })
    const commit = useHistoryCommit({ history: h, saveSelected: vi.fn() })
    commit.toggle('b.md')
    commit.message.value = 'Only A'

    await commit.submit()

    expect(h.dirtyCount.value).toBe(1)
    expect(h.status.value[0]?.path).toBe('b.md')
  })

  it('refreshes existing comparisons after a successful commit', async () => {
    const h = history(['a.md'])
    const refreshComparisons = vi.fn()
    vi.mocked(api.createCommit).mockResolvedValue({ sha: 'abc', filesCommitted: ['a.md'] })
    const commit = useHistoryCommit({ history: h, saveSelected: vi.fn(), refreshComparisons })
    commit.message.value = 'Version'
    await commit.submit()
    expect(refreshComparisons).toHaveBeenCalledWith(['a.md'])
  })

  it('keeps the barrier through commit and releases it before post-commit refreshes', async () => {
    const h = history(['a.md'])
    const calls: string[] = []
    const release = vi.fn(async () => { calls.push('release') })
    vi.mocked(h.refreshStatus).mockImplementation(async () => { calls.push('status') })
    vi.mocked(h.refreshLog).mockImplementation(async () => { calls.push('log') })
    vi.mocked(api.createCommit).mockImplementation(async () => {
      calls.push('commit')
      return { sha: 'abc', filesCommitted: ['a.md'] }
    })
    const commit = useHistoryCommit({
      history: h,
      saveSelected: vi.fn(async () => {
        calls.push('barrier')
        return release
      }),
    })
    commit.message.value = 'Version'

    await commit.submit()

    expect(calls[0]).toBe('barrier')
    expect(calls[1]).toBe('commit')
    expect(calls[2]).toBe('release')
    expect(calls.slice(3).sort()).toEqual(['log', 'status'])
    expect(release).toHaveBeenCalledOnce()
  })

  it('disables submission and reports a mutation-lock conflict', async () => {
    const h = history(['a.md'])
    const locked = ref(true)
    const commit = useHistoryCommit({
      history: h,
      saveSelected: vi.fn(),
      canMutate: () => !locked.value,
      acquireMutation: () => null,
    })
    commit.message.value = 'Version'

    expect(commit.canCommit.value).toBe(false)
    await expect(commit.submit()).resolves.toBeNull()

    expect(commit.error.value).toBe('Another change is in progress for this document. Try again shortly.')
    expect(toast.info).toHaveBeenCalledWith(commit.error.value)
    expect(api.getContentHashes).not.toHaveBeenCalled()
  })

  it('treats index refresh degradation as a successful version with a warning', async () => {
    const h = history(['a.md'])
    vi.mocked(api.createCommit).mockResolvedValue({
      sha: 'abc',
      filesCommitted: ['a.md'],
      indexRefreshFailed: true,
      indexRepair: repairTransaction,
    })
    const commit = useHistoryCommit({ history: h, saveSelected: vi.fn() })
    commit.message.value = 'Version'

    await expect(commit.submit()).resolves.toMatchObject({ sha: 'abc' })

    expect(commit.message.value).toBe('')
    expect(commit.selectedPaths.value.size).toBe(0)
    expect(toast.error).not.toHaveBeenCalled()
    expect(toast.info).toHaveBeenCalledWith(
      'Version created, but Git status could not be synchronized. Retry the repair.',
      5000,
    )
  })

  it('reports repair-state persistence failure as a degraded successful version', async () => {
    const h = history(['a.md'])
    vi.mocked(api.createCommit).mockResolvedValue({
      sha: 'abc',
      filesCommitted: ['a.md'],
      indexRefreshFailed: true,
      repairStatePersistenceFailed: true,
    })
    const commit = useHistoryCommit({ history: h, saveSelected: vi.fn() })
    commit.message.value = 'Version'

    await expect(commit.submit()).resolves.toMatchObject({ sha: 'abc' })

    expect(commit.error.value).toBeNull()
    expect(commit.message.value).toBe('')
    expect(toast.error).not.toHaveBeenCalled()
    expect(toast.info).toHaveBeenCalledWith(
      'Version created, but automatic repair information could not be saved. Check Git status in a terminal.',
      5000,
    )
  })

  it('reports an external HEAD CAS conflict and refreshes status and Timeline', async () => {
    const h = history(['a.md'])
    vi.mocked(api.createCommit).mockRejectedValue(
      new api.HistoryApiError('repository changed before commit', 409),
    )
    const commit = useHistoryCommit({ history: h, saveSelected: vi.fn() })
    commit.message.value = 'Version'

    await commit.submit()

    expect(h.refreshStatus).toHaveBeenCalledOnce()
    expect(h.refreshLog).toHaveBeenCalledOnce()
    expect(commit.repositoryChangeId.value).toBe(1)
    expect(commit.error.value).toBe(
      'The repository changed before the version could be created. Review the refreshed status and retry.',
    )
  })
})

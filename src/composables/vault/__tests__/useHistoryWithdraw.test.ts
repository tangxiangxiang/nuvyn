// @vitest-environment jsdom
import { computed, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useHistoryWithdraw } from '../useHistoryWithdraw'
import type { HistoryState } from '../useHistory'
import { HistoryApiError, type DropCommitResult } from '../../../lib/history-api'
import { useI18n } from '../../useI18n'

const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() }
vi.mock('../../useToast', () => ({ useToast: () => toast }))

function history(): HistoryState {
  const status = ref([])
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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const result = (overrides: Partial<DropCommitResult> = {}): DropCommitResult => ({
  sha: 'a'.repeat(40),
  droppedSha: 'b'.repeat(40),
  filesChanged: ['inbox/a.md'],
  indexRefreshFailed: false,
  repairStatePersistenceFailed: false,
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  useI18n().setLocale('en')
})

describe('useHistoryWithdraw', () => {
  it('is single-flight and refreshes Status, Timeline, revisions, comparisons, and repair state', async () => {
    const h = history()
    const request = deferred<DropCommitResult>()
    const drop = vi.fn(() => request.promise)
    const release = vi.fn()
    const refreshComparisons = vi.fn()
    const refreshIndexRepairStatus = vi.fn().mockResolvedValue(true)
    const registerIndexRepair = vi.fn()
    const settleIndexRepairPaths = vi.fn()
    const closeDroppedRevision = vi.fn()
    const withdraw = useHistoryWithdraw({
      history: h,
      confirm: vi.fn().mockResolvedValue(true),
      acquireMutation: () => release,
      refreshComparisons,
      refreshIndexRepairStatus,
      registerIndexRepair,
      settleIndexRepairPaths,
      closeDroppedRevision,
      drop,
    })

    const first = withdraw.withdraw('b'.repeat(40))
    const duplicate = withdraw.withdraw('b'.repeat(40))
    await Promise.resolve()
    expect(withdraw.busy.value).toBe(true)
    expect(drop).toHaveBeenCalledOnce()
    await expect(duplicate).resolves.toBeNull()

    request.resolve(result())
    await expect(first).resolves.toEqual(result())

    expect(h.refreshStatus).toHaveBeenCalledOnce()
    expect(h.refreshLog).toHaveBeenCalledOnce()
    expect(refreshComparisons).toHaveBeenCalledWith(['inbox/a.md'])
    expect(refreshIndexRepairStatus).toHaveBeenCalledOnce()
    expect(settleIndexRepairPaths).toHaveBeenCalledWith(['inbox/a.md'])
    expect(closeDroppedRevision).toHaveBeenCalledWith('b'.repeat(40))
    expect(withdraw.completionId.value).toBe(1)
    expect(release).toHaveBeenCalledOnce()
    expect(toast.success).toHaveBeenCalledWith(
      'The latest version was withdrawn and document changes were kept.',
    )
  })

  it('does not clear or refresh the current UI when withdrawal fails', async () => {
    const h = history()
    const closeDroppedRevision = vi.fn()
    const refreshComparisons = vi.fn()
    const withdraw = useHistoryWithdraw({
      history: h,
      confirm: vi.fn().mockResolvedValue(true),
      acquireMutation: () => () => {},
      refreshComparisons,
      refreshIndexRepairStatus: vi.fn(),
      registerIndexRepair: vi.fn(),
      settleIndexRepairPaths: vi.fn(),
      closeDroppedRevision,
      drop: vi.fn().mockRejectedValue(new HistoryApiError('server failed', 500)),
    })

    await expect(withdraw.withdraw('b'.repeat(40))).resolves.toBeNull()

    expect(closeDroppedRevision).not.toHaveBeenCalled()
    expect(refreshComparisons).not.toHaveBeenCalled()
    expect(h.refreshStatus).not.toHaveBeenCalled()
    expect(h.refreshLog).not.toHaveBeenCalled()
    expect(withdraw.completionId.value).toBe(0)
    expect(toast.error).toHaveBeenCalledWith('Could not withdraw the latest version: server failed')
  })

  it('does not open confirmation while another Vault mutation owns the lock', async () => {
    const confirm = vi.fn().mockResolvedValue(true)
    const drop = vi.fn()
    const withdraw = useHistoryWithdraw({
      history: history(),
      confirm,
      canMutate: () => false,
      acquireMutation: () => null,
      refreshComparisons: vi.fn(),
      refreshIndexRepairStatus: vi.fn(),
      registerIndexRepair: vi.fn(),
      settleIndexRepairPaths: vi.fn(),
      closeDroppedRevision: vi.fn(),
      drop,
    })

    expect(withdraw.canWithdraw.value).toBe(false)
    await expect(withdraw.withdraw('b'.repeat(40))).resolves.toBeNull()
    expect(confirm).not.toHaveBeenCalled()
    expect(drop).not.toHaveBeenCalled()
    expect(toast.info).toHaveBeenCalledWith(
      'Another History action is in progress. Try again shortly.',
    )
  })

  it('refreshes repository state after a latest-version conflict', async () => {
    const h = history()
    const withdraw = useHistoryWithdraw({
      history: h,
      confirm: vi.fn().mockResolvedValue(true),
      acquireMutation: () => () => {},
      refreshComparisons: vi.fn(),
      refreshIndexRepairStatus: vi.fn(),
      registerIndexRepair: vi.fn(),
      settleIndexRepairPaths: vi.fn(),
      closeDroppedRevision: vi.fn(),
      drop: vi.fn().mockRejectedValue(
        new HistoryApiError('repository changed before withdrawal', 409),
      ),
    })

    await withdraw.withdraw('b'.repeat(40))

    expect(h.refreshStatus).toHaveBeenCalledOnce()
    expect(h.refreshLog).toHaveBeenCalledOnce()
    expect(withdraw.error.value).toBe('The latest version has changed. Refresh and try again.')
  })

  it.each([
    ['HISTORY_NOT_NUVYN_VERSION', 'This commit is not a Nuvyn version created by this Vault, so it cannot be withdrawn.'],
  ] as const)('shows a specific marker message for %s', async (code, expected) => {
    const h = history()
    const withdraw = useHistoryWithdraw({
      history: h,
      confirm: vi.fn().mockResolvedValue(true),
      acquireMutation: () => () => {},
      refreshComparisons: vi.fn(),
      refreshIndexRepairStatus: vi.fn(),
      registerIndexRepair: vi.fn(),
      settleIndexRepairPaths: vi.fn(),
      closeDroppedRevision: vi.fn(),
      drop: vi.fn().mockRejectedValue(new HistoryApiError('marker rejected', 409, code)),
    })

    await withdraw.withdraw('b'.repeat(40))

    expect(withdraw.error.value).toBe(expected)
    expect(h.refreshStatus).not.toHaveBeenCalled()
    expect(h.refreshLog).not.toHaveBeenCalled()
  })

  it('does not turn an unrecognized 409 into a latest-version message', async () => {
    const withdraw = useHistoryWithdraw({
      history: history(),
      confirm: vi.fn().mockResolvedValue(true),
      acquireMutation: () => () => {},
      refreshComparisons: vi.fn(),
      refreshIndexRepairStatus: vi.fn(),
      registerIndexRepair: vi.fn(),
      settleIndexRepairPaths: vi.fn(),
      closeDroppedRevision: vi.fn(),
      drop: vi.fn().mockRejectedValue(new HistoryApiError('unsafe transition', 409)),
    })

    await withdraw.withdraw('b'.repeat(40))

    expect(withdraw.error.value).toBe('Could not withdraw the latest version: unsafe transition')
  })

  it('reports Index and repair-record degradation as successful withdrawals', async () => {
    const h = history()
    const drop = vi.fn()
      .mockResolvedValueOnce(result({ indexRefreshFailed: true }))
      .mockResolvedValueOnce(result({
        indexRefreshFailed: true,
        repairStatePersistenceFailed: true,
      }))
    const withdraw = useHistoryWithdraw({
      history: h,
      confirm: vi.fn().mockResolvedValue(true),
      acquireMutation: () => () => {},
      refreshComparisons: vi.fn(),
      refreshIndexRepairStatus: vi.fn(),
      registerIndexRepair: vi.fn(),
      settleIndexRepairPaths: vi.fn(),
      closeDroppedRevision: vi.fn(),
      drop,
    })

    await expect(withdraw.withdraw('b'.repeat(40))).resolves.toMatchObject({ indexRefreshFailed: true })
    expect(toast.info).toHaveBeenLastCalledWith(
      'The latest version was withdrawn, but Git status needs repair. No document content was lost.',
      5000,
    )

    await expect(withdraw.withdraw('b'.repeat(40))).resolves.toMatchObject({
      repairStatePersistenceFailed: true,
    })
    expect(toast.info).toHaveBeenLastCalledWith(
      'The latest version was withdrawn, but its Git repair record could not be saved. Check Git status.',
      5000,
    )
  })

  it('registers a returned Repair transaction before a failed server-status refresh', async () => {
    const transaction = {
      token: 'c'.repeat(32),
      status: 'pending' as const,
      head: 'a'.repeat(40),
      paths: ['inbox/a.md'],
      expectedIndex: { 'inbox/a.md': [] },
    }
    const registerIndexRepair = vi.fn()
    const refreshIndexRepairStatus = vi.fn().mockResolvedValue(false)
    const withdraw = useHistoryWithdraw({
      history: history(),
      confirm: vi.fn().mockResolvedValue(true),
      acquireMutation: () => () => {},
      refreshComparisons: vi.fn(),
      refreshIndexRepairStatus,
      registerIndexRepair,
      settleIndexRepairPaths: vi.fn(),
      closeDroppedRevision: vi.fn(),
      drop: vi.fn().mockResolvedValue(result({
        indexRefreshFailed: true,
        indexRepair: transaction,
      })),
    })

    await withdraw.withdraw('b'.repeat(40))

    expect(registerIndexRepair).toHaveBeenCalledWith(transaction)
    expect(registerIndexRepair.mock.invocationCallOrder[0]).toBeLessThan(
      refreshIndexRepairStatus.mock.invocationCallOrder[0]!,
    )
  })
})

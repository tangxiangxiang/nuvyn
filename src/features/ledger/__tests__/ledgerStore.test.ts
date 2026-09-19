// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  LedgerAccountDto,
  LedgerCategoryDto,
  LedgerOverviewDto,
  LedgerOverviewScope,
  LedgerSettingsDto,
} from '../../../../shared/ledgerProtocol'
import { LedgerApiError } from '../ledgerErrors'

const api = vi.hoisted(() => ({
  getLedgerSettings: vi.fn(),
  listLedgerAccounts: vi.fn(),
  listLedgerCategories: vi.fn(),
  getLedgerOverview: vi.fn(),
  listLedgerTransactions: vi.fn(),
  createLedgerSettings: vi.fn(),
  createLedgerAccount: vi.fn(),
  createLedgerCategory: vi.fn(),
  createLedgerTransaction: vi.fn(),
  getLedgerAccount: vi.fn(),
  getLedgerTransaction: vi.fn(),
  getLedgerAccountTransactions: vi.fn(),
  patchLedgerSettings: vi.fn(),
  patchLedgerAccount: vi.fn(),
  archiveLedgerAccount: vi.fn(),
  restoreLedgerAccount: vi.fn(),
  deleteLedgerAccount: vi.fn(),
  patchLedgerCategory: vi.fn(),
  archiveLedgerCategory: vi.fn(),
  restoreLedgerCategory: vi.fn(),
  deleteLedgerCategory: vi.fn(),
  patchLedgerTransaction: vi.fn(),
  deleteLedgerTransaction: vi.fn(),
}))

vi.mock('../api', () => api)

import { resetLedgerStoreForTesting, useLedgerStore } from '../ledgerStore'

const settings = (hasCreatedAccount: boolean): LedgerSettingsDto => ({
  baseCurrency: 'CNY',
  currencyExponent: 2,
  timezone: 'Asia/Shanghai',
  hasCreatedAccount,
  version: 1,
  createdAt: 1,
  updatedAt: 1,
})

const account = (id: string, archivedAt: number | null = null): LedgerAccountDto => ({
  id,
  name: id,
  type: 'bank',
  nature: 'asset',
  openingBalanceMinor: 0,
  openingDate: '2026-01-01',
  currency: 'CNY',
  currencyExponent: 2,
  note: '',
  archivedAt,
  version: 1,
  createdAt: 1,
  updatedAt: 1,
  currentBalanceMinor: 0,
})

const category = (id: string): LedgerCategoryDto => ({
  id,
  kind: 'expense',
  name: id,
  normalizedName: id,
  archivedAt: null,
  version: 1,
  createdAt: 1,
  updatedAt: 1,
})

const overview = (): LedgerOverviewDto => ({
  context: { anchorDate: '2026-09-05', todayDate: '2026-09-05', isToday: true, scope: 'month' },
  currency: 'CNY',
  currencyExponent: 2,
  assetTotalMinor: 0,
  liabilityTotalMinor: 0,
  netWorthMinor: 0,
  accounts: [],
  cashflow: { incomeMinor: 0, expenseMinor: 0, balanceMinor: 0 },
  categoryBreakdown: { income: [], expense: [] },
  periods: [],
  trend: [],
  recentTransactions: [],
})

function overviewFor(
  scope: LedgerOverviewScope,
  anchorDate: string,
  isToday = false,
): LedgerOverviewDto {
  return {
    ...overview(),
    context: {
      ...overview().context,
      scope,
      anchorDate,
      isToday,
    },
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve })
  return { promise, resolve }
}

describe('Ledger feature-local state', () => {
  beforeEach(() => {
    sessionStorage.clear()
    resetLedgerStoreForTesting()
    vi.clearAllMocks()
    api.listLedgerCategories.mockResolvedValue([])
    api.getLedgerOverview.mockResolvedValue(overview())
    api.listLedgerTransactions.mockResolvedValue({ transactions: [], page: { nextCursor: null } })
  })

  it('uses hasCreatedAccount, not account-list length, for lifecycle states', async () => {
    api.getLedgerSettings.mockResolvedValueOnce(settings(false)).mockResolvedValueOnce(settings(true))
    api.listLedgerAccounts.mockResolvedValueOnce([]).mockResolvedValueOnce([])
    const store = useLedgerStore()

    await store.bootstrap()
    expect(store.workspaceState.value).toBe('FIRST_ACCOUNT_REQUIRED')

    await store.bootstrap()
    expect(store.workspaceState.value).toBe('NO_ACTIVE_ACCOUNT')
  })

  it('enters the fresh Ledger onboarding state from a successful null Settings response', async () => {
    api.getLedgerSettings.mockResolvedValue(null)
    const store = useLedgerStore()

    const result = await store.bootstrap()

    expect(result).toBeUndefined()
    expect(store.workspaceState.value).toBe('UNINITIALIZED')
    expect(store.settings.value).toBeNull()
    expect(store.accounts.value).toEqual([])
    expect(store.categories.value).toEqual([])
    expect(store.overview.value).toBeNull()
    expect(store.workspaceError.value).toBeNull()
    expect(api.listLedgerAccounts).not.toHaveBeenCalled()
    expect(api.listLedgerCategories).not.toHaveBeenCalled()
    expect(api.getLedgerOverview).not.toHaveBeenCalled()
  })

  it.each([
    ['an empty-body HTTP 404', new LedgerApiError('not found', 404, 'ledger-http-404')],
    ['the legacy ledger-not-found error', new LedgerApiError('missing', 404, 'ledger-not-found')],
  ])('keeps %s in the recoverable error state instead of onboarding', async (_label, error) => {
    api.getLedgerSettings.mockRejectedValue(error)
    const store = useLedgerStore()

    const result = await store.bootstrap()

    expect(result).toMatchObject({ status: 'error', error })
    expect(store.workspaceState.value).toBe('RECOVERABLE_ERROR')
    expect(store.workspaceError.value).toBe(error)
    expect(store.settings.value).toBeNull()
    expect(store.accounts.value).toEqual([])
    expect(store.categories.value).toEqual([])
    expect(api.listLedgerAccounts).not.toHaveBeenCalled()
    expect(api.listLedgerCategories).not.toHaveBeenCalled()
  })

  it('assigns an initial Overview read failure to the Workspace recovery boundary', async () => {
    api.getLedgerSettings.mockResolvedValue(settings(true))
    api.listLedgerAccounts.mockResolvedValue([account('account-1')])
    const overviewError = new LedgerApiError('overview unavailable', 500, 'ledger-internal-error')
    api.getLedgerOverview.mockRejectedValueOnce(overviewError)
    const store = useLedgerStore()

    const result = await store.bootstrap()

    expect(result).toMatchObject({ status: 'error', error: overviewError })
    expect(store.workspaceState.value).toBe('RECOVERABLE_ERROR')
    expect(store.workspaceError.value).toBe(overviewError)
    expect(store.overviewError.value).toBe(overviewError)
    expect(store.overview.value).toBeNull()
  })

  it('uses an explicit overview request context and preserves its anchor across refreshes', async () => {
    api.getLedgerSettings.mockResolvedValue(settings(true))
    api.listLedgerAccounts.mockResolvedValue([account('account-1')])
    const store = useLedgerStore()

    await store.bootstrap()
    expect(api.getLedgerOverview).toHaveBeenLastCalledWith({ scope: 'month', anchorDate: undefined })
    expect(store.overviewRequestContext.value).toEqual({ scope: 'month', anchorDate: undefined })
    expect(store.overviewMatchesRequest.value).toBe(true)

    store.setOverviewRequestContext({ scope: 'month', anchorDate: '2026-08-20' })
    api.getLedgerOverview.mockResolvedValue(overviewFor('month', '2026-08-20'))
    const historicalResult = await store.refreshOverview()
    expect(historicalResult.status).toBe('success')
    expect(api.getLedgerOverview).toHaveBeenLastCalledWith({ scope: 'month', anchorDate: '2026-08-20' })
    expect(store.overviewMatchesRequest.value).toBe(true)

    store.setOverviewRequestContext({ scope: 'year', anchorDate: '2026-08-20' })
    api.getLedgerOverview.mockResolvedValue(overviewFor('year', '2026-08-20'))
    await store.refreshOverview()
    expect(api.getLedgerOverview).toHaveBeenLastCalledWith({ scope: 'year', anchorDate: '2026-08-20' })
    expect(store.overviewRequestContext.value).toEqual({ scope: 'year', anchorDate: '2026-08-20' })
  })

  it('returns a typed future-anchor error without changing the requested context', async () => {
    api.getLedgerSettings.mockResolvedValue(settings(true))
    api.listLedgerAccounts.mockResolvedValue([account('account-1')])
    const store = useLedgerStore()
    await store.bootstrap()

    store.setOverviewRequestContext({ scope: 'month', anchorDate: '2026-09-06' })
    const futureError = new LedgerApiError(
      'future anchor',
      400,
      'ledger-validation-failed',
      { field: 'anchorDate' },
    )
    api.getLedgerOverview.mockRejectedValue(futureError)
    const result = await store.refreshOverview()

    expect(result).toMatchObject({
      status: 'error',
      request: { scope: 'month', anchorDate: '2026-09-06' },
      error: futureError,
    })
    expect(store.overviewRequestContext.value).toEqual({ scope: 'month', anchorDate: '2026-09-06' })
  })

  it('publishes only the latest overview request when navigation races', async () => {
    api.getLedgerSettings.mockResolvedValue(settings(true))
    api.listLedgerAccounts.mockResolvedValue([account('account-1')])
    const store = useLedgerStore()
    await store.bootstrap()

    const first = deferred<LedgerOverviewDto>()
    const second = deferred<LedgerOverviewDto>()
    api.getLedgerOverview.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

    store.setOverviewRequestContext({ scope: 'month', anchorDate: '2026-08-20' })
    const firstRequest = store.refreshOverview()
    store.setOverviewRequestContext({ scope: 'month', anchorDate: '2026-06-15' })
    const secondRequest = store.refreshOverview()

    first.resolve(overviewFor('month', '2026-08-20'))
    expect((await firstRequest).status).toBe('stale')
    expect(store.overview.value?.context.anchorDate).toBe('2026-09-05')

    second.resolve(overviewFor('month', '2026-06-15'))
    expect((await secondRequest).status).toBe('success')
    expect(store.overview.value?.context.anchorDate).toBe('2026-06-15')
    expect(store.overviewMatchesRequest.value).toBe(true)
  })

  it('keeps the current historical context for mutation refreshes', async () => {
    api.getLedgerSettings.mockResolvedValue(settings(true))
    api.listLedgerAccounts.mockResolvedValue([account('account-1')])
    const store = useLedgerStore()
    await store.bootstrap()

    store.setOverviewRequestContext({ scope: 'month', anchorDate: '2026-08-20' })
    api.getLedgerOverview.mockResolvedValue(overviewFor('month', '2026-08-20'))
    await store.refreshOverview()
    api.getLedgerOverview.mockClear()
    await store.refreshData()

    expect(api.getLedgerOverview).toHaveBeenCalledWith({ scope: 'month', anchorDate: '2026-08-20' })
  })

  it.each(['patch', 'delete'] as const)('refreshes the authoritative Overview after a transaction %s while preserving historical context', async (mutation) => {
    api.getLedgerSettings.mockResolvedValue(settings(true))
    api.listLedgerAccounts.mockResolvedValue([account('account-1')])
    const store = useLedgerStore()
    await store.bootstrap()

    store.setOverviewRequestContext({ scope: 'month', anchorDate: '2026-08-20' })
    api.getLedgerOverview.mockResolvedValue(overviewFor('month', '2026-08-20'))
    await store.refreshOverview()
    api.getLedgerOverview.mockClear()

    if (mutation === 'patch') {
      api.patchLedgerTransaction.mockResolvedValue({ id: 'tx-1', type: 'expense' })
      await store.patchTransaction('tx-1', { expectedVersion: 1, note: '更新后的备注' })
    } else {
      api.deleteLedgerTransaction.mockResolvedValue({ id: 'tx-1', type: 'expense' })
      await store.deleteTransaction('tx-1', 1)
    }

    expect(api.getLedgerOverview).toHaveBeenCalledWith({ scope: 'month', anchorDate: '2026-08-20' })
    expect(store.overviewRequestContext.value).toEqual({ scope: 'month', anchorDate: '2026-08-20' })
  })

  it('escalates a successful mutation when its historical overview refresh fails', async () => {
    api.getLedgerSettings.mockResolvedValue(settings(true))
    api.listLedgerAccounts.mockResolvedValue([account('account-1')])
    const store = useLedgerStore()
    await store.bootstrap()

    store.setOverviewRequestContext({ scope: 'month', anchorDate: '2026-08-20' })
    api.getLedgerOverview.mockResolvedValue(overviewFor('month', '2026-08-20'))
    await store.refreshOverview()
    expect(store.overviewMatchesRequest.value).toBe(true)

    const refreshError = new LedgerApiError('overview unavailable', 503, 'ledger-internal-error')
    api.getLedgerOverview.mockRejectedValueOnce(refreshError)
    api.createLedgerTransaction.mockResolvedValue({ id: 'tx-1', type: 'expense' })
    const payload = {
      type: 'expense' as const,
      amountMinor: 3_800,
      accountId: 'account-1',
      categoryId: 'category-1',
      occurredAt: 1_700_000_000_000,
      payee: '',
      note: '',
    }

    await expect(store.createTransaction(payload)).resolves.toMatchObject({ id: 'tx-1' })

    expect(store.workspaceState.value).toBe('RECOVERABLE_ERROR')
    expect(store.overviewRequestedAnchorDate.value).toBe('2026-08-20')
    expect(store.overview.value?.context.anchorDate).toBe('2026-08-20')
    expect(store.overviewMatchesRequest.value).toBe(false)
    expect(store.workspaceError.value).toBe(refreshError)
    expect(store.overviewError.value).toBe(refreshError)
    expect(store.error.value).toBe(refreshError)
    expect(store.loading.value).toBe(false)

    api.getLedgerOverview.mockResolvedValueOnce(overviewFor('month', '2026-08-20'))
    await store.bootstrap()
    expect(store.workspaceState.value).toBe('READY')
    expect(store.overviewMatchesRequest.value).toBe(true)
    expect(store.workspaceError.value).toBeNull()
    expect(store.overviewError.value).toBeNull()
    expect(store.error.value).toBeNull()
  })

  it('does not present refreshed current state behind stale data after a mutation overview failure', async () => {
    api.getLedgerSettings.mockResolvedValue(settings(true))
    api.listLedgerAccounts.mockResolvedValue([account('account-1')])
    const store = useLedgerStore()
    await store.bootstrap()

    store.setOverviewRequestContext({ scope: 'month', anchorDate: '2026-08-20' })
    api.getLedgerOverview.mockResolvedValue(overviewFor('month', '2026-08-20'))
    await store.refreshOverview()
    expect(store.overviewMatchesRequest.value).toBe(true)

    // The mutation refresh sees new current-state data and a historical
    // projection read that fails.
    api.listLedgerAccounts.mockResolvedValue([account('account-1'), account('account-2')])
    api.listLedgerCategories.mockResolvedValue([category('category-1')])
    const refreshError = new LedgerApiError('projection unavailable', 503, 'ledger-internal-error')
    api.getLedgerOverview.mockRejectedValueOnce(refreshError)
    api.createLedgerTransaction.mockResolvedValue({ id: 'tx-1', type: 'expense' })

    await expect(store.createTransaction({
      type: 'expense' as const,
      amountMinor: 3_800,
      accountId: 'account-1',
      categoryId: 'category-1',
      occurredAt: 1_700_000_000_000,
      payee: '',
      note: '',
    })).resolves.toMatchObject({ id: 'tx-1' })

    // The current state was refreshed, but the Overview still contains the old
    // projection. The workspace recovery boundary prevents that stale snapshot
    // from being presented as if it were current.
    expect(store.workspaceState.value).toBe('RECOVERABLE_ERROR')
    expect(store.accounts.value.map((item) => item.id)).toEqual(['account-1', 'account-2'])
    expect(store.categories.value.map((item) => item.id)).toEqual(['category-1'])
    expect(store.overviewDataReady.value).toBe(false)
    expect(store.overviewMatchesRequest.value).toBe(false)
    expect(store.overviewRequestedAnchorDate.value).toBe('2026-08-20')
    expect(store.overviewScope.value).toBe('month')
    expect(store.workspaceError.value).toBe(refreshError)
    expect(store.overviewError.value).toBe(refreshError)
    expect(store.error.value).toBe(refreshError)
    expect(store.loading.value).toBe(false)

    api.getLedgerOverview.mockClear()
    api.getLedgerOverview.mockResolvedValueOnce(overviewFor('month', '2026-08-20'))
    await store.bootstrap()
    expect(api.getLedgerOverview).toHaveBeenCalledTimes(1)
    expect(api.getLedgerOverview).toHaveBeenCalledWith({ scope: 'month', anchorDate: '2026-08-20' })
    expect(store.workspaceState.value).toBe('READY')
    expect(store.overviewDataReady.value).toBe(true)
    expect(store.overviewMatchesRequest.value).toBe(true)
    expect(store.workspaceError.value).toBeNull()
    expect(store.overviewError.value).toBeNull()
    expect(store.error.value).toBeNull()
  })

  it('keeps a current-state error owned by the workspace when a later overview succeeds', async () => {
    api.getLedgerSettings.mockResolvedValue(settings(true))
    api.listLedgerAccounts.mockResolvedValue([account('account-1')])
    const store = useLedgerStore()
    await store.bootstrap()

    const workspaceError = new LedgerApiError('current state unavailable', 503, 'ledger-internal-error')
    api.listLedgerAccounts.mockRejectedValueOnce(workspaceError)
    await store.refreshData()

    expect(store.workspaceState.value).toBe('RECOVERABLE_ERROR')
    expect(store.workspaceError.value).toBe(workspaceError)
    expect(store.overviewError.value).toBeNull()

    api.getLedgerOverview.mockResolvedValueOnce(overview())
    const overviewResult = await store.refreshOverview()
    expect(overviewResult.status).toBe('success')
    expect(store.workspaceError.value).toBe(workspaceError)
    expect(store.workspaceState.value).toBe('RECOVERABLE_ERROR')
    expect(store.error.value).toBe(workspaceError)
  })

  it('keeps transaction read failures out of workspace and period error ownership', async () => {
    api.getLedgerSettings.mockResolvedValue(settings(true))
    api.listLedgerAccounts.mockResolvedValue([account('account-1')])
    const store = useLedgerStore()
    await store.bootstrap()

    const transactionsError = new LedgerApiError('transactions unavailable', 500, 'ledger-internal-error')
    api.listLedgerTransactions.mockRejectedValueOnce(transactionsError)
    await store.refreshTransactions({ type: 'all', limit: 50 })

    expect(store.workspaceState.value).toBe('READY')
    expect(store.workspaceError.value).toBeNull()
    expect(store.overviewError.value).toBeNull()
    expect(store.transactionsError.value).toBe(transactionsError)
    expect(store.error.value).toBe(transactionsError)
    expect(store.transactionsLoading.value).toBe(false)
  })

  it.each([
    ['accounts', () => api.listLedgerAccounts],
    ['categories', () => api.listLedgerCategories],
  ] as const)('escalates a failed %s refresh to a workspace recovery state', async (_label, failing) => {
    api.getLedgerSettings.mockResolvedValue(settings(true))
    api.listLedgerAccounts.mockResolvedValue([account('account-1')])
    const store = useLedgerStore()
    await store.bootstrap()

    store.setOverviewRequestContext({ scope: 'month', anchorDate: '2026-08-20' })
    api.getLedgerOverview.mockResolvedValue(overviewFor('month', '2026-08-20'))
    await store.refreshOverview()
    expect(store.workspaceState.value).toBe('READY')

    const currentStateError = new LedgerApiError('current state unavailable', 503, 'ledger-internal-error')
    failing().mockRejectedValueOnce(currentStateError)
    api.getLedgerOverview.mockClear()
    api.createLedgerTransaction.mockResolvedValue({ id: 'tx-2', type: 'expense' })

    await expect(store.createTransaction({
      type: 'expense' as const,
      amountMinor: 1_200,
      accountId: 'account-1',
      categoryId: 'category-1',
      occurredAt: 1_700_000_000_000,
      payee: '',
      note: '',
    })).resolves.toMatchObject({ id: 'tx-2' })

    // A current-state dependency failed. It is not a period-only analysis
    // failure: the workspace must expose its own recovery boundary instead of
    // presenting a stale Current Snapshot behind a period error.
    expect(store.workspaceState.value).toBe('RECOVERABLE_ERROR')
    expect(store.error.value).toBe(currentStateError)
    expect(store.overviewDataReady.value).toBe(false)
    expect(store.loading.value).toBe(false)
    // The period read is not the recovery action, so it was never attempted.
    expect(api.getLedgerOverview).not.toHaveBeenCalled()

    // The workspace-level retry is what recovers.
    api.listLedgerAccounts.mockResolvedValue([account('account-1')])
    api.listLedgerCategories.mockResolvedValue([])
    api.getLedgerOverview.mockResolvedValue(overviewFor('month', '2026-08-20'))
    await store.bootstrap()
    expect(store.workspaceState.value).toBe('READY')
    expect(store.error.value).toBeNull()
    expect(store.overviewDataReady.value).toBe(true)
    expect(store.overviewRequestedAnchorDate.value).toBe('2026-08-20')
  })

  it('keeps a network-uncertain create intent durable with the same key', async () => {
    api.getLedgerSettings.mockResolvedValue(settings(true))
    api.listLedgerAccounts.mockResolvedValue([account('account-1')])
    const uncertain = new LedgerApiError('unknown', 0, 'ledger-network-error', null, true)
    api.createLedgerTransaction.mockRejectedValue(uncertain)
    const store = useLedgerStore()
    await store.bootstrap()

    const payload = {
      type: 'expense' as const,
      amountMinor: 3800,
      accountId: 'account-1',
      categoryId: 'category-1',
      occurredAt: 1_700_000_000_000,
      payee: '',
      note: '',
    }
    await expect(store.createTransaction(payload)).rejects.toMatchObject({ transportOutcomeUnknown: true })
    expect(store.mutationState.value).toBe('UNCERTAIN')
    expect(store.pendingCreate.value?.canonicalPayload).toEqual(payload)
    expect(store.pendingCreate.value?.idempotencyKey).toBeTruthy()
    expect(JSON.parse(sessionStorage.getItem('nuvyn.ledger.pending-create') ?? '{}')).toMatchObject({
      canonicalPayload: payload,
      operation: 'transaction',
    })

    api.createLedgerTransaction.mockResolvedValue({ id: 'tx-1', type: 'expense' })
    await store.retryPendingCreate()
    expect(api.createLedgerTransaction).toHaveBeenLastCalledWith(payload, expect.any(String))
    expect(store.pendingCreate.value).toBeNull()
    expect(sessionStorage.getItem('nuvyn.ledger.pending-create')).toBeNull()
  })

  it('treats a definite 503 as a confirmed failure and clears recovery', async () => {
    api.getLedgerSettings.mockResolvedValue(settings(true))
    api.listLedgerAccounts.mockResolvedValue([account('account-1')])
    api.createLedgerTransaction.mockRejectedValue(new LedgerApiError('busy', 503, 'ledger-write-busy'))
    const store = useLedgerStore()
    await store.bootstrap()
    const payload = {
      type: 'expense' as const,
      amountMinor: 1,
      accountId: 'account-1',
      categoryId: 'category-1',
      occurredAt: 1_700_000_000_000,
      payee: '',
      note: '',
    }
    await expect(store.createTransaction(payload)).rejects.toMatchObject({ code: 'ledger-write-busy' })
    expect(store.mutationState.value).toBe('ERROR')
    expect(store.pendingCreate.value).toBeNull()
    expect(sessionStorage.getItem('nuvyn.ledger.pending-create')).toBeNull()
  })

  it('does not send any create mutation when sessionStorage cannot persist the intent', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    const store = useLedgerStore()
    const accountPayload = {
      name: '招商银行',
      type: 'bank' as const,
      nature: 'asset' as const,
      openingBalanceMinor: 0,
      openingDate: '2026-09-05',
      currency: 'CNY',
      note: '',
    }
    const transactionPayload = {
      type: 'expense' as const,
      amountMinor: 1,
      accountId: 'account-1',
      categoryId: 'category-1',
      occurredAt: 1_700_000_000_000,
      payee: '',
      note: '',
    }

    await expect(store.createSettings({ baseCurrency: 'CNY', timezone: 'Asia/Shanghai' }))
      .rejects.toMatchObject({ code: 'ledger-recovery-storage-unavailable' })
    await expect(store.createAccount(accountPayload))
      .rejects.toMatchObject({ code: 'ledger-recovery-storage-unavailable' })
    await expect(store.createCategory({ kind: 'expense', name: '交通' }))
      .rejects.toMatchObject({ code: 'ledger-recovery-storage-unavailable' })
    await expect(store.createTransaction(transactionPayload))
      .rejects.toMatchObject({ code: 'ledger-recovery-storage-unavailable' })

    expect(api.createLedgerSettings).not.toHaveBeenCalled()
    expect(api.createLedgerAccount).not.toHaveBeenCalled()
    expect(api.createLedgerCategory).not.toHaveBeenCalled()
    expect(api.createLedgerTransaction).not.toHaveBeenCalled()
    setItem.mockRestore()
  })

  it('blocks new creates and retains an invalid recovery record', async () => {
    const invalidRecord = {
      version: 99,
      operation: 'transaction',
      operationScope: 'POST:/api/ledger/transactions',
      idempotencyKey: 'key-invalid',
      canonicalPayload: {},
      createdAt: 1,
      ownerIdentity: null,
    }
    const raw = JSON.stringify(invalidRecord)
    sessionStorage.setItem('nuvyn.ledger.pending-create', raw)
    resetLedgerStoreForTesting()
    const store = useLedgerStore()

    expect(store.recoveryState.value).toBe('BLOCKED')
    await expect(store.createCategory({ kind: 'expense', name: '新分类' }))
      .rejects.toMatchObject({ code: 'ledger-recovery-blocked' })
    expect(api.createLedgerCategory).not.toHaveBeenCalled()
    expect(sessionStorage.getItem('nuvyn.ledger.pending-create')).toBe(raw)
  })

  it('keeps the original intent when a successful create response body is unusable, then replays it', async () => {
    api.getLedgerSettings.mockResolvedValue(settings(true))
    api.listLedgerAccounts.mockResolvedValue([account('account-1')])
    const malformedSuccess = new LedgerApiError(
      'success body could not be validated',
      201,
      'ledger-malformed-response',
      null,
      false,
      true,
    )
    api.createLedgerTransaction.mockRejectedValueOnce(malformedSuccess)
    const store = useLedgerStore()
    await store.bootstrap()
    const payload = {
      type: 'expense' as const,
      amountMinor: 3800,
      accountId: 'account-1',
      categoryId: 'category-1',
      occurredAt: 1_700_000_000_000,
      payee: '',
      note: '',
    }

    await expect(store.createTransaction(payload)).rejects.toMatchObject({
      code: 'ledger-malformed-response',
      transportOutcomeUnknown: false,
      requiresIdempotentReplay: true,
    })
    const firstKey = store.pendingCreate.value?.idempotencyKey
    expect(firstKey).toBeTruthy()
    expect(store.mutationState.value).toBe('UNCERTAIN')
    expect(JSON.parse(sessionStorage.getItem('nuvyn.ledger.pending-create') ?? '{}')).toMatchObject({
      idempotencyKey: firstKey,
      canonicalPayload: payload,
    })

    api.createLedgerTransaction.mockResolvedValue({ id: 'tx-replayed', type: 'expense' })
    await store.retryPendingCreate()
    expect(api.createLedgerTransaction).toHaveBeenLastCalledWith(payload, firstKey)
    expect(store.pendingCreate.value).toBeNull()
    expect(sessionStorage.getItem('nuvyn.ledger.pending-create')).toBeNull()
  })
})

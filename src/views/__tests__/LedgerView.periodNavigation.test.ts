// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import type {
  LedgerAccountDto,
  LedgerCategoryDto,
  LedgerOverviewDto,
  LedgerOverviewScope,
  LedgerSettingsDto,
} from '../../../shared/ledgerProtocol'
import { LedgerApiError } from '../../features/ledger/ledgerErrors'
import { resetLedgerStoreForTesting, useLedgerStore } from '../../features/ledger/ledgerStore'
import LedgerDatePicker from '../../components/ledger/LedgerDatePicker.vue'
import LedgerView from '../LedgerView.vue'

const api = vi.hoisted(() => ({
  getLedgerSettings: vi.fn(),
  listLedgerAccounts: vi.fn(),
  listLedgerCategories: vi.fn(),
  getLedgerOverview: vi.fn(),
  listLedgerTransactions: vi.fn(),
  createLedgerTransaction: vi.fn(),
}))

vi.mock('../../features/ledger/api', () => api)

const settings: LedgerSettingsDto = {
  baseCurrency: 'CNY',
  currencyExponent: 2,
  timezone: 'Asia/Shanghai',
  hasCreatedAccount: true,
  version: 1,
  createdAt: 1,
  updatedAt: 1,
}

const account: LedgerAccountDto = {
  id: 'bank-1',
  name: '招商银行',
  type: 'bank',
  nature: 'asset',
  openingBalanceMinor: 1_000_000,
  openingDate: '2026-01-01',
  currency: 'CNY',
  currencyExponent: 2,
  note: '',
  archivedAt: null,
  version: 1,
  createdAt: 1,
  updatedAt: 1,
  currentBalanceMinor: 1_000_000,
}

const category: LedgerCategoryDto = {
  id: 'food',
  kind: 'expense',
  name: '餐饮',
  normalizedName: '餐饮',
  archivedAt: null,
  version: 1,
  createdAt: 1,
  updatedAt: 1,
}

function overviewFor(input: { scope: LedgerOverviewScope; anchorDate: string | undefined }): LedgerOverviewDto {
  const anchorDate = input.anchorDate ?? '2026-09-05'
  return {
    context: {
      anchorDate,
      todayDate: '2026-09-05',
      isToday: anchorDate === '2026-09-05',
      scope: input.scope,
    },
    currency: 'CNY',
    currencyExponent: 2,
    assetTotalMinor: 1_000_000,
    liabilityTotalMinor: 0,
    netWorthMinor: 1_000_000,
    accounts: [{
      ...account,
      balanceIncreaseMinor: 0,
      balanceDecreaseMinor: 0,
    }],
    cashflow: { incomeMinor: 0, expenseMinor: 0, balanceMinor: 0 },
    categoryBreakdown: { income: [], expense: [] },
    periods: [
      { period: 'today', startAt: 0, endAt: 1, incomeMinor: 0, expenseMinor: 0, balanceMinor: 0 },
      { period: 'week', startAt: 0, endAt: 1, incomeMinor: 0, expenseMinor: 0, balanceMinor: 0 },
      { period: 'month', startAt: 0, endAt: 1, incomeMinor: 0, expenseMinor: 0, balanceMinor: 0 },
      { period: 'year', startAt: 0, endAt: 1, incomeMinor: 0, expenseMinor: 0, balanceMinor: 0 },
    ],
    trend: [],
    recentTransactions: [],
  }
}

const wrappers: VueWrapper[] = []

async function setLedgerDate(wrapper: VueWrapper, value: string): Promise<void> {
  const picker = wrapper.findAllComponents(LedgerDatePicker).find((candidate) => candidate.props('testId') === 'ledger-period-date')
  if (!picker) throw new Error('Ledger dashboard date picker is not mounted')
  await picker.vm.$emit('update:modelValue', value)
}

function setupApi(): void {
  api.getLedgerSettings.mockResolvedValue(settings)
  api.listLedgerAccounts.mockResolvedValue([account])
  api.listLedgerCategories.mockResolvedValue([category])
  api.getLedgerOverview.mockImplementation((input: { scope: LedgerOverviewScope; anchorDate: string | undefined }) => Promise.resolve(overviewFor(input)))
  api.listLedgerTransactions.mockResolvedValue({ transactions: [], page: { nextCursor: null } })
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

/**
 * Route the Overview mock by requested anchor instead of call order so a test
 * can leave one anchor pending while a newer anchor resolves. Returns the list
 * of anchors the store actually requested.
 */
function routeOverviewGate(gates: Record<string, Promise<LedgerOverviewDto>>): Array<string | undefined> {
  const requested: Array<string | undefined> = []
  api.getLedgerOverview.mockImplementation((input: { scope: LedgerOverviewScope; anchorDate: string | undefined }) => {
    requested.push(input.anchorDate)
    const gate = input.anchorDate === undefined ? undefined : gates[input.anchorDate]
    return gate ?? Promise.resolve(overviewFor(input))
  })
  return requested
}

async function mountAt(path: string): Promise<{ router: ReturnType<typeof createRouter>; wrapper: VueWrapper }> {
  const placeholder = { template: '<div />' }
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/ledger', name: 'ledger', component: LedgerView },
      { path: '/ledger/transactions', name: 'ledger-transactions', component: placeholder },
      { path: '/ledger/accounts', name: 'ledger-accounts', component: placeholder },
      { path: '/ledger/accounts/:id', name: 'ledger-account', component: placeholder },
    ],
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(LedgerView, { global: { plugins: [router] } })
  wrappers.push(wrapper)
  await flushPromises()
  await flushPromises()
  return { router, wrapper }
}

describe('Ledger historical period route coordination', () => {
  beforeEach(() => {
    sessionStorage.clear()
    resetLedgerStoreForTesting()
    vi.clearAllMocks()
    setupApi()
  })

  afterEach(() => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount()
  })

  it('loads an anchored route, exposes the requested date, and keeps current snapshot wording', async () => {
    const { router, wrapper } = await mountAt('/ledger?date=2026-08-20')

    expect(router.currentRoute.value.fullPath).toBe('/ledger?date=2026-08-20')
    expect(api.getLedgerOverview).toHaveBeenCalledWith({ scope: 'month', anchorDate: '2026-08-20' })
    expect((wrapper.get('[data-testid="ledger-period-date"] input').element as HTMLInputElement).value).toBe('2026-08-20')
    expect(wrapper.find('[data-testid="ledger-return-today"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="ledger-dashboard-assets"] .ledger-dashboard-account').element.tagName).toBe('A')
    expect(wrapper.get('[data-testid="ledger-dashboard-assets"] .ledger-dashboard-account').attributes('href')).toBe('/ledger/accounts/bank-1?from=overview')
    expect(wrapper.text()).toContain('2026年8月20日 · 账户余额为当前值')
    expect(wrapper.text()).toContain('截至 2026年8月20日')
  })

  it('keeps the route anchor while the Today period card refreshes independently', async () => {
    const { router, wrapper } = await mountAt('/ledger?date=2026-08-20')
    api.getLedgerOverview.mockClear()

    await setLedgerDate(wrapper, '2026-08-19')
    await flushPromises()
    await flushPromises()
    expect(router.currentRoute.value.query.date).toBe('2026-08-20')
    expect(api.getLedgerOverview).toHaveBeenLastCalledWith({ scope: 'month', anchorDate: '2026-08-19' })
    expect((wrapper.get('[data-testid="ledger-period-date"] input').element as HTMLInputElement).value).toBe('2026-08-19')

    await setLedgerDate(wrapper, '2026-09-05')
    await flushPromises()
    await flushPromises()
    expect(router.currentRoute.value.query.date).toBe('2026-08-20')
    expect(api.getLedgerOverview).toHaveBeenLastCalledWith({ scope: 'month', anchorDate: '2026-09-05' })
    expect((wrapper.get('[data-testid="ledger-period-date"] input').element as HTMLInputElement).value).toBe('2026-09-05')
    expect(wrapper.find('[data-testid="ledger-return-today"]').exists()).toBe(false)
  })

  it('canonicalizes invalid and explicit-today dates without sending an invalid anchor', async () => {
    const invalid = await mountAt('/ledger?date=2026-02-30')
    expect(invalid.router.currentRoute.value.fullPath).toBe('/ledger')
    expect(api.getLedgerOverview).not.toHaveBeenCalledWith({ scope: 'month', anchorDate: '2026-02-30' })

    invalid.wrapper.unmount()
    resetLedgerStoreForTesting()
    vi.clearAllMocks()
    setupApi()
    const today = await mountAt('/ledger?date=2026-09-05')
    expect(today.router.currentRoute.value.fullPath).toBe('/ledger')
    expect(api.getLedgerOverview).toHaveBeenCalledWith({ scope: 'month', anchorDate: '2026-09-05' })
    expect(api.getLedgerOverview).toHaveBeenLastCalledWith({ scope: 'month', anchorDate: undefined })
  })

  it('lets Server future-date validation canonicalize the route and recover to the current dashboard', async () => {
    const future = new LedgerApiError(
      'future anchor',
      400,
      'ledger-validation-failed',
      { field: 'anchorDate' },
    )
    api.getLedgerOverview.mockRejectedValueOnce(future)
    const { router, wrapper } = await mountAt('/ledger?date=2026-09-06')

    expect(router.currentRoute.value.fullPath).toBe('/ledger')
    expect(wrapper.find('[data-testid="ledger-dashboard"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ledger-bootstrap-error"]').exists()).toBe(false)
    expect(api.getLedgerOverview).toHaveBeenLastCalledWith({ scope: 'month', anchorDate: undefined })
  })

  it('starts a fresh canonical-today overview when future validation races initial bootstrap', async () => {
    const initial = deferred<LedgerOverviewDto>()
    const future = deferred<LedgerOverviewDto>()
    const today = deferred<LedgerOverviewDto>()
    const requestedAnchors: Array<string | undefined> = []
    api.getLedgerOverview.mockImplementation((input: { scope: LedgerOverviewScope; anchorDate: string | undefined }) => {
      requestedAnchors.push(input.anchorDate)
      if (input.anchorDate === '2026-08-20') return initial.promise
      if (input.anchorDate === '2026-09-06') return future.promise
      if (input.anchorDate === undefined) return today.promise
      return Promise.resolve(overviewFor(input))
    })

    const { router, wrapper } = await mountAt('/ledger?date=2026-08-20')
    const store = useLedgerStore()
    expect(requestedAnchors).toEqual(['2026-08-20'])
    expect(store.workspaceState.value).toBe('READY')
    expect(store.workspaceLoading.value).toBe(false)
    expect(wrapper.find('[data-testid="ledger-loading"]').exists()).toBe(true)

    await router.push('/ledger?date=2026-09-06')
    await nextTick()
    expect(requestedAnchors).toEqual(['2026-08-20', '2026-09-06'])
    expect(store.overviewRequestedAnchorDate.value).toBe('2026-09-06')

    future.reject(new LedgerApiError(
      'future anchor',
      400,
      'ledger-validation-failed',
      { field: 'anchorDate' },
    ))
    await flushPromises()
    await flushPromises()

    expect(router.currentRoute.value.fullPath).toBe('/ledger')
    expect(requestedAnchors).toContain(undefined)
    expect(store.overviewRequestedAnchorDate.value).toBeUndefined()

    initial.resolve(overviewFor({ scope: 'month', anchorDate: '2026-08-20' }))
    await flushPromises()
    expect(store.overview.value).toBeNull()
    expect(router.currentRoute.value.fullPath).toBe('/ledger')

    today.resolve(overviewFor({ scope: 'month', anchorDate: undefined }))
    await flushPromises()
    expect(store.workspaceState.value).toBe('READY')
    expect(store.overview.value?.context.isToday).toBe(true)
    expect(store.overviewRequestedAnchorDate.value).toBeUndefined()
    expect(store.overviewMatchesRequest.value).toBe(true)
    expect(wrapper.find('[data-testid="ledger-dashboard"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ledger-loading"]').exists()).toBe(false)
  })

  it('starts the latest route request immediately and publishes only its result', async () => {
    const { router, wrapper } = await mountAt('/ledger')
    api.getLedgerOverview.mockClear()
    const first = deferred<LedgerOverviewDto>()
    const second = deferred<LedgerOverviewDto>()
    api.getLedgerOverview.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

    await router.push('/ledger?date=2026-08-20')
    await nextTick()
    expect(api.getLedgerOverview).toHaveBeenNthCalledWith(1, { scope: 'month', anchorDate: '2026-08-20' })

    await router.push('/ledger?date=2026-06-15')
    await nextTick()
    expect(api.getLedgerOverview).toHaveBeenNthCalledWith(2, { scope: 'month', anchorDate: '2026-06-15' })
    expect(useLedgerStore().overviewRequestedAnchorDate.value).toBe('2026-06-15')

    first.resolve(overviewFor({ scope: 'month', anchorDate: '2026-08-20' }))
    await flushPromises()
    expect(useLedgerStore().overview.value?.context.anchorDate).not.toBe('2026-08-20')
    expect(router.currentRoute.value.fullPath).toBe('/ledger?date=2026-06-15')
    expect(wrapper.text()).not.toContain('2026年8月20日')

    second.resolve(overviewFor({ scope: 'month', anchorDate: '2026-06-15' }))
    await flushPromises()
    expect(wrapper.text()).toContain('2026年6月15日')
    expect(useLedgerStore().overviewMatchesRequest.value).toBe(true)
    expect(router.currentRoute.value.fullPath).toBe('/ledger?date=2026-06-15')
  })

  it('does not canonicalize a newer historical route after a stale future response', async () => {
    const { router, wrapper } = await mountAt('/ledger')
    api.getLedgerOverview.mockClear()
    const future = deferred<LedgerOverviewDto>()
    const historical = deferred<LedgerOverviewDto>()
    api.getLedgerOverview.mockReturnValueOnce(future.promise).mockReturnValueOnce(historical.promise)

    await router.push('/ledger?date=2026-09-06')
    await nextTick()
    await router.push('/ledger?date=2026-06-15')
    await nextTick()
    expect(api.getLedgerOverview).toHaveBeenCalledTimes(2)
    expect(api.getLedgerOverview).toHaveBeenLastCalledWith({ scope: 'month', anchorDate: '2026-06-15' })

    future.reject(new LedgerApiError(
      'future anchor',
      400,
      'ledger-validation-failed',
      { field: 'anchorDate' },
    ))
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/ledger?date=2026-06-15')
    expect(api.getLedgerOverview).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="ledger-return-today"]').exists()).toBe(false)

    historical.resolve(overviewFor({ scope: 'month', anchorDate: '2026-06-15' }))
    await flushPromises()
    expect(useLedgerStore().overviewMatchesRequest.value).toBe(true)
    expect(router.currentRoute.value.fullPath).toBe('/ledger?date=2026-06-15')
  })

  it('finishes the workspace bootstrap when a route change races the initial overview request', async () => {
    const anchored = deferred<LedgerOverviewDto>()
    const historical = deferred<LedgerOverviewDto>()
    const requestedAnchors = routeOverviewGate({
      '2026-08-20': anchored.promise,
      '2026-06-15': historical.promise,
    })

    // The initial bootstrap is genuinely pending: Settings, Accounts and
    // Categories resolve, but its Overview read never has.
    const { router, wrapper } = await mountAt('/ledger?date=2026-08-20')
    const store = useLedgerStore()
    expect(requestedAnchors).toEqual(['2026-08-20'])
    expect(store.workspaceState.value).toBe('READY')
    expect(store.settings.value).toEqual(settings)
    expect(store.accounts.value).toHaveLength(1)
    expect(store.categories.value).toHaveLength(1)
    expect(wrapper.find('[data-testid="ledger-loading"]').exists()).toBe(true)

    await router.push('/ledger?date=2026-06-15')
    await nextTick()
    expect(store.overviewRequestedAnchorDate.value).toBe('2026-06-15')
    expect(requestedAnchors).toEqual(['2026-08-20', '2026-06-15'])

    anchored.resolve(overviewFor({ scope: 'month', anchorDate: '2026-08-20' }))
    await flushPromises()
    expect(store.overview.value).toBeNull()
    expect(store.workspaceState.value).toBe('READY')
    expect(wrapper.find('[data-testid="ledger-bootstrap-error"]').exists()).toBe(false)
    expect(router.currentRoute.value.fullPath).toBe('/ledger?date=2026-06-15')

    historical.resolve(overviewFor({ scope: 'month', anchorDate: '2026-06-15' }))
    await flushPromises()
    expect(store.workspaceState.value).toBe('READY')
    expect(wrapper.find('[data-testid="ledger-dashboard"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ledger-loading"]').exists()).toBe(false)
    expect((wrapper.get('[data-testid="ledger-period-date"] input').element as HTMLInputElement).value).toBe('2026-06-15')
    expect(store.overviewMatchesRequest.value).toBe(true)
    expect(store.error.value).toBeNull()
    expect(router.currentRoute.value.fullPath).toBe('/ledger?date=2026-06-15')
  })

  it('keeps a raced bootstrap overview failure out of the newest route lifecycle', async () => {
    const anchored = deferred<LedgerOverviewDto>()
    const historical = deferred<LedgerOverviewDto>()
    routeOverviewGate({
      '2026-08-20': anchored.promise,
      '2026-06-15': historical.promise,
    })

    const { router, wrapper } = await mountAt('/ledger?date=2026-08-20')
    const store = useLedgerStore()
    await router.push('/ledger?date=2026-06-15')
    await nextTick()

    anchored.reject(new LedgerApiError('projection unavailable', 500, 'ledger-internal-error'))
    await flushPromises()
    // The superseded Overview read owns no lifecycle any more: it may not
    // publish an error, degrade the workspace, or touch the route.
    expect(store.workspaceState.value).toBe('READY')
    expect(store.error.value).toBeNull()
    expect(wrapper.find('[data-testid="ledger-bootstrap-error"]').exists()).toBe(false)
    expect(router.currentRoute.value.fullPath).toBe('/ledger?date=2026-06-15')

    historical.resolve(overviewFor({ scope: 'month', anchorDate: '2026-06-15' }))
    await flushPromises()
    expect(store.workspaceState.value).toBe('READY')
    expect(store.overviewMatchesRequest.value).toBe(true)
    expect(store.error.value).toBeNull()
    expect(wrapper.find('[data-testid="ledger-dashboard"]').exists()).toBe(true)
    expect((wrapper.get('[data-testid="ledger-period-date"] input').element as HTMLInputElement).value).toBe('2026-06-15')
    expect(router.currentRoute.value.fullPath).toBe('/ledger?date=2026-06-15')
  })

  it('uses read-specific recovery copy after a confirmed mutation overview failure', async () => {
    const { wrapper } = await mountAt('/ledger?date=2026-08-20')
    const store = useLedgerStore()
    const overviewError = new LedgerApiError('overview unavailable', 500, 'ledger-network-error')
    api.createLedgerTransaction.mockResolvedValue({ id: 'tx-1', type: 'expense' })
    api.getLedgerOverview.mockRejectedValueOnce(overviewError)

    await expect(store.createTransaction({
      type: 'expense' as const,
      amountMinor: 3_800,
      accountId: 'bank-1',
      categoryId: 'food',
      occurredAt: 1_700_000_000_000,
      payee: '',
      note: '',
    })).resolves.toMatchObject({ id: 'tx-1' })
    await nextTick()

    expect(store.workspaceState.value).toBe('RECOVERABLE_ERROR')
    expect(store.workspaceError.value).toBe(overviewError)
    expect(store.overviewError.value).toBe(overviewError)
    expect(wrapper.find('[data-testid="ledger-bootstrap-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ledger-dashboard"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('Ledger 数据暂时无法加载，请稍后重试。')
    expect(wrapper.text()).not.toContain('尚未确认本次操作是否保存')
    expect(wrapper.text()).not.toContain('这段期间的数据暂时无法加载')
  })

  it('keeps canonical-today recovery when the old bootstrap completes after its Overview failed', async () => {
    const settingsGate = deferred<LedgerSettingsDto>()
    api.getLedgerSettings.mockReturnValueOnce(settingsGate.promise)
    const future = deferred<LedgerOverviewDto>()
    const today = deferred<LedgerOverviewDto>()
    const requestedAnchors: Array<string | undefined> = []
    api.getLedgerOverview.mockImplementation((input: { scope: LedgerOverviewScope; anchorDate: string | undefined }) => {
      requestedAnchors.push(input.anchorDate)
      if (input.anchorDate === '2026-09-06') return future.promise
      if (input.anchorDate === undefined) return today.promise
      return Promise.resolve(overviewFor(input))
    })

    const { router, wrapper } = await mountAt('/ledger?date=2026-08-20')
    const store = useLedgerStore()
    expect(store.workspaceState.value).toBe('BOOTSTRAPPING')
    expect(requestedAnchors).toEqual([])

    await router.push('/ledger?date=2026-09-06')
    await nextTick()
    expect(store.overviewRequestedAnchorDate.value).toBe('2026-09-06')
    expect(requestedAnchors).toEqual(['2026-09-06'])

    future.reject(new LedgerApiError(
      'future anchor',
      400,
      'ledger-validation-failed',
      { field: 'anchorDate' },
    ))
    await flushPromises()
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/ledger')
    expect(requestedAnchors).toEqual(['2026-09-06', undefined])

    const todayError = new LedgerApiError('today overview unavailable', 500, 'ledger-network-error')
    today.reject(todayError)
    await flushPromises()

    // Let the original bootstrap finish after the newer canonical-today read
    // has already established the Workspace recovery boundary.
    settingsGate.resolve(settings)
    await flushPromises()
    await flushPromises()

    expect(store.workspaceState.value).toBe('RECOVERABLE_ERROR')
    expect(store.overview.value).toBeNull()
    expect(store.overviewDataReady.value).toBe(false)
    expect(store.overviewMatchesRequest.value).toBe(false)
    expect(store.overviewRequestedAnchorDate.value).toBeUndefined()
    expect(store.workspaceError.value).toBe(todayError)
    expect(store.overviewError.value).toBe(todayError)
    expect(wrapper.find('[data-testid="ledger-bootstrap-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ledger-dashboard"]').exists()).toBe(false)
    expect(wrapper.find('.ledger-inline-error').exists()).toBe(false)
    expect(wrapper.text()).toContain('Ledger 数据暂时无法加载，请稍后重试。')
    expect(wrapper.text()).not.toContain('这段期间的数据暂时无法加载')
    expect(wrapper.text()).not.toContain('正在加载所选期间')
  })

  it('completes a bootstrap interrupted before Settings with the newest route anchor', async () => {
    const settingsGate = deferred<LedgerSettingsDto>()
    api.getLedgerSettings.mockReturnValueOnce(settingsGate.promise)
    const requestedAnchors = routeOverviewGate({})

    const { router, wrapper } = await mountAt('/ledger?date=2026-08-20')
    const store = useLedgerStore()
    expect(store.workspaceState.value).toBe('BOOTSTRAPPING')
    expect(requestedAnchors).toEqual([])

    await router.push('/ledger?date=2026-06-15')
    await flushPromises()
    expect(store.overviewRequestedAnchorDate.value).toBe('2026-06-15')
    expect(requestedAnchors).toEqual(['2026-06-15'])
    expect(store.overview.value?.context.anchorDate).toBe('2026-06-15')
    // Settings is still in flight, so the workspace is still bootstrapping —
    // and that lifecycle is the only thing left to finish.
    expect(store.workspaceState.value).toBe('BOOTSTRAPPING')
    expect(wrapper.find('[data-testid="ledger-loading"]').exists()).toBe(true)

    settingsGate.resolve(settings)
    await flushPromises()
    expect(store.workspaceState.value).toBe('READY')
    expect(store.settings.value).toEqual(settings)
    expect(store.accounts.value).toHaveLength(1)
    expect(store.categories.value).toHaveLength(1)
    // The superseded bootstrap never sends an Overview request it could not publish.
    expect(requestedAnchors).toEqual(['2026-06-15'])
    expect(store.overview.value?.context.anchorDate).toBe('2026-06-15')
    expect(store.overviewMatchesRequest.value).toBe(true)
    expect(store.error.value).toBeNull()
    expect(wrapper.find('[data-testid="ledger-dashboard"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ledger-loading"]').exists()).toBe(false)
    expect((wrapper.get('[data-testid="ledger-period-date"] input').element as HTMLInputElement).value).toBe('2026-06-15')
    expect(router.currentRoute.value.fullPath).toBe('/ledger?date=2026-06-15')
  })
})

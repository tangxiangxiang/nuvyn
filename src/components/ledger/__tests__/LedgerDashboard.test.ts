// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import type {
  LedgerAccountDto,
  LedgerAccountSummary,
  LedgerCategoryDto,
  LedgerOverviewDto,
  LedgerSettingsDto,
  LedgerTransactionDto,
} from '../../../../shared/ledgerProtocol'
import { LedgerApiError } from '../../../features/ledger/ledgerErrors'
import { resetLedgerStoreForTesting, useLedgerStore } from '../../../features/ledger/ledgerStore'
import { instantFromLocalDateTime } from '../../../features/ledger/time'
import LedgerCashflowTrend from '../LedgerCashflowTrend.vue'
import LedgerDatePicker from '../LedgerDatePicker.vue'
import LedgerView from '../../../views/LedgerView.vue'
import { getNaiveSelect, setNaiveSelect } from './selectTestUtils'

const api = vi.hoisted(() => ({
  getLedgerSettings: vi.fn(),
  listLedgerAccounts: vi.fn(),
  listLedgerCategories: vi.fn(),
  getLedgerOverview: vi.fn(),
  getLedgerTrend: vi.fn(),
  listLedgerTransactions: vi.fn(),
}))

vi.mock('../../../features/ledger/api', () => api)

// jsdom has no canvas, so the chart's DOM-owning entry point is stubbed. The
// chart's own suite covers what it renders.
vi.mock('echarts/core', () => ({
  init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })),
  use: vi.fn(),
}))

const settings: LedgerSettingsDto = {
  baseCurrency: 'CNY',
  currencyExponent: 2,
  timezone: 'Asia/Shanghai',
  hasCreatedAccount: true,
  version: 2,
  createdAt: 1,
  updatedAt: 2,
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
  currentBalanceMinor: 996_200,
}

const archivedAccount: LedgerAccountDto = {
  ...account,
  id: 'cash-1',
  name: '现金账户',
  type: 'cash',
  archivedAt: 3,
  version: 2,
  updatedAt: 3,
  currentBalanceMinor: 0,
}

const secondArchivedAccount: LedgerAccountDto = {
  ...archivedAccount,
  id: 'wallet-1',
  name: '旧钱包',
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

const expense: LedgerTransactionDto = {
  id: 'tx-1',
  type: 'expense',
  amountMinor: 3_800,
  accountId: 'bank-1',
  categoryId: 'food',
  occurredAt: Date.UTC(2026, 8, 5, 4, 30),
  payee: '午餐',
  note: '',
  deletedAt: null,
  version: 1,
  createdAt: 1,
  updatedAt: 1,
}

const archivedExpense: LedgerTransactionDto = {
  ...expense,
  id: 'tx-archived-expense',
  accountId: archivedAccount.id,
  payee: '',
}

const transferActiveToArchived: LedgerTransactionDto = {
  ...expense,
  id: 'tx-transfer-active-archived',
  type: 'transfer',
  transferKind: 'general',
  amountMinor: 10_000,
  fromAccountId: account.id,
  toAccountId: archivedAccount.id,
}

const transferArchivedToActive: LedgerTransactionDto = {
  ...transferActiveToArchived,
  id: 'tx-transfer-archived-active',
  fromAccountId: archivedAccount.id,
  toAccountId: account.id,
}

const transferArchivedToArchived: LedgerTransactionDto = {
  ...transferActiveToArchived,
  id: 'tx-transfer-archived-archived',
  fromAccountId: archivedAccount.id,
  toAccountId: secondArchivedAccount.id,
}

const archivedAdjustment: LedgerTransactionDto = {
  ...expense,
  id: 'tx-archived-adjustment',
  type: 'adjustment',
  amountMinor: 0,
  accountId: archivedAccount.id,
  adjustmentCalculatedBalanceMinor: 0,
  adjustmentTargetBalanceMinor: 0,
}

const accountSummary: LedgerAccountSummary = {
  ...account,
  balanceIncreaseMinor: 0,
  balanceDecreaseMinor: 3_800,
}

function trendPoint(month: string, incomeMinor: number, expenseMinor: number): LedgerOverviewDto['trend'][number] {
  const [year, index] = month.split('-').map(Number)
  return {
    month,
    startAt: Date.UTC(year, index - 1, 1),
    endAt: Date.UTC(year, index, 1),
    incomeMinor,
    expenseMinor,
    balanceMinor: incomeMinor - expenseMinor,
  }
}

// The Overview contract is the six complete calendar months ending with the
// anchor month.
const sixMonthTrend: LedgerOverviewDto['trend'] = [
  trendPoint('2026-04', 510_000, 120_000),
  trendPoint('2026-05', 480_000, 240_000),
  trendPoint('2026-06', 500_000, 640_000),
  trendPoint('2026-07', 500_000, 30_000),
  trendPoint('2026-08', 520_000, 44_000),
  trendPoint('2026-09', 0, 3_800),
]

const overview = (): LedgerOverviewDto => ({
  context: { anchorDate: '2026-09-05', todayDate: '2026-09-05', isToday: true, scope: 'month' },
  currency: 'CNY',
  currencyExponent: 2,
  assetTotalMinor: 996_200,
  liabilityTotalMinor: 0,
  netWorthMinor: 996_200,
  accounts: [accountSummary],
  cashflow: { incomeMinor: 0, expenseMinor: 3_800, balanceMinor: -3_800 },
  categoryBreakdown: { income: [], expense: [{ categoryId: 'food', name: '餐饮', kind: 'expense', amountMinor: 3_800 }] },
  periods: [
    { period: 'today', startAt: instantFromLocalDateTime('2026-09-05T00:00', 'Asia/Shanghai'), endAt: instantFromLocalDateTime('2026-09-06T00:00', 'Asia/Shanghai'), incomeMinor: 0, expenseMinor: 3_800, balanceMinor: -3_800 },
    { period: 'week', startAt: instantFromLocalDateTime('2026-08-31T00:00', 'Asia/Shanghai'), endAt: instantFromLocalDateTime('2026-09-07T00:00', 'Asia/Shanghai'), incomeMinor: 0, expenseMinor: 3_800, balanceMinor: -3_800 },
    { period: 'month', startAt: instantFromLocalDateTime('2026-09-01T00:00', 'Asia/Shanghai'), endAt: instantFromLocalDateTime('2026-10-01T00:00', 'Asia/Shanghai'), incomeMinor: 0, expenseMinor: 3_800, balanceMinor: -3_800 },
    { period: 'year', startAt: instantFromLocalDateTime('2026-01-01T00:00', 'Asia/Shanghai'), endAt: instantFromLocalDateTime('2027-01-01T00:00', 'Asia/Shanghai'), incomeMinor: 0, expenseMinor: 3_800, balanceMinor: -3_800 },
  ],
  trend: sixMonthTrend,
  recentTransactions: [expense],
})

const wrappers: VueWrapper[] = []

function setup(): void {
  api.getLedgerSettings.mockResolvedValue(settings)
  api.listLedgerAccounts.mockResolvedValue([account])
  api.listLedgerCategories.mockResolvedValue([category])
  api.getLedgerOverview.mockImplementation((input: { scope: LedgerOverviewDto['context']['scope']; anchorDate: string | undefined }) => Promise.resolve({
    ...overview(),
    context: {
      ...overview().context,
      scope: input.scope,
      anchorDate: input.anchorDate ?? overview().context.todayDate,
      isToday: input.anchorDate === undefined,
    },
  }))
  api.getLedgerTrend.mockResolvedValue(sixMonthTrend)
  api.listLedgerTransactions.mockResolvedValue({ transactions: [expense], page: { nextCursor: null } })
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

function overviewFor(anchorDate: string, incomeMinor = 0, expenseMinor = 3_800): LedgerOverviewDto {
  const base = overview()
  return {
    ...base,
    context: { ...base.context, anchorDate },
    cashflow: { incomeMinor, expenseMinor, balanceMinor: incomeMinor - expenseMinor },
    periods: base.periods.map((period) => period.period === 'today'
      ? { ...period, incomeMinor, expenseMinor, balanceMinor: incomeMinor - expenseMinor }
      : period),
  }
}

function categoryOverviewFor(anchorDate: string, name: string): LedgerOverviewDto {
  return {
    ...overviewFor(anchorDate),
    categoryBreakdown: {
      income: [{ categoryId: name, name, kind: 'income', amountMinor: 1_000 }],
      expense: [],
    },
  }
}

function datePickerFor(wrapper: VueWrapper, testId: string): VueWrapper<any> {
  const picker = wrapper.findAllComponents(LedgerDatePicker).find((candidate) => candidate.props('testId') === testId)
  if (!picker) throw new Error(`Missing LedgerDatePicker ${testId}`)
  return picker
}

describe('Ledger live dashboard', () => {
  beforeEach(() => {
    resetLedgerStoreForTesting()
    vi.clearAllMocks()
    setup()
  })

  afterEach(() => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount()
  })

  it('renders live data and recent real transactions without mock data', async () => {
    const wrapper = mount(LedgerView)
    wrappers.push(wrapper)
    await flushPromises()

    expect(wrapper.find('[data-testid="ledger-dashboard"]').exists()).toBe(true)
    await vi.waitFor(() => {
      expect(wrapper.get('[data-testid="ledger-total-assets"]').text()).toContain('9,962')
      expect(wrapper.get('[data-testid="ledger-total-liabilities"]').text()).toContain('0')
      expect(wrapper.get('[data-testid="ledger-net-worth"]').text()).toContain('9,962')
    }, { timeout: 2500 })
    expect(wrapper.get('[data-testid="ledger-total-assets"]').text()).not.toContain('当前所有资产账户余额')
    expect(wrapper.get('[data-testid="ledger-total-liabilities"]').text()).not.toContain('当前所有负债账户余额')
    expect(wrapper.get('[data-testid="ledger-net-worth"]').text()).not.toContain('当前净资产')
    expect(wrapper.get('[data-testid="ledger-dashboard-accounts"]').text()).toContain('招商银行')
    expect(wrapper.get('[data-testid="ledger-category-breakdown"]').text()).toContain('餐饮')
    expect(wrapper.get('[data-testid="ledger-category-breakdown"]').text()).toContain('这段期间还没有收入分类。')
    expect(wrapper.get('[data-testid="ledger-recent-transactions"]').text()).toContain('午餐')
    expect(wrapper.get('[data-testid="ledger-period-today"]').text()).toContain('2026-09-05')
    expect(wrapper.get('[data-testid="ledger-period-week"]').text()).toContain('2026-36周')
    expect(wrapper.get('[data-testid="ledger-period-month"]').text()).toContain('2026-09')
    expect(wrapper.get('[data-testid="ledger-period-year"]').text()).toContain('2026')
    for (const period of ['today', 'week', 'month', 'year']) {
      expect(wrapper.get(`[data-testid="ledger-period-${period}"]`).text()).not.toMatch(/00:00|23:59/)
    }
    expect(wrapper.get('[data-testid="ledger-period-month"]').text()).toContain('收支结余')
    expect(wrapper.get('[data-testid="ledger-period-month"]').text()).toContain('-¥38.00')
    expect(wrapper.text()).not.toContain('billsMockData')
  })

  it('hydrates local projections from the main overview without duplicate initial reads', async () => {
    const wrapper = mount(LedgerView)
    wrappers.push(wrapper)
    await flushPromises()

    expect(api.getLedgerOverview).toHaveBeenCalledTimes(1)
    expect(api.getLedgerTrend).not.toHaveBeenCalled()
  })

  it('rehydrates period projections when the main overview refreshes in place', async () => {
    const wrapper = mount(LedgerView)
    wrappers.push(wrapper)
    await flushPromises()
    await vi.waitFor(() => {
      expect(wrapper.get('[data-testid="ledger-period-today"]').text()).toContain('-¥38.00')
    }, { timeout: 2500 })

    api.getLedgerOverview.mockResolvedValueOnce(overviewFor('2026-09-05', 2_200, 0))
    await useLedgerStore().refreshOverview()
    await flushPromises()

    await vi.waitFor(() => {
      expect(wrapper.get('[data-testid="ledger-period-today"]').text()).toContain('¥22.00')
    }, { timeout: 2500 })
    expect(wrapper.get('[data-testid="ledger-period-today"]').text()).not.toContain('-¥38.00')
  })

  it('does not present stale period amounts while a local request is pending or fails', async () => {
    const wrapper = mount(LedgerView)
    wrappers.push(wrapper)
    await flushPromises()

    const pending = deferred<LedgerOverviewDto>()
    api.getLedgerOverview.mockReturnValueOnce(pending.promise)
    datePickerFor(wrapper, 'ledger-period-date').vm.$emit('update:modelValue', '2025-09-05')
    await nextTick()

    const periodCard = wrapper.get('[data-testid="ledger-period-today"]')
    expect(periodCard.text()).not.toContain('-¥38.00')
    expect(periodCard.find('[data-testid="ledger-period-loading-today"]').exists()).toBe(true)

    pending.reject(new LedgerApiError('period unavailable', 500, 'ledger-internal-error'))
    await flushPromises()

    expect(periodCard.text()).not.toContain('-¥38.00')
    expect(periodCard.get('[data-testid="ledger-period-error-today"]').text()).toContain('该期间数据暂时无法加载')
    expect(periodCard.get('[data-testid="ledger-period-error-today"]').text()).toContain('重试')
  })

  it('keeps the newest period request authoritative when an older success resolves later', async () => {
    const wrapper = mount(LedgerView)
    wrappers.push(wrapper)
    await flushPromises()

    const first = deferred<LedgerOverviewDto>()
    const second = deferred<LedgerOverviewDto>()
    api.getLedgerOverview.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const picker = datePickerFor(wrapper, 'ledger-period-date')
    picker.vm.$emit('update:modelValue', '2024-01-01')
    picker.vm.$emit('update:modelValue', '2025-01-01')
    await nextTick()

    second.resolve(overviewFor('2025-01-01', 2_200, 0))
    await flushPromises()
    const periodCard = wrapper.get('[data-testid="ledger-period-today"]')
    await vi.waitFor(() => {
      expect(periodCard.text()).toContain('¥22.00')
    }, { timeout: 2500 })

    first.resolve(overviewFor('2024-01-01', 1_100, 0))
    await flushPromises()
    expect(periodCard.text()).toContain('¥22.00')
    expect(periodCard.text()).not.toContain('¥11.00')
  })

  it('keeps the newest period success when an older request fails later', async () => {
    const wrapper = mount(LedgerView)
    wrappers.push(wrapper)
    await flushPromises()

    const first = deferred<LedgerOverviewDto>()
    const second = deferred<LedgerOverviewDto>()
    api.getLedgerOverview.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const picker = datePickerFor(wrapper, 'ledger-period-date')
    picker.vm.$emit('update:modelValue', '2024-01-01')
    picker.vm.$emit('update:modelValue', '2025-01-01')
    await nextTick()

    second.resolve(overviewFor('2025-01-01', 2_200, 0))
    await flushPromises()
    first.reject(new LedgerApiError('old period unavailable', 500, 'ledger-internal-error'))
    await flushPromises()

    const periodCard = wrapper.get('[data-testid="ledger-period-today"]')
    await vi.waitFor(() => {
      expect(periodCard.text()).toContain('¥22.00')
    }, { timeout: 2500 })
    expect(periodCard.find('[data-testid="ledger-period-error-today"]').exists()).toBe(false)
  })

  it('does not present stale trend data while a new trend request is pending or fails', async () => {
    const wrapper = mount(LedgerView)
    wrappers.push(wrapper)
    await flushPromises()

    const pending = deferred<LedgerOverviewDto['trend']>()
    api.getLedgerTrend.mockReturnValueOnce(pending.promise)
    datePickerFor(wrapper, 'ledger-trend-date').vm.$emit('update:modelValue', '2024-01-01')
    await nextTick()

    const trendSection = wrapper.get('#ledger-trend-title').element.closest('.ledger-dashboard-section')!
    expect(wrapper.findComponent(LedgerCashflowTrend).props('trend')).toEqual([])
    expect(trendSection.querySelector('[data-testid="ledger-trend-loading"]')).not.toBeNull()

    pending.reject(new LedgerApiError('trend unavailable', 500, 'ledger-internal-error'))
    await flushPromises()

    expect(wrapper.findComponent(LedgerCashflowTrend).props('trend')).toEqual([])
    expect(trendSection.querySelector('[data-testid="ledger-trend-error"]')?.textContent).toContain('趋势数据暂时无法加载')
    expect(trendSection.textContent).not.toContain('最近 6 个月')
  })

  it('keeps the newest trend request authoritative when an older success resolves later', async () => {
    const wrapper = mount(LedgerView)
    wrappers.push(wrapper)
    await flushPromises()

    const first = deferred<LedgerOverviewDto['trend']>()
    const second = deferred<LedgerOverviewDto['trend']>()
    api.getLedgerTrend.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const picker = datePickerFor(wrapper, 'ledger-trend-date')
    picker.vm.$emit('update:modelValue', '2024-01-01')
    await nextTick()
    picker.vm.$emit('update:modelValue', '2025-01-01')
    await nextTick()

    const secondTrend = [trendPoint('2025-01', 2_200, 0)]
    second.resolve(secondTrend)
    await flushPromises()
    expect(wrapper.findComponent(LedgerCashflowTrend).props('trend')).toEqual(secondTrend)

    const firstTrend = [trendPoint('2024-01', 1_100, 0)]
    first.resolve(firstTrend)
    await flushPromises()
    expect(wrapper.findComponent(LedgerCashflowTrend).props('trend')).toEqual(secondTrend)
  })

  it('distinguishes an empty category response from a category request failure', async () => {
    const wrapper = mount(LedgerView)
    wrappers.push(wrapper)
    await flushPromises()

    api.getLedgerOverview.mockResolvedValueOnce({
      ...overviewFor('2025-01-01'),
      categoryBreakdown: { income: [], expense: [] },
    })
    datePickerFor(wrapper, 'ledger-category-date').vm.$emit('update:modelValue', '2025-01-01')
    await flushPromises()

    const categorySection = wrapper.get('[aria-labelledby="ledger-category-breakdown-title"]')
    expect(categorySection.text()).toContain('这段期间还没有收入分类。')
    expect(categorySection.text()).toContain('这段期间还没有支出分类。')
    expect(categorySection.find('[data-testid="ledger-category-error"]').exists()).toBe(false)

    const failed = deferred<LedgerOverviewDto>()
    api.getLedgerOverview.mockReturnValueOnce(failed.promise)
    datePickerFor(wrapper, 'ledger-category-date').vm.$emit('update:modelValue', '2024-01-01')
    await nextTick()
    failed.reject(new LedgerApiError('category unavailable', 500, 'ledger-internal-error'))
    await flushPromises()

    expect(categorySection.get('[data-testid="ledger-category-error"]').text()).toContain('这段期间的数据暂时无法加载')
    expect(categorySection.text()).not.toContain('这段期间还没有收入分类。')
    expect(categorySection.text()).not.toContain('这段期间还没有支出分类。')
  })

  it('keeps all-time category reads independent of the disabled date picker', async () => {
    const wrapper = mount(LedgerView)
    wrappers.push(wrapper)
    await flushPromises()
    api.getLedgerOverview.mockClear()

    await setNaiveSelect(wrapper, '选择统计期间', 'all')
    await flushPromises()

    expect(api.getLedgerOverview).toHaveBeenLastCalledWith({ scope: 'all', anchorDate: undefined })
    expect(datePickerFor(wrapper, 'ledger-category-date').props('disabled')).toBe(true)
  })

  it('keeps the newest category request authoritative when an older success resolves later', async () => {
    const wrapper = mount(LedgerView)
    wrappers.push(wrapper)
    await flushPromises()

    const first = deferred<LedgerOverviewDto>()
    const second = deferred<LedgerOverviewDto>()
    api.getLedgerOverview.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const picker = datePickerFor(wrapper, 'ledger-category-date')
    picker.vm.$emit('update:modelValue', '2024-01-01')
    await nextTick()
    picker.vm.$emit('update:modelValue', '2025-01-01')
    await nextTick()

    second.resolve(categoryOverviewFor('2025-01-01', '2025分类'))
    await flushPromises()
    const categorySection = wrapper.get('[aria-labelledby="ledger-category-breakdown-title"]')
    expect(categorySection.text()).toContain('2025分类')

    first.resolve(categoryOverviewFor('2024-01-01', '2024分类'))
    await flushPromises()
    expect(categorySection.text()).toContain('2025分类')
    expect(categorySection.text()).not.toContain('2024分类')
  })

  it('keeps the newest category success when an older request fails later', async () => {
    const wrapper = mount(LedgerView)
    wrappers.push(wrapper)
    await flushPromises()

    const first = deferred<LedgerOverviewDto>()
    const second = deferred<LedgerOverviewDto>()
    api.getLedgerOverview.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const picker = datePickerFor(wrapper, 'ledger-category-date')
    picker.vm.$emit('update:modelValue', '2024-01-01')
    await nextTick()
    picker.vm.$emit('update:modelValue', '2025-01-01')
    await nextTick()

    second.resolve(categoryOverviewFor('2025-01-01', '2025分类'))
    await flushPromises()
    first.reject(new LedgerApiError('old category unavailable', 500, 'ledger-internal-error'))
    await flushPromises()

    const categorySection = wrapper.get('[aria-labelledby="ledger-category-breakdown-title"]')
    expect(categorySection.text()).toContain('2025分类')
    expect(categorySection.find('[data-testid="ledger-category-error"]').exists()).toBe(false)
  })

  it('uses the matching Naive date picker type for each period summary', async () => {
    const wrapper = mount(LedgerView)
    wrappers.push(wrapper)
    await flushPromises()

    const cashflowSection = wrapper.get('.ledger-cashflow-section')
    const periodSummarySection = wrapper.get('[aria-labelledby="ledger-periods-title"]')
    expect(wrapper.find('.ledger-period-navigation').exists()).toBe(false)
    expect(wrapper.find('#ledger-period-navigation-title').exists()).toBe(false)
    expect(cashflowSection.find('[data-testid="ledger-period-date"]').exists()).toBe(false)
    expect(periodSummarySection.get('[data-testid="ledger-period-date-control-today"]').text()).toContain('2026-09-05')
    const periodPickers = periodSummarySection.findAllComponents(LedgerDatePicker)
    expect(periodPickers).toHaveLength(4)
    expect(periodPickers.map((picker: VueWrapper<any>) => picker.props('type'))).toEqual(['date', 'week', 'month', 'year'])
    expect(getNaiveSelect(cashflowSection, '选择收支期间').exists()).toBe(true)
    expect(cashflowSection.find('[data-testid="ledger-return-today"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('期间分析')
    expect(wrapper.text()).not.toContain('breakdown')
    expect(wrapper.text()).not.toContain('projection')
    expect(wrapper.text()).not.toContain('查看日期')
    expect(wrapper.text()).not.toContain('收支范围')
  })

  it('keeps dashboard groups lightweight without losing account navigation or period semantics', async () => {
    const wrapper = mount(LedgerView)
    wrappers.push(wrapper)
    await flushPromises()

    expect(wrapper.findAll('[data-testid="ledger-dashboard-accounts"]')).toHaveLength(1)
    expect(wrapper.find('[data-testid="ledger-dashboard-account-viewport"]').exists()).toBe(true)
    expect(wrapper.findAll('.ledger-dashboard-actions')).toHaveLength(1)
    expect(wrapper.findAll('[data-testid="ledger-record-button"]')).toHaveLength(1)
    expect(wrapper.findAll('.ledger-metric-card')).toHaveLength(3)

    const sectionOrder = [
      wrapper.get('.ledger-metric-grid').element,
      wrapper.get('.ledger-cashflow-section').element,
      wrapper.get('[data-testid="ledger-dashboard-accounts"]').element,
      wrapper.get('.ledger-dashboard-two-column').element,
      wrapper.get('#ledger-periods-title').element.closest('.ledger-dashboard-section')!,
      wrapper.get('#ledger-trend-title').element.closest('.ledger-dashboard-section')!,
    ]
    for (let index = 1; index < sectionOrder.length; index += 1) {
      const position = sectionOrder[index - 1].compareDocumentPosition(sectionOrder[index])
      expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    }

    const accountLinks = wrapper.get('[data-testid="ledger-dashboard-assets"]').findAll('.ledger-dashboard-account')
    expect(accountLinks).toHaveLength(1)
    expect(accountLinks[0].classes()).toContain('ledger-dashboard-account')
    expect(accountLinks[0].classes()).not.toContain('ledger-account-card')
    await vi.waitFor(() => {
      expect(wrapper.get('#ledger-dashboard-assets-title').text()).toContain('¥9,962.00')
      expect(wrapper.get('#ledger-dashboard-liabilities-title').text()).toContain('¥0.00')
    }, { timeout: 2500 })

    const periodItems = wrapper.get('[data-testid="ledger-period-summaries"]').findAll('.ledger-period-card')
    expect(periodItems).toHaveLength(4)
    expect(periodItems.map((item) => item.attributes('data-testid'))).toEqual([
      'ledger-period-today',
      'ledger-period-week',
      'ledger-period-month',
      'ledger-period-year',
    ])
    expect(wrapper.text()).not.toContain('按资产与负债区分')
    expect(wrapper.text()).not.toContain('收支与分类按所选期间统计')
    expect(wrapper.text()).not.toContain('收入与支出分类金额')
    expect(wrapper.text()).not.toContain('最近 5 笔真实记录')
    expect(wrapper.text()).not.toContain('期间边界和金额均按 Ledger 时区统一计算')
    expect(wrapper.text()).not.toContain('最近月份的收支变化')
  })

  it('keeps every account in its nature-specific dashboard viewport', async () => {
    const accounts = Array.from({ length: 8 }, (_, index) => ({
      ...accountSummary,
      id: `bank-${index + 1}`,
      name: `账户 ${index + 1}`,
    }))
    api.getLedgerOverview.mockResolvedValue({ ...overview(), accounts })

    const wrapper = mount(LedgerView)
    wrappers.push(wrapper)
    await flushPromises()

    const viewport = wrapper.get('[data-testid="ledger-dashboard-assets-viewport"]')
    expect(viewport.findAll('.ledger-dashboard-account')).toHaveLength(accounts.length)
    for (const accountItem of accounts) {
      expect(viewport.text()).toContain(accountItem.name)
    }
  })

  it('uses the server scope endpoint when the selected cashflow period changes', async () => {
    const wrapper = mount(LedgerView)
    wrappers.push(wrapper)
    await flushPromises()

    await setNaiveSelect(wrapper, '选择收支期间', 'today')
    await flushPromises()

    expect(api.getLedgerOverview).toHaveBeenLastCalledWith({ scope: 'today', anchorDate: undefined })
    await vi.waitFor(() => {
      expect(wrapper.get('[data-testid="ledger-total-assets"]').text()).toContain('9,962')
    }, { timeout: 2500 })
    await vi.waitFor(() => {
      expect(wrapper.get('[data-testid="ledger-dashboard-cashflow"]').text()).toContain('38.00')
    }, { timeout: 2500 })
  })

  it('refreshes category breakdown independently from the cashflow period', async () => {
    const wrapper = mount(LedgerView)
    wrappers.push(wrapper)
    await flushPromises()

    await setNaiveSelect(wrapper, '选择统计期间', 'today')
    await flushPromises()

    expect(api.getLedgerOverview).toHaveBeenLastCalledWith({ scope: 'today', anchorDate: '2026-09-05' })
    expect(wrapper.get('#ledger-dashboard-cashflow-title').text()).toBe('本月收支')
    expect(wrapper.get('#ledger-category-breakdown-title').text()).toBe('收支分类')

    const categoryPicker = wrapper.findAllComponents(LedgerDatePicker).find((picker) => picker.props('testId') === 'ledger-category-date')
    expect(categoryPicker?.props('type')).toBe('date')

    await setNaiveSelect(wrapper, '选择统计期间', 'week')
    await flushPromises()
    const linkedWeekPicker = wrapper.findAllComponents(LedgerDatePicker).find((picker) => picker.props('testId') === 'ledger-category-date')
    expect(linkedWeekPicker?.props('type')).toBe('week')
    expect(api.getLedgerOverview).toHaveBeenLastCalledWith({ scope: 'week', anchorDate: '2026-09-05' })

    await setNaiveSelect(wrapper, '选择统计期间', 'month')
    await flushPromises()
    expect(wrapper.get('#ledger-category-breakdown-title').text()).toBe('收支分类')
  })

  it('supports the all-time scope without changing server-owned balances or fixed periods', async () => {
    const wrapper = mount(LedgerView)
    wrappers.push(wrapper)
    await flushPromises()

    await setNaiveSelect(wrapper, '选择收支期间', 'all')
    await flushPromises()

    expect(api.getLedgerOverview).toHaveBeenLastCalledWith({ scope: 'all', anchorDate: undefined })
    await vi.waitFor(() => {
      expect(wrapper.get('[data-testid="ledger-total-assets"]').text()).toContain('9,962')
    }, { timeout: 2500 })
    expect(wrapper.get('[data-testid="ledger-total-liabilities"]').text()).toContain('0')
    expect(wrapper.get('[data-testid="ledger-period-month"]').text()).toContain('-¥38.00')
  })

  it('keeps historical period errors separate from loading presentation', async () => {
    const wrapper = mount(LedgerView)
    wrappers.push(wrapper)
    await flushPromises()

    const refreshError = new LedgerApiError('overview unavailable', 500, 'ledger-internal-error')
    api.getLedgerOverview.mockRejectedValueOnce(refreshError)
    await setNaiveSelect(wrapper, '选择收支期间', 'today')
    await flushPromises()

    expect(wrapper.get('.ledger-inline-error').text()).toContain('这段期间的数据暂时无法加载。')
    expect(wrapper.get('.ledger-inline-error').text()).not.toContain('Ledger 暂时不可用')
    expect(wrapper.get('.ledger-inline-error').text()).toContain('重试')
    expect(wrapper.find('[data-testid="ledger-period-analysis-loading"]').exists()).toBe(false)
    await vi.waitFor(() => {
      expect(wrapper.get('[data-testid="ledger-total-assets"]').text()).toContain('9,962')
    }, { timeout: 2500 })

    const retry = deferred<LedgerOverviewDto>()
    api.getLedgerOverview.mockReturnValueOnce(retry.promise)
    await wrapper.get('.ledger-inline-error button').trigger('click')
    await nextTick()
    expect(wrapper.find('[data-testid="ledger-period-analysis-loading"]').exists()).toBe(true)
    expect(wrapper.find('.ledger-inline-error').exists()).toBe(false)

    retry.resolve({
      ...overview(),
      context: { ...overview().context, scope: 'today' },
    })
    await flushPromises()
    expect(wrapper.find('[data-testid="ledger-period-analysis-loading"]').exists()).toBe(false)
    expect(wrapper.find('.ledger-inline-error').exists()).toBe(false)
    await vi.waitFor(() => {
      expect(wrapper.get('[data-testid="ledger-dashboard-cashflow"]').text()).toContain('38.00')
    }, { timeout: 2500 })
  })

  it('does not show a period error when only the transaction read fails', async () => {
    const wrapper = mount(LedgerView)
    wrappers.push(wrapper)
    await flushPromises()

    const transactionsError = new LedgerApiError('transactions unavailable', 500, 'ledger-internal-error')
    api.listLedgerTransactions.mockRejectedValueOnce(transactionsError)
    await useLedgerStore().refreshTransactions({ type: 'all', limit: 50 })
    await nextTick()

    expect(useLedgerStore().transactionsError.value).toBe(transactionsError)
    expect(useLedgerStore().workspaceState.value).toBe('READY')
    expect(wrapper.find('[data-testid="ledger-dashboard"]').exists()).toBe(true)
    expect(wrapper.find('.ledger-inline-error').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('这段期间的数据暂时无法加载')
  })

  it('states a failed historical period read inside the period boundary', async () => {
    const wrapper = mount(LedgerView)
    wrappers.push(wrapper)
    await flushPromises()

    const store = useLedgerStore()
    store.setOverviewRequestContext({ scope: 'month', anchorDate: '2026-08-20' })
    await store.refreshOverview()
    await nextTick()
    expect((wrapper.get('[data-testid="ledger-period-date"] input').element as HTMLInputElement).value).toBe('2026-08-20')
    expect(wrapper.get('.ledger-cashflow-section').find('[data-testid="ledger-return-today"]').exists()).toBe(false)
    expect(wrapper.get('.ledger-cashflow-section').text()).toContain('2026年8月20日 · 账户余额为当前值')

    api.getLedgerOverview.mockRejectedValueOnce(new LedgerApiError('projection unavailable', 500, 'ledger-internal-error'))
    await store.refreshOverview()
    await nextTick()

    // The Current Snapshot is still on screen, so the copy may only speak for
    // the period that failed — not for Ledger as a whole.
    const inlineError = wrapper.get('.ledger-inline-error')
    expect(inlineError.text()).toContain('这段期间的数据暂时无法加载。')
    expect(inlineError.text()).toContain('重试')
    expect(wrapper.text()).not.toContain('Ledger 暂时不可用')
    expect(wrapper.text()).not.toContain('Ledger 暂时无法打开')
    expect(wrapper.find('[data-testid="ledger-period-analysis-loading"]').exists()).toBe(false)
    await vi.waitFor(() => {
      expect(wrapper.get('[data-testid="ledger-total-assets"]').text()).toContain('9,962')
    }, { timeout: 2500 })
    expect(wrapper.get('[data-testid="ledger-dashboard-accounts"]').text()).toContain('招商银行')
    expect(wrapper.find('[data-testid="ledger-bootstrap-error"]').exists()).toBe(false)
  })

  it('sends a failed current-state refresh to the workspace recovery boundary', async () => {
    const wrapper = mount(LedgerView)
    wrappers.push(wrapper)
    await flushPromises()
    expect(wrapper.find('[data-testid="ledger-dashboard"]').exists()).toBe(true)

    api.listLedgerAccounts.mockRejectedValueOnce(new LedgerApiError('accounts unavailable', 503, 'ledger-internal-error'))
    api.getLedgerOverview.mockClear()
    await useLedgerStore().refreshData()
    await nextTick()

    // Accounts are a current-state dependency. Presenting this as a period-only
    // failure would leave a stale Current Snapshot with only a period retry.
    expect(wrapper.find('[data-testid="ledger-bootstrap-error"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Ledger 暂时无法打开')
    expect(wrapper.get('[data-testid="ledger-bootstrap-error"] button').text()).toContain('重新加载')
    expect(wrapper.find('[data-testid="ledger-dashboard"]').exists()).toBe(false)
    expect(wrapper.find('.ledger-inline-error').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('这段期间的数据暂时无法加载')
    expect(wrapper.find('[data-testid="ledger-period-date"]').exists()).toBe(false)
    expect(api.getLedgerOverview).not.toHaveBeenCalled()
  })

  it('shows presentation-only category shares and groups accounts by nature', async () => {
    const liability: LedgerAccountSummary = {
      ...account,
      id: 'card-1',
      name: '信用卡',
      type: 'credit_card',
      nature: 'liability',
      currentBalanceMinor: 10_000,
      balanceIncreaseMinor: 10_000,
      balanceDecreaseMinor: 0,
    }
    api.getLedgerOverview.mockResolvedValue({
      ...overview(),
      accounts: [accountSummary, liability],
      categoryBreakdown: {
        income: [],
        expense: [
          { categoryId: 'food', name: '餐饮', kind: 'expense', amountMinor: 3_800 },
          { categoryId: 'transport', name: '交通', kind: 'expense', amountMinor: 6_200 },
        ],
      },
    })
    const wrapper = mount(LedgerView)
    wrappers.push(wrapper)
    await flushPromises()

    const breakdown = wrapper.get('[data-testid="ledger-category-breakdown"]').text()
    expect(breakdown).toContain('餐饮')
    expect(breakdown).toContain('38%')
    expect(breakdown).toContain('交通')
    expect(breakdown).toContain('62%')
    const accounts = wrapper.get('[data-testid="ledger-dashboard-accounts"]').text()
    expect(accounts).toContain('资产账户')
    expect(accounts).toContain('负债账户')
    expect(accounts).toContain('招商银行')
    expect(accounts).toContain('信用卡')
    expect(wrapper.get('[data-testid="ledger-dashboard-assets-viewport"]').findAll('.ledger-dashboard-account')).toHaveLength(1)
    expect(wrapper.get('[data-testid="ledger-dashboard-liabilities-viewport"]').findAll('.ledger-dashboard-account')).toHaveLength(1)
  })

  it('keeps category name and share on the left while placing the amount on the right', async () => {
    api.getLedgerOverview.mockResolvedValue({
      ...overview(),
      categoryBreakdown: {
        income: [
          { categoryId: 'salary', name: '工资', kind: 'income', amountMinor: 500_000 },
          { categoryId: 'side-job', name: '兼职', kind: 'income', amountMinor: 10_000 },
        ],
        expense: [
          { categoryId: 'food', name: '餐饮', kind: 'expense', amountMinor: 5_290 },
        ],
      },
    })
    const wrapper = mount(LedgerView)
    wrappers.push(wrapper)
    await flushPromises()

    const incomeRows = wrapper.get('[data-testid="ledger-category-breakdown"]').findAll('.ledger-breakdown-row')
    await vi.waitFor(() => {
      expect(incomeRows[0].get('.ledger-breakdown-amount').text()).toBe('¥5,000.00')
      expect(incomeRows[1].get('.ledger-breakdown-amount').text()).toBe('¥100.00')
    }, { timeout: 2500 })
    expect(incomeRows[0].get('.ledger-breakdown-name').text()).toBe('工资')
    expect(incomeRows[0].get('.ledger-breakdown-share').text()).toBe('98%')
    expect(incomeRows[0].get('.ledger-breakdown-amount').text()).not.toContain('98%')
    expect(incomeRows[1].get('.ledger-breakdown-name').text()).toBe('兼职')
    expect(incomeRows[1].get('.ledger-breakdown-share').text()).toBe('2%')
    expect(incomeRows[1].get('.ledger-breakdown-amount').text()).not.toContain('2%')

    const expenseRows = wrapper.get('[data-testid="ledger-category-breakdown"]').findAll('.ledger-breakdown-row')
    expect(expenseRows[2].get('.ledger-breakdown-name').text()).toBe('餐饮')
    expect(expenseRows[2].get('.ledger-breakdown-share').text()).toBe('100%')
    await vi.waitFor(() => {
      expect(expenseRows[2].get('.ledger-breakdown-amount').text()).toBe('¥52.90')
    }, { timeout: 2500 })
    expect(expenseRows[2].get('.ledger-breakdown-amount').text()).not.toContain('100%')
  })

  it('resolves recent transaction account labels from active and archived accounts', async () => {
    api.listLedgerAccounts.mockResolvedValue([account, archivedAccount, secondArchivedAccount])
    api.getLedgerOverview.mockResolvedValue({
      ...overview(),
      accounts: [accountSummary],
      recentTransactions: [
        archivedExpense,
        transferActiveToArchived,
        transferArchivedToActive,
        transferArchivedToArchived,
        archivedAdjustment,
      ],
    })

    const wrapper = mount(LedgerView)
    wrappers.push(wrapper)
    await flushPromises()

    const recent = wrapper.get('[data-testid="ledger-recent-transactions"]')
    const rows = recent.findAll('.ledger-recent-row')
    expect(rows).toHaveLength(5)
    expect(rows[0].element.tagName).toBe('DIV')
    expect(rows[0].element.parentElement?.classList.contains('n-list-item__main')).toBe(true)
    expect(rows[0].text()).toContain('餐饮 · 现金账户（已归档）')
    expect(rows[1].text()).toContain('招商银行 → 现金账户（已归档）')
    expect(rows[2].text()).toContain('现金账户（已归档） → 招商银行')
    expect(rows[3].text()).toContain('现金账户（已归档） → 旧钱包（已归档）')
    expect(rows[4].text()).toContain('现金账户（已归档）')

    // Archived accounts remain available for historical labels, but do not
    // re-enter the Dashboard's active account projection.
    expect(wrapper.get('[data-testid="ledger-dashboard-assets"]').text()).not.toContain('现金账户')
  })

  it('hands the whole anchored trend to the cashflow chart instead of a visible table', async () => {
    const wrapper = mount(LedgerView)
    wrappers.push(wrapper)
    await flushPromises()

    const chart = wrapper.findComponent(LedgerCashflowTrend)
    expect(chart.exists()).toBe(true)
    expect(chart.props('trend')).toEqual(sixMonthTrend)
    expect(chart.props('trend')).toHaveLength(6)
    expect(chart.props('currency')).toBe('CNY')
    expect(wrapper.find('[data-testid="ledger-cashflow-trend-canvas"]').exists()).toBe(true)

    // The old table stays available to assistive technology only, so it may
    // not come back as a second visible reading of the same six months.
    expect(wrapper.find('[data-testid="ledger-trend"]').exists()).toBe(false)
    expect(wrapper.find('.ledger-trend-table').exists()).toBe(false)
    expect(wrapper.get('[data-testid="ledger-cashflow-trend-table"]').classes()).toContain('sr-only')
    expect(wrapper.get('[data-testid="ledger-cashflow-trend-table"]').findAll('tbody tr')).toHaveLength(6)
  })

  it('keeps the currency in step with the Overview the chart was rendered from', async () => {
    api.getLedgerOverview.mockResolvedValue({ ...overview(), currency: 'JPY' })
    const wrapper = mount(LedgerView)
    wrappers.push(wrapper)
    await flushPromises()

    expect(wrapper.findComponent(LedgerCashflowTrend).props('currency')).toBe('JPY')
  })

  it('adds a proportion bar to each category row without displacing its text', async () => {
    api.getLedgerOverview.mockResolvedValue({
      ...overview(),
      categoryBreakdown: {
        income: [
          { categoryId: 'salary', name: '工资', kind: 'income', amountMinor: 500_000 },
          { categoryId: 'side-job', name: '兼职', kind: 'income', amountMinor: 10_000 },
        ],
        expense: [
          { categoryId: 'food', name: '餐饮', kind: 'expense', amountMinor: 5_290 },
        ],
      },
    })
    const wrapper = mount(LedgerView)
    wrappers.push(wrapper)
    await flushPromises()

    const rows = wrapper.get('[data-testid="ledger-category-breakdown"]').findAll('.ledger-breakdown-row')
    expect(rows).toHaveLength(3)

    await vi.waitFor(() => {
      expect(rows.map((row) => row.get('.ledger-breakdown-amount').text())).toEqual([
        '¥5,000.00',
        '¥100.00',
        '¥52.90',
      ])
    }, { timeout: 2500 })

    // Sort order, name, share and amount all stay exactly where they were.
    expect(rows.map((row) => [
      row.get('.ledger-breakdown-name').text(),
      row.get('.ledger-breakdown-share').text(),
    ])).toEqual([
      ['工资', '98%'],
      ['兼职', '2%'],
      ['餐饮', '100%'],
    ])
    // The bar reads from the same share, and stays out of the accessibility
    // tree because the percentage is already spoken by the label.
    const fills = rows.map((row) => row.get('.ledger-breakdown-bar-fill'))
    expect(fills.map((fill) => fill.attributes('style'))).toEqual([
      'width: 98%;',
      'width: 2%;',
      'width: 100%;',
    ])
    expect(rows[0].get('.ledger-breakdown-bar').attributes('aria-hidden')).toBe('true')
    expect(fills[0].classes()).toContain('is-income')
    expect(fills[2].classes()).toContain('is-expense')
  })

  it('renders a zero-width bar when a period has no category total to divide', async () => {
    api.getLedgerOverview.mockResolvedValue({
      ...overview(),
      categoryBreakdown: {
        income: [],
        expense: [{ categoryId: 'food', name: '餐饮', kind: 'expense', amountMinor: 0 }],
      },
    })
    const wrapper = mount(LedgerView)
    wrappers.push(wrapper)
    await flushPromises()

    const row = wrapper.get('[data-testid="ledger-category-breakdown"]').get('.ledger-breakdown-row')
    expect(row.get('.ledger-breakdown-name').text()).toBe('餐饮')
    expect(row.get('.ledger-breakdown-share').text()).toBe('0%')
    expect(row.get('.ledger-breakdown-bar-fill').attributes('style')).toBe('width: 0%;')
  })

  it('labels the trend window only while it is anchored to today', async () => {
    const wrapper = mount(LedgerView)
    wrappers.push(wrapper)
    await flushPromises()

    const trendSection = wrapper.get('#ledger-trend-title').element.closest('.ledger-dashboard-section')!
    expect(trendSection.textContent).toContain('收支趋势')
    expect(trendSection.textContent).toContain('最近 6 个月')

    const store = useLedgerStore()
    store.setOverviewRequestContext({ scope: 'month', anchorDate: '2026-08-20' })
    await store.refreshOverview()
    await nextTick()

    // The trend has its own selected month, so its window remains meaningful
    // even when the rest of the dashboard is anchored in the past.
    expect(wrapper.get('#ledger-trend-title').element.closest('.ledger-dashboard-section')!.textContent).toContain('最近 6 个月')
    expect(wrapper.findComponent(LedgerCashflowTrend).props('trend')).toEqual(sixMonthTrend)
  })

  it('shows the trend empty state without a chart when there is nothing to plot', async () => {
    api.getLedgerOverview.mockResolvedValue({ ...overview(), trend: [] })
    const wrapper = mount(LedgerView)
    wrappers.push(wrapper)
    await flushPromises()

    expect(wrapper.get('[data-testid="ledger-cashflow-trend-empty"]').text()).toContain('还没有趋势数据')
    expect(wrapper.find('[data-testid="ledger-cashflow-trend-canvas"]').exists()).toBe(false)
    expect(wrapper.get('#ledger-trend-title').element.closest('.ledger-dashboard-section')!.textContent).not.toContain('最近')
  })
})

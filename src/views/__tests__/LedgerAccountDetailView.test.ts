// @vitest-environment jsdom
import { DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  LedgerAccountDto,
  LedgerAccountTransactionBalance,
  LedgerOverviewDto,
  LedgerSettingsDto,
  LedgerTransactionDto,
} from '../../../shared/ledgerProtocol'
import { resetLedgerStoreForTesting } from '../../features/ledger/ledgerStore'
import LedgerAccountDetailView from '../LedgerAccountDetailView.vue'

const api = vi.hoisted(() => ({
  getLedgerSettings: vi.fn(),
  listLedgerAccounts: vi.fn(),
  listLedgerCategories: vi.fn(),
  getLedgerOverview: vi.fn(),
  listLedgerTransactions: vi.fn(),
  getLedgerAccount: vi.fn(),
  getLedgerAccountBalanceTrend: vi.fn(),
  getLedgerAccountTransactions: vi.fn(),
  patchLedgerAccount: vi.fn(),
  archiveLedgerAccount: vi.fn(),
  restoreLedgerAccount: vi.fn(),
}))
const confirm = vi.hoisted(() => vi.fn())

vi.mock('../../features/ledger/api', () => api)
vi.mock('../../composables/useConfirm', () => ({ useConfirm: () => ({ confirm }) }))

const settings: LedgerSettingsDto = {
  baseCurrency: 'CNY',
  currencyExponent: 2,
  timezone: 'Asia/Shanghai',
  hasCreatedAccount: true,
  version: 2,
  createdAt: 1,
  updatedAt: 2,
}

function account(overrides: Partial<LedgerAccountDto> = {}): LedgerAccountDto {
  return {
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
    version: 3,
    createdAt: 1,
    updatedAt: 2,
    currentBalanceMinor: 1_000_000,
    ...overrides,
  }
}

const overview = (): LedgerOverviewDto => ({
  context: { anchorDate: '2026-09-05', todayDate: '2026-09-05', isToday: true, scope: 'month' },
  currency: 'CNY',
  currencyExponent: 2,
  assetTotalMinor: 1_000_000,
  liabilityTotalMinor: 0,
  netWorthMinor: 1_000_000,
  accounts: [],
  cashflow: { incomeMinor: 0, expenseMinor: 0, balanceMinor: 0 },
  categoryBreakdown: { income: [], expense: [] },
  periods: [],
  trend: [],
  recentTransactions: [],
})

const wrappers: VueWrapper[] = []
const bodyWrapper = () => new DOMWrapper(document.body)

function createTestRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/ledger/accounts/:id', name: 'ledger-account', component: LedgerAccountDetailView },
      { path: '/ledger/accounts', name: 'ledger-accounts', component: { template: '<div />' } },
      { path: '/ledger/transactions', name: 'ledger-transactions', component: { template: '<div />' } },
    ],
  })
}

function setup(
  nextAccount: LedgerAccountDto,
  history: unknown[] = [],
  transactionBalances: readonly LedgerAccountTransactionBalance[] = [],
): void {
  api.getLedgerSettings.mockResolvedValue(settings)
  api.getLedgerAccount.mockResolvedValue(nextAccount)
  api.getLedgerAccountTransactions.mockResolvedValue({
    account: nextAccount,
    movement: { balanceIncreaseMinor: 0, balanceDecreaseMinor: 0 },
    transactions: history,
    transactionBalances,
    page: { nextCursor: null },
  })
  api.getLedgerAccountBalanceTrend.mockResolvedValue({ range: 30, points: [] })
  api.listLedgerAccounts.mockResolvedValue([nextAccount])
  api.listLedgerCategories.mockResolvedValue([])
  api.getLedgerOverview.mockResolvedValue(overview())
  api.listLedgerTransactions.mockResolvedValue({ transactions: [], page: { nextCursor: null } })
}

describe('Ledger account detail lifecycle', () => {
  beforeEach(() => {
    sessionStorage.clear()
    resetLedgerStoreForTesting()
    vi.clearAllMocks()
    confirm.mockResolvedValue(true)
  })

  afterEach(() => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount()
  })

  it('allows financial interpretation edits only before account history exists', async () => {
    const original = account()
    setup(original)
    const nextRouter = createTestRouter()
    await nextRouter.push('/ledger/accounts/bank-1')
    await nextRouter.isReady()
    const wrapper = mount(LedgerAccountDetailView, { global: { plugins: [nextRouter] } })
    wrappers.push(wrapper)
    await flushPromises()

    expect(api.getLedgerAccount).not.toHaveBeenCalled()
    await wrapper.findAll('button').find((button) => button.text() === '编辑账户')!.trigger('click')
    expect(bodyWrapper().findAll('.n-base-selection').length).toBeGreaterThan(0)
    await bodyWrapper().get('input[name="name"]').setValue('招商银行主账户')
    api.patchLedgerAccount.mockResolvedValue(account({ name: '招商银行主账户', version: 4 }))
    api.getLedgerAccount.mockResolvedValue(account({ name: '招商银行主账户', version: 4 }))
    await bodyWrapper().get('[data-testid="ledger-account-edit-form"]').trigger('submit')
    await flushPromises()

    expect(api.patchLedgerAccount).toHaveBeenCalledWith('bank-1', expect.objectContaining({
      expectedVersion: 3,
      name: '招商银行主账户',
      openingBalanceMinor: 1_000_000,
    }))
  })

  it('keeps the balance trend mounted while the edit modal opens and closes', async () => {
    const original = account()
    setup(original)
    const nextRouter = createTestRouter()
    await nextRouter.push('/ledger/accounts/bank-1')
    await nextRouter.isReady()
    const wrapper = mount(LedgerAccountDetailView, { global: { plugins: [nextRouter] } })
    wrappers.push(wrapper)
    await flushPromises()

    const chart = wrapper.get('[data-testid="ledger-balance-trend-chart"]')
    await wrapper.findAll('button').find((button) => button.text() === '编辑账户')!.trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="ledger-balance-trend-chart"]').element).toBe(chart.element)

    await bodyWrapper().findAll('button').find((button) => button.text() === '取消')!.trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="ledger-balance-trend-chart"]').element).toBe(chart.element)
  })

  it('closes the edit modal when clicking the mask', async () => {
    const original = account()
    setup(original)
    const nextRouter = createTestRouter()
    await nextRouter.push('/ledger/accounts/bank-1')
    await nextRouter.isReady()
    const wrapper = mount(LedgerAccountDetailView, { global: { plugins: [nextRouter] } })
    wrappers.push(wrapper)
    await flushPromises()

    await wrapper.findAll('button').find((button) => button.text() === '编辑账户')!.trigger('click')
    await flushPromises()
    expect(bodyWrapper().findAll('[data-testid="ledger-account-edit-form"]')).toHaveLength(1)

    const mask = bodyWrapper().get('.n-modal-mask')
    await mask.trigger('mousedown')
    await mask.trigger('mouseup')
    await flushPromises()
    expect(bodyWrapper().findAll('[data-testid="ledger-account-edit-form"]')).toHaveLength(0)
    expect(wrapper.findAll('[data-testid="ledger-balance-trend-chart"]')).toHaveLength(1)
  })

  it('sends only name and note when history makes financial fields read-only', async () => {
    const original = account()
    setup(original, [{ id: 'transaction-1', type: 'expense' }])
    const nextRouter = createTestRouter()
    await nextRouter.push('/ledger/accounts/bank-1')
    await nextRouter.isReady()
    const wrapper = mount(LedgerAccountDetailView, { global: { plugins: [nextRouter] } })
    wrappers.push(wrapper)
    await flushPromises()

    await wrapper.findAll('button').find((button) => button.text() === '编辑账户')!.trigger('click')
    expect(bodyWrapper().findAllComponents({ name: 'NSelect' }).length).toBe(0)
    expect(bodyWrapper().text()).not.toContain('账户已有历史记录')
    await bodyWrapper().get('input[name="name"]').setValue('历史账户')
    api.patchLedgerAccount.mockResolvedValue(account({ name: '历史账户', version: 4 }))
    await bodyWrapper().get('[data-testid="ledger-account-edit-form"]').trigger('submit')
    await flushPromises()

    expect(api.patchLedgerAccount).toHaveBeenCalledWith('bank-1', {
      expectedVersion: 3,
      name: '历史账户',
      note: '',
    })
  })

  it('requires zero balance before archiving and sends expectedVersion', async () => {
    const original = account({ currentBalanceMinor: 0 })
    setup(original)
    const nextRouter = createTestRouter()
    await nextRouter.push('/ledger/accounts/bank-1')
    await nextRouter.isReady()
    const wrapper = mount(LedgerAccountDetailView, { global: { plugins: [nextRouter] } })
    wrappers.push(wrapper)
    await flushPromises()

    await (wrapper.vm as unknown as { archive: () => Promise<void> }).archive()
    api.archiveLedgerAccount.mockResolvedValue(account({ currentBalanceMinor: 0, archivedAt: 20, version: 4 }))
    api.listLedgerAccounts.mockResolvedValue([account({ currentBalanceMinor: 0, archivedAt: 20, version: 4 })])
    await flushPromises()

    expect(api.archiveLedgerAccount).toHaveBeenCalledWith('bank-1', 3)
  })

  it('renders the server movement projection with asset language and a filtered-history link', async () => {
    const original = account()
    setup(original)
    api.getLedgerAccountTransactions.mockResolvedValue({
      account: original,
      movement: { balanceIncreaseMinor: 50_000, balanceDecreaseMinor: 12_000 },
      transactions: [],
      page: { nextCursor: null },
    })
    const nextRouter = createTestRouter()
    await nextRouter.push('/ledger/accounts/bank-1')
    await nextRouter.isReady()
    const wrapper = mount(LedgerAccountDetailView, { global: { plugins: [nextRouter] } })
    wrappers.push(wrapper)
    await flushPromises()

    const movement = wrapper.get('[data-testid="ledger-account-movement"]')
    expect(movement.text()).toContain('流入')
    expect(movement.text()).toContain('流出')
    await vi.waitFor(() => {
      expect(movement.text()).toContain('¥500.00')
      expect(movement.text()).toContain('¥120.00')
    }, { timeout: 2500 })
    expect(wrapper.get('.ledger-section-heading a').attributes('href')).toBe('/ledger/transactions?accountId=bank-1')
    expect(api.getLedgerAccountTransactions).toHaveBeenCalledWith('bank-1', { limit: 5 })
  })

  it('counts a bundled charge only once when it is listed beside the outgoing transfer', async () => {
    const original = account({ currentBalanceMinor: 470_000 })
    const repayment: LedgerTransactionDto = {
      id: 'repayment-1',
      type: 'transfer',
      transferKind: 'repayment',
      amountMinor: 500_000,
      bundle: { chargeMinor: 30_000, totalMinor: 530_000 },
      groupId: 'repayment-group',
      fromAccountId: 'bank-1',
      toAccountId: 'loan-1',
      payee: '',
      note: '',
      occurredAt: 3,
      deletedAt: null,
      version: 1,
      createdAt: 3,
      updatedAt: 3,
    }
    const interest: LedgerTransactionDto = {
      id: 'interest-1',
      type: 'expense',
      amountMinor: 30_000,
      groupId: 'repayment-group',
      accountId: 'bank-1',
      categoryId: 'interest',
      payee: '分期账单',
      note: '',
      occurredAt: 3,
      deletedAt: null,
      version: 1,
      createdAt: 4,
      updatedAt: 4,
    }
    setup(original, [interest, repayment], [
      { transactionId: 'interest-1', balanceMinor: 470_000 },
      { transactionId: 'repayment-1', balanceMinor: 500_000 },
    ])
    const nextRouter = createTestRouter()
    await nextRouter.push('/ledger/accounts/bank-1')
    await nextRouter.isReady()
    const wrapper = mount(LedgerAccountDetailView, { global: { plugins: [nextRouter] } })
    wrappers.push(wrapper)
    await flushPromises()

    const rows = wrapper.findAll('.ledger-recent-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.text()).toContain('-¥300.00')
    expect(rows[0]!.text()).toContain('¥4,700.00')
    expect(rows[1]!.text()).toContain('-¥5,000.00')
    expect(rows[1]!.text()).toContain('¥5,000.00')
  })

  it('renders server-provided running balances for recent transactions', async () => {
    const original = account({ openingBalanceMinor: 100_000, currentBalanceMinor: 106_000 })
    const latest: LedgerTransactionDto = {
      id: 'recent-latest',
      type: 'expense',
      amountMinor: 2_000,
      accountId: 'bank-1',
      categoryId: 'category-1',
      payee: '最新支出',
      note: '',
      occurredAt: 3,
      deletedAt: null,
      version: 1,
      createdAt: 3,
      updatedAt: 3,
    }
    const middle: LedgerTransactionDto = {
      ...latest,
      id: 'recent-middle',
      payee: '较早支出',
      occurredAt: 2,
      createdAt: 2,
      updatedAt: 2,
    }
    const oldest: LedgerTransactionDto = {
      ...latest,
      id: 'recent-oldest',
      type: 'income',
      amountMinor: 10_000,
      payee: '较早收入',
      occurredAt: 1,
      createdAt: 1,
      updatedAt: 1,
    }
    setup(original, [latest, middle, oldest], [
      { transactionId: latest.id, balanceMinor: 106_000 },
      { transactionId: middle.id, balanceMinor: 108_000 },
      { transactionId: oldest.id, balanceMinor: 110_000 },
    ])
    const nextRouter = createTestRouter()
    await nextRouter.push('/ledger/accounts/bank-1')
    await nextRouter.isReady()
    const wrapper = mount(LedgerAccountDetailView, { global: { plugins: [nextRouter] } })
    wrappers.push(wrapper)
    await flushPromises()

    const balances = wrapper.findAll('.ledger-recent-row').map((row) => row.find('.ledger-transaction-balance').text())
    expect(balances).toEqual(['¥1,060.00', '¥1,080.00', '¥1,100.00'])
  })

  it('uses only the transfer amount for an incoming account when a fee is bundled', async () => {
    const original = account({ id: 'bank-2', currentBalanceMinor: 200_000 })
    const withdrawal: LedgerTransactionDto = {
      id: 'withdrawal-1',
      type: 'transfer',
      transferKind: 'withdrawal',
      amountMinor: 200_000,
      bundle: { chargeMinor: 5_000, totalMinor: 205_000 },
      groupId: 'withdrawal-group',
      fromAccountId: 'wallet-1',
      toAccountId: 'bank-2',
      payee: '',
      note: '',
      occurredAt: 3,
      deletedAt: null,
      version: 1,
      createdAt: 3,
      updatedAt: 3,
    }
    setup(original, [withdrawal], [{ transactionId: withdrawal.id, balanceMinor: 200_000 }])
    const nextRouter = createTestRouter()
    await nextRouter.push('/ledger/accounts/bank-2')
    await nextRouter.isReady()
    const wrapper = mount(LedgerAccountDetailView, { global: { plugins: [nextRouter] } })
    wrappers.push(wrapper)
    await flushPromises()

    const row = wrapper.get('.ledger-recent-row')
    expect(row.text()).toContain('+¥2,000.00')
    expect(row.text()).toContain('¥2,000.00')
  })

  it('uses liability movement language instead of cashflow language', async () => {
    const liability = account({
      type: 'credit_card',
      nature: 'liability',
      currentBalanceMinor: 200_000,
    })
    setup(liability)
    api.getLedgerAccountTransactions.mockResolvedValue({
      account: liability,
      movement: { balanceIncreaseMinor: 80_000, balanceDecreaseMinor: 30_000 },
      transactions: [],
      page: { nextCursor: null },
    })
    const nextRouter = createTestRouter()
    await nextRouter.push('/ledger/accounts/bank-1')
    await nextRouter.isReady()
    const wrapper = mount(LedgerAccountDetailView, { global: { plugins: [nextRouter] } })
    wrappers.push(wrapper)
    await flushPromises()

    const movement = wrapper.get('[data-testid="ledger-account-movement"]')
    expect(movement.text()).toContain('新增负债')
    expect(movement.text()).toContain('减少负债')
    expect(movement.text()).not.toContain('流入')
    expect(movement.text()).not.toContain('流出')

    const metrics = movement.findAll('.ledger-metric-item')
    expect(metrics[1]?.find('.ledger-metric-icon').classes()).toContain('is-expense')
    expect(metrics[1]?.find('strong').classes()).toContain('is-expense')
    expect(metrics[2]?.find('.ledger-metric-icon').classes()).toContain('is-income')
    expect(metrics[2]?.find('strong').classes()).toContain('is-income')
    expect(metrics[3]?.find('strong').classes()).toContain('is-expense')
  })
})

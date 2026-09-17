// @vitest-environment jsdom
import { DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { NPagination } from 'naive-ui'
import type {
  LedgerAccountDto,
  LedgerCategoryDto,
  LedgerOverviewDto,
  LedgerSettingsDto,
  LedgerTransactionDto,
  LedgerTransactionPageDto,
} from '../../../shared/ledgerProtocol'
import { resetLedgerStoreForTesting } from '../../features/ledger/ledgerStore'
import { LEDGER_PENDING_CREATE_STORAGE_KEY, createLedgerPendingIntent } from '../../features/ledger/recovery'
import { instantFromLedgerDate } from '../../features/ledger/time'
import LedgerTransactionsView from '../LedgerTransactionsView.vue'
import LedgerDatePicker from '../../components/ledger/LedgerDatePicker.vue'
import { getNaiveSelect, naiveSelectValue, setNaiveSelect } from '../../components/ledger/__tests__/selectTestUtils'

const api = vi.hoisted(() => ({
  getLedgerSettings: vi.fn(),
  createLedgerSettings: vi.fn(),
  patchLedgerSettings: vi.fn(),
  listLedgerAccounts: vi.fn(),
  getLedgerAccount: vi.fn(),
  getLedgerAccountTransactions: vi.fn(),
  createLedgerAccount: vi.fn(),
  patchLedgerAccount: vi.fn(),
  archiveLedgerAccount: vi.fn(),
  restoreLedgerAccount: vi.fn(),
  deleteLedgerAccount: vi.fn(),
  listLedgerCategories: vi.fn(),
  createLedgerCategory: vi.fn(),
  patchLedgerCategory: vi.fn(),
  archiveLedgerCategory: vi.fn(),
  restoreLedgerCategory: vi.fn(),
  deleteLedgerCategory: vi.fn(),
  getLedgerOverview: vi.fn(),
  listLedgerTransactions: vi.fn(),
  createLedgerTransaction: vi.fn(),
  getLedgerTransaction: vi.fn(),
  patchLedgerTransaction: vi.fn(),
  deleteLedgerTransaction: vi.fn(),
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

function account(
  id: string,
  name: string,
  archivedAt: number | null = null,
): LedgerAccountDto {
  return {
    id,
    name,
    type: 'bank',
    nature: 'asset',
    openingBalanceMinor: 1_000_000,
    openingDate: '2026-01-01',
    currency: 'CNY',
    currencyExponent: 2,
    note: '',
    archivedAt,
    version: archivedAt === null ? 1 : 4,
    createdAt: 1,
    updatedAt: 2,
    currentBalanceMinor: 1_000_000,
  }
}

const activeAccount = account('bank-1', '招商银行')
const archivedAccount = account('old-bank', '旧账户', 20)
const walletAccount = { ...account('wallet-1', '微信零钱'), type: 'wallet' as const }
const liabilityAccount = {
  ...account('liability-1', '花呗'),
  type: 'credit_card' as const,
  nature: 'liability' as const,
}

function category(
  id: string,
  kind: 'income' | 'expense',
  name: string,
  archivedAt: number | null = null,
): LedgerCategoryDto {
  return {
    id,
    kind,
    name,
    normalizedName: name.toLowerCase(),
    archivedAt,
    version: 1,
    createdAt: 1,
    updatedAt: 2,
  }
}

const expenseCategory = category('food', 'expense', '餐饮')
const incomeCategory = category('salary', 'income', '工资')
const archivedCategory = category('old-food', 'expense', '旧餐饮', 20)

const expense: LedgerTransactionDto = {
  id: 'tx-expense',
  type: 'expense',
  amountMinor: 3_800,
  accountId: activeAccount.id,
  categoryId: expenseCategory.id,
  occurredAt: Date.UTC(2026, 8, 5, 4, 30),
  payee: '午餐',
  note: '',
  deletedAt: null,
  version: 3,
  createdAt: 1,
  updatedAt: 2,
}

const income: LedgerTransactionDto = {
  id: 'tx-income',
  type: 'income',
  amountMinor: 20_000,
  accountId: activeAccount.id,
  categoryId: incomeCategory.id,
  occurredAt: Date.UTC(2026, 8, 4, 4, 30),
  payee: '工资',
  note: '月度收入',
  deletedAt: null,
  version: 1,
  createdAt: 1,
  updatedAt: 2,
}

const transfer: LedgerTransactionDto = {
  id: 'tx-transfer',
  type: 'transfer',
  transferKind: 'general',
  amountMinor: 5_000,
  fromAccountId: activeAccount.id,
  toAccountId: archivedAccount.id,
  occurredAt: Date.UTC(2026, 8, 3, 4, 30),
  payee: '',
  note: '转入旧账户',
  deletedAt: null,
  version: 1,
  createdAt: 1,
  updatedAt: 2,
}

const adjustment: LedgerTransactionDto = {
  id: 'tx-adjustment',
  type: 'adjustment',
  amountMinor: 2_000,
  accountId: activeAccount.id,
  adjustmentCalculatedBalanceMinor: 98_000,
  adjustmentTargetBalanceMinor: 100_000,
  occurredAt: Date.UTC(2026, 8, 2, 4, 30),
  note: '期初校准',
  deletedAt: null,
  version: 1,
  createdAt: 1,
  updatedAt: 2,
}

const withdrawalFee: LedgerTransactionDto = {
  ...expense,
  id: 'tx-withdrawal-fee',
  groupId: 'withdrawal-group',
  accountId: walletAccount.id,
  categoryId: 'fee',
  payee: '微信零钱提现手续费',
}

const withdrawal: LedgerTransactionDto = {
  id: 'tx-withdrawal',
  groupId: withdrawalFee.groupId,
  type: 'transfer',
  transferKind: 'withdrawal',
  feeMode: 'deducted',
  amountMinor: 9_900,
  fromAccountId: walletAccount.id,
  toAccountId: activeAccount.id,
  occurredAt: withdrawalFee.occurredAt,
  payee: '',
  note: '',
  deletedAt: null,
  version: 1,
  createdAt: 1,
  updatedAt: 2,
}

const repaymentInterest: LedgerTransactionDto = {
  ...expense,
  id: 'tx-repayment-interest',
  groupId: 'repayment-group',
  categoryId: 'interest',
  payee: '花呗还款利息',
}

const repayment: LedgerTransactionDto = {
  id: 'tx-repayment',
  groupId: repaymentInterest.groupId,
  type: 'transfer',
  transferKind: 'repayment',
  amountMinor: 10_000,
  fromAccountId: activeAccount.id,
  toAccountId: liabilityAccount.id,
  occurredAt: repaymentInterest.occurredAt,
  payee: '',
  note: '',
  deletedAt: null,
  version: 1,
  createdAt: 1,
  updatedAt: 2,
}

const overview: LedgerOverviewDto = {
  context: { anchorDate: '2026-09-05', todayDate: '2026-09-05', isToday: true, scope: 'month' },
  currency: 'CNY',
  currencyExponent: 2,
  assetTotalMinor: 1_000_000,
  liabilityTotalMinor: 0,
  netWorthMinor: 1_000_000,
  accounts: [],
  cashflow: { incomeMinor: 20_000, expenseMinor: 3_800, balanceMinor: 16_200 },
  categoryBreakdown: { income: [], expense: [] },
  periods: [],
  trend: [],
  recentTransactions: [expense],
}

const emptyPage: LedgerTransactionPageDto = {
  transactions: [],
  page: { nextCursor: null },
}

const wrappers: VueWrapper[] = []

async function setLedgerDate(wrapper: VueWrapper, testId: string, value: string): Promise<void> {
  const picker = wrapper.findAllComponents(LedgerDatePicker).find((candidate) => candidate.props('testId') === testId)
  if (!picker) throw new Error(`Ledger date picker not found: ${testId}`)
  await picker.vm.$emit('update:modelValue', value)
}

function setup(
  page: LedgerTransactionPageDto = { transactions: [expense, income, transfer, adjustment], page: { nextCursor: null } },
  accounts: LedgerAccountDto[] = [activeAccount, archivedAccount],
): void {
  api.getLedgerSettings.mockResolvedValue(settings)
  api.listLedgerAccounts.mockResolvedValue(accounts)
  api.getLedgerAccount.mockImplementation((id: string) => Promise.resolve(accounts.find((item) => item.id === id) ?? activeAccount))
  api.listLedgerCategories.mockResolvedValue([expenseCategory, incomeCategory, archivedCategory])
  api.getLedgerOverview.mockResolvedValue(overview)
  api.listLedgerTransactions.mockResolvedValue(page)
  api.getLedgerTransaction.mockResolvedValue(expense)
  api.patchLedgerTransaction.mockResolvedValue({ ...expense, note: '已更新', version: 4 })
  api.deleteLedgerTransaction.mockResolvedValue({ ...expense, deletedAt: 30, version: 4 })
  api.restoreLedgerAccount.mockResolvedValue(activeAccount)
  confirm.mockResolvedValue(true)
}

async function mountView(path = '/ledger/transactions'): Promise<VueWrapper> {
  const nextRouter = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/ledger/transactions', name: 'ledger-transactions', component: LedgerTransactionsView },
      { path: '/ledger/accounts', name: 'ledger-accounts', component: { template: '<div />' } },
      { path: '/ledger', name: 'ledger', component: { template: '<div />' } },
    ],
  })
  await nextRouter.push(path)
  await nextRouter.isReady()
  const wrapper = mount(LedgerTransactionsView, { global: { plugins: [nextRouter] } })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}

function getDetail(): InstanceType<typeof DOMWrapper> {
  const element = document.body.querySelector<HTMLElement>('.ledger-detail-sheet')
  if (!element) throw new Error('transaction detail is not mounted')
  return new DOMWrapper(element)
}

describe('Ledger live transaction history workspace', () => {
  beforeEach(() => {
    sessionStorage.clear()
    resetLedgerStoreForTesting()
    vi.clearAllMocks()
    setup()
  })

  afterEach(async () => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount()
    document.body.querySelectorAll('.ledger-detail-sheet').forEach((element) => element.remove())
    await flushPromises()
  })

  it('renders real transactions and exposes archived accounts/categories in history filters', async () => {
    const wrapper = await mountView()

    expect(wrapper.find('[data-testid="ledger-transaction-list"]').text()).toContain('午餐')
    expect(wrapper.text()).toContain('工资')
    expect(wrapper.text()).toContain('余额调整')
    expect(wrapper.findAll('thead th').map((header) => header.text())).toEqual(['交易对象', '类型', '分类', '账户', '备注', '时间', '金额'])
    expect(wrapper.get('[data-testid="ledger-transaction-row-tx-expense"]').text()).toContain('2026/09/05 12:30')
    expect(wrapper.get('[data-testid="ledger-transaction-row-tx-expense"]').text()).toContain('-¥38.00')
    expect(wrapper.get('[data-testid="ledger-transaction-row-tx-transfer"]').text()).toContain('¥50.00')
    expect(wrapper.get('[data-testid="ledger-transaction-row-tx-transfer"]').text()).not.toContain('-¥50.00')
    expect(getNaiveSelect(wrapper, '账户').props('options')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'group',
        label: '资产账户',
        children: expect.arrayContaining([
          expect.objectContaining({ value: 'old-bank', accountName: '旧账户（已归档）' }),
        ]),
      }),
    ]))
    expect(getNaiveSelect(wrapper, '分类').props('options')).toEqual(expect.arrayContaining([{ value: 'old-food', label: '旧餐饮（已归档）' }]))
    expect(getNaiveSelect(wrapper, '账户').props('renderLabel')).toEqual(expect.any(Function))
    expect(getNaiveSelect(wrapper, '分类').props('renderLabel')).toEqual(expect.any(Function))
    expect(wrapper.text()).not.toContain('billsMockData')
  })

  it('sends supported type, entity, and Ledger-timezone date filters to the API', async () => {
    const wrapper = await mountView()

    await wrapper.get('[data-ledger-filter-type="expense"]').trigger('click')
    await setNaiveSelect(wrapper, '账户', 'old-bank')
    await setNaiveSelect(wrapper, '分类', 'old-food')
    await setNaiveSelect(wrapper, '日期', 'custom')
    await setLedgerDate(wrapper, 'ledger-filter-from', '2026-09-01')
    await setLedgerDate(wrapper, 'ledger-filter-to', '2026-09-05')
    await wrapper.get('input[name="search"]').setValue('午餐')
    await wrapper.get('[data-testid="ledger-filters-form"]').trigger('submit')
    await flushPromises()

    expect(api.listLedgerTransactions).toHaveBeenLastCalledWith({
      type: 'expense',
      accountId: 'old-bank',
      categoryId: 'old-food',
      from: instantFromLedgerDate('2026-09-01', 'Asia/Shanghai', 'start'),
      to: instantFromLedgerDate('2026-09-05', 'Asia/Shanghai', 'end'),
      search: '午餐',
      limit: 25,
    })
  })

  it('applies an Account deep-link query before loading history', async () => {
    const wrapper = await mountView('/ledger/transactions?accountId=old-bank')

    expect(naiveSelectValue(wrapper, '账户')).toBe('old-bank')
    expect(api.listLedgerTransactions).toHaveBeenLastCalledWith({
      type: 'all',
      accountId: 'old-bank',
      limit: 25,
    })
  })

  it('requests the selected server-side page with the correct offset', async () => {
    const firstPage: LedgerTransactionPageDto = {
      transactions: Array.from({ length: 25 }, (_, index) => ({ ...expense, id: index === 0 ? expense.id : `tx-expense-${index}` })),
      page: { nextCursor: 'cursor-1', total: 26, incomeMinor: income.amountMinor, expenseMinor: expense.amountMinor * 25 },
    }
    const secondPage: LedgerTransactionPageDto = {
      transactions: [income],
      page: { nextCursor: null, total: 26, incomeMinor: income.amountMinor, expenseMinor: expense.amountMinor * 25 },
    }
    api.listLedgerTransactions.mockReset()
    api.listLedgerTransactions
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage)
      .mockResolvedValueOnce(firstPage)
    const wrapper = await mountView()

    await wrapper.findComponent(NPagination).vm.$emit('update:page', 2)
    await flushPromises()

    await vi.waitFor(() => {
      expect(api.listLedgerTransactions).toHaveBeenCalledWith({ type: 'all', limit: 25, offset: 25 })
    })
    await vi.waitFor(() => {
      expect(wrapper.get('[data-testid="ledger-transaction-list"]').text()).toContain('工资')
      expect(wrapper.get('[data-testid="ledger-transaction-list"]').text()).not.toContain('午餐')
    })
    expect(wrapper.text()).toContain('共 26 条')
    expect(wrapper.findComponent(NPagination).props('page')).toBe(2)
    expect(wrapper.findComponent(NPagination).props('itemCount')).toBe(26)
    expect(wrapper.findComponent(NPagination).props('showSizePicker')).toBe(true)
    await wrapper.findComponent(NPagination).vm.$emit('update:page', 1)
    await flushPromises()
    await vi.waitFor(() => {
      expect(api.listLedgerTransactions).toHaveBeenCalledWith({ type: 'all', limit: 25 })
      expect(wrapper.get('[data-testid="ledger-transaction-list"]').text()).toContain('午餐')
    })
    expect(wrapper.get('[data-testid="ledger-transaction-list"]').text()).not.toContain('工资')
  })

  it('shows a purposeful empty state for a filtered result', async () => {
    api.listLedgerTransactions.mockResolvedValue(emptyPage)
    const wrapper = await mountView()

    await wrapper.get('[data-ledger-filter-type="income"]').trigger('click')
    await wrapper.get('[data-testid="ledger-filters-form"]').trigger('submit')
    await flushPromises()

    expect(wrapper.get('[data-testid="ledger-transactions-empty"]').text()).toContain('没有符合当前筛选条件的交易')
    expect(wrapper.find('.ledger-empty-icon').exists()).toBe(true)
    expect(wrapper.get('[data-testid="ledger-transactions-empty"]').text()).toContain('清除筛选')
  })

  it('keeps history and archived filters available when every Account is archived', async () => {
    setup({ transactions: [expense], page: { nextCursor: null } }, [archivedAccount])
    const wrapper = await mountView()

    expect(wrapper.get('[data-testid="ledger-transactions-no-account"]').text()).toContain('当前没有可用于新增交易的账户')
    expect(wrapper.get('[data-testid="ledger-transaction-list"]').text()).toContain('午餐')
    expect(getNaiveSelect(wrapper, '账户').props('options')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'group',
        children: expect.arrayContaining([
          expect.objectContaining({ value: 'old-bank', accountName: '旧账户（已归档）' }),
        ]),
      }),
    ]))
    expect(getNaiveSelect(wrapper, '分类').props('options')).toEqual(expect.arrayContaining([{ value: 'old-food', label: '旧餐饮（已归档）' }]))
    expect(wrapper.get('[data-testid="ledger-transactions-record-button"]').attributes('disabled')).toBeDefined()
  })

  it('edits an ordinary transaction with its current expectedVersion and refreshes the live list', async () => {
    const wrapper = await mountView()
    await wrapper.findAll('[data-testid^="ledger-transaction-row"]').at(0)?.trigger('click')
    await flushPromises()

    const detail = getDetail()
    expect(detail.text()).toContain('交易详情')
    await detail.findAll('button').find((button) => button.text() === '编辑交易')!.trigger('click')
    const editForm = getDetail().get('[data-testid="ledger-transaction-edit-form"]')
    await editForm.get('textarea[name="note"]').setValue('已核对')
    await editForm.trigger('submit')
    await flushPromises()

    expect(api.patchLedgerTransaction).toHaveBeenCalledWith('tx-expense', {
      expectedVersion: 3,
      amountMinor: 3_800,
      accountId: 'bank-1',
      categoryId: 'food',
      occurredAt: expense.occurredAt,
      payee: '午餐',
      location: '',
      note: '已核对',
    })
  })

  it('shows the stored withdrawal fee payee in the table and detail sheet', async () => {
    setup(
      { transactions: [withdrawalFee, withdrawal], page: { nextCursor: null } },
      [activeAccount, walletAccount],
    )
    api.listLedgerTransactions.mockImplementation((query: { groupId?: string }) => Promise.resolve(
      query.groupId === withdrawalFee.groupId
        ? { transactions: [withdrawal, withdrawalFee], page: { nextCursor: null } }
        : { transactions: [withdrawalFee, withdrawal], page: { nextCursor: null } },
    ))
    const wrapper = await mountView()

    expect(wrapper.get('[data-testid="ledger-transaction-row-tx-withdrawal-fee"]').text()).toContain('微信零钱提现手续费')
    await wrapper.get('[data-testid="ledger-transaction-row-tx-withdrawal-fee"]').trigger('click')
    await flushPromises()

    expect(getDetail().text()).toContain('交易对象微信零钱提现手续费')
    expect(getDetail().text()).not.toContain('交易对象未填写')
  })

  it('shows the stored repayment interest payee in the table and detail sheet', async () => {
    setup(
      { transactions: [repaymentInterest, repayment], page: { nextCursor: null } },
      [activeAccount, liabilityAccount],
    )
    api.listLedgerTransactions.mockImplementation((query: { groupId?: string }) => Promise.resolve(
      query.groupId === repaymentInterest.groupId
        ? { transactions: [repayment, repaymentInterest], page: { nextCursor: null } }
        : { transactions: [repaymentInterest, repayment], page: { nextCursor: null } },
    ))
    const wrapper = await mountView()

    expect(wrapper.get('[data-testid="ledger-transaction-row-tx-repayment-interest"]').text()).toContain('花呗还款利息')
    await wrapper.get('[data-testid="ledger-transaction-row-tx-repayment-interest"]').trigger('click')
    await flushPromises()

    expect(getDetail().text()).toContain('交易对象花呗还款利息')
    expect(getDetail().text()).not.toContain('交易对象花呗账单')
  })

  it('restores an archived account and refreshes an ordinary transaction', async () => {
    const archivedExpense = { ...expense, id: 'tx-restore-ordinary', accountId: archivedAccount.id }
    setup({ transactions: [archivedExpense], page: { nextCursor: null } }, [archivedAccount])
    api.restoreLedgerAccount.mockResolvedValue({ ...archivedAccount, archivedAt: null, version: 5 })
    api.listLedgerAccounts
      .mockResolvedValueOnce([archivedAccount])
      .mockResolvedValue([{ ...archivedAccount, archivedAt: null, version: 5 }])
    api.getLedgerTransaction.mockResolvedValue(archivedExpense)
    const wrapper = await mountView()

    await wrapper.get('[data-testid="ledger-transaction-row-tx-restore-ordinary"]').trigger('click')
    await flushPromises()
    await getDetail().findAll('button').find((button) => button.text() === '恢复账户')!.trigger('click')
    await flushPromises()

    expect(api.restoreLedgerAccount).toHaveBeenCalledWith(archivedAccount.id, archivedAccount.version)
    expect(api.getLedgerTransaction).toHaveBeenCalledWith(archivedExpense.id)
    expect(getDetail().text()).not.toContain('账户没有恢复')
  })

  it.each([
    ['repayment interest', repaymentInterest, repayment, archivedAccount],
    ['withdrawal fee', withdrawalFee, withdrawal, { ...walletAccount, archivedAt: 20, version: 4 }],
  ])('restores an archived account from a grouped %s companion without reading its forbidden id', async (_label, companion, primary, archived) => {
    const groupedCompanion = { ...companion, accountId: archived.id }
    setup({ transactions: [groupedCompanion, primary], page: { nextCursor: null } }, [archived])
    api.listLedgerTransactions.mockImplementation((query: { groupId?: string }) => Promise.resolve(
      query.groupId === companion.groupId
        ? { transactions: [primary, groupedCompanion], page: { nextCursor: null } }
        : { transactions: [groupedCompanion, primary], page: { nextCursor: null } },
    ))
    api.restoreLedgerAccount.mockResolvedValue({ ...archived, archivedAt: null, version: 5 })
    api.listLedgerAccounts
      .mockResolvedValueOnce([archived])
      .mockResolvedValue([{ ...archived, archivedAt: null, version: 5 }])
    api.getLedgerTransaction.mockRejectedValue(new Error('grouped companion is not directly readable'))
    const wrapper = await mountView()

    await wrapper.get(`[data-testid="ledger-transaction-row-${groupedCompanion.id}"]`).trigger('click')
    await flushPromises()
    await getDetail().findAll('button').find((button) => button.text() === '恢复账户')!.trigger('click')
    await flushPromises()

    expect(api.restoreLedgerAccount).toHaveBeenCalledWith(archived.id, archived.version)
    expect(api.getLedgerTransaction).not.toHaveBeenCalled()
    expect(getDetail().text()).not.toContain('账户没有恢复')
    expect(getDetail().text()).not.toContain('恢复账户')
  })

  it('reports a real account restore failure', async () => {
    const archivedExpense = { ...expense, id: 'tx-restore-failure', accountId: archivedAccount.id }
    setup({ transactions: [archivedExpense], page: { nextCursor: null } }, [archivedAccount])
    api.restoreLedgerAccount.mockRejectedValue(new Error('restore failed'))
    const wrapper = await mountView()

    await wrapper.get('[data-testid="ledger-transaction-row-tx-restore-failure"]').trigger('click')
    await flushPromises()
    await getDetail().findAll('button').find((button) => button.text() === '恢复账户')!.trigger('click')
    await flushPromises()

    expect(api.getLedgerTransaction).not.toHaveBeenCalled()
    expect(getDetail().text()).toContain('网络连接中断，尚未确认本次操作是否保存。')
  })

  it('edits a legacy withdrawal without feeMode using the server-compatible extra mode', async () => {
    const legacyWithdrawal = { ...withdrawal, amountMinor: 10_000, feeMode: undefined }
    const legacyFee = { ...withdrawalFee, amountMinor: 100 }
    setup({ transactions: [legacyWithdrawal], page: { nextCursor: null } }, [activeAccount, walletAccount])
    api.listLedgerTransactions.mockImplementation((query: { groupId?: string }) => Promise.resolve(
      query.groupId === legacyWithdrawal.groupId
        ? { transactions: [legacyWithdrawal, legacyFee], page: { nextCursor: null } }
        : { transactions: [legacyWithdrawal], page: { nextCursor: null } },
    ))
    const wrapper = await mountView()

    await wrapper.get('[data-testid="ledger-transaction-row-tx-withdrawal"]').trigger('click')
    await flushPromises()
    await getDetail().findAll('button').find((button) => button.text() === '编辑交易')!.trigger('click')
    const form = getDetail().get('[data-testid="ledger-transaction-edit-form"]')

    expect((form.get('input[name="amount"]').element as HTMLInputElement).value).toBe('100.00')
    expect(form.get('[aria-label="修改手续费方式：额外扣除"]').text()).toBe('额外扣除')
    await form.trigger('submit')
    await flushPromises()

    expect(api.patchLedgerTransaction).toHaveBeenCalledWith(legacyWithdrawal.id, expect.objectContaining({
      amountMinor: 10_000,
      feeMinor: 100,
      feeMode: 'extra',
    }))
  })

  it('defaults a withdrawal without a feeMode or existing fee to deducted when adding its first fee', async () => {
    const legacyWithdrawal = { ...withdrawal, amountMinor: 10_000, feeMode: undefined }
    setup({ transactions: [legacyWithdrawal], page: { nextCursor: null } }, [activeAccount, walletAccount])
    api.listLedgerTransactions.mockImplementation((query: { groupId?: string }) => Promise.resolve(
      query.groupId === legacyWithdrawal.groupId
        ? { transactions: [legacyWithdrawal], page: { nextCursor: null } }
        : { transactions: [legacyWithdrawal], page: { nextCursor: null } },
    ))
    const wrapper = await mountView()

    await wrapper.get('[data-testid="ledger-transaction-row-tx-withdrawal"]').trigger('click')
    await flushPromises()
    await getDetail().findAll('button').find((button) => button.text() === '编辑交易')!.trigger('click')
    const form = getDetail().get('[data-testid="ledger-transaction-edit-form"]')
    await form.get('input[name="feeAmount"]').setValue('1')

    expect(form.get('[aria-label="修改手续费方式：从提现金额中扣除"]').text()).toBe('从提现金额中扣除')
    await form.trigger('submit')
    await flushPromises()

    expect(api.patchLedgerTransaction).toHaveBeenCalledWith(legacyWithdrawal.id, expect.objectContaining({
      amountMinor: 10_000,
      feeMinor: 100,
      feeMode: 'deducted',
    }))
  })

  it('guards every detail close path when an edit is dirty', async () => {
    const wrapper = await mountView()
    await wrapper.find('[data-testid="ledger-transaction-row-tx-expense"]').trigger('click')
    await flushPromises()

    let detail = getDetail()
    await detail.findAll('button').find((button) => button.text() === '编辑交易')!.trigger('click')
    await getDetail().get('input[name="payee"]').setValue('未保存商户')
    await flushPromises()

    confirm.mockResolvedValueOnce(false)
    await getDetail().find('.ledger-close-button').trigger('click')
    await flushPromises()

    expect(confirm).toHaveBeenCalledWith('放弃这笔尚未保存的修改？', '已填写的内容将不会保存。')
    expect(document.body.querySelector('.ledger-detail-sheet')).not.toBeNull()

    confirm.mockResolvedValueOnce(true)
    await getDetail().find('.ledger-close-button').trigger('click')
    await flushPromises()

    expect(document.body.querySelector('.ledger-detail-sheet')).toBeNull()
  })

  it('restricts financial edits for an archived-account transaction to payee and note', async () => {
    const archivedExpense: LedgerTransactionDto = {
      ...expense,
      id: 'tx-archived-account',
      accountId: archivedAccount.id,
    }
    const wrapper = await mountView()
    const storePage: LedgerTransactionPageDto = { transactions: [archivedExpense], page: { nextCursor: null } }
    api.listLedgerTransactions.mockResolvedValue(storePage)
    await wrapper.get('[data-ledger-filter-type="expense"]').trigger('click')
    await wrapper.get('[data-testid="ledger-filters-form"]').trigger('submit')
    await flushPromises()
    await wrapper.get('[data-testid="ledger-transaction-row-tx-archived-account"]').trigger('click')
    await flushPromises()

    const detail = getDetail()
    await detail.findAll('button').find((button) => button.text() === '编辑交易')!.trigger('click')
    const editForm = getDetail().get('[data-testid="ledger-transaction-edit-form"]')
    expect(editForm.find('input[name="amount"]').exists()).toBe(false)
    await editForm.get('input[name="payee"]').setValue('归档前商户')
    await editForm.get('textarea[name="note"]').setValue('补充备注')
    await editForm.trigger('submit')
    await flushPromises()

    expect(api.patchLedgerTransaction).toHaveBeenCalledWith('tx-archived-account', {
      expectedVersion: 3,
      location: '',
      payee: '归档前商户',
      note: '补充备注',
    })
  })

  it('rechecks the authoritative Account before sending a financial edit', async () => {
    const wrapper = await mountView()
    await wrapper.find('[data-testid="ledger-transaction-row-tx-expense"]').trigger('click')
    await flushPromises()

    const detail = getDetail()
    await detail.findAll('button').find((button) => button.text() === '编辑交易')!.trigger('click')
    const editForm = getDetail().get('[data-testid="ledger-transaction-edit-form"]')
    await editForm.get('textarea[name="note"]').setValue('并发归档')
    api.getLedgerAccount.mockResolvedValueOnce(account('bank-1', '招商银行', 20))
    await editForm.trigger('submit')
    await flushPromises()

    expect(api.getLedgerAccount).toHaveBeenCalledWith('bank-1')
    expect(api.patchLedgerTransaction).not.toHaveBeenCalled()
    expect(getDetail().text()).toContain('请先恢复账户')
  })

  it('keeps a pending Category recovery visible when the route changes', async () => {
    const pending = createLedgerPendingIntent(
      'category',
      { kind: 'expense', name: '待确认分类' },
      'key-category-recovery',
      null,
    )
    sessionStorage.setItem(LEDGER_PENDING_CREATE_STORAGE_KEY, JSON.stringify(pending))
    resetLedgerStoreForTesting()
    setup()
    api.createLedgerCategory.mockResolvedValue(category('replayed-category', 'expense', '待确认分类'))
    const wrapper = await mountView('/ledger/transactions')

    expect(wrapper.find('[data-testid="ledger-recovery-gate"]').exists()).toBe(true)
    await wrapper.get('[data-testid="ledger-recovery"] button').trigger('click')
    await flushPromises()

    expect(api.createLedgerCategory).toHaveBeenCalledWith({ kind: 'expense', name: '待确认分类' }, 'key-category-recovery')
    expect(wrapper.find('[data-testid="ledger-recovery-gate"]').exists()).toBe(false)
  })

  it('keeps Adjustment read-only and soft-deletes ordinary transactions only after confirmation', async () => {
    const wrapper = await mountView()
    const rows = wrapper.findAll('.ledger-transaction-row')
    await rows.find((row) => row.text().includes('余额调整'))!.trigger('click')
    await flushPromises()
    let detail = getDetail()
    expect(detail.text()).toContain('余额调整为只读记录')
    expect(detail.text()).not.toContain('编辑交易')
    expect(detail.text()).not.toContain('删除记录')

    await detail.find('.ledger-close-button').trigger('click')
    await rows.find((row) => row.text().includes('午餐'))!.trigger('click')
    await flushPromises()
    detail = getDetail()
    await detail.findAll('button').find((button) => button.text() === '删除记录')!.trigger('click')
    await flushPromises()

    expect(confirm).toHaveBeenCalledWith(
      '删除这笔交易？',
      expect.any(String),
      expect.objectContaining({ destructive: true }),
    )
    expect(api.deleteLedgerTransaction).toHaveBeenCalledWith('tx-expense', 3)
    expect(document.body.querySelector('.ledger-detail-sheet')).toBeNull()
  })
})

// @vitest-environment jsdom
import { DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick, type VNodeChild } from 'vue'
import type { SelectOption } from 'naive-ui'
import type {
  LedgerAccountDto,
  LedgerCategoryDto,
  LedgerOverviewDto,
  LedgerSettingsDto,
  LedgerTransactionDto,
} from '../../../../shared/ledgerProtocol'
import { LedgerApiError } from '../../../features/ledger/ledgerErrors'
import { useConfirm } from '../../../composables/useConfirm'
import { useToast } from '../../../composables/useToast'
import { resetLedgerStoreForTesting } from '../../../features/ledger/ledgerStore'
import LedgerView from '../../../views/LedgerView.vue'
import LedgerDateTimePicker from '../LedgerDateTimePicker.vue'
import LedgerTransactionFormFields from '../LedgerTransactionFormFields.vue'
import { getNaiveSelect, naiveSelectValue, setNaiveSelect } from './selectTestUtils'

const api = vi.hoisted(() => ({
  getLedgerSettings: vi.fn(),
  listLedgerAccounts: vi.fn(),
  listLedgerCategories: vi.fn(),
  getLedgerOverview: vi.fn(),
  listLedgerTransactions: vi.fn(),
  createLedgerTransaction: vi.fn(),
  createLedgerCategory: vi.fn(),
}))

vi.mock('../../../features/ledger/api', () => api)

const settings: LedgerSettingsDto = {
  baseCurrency: 'CNY',
  currencyExponent: 2,
  timezone: 'Asia/Shanghai',
  hasCreatedAccount: true,
  version: 2,
  createdAt: 1,
  updatedAt: 2,
}

function account(id: string, name: string): LedgerAccountDto {
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
    archivedAt: null,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    currentBalanceMinor: 1_000_000,
  }
}

function category(id: string, kind: 'income' | 'expense', name: string, archivedAt: number | null = null): LedgerCategoryDto {
  return { id, kind, name, normalizedName: name.toLowerCase(), archivedAt, version: 1, createdAt: 1, updatedAt: 1 }
}

const expense = category('food', 'expense', '餐饮')
const income = category('salary', 'income', '工资')

const overview = (): LedgerOverviewDto => ({
  context: { anchorDate: '2026-09-05', todayDate: '2026-09-05', isToday: true, scope: 'month' },
  currency: 'CNY',
  currencyExponent: 2,
  assetTotalMinor: 2_000_000,
  liabilityTotalMinor: 0,
  netWorthMinor: 2_000_000,
  accounts: [],
  cashflow: { incomeMinor: 0, expenseMinor: 0, repaymentMinor: 0, balanceMinor: 0 },
  categoryBreakdown: { income: [], expense: [] },
  periods: [],
  trend: [],
  recentTransactions: [],
})

const savedTransaction = { id: 'tx-1', type: 'expense' } as unknown as LedgerTransactionDto
const wrappers: VueWrapper[] = []
let categories: LedgerCategoryDto[] = [expense, income, category('old', 'expense', '旧分类', 10)]

function setup(accounts: LedgerAccountDto[] = [account('bank-1', '招商银行'), account('wallet-1', '现金钱包')]): void {
  api.getLedgerSettings.mockResolvedValue(settings)
  api.listLedgerAccounts.mockResolvedValue(accounts)
  api.listLedgerCategories.mockImplementation(() => Promise.resolve(categories))
  api.getLedgerOverview.mockResolvedValue(overview())
  api.listLedgerTransactions.mockResolvedValue({ transactions: [], page: { nextCursor: null } })
}

async function openSheet(): Promise<VueWrapper> {
  const wrapper = mount(LedgerView)
  wrappers.push(wrapper)
  await flushPromises()
  await wrapper.get('[data-testid="ledger-record-button"]').trigger('click')
  await flushPromises()
  return wrapper
}

function getSheet(): InstanceType<typeof DOMWrapper> {
  const element = document.body.querySelector<HTMLElement>('.ledger-sheet')
  if (!element) throw new Error('transaction sheet is not mounted')
  return new DOMWrapper(element)
}

async function setLedgerDateTime(sheet: InstanceType<typeof DOMWrapper>, value: string): Promise<void> {
  const picker = sheet.findComponent(LedgerDateTimePicker)
  if (!picker.exists()) throw new Error('Ledger datetime picker is not mounted')
  await picker.vm.$emit('update:modelValue', value)
  await nextTick()
}

function ledgerDateTimeValue(sheet: InstanceType<typeof DOMWrapper>): string {
  return (sheet.get('[data-testid="ledger-transaction-occurred-at"] input').element as HTMLInputElement).value.replace(' ', 'T')
}

type OptionRenderer = (option: SelectOption, selected?: boolean) => VNodeChild

describe('Ledger transaction creation sheet', () => {
  beforeEach(() => {
    sessionStorage.clear()
    resetLedgerStoreForTesting()
    vi.clearAllMocks()
    categories = [expense, income, category('old', 'expense', '旧分类', 10)]
    setup()
  })

  afterEach(() => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount()
  })

  it('opens with Expense as the default and sends CNY decimal input as minor units', async () => {
    await openSheet()
    const sheet = getSheet()

    expect(sheet.get('[role="tab"][aria-selected="true"]').text()).toBe('支出')
    expect(ledgerDateTimeValue(sheet)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    expect(getNaiveSelect(sheet, '分类').props('placeholder')).toBe('请选择分类')
    expect(getNaiveSelect(sheet, '分类').props('options')).toEqual([{ value: 'food', label: '餐饮' }])

    await sheet.get('input[name="amount"]').setValue('38')
    await setNaiveSelect(sheet, '账户', 'bank-1')
    await setNaiveSelect(sheet, '分类', 'food')
    await setLedgerDateTime(sheet, '2026-09-05T12:30')
    await sheet.get('input[name="location"]').setValue('上海市静安区')
    api.createLedgerTransaction.mockResolvedValue(savedTransaction)
    await sheet.get('form').trigger('submit')
    await flushPromises()

    expect(api.createLedgerTransaction).toHaveBeenCalledWith(expect.objectContaining({
      type: 'expense',
      amountMinor: 3800,
      accountId: 'bank-1',
      categoryId: 'food',
      location: '上海市静安区',
      payee: '',
      note: '',
      occurredAt: expect.any(Number),
    }), expect.any(String))
    expect(document.body.querySelector('.ledger-sheet')).toBeNull()
  })

  it('keeps account and category renderers as stable option rows', async () => {
    await openSheet()
    const sheet = getSheet()
    const fields = sheet.findComponent(LedgerTransactionFormFields)
    const renderAccountLabel = fields.props('renderAccountLabel') as OptionRenderer | undefined
    const renderCategoryLabel = fields.props('renderCategoryLabel') as OptionRenderer | undefined
    if (!renderAccountLabel || !renderCategoryLabel) throw new Error('Ledger option renderers are not provided')

    const accountOption = mount({
      render: () => renderAccountLabel({
        value: 'bank-1',
        label: '招商银行 · ¥10,000.00',
        accountName: '招商银行',
        balanceLabel: '¥10,000.00',
      } as SelectOption, false),
    })
    const selectedAccount = mount({
      render: () => renderAccountLabel({
        value: 'bank-1',
        label: '招商银行 · ¥10,000.00',
        accountName: '招商银行',
        balanceLabel: '¥10,000.00',
      } as SelectOption, true),
    })
    const categoryOption = mount({
      render: () => renderCategoryLabel({ value: 'food', label: '餐饮' }),
    })
    wrappers.push(accountOption, selectedAccount, categoryOption)

    expect(accountOption.find('.ledger-account-select-option').exists()).toBe(true)
    expect(accountOption.find('.ledger-account-select-icon').exists()).toBe(true)
    expect(accountOption.find('.ledger-account-select-label').text()).toBe('招商银行')
    expect(accountOption.find('.ledger-account-select-balance').text()).toBe('¥10,000.00')
    expect(selectedAccount.find('.ledger-account-select-label').text()).toBe('招商银行')
    expect(selectedAccount.find('.ledger-account-select-balance').text()).toBe('¥10,000.00')
    expect(categoryOption.find('.ledger-category-select-option').exists()).toBe(true)
    expect(categoryOption.find('.ledger-category-select-icon').exists()).toBe(true)
    expect(categoryOption.find('.ledger-category-select-label').text()).toBe('餐饮')
    expect(categoryOption.find('.ledger-account-select-label').exists()).toBe(false)

    await setNaiveSelect(sheet, '账户', 'bank-1')
    await setNaiveSelect(sheet, '分类', 'food')
    expect(sheet.find('.ledger-account-select-label').text()).toContain('招商银行')
    expect(sheet.find('.n-base-selection-input__content .ledger-account-select-balance').exists()).toBe(true)
    expect(sheet.find('.ledger-category-select-label').text()).toContain('餐饮')
  })

  it('preselects the only active account', async () => {
    setup([account('only-bank', '唯一账户')])
    await openSheet()
    expect(naiveSelectValue(getSheet(), '账户')).toBe('only-bank')
  })

  it('does not guess an account when multiple active accounts are available', async () => {
    await openSheet()
    const sheet = getSheet()
    expect(naiveSelectValue(sheet, '账户')).toBe('')
    await sheet.get('input[name="amount"]').setValue('5')
    await setNaiveSelect(sheet, '分类', 'food')
    await setLedgerDateTime(sheet, '2026-09-05T12:30')
    await sheet.get('form').trigger('submit')
    expect(useToast().toasts.value.at(-1)?.message).toBe('请选择账户。')
    expect(sheet.text()).not.toContain('请选择账户。')
    expect(api.createLedgerTransaction).not.toHaveBeenCalled()
  })

  it('closes after confirming that a dirty draft should be discarded', async () => {
    await openSheet()
    const sheet = getSheet()
    await setNaiveSelect(sheet, '账户', 'bank-1')
    await sheet.get('[aria-label="关闭记账窗口"]').trigger('click')
    await flushPromises()

    const { queue, answer } = useConfirm()
    expect(queue.value).toHaveLength(1)
    answer(queue.value[0]!.id, true)
    await flushPromises()

    expect(document.body.querySelector('.ledger-sheet')).toBeNull()
  })

  it('switches to income and transfer with their applicable fields', async () => {
    const wrapper = await openSheet()
    const sheet = getSheet()

    await sheet.findAll('[role="tab"]').find((button) => button.text() === '收入')!.trigger('click')
    expect(getNaiveSelect(sheet, '分类').props('options')).toEqual([{ value: 'salary', label: '工资' }])
    expect(getNaiveSelect(sheet, '分类').props('placeholder')).toBe('请选择分类')
    await sheet.get('input[name="amount"]').setValue('12.50')
    await setNaiveSelect(sheet, '账户', 'bank-1')
    await setNaiveSelect(sheet, '分类', 'salary')
    await setLedgerDateTime(sheet, '2026-09-05T12:30')
    api.createLedgerTransaction.mockResolvedValue(savedTransaction)
    await sheet.get('form').trigger('submit')
    await flushPromises()

    expect(api.createLedgerTransaction).toHaveBeenCalledWith(expect.objectContaining({ type: 'income', amountMinor: 1250 }), expect.any(String))

    await wrapper.get('[data-testid="ledger-record-button"]').trigger('click')
    const transferSheet = getSheet()
    await transferSheet.findAll('[role="tab"]').find((button) => button.text() === '转账')!.trigger('click')
    expect(transferSheet.find('[aria-label="分类"]').exists()).toBe(false)
    expect(transferSheet.find('input[name="payee"]').exists()).toBe(false)
    expect(naiveSelectValue(transferSheet, '转出账户')).toBe('')
    expect(naiveSelectValue(transferSheet, '转入账户')).toBe('')
    await transferSheet.get('input[name="amount"]').setValue('5')
    await setNaiveSelect(transferSheet, '转出账户', 'bank-1')
    await setNaiveSelect(transferSheet, '转入账户', 'wallet-1')
    await setLedgerDateTime(transferSheet, '2026-09-05T12:30')
    api.createLedgerTransaction.mockResolvedValue({ id: 'tx-2', type: 'transfer' } as unknown as LedgerTransactionDto)
    await transferSheet.get('form').trigger('submit')
    await flushPromises()

    expect(api.createLedgerTransaction).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'transfer', transferKind: 'general', amountMinor: 500, fromAccountId: 'bank-1', toAccountId: 'wallet-1', payee: '',
    }), expect.any(String))
  })

  it('reveals a lightweight withdrawal fee mode picker only after a positive fee is entered', async () => {
    await openSheet()
    const sheet = getSheet()
    await sheet.findAll('[role="tab"]').find((button) => button.text() === '转账')!.trigger('click')
    await sheet.findAll('.n-radio-button').find((button) => button.text() === '提现')!.trigger('click')

    expect(sheet.find('[aria-label="选择手续费方式"]').exists()).toBe(false)
    await sheet.get('input[name="feeAmount"]').setValue('1')
    await nextTick()

    const feeModeTrigger = sheet.get('[aria-label="修改手续费方式：从提现金额中扣除"]')
    expect(feeModeTrigger.text()).toBe('从提现金额中扣除')
    await feeModeTrigger.trigger('click')
    await nextTick()

    const body = new DOMWrapper(document.body)
    const deductedOption = body.findAll('[role="radio"]').find((button) => button.text() === '从提现金额中扣除')
    expect(deductedOption).toBeDefined()
    await deductedOption!.trigger('click')
    await nextTick()

    expect(sheet.get('[aria-label="修改手续费方式：从提现金额中扣除"]').text()).toBe('从提现金额中扣除')
    await sheet.get('input[name="amount"]').setValue('100')
    expect(sheet.find('.ledger-amount-field').text()).toContain('实际到账 ¥99.00')
    await setNaiveSelect(sheet, '转出账户', 'bank-1')
    await setNaiveSelect(sheet, '转入账户', 'wallet-1')
    await setLedgerDateTime(sheet, '2026-09-05T12:30')
    api.createLedgerTransaction.mockResolvedValue({ id: 'withdrawal-1', type: 'transfer' } as unknown as LedgerTransactionDto)
    await sheet.get('form').trigger('submit')
    await flushPromises()

    expect(api.createLedgerTransaction).toHaveBeenCalledWith(expect.objectContaining({
      type: 'transfer',
      transferKind: 'withdrawal',
      amountMinor: 10_000,
      feeMinor: 100,
      feeMode: 'deducted',
    }), expect.any(String))
  })

  it('preserves only amount, time, and note across semantic type switches', async () => {
    await openSheet()
    const sheet = getSheet()
    await sheet.get('input[name="amount"]').setValue('12.50')
    await setNaiveSelect(sheet, '账户', 'bank-1')
    await setNaiveSelect(sheet, '分类', 'food')
    await setLedgerDateTime(sheet, '2026-09-05T12:30')
    await sheet.get('input[name="payee"]').setValue('午餐')
    await sheet.get('textarea[name="note"]').setValue('共同备注')

    await sheet.findAll('[role="tab"]').find((button) => button.text() === '收入')!.trigger('click')
    expect((sheet.get('input[name="amount"]').element as HTMLInputElement).value).toBe('12.50')
    expect(ledgerDateTimeValue(sheet)).toBe('2026-09-05T12:30')
    expect((sheet.get('textarea[name="note"]').element as HTMLTextAreaElement).value).toBe('共同备注')
    expect(naiveSelectValue(sheet, '账户')).toBe('')
    expect(naiveSelectValue(sheet, '分类')).toBe('')
    expect((sheet.get('input[name="payee"]').element as HTMLInputElement).value).toBe('')

    await sheet.findAll('[role="tab"]').find((button) => button.text() === '转账')!.trigger('click')
    expect((sheet.get('input[name="amount"]').element as HTMLInputElement).value).toBe('12.50')
    expect(ledgerDateTimeValue(sheet)).toBe('2026-09-05T12:30')
    expect((sheet.get('textarea[name="note"]').element as HTMLTextAreaElement).value).toBe('共同备注')
    expect(naiveSelectValue(sheet, '转出账户')).toBe('')
    expect(naiveSelectValue(sheet, '转入账户')).toBe('')
  })

  it('keeps category lifecycle in settings instead of offering inline quick-create', async () => {
    await openSheet()
    const sheet = getSheet()
    expect(sheet.text()).not.toContain('如需新增分类，请前往设置中的“交易分类”。')
    expect(sheet.findAll('button').some((button) => button.text() === '新建分类')).toBe(false)
    expect(sheet.find('[data-testid="ledger-category-quick-create"]').exists()).toBe(false)
    expect(api.createLedgerCategory).not.toHaveBeenCalled()
  })

  it('keeps the same idempotency key and readonly recovery surface after response loss', async () => {
    const wrapper = await openSheet()
    const sheet = getSheet()
    await sheet.get('input[name="amount"]').setValue('38')
    await setNaiveSelect(sheet, '账户', 'bank-1')
    await setNaiveSelect(sheet, '分类', 'food')
    await setLedgerDateTime(sheet, '2026-09-05T12:30')
    api.createLedgerTransaction.mockRejectedValueOnce(new LedgerApiError('unknown', 0, 'ledger-network-error', null, true))
    await sheet.get('form').trigger('submit')
    await flushPromises()
    await nextTick()

    expect(wrapper.find('[data-testid="ledger-recovery"]').exists()).toBe(true)
    expect(document.body.querySelector('input[name="amount"]')).toBeNull()
    const firstKey = api.createLedgerTransaction.mock.calls[0][1]
    api.createLedgerTransaction.mockResolvedValue(savedTransaction)
    await wrapper.get('[data-testid="ledger-recovery"] button').trigger('click')
    await flushPromises()
    await nextTick()

    expect(api.createLedgerTransaction.mock.calls[1][1]).toBe(firstKey)
    expect(sessionStorage.getItem('nuvyn.ledger.pending-create')).toBeNull()
    expect(document.body.querySelector('.ledger-sheet')).toBeNull()
  })

  it('treats a transfer to the same account as a user-correctable validation error', async () => {
    await openSheet()
    const sheet = getSheet()
    await sheet.findAll('[role="tab"]').find((button) => button.text() === '转账')!.trigger('click')
    await sheet.get('input[name="amount"]').setValue('5')
    await setNaiveSelect(sheet, '转出账户', 'bank-1')
    await setNaiveSelect(sheet, '转入账户', 'bank-1')
    await setLedgerDateTime(sheet, '2026-09-05T12:30')
    await sheet.get('form').trigger('submit')

    expect(useToast().toasts.value.at(-1)?.message).toBe('转出账户和转入账户必须不同。')
    expect(sheet.text()).not.toContain('转出账户和转入账户必须不同。')
    expect(api.createLedgerTransaction).not.toHaveBeenCalled()
  })
})

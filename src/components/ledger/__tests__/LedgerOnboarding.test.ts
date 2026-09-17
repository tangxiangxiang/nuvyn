// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LedgerApiError } from '../../../features/ledger/ledgerErrors'
import { resetLedgerStoreForTesting } from '../../../features/ledger/ledgerStore'
import { LEDGER_PENDING_CREATE_STORAGE_KEY, createLedgerPendingIntent } from '../../../features/ledger/recovery'
import type {
  LedgerAccountDto,
  LedgerOverviewDto,
  LedgerSettingsDto,
} from '../../../../shared/ledgerProtocol'
import LedgerView from '../../../views/LedgerView.vue'
import { setNaiveSelect } from './selectTestUtils'

const api = vi.hoisted(() => ({
  getLedgerSettings: vi.fn(),
  listLedgerAccounts: vi.fn(),
  listLedgerCategories: vi.fn(),
  getLedgerOverview: vi.fn(),
  listLedgerTransactions: vi.fn(),
  createLedgerSettings: vi.fn(),
  patchLedgerSettings: vi.fn(),
  createLedgerAccount: vi.fn(),
}))

vi.mock('../../../features/ledger/api', () => api)

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

function setupLoadedState(
  nextSettings: LedgerSettingsDto,
  nextAccounts: LedgerAccountDto[] = [],
): void {
  api.getLedgerSettings.mockResolvedValue(nextSettings)
  api.listLedgerAccounts.mockResolvedValue(nextAccounts)
  api.listLedgerCategories.mockResolvedValue([])
  api.getLedgerOverview.mockResolvedValue(overview())
  api.listLedgerTransactions.mockResolvedValue({ transactions: [], page: { nextCursor: null } })
}

function installBrowserApiShims(): void {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as typeof window.matchMedia
  }
  globalThis.matchMedia = window.matchMedia
  if (!HTMLElement.prototype.scrollTo) {
    HTMLElement.prototype.scrollTo = (() => undefined) as typeof HTMLElement.prototype.scrollTo
  }
}

describe('Ledger initialization and first-account onboarding', () => {
  beforeEach(() => {
    sessionStorage.clear()
    resetLedgerStoreForTesting()
    vi.clearAllMocks()
    installBrowserApiShims()
  })

  it('shows an explicit settings step when the Ledger is uninitialized', async () => {
    api.getLedgerSettings.mockRejectedValue(new LedgerApiError('missing', 404, 'ledger-not-found'))
    const wrapper = mount(LedgerView)

    await flushPromises()

    expect(wrapper.find('[data-testid="ledger-settings-form"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ledger-account-form"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('先设置你的 Ledger')
    expect(wrapper.text()).not.toContain('基础货币决定金额的表达方式')
  })

  it('requires an explicit currency and timezone confirmation before moving to the account step', async () => {
    api.getLedgerSettings
      .mockRejectedValueOnce(new LedgerApiError('missing', 404, 'ledger-not-found'))
      .mockResolvedValue(settings(false))
    api.listLedgerAccounts.mockResolvedValue([])
    api.listLedgerCategories.mockResolvedValue([])
    api.getLedgerOverview.mockResolvedValue(overview())
    api.listLedgerTransactions.mockResolvedValue({ transactions: [], page: { nextCursor: null } })
    const wrapper = mount(LedgerView)
    await flushPromises()

    const settingsForm = wrapper.get('[data-testid="ledger-settings-form"]')
    await setNaiveSelect(settingsForm, '基础货币', 'CNY')
    await settingsForm.get('input[name="timezone"]').setValue('Asia/Shanghai')

    api.getLedgerSettings.mockResolvedValue(settings(false))
    api.createLedgerSettings.mockResolvedValue(settings(false))
    await settingsForm.trigger('submit')
    await flushPromises()

    expect(api.createLedgerSettings).toHaveBeenCalledWith(
      { baseCurrency: 'CNY', timezone: 'Asia/Shanghai' },
      expect.any(String),
    )
    expect(wrapper.find('[data-testid="ledger-account-form"]').exists()).toBe(true)
  })

  it('creates the first account without requiring a card number', async () => {
    setupLoadedState(settings(false))
    const wrapper = mount(LedgerView)
    await flushPromises()

    const form = wrapper.get('[data-testid="ledger-account-form"]')
    await form.get('input[name="name"]').setValue('招商银行')
    await form.get('input[name="openingBalance"]').setValue('10000.00')
    await form.get('[data-testid="ledger-account-opening-date"] input').setValue('2026-09-05')

    api.createLedgerAccount.mockResolvedValue(account('bank-1'))
    api.getLedgerSettings.mockResolvedValue(settings(true))
    api.listLedgerAccounts.mockResolvedValue([account('bank-1')])
    await form.trigger('submit')
    await flushPromises()

    expect(api.createLedgerAccount).toHaveBeenCalledWith({
      name: '招商银行',
      type: 'bank',
      nature: 'asset',
      openingBalanceMinor: 1_000_000,
      openingDate: '2026-09-05',
      currency: 'CNY',
      note: '',
    }, expect.any(String))
    expect(wrapper.find('[data-testid="ledger-dashboard"]').exists()).toBe(true)
  })

  it('does not present a normal zero dashboard when initialized without an active account', async () => {
    setupLoadedState(settings(true), [account('archived-bank', 5)])
    const wrapper = mount(LedgerView)

    await flushPromises()

    expect(wrapper.find('[data-testid="ledger-no-active-account"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ledger-ready-placeholder"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('恢复账户')
    expect(wrapper.text()).toContain('创建新账户')
  })

  it('keeps initialized settings locked after the account marker is true', async () => {
    setupLoadedState(settings(true), [account('bank-1')])
    const wrapper = mount(LedgerView)

    await flushPromises()

    expect(wrapper.find('[data-testid="ledger-settings-form"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="ledger-dashboard"]').exists()).toBe(true)
  })

  it('supports Step 2 back-edit of settings and uses the updated values for the first account', async () => {
    const initialSettings = settings(false)
    const editedSettings: LedgerSettingsDto = {
      ...initialSettings,
      baseCurrency: 'JPY',
      currencyExponent: 0,
      timezone: 'Asia/Tokyo',
      version: 2,
    }
    const lockedSettings: LedgerSettingsDto = { ...editedSettings, hasCreatedAccount: true, version: 3 }
    api.getLedgerSettings
      .mockRejectedValueOnce(new LedgerApiError('missing', 404, 'ledger-not-found'))
      .mockResolvedValue(initialSettings)
    api.listLedgerAccounts.mockResolvedValue([])
    api.listLedgerCategories.mockResolvedValue([])
    api.getLedgerOverview.mockResolvedValue(overview())
    api.listLedgerTransactions.mockResolvedValue({ transactions: [], page: { nextCursor: null } })
    api.createLedgerSettings.mockResolvedValue(initialSettings)
    api.patchLedgerSettings.mockResolvedValue(editedSettings)

    const wrapper = mount(LedgerView)
    await flushPromises()
    const settingsForm = wrapper.get('[data-testid="ledger-settings-form"]')
    await setNaiveSelect(settingsForm, '基础货币', 'CNY')
    await settingsForm.get('input[name="timezone"]').setValue('Asia/Shanghai')
    await settingsForm.trigger('submit')
    await flushPromises()

    const firstAccount = wrapper.get('[data-testid="ledger-account-form"]')
    expect(firstAccount.find('button').text()).toContain('修改 Ledger 设置')
    await firstAccount.findAll('button').find((button) => button.text() === '修改 Ledger 设置')!.trigger('click')

    const editSettingsForm = wrapper.get('[data-testid="ledger-settings-form"]')
    await setNaiveSelect(editSettingsForm, '基础货币', 'JPY')
    await editSettingsForm.get('input[name="timezone"]').setValue('Asia/Tokyo')
    api.getLedgerSettings.mockResolvedValue(editedSettings)
    await editSettingsForm.trigger('submit')
    await flushPromises()

    expect(api.patchLedgerSettings).toHaveBeenCalledWith({
      expectedVersion: 1,
      baseCurrency: 'JPY',
      timezone: 'Asia/Tokyo',
    })
    const editedAccountForm = wrapper.get('[data-testid="ledger-account-form"]')
    expect(editedAccountForm.text()).toContain('JPY')
    await editedAccountForm.get('input[name="cardNumber"]').setValue('6222021234567890')
    await editedAccountForm.get('input[name="name"]').setValue('东京账户')
    await editedAccountForm.get('input[name="openingBalance"]').setValue('38')
    api.createLedgerAccount.mockResolvedValue({
      ...account('jpy-1'),
      currency: 'JPY',
      currencyExponent: 0,
      openingBalanceMinor: 38,
      currentBalanceMinor: 38,
    })
    api.getLedgerSettings.mockResolvedValue(lockedSettings)
    api.listLedgerAccounts.mockResolvedValue([{
      ...account('jpy-1'),
      currency: 'JPY',
      currencyExponent: 0,
      openingBalanceMinor: 38,
      currentBalanceMinor: 38,
    }])
    await editedAccountForm.trigger('submit')
    await flushPromises()

    expect(api.createLedgerAccount).toHaveBeenCalledWith(expect.objectContaining({
      name: '东京账户',
      currency: 'JPY',
      openingBalanceMinor: 38,
    }), expect.any(String))
    expect(wrapper.find('[data-testid="ledger-dashboard"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ledger-settings-form"]').exists()).toBe(false)
  })

  it('keeps an Account create recovery gate visible after reload even when bootstrap is READY', async () => {
    const pending = createLedgerPendingIntent(
      'account',
      {
        name: '待确认账户',
        type: 'bank',
        nature: 'asset',
        openingBalanceMinor: 1000,
        openingDate: '2026-09-05',
        currency: 'CNY',
        note: '',
        cardNumber: '6222021234567890',
      },
      'key-account-recovery',
      null,
    )
    sessionStorage.setItem(LEDGER_PENDING_CREATE_STORAGE_KEY, JSON.stringify(pending))
    resetLedgerStoreForTesting()
    setupLoadedState(settings(true), [account('existing-bank')])
    api.createLedgerAccount.mockResolvedValue(account('replayed-account'))
    const wrapper = mount(LedgerView)
    await flushPromises()

    expect(wrapper.find('[data-testid="ledger-recovery-gate"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ledger-recovery"]').text()).toContain('上一次账户保存结果未知')
    await wrapper.get('[data-testid="ledger-recovery"] button').trigger('click')
    await flushPromises()

    expect(api.createLedgerAccount).toHaveBeenCalledWith(expect.objectContaining({ name: '待确认账户' }), 'key-account-recovery')
    expect(wrapper.find('[data-testid="ledger-recovery-gate"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="ledger-dashboard"]').exists()).toBe(true)
  })
})

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LedgerAccountDto, LedgerCategoryDto, LedgerSettingsDto, LedgerTransactionDto } from '../../../../shared/ledgerProtocol'
import { downloadLedgerAnalysisExport, loadLedgerAnalysisExport } from '../ledgerAnalysisExport'

const api = vi.hoisted(() => ({
  getLedgerSettings: vi.fn(),
  listLedgerAccounts: vi.fn(),
  listLedgerCategories: vi.fn(),
  listLedgerTransactions: vi.fn(),
}))
vi.mock('../api', () => api)

const settings: LedgerSettingsDto = {
  baseCurrency: 'CNY', currencyExponent: 2, timezone: 'Asia/Shanghai',
  hasCreatedAccount: true, version: 1, createdAt: 1, updatedAt: 1,
}
const account: LedgerAccountDto = {
  id: 'bank', name: '银行账户', type: 'bank', nature: 'asset',
  openingBalanceMinor: 100_000, openingDate: '2026-01-01', currentBalanceMinor: 80_001,
  currency: 'CNY', currencyExponent: 2, note: '应急储蓄', archivedAt: null,
  icon: 'building_bank', cardNumber: '12345678', version: 1, createdAt: 1, updatedAt: 1,
}
const archivedAccount: LedgerAccountDto = {
  ...account, id: 'loan', name: '旧贷款', type: 'loan', nature: 'liability',
  currentBalanceMinor: Number.MAX_SAFE_INTEGER, archivedAt: 2,
}
const category: LedgerCategoryDto = {
  id: 'food', name: '餐饮', kind: 'expense', normalizedName: '餐饮',
  archivedAt: 2, version: 1, createdAt: 1, updatedAt: 1,
}
const transactionBase = {
  excludedFromStatistics: false, amountMinor: 1, occurredAt: 1_700_000_000_000,
  location: '上海', note: '保留小额', deletedAt: null, version: 1, createdAt: 1, updatedAt: 1,
}
const transactions: LedgerTransactionDto[] = [
  { ...transactionBase, id: 'income', type: 'income', accountId: 'bank', categoryId: 'salary', payee: '公司' },
  { ...transactionBase, id: 'expense', type: 'expense', accountId: 'bank', categoryId: 'food', payee: '午餐', excludedFromStatistics: true },
  { ...transactionBase, id: 'transfer', type: 'transfer', transferKind: 'general', fromAccountId: 'bank', toAccountId: 'loan', payee: '' },
  {
    ...transactionBase, id: 'repayment', type: 'transfer', transferKind: 'repayment',
    fromAccountId: 'bank', toAccountId: 'loan', groupId: 'repayment-group', payee: '旧贷款',
    excludedFromStatistics: true, bundle: { chargeMinor: 2, totalMinor: 3 },
  },
  {
    ...transactionBase, id: 'fee', type: 'expense', accountId: 'bank', categoryId: 'food',
    groupId: 'repayment-group', payee: '还款利息', amountMinor: 2,
  },
  {
    ...transactionBase, id: 'withdrawal', type: 'transfer', transferKind: 'withdrawal',
    fromAccountId: 'bank', toAccountId: 'loan', feeMode: 'deducted', payee: '',
  },
  {
    ...transactionBase, id: 'adjustment', type: 'adjustment', accountId: 'bank', amountMinor: -99,
    adjustmentCalculatedBalanceMinor: 100, adjustmentTargetBalanceMinor: 1,
  },
  { ...transactionBase, id: 'deleted', type: 'expense', accountId: 'loan', categoryId: 'food', payee: '旧交易', deletedAt: 3 },
]
const activeTransactions = transactions.filter(({ deletedAt }) => deletedAt === null)

beforeEach(() => {
  vi.resetAllMocks()
  api.getLedgerSettings.mockResolvedValue(settings)
  api.listLedgerAccounts.mockResolvedValue([account, archivedAccount])
  api.listLedgerCategories.mockResolvedValue([category, { ...category, id: 'salary', name: '工资', kind: 'income' }])
  api.listLedgerTransactions.mockResolvedValue({ transactions, page: { nextCursor: null, total: transactions.length } })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Ledger analysis data export', () => {
  it('exports only the two core collections, using fresh reads including archived accounts and categories', async () => {
    const data = await loadLedgerAnalysisExport()

    expect(Object.keys(data)).toEqual(['version', 'exportedAt', 'currency', 'timezone', 'accounts', 'transactions'])
    expect(data).toMatchObject({ version: 1, currency: 'CNY', timezone: 'Asia/Shanghai' })
    expect(new Date(data.exportedAt).toISOString()).toBe(data.exportedAt)
    expect(api.getLedgerSettings).toHaveBeenCalledOnce()
    expect(api.listLedgerAccounts).toHaveBeenCalledWith(true)
    expect(api.listLedgerCategories).toHaveBeenCalledWith(undefined, true)
    expect(data.accounts).toEqual([
      {
        id: 'bank', name: '银行账户', type: 'bank', nature: 'asset', openingBalanceMinor: 100_000,
        openingDate: '2026-01-01', currentBalanceMinor: 80_001, currency: 'CNY', currencyExponent: 2,
        note: '应急储蓄', archivedAt: null,
      },
      expect.objectContaining({ id: 'loan', nature: 'liability', archivedAt: 2, currentBalanceMinor: Number.MAX_SAFE_INTEGER }),
    ])
    expect(data.accounts[0]).not.toHaveProperty('cardNumber')
    expect(data.accounts[0]).not.toHaveProperty('icon')
  })

  it('preserves every active transaction type, exact minor amounts, exclusions and companion expenses', async () => {
    const data = await loadLedgerAnalysisExport()

    expect(data.transactions.map(({ id }) => id)).toEqual(activeTransactions.map(({ id }) => id))
    for (const original of activeTransactions) {
      const exported = data.transactions.find(({ id }) => id === original.id)!
      const raw = original.type === 'transfer'
        ? (({ bundle: _bundle, ...principal }) => principal)(original)
        : original
      expect(exported).toMatchObject(raw)
      expect(exported).not.toHaveProperty('bundle')
    }
    expect(data.transactions.find(({ id }) => id === 'repayment')).toMatchObject({
      type: 'transfer', transferKind: 'repayment', excludedFromStatistics: true,
      fromAccountId: 'bank', fromAccountName: '银行账户', toAccountId: 'loan', toAccountName: '旧贷款',
    })
    expect(data.transactions.find(({ id }) => id === 'expense')).toMatchObject({
      categoryId: 'food', categoryName: '餐饮', accountId: 'bank', accountName: '银行账户',
    })
    expect(data.transactions.find(({ id }) => id === 'income')).toMatchObject({ categoryName: '工资' })
    expect(data.transactions.find(({ id }) => id === 'deleted')).toBeUndefined()
    expect(data.transactions.every(({ deletedAt }) => deletedAt === null)).toBe(true)
  })

  it.each([
    ...activeTransactions,
    { ...transactions[1]!, id: 'ordinary-expense', excludedFromStatistics: false },
  ])('exports active $id rows but excludes their soft-deleted counterparts', async (transaction) => {
    const deleted = { ...transaction, id: `deleted-${transaction.id}`, deletedAt: 3 }
    api.listLedgerTransactions.mockResolvedValue({ transactions: [deleted, transaction], page: { nextCursor: null, total: 2 } })

    const data = await loadLedgerAnalysisExport()

    expect(data.transactions).toHaveLength(1)
    expect(data.transactions[0]).toMatchObject({ id: transaction.id, type: transaction.type, deletedAt: null })
  })

  it('excludes a deletion timestamp of zero rather than treating it as active', async () => {
    const deleted = { ...transactions[0]!, deletedAt: 0 }
    api.listLedgerTransactions.mockResolvedValue({ transactions: [deleted], page: { nextCursor: null, total: 1 } })

    const data = await loadLedgerAnalysisExport()

    expect(data.transactions).toEqual([])
    expect(data.accounts).toHaveLength(2)
  })

  it('walks all cursor pages even when the first page contains only deleted rows', async () => {
    api.listLedgerTransactions
      .mockResolvedValueOnce({ transactions: [transactions[7]!], page: { nextCursor: 'second-page', total: 8, incomeMinor: 999 } })
      .mockResolvedValueOnce({ transactions: activeTransactions.slice(0, 3), page: { nextCursor: 'third-page', total: 8 } })
      .mockResolvedValueOnce({ transactions: activeTransactions.slice(3), page: { nextCursor: null, total: 8 } })

    const data = await loadLedgerAnalysisExport()

    expect(api.listLedgerTransactions.mock.calls).toEqual([
      [{ limit: 200, includeDeleted: true }],
      [{ limit: 200, includeDeleted: true, cursor: 'second-page' }],
      [{ limit: 200, includeDeleted: true, cursor: 'third-page' }],
    ])
    expect(data.transactions.map(({ id }) => id)).toEqual(activeTransactions.map(({ id }) => id))
    expect(data.transactions.every(({ deletedAt }) => deletedAt === null)).toBe(true)
    expect(data).not.toHaveProperty('incomeMinor')
  })

  it('keeps active account movements consistent with the current balance without counting deleted expenses', async () => {
    const income = { ...transactions[0]!, amountMinor: 1_250 }
    const expense = { ...transactions[1]!, amountMinor: 275 }
    const deleted = { ...transactions[7]!, accountId: 'bank', amountMinor: 90_000 }
    api.listLedgerAccounts.mockResolvedValue([{ ...account, currentBalanceMinor: 100_975 }])
    api.listLedgerTransactions.mockResolvedValue({ transactions: [income, expense, deleted], page: { nextCursor: null, total: 3 } })

    const data = await loadLedgerAnalysisExport()
    const exportedAccount = data.accounts[0]!
    const balanceMinor = data.transactions.reduce((balance, transaction) => {
      if (transaction.type === 'income') return balance + transaction.amountMinor
      if (transaction.type === 'expense') return balance - transaction.amountMinor
      throw new Error('Unexpected transaction type in the balance fixture')
    }, exportedAccount.openingBalanceMinor)

    expect(balanceMinor).toBe(exportedAccount.currentBalanceMinor)
    expect(data.transactions).toHaveLength(2)
  })

  it('keeps IDs with null readable names if a referenced name is unavailable', async () => {
    api.listLedgerAccounts.mockResolvedValue([])
    api.listLedgerCategories.mockResolvedValue([])
    const data = await loadLedgerAnalysisExport()
    expect(data.transactions[0]).toMatchObject({ accountId: 'bank', accountName: null, categoryId: 'salary', categoryName: null })
    expect(data.transactions.find(({ id }) => id === 'repayment')).toMatchObject({ fromAccountName: null, toAccountName: null })
  })

  it('rejects a failed later page instead of returning a partial export', async () => {
    api.listLedgerTransactions
      .mockResolvedValueOnce({ transactions: transactions.slice(0, 2), page: { nextCursor: 'next', total: 8 } })
      .mockRejectedValueOnce(new Error('network failed'))
    await expect(loadLedgerAnalysisExport()).rejects.toThrow('network failed')
  })

  it('rejects repeated cursors rather than looping forever', async () => {
    api.listLedgerTransactions.mockResolvedValue({ transactions: [], page: { nextCursor: 'same' } })
    await expect(loadLedgerAnalysisExport()).rejects.toThrow('invalid transaction cursor')
    expect(api.listLedgerTransactions).toHaveBeenCalledTimes(2)
  })

  it.each([
    { transactions, page: { nextCursor: null, total: 9 } },
    { transactions: [transactions[0], transactions[0]], page: { nextCursor: null, total: 2 } },
    { transactions: [transactions[7], transactions[7]], page: { nextCursor: null, total: 2 } },
  ])('rejects incomplete or duplicate history before filtering deleted rows', async (page) => {
    api.listLedgerTransactions.mockResolvedValue(page)
    await expect(loadLedgerAnalysisExport()).rejects.toThrow('complete transaction history')
  })

  it('requires initialized Ledger settings', async () => {
    api.getLedgerSettings.mockResolvedValue(null)
    await expect(loadLedgerAnalysisExport()).rejects.toThrow('initialized settings')
    expect(api.listLedgerTransactions).not.toHaveBeenCalled()
  })
})

describe('Ledger analysis JSON download', () => {
  it.each([
    ['Asia/Shanghai', '2026-10-02'],
    ['Pacific/Honolulu', '2026-10-01'],
  ])('uses the Ledger date in %s, readable UTF-8 JSON, and cleans up the download', async (timezone, date) => {
    const data = { ...await loadLedgerAnalysisExport(), exportedAt: '2026-10-01T16:30:00.000Z', timezone }
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:ledger-analysis')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe(`nuvyn-ledger-${date}.json`)
      expect(this.href).toBe('blob:ledger-analysis')
      expect(this.isConnected).toBe(true)
      expect(this.hidden).toBe(true)
    })

    downloadLedgerAnalysisExport(data)

    expect(click).toHaveBeenCalledOnce()
    const blob = createObjectURL.mock.calls[0]![0] as Blob
    expect(blob.type).toBe('application/json')
    const json = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = () => reject(reader.error)
      reader.readAsText(blob, 'utf-8')
    })
    expect(json).toBe(JSON.stringify(data, null, 2))
    expect(json).toContain('餐饮')
    expect(json).not.toMatch(/^\uFEFF/)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:ledger-analysis')
    expect(document.querySelector('a[download]')).toBeNull()
  })

  it('removes the anchor and revokes the URL even if the browser download throws', async () => {
    const data = await loadLedgerAnalysisExport()
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:failed'), revokeObjectURL })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => { throw new Error('download failed') })

    expect(() => downloadLedgerAnalysisExport(data)).toThrow('download failed')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:failed')
    expect(document.querySelector('a[download]')).toBeNull()
  })
})

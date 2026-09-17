import { describe, expect, it } from 'vitest'
import type {
  AdjustmentTransaction,
  ExpenseTransaction,
  IncomeTransaction,
  LedgerAccount,
  LedgerTransaction,
  LedgerTransactionRow,
  TransferTransaction,
} from './domain.js'
import {
  isLedgerAccountTypeNature,
  ledgerAccountFromRow,
  ledgerCategoryFromRow,
  ledgerSettingsFromRow,
  ledgerTransactionFromRow,
} from './domain.js'
import {
  deriveCurrentBalance,
  transactionEffectForAccount,
} from './balance.js'
import { LedgerError } from './errors.js'
import { MAX_SAFE_MINOR } from './money.js'

const COMMON_ROW = {
  id: 'transaction-1',
  transfer_kind: null,
  amount_minor: 100,
  occurred_at: 2_000,
  payee: '',
  note: '',
  deleted_at: null,
  version: 1,
  created_at: 2_000,
  updated_at: 2_000,
} satisfies Omit<LedgerTransactionRow, 'type'>

function incomeRow(overrides: Record<string, unknown> = {}): LedgerTransactionRow {
  return {
    ...COMMON_ROW,
    type: 'income',
    account_id: 'account-1',
    from_account_id: null,
    to_account_id: null,
    category_id: 'income-category',
    adjustment_calculated_balance_minor: null,
    adjustment_target_balance_minor: null,
    ...overrides,
  }
}

function transferRow(overrides: Record<string, unknown> = {}): LedgerTransactionRow {
  return {
    ...COMMON_ROW,
    type: 'transfer',
    transfer_kind: 'general',
    account_id: null,
    from_account_id: 'account-1',
    to_account_id: 'account-2',
    category_id: null,
    payee: '',
    adjustment_calculated_balance_minor: null,
    adjustment_target_balance_minor: null,
    ...overrides,
  }
}

function adjustmentRow(overrides: Record<string, unknown> = {}): LedgerTransactionRow {
  return {
    ...COMMON_ROW,
    type: 'adjustment',
    amount_minor: 200,
    account_id: 'account-1',
    from_account_id: null,
    to_account_id: null,
    category_id: null,
    payee: '',
    adjustment_calculated_balance_minor: 1_000,
    adjustment_target_balance_minor: 1_200,
    ...overrides,
  }
}

function account(
  id: string,
  nature: LedgerAccount['nature'],
  openingBalanceMinor = 0,
): LedgerAccount {
  return {
    id,
    name: id,
    type: nature === 'asset' ? 'bank' : 'loan',
    nature,
    openingBalanceMinor,
    openingDate: '2026-01-01',
    currency: 'CNY',
    note: '',
    archivedAt: null,
    version: 1,
    createdAt: 1_000,
    updatedAt: 1_000,
  }
}

function income(
  id: string,
  accountId: string,
  amountMinor = 100,
  deletedAt: number | null = null,
): IncomeTransaction {
  return {
    id,
    type: 'income',
    amountMinor,
    accountId,
    categoryId: 'income-category',
    occurredAt: 2_000,
    payee: '',
    note: '',
    deletedAt,
    version: 1,
    createdAt: 2_000,
    updatedAt: 2_000,
  }
}

function expense(
  id: string,
  accountId: string,
  amountMinor = 100,
  deletedAt: number | null = null,
): ExpenseTransaction {
  return {
    id,
    type: 'expense',
    amountMinor,
    accountId,
    categoryId: 'expense-category',
    occurredAt: 2_000,
    payee: '',
    note: '',
    deletedAt,
    version: 1,
    createdAt: 2_000,
    updatedAt: 2_000,
  }
}

function transfer(
  id: string,
  fromAccountId: string,
  toAccountId: string,
  amountMinor = 100,
  deletedAt: number | null = null,
): TransferTransaction {
  return {
    id,
    type: 'transfer',
    transferKind: 'general',
    amountMinor,
    fromAccountId,
    toAccountId,
    occurredAt: 2_000,
    payee: '',
    note: '',
    deletedAt,
    version: 1,
    createdAt: 2_000,
    updatedAt: 2_000,
  }
}

function adjustment(
  id: string,
  accountId: string,
  calculated: number,
  target: number,
  deletedAt: number | null = null,
): AdjustmentTransaction {
  return {
    id,
    type: 'adjustment',
    amountMinor: target - calculated,
    accountId,
    adjustmentCalculatedBalanceMinor: calculated,
    adjustmentTargetBalanceMinor: target,
    occurredAt: 2_000,
    note: '',
    deletedAt,
    version: 1,
    createdAt: 2_000,
    updatedAt: 2_000,
  }
}

function expectLedgerErrorCode(callback: () => unknown, code: LedgerError['code']): void {
  try {
    callback()
  } catch (error) {
    expect(error).toBeInstanceOf(LedgerError)
    expect((error as LedgerError).code).toBe(code)
    return
  }
  throw new Error(`Expected LedgerError ${code}`)
}

describe('Ledger domain row conversion', () => {
  it('converts nullable transaction columns into clean discriminated forms', () => {
    expect(ledgerTransactionFromRow(incomeRow())).toEqual({
      id: 'transaction-1',
      type: 'income',
      amountMinor: 100,
      accountId: 'account-1',
      categoryId: 'income-category',
      occurredAt: 2_000,
      location: '',
      payee: '',
      note: '',
      deletedAt: null,
      version: 1,
      createdAt: 2_000,
      updatedAt: 2_000,
    })
    expect(ledgerTransactionFromRow(incomeRow({
      type: 'expense',
      category_id: 'expense-category',
    }))).toMatchObject({
      type: 'expense',
      accountId: 'account-1',
      categoryId: 'expense-category',
      amountMinor: 100,
    })
    expect(ledgerTransactionFromRow(transferRow())).toEqual({
      id: 'transaction-1',
      type: 'transfer',
      transferKind: 'general',
      amountMinor: 100,
      fromAccountId: 'account-1',
      toAccountId: 'account-2',
      occurredAt: 2_000,
      location: '',
      payee: '',
      note: '',
      deletedAt: null,
      version: 1,
      createdAt: 2_000,
      updatedAt: 2_000,
    })
    expect(ledgerTransactionFromRow(adjustmentRow())).toMatchObject({
      type: 'adjustment',
      amountMinor: 200,
      accountId: 'account-1',
      adjustmentCalculatedBalanceMinor: 1_000,
      adjustmentTargetBalanceMinor: 1_200,
    })
  })

  it('converts settings/accounts/categories and centralizes account type/nature rules', () => {
    expect(isLedgerAccountTypeNature('cash', 'asset')).toBe(true)
    expect(isLedgerAccountTypeNature('credit_card', 'liability')).toBe(true)
    expect(isLedgerAccountTypeNature('other', 'asset')).toBe(true)
    expect(isLedgerAccountTypeNature('other', 'liability')).toBe(true)
    expect(isLedgerAccountTypeNature('cash', 'liability')).toBe(false)

    expect(ledgerSettingsFromRow({
      singleton_id: 1,
      base_currency: 'CNY',
      timezone: 'Asia/Shanghai',
      has_created_account: 1,
      version: 1,
      created_at: 1_000,
      updated_at: 1_000,
    })).toMatchObject({
      baseCurrency: 'CNY',
      timezone: 'Asia/Shanghai',
      hasCreatedAccount: true,
    })
    expect(ledgerAccountFromRow({
      id: 'account-1',
      name: 'Bank',
      type: 'bank',
      nature: 'asset',
      opening_balance_minor: 0,
      opening_date: '2026-01-01',
      currency: 'CNY',
      note: '',
      archived_at: null,
      version: 1,
      created_at: 1_000,
      updated_at: 1_000,
    })).toMatchObject({ id: 'account-1', nature: 'asset' })
    expect(ledgerCategoryFromRow({
      id: 'category-1',
      kind: 'expense',
      name: '餐饮',
      normalized_name: '餐饮',
      archived_at: null,
      version: 1,
      created_at: 1_000,
      updated_at: 1_000,
    })).toMatchObject({ id: 'category-1', normalizedName: '餐饮' })
  })

  it.each([
    ['wrong discriminator', incomeRow({ type: 'unknown' })],
    ['income missing account', incomeRow({ account_id: null })],
    ['income missing category', incomeRow({ category_id: null })],
    ['income with transfer columns', incomeRow({ from_account_id: 'account-2' })],
    ['transfer same account', transferRow({ to_account_id: 'account-1' })],
    ['transfer carrying category', transferRow({ category_id: 'category-1' })],
    ['adjustment missing calculated', adjustmentRow({ adjustment_calculated_balance_minor: null })],
    ['adjustment missing target', adjustmentRow({ adjustment_target_balance_minor: null })],
    ['adjustment wrong delta', adjustmentRow({ amount_minor: 199 })],
    ['non-positive amount', incomeRow({ amount_minor: 0 })],
    ['unsafe integer', incomeRow({ amount_minor: MAX_SAFE_MINOR + 1 })],
    ['invalid version', incomeRow({ version: 0 })],
    ['invalid timestamp', incomeRow({ occurred_at: 1.5 })],
    ['invalid account pairing', {
      id: 'account-1',
      name: 'Cash',
      type: 'cash',
      nature: 'liability',
      opening_balance_minor: 0,
      opening_date: '2026-01-01',
      currency: 'CNY',
      note: '',
      archived_at: null,
      version: 1,
      created_at: 1_000,
      updated_at: 1_000,
    }],
  ])('fails closed for %s persisted corruption', (_label, row) => {
    expect(() => (
      _label === 'invalid account pairing'
        ? ledgerAccountFromRow(row)
        : ledgerTransactionFromRow(row)
    )).toThrow(LedgerError)
  })

  it('rejects adjustment delta arithmetic that would leave the safe integer range', () => {
    expectLedgerErrorCode(() => ledgerTransactionFromRow(adjustmentRow({
      amount_minor: MAX_SAFE_MINOR,
      adjustment_calculated_balance_minor: -1,
      adjustment_target_balance_minor: MAX_SAFE_MINOR,
    })), 'ledger-money-overflow')
  })
})

describe('Ledger natural-balance transaction effects', () => {
  it.each([
    ['asset income', 'asset', income('income-asset', 'asset'), 100],
    ['liability income', 'liability', income('income-liability', 'liability'), -100],
    ['asset expense', 'asset', expense('expense-asset', 'asset'), -100],
    ['liability expense', 'liability', expense('expense-liability', 'liability'), 100],
  ] as const)('%s has the accepted signed effect', (_label, nature, transaction, expected) => {
    expect(transactionEffectForAccount(transaction, account(nature, nature))).toBe(expected)
  })

  it.each([
    ['asset → asset', 'asset', 'asset', -100, 100],
    ['asset → liability', 'asset', 'liability', -100, -100],
    ['liability → asset', 'liability', 'asset', 100, 100],
    ['liability → liability', 'liability', 'liability', 100, -100],
  ] as const)('%s has distinct outgoing/incoming effects and ignores unrelated accounts', (
    _label,
    fromNature,
    toNature,
    expectedFrom,
    expectedTo,
  ) => {
    const transaction = transfer('transfer-1', 'from', 'to')
    expect(transactionEffectForAccount(transaction, account('from', fromNature))).toBe(expectedFrom)
    expect(transactionEffectForAccount(transaction, account('to', toNature))).toBe(expectedTo)
    expect(transactionEffectForAccount(transaction, account('unrelated', 'asset'))).toBe(0)
  })

  it.each([
    ['asset positive', 'asset', 1_000, 1_200, 200],
    ['asset negative', 'asset', 1_000, 800, -200],
    ['liability positive', 'liability', 1_000, 1_200, 200],
    ['liability negative', 'liability', 1_000, 800, -200],
  ] as const)('%s adjustment applies its signed delta directly', (
    _label,
    nature,
    calculated,
    target,
    expected,
  ) => {
    expect(transactionEffectForAccount(
      adjustment('adjustment-1', 'account', calculated, target),
      account('account', nature),
    )).toBe(expected)
  })

  it('rejects a mismatched in-memory adjustment delta at the balance boundary', () => {
    const malformed: AdjustmentTransaction = {
      ...adjustment('mismatched-adjustment', 'account', 1_000, 1_200),
      amountMinor: 500,
    }

    expectLedgerErrorCode(
      () => transactionEffectForAccount(malformed, account('account', 'asset')),
      'ledger-validation-failed',
    )
  })

  it('rejects in-memory adjustment subtraction overflow with checked arithmetic', () => {
    const malformed: AdjustmentTransaction = {
      ...adjustment('overflow-adjustment', 'account', 0, 1),
      amountMinor: MAX_SAFE_MINOR,
      adjustmentCalculatedBalanceMinor: -1,
      adjustmentTargetBalanceMinor: MAX_SAFE_MINOR,
    }

    expectLedgerErrorCode(
      () => transactionEffectForAccount(malformed, account('account', 'asset')),
      'ledger-money-overflow',
    )
  })
})

describe('Ledger current-balance derivation', () => {
  it.each([
    ['opening only', account('asset', 'asset', 500), [], 500],
    ['opening plus one transaction', account('asset', 'asset', 500), [income('income', 'asset', 200)], 700],
    [
      'mixed records',
      account('asset', 'asset', 500),
      [income('income', 'asset', 200), expense('expense', 'asset', 50), transfer('transfer', 'asset', 'other', 100)],
      550,
    ],
    ['signed opening balance', account('asset', 'asset', -500), [income('income', 'asset', 100)], -400],
    ['negative final asset balance', account('asset', 'asset', 50), [expense('expense', 'asset', 100)], -50],
    ['negative final liability balance', account('liability', 'liability', 50), [income('income', 'liability', 100)], -50],
  ] as const)('%s derives the signed current balance', (_label, candidate, transactions, expected) => {
    expect(deriveCurrentBalance(candidate, transactions)).toBe(expected)
  })

  it('excludes every deleted transaction type at the engine boundary', () => {
    const candidate = account('account', 'asset', 500)
    const deleted: LedgerTransaction[] = [
      income('deleted-income', 'account', 100, 3_000),
      expense('deleted-expense', 'account', 100, 3_000),
      transfer('deleted-transfer', 'account', 'other', 100, 3_000),
      adjustment('deleted-adjustment', 'account', 500, 600, 3_000),
    ]
    expect(deleted.map((transaction) => transactionEffectForAccount(transaction, candidate))).toEqual([0, 0, 0, 0])
    expect(deriveCurrentBalance(candidate, deleted)).toBe(500)
  })

  it.each([
    ['opening plus effect overflow', account('asset', 'asset', MAX_SAFE_MINOR), [income('overflow', 'asset', 1)]],
    ['multi-transaction aggregate overflow', account('asset', 'asset', 0), [income('first', 'asset', MAX_SAFE_MINOR), income('second', 'asset', 1)]],
  ] as const)('%s fails closed with checked money overflow', (_label, candidate, transactions) => {
    expectLedgerErrorCode(
      () => deriveCurrentBalance(candidate, transactions),
      'ledger-money-overflow',
    )
  })

  it('rejects an unsafe single effect before it can enter a balance', () => {
    const unsafe = income('unsafe', 'asset', MAX_SAFE_MINOR + 1)
    expectLedgerErrorCode(
      () => transactionEffectForAccount(unsafe, account('asset', 'asset')),
      'ledger-money-unsafe',
    )
  })

  it.each([
    ['asset → asset', 'asset', 'asset'],
    ['asset → liability', 'asset', 'liability'],
    ['liability → asset', 'liability', 'asset'],
    ['liability → liability', 'liability', 'liability'],
  ] as const)('keeps net worth unchanged for %s transfer', (_label, fromNature, toNature) => {
    const from = account('from', fromNature, 5_000)
    const to = account('to', toNature, 7_000)
    const transaction = transfer('transfer', 'from', 'to', 1_000)
    const before = (from.nature === 'asset' ? from.openingBalanceMinor : -from.openingBalanceMinor)
      + (to.nature === 'asset' ? to.openingBalanceMinor : -to.openingBalanceMinor)
    const afterFrom = deriveCurrentBalance(from, [transaction])
    const afterTo = deriveCurrentBalance(to, [transaction])
    const after = (from.nature === 'asset' ? afterFrom : -afterFrom)
      + (to.nature === 'asset' ? afterTo : -afterTo)
    expect(after).toBe(before)
  })
})

/**
 * The single Ledger natural-balance financial-effect authority.
 *
 * Accounts store natural balances: positive assets are held assets and
 * positive liabilities are debts. Every later read/write layer must call this
 * module instead of interpreting transaction signs independently.
 */

import type {
  AdjustmentTransaction,
  LedgerAccount,
  LedgerTransaction,
} from './domain.js'
import { ledgerValidationError } from './errors.js'
import {
  assertPositiveMinor,
  assertSafeMinor,
  checkedAddMinor,
  checkedSubMinor,
  checkedSumMinor,
} from './money.js'

export type LedgerAccountReference = Pick<LedgerAccount, 'id' | 'nature'>
export type LedgerBalanceAccount = LedgerAccountReference & Pick<LedgerAccount, 'openingBalanceMinor'>

type NaturalBalanceRole =
  | 'income'
  | 'expense'
  | 'transfer-outgoing'
  | 'transfer-incoming'

function assertAccountReference(account: LedgerAccountReference): void {
  if (
    account === null
    || typeof account !== 'object'
    || typeof account.id !== 'string'
    || account.id.length === 0
  ) {
    throw ledgerValidationError('Ledger balance account must have a non-empty id', { field: 'id' })
  }
  if (account.nature !== 'asset' && account.nature !== 'liability') {
    throw ledgerValidationError('Ledger balance account has an invalid nature', { field: 'nature' })
  }
}

function signedAmountForRole(
  nature: LedgerAccountReference['nature'],
  role: NaturalBalanceRole,
  amountMinor: number,
): number {
  const increasesNaturalBalance = nature === 'asset'
    ? role === 'income' || role === 'transfer-incoming'
    : role === 'expense' || role === 'transfer-outgoing'

  return increasesNaturalBalance
    ? amountMinor
    : checkedSubMinor(0, amountMinor)
}

function assertAdjustmentEffect(transaction: AdjustmentTransaction): void {
  assertSafeMinor(transaction.amountMinor, 'amountMinor')
  assertSafeMinor(
    transaction.adjustmentCalculatedBalanceMinor,
    'adjustmentCalculatedBalanceMinor',
  )
  assertSafeMinor(
    transaction.adjustmentTargetBalanceMinor,
    'adjustmentTargetBalanceMinor',
  )

  const expectedDelta = checkedSubMinor(
    transaction.adjustmentTargetBalanceMinor,
    transaction.adjustmentCalculatedBalanceMinor,
  )
  if (transaction.amountMinor !== expectedDelta) {
    throw ledgerValidationError(
      'Adjustment amountMinor must equal target minus calculated balance',
      { field: 'amountMinor' },
    )
  }

  if (transaction.amountMinor === 0) {
    throw ledgerValidationError('Adjustment delta must be non-zero', { field: 'amountMinor' })
  }
}

/**
 * Return the signed natural-balance delta contributed by one transaction to
 * one account. Unrelated accounts receive zero; deleted rows never contribute.
 */
export function transactionEffectForAccount(
  transaction: LedgerTransaction,
  account: LedgerAccountReference,
): number {
  assertAccountReference(account)
  if (transaction.deletedAt !== null) return 0

  switch (transaction.type) {
    case 'income':
      assertPositiveMinor(transaction.amountMinor, 'amountMinor')
      return transaction.accountId === account.id
        ? signedAmountForRole(account.nature, 'income', transaction.amountMinor)
        : 0

    case 'expense':
      assertPositiveMinor(transaction.amountMinor, 'amountMinor')
      return transaction.accountId === account.id
        ? signedAmountForRole(account.nature, 'expense', transaction.amountMinor)
        : 0

    case 'transfer':
      assertPositiveMinor(transaction.amountMinor, 'amountMinor')
      if (transaction.fromAccountId === transaction.toAccountId) {
        throw ledgerValidationError('Transfer account pair must be distinct', { field: 'toAccountId' })
      }
      if (transaction.fromAccountId === account.id) {
        return signedAmountForRole(account.nature, 'transfer-outgoing', transaction.amountMinor)
      }
      if (transaction.toAccountId === account.id) {
        return signedAmountForRole(account.nature, 'transfer-incoming', transaction.amountMinor)
      }
      return 0

    case 'adjustment':
      assertAdjustmentEffect(transaction)
      return transaction.accountId === account.id ? transaction.amountMinor : 0

    default:
      throw ledgerValidationError('Ledger transaction has an unsupported type', { field: 'type' })
  }
}

/**
 * Derive an account's current natural balance from its opening position and
 * active transaction effects. Both individual effects and aggregate results
 * are checked safe minor-unit arithmetic.
 */
export function deriveCurrentBalance(
  account: LedgerBalanceAccount,
  transactions: Iterable<LedgerTransaction>,
): number {
  assertAccountReference(account)
  assertSafeMinor(account.openingBalanceMinor, 'openingBalanceMinor')

  const effects = (function* (): Iterable<number> {
    for (const transaction of transactions) {
      yield transactionEffectForAccount(transaction, account)
    }
  })()

  const transactionTotal = checkedSumMinor(effects)
  return checkedAddMinor(account.openingBalanceMinor, transactionTotal)
}

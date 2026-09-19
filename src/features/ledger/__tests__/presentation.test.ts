import { describe, expect, it } from 'vitest'
import type { LedgerTransactionDto } from '../../../../shared/ledgerProtocol'
import {
  ledgerPresentationBalanceMinor,
  ledgerPresentationOutflowMinor,
  ledgerTransactionPresentationKind,
} from '../presentation'

const transfer = (transferKind: 'general' | 'repayment' | 'withdrawal'): LedgerTransactionDto => ({
  id: `transfer-${transferKind}`,
  type: 'transfer',
  transferKind,
  amountMinor: 3_000,
  fromAccountId: 'asset',
  toAccountId: 'liability',
  payee: '',
  note: '',
  occurredAt: 1,
  deletedAt: null,
  version: 1,
  createdAt: 1,
  updatedAt: 1,
})

describe('Ledger presentation metrics', () => {
  it('classifies only repayment transfers as repayment', () => {
    expect(ledgerTransactionPresentationKind(transfer('repayment'))).toBe('repayment')
    expect(ledgerTransactionPresentationKind(transfer('general'))).toBe('transfer')
    expect(ledgerTransactionPresentationKind(transfer('withdrawal'))).toBe('transfer')
  })

  it('derives UI outflow and balance in safe minor units', () => {
    const summary = { incomeMinor: 10_000, expenseMinor: 2_000, repaymentMinor: 3_000 }
    expect(ledgerPresentationOutflowMinor(summary)).toBe(5_000)
    expect(ledgerPresentationBalanceMinor(summary)).toBe(5_000)
  })

  it('rejects unsafe presentation arithmetic', () => {
    expect(() => ledgerPresentationOutflowMinor({
      expenseMinor: Number.MAX_SAFE_INTEGER,
      repaymentMinor: 1,
    })).toThrow('minor amount sum must be a safe integer')
  })
})

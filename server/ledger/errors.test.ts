import { describe, expect, it } from 'vitest'
import {
  LEDGER_STABLE_ERROR_CODES,
  LedgerError,
  type LedgerErrorCode,
} from './errors.js'

const EXPECTED_STABLE_ERROR_CODES = [
  'ledger-validation-failed',
  'ledger-not-found',
  'ledger-duplicate-category',
  'ledger-archived-account',
  'ledger-archived-category',
  'ledger-invalid-account-pair',
  'ledger-currency-mismatch',
  'ledger-opening-date-conflict',
  'ledger-timezone-locked',
  'ledger-base-currency-locked',
  'ledger-balance-conflict',
  'ledger-version-conflict',
  'ledger-account-has-history',
  'ledger-account-nonzero-balance',
  'ledger-category-has-history',
  'ledger-settings-already-initialized',
  'ledger-transaction-type-immutable',
  'ledger-transaction-deleted',
  'ledger-adjustment-immutable',
  'ledger-idempotency-conflict',
] as const

type LegacyCurrencyAliasAccepted =
  'ledger-account-currency-mismatch' extends LedgerErrorCode ? true : false
const legacyCurrencyAliasAccepted: LegacyCurrencyAliasAccepted = false

describe('Ledger canonical error vocabulary', () => {
  it('matches the Accepted stable code list and constructs every code', () => {
    expect(LEDGER_STABLE_ERROR_CODES).toEqual(EXPECTED_STABLE_ERROR_CODES)

    for (const code of LEDGER_STABLE_ERROR_CODES) {
      const error = new LedgerError(code, 409, 'contract test')
      expect(error.code).toBe(code)
    }
  })

  it('does not expose the removed currency alias', () => {
    expect(LEDGER_STABLE_ERROR_CODES).not.toContain('ledger-account-currency-mismatch')
    expect(legacyCurrencyAliasAccepted).toBe(false)
  })
})

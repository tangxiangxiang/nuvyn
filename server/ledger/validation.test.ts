import { describe, expect, it } from 'vitest'
import { LedgerError } from './errors.js'
import {
  LEDGER_IDEMPOTENCY_KEY_MAX_LENGTH,
  LEDGER_LIST_LIMIT_DEFAULT,
  LEDGER_LIST_LIMIT_MAX,
  parseAccountCreateRequest,
  parseAccountBalanceTrendRange,
  parseAccountPatchRequest,
  parseAdjustmentEndpointRequest,
  parseCategoryCreateRequest,
  parseCategoryPatchRequest,
  parseExpectedVersion,
  parseExpectedVersionCommand,
  parseIdempotencyKey,
  parseLimit,
  parseLedgerTransactionCursor,
  parseOverviewScope,
  parseSettingsCreateRequest,
  parseSettingsPatchRequest,
  parseTransactionCreateRequest,
  parseTransactionPatchRequest,
  parseTransactionQuery,
  parseTransactionTypeFilter,
  parseTrendMonths,
} from './validation.js'

const occurredAt = 1_700_000_000_000

describe('Ledger stateless request validation', () => {
  it('rejects unknown keys and keeps Category normalizedName server-derived', () => {
    expect(() => parseCategoryCreateRequest({
      kind: 'expense',
      name: '餐饮',
      normalizedName: '餐饮',
    })).toThrow(LedgerError)
    expect(() => parseSettingsCreateRequest({
      baseCurrency: 'CNY',
      timezone: 'Asia/Shanghai',
      currencyExponent: 2,
    })).toThrow()
  })

  it('normalizes names, defaults text fields, and enforces UTF-16 limits', () => {
    expect(parseAccountCreateRequest({
      name: '  中国银行  ',
      type: 'bank',
      nature: 'asset',
      openingBalanceMinor: -1,
      openingDate: '2026-01-01',
      currency: 'cny',
    })).toMatchObject({ name: '中国银行', currency: 'CNY', note: '' })
    expect(parseTransactionCreateRequest({
      type: 'expense',
      amountMinor: 3800,
      accountId: 'account-1',
      categoryId: 'category-1',
      occurredAt,
    })).toEqual({
      type: 'expense',
      amountMinor: 3800,
      accountId: 'account-1',
      categoryId: 'category-1',
      occurredAt,
      location: '',
      payee: '',
      note: '',
    })
    expect(() => parseAccountCreateRequest({
      name: 'a'.repeat(121),
      type: 'bank',
      nature: 'asset',
      openingBalanceMinor: 0,
      openingDate: '2026-01-01',
      currency: 'CNY',
    })).toThrow()
    expect(() => parseTransactionCreateRequest({
      type: 'expense',
      amountMinor: 1,
      accountId: 'a',
      categoryId: 'c',
      occurredAt,
      payee: 'p'.repeat(LEDGER_LIST_LIMIT_MAX + 1_000),
    })).toThrow()
    expect(() => parseTransactionCreateRequest({
      type: 'expense',
      amountMinor: 1,
      accountId: 'a',
      categoryId: 'c',
      occurredAt,
      note: 'n'.repeat(2_001),
    })).toThrow()
  })

  it('requires positive safe expected versions and opaque idempotency keys', () => {
    expect(parseExpectedVersion({ expectedVersion: 1 })).toBe(1)
    expect(() => parseExpectedVersion({ expectedVersion: 0 })).toThrow()
    expect(() => parseExpectedVersion({ expectedVersion: 1.1 })).toThrow()
    expect(() => parseExpectedVersion({ expectedVersion: Number.MAX_SAFE_INTEGER + 1 })).toThrow()
    expect(parseIdempotencyKey('retry-key')).toBe('retry-key')
    expect(() => parseIdempotencyKey('')).toThrow()
    expect(() => parseIdempotencyKey('x'.repeat(LEDGER_IDEMPOTENCY_KEY_MAX_LENGTH + 1))).toThrow()
  })

  it('parses every discriminated transaction shape and applies only applicable defaults', () => {
    const income = parseTransactionCreateRequest({
      type: 'income', amountMinor: 1, accountId: 'a', categoryId: 'i', occurredAt, payee: 'Employer',
    })
    expect(income).toMatchObject({ type: 'income', payee: 'Employer', note: '' })
    expect(parseTransactionCreateRequest({
      type: 'transfer', amountMinor: 1, fromAccountId: 'a', toAccountId: 'b', occurredAt,
    })).toEqual({ type: 'transfer', amountMinor: 1, fromAccountId: 'a', toAccountId: 'b', occurredAt, location: '', payee: '', note: '' })
    expect(parseTransactionCreateRequest({
      type: 'transfer', transferKind: 'repayment', amountMinor: 1,
      fromAccountId: 'a', toAccountId: 'b', occurredAt,
    })).toMatchObject({ type: 'transfer', transferKind: 'repayment' })
    expect(parseTransactionCreateRequest({
      type: 'adjustment', accountId: 'a', targetBalanceMinor: 10,
      expectedCalculatedBalanceMinor: 5, occurredAt,
    })).toMatchObject({
      type: 'adjustment', accountId: 'a', targetBalanceMinor: 10,
      expectedCalculatedBalanceMinor: 5, note: '',
    })
    expect(() => parseTransactionCreateRequest({
      type: 'transfer', amountMinor: 1, fromAccountId: 'a', toAccountId: 'b', occurredAt, categoryId: 'c',
    })).toThrow()
    expect(() => parseTransactionCreateRequest({
      type: 'transfer', amountMinor: 1, fromAccountId: 'a', toAccountId: 'b', occurredAt,
      feeMinor: 1, feeCategoryId: 'fee-category',
    })).toThrow()
    expect(() => parseTransactionCreateRequest({
      type: 'income', amountMinor: 1, accountId: 'a', categoryId: 'i', occurredAt, fromAccountId: 'b',
    })).toThrow()
    expect(() => parseTransactionCreateRequest({
      type: 'adjustment', accountId: 'a', targetBalanceMinor: 10,
      expectedCalculatedBalanceMinor: 5, occurredAt, payee: 'not applicable',
    })).toThrow()
    expect(parseAdjustmentEndpointRequest({
      targetBalanceMinor: 10, expectedCalculatedBalanceMinor: 5, occurredAt,
    })).toEqual({ targetBalanceMinor: 10, expectedCalculatedBalanceMinor: 5, occurredAt, note: '' })
  })

  it('validates settings/account/category/transaction patch shapes without DB access', () => {
    expect(parseSettingsPatchRequest({ expectedVersion: 1, baseCurrency: 'usd' })).toEqual({
      expectedVersion: 1, baseCurrency: 'USD',
    })
    expect(parseAccountPatchRequest({ expectedVersion: 1, name: 'New name' })).toEqual({
      expectedVersion: 1, name: 'New name',
    })
    expect(parseCategoryPatchRequest({ expectedVersion: 1, name: 'New category' })).toEqual({
      expectedVersion: 1, name: 'New category',
    })
    expect(parseTransactionPatchRequest({ expectedVersion: 1, type: 'expense', amountMinor: 1 })).toEqual({
      expectedVersion: 1, type: 'expense', amountMinor: 1,
    })
    expect(parseTransactionPatchRequest({
      expectedVersion: 1,
      type: 'transfer',
      feeMinor: 25,
      feeMode: 'deducted',
    })).toEqual({
      expectedVersion: 1,
      type: 'transfer',
      feeMinor: 25,
      feeMode: 'deducted',
    })
    expect(() => parseTransactionPatchRequest({
      expectedVersion: 1,
      type: 'transfer',
      feeMinor: 25,
      feeCategoryId: 'fee-category',
    })).toThrow()
    expect(() => parseTransactionPatchRequest({ expectedVersion: 1, feeMinor: -1 })).toThrow()
    expect(parseExpectedVersionCommand({ expectedVersion: 3 })).toBe(3)
    expect(() => parseSettingsPatchRequest({ expectedVersion: 1 })).toThrow()
    expect(() => parseAccountPatchRequest({ expectedVersion: 1, currency: 'USD' })).toThrow()
    expect(() => parseCategoryPatchRequest({ expectedVersion: 1, normalizedName: 'x' })).toThrow()
    expect(() => parseTransactionPatchRequest({ expectedVersion: 1 })).toThrow()
  })

  it('parses query limits, scope, and transaction filters deterministically', () => {
    expect(parseLimit(undefined)).toBe(LEDGER_LIST_LIMIT_DEFAULT)
    expect(parseLimit('200')).toBe(LEDGER_LIST_LIMIT_MAX)
    expect(parseLimit(1)).toBe(1)
    expect(() => parseLimit('0')).toThrow()
    expect(() => parseLimit('201')).toThrow()
    expect(parseOverviewScope(undefined)).toBe('all')
    expect(parseOverviewScope('week')).toBe('week')
    expect(parseTransactionTypeFilter(undefined)).toBe('all')
    expect(parseTransactionTypeFilter('transfer')).toBe('transfer')
    expect(() => parseTransactionTypeFilter('adjustment')).toThrow()
    expect(() => parseTransactionTypeFilter('unknown')).toThrow()
  })

  it('parses the canonical transaction query and strictly validates v1 cursors', () => {
    const cursor = Buffer.from(JSON.stringify({
      v: 1,
      occurredAt,
      createdAt: occurredAt - 1,
      id: 'transaction-1',
    }), 'utf8').toString('base64url')
    expect(parseTransactionQuery({
      type: 'all',
      accountId: 'account-1',
      categoryId: 'category-1',
      from: String(occurredAt - 100),
      to: String(occurredAt + 100),
      search: '  coffee  ',
      includeDeleted: 'true',
      limit: '2',
      offset: '10',
    })).toMatchObject({
      type: 'all',
      accountId: 'account-1',
      categoryId: 'category-1',
      from: occurredAt - 100,
      to: occurredAt + 100,
      search: 'coffee',
      includeDeleted: true,
      limit: 2,
      offset: 10,
    })
    expect(() => parseTransactionQuery({ limit: '2', cursor, offset: '10' })).toThrow()
    expect(() => parseTransactionQuery({ offset: '-1' })).toThrow()
    expect(parseTransactionQuery({ limit: '2', cursor })).toMatchObject({ cursor })
    expect(parseLedgerTransactionCursor(cursor)).toEqual({
      occurredAt,
      createdAt: occurredAt - 1,
      id: 'transaction-1',
    })
    expect(parseTransactionQuery({ search: '   ' }).search).toBeUndefined()
    expect(parseTrendMonths(undefined)).toBe(6)
    expect(parseTrendMonths('3')).toBe(3)
    expect(parseAccountBalanceTrendRange(undefined)).toBe(30)
    expect(parseAccountBalanceTrendRange('365')).toBe(365)

    expect(() => parseTransactionQuery({ from: String(occurredAt), to: String(occurredAt) })).toThrow()
    expect(() => parseTransactionQuery({ cursor: 'not-base64url' })).toThrow()
    expect(() => parseLedgerTransactionCursor(Buffer.from(JSON.stringify({
      v: 1,
      occurredAt,
      createdAt: occurredAt,
      id: 'transaction-1',
      extra: true,
    }), 'utf8').toString('base64url'))).toThrow()
    expect(() => parseLedgerTransactionCursor(Buffer.from(JSON.stringify({
      v: 2,
      occurredAt,
      createdAt: occurredAt,
      id: 'transaction-1',
    }), 'utf8').toString('base64url'))).toThrow()
    expect(() => parseTrendMonths('0')).toThrow()
    expect(() => parseTrendMonths('-1')).toThrow()
    expect(() => parseAccountBalanceTrendRange('14')).toThrow()
    expect(() => parseAccountBalanceTrendRange('0')).toThrow()
  })
})

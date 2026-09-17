// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearLedgerPendingCreate,
  createLedgerPendingIntent,
  isLedgerPendingCreateIntent,
  LEDGER_PENDING_CREATE_STORAGE_KEY,
  readLedgerPendingCreate,
  writeLedgerPendingCreate,
} from '../recovery'

describe('Ledger unresolved create recovery', () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  it('stores only the exact create intent in sessionStorage', () => {
    const intent = createLedgerPendingIntent(
      'transaction',
      {
        type: 'expense',
        amountMinor: 3800,
        accountId: 'account-1',
        categoryId: 'category-1',
        occurredAt: 1_700_000_000_000,
        payee: '',
        note: '',
      },
      'key-a',
      'owner-a',
      1_700_000_000_123,
    )
    writeLedgerPendingCreate(intent)

    expect(readLedgerPendingCreate()).toEqual({ status: 'valid', intent })
    expect(sessionStorage.getItem(LEDGER_PENDING_CREATE_STORAGE_KEY)).toContain('key-a')
    expect(sessionStorage.getItem(LEDGER_PENDING_CREATE_STORAGE_KEY)).not.toContain('password')
    clearLedgerPendingCreate()
    expect(readLedgerPendingCreate()).toEqual({ status: 'none' })
  })

  it('fails closed on malformed or unsupported records without clearing them', () => {
    sessionStorage.setItem(LEDGER_PENDING_CREATE_STORAGE_KEY, '{broken')
    expect(readLedgerPendingCreate()).toMatchObject({ status: 'invalid' })
    expect(sessionStorage.getItem(LEDGER_PENDING_CREATE_STORAGE_KEY)).toBe('{broken')

    const unsupported = {
      version: 99,
      operation: 'transaction',
      operationScope: 'POST:/api/ledger/transactions',
      idempotencyKey: 'key-b',
      canonicalPayload: {},
      createdAt: 1,
      ownerIdentity: null,
    }
    expect(isLedgerPendingCreateIntent(unsupported)).toBe(false)
    sessionStorage.setItem(LEDGER_PENDING_CREATE_STORAGE_KEY, JSON.stringify(unsupported))
    expect(readLedgerPendingCreate()).toMatchObject({ status: 'invalid' })
    expect(sessionStorage.getItem(LEDGER_PENDING_CREATE_STORAGE_KEY)).toContain('"version":99')
  })

  it('validates operation-specific payload shape and scope while retaining every invalid record', () => {
    const transactionIntent = createLedgerPendingIntent(
      'transaction',
      {
        type: 'expense',
        amountMinor: 3800,
        accountId: 'account-1',
        categoryId: 'category-1',
        occurredAt: 1_700_000_000_000,
        payee: '',
        note: '',
      },
      'key-transaction',
      null,
      1_700_000_000_123,
    )
    const accountIntent = createLedgerPendingIntent(
      'account',
      {
        name: '招商银行',
        type: 'bank',
        nature: 'asset',
        openingBalanceMinor: 1_000_000,
        openingDate: '2026-09-05',
        currency: 'CNY',
        note: '',
      },
      'key-account',
      null,
      1_700_000_000_124,
    )
    const invalidRecords = [
      { ...transactionIntent, idempotencyKey: '' },
      { ...transactionIntent, operationScope: 'POST:/api/ledger/accounts' },
      { ...transactionIntent, canonicalPayload: { ...transactionIntent.canonicalPayload, amountMinor: 0 } },
      { ...accountIntent, canonicalPayload: { ...accountIntent.canonicalPayload, type: 'unsupported' } },
    ]

    for (const invalid of invalidRecords) {
      expect(isLedgerPendingCreateIntent(invalid)).toBe(false)
      const raw = JSON.stringify(invalid)
      sessionStorage.setItem(LEDGER_PENDING_CREATE_STORAGE_KEY, raw)
      expect(readLedgerPendingCreate()).toMatchObject({ status: 'invalid' })
      expect(sessionStorage.getItem(LEDGER_PENDING_CREATE_STORAGE_KEY)).toBe(raw)
    }
  })

  it('accepts the current account create payload with an optional card number', () => {
    const intent = createLedgerPendingIntent(
      'account',
      {
        name: '招商银行',
        type: 'bank',
        nature: 'asset',
        openingBalanceMinor: 1_000_000,
        openingDate: '2026-09-05',
        currency: 'CNY',
        note: '',
        cardNumber: '6222021234567890',
      },
      'key-account-card-number',
      null,
    )

    expect(isLedgerPendingCreateIntent(intent)).toBe(true)
    writeLedgerPendingCreate(intent)
    expect(readLedgerPendingCreate()).toEqual({ status: 'valid', intent })
  })

  it('reports a durable-storage write failure instead of pretending the snapshot was saved', () => {
    const intent = createLedgerPendingIntent(
      'category',
      { kind: 'expense', name: '交通' },
      'key-storage-failure',
      null,
    )
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('blocked', 'SecurityError')
    })

    expect(writeLedgerPendingCreate(intent)).toMatchObject({ ok: false })
    expect(sessionStorage.getItem(LEDGER_PENDING_CREATE_STORAGE_KEY)).toBeNull()
    setItem.mockRestore()
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import type {
  LedgerAccount,
  LedgerCategory,
} from './domain.js'
import type {
  LedgerAccountDto,
  LedgerAdjustmentAppliedDto,
  LedgerAdjustmentNoOpDto,
  LedgerCategoryDto,
  LedgerSettingsDto,
  LedgerTransactionDto,
} from '../../shared/ledgerProtocol.js'
import { LedgerError } from './errors.js'
import {
  executeIdempotentLedgerCreate,
  fingerprintLedgerMutation,
  ledgerAccountAdjustmentOperationScope,
  LEDGER_IDEMPOTENCY_OPERATION_SCOPES,
  serializeLedgerReplayResponse,
  stableSerializeLedgerJson,
  type LedgerReplayResponseBody,
} from './idempotency.js'
import {
  parseAccountCreateRequest,
  parseAdjustmentEndpointRequest,
  parseCategoryCreateRequest,
  parseTransactionCreateRequest,
} from './validation.js'
import {
  createLedgerRepository,
  type LedgerIdempotencyRecord,
} from './repository.js'
import { runLedgerWrite } from './writeTransaction.js'
import {
  createLedgerTestDatabase,
  type LedgerTestDatabase,
} from '../__tests__/helpers/ledgerDb.js'

const databases: LedgerTestDatabase[] = []

function freshDatabase(): LedgerTestDatabase {
  const database = createLedgerTestDatabase()
  databases.push(database)
  return database
}

afterEach(() => {
  for (const database of databases.splice(0)) database.cleanup()
})

function account(
  id: string,
  overrides: Partial<LedgerAccount> = {},
): LedgerAccount {
  return {
    id,
    name: `Account ${id}`,
    type: 'bank',
    nature: 'asset',
    openingBalanceMinor: 0,
    openingDate: '2026-01-01',
    currency: 'CNY',
    note: '',
    archivedAt: null,
    version: 1,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  }
}

function category(
  id: string,
  overrides: Partial<LedgerCategory> = {},
): LedgerCategory {
  return {
    id,
    kind: 'expense',
    name: `Category ${id}`,
    normalizedName: `category ${id}`,
    archivedAt: null,
    version: 1,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  }
}

function accountRequest(name = 'Original account') {
  return parseAccountCreateRequest({
    name,
    type: 'bank',
    nature: 'asset',
    openingBalanceMinor: 0,
    openingDate: '2026-01-01',
    currency: 'CNY',
  })
}

function accountResponse(
  value: LedgerAccount,
  currentBalanceMinor = value.openingBalanceMinor,
): LedgerAccountDto {
  return {
    id: value.id,
    name: value.name,
    type: value.type,
    nature: value.nature,
    openingBalanceMinor: value.openingBalanceMinor,
    openingDate: value.openingDate,
    currency: value.currency,
    currencyExponent: 2,
    note: value.note,
    archivedAt: value.archivedAt,
    version: value.version,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    currentBalanceMinor,
  }
}

function categoryResponse(value: LedgerCategory): LedgerCategoryDto {
  return {
    id: value.id,
    kind: value.kind,
    name: value.name,
    normalizedName: value.normalizedName,
    archivedAt: value.archivedAt,
    version: value.version,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

function committedAccountResult(value: LedgerAccount) {
  return {
    resultStatus: 'committed' as const,
    responseStatus: 201 as const,
    responseBody: accountResponse(value),
    resultType: 'account',
    resultId: value.id,
  }
}

function expectLedgerError(callback: () => unknown, code: LedgerError['code']): LedgerError {
  try {
    callback()
  } catch (error) {
    expect(error).toBeInstanceOf(LedgerError)
    expect((error as LedgerError).code).toBe(code)
    return error as LedgerError
  }
  throw new Error(`Expected LedgerError ${code}`)
}

describe('Ledger idempotency canonicalization', () => {
  it('sorts recursive object keys, preserves array order, and fingerprints deterministically', () => {
    const first = { b: 2, nested: { d: 4, c: 3 }, a: 1 }
    const second = { a: 1, nested: { c: 3, d: 4 }, b: 2 }

    expect(stableSerializeLedgerJson(first)).toBe('{"a":1,"b":2,"nested":{"c":3,"d":4}}')
    expect(stableSerializeLedgerJson(first)).toBe(stableSerializeLedgerJson(second))
    const firstRequest = { baseCurrency: 'CNY', timezone: 'Asia/Shanghai' } as const
    const secondRequest = { timezone: 'Asia/Shanghai', baseCurrency: 'CNY' } as const
    const fingerprint = fingerprintLedgerMutation(firstRequest)
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(fingerprint).toBe(fingerprintLedgerMutation(secondRequest))
    expect(stableSerializeLedgerJson([1, 2])).toBe('[1,2]')
    expect(stableSerializeLedgerJson([1, 2])).not.toBe(stableSerializeLedgerJson([2, 1]))
  })

  it('rejects values that are not safe canonical JSON data', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const unsupportedValues: unknown[] = [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      1n,
      () => undefined,
      Symbol('ledger'),
      new Date(0),
      new Map(),
      cyclic,
    ]

    for (const value of unsupportedValues) {
      expect(() => stableSerializeLedgerJson(value)).toThrow(TypeError)
    }
  })

  it('starts from parsed canonical DTOs so defaults and normalized currency are equivalent', () => {
    const omittedNote = accountRequest('  Original account  ')
    const explicitNote = parseAccountCreateRequest({
      name: 'Original account',
      type: 'bank',
      nature: 'asset',
      openingBalanceMinor: 0,
      openingDate: '2026-01-01',
      currency: ' cny ',
      note: '',
    })
    expect(omittedNote).toEqual(explicitNote)
    expect(fingerprintLedgerMutation(omittedNote)).toBe(fingerprintLedgerMutation(explicitNote))

    const trimmedCategory = parseCategoryCreateRequest({ kind: 'expense', name: '  餐饮  ' })
    const canonicalCategory = parseCategoryCreateRequest({ kind: 'expense', name: '餐饮' })
    expect(trimmedCategory).toEqual(canonicalCategory)
    expect(fingerprintLedgerMutation(trimmedCategory)).toBe(fingerprintLedgerMutation(canonicalCategory))

    const omittedPayee = parseTransactionCreateRequest({
      type: 'expense',
      amountMinor: 100,
      accountId: 'account-1',
      categoryId: 'category-1',
      occurredAt: 1_700_000_000_000,
    })
    const explicitPayee = parseTransactionCreateRequest({
      type: 'expense',
      amountMinor: 100,
      accountId: 'account-1',
      categoryId: 'category-1',
      occurredAt: 1_700_000_000_000,
      payee: '',
      note: '',
    })
    expect(omittedPayee).toEqual(explicitPayee)
    expect(fingerprintLedgerMutation(omittedPayee)).toBe(fingerprintLedgerMutation(explicitPayee))

    const differentAmount = parseTransactionCreateRequest({
      ...explicitPayee,
      amountMinor: 101,
    })
    expect(fingerprintLedgerMutation(explicitPayee)).not.toBe(fingerprintLedgerMutation(differentAmount))
  })

  it('freezes the exact operation scopes', () => {
    expect(LEDGER_IDEMPOTENCY_OPERATION_SCOPES).toEqual({
      settings: 'POST:/api/ledger/settings',
      accounts: 'POST:/api/ledger/accounts',
      categories: 'POST:/api/ledger/categories',
      transactions: 'POST:/api/ledger/transactions',
    })
    expect(ledgerAccountAdjustmentOperationScope('account-1'))
      .toBe('POST:/api/ledger/accounts/account-1/adjust')
  })
})

describe('Ledger persistent idempotent create executor', () => {
  it('replays the original response after the mutable resource changes, without rerunning the callback', () => {
    const database = freshDatabase()
    const repository = createLedgerRepository(database.db)
    const originalAccount = account('mutable-account')
    const request = accountRequest()
    let callbackCount = 0

    const first = executeIdempotentLedgerCreate(database.db, repository, {
      operationScope: LEDGER_IDEMPOTENCY_OPERATION_SCOPES.accounts,
      idempotencyKey: 'mutable-replay-key',
      request,
      createdAt: 1_111,
      mutation: () => {
        callbackCount += 1
        repository.insertAccount(originalAccount)
        return committedAccountResult(originalAccount)
      },
    })
    const storedBeforeReplay = repository.getIdempotencyRecord(
      LEDGER_IDEMPOTENCY_OPERATION_SCOPES.accounts,
      'mutable-replay-key',
    )
    expect(first.replayed).toBe(false)
    expect(callbackCount).toBe(1)
    expect(storedBeforeReplay?.responseBodyJson).toBe(first.responseBodyJson)

    const changedAccount = {
      ...originalAccount,
      name: 'Changed after create',
      openingBalanceMinor: 900,
      version: 2,
      updatedAt: 2_000,
    }
    expect(repository.updateAccount({ account: changedAccount, expectedVersion: 1 })).toBe(1)

    const replay = executeIdempotentLedgerCreate(database.db, repository, {
      operationScope: LEDGER_IDEMPOTENCY_OPERATION_SCOPES.accounts,
      idempotencyKey: 'mutable-replay-key',
      request,
      mutation: () => {
        throw new Error('replay must not execute the current-state callback')
      },
    })

    expect(replay).toEqual({
      responseStatus: first.responseStatus,
      responseBodyJson: first.responseBodyJson,
      replayed: true,
    })
    expect(callbackCount).toBe(1)
    expect(repository.getAccount(originalAccount.id)).toEqual(changedAccount)
    expect(repository.getIdempotencyRecord(
      LEDGER_IDEMPOTENCY_OPERATION_SCOPES.accounts,
      'mutable-replay-key',
    )).toEqual(storedBeforeReplay)
  })

  it('replays after physical resource deletion and never resurrects the resource', () => {
    const database = freshDatabase()
    const repository = createLedgerRepository(database.db)
    const createdAccount = account('deleted-account')
    const request = accountRequest('Deleted later')
    let callbackCount = 0

    const first = executeIdempotentLedgerCreate(database.db, repository, {
      operationScope: LEDGER_IDEMPOTENCY_OPERATION_SCOPES.accounts,
      idempotencyKey: 'physical-delete-key',
      request,
      mutation: () => {
        callbackCount += 1
        repository.insertAccount(createdAccount)
        return committedAccountResult(createdAccount)
      },
    })
    const storedRecord = repository.getIdempotencyRecord(
      LEDGER_IDEMPOTENCY_OPERATION_SCOPES.accounts,
      'physical-delete-key',
    )
    expect(repository.deleteAccount(createdAccount.id)).toBe(1)
    expect(repository.getAccount(createdAccount.id)).toBeNull()

    const replay = executeIdempotentLedgerCreate(database.db, repository, {
      operationScope: LEDGER_IDEMPOTENCY_OPERATION_SCOPES.accounts,
      idempotencyKey: 'physical-delete-key',
      request,
      mutation: () => {
        callbackCount += 1
        throw new Error('physical-delete replay must not recreate the account')
      },
    })

    expect(replay.responseStatus).toBe(first.responseStatus)
    expect(replay.responseBodyJson).toBe(storedRecord?.responseBodyJson)
    expect(replay.replayed).toBe(true)
    expect(callbackCount).toBe(1)
    expect(repository.getAccount(createdAccount.id)).toBeNull()
    expect(repository.getIdempotencyRecord(
      LEDGER_IDEMPOTENCY_OPERATION_SCOPES.accounts,
      'physical-delete-key',
    )).toEqual(storedRecord)
  })

  it('replays an original Adjustment no-op snapshot after later balance state changes', () => {
    const database = freshDatabase()
    const repository = createLedgerRepository(database.db)
    const targetAccount = account('adjustment-no-op-account', { openingBalanceMinor: 1_000 })
    repository.insertAccount(targetAccount)
    const request = parseAdjustmentEndpointRequest({
      targetBalanceMinor: 1_000,
      expectedCalculatedBalanceMinor: 1_000,
      occurredAt: 1_700_000_000_000,
    })
    const scope = ledgerAccountAdjustmentOperationScope(targetAccount.id)
    const originalBody: LedgerAdjustmentNoOpDto = {
      adjustment: null,
      account: accountResponse(targetAccount, 1_000),
      noOp: true,
    }

    const first = executeIdempotentLedgerCreate(database.db, repository, {
      operationScope: scope,
      idempotencyKey: 'adjustment-no-op-key',
      request,
      mutation: () => ({
        resultStatus: 'no-op' as const,
        responseStatus: 200 as const,
        responseBody: originalBody,
        resultType: 'adjustment',
        resultId: targetAccount.id,
      }),
    })
    const storedNoOp = repository.getIdempotencyRecord(scope, 'adjustment-no-op-key')
    expect(storedNoOp).toMatchObject({
      responseStatus: 200,
      resultStatus: 'no-op',
      resultType: 'adjustment',
      resultId: targetAccount.id,
    })
    const laterAccount = {
      ...targetAccount,
      openingBalanceMinor: 2_000,
      version: 2,
      updatedAt: 2_000,
    }
    expect(repository.updateAccount({ account: laterAccount, expectedVersion: 1 })).toBe(1)

    const replay = executeIdempotentLedgerCreate(database.db, repository, {
      operationScope: scope,
      idempotencyKey: 'adjustment-no-op-key',
      request,
      mutation: () => {
        throw new Error('Adjustment no-op replay must not recompute the account projection')
      },
    })

    expect(first.responseStatus).toBe(200)
    expect(JSON.parse(first.responseBodyJson)).toEqual(originalBody)
    expect(replay.responseStatus).toBe(first.responseStatus)
    expect(replay.responseBodyJson).toBe(first.responseBodyJson)
    expect(repository.getAccount(targetAccount.id)).toEqual(laterAccount)
  })

  it('returns a conflict for a changed request and does not run the conflicting callback', () => {
    const database = freshDatabase()
    const repository = createLedgerRepository(database.db)
    const request = accountRequest()
    const originalAccount = account('conflict-account')
    let conflictingCallbackRan = false

    executeIdempotentLedgerCreate(database.db, repository, {
      operationScope: LEDGER_IDEMPOTENCY_OPERATION_SCOPES.accounts,
      idempotencyKey: 'conflict-key',
      request,
      mutation: () => {
        repository.insertAccount(originalAccount)
        return committedAccountResult(originalAccount)
      },
    })

    const conflict = expectLedgerError(() => executeIdempotentLedgerCreate(database.db, repository, {
      operationScope: LEDGER_IDEMPOTENCY_OPERATION_SCOPES.accounts,
      idempotencyKey: 'conflict-key',
      request: accountRequest('different request'),
      mutation: () => {
        conflictingCallbackRan = true
        throw new Error('conflicting callback must not run')
      },
    }), 'ledger-idempotency-conflict')
    expect(conflict.status).toBe(409)
    expect(conflict.details).toBeUndefined()
    expect(conflictingCallbackRan).toBe(false)
  })

  it('allows the same key in independent operation scopes', () => {
    const database = freshDatabase()
    const repository = createLedgerRepository(database.db)
    const accountValue = account('scope-account')
    const categoryValue = category('scope-category')
    const key = 'same-key-different-scope'

    executeIdempotentLedgerCreate(database.db, repository, {
      operationScope: LEDGER_IDEMPOTENCY_OPERATION_SCOPES.accounts,
      idempotencyKey: key,
      request: accountRequest(),
      mutation: () => {
        repository.insertAccount(accountValue)
        return committedAccountResult(accountValue)
      },
    })
    const categoryRequest = { kind: 'expense' as const, name: 'Scope category' }
    const categoryBody = categoryResponse(categoryValue)
    executeIdempotentLedgerCreate(database.db, repository, {
      operationScope: LEDGER_IDEMPOTENCY_OPERATION_SCOPES.categories,
      idempotencyKey: key,
      request: categoryRequest,
      mutation: () => {
        repository.insertCategory(categoryValue)
        return {
          resultStatus: 'committed' as const,
          responseStatus: 201 as const,
          responseBody: categoryBody,
          resultType: 'category',
          resultId: categoryValue.id,
        }
      },
    })

    expect(repository.getAccount(accountValue.id)).not.toBeNull()
    expect(repository.getCategory(categoryValue.id)).not.toBeNull()
    expect(repository.getIdempotencyRecord(
      LEDGER_IDEMPOTENCY_OPERATION_SCOPES.accounts,
      key,
    )).not.toBeNull()
    expect(repository.getIdempotencyRecord(
      LEDGER_IDEMPOTENCY_OPERATION_SCOPES.categories,
      key,
    )).not.toBeNull()
  })

  it('does not consume a key when validation, serialization, or the atomicity seam fails', () => {
    const database = freshDatabase()
    const repository = createLedgerRepository(database.db)

    expect(() => executeIdempotentLedgerCreate(database.db, repository, {
      operationScope: LEDGER_IDEMPOTENCY_OPERATION_SCOPES.accounts,
      idempotencyKey: 'callback-failure-key',
      request: accountRequest(),
      mutation: () => {
        throw new Error('domain failure before mutation')
      },
    })).toThrow('domain failure before mutation')
    expect(repository.getIdempotencyRecord(
      LEDGER_IDEMPOTENCY_OPERATION_SCOPES.accounts,
      'callback-failure-key',
    )).toBeNull()

    const callbackRetryAccount = account('callback-retry-account')
    const callbackRetry = executeIdempotentLedgerCreate(database.db, repository, {
      operationScope: LEDGER_IDEMPOTENCY_OPERATION_SCOPES.accounts,
      idempotencyKey: 'callback-failure-key',
      request: accountRequest(),
      mutation: () => {
        repository.insertAccount(callbackRetryAccount)
        return committedAccountResult(callbackRetryAccount)
      },
    })
    expect(callbackRetry.replayed).toBe(false)
    expect(repository.getAccount(callbackRetryAccount.id)).not.toBeNull()

    const seamAccount = account('seam-account')
    expect(() => executeIdempotentLedgerCreate(database.db, repository, {
      operationScope: LEDGER_IDEMPOTENCY_OPERATION_SCOPES.accounts,
      idempotencyKey: 'seam-failure-key',
      request: accountRequest('Seam account'),
      mutation: () => {
        repository.insertAccount(seamAccount)
        return committedAccountResult(seamAccount)
      },
      afterMutationBeforeIdempotencyInsert: () => {
        throw new Error('failure seam')
      },
    })).toThrow('failure seam')
    expect(repository.getAccount(seamAccount.id)).toBeNull()
    expect(repository.getIdempotencyRecord(
      LEDGER_IDEMPOTENCY_OPERATION_SCOPES.accounts,
      'seam-failure-key',
    )).toBeNull()

    const invalidResponseAccount = account('serialization-account')
    expect(() => executeIdempotentLedgerCreate(database.db, repository, {
      operationScope: LEDGER_IDEMPOTENCY_OPERATION_SCOPES.accounts,
      idempotencyKey: 'serialization-failure-key',
      request: accountRequest('Serialization account'),
      mutation: () => {
        repository.insertAccount(invalidResponseAccount)
        return {
          resultStatus: 'committed' as const,
          responseStatus: 201 as const,
          responseBody: new Date(0) as unknown as LedgerAccountDto,
          resultType: 'account',
          resultId: invalidResponseAccount.id,
        }
      },
    })).toThrow(TypeError)
    expect(repository.getAccount(invalidResponseAccount.id)).toBeNull()
    expect(repository.getIdempotencyRecord(
      LEDGER_IDEMPOTENCY_OPERATION_SCOPES.accounts,
      'serialization-failure-key',
    )).toBeNull()

    const serializationRetryAccount = account('serialization-retry-account')
    const serializationRetry = executeIdempotentLedgerCreate(database.db, repository, {
      operationScope: LEDGER_IDEMPOTENCY_OPERATION_SCOPES.accounts,
      idempotencyKey: 'serialization-failure-key',
      request: accountRequest('Serialization account'),
      mutation: () => {
        repository.insertAccount(serializationRetryAccount)
        return committedAccountResult(serializationRetryAccount)
      },
    })
    expect(serializationRetry.replayed).toBe(false)
    expect(repository.getAccount(serializationRetryAccount.id)).not.toBeNull()

    const retryRequest = accountRequest('Seam account')
    let retryCount = 0
    const retry = executeIdempotentLedgerCreate(database.db, repository, {
      operationScope: LEDGER_IDEMPOTENCY_OPERATION_SCOPES.accounts,
      idempotencyKey: 'seam-failure-key',
      request: retryRequest,
      mutation: () => {
        retryCount += 1
        repository.insertAccount(seamAccount)
        return committedAccountResult(seamAccount)
      },
    })
    expect(retry.replayed).toBe(false)
    expect(retryCount).toBe(1)
    expect(repository.getAccount(seamAccount.id)).not.toBeNull()
    expect(repository.getIdempotencyRecord(
      LEDGER_IDEMPOTENCY_OPERATION_SCOPES.accounts,
      'seam-failure-key',
    )).not.toBeNull()
  })

  it('rejects a sensitive top-level response field and rolls back both writes', () => {
    const database = freshDatabase()
    const repository = createLedgerRepository(database.db)
    const value = account('top-level-privacy-rollback-account')
    const unsafeResponse = {
      ...accountResponse(value),
      authorization: 'Bearer secret',
    } as unknown as LedgerAccountDto

    expect(() => executeIdempotentLedgerCreate(database.db, repository, {
      operationScope: LEDGER_IDEMPOTENCY_OPERATION_SCOPES.accounts,
      idempotencyKey: 'top-level-privacy-rollback-key',
      request: accountRequest('Top-level privacy account'),
      mutation: () => {
        repository.insertAccount(value)
        return {
          resultStatus: 'committed' as const,
          responseStatus: 201 as const,
          responseBody: unsafeResponse,
          resultType: 'account',
          resultId: value.id,
        }
      },
    })).toThrow(TypeError)

    expect(repository.getAccount(value.id)).toBeNull()
    expect(repository.getIdempotencyRecord(
      LEDGER_IDEMPOTENCY_OPERATION_SCOPES.accounts,
      'top-level-privacy-rollback-key',
    )).toBeNull()
  })

  it('rejects a sensitive nested response field and rolls back both writes', () => {
    const database = freshDatabase()
    const repository = createLedgerRepository(database.db)
    const value = account('nested-privacy-rollback-account')
    const unsafeResponse = {
      adjustment: null,
      account: {
        ...accountResponse(value),
        sessionToken: 'secret',
      },
      noOp: true,
    } as unknown as LedgerAdjustmentNoOpDto

    expect(() => executeIdempotentLedgerCreate(database.db, repository, {
      operationScope: ledgerAccountAdjustmentOperationScope(value.id),
      idempotencyKey: 'nested-privacy-rollback-key',
      request: parseAdjustmentEndpointRequest({
        targetBalanceMinor: 0,
        expectedCalculatedBalanceMinor: 0,
        occurredAt: 1_700_000_000_000,
      }),
      mutation: () => {
        repository.insertAccount(value)
        return {
          resultStatus: 'no-op' as const,
          responseStatus: 200 as const,
          responseBody: unsafeResponse,
          resultType: 'adjustment',
          resultId: value.id,
        }
      },
    })).toThrow(TypeError)

    expect(repository.getAccount(value.id)).toBeNull()
    expect(repository.getIdempotencyRecord(
      ledgerAccountAdjustmentOperationScope(value.id),
      'nested-privacy-rollback-key',
    )).toBeNull()
  })

  it('uses one nested transaction boundary with runLedgerWrite', () => {
    const database = freshDatabase()
    const repository = createLedgerRepository(database.db)
    const value = account('nested-idempotency-account')

    expect(() => {
      // The executor owns no manual BEGIN/COMMIT; the outer Ledger write owns rollback.
      runLedgerWrite(database.db, () => {
        executeIdempotentLedgerCreate(database.db, repository, {
          operationScope: LEDGER_IDEMPOTENCY_OPERATION_SCOPES.accounts,
          idempotencyKey: 'nested-key',
          request: accountRequest('Nested account'),
          mutation: () => {
            repository.insertAccount(value)
            return committedAccountResult(value)
          },
        })
        throw new Error('outer transaction rollback')
      })
    }).toThrow('outer transaction rollback')

    expect(repository.getAccount(value.id)).toBeNull()
    expect(repository.getIdempotencyRecord(
      LEDGER_IDEMPOTENCY_OPERATION_SCOPES.accounts,
      'nested-key',
    )).toBeNull()
  })

  it('contains an escaped native async mutation before its body can execute', async () => {
    const database = freshDatabase()
    const repository = createLedgerRepository(database.db)
    const escapedAccount = account('escaped-idempotency-account')
    const escapedCategory = category('escaped-idempotency-category')
    let callbackRan = false
    type CommittedAccountResult = ReturnType<typeof committedAccountResult>
    const escapedMutation = (async () => {
      callbackRan = true
      repository.insertAccount(escapedAccount)
      await Promise.resolve()
      repository.insertCategory(escapedCategory)
      return committedAccountResult(escapedAccount)
    }) as unknown as () => CommittedAccountResult

    expect(() => executeIdempotentLedgerCreate(database.db, repository, {
      operationScope: LEDGER_IDEMPOTENCY_OPERATION_SCOPES.accounts,
      idempotencyKey: 'escaped-async-key',
      request: accountRequest('Escaped async account'),
      mutation: escapedMutation,
    })).toThrow(TypeError)
    expect(callbackRan).toBe(false)
    await Promise.resolve()
    expect(repository.getAccount(escapedAccount.id)).toBeNull()
    expect(repository.getCategory(escapedCategory.id)).toBeNull()
    expect(repository.getIdempotencyRecord(
      LEDGER_IDEMPOTENCY_OPERATION_SCOPES.accounts,
      'escaped-async-key',
    )).toBeNull()
  })

  it('maps repository idempotency fields and preserves SQLite identity constraints', () => {
    const database = freshDatabase()
    const repository = createLedgerRepository(database.db)
    const record: LedgerIdempotencyRecord = {
      operationScope: 'POST:/api/ledger/accounts',
      idempotencyKey: 'repository-key',
      requestFingerprint: 'a'.repeat(64),
      responseStatus: 201,
      responseBodyJson: '{"id":"account-1"}',
      resultStatus: 'committed',
      resultType: 'account',
      resultId: 'account-1',
      createdAt: 1_000,
    }
    repository.insertIdempotencyRecord(record)
    expect(repository.getIdempotencyRecord(record.operationScope, record.idempotencyKey)).toEqual(record)
    expect(() => repository.insertIdempotencyRecord(record)).toThrow()

    const otherScope = { ...record, operationScope: 'POST:/api/ledger/categories', resultType: null, resultId: null }
    repository.insertIdempotencyRecord(otherScope)
    expect(repository.getIdempotencyRecord(otherScope.operationScope, otherScope.idempotencyKey)).toEqual(otherScope)
  })
})

describe('Ledger idempotency response serialization', () => {
  const settingsResponse: LedgerSettingsDto = {
    baseCurrency: 'CNY',
    currencyExponent: 2,
    timezone: 'Asia/Shanghai',
    hasCreatedAccount: false,
    version: 1,
    createdAt: 1_000,
    updatedAt: 1_000,
  }

  const transactionResponse: LedgerTransactionDto = {
    id: 'serialization-transaction',
    type: 'income',
    amountMinor: 100,
    accountId: 'serialization-account',
    categoryId: 'serialization-category',
    occurredAt: 1_700_000_000_000,
    payee: 'Employer',
    note: '',
    deletedAt: null,
    version: 1,
    createdAt: 1_000,
    updatedAt: 1_000,
  }

  const adjustmentTransaction: Extract<LedgerTransactionDto, { type: 'adjustment' }> = {
    id: 'serialization-adjustment',
    type: 'adjustment',
    amountMinor: 200,
    accountId: 'serialization-adjustment-account',
    adjustmentCalculatedBalanceMinor: 1_000,
    adjustmentTargetBalanceMinor: 1_200,
    occurredAt: 1_700_000_000_000,
    note: '',
    deletedAt: null,
    version: 1,
    createdAt: 1_000,
    updatedAt: 1_000,
  }

  const appliedAdjustment: LedgerAdjustmentAppliedDto = {
    adjustment: adjustmentTransaction,
    account: accountResponse(account('serialization-adjustment-account'), 1_200),
    noOp: false,
  }

  const noOpAdjustment: LedgerAdjustmentNoOpDto = {
    adjustment: null,
    account: accountResponse(account('serialization-no-op-account')),
    noOp: true,
  }

  const validResponses: readonly [string, LedgerReplayResponseBody][] = [
    ['settings', settingsResponse],
    ['account', accountResponse(account('serialization-account'))],
    ['category', categoryResponse(category('serialization-category'))],
    ['transaction', transactionResponse],
    ['adjustment-applied', appliedAdjustment],
    ['adjustment-no-op', noOpAdjustment],
  ]

  it.each(validResponses)('serializes the valid %s response variant', (_name, responseBody) => {
    expect(serializeLedgerReplayResponse(responseBody)).toBe(stableSerializeLedgerJson(responseBody))
  })

  it('rejects an unknown top-level field even when the value is JSON-safe', () => {
    const unsafeResponse = {
      ...accountResponse(account('top-level-privacy-account')),
      authorization: 'Bearer secret',
    } as unknown as LedgerReplayResponseBody

    expect(() => serializeLedgerReplayResponse(unsafeResponse)).toThrow(TypeError)
  })

  it('rejects an unknown nested DTO field', () => {
    const unsafeResponse = {
      adjustment: null,
      account: {
        ...accountResponse(account('nested-privacy-account')),
        sessionToken: 'secret',
      },
      noOp: true,
    } as unknown as LedgerReplayResponseBody

    expect(() => serializeLedgerReplayResponse(unsafeResponse)).toThrow(TypeError)
  })

  it.each([
    {
      adjustment: adjustmentTransaction,
      account: accountResponse(account('malformed-no-op-account')),
      noOp: true,
    },
    {
      adjustment: null,
      account: accountResponse(account('malformed-applied-account')),
      noOp: false,
    },
  ] as const)('rejects malformed Adjustment wrapper discriminator %#', (responseBody) => {
    expect(() => serializeLedgerReplayResponse(
      responseBody as unknown as LedgerReplayResponseBody,
    )).toThrow(TypeError)
  })
})

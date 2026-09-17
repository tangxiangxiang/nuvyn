import type { Database as DatabaseT } from 'better-sqlite3'
import type { LedgerAccountCreateRequest, LedgerAccountDto } from '../../shared/ledgerProtocol.js'
import {
  executeIdempotentLedgerCreate,
  LEDGER_IDEMPOTENCY_OPERATION_SCOPES,
} from './idempotency.js'
import type { LedgerRepository } from './repository.js'

declare const db: DatabaseT
declare const repository: LedgerRepository
declare const request: LedgerAccountCreateRequest
declare const accountResponse: LedgerAccountDto

executeIdempotentLedgerCreate(db, repository, {
  operationScope: LEDGER_IDEMPOTENCY_OPERATION_SCOPES.accounts,
  idempotencyKey: 'type-test-key',
  request,
  mutation: () => ({
    resultStatus: 'committed',
    responseStatus: 201,
    responseBody: accountResponse,
  }),
})

executeIdempotentLedgerCreate(db, repository, {
  operationScope: LEDGER_IDEMPOTENCY_OPERATION_SCOPES.accounts,
  idempotencyKey: 'async-type-test-key',
  request,
  // @ts-expect-error Promise-returning Ledger mutation callbacks are forbidden.
  mutation: async () => ({
    resultStatus: 'committed',
    responseStatus: 201,
    responseBody: accountResponse,
  }),
})

const thenable = { then: () => undefined }

executeIdempotentLedgerCreate(db, repository, {
  operationScope: LEDGER_IDEMPOTENCY_OPERATION_SCOPES.accounts,
  idempotencyKey: 'thenable-type-test-key',
  request,
  // @ts-expect-error PromiseLike-returning Ledger mutation callbacks are forbidden.
  mutation: () => thenable,
})

executeIdempotentLedgerCreate(db, repository, {
  operationScope: LEDGER_IDEMPOTENCY_OPERATION_SCOPES.accounts,
  idempotencyKey: 'arbitrary-response-type-test-key',
  request,
  mutation: () => ({
    resultStatus: 'committed',
    responseStatus: 201,
    // @ts-expect-error Arbitrary JSON objects are not Ledger replay DTOs.
    responseBody: { committed: true },
  }),
})

executeIdempotentLedgerCreate(db, repository, {
  operationScope: LEDGER_IDEMPOTENCY_OPERATION_SCOPES.accounts,
  idempotencyKey: 'sensitive-response-type-test-key',
  request,
  mutation: () => ({
    resultStatus: 'committed',
    responseStatus: 201,
    // @ts-expect-error Sensitive/non-Ledger response objects are not replay DTOs.
    responseBody: { authorization: 'secret' },
  }),
})

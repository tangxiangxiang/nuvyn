import { getDb } from '../../db.js'
import { isLedgerError, ledgerValidationError } from '../errors.js'
import type { LedgerReplayResult } from '../idempotency.js'
import { createLedgerRepository } from '../repository.js'
import { createLedgerProjections, type LedgerProjections } from '../projections.js'
import { createLedgerService, type LedgerService } from '../service.js'

export type LedgerServiceFactory = () => LedgerService
export type LedgerProjectionFactory = () => LedgerProjections

export function ledgerServiceForRequest(): LedgerService {
  const db = getDb()
  return createLedgerService(db, createLedgerRepository(db))
}

export function ledgerProjectionsForRequest(): LedgerProjections {
  const db = getDb()
  return createLedgerProjections(createLedgerRepository(db))
}

export async function readLedgerJson(c: any): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    throw ledgerValidationError('request body must be valid JSON')
  }
}

export function ledgerErrorResponse(c: any, error: unknown): Response {
  c.header('Cache-Control', 'no-store')
  if (isLedgerError(error)) {
    return c.json({
      error: error.message,
      code: error.code,
      ...(error.details === undefined ? {} : { details: error.details }),
    }, error.status)
  }
  return c.json({
    error: 'Ledger operation failed.',
    code: 'ledger-internal-error',
  }, 500)
}

export async function withLedgerErrors(
  c: any,
  operation: () => Response | Promise<Response>,
): Promise<Response> {
  try {
    return await operation()
  } catch (error) {
    return ledgerErrorResponse(c, error)
  }
}

/** Return the already serialized replay snapshot without rebuilding it. */
export function ledgerReplayResponse(c: any, result: LedgerReplayResult): Response {
  c.header('Cache-Control', 'no-store')
  c.header('Content-Type', 'application/json; charset=UTF-8')
  return c.body(result.responseBodyJson, result.responseStatus)
}

import { Hono } from 'hono'
import {
  parseAccountCreateRequest,
  parseAccountBalanceTrendRange,
  parseAdjustmentEndpointRequest,
  parseBooleanQuery,
  parseIdempotencyKey,
  parseTransactionQuery,
} from '../validation.js'
import {
  ledgerProjectionsForRequest,
  ledgerReplayResponse,
  readLedgerJson,
  withLedgerErrors,
  type LedgerProjectionFactory,
  type LedgerServiceFactory,
} from './shared.js'

export function createAccountRoutes(
  getService: LedgerServiceFactory,
  getProjections: LedgerProjectionFactory = ledgerProjectionsForRequest,
): Hono {
  const routes = new Hono()

  routes.get('/', (c) => withLedgerErrors(c, () => {
    const includeArchived = parseBooleanQuery(
      c.req.query('includeArchived'),
      'includeArchived',
      false,
    )
    return c.json(getService().listAccounts(includeArchived))
  }))

  routes.post('/', (c) => withLedgerErrors(c, async () => {
    const request = parseAccountCreateRequest(await readLedgerJson(c))
    const idempotencyKey = parseIdempotencyKey(c.req.header('Idempotency-Key'))
    return ledgerReplayResponse(c, getService().createAccount(request, idempotencyKey))
  }))

  routes.post('/:id/archive', (c) => withLedgerErrors(c, async () => {
    const body = await readLedgerJson(c)
    return c.json(getService().archiveAccount(c.req.param('id'), body))
  }))

  routes.post('/:id/restore', (c) => withLedgerErrors(c, async () => {
    const body = await readLedgerJson(c)
    return c.json(getService().restoreAccount(c.req.param('id'), body))
  }))

  routes.post('/:id/adjust', (c) => withLedgerErrors(c, async () => {
    const request = parseAdjustmentEndpointRequest(await readLedgerJson(c))
    const idempotencyKey = parseIdempotencyKey(c.req.header('Idempotency-Key'))
    return ledgerReplayResponse(c, getService().adjustAccount(
      c.req.param('id'),
      request,
      idempotencyKey,
    ))
  }))

  routes.get('/:id/balance-trend', (c) => withLedgerErrors(c, () => c.json(
    getProjections().getAccountBalanceTrend(
      c.req.param('id'),
      parseAccountBalanceTrendRange(c.req.query('range')),
    ),
  )))

  routes.get('/:id/transactions', (c) => withLedgerErrors(c, () => c.json(
    getProjections().getAccountTransactions(
      c.req.param('id'),
      parseTransactionQuery(c.req.query()),
    ),
  )))

  routes.get('/:id', (c) => withLedgerErrors(c, () => c.json(
    getService().getAccount(c.req.param('id')),
  )))

  routes.patch('/:id', (c) => withLedgerErrors(c, async () => {
    const body = await readLedgerJson(c)
    return c.json(getService().patchAccount(c.req.param('id'), body))
  }))

  routes.delete('/:id', (c) => withLedgerErrors(c, async () => {
    const body = await readLedgerJson(c)
    return c.json(getService().deleteAccount(c.req.param('id'), body))
  }))

  return routes
}

import { Hono } from 'hono'
import {
  parseIdempotencyKey,
  parseTransactionCreateRequest,
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

export function createTransactionRoutes(
  getService: LedgerServiceFactory,
  getProjections: LedgerProjectionFactory = ledgerProjectionsForRequest,
): Hono {
  const routes = new Hono()

  routes.get('/', (c) => withLedgerErrors(c, () => c.json(
    getProjections().listTransactions(parseTransactionQuery(c.req.query())),
  )))

  routes.post('/', (c) => withLedgerErrors(c, async () => {
    const request = parseTransactionCreateRequest(await readLedgerJson(c))
    const idempotencyKey = parseIdempotencyKey(c.req.header('Idempotency-Key'))
    return ledgerReplayResponse(c, getService().createTransaction(request, idempotencyKey))
  }))

  routes.get('/:id', (c) => withLedgerErrors(c, () => c.json(
    getService().getTransaction(c.req.param('id')),
  )))

  routes.patch('/:id', (c) => withLedgerErrors(c, async () => {
    const body = await readLedgerJson(c)
    return c.json(getService().patchTransaction(c.req.param('id'), body))
  }))

  routes.delete('/:id', (c) => withLedgerErrors(c, async () => {
    const body = await readLedgerJson(c)
    return c.json(getService().deleteTransaction(c.req.param('id'), body))
  }))

  return routes
}

import { Hono } from 'hono'
import { parseIdempotencyKey, parseSettingsCreateRequest } from '../validation.js'
import {
  ledgerReplayResponse,
  readLedgerJson,
  withLedgerErrors,
  type LedgerServiceFactory,
} from './shared.js'

export function createSettingsRoutes(getService: LedgerServiceFactory): Hono {
  const routes = new Hono()

  routes.get('/', (c) => withLedgerErrors(c, () => c.json(getService().getSettings())))

  routes.post('/', (c) => withLedgerErrors(c, async () => {
    const request = parseSettingsCreateRequest(await readLedgerJson(c))
    const idempotencyKey = parseIdempotencyKey(c.req.header('Idempotency-Key'))
    return ledgerReplayResponse(c, getService().createSettings(request, idempotencyKey))
  }))

  routes.patch('/', (c) => withLedgerErrors(c, async () => {
    const body = await readLedgerJson(c)
    return c.json(getService().patchSettings(body))
  }))

  return routes
}

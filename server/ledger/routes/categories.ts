import { Hono } from 'hono'
import {
  parseBooleanQuery,
  parseCategoryCreateRequest,
  parseCategoryKind,
  parseIdempotencyKey,
} from '../validation.js'
import {
  ledgerReplayResponse,
  readLedgerJson,
  withLedgerErrors,
  type LedgerServiceFactory,
} from './shared.js'

export function createCategoryRoutes(getService: LedgerServiceFactory): Hono {
  const routes = new Hono()

  routes.get('/', (c) => withLedgerErrors(c, () => {
    const kindValue = c.req.query('kind')
    const kind = kindValue === undefined
      ? undefined
      : parseCategoryKind({ kind: kindValue })
    const includeArchived = parseBooleanQuery(
      c.req.query('includeArchived'),
      'includeArchived',
      false,
    )
    return c.json(getService().listCategories(kind, includeArchived))
  }))

  routes.post('/', (c) => withLedgerErrors(c, async () => {
    const request = parseCategoryCreateRequest(await readLedgerJson(c))
    const idempotencyKey = parseIdempotencyKey(c.req.header('Idempotency-Key'))
    return ledgerReplayResponse(c, getService().createCategory(request, idempotencyKey))
  }))

  routes.post('/:id/archive', (c) => withLedgerErrors(c, async () => {
    const body = await readLedgerJson(c)
    return c.json(getService().archiveCategory(c.req.param('id'), body))
  }))

  routes.post('/:id/restore', (c) => withLedgerErrors(c, async () => {
    const body = await readLedgerJson(c)
    return c.json(getService().restoreCategory(c.req.param('id'), body))
  }))

  routes.patch('/:id', (c) => withLedgerErrors(c, async () => {
    const body = await readLedgerJson(c)
    return c.json(getService().patchCategory(c.req.param('id'), body))
  }))

  routes.delete('/:id', (c) => withLedgerErrors(c, async () => {
    const body = await readLedgerJson(c)
    return c.json(getService().deleteCategory(c.req.param('id'), body))
  }))

  return routes
}

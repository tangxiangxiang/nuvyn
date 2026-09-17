import { Hono } from 'hono'
import {
  parseOverviewScope,
  parseOverviewAnchorDate,
  parseTrendMonths,
} from '../validation.js'
import {
  withLedgerErrors,
  type LedgerProjectionFactory,
} from './shared.js'

export function createProjectionRoutes(getProjections: LedgerProjectionFactory): Hono {
  const routes = new Hono()

  routes.get('/overview', (c) => withLedgerErrors(c, () => c.json(
    getProjections().getOverview({
      scope: parseOverviewScope(c.req.query('scope')),
      anchorDate: parseOverviewAnchorDate(c.req.query('anchorDate')),
    }),
  )))

  routes.get('/trend', (c) => withLedgerErrors(c, () => c.json(
    getProjections().getTrend(
      parseTrendMonths(c.req.query('months')),
      parseOverviewAnchorDate(c.req.query('anchorDate')),
    ),
  )))

  return routes
}

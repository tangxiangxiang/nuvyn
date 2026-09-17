import { Hono } from 'hono'
import { createAccountRoutes } from './accounts.js'
import { createCategoryRoutes } from './categories.js'
import { createSettingsRoutes } from './settings.js'
import { createTransactionRoutes } from './transactions.js'
import { createProjectionRoutes } from './projections.js'
import {
  ledgerProjectionsForRequest,
  ledgerServiceForRequest,
  type LedgerProjectionFactory,
  type LedgerServiceFactory,
} from './shared.js'

export function createLedgerRoutes(
  getService: LedgerServiceFactory = ledgerServiceForRequest,
  getProjections: LedgerProjectionFactory = ledgerProjectionsForRequest,
): Hono {
  const routes = new Hono()
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    await next()
  })
  routes.route('/settings', createSettingsRoutes(getService))
  routes.route('/accounts', createAccountRoutes(getService, getProjections))
  routes.route('/categories', createCategoryRoutes(getService))
  routes.route('/transactions', createTransactionRoutes(getService, getProjections))
  routes.route('/', createProjectionRoutes(getProjections))
  return routes
}

const ledgerRoutes = createLedgerRoutes()

export default ledgerRoutes

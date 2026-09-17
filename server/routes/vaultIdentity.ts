import { Hono } from 'hono'
import { getVaultId } from '../vaultIdentity.js'

const vaultIdentityRoutes = new Hono()

vaultIdentityRoutes.get('/api/vault/identity', (c) => c.json({ vaultId: getVaultId() }))

export default vaultIdentityRoutes

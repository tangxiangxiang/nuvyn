import { Hono } from 'hono'

const healthRoutes = new Hono()

// Public liveness only. Stable vault identity is deliberately protected by
// /api/vault/identity so anonymous health probes cannot enumerate it.
healthRoutes.get('/api/health', (c) => c.json({ ok: true }))

export default healthRoutes

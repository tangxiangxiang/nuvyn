import { Hono } from 'hono'
import { getDb } from '../db.js'
import type { AiProfileInput } from '../../shared/aiProfiles.js'
import { AiKeyConfigurationError, AiSettingsValidationError } from './settings.js'
import { AiConnectionError, probeAiConnection } from './llm.js'
import { activateAiProfile, AiProfileError, createAiProfile, deleteAiProfile, initializeAiProfiles, listAiProfiles, profileProbeConfig, updateAiProfile } from './profiles.js'

const profiles = new Hono()
profiles.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  await next()
})
profiles.onError((error, c) => {
  if (error instanceof AiProfileError) return c.json({ error: error.message, code: error.code }, error.status as 400 | 404 | 409 | 503)
  if (error instanceof AiKeyConfigurationError) return c.json({ error: error.message, code: error.code }, 503)
  if (error instanceof AiSettingsValidationError) return c.json({ error: error.message, code: error.code }, 400)
  // Database/SDK diagnostics must not echo credentials or SQL bound values.
  return c.json({ error: 'AI profile operation failed' }, 500)
})

async function input(request: { json: () => Promise<unknown> }): Promise<AiProfileInput> {
  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AiProfileError('ai-profile-invalid', 'Object body required')
  const value = body as Record<string, unknown>
  const fields = ['name', 'provider', 'apiKey', 'baseURL', 'model', 'clearKey', 'confirmProviderChange']
  for (const [key, field] of Object.entries(value)) {
    if (!fields.includes(key) || typeof field !== (key === 'clearKey' || key === 'confirmProviderChange' ? 'boolean' : 'string')) {
      throw new AiProfileError('ai-profile-invalid', 'Invalid profile fields')
    }
  }
  if (value.clearKey && typeof value.apiKey === 'string' && value.apiKey.trim()) throw new AiProfileError('ai-profile-invalid', 'Cannot replace and clear the same credential')
  return value as AiProfileInput
}
profiles.get('/', (c) => c.json(listAiProfiles(getDb())))
// Explicit recovery after an operator has restored the original master key.
// Ordinary GET requests never repeatedly retry a failed credential conversion.
profiles.post('/retry-migration', (c) => {
  initializeAiProfiles(getDb(), true)
  return c.json(listAiProfiles(getDb()))
})
profiles.post('/', async (c) => c.json(createAiProfile(getDb(), await input(c.req)), 201))
profiles.patch('/:id', async (c) => c.json(updateAiProfile(getDb(), c.req.param('id'), await input(c.req))))
profiles.put('/:id/activate', (c) => {
  activateAiProfile(getDb(), c.req.param('id'))
  return c.json({ activeProfileId: c.req.param('id') })
})
profiles.delete('/:id', async (c) => {
  const body = await c.req.json().catch(() => ({})) as { disableDefault?: unknown }
  deleteAiProfile(getDb(), c.req.param('id'), body?.disableDefault === true)
  return c.json({ deleted: true })
})
for (const path of ['/test-connection', '/:id/test-connection']) {
  profiles.post(path, async (c) => {
    const config = profileProbeConfig(getDb(), c.req.param('id'), await input(c.req))
    const startedAt = Date.now()
    try {
      await probeAiConnection(config, c.req.raw.signal)
      return c.json({ ok: true, provider: config.provider, model: config.model,
        checkedAt: Date.now(), latencyMs: Math.max(0, Date.now() - startedAt) })
    } catch (error) {
      if (!(error instanceof AiConnectionError)) throw error
      const status = error.code === 'ai-authentication-failed' ? 401 : error.code === 'ai-connection-timeout' ? 504 : 502
      return c.json({ error: error.message.split(config.apiKey).join('[redacted]').slice(0, 4000), code: error.code }, status)
    }
  })
}
export default profiles

import Database from 'better-sqlite3'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { applyMigrations } from '../db'
import { activateAiProfile, createAiProfile, initializeAiProfiles } from '../ai/profiles'
const state = vi.hoisted(() => ({ db: null as Database.Database | null, probe: vi.fn() }))
vi.mock('../db', async (original) => ({ ...await original<typeof import('../db')>(), getDb: () => state.db! }))
vi.mock('../ai/llm', async (original) => ({ ...await original<typeof import('../ai/llm')>(), probeAiConnection: (...args: unknown[]) => state.probe(...args) }))
import ai from '../ai/routes'
import { AiConnectionError } from '../ai/llm'

const previous = process.env.NUVYN_MASTER_KEY
beforeEach(() => {
  process.env.NUVYN_MASTER_KEY = '77'.repeat(32)
  state.db = new Database(':memory:')
  applyMigrations(state.db)
  initializeAiProfiles(state.db)
  state.probe.mockReset().mockResolvedValue(undefined)
})
afterEach(() => {
  state.db!.close()
  if (previous === undefined) delete process.env.NUVYN_MASTER_KEY
  else process.env.NUVYN_MASTER_KEY = previous
})
const call = (method: string, url: string, body?: unknown) => ai.request(url, { method, headers: body ? { 'content-type': 'application/json' } : undefined, ...(body ? { body: JSON.stringify(body) } : {}) })
function add(name: string, provider: 'openai' | 'anthropic' = 'anthropic') {
  return createAiProfile(state.db!, { name, provider, apiKey: `sk-${name}-secret`, baseURL: 'https://example.test/v1', model: 'custom-model' })
}

describe('AI Profile HTTP contract', () => {
  it('creates and lists same-protocol profiles without exposing credentials or changing default', async () => {
    for (const name of ['A', 'B']) {
      const r = await call('POST', '/profiles', { name, provider: 'anthropic', apiKey: `sk-${name}-secret` })
      expect(r.status).toBe(201)
      expect(await r.json()).toMatchObject({ name, configured: true, maskedKey: '••••••••' })
    }
    const r = await call('GET', '/profiles')
    expect(r.headers.get('cache-control')).toBe('no-store')
    const body = await r.json()
    expect(body.profiles).toHaveLength(2)
    expect(body.activeProfileId).toBeNull()
    expect(JSON.stringify(body)).not.toContain('secret')
  })
  it.each([{ name: '' }, { name: 'x'.repeat(101) }, { name: 'A', provider: 'other' }, { name: 'A', provider: 'openai', model: 'bad name' }, { name: 'A', provider: 'anthropic', baseURL: 'javascript:alert(1)' }, { name: 'A', provider: 'openai', baseURL: 'https://example.test/chat/completions' }, { name: 'A', provider: 'anthropic', apiKey: 123 }, { name: 'A', provider: 'anthropic', clearKey: 'yes' }, { name: 'A', provider: 'anthropic', apiKey: 'x'.repeat(257) }])('validates untrusted input %#', async (data) => {
    expect((await call('POST', '/profiles', data)).status).toBe(400)
    expect((await (await call('GET', '/profiles')).json()).profiles).toHaveLength(0)
  })
  it('activates explicitly, rejects default deletion, and only disables default with consent', async () => {
    const a = add('A'), b = add('B')
    expect((await call('PUT', `/profiles/${a.id}/activate`)).status).toBe(200)
    expect((await call('DELETE', `/profiles/${a.id}`)).status).toBe(409)
    expect((await call('DELETE', `/profiles/${b.id}`)).status).toBe(200)
    expect((await call('DELETE', `/profiles/${a.id}`, { disableDefault: true })).status).toBe(200)
    expect((await (await call('GET', '/profiles')).json()).activeProfileId).toBeNull()
    expect((await call('PATCH', '/profiles/missing', { name: 'X' })).status).toBe(404)
    expect((await call('PUT', '/profiles/missing/activate')).status).toBe(404)
    expect((await call('DELETE', '/profiles/missing')).status).toBe(404)
  })
  it('does not reuse another profile key for a probe or change any persistent state', async () => {
    const a = add('A'), b = add('B')
    activateAiProfile(state.db!, b.id)
    const before = state.db!.serialize()
    const r = await call('POST', `/profiles/${a.id}/test-connection`, { model: 'unsaved' })
    expect(r.status).toBe(200)
    expect(state.probe).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-A-secret', model: 'unsaved' }), expect.any(AbortSignal))
    expect(state.db!.serialize()).toEqual(before)
    const unsaved = await call('POST', '/profiles/test-connection', { provider: 'openai', apiKey: 'sk-transient', model: 'new' })
    expect(unsaved.status).toBe(200)
    expect(state.probe).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: 'sk-transient', provider: 'openai' }), expect.any(AbortSignal))
    expect(state.db!.serialize()).toEqual(before)
    expect((await call('POST', `/profiles/${a.id}/test-connection`, { provider: 'openai' })).status).toBe(409)
  })
  it.each(['ai-authentication-failed', 'ai-connection-timeout', 'ai-model-unavailable', 'openai-tools-unsupported'] as const)('preserves safe probe errors: %s', async (code) => {
    const a = add('A')
    state.probe.mockRejectedValueOnce(new AiConnectionError(code, 'Failed with sk-A-secret'))
    const r = await call('POST', `/profiles/${a.id}/test-connection`, {})
    const body = await r.json()
    expect(body.code).toBe(code)
    expect(body.error).not.toContain('sk-A-secret')
    expect(body.error).toContain('[redacted]')
  })
  it('lists metadata and explicitly clears only the affected credential when the master key is wrong', async () => {
    const a = add('A'), b = add('B')
    process.env.NUVYN_MASTER_KEY = '88'.repeat(32)
    const r = await call('GET', '/profiles')
    expect(r.status).toBe(200)
    expect((await r.json()).profiles[0].credentialError).toBe('master-key-invalid')
    expect((await call('PATCH', `/profiles/${a.id}`, { clearKey: true })).status).toBe(200)
    expect((await (await call('GET', '/profiles')).json()).profiles.find((p: { id: string }) => p.id === b.id).configured).toBe(true)
  })
  it('keeps the compatibility GET and credential status but safely rejects ambiguous legacy writes and probes', async () => {
    const a = add('A')
    add('B')
    activateAiProfile(state.db!, a.id)
    const before = state.db!.serialize()
    expect((await call('GET', '/settings')).status).toBe(200)
    expect((await call('GET', '/settings/credential-status')).status).toBe(200)
    expect((await call('PUT', '/settings', { provider: 'anthropic', model: 'wrong' })).status).toBe(409)
    expect((await call('PUT', '/settings', { model: 'wrong' })).status).toBe(409)
    expect((await call('DELETE', '/settings/key?provider=anthropic')).status).toBe(409)
    expect((await call('POST', '/settings/test-connection', { provider: 'anthropic' })).status).toBe(409)
    expect(state.db!.serialize()).toEqual(before)
  })
})

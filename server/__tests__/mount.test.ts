// Smoke test: hit the AI sub-router through the real `app` to
// confirm server/index.ts mounts it correctly at /api/ai. This
// The route-mounting assertion does not need a production database.
// Use one isolated in-memory database per test so parallel test files
// cannot contend over ./data/nuvyn.db on Windows.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'

const { testDbRef } = vi.hoisted(() => ({
  testDbRef: { value: null as Database.Database | null },
}))

vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>()
  return {
    ...actual,
    getDb: () => testDbRef.value!,
  }
})

vi.mock('../ai/chat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ai/chat')>()
  return {
    ...actual,
    runChat: vi.fn(async ({ onEvent }: any) => {
      await onEvent({ type: 'user', id: 1 })
      await onEvent({ type: 'token', text: 'ok' })
      await onEvent({ type: 'done', userId: 1, assistantId: 2 })
      return { userId: 1, assistantId: 2, fullText: 'ok' }
    }),
  }
})

import app from '../index'
import { applyMigrations } from '../db'
import { closeAuthTestContext, createAuthenticatedTestContext, withAuthCookie, type AuthenticatedTestContext } from './helpers/auth'

const originalMasterKey = process.env.NUVYN_MASTER_KEY
process.env.NUVYN_MASTER_KEY = '11'.repeat(32)
let auth: AuthenticatedTestContext

beforeEach(() => {
  process.env.NUVYN_MASTER_KEY = '11'.repeat(32)
  const db = new Database(':memory:')
  applyMigrations(db)
  testDbRef.value = db
  auth = createAuthenticatedTestContext({ db })
})

afterEach(() => {
  closeAuthTestContext(auth)
  testDbRef.value?.close()
  testDbRef.value = null
  if (originalMasterKey === undefined) delete process.env.NUVYN_MASTER_KEY
  else process.env.NUVYN_MASTER_KEY = originalMasterKey
})

describe('app mounts /api/ai', () => {
  it('GET /api/ai/sessions reaches the AI sub-router (returns 200 + [])', async () => {
    const req = withAuthCookie(auth, new Request('http://localhost/api/ai/sessions'))
    const r = await app.fetch(req)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual([])
  })

  it('GET /api/ai/health on the parent app also works (sanity)', async () => {
    // The liveness route remains public after the application boundary;
    // stable vault identity is intentionally covered by the protected
    // /api/vault/identity test in auth-middleware.test.ts.
    const req = new Request('http://localhost/api/health')
    const r = await app.fetch(req)
    expect(r.status).toBe(200)
    const body = await r.json() as { ok: boolean; vaultId?: string }
    expect(body.ok).toBe(true)
    expect(body).not.toHaveProperty('vaultId')
  })
})

describe('app mounts /api/ai/chat', () => {
  // Settings live in the DB — this describe block seeds the
  // out-of-band master key and the route reads the API key from SQLite.
  // from the DB, but other tests in this file rely on the chat route
  // finding some configured key (otherwise it would 503 before we
  // exercise streaming). We seed the DB-backed settings instead.
  // (No setup needed here — each test that needs a key writes via
  // PUT /api/ai/settings or relies on a sibling test having done so.)

  it('POST /api/ai/chat returns a text/event-stream response', async () => {
    // Seed DB-backed API key — settings live entirely in the DB now.
    await app.fetch(withAuthCookie(auth, new Request('http://localhost/api/ai/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'sk-ant-test-key' }),
    })))
    // Create a session first.
    const created = await app.fetch(withAuthCookie(auth, new Request('http://localhost/api/ai/sessions', { method: 'POST' })))
    const { id } = await created.json() as { id: number }
    const r = await app.fetch(withAuthCookie(auth, new Request('http://localhost/api/ai/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: id, content: 'hi' }),
    })))
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toMatch(/text\/event-stream/)
    const text = await r.text()
    expect(text).toContain('event: user')
    expect(text).toContain('event: done')
  })
})

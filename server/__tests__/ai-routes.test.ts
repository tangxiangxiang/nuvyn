// HTTP-level tests for the /api/ai sub-router. We mock ../db's
// getDb() to return a fresh in-memory DB per test — the on-disk
// ./data/nuvyn.db is never touched. The mock uses vi.mock with a
// vi.hoisted handle so the factory can close over the test DB
// reference (vi.mock is hoisted above top-level imports).
import { existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { applyMigrations } from '../db'
import * as aiSessions from '../ai/sessions'

// vi.hoisted runs synchronously before imports are resolved, so the
// factory must be sync. Only `testDbRef` lives in the hoisted scope
// (the mock factory closes over it); `applyMigrations` is imported
// directly because it does not depend on the mocked getDb.
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

// Import AFTER vi.mock so ai/routes.ts picks up the mocked getDb.
import aiRoutes from '../ai/routes'

const TEST_MASTER_KEY = '11'.repeat(32)
const originalMasterKey = process.env.NUVYN_MASTER_KEY
const originalMasterKeyFile = process.env.NUVYN_MASTER_KEY_FILE

async function withIsolatedCwd(run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'nuvyn-ai-routes-'))
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root)
  try {
    await run(root)
  } finally {
    cwd.mockRestore()
    rmSync(root, { recursive: true, force: true })
  }
}

beforeEach(() => {
  // The test key is injected out-of-band just like production. It is
  // deliberately not written into the SQLite settings table.
  process.env.NUVYN_MASTER_KEY = TEST_MASTER_KEY
  delete process.env.NUVYN_MASTER_KEY_FILE
  const db = new Database(':memory:')
  applyMigrations(db)
  testDbRef.value = db
})

afterEach(() => {
  testDbRef.value?.close()
  testDbRef.value = null
  if (originalMasterKey === undefined) delete process.env.NUVYN_MASTER_KEY
  else process.env.NUVYN_MASTER_KEY = originalMasterKey
  if (originalMasterKeyFile === undefined) delete process.env.NUVYN_MASTER_KEY_FILE
  else process.env.NUVYN_MASTER_KEY_FILE = originalMasterKeyFile
})

async function call(method: string, urlPath: string, body?: unknown) {
  const req = new Request(`http://localhost${urlPath}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  return aiRoutes.fetch(req)
}

describe('GET /api/ai/sessions', () => {
  it('returns an empty array when no sessions exist', async () => {
    const r = await call('GET', '/sessions')
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual([])
  })

  it('returns all sessions newest-first', async () => {
    // Create two sessions, sleep a tick, create a third.
    await call('POST', '/sessions')
    await new Promise((r) => setTimeout(r, 2))
    await call('POST', '/sessions')
    const r = await call('GET', '/sessions')
    const list = await r.json() as { id: number }[]
    expect(list).toHaveLength(2)
    expect(list[0].id).toBeGreaterThan(list[1].id)
  })
})

describe('POST /api/ai/slug', () => {
  it('validates the request body', async () => {
    const r = await call('POST', '/slug', { input: '第一性原理', kind: 'note' })
    expect(r.status).toBe(400)
  })

  it('returns 503 when AI auth is not configured', async () => {
    const r = await call('POST', '/slug', { input: '第一性原理', kind: 'file' })
    expect(r.status).toBe(503)
  })
})

describe('POST /api/ai/sessions', () => {
  it('creates a session and returns it with status 201', async () => {
    const r = await call('POST', '/sessions')
    expect(r.status).toBe(201)
    const body = await r.json() as { id: number; title: string }
    expect(body.id).toBeGreaterThan(0)
    expect(body.title).toBe('')
  })
})

describe('PATCH /api/ai/sessions/:id', () => {
  it('renames a session and returns it', async () => {
    const created = (await (await call('POST', '/sessions')).json()) as { id: number }
    const r = await call('PATCH', `/sessions/${created.id}`, { title: 'New name' })
    expect(r.status).toBe(200)
    const body = await r.json() as { title: string }
    expect(body.title).toBe('New name')
  })

  it('returns 400 when the title is empty after trim', async () => {
    const created = (await (await call('POST', '/sessions')).json()) as { id: number }
    const r = await call('PATCH', `/sessions/${created.id}`, { title: '   ' })
    expect(r.status).toBe(400)
  })

  it('returns 404 for a non-existent session', async () => {
    const r = await call('PATCH', '/sessions/999', { title: 'New name' })
    expect(r.status).toBe(404)
  })
})

describe('DELETE /api/ai/sessions/:id', () => {
  it('deletes a session and returns { ok: true }', async () => {
    const created = (await (await call('POST', '/sessions')).json()) as { id: number }
    const r = await call('DELETE', `/sessions/${created.id}`)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true })
  })

  it('returns 404 for a non-existent session', async () => {
    const r = await call('DELETE', '/sessions/999')
    expect(r.status).toBe(404)
  })
})

describe('GET /api/ai/sessions/:id/messages', () => {
  it('returns an empty array for a new session', async () => {
    const created = (await (await call('POST', '/sessions')).json()) as { id: number }
    const r = await call('GET', `/sessions/${created.id}/messages`)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual([])
  })

  it('returns 404 for a non-existent session', async () => {
    const r = await call('GET', '/sessions/999/messages')
    expect(r.status).toBe(404)
  })

  it('rehydrates a persisted tool envelope into content+blocks, hiding the raw envelope string', async () => {
    // Regression: a tool-using assistant turn is stored as a JSON
    // envelope in the `content` column. Without rehydration the API
    // would return that raw string and the panel would render JSON
    // instead of the bubble text. The streaming code path also
    // produces content+blocks in memory, so the response shape
    // here matches what the client sees during a live turn.
    const created = (await (await call('POST', '/sessions')).json()) as { id: number }
    const envelope = JSON.stringify({
      v: 1,
      text: 'I read the file.',
      rounds: [[{ type: 'text', text: 'I read the file.' }]],
      toolCalls: [
        { id: 't1', name: 'read_file', input: { path: 'foo' }, result: { content: '...', is_error: false } },
      ],
    })
    // Insert directly to simulate the chat orchestrator's write
    // path (appendMessage would happily accept the JSON string, but
    // the read-path test is the one that matters here).
    testDbRef.value!
      .prepare('INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)')
      .run(created.id, 'assistant', envelope, Date.now())

    const r = await call('GET', `/sessions/${created.id}/messages`)
    expect(r.status).toBe(200)
    const list = await r.json() as Array<{ role: string; content: string; blocks?: unknown }>
    expect(list).toHaveLength(1)
    expect(list[0].role).toBe('assistant')
    expect(list[0].content).toBe('I read the file.')
    expect(list[0].blocks).toEqual({
      v: 1,
      text: 'I read the file.',
      toolCalls: [
        { id: 't1', name: 'read_file', input: { path: 'foo' }, result: { content: '...', is_error: false } },
      ],
    })
    // The `rounds` field is server-internal and must not leak
    // through the API response.
    expect((list[0].blocks as any).rounds).toBeUndefined()
  })

  it('leaves a plain assistant message without a blocks field', async () => {
    const created = (await (await call('POST', '/sessions')).json()) as { id: number }
    await call('POST', `/sessions/${created.id}/messages`, { role: 'assistant', content: 'plain reply' })
    const r = await call('GET', `/sessions/${created.id}/messages`)
    const list = await r.json() as Array<{ content: string; blocks?: unknown }>
    expect(list[0].content).toBe('plain reply')
    expect(list[0].blocks).toBeUndefined()
  })
})

describe('GET /api/ai/thread', () => {
  it('returns only the bounded recent window after compaction and retains raw history', async () => {
    const scope = {
      kind: 'document' as const,
      vaultId: 'vault-a',
      documentId: 'doc-a',
      path: 'notes/a.md',
      title: 'A note',
    }
    const thread = aiSessions.ensureAiThread(testDbRef.value!, scope)
    const insert = testDbRef.value!.prepare(
      'INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)'
    )
    for (let i = 1; i <= 100; i += 1) {
      insert.run(thread.session.id, i % 2 ? 'user' : 'assistant', `message-${i}`, i)
    }
    expect(aiSessions.saveAiThreadCompaction(testDbRef.value!, thread.session.id, 0, 20, 'summary')).toBe(true)

    const url = `/thread?scope=${encodeURIComponent(JSON.stringify(scope))}`
    const response = await call('GET', url)
    expect(response.status).toBe(200)
    const body = await response.json() as { messages: Array<{ id: number; content: string }> }
    expect(body.messages).toHaveLength(40)
    expect(body.messages[0]).toMatchObject({ id: 61, content: 'message-61' })
    expect(body.messages.at(-1)).toMatchObject({ id: 100, content: 'message-100' })
    expect(testDbRef.value!.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?')
      .get(thread.session.id)).toEqual({ count: 100 })
  })
})

describe('POST /api/ai/sessions/:id/messages', () => {
  it('appends a user message and returns the saved message', async () => {
    const created = (await (await call('POST', '/sessions')).json()) as { id: number }
    const r = await call('POST', `/sessions/${created.id}/messages`, { role: 'user', content: 'hello' })
    expect(r.status).toBe(201)
    const body = await r.json() as { id: number; role: string; content: string }
    expect(body.content).toBe('hello')
    expect(body.role).toBe('user')
  })

  it('returns 400 for empty content', async () => {
    const created = (await (await call('POST', '/sessions')).json()) as { id: number }
    const r = await call('POST', `/sessions/${created.id}/messages`, { role: 'user', content: '   ' })
    expect(r.status).toBe(400)
  })

  it('returns 400 for an invalid role', async () => {
    const created = (await (await call('POST', '/sessions')).json()) as { id: number }
    const r = await call('POST', `/sessions/${created.id}/messages`, { role: 'system', content: 'x' })
    expect(r.status).toBe(400)
  })

  it('returns 404 for a non-existent session', async () => {
    const r = await call('POST', '/sessions/999/messages', { role: 'user', content: 'x' })
    expect(r.status).toBe(404)
  })
})

describe('GET/PUT /api/ai/settings', () => {
  it('saves DB settings and returns a masked key', async () => {
    const r = await call('PUT', '/settings', {
      apiKey: 'sk-ant-test-123456',
      baseURL: 'https://proxy.example.com',
      model: 'claude-test',
    })
    expect(r.status).toBe(200)
    const body = await r.json() as {
      configured: boolean
      source: string
      maskedKey: string
      baseURL: string
      model: string
      apiKey?: string
    }
    expect(body.configured).toBe(true)
    expect(body.source).toBe('db')
    // maskKey() shows first 8 + '...' + last 8 — input is
    // `sk-ant-test-123456` (18 chars), so the mask is
    // `sk-ant-t...t-123456`. The middle two chars stay hidden.
    expect(body.maskedKey).toBe('sk-ant-t...t-123456')
    expect(body.baseURL).toBe('https://proxy.example.com')
    expect(body.model).toBe('claude-test')
    expect(body.apiKey).toBeUndefined()
  })

  it('clears only the stored API key', async () => {
    await call('PUT', '/settings', {
      apiKey: 'sk-ant-test-123456',
      baseURL: 'https://proxy.example.com',
      model: 'claude-test',
    })
    const r = await call('DELETE', '/settings/key')
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ cleared: true, provider: 'anthropic' })
    const view = await (await call('GET', '/settings')).json() as { configured: boolean; source: string; maskedKey: string; baseURL: string; model: string }
    expect(view.configured).toBe(false)
    expect(view.source).toBe('none')
    expect(view.maskedKey).toBe('')
    expect(view.baseURL).toBe('https://proxy.example.com')
    expect(view.model).toBe('claude-test')
  })

  it('clears a selected provider without decrypting when the fallback key is missing', async () => {
    await withIsolatedCwd(async (root) => {
      delete process.env.NUVYN_MASTER_KEY
      await call('PUT', '/settings', { provider: 'anthropic', apiKey: 'sk-ant-unrecoverable' })
      await call('PUT', '/settings', { provider: 'openai', apiKey: 'sk-openai-unrecoverable' })
      const fallbackFile = path.join(root, 'data', '.nuvyn-master-key')
      const openAiCiphertext = testDbRef.value!.prepare('SELECT value FROM settings WHERE key = ?').get('ai.openai.apiKey') as { value: string }
      expect(existsSync(fallbackFile)).toBe(true)
      unlinkSync(fallbackFile)

      const r = await call('DELETE', '/settings/key?provider=anthropic')
      expect(r.status).toBe(200)
      expect(await r.json()).toEqual({ cleared: true, provider: 'anthropic' })
      expect(existsSync(fallbackFile)).toBe(false)
      expect((testDbRef.value!.prepare('SELECT value FROM settings WHERE key = ?').get('ai.anthropic.apiKey') as { value?: string } | undefined)?.value).toBeUndefined()
      expect((testDbRef.value!.prepare('SELECT value FROM settings WHERE key = ?').get('ai.openai.apiKey') as { value: string }).value).toBe(openAiCiphertext.value)

      const failed = await call('GET', '/settings')
      expect(failed.status).toBe(503)
      expect(await failed.json()).toMatchObject({ code: 'master-key-required' })
    })
  })

  it('rejects an invalid provider for credential deletion', async () => {
    const r = await call('DELETE', '/settings/key?provider=gemini')
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({ error: 'provider must be one of: anthropic, openai' })
  })

  it('treats clearing an absent provider credential as an idempotent success', async () => {
    const r = await call('DELETE', '/settings/key?provider=openai')
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ cleared: true, provider: 'openai' })
  })

  it('returns stable master-key error codes from settings reads', async () => {
    await call('PUT', '/settings', { apiKey: 'sk-ant-code-test' })
    delete process.env.NUVYN_MASTER_KEY
    process.env.NUVYN_MASTER_KEY_FILE = path.join(tmpdir(), 'nuvyn-missing-master-key')

    const r = await call('GET', '/settings')
    expect(r.status).toBe(503)
    const body = await r.json() as { error: string; code: string }
    expect(body.code).toBe('master-key-file-unreadable')
    expect(body.error).not.toContain('sk-ant-code-test')
  })

  it('returns master-key-invalid for an explicitly wrong key', async () => {
    await call('PUT', '/settings', { apiKey: 'sk-ant-wrong-key-test' })
    process.env.NUVYN_MASTER_KEY = '33'.repeat(32)

    const r = await call('GET', '/settings')
    expect(r.status).toBe(503)
    expect(await r.json()).toMatchObject({ code: 'master-key-invalid' })
  })

  it('keeps the structured code on active and chat preflight failures', async () => {
    await withIsolatedCwd(async (root) => {
      delete process.env.NUVYN_MASTER_KEY
      await call('PUT', '/settings', { apiKey: 'sk-ant-preflight-test' })
      unlinkSync(path.join(root, 'data', '.nuvyn-master-key'))

      const active = await call('GET', '/active')
      expect(active.status).toBe(503)
      expect(await active.json()).toMatchObject({ code: 'master-key-required' })

      const chat = await call('POST', '/chat', { sessionId: 1, content: 'hello' })
      expect(chat.status).toBe(503)
      expect(await chat.json()).toMatchObject({ code: 'master-key-required' })
    })
  })

  it('reports credential status without requiring a master key', async () => {
    await call('PUT', '/settings', { provider: 'openai', apiKey: 'sk-openai-status-test' })
    const r = await call('GET', '/settings/credential-status')
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({
      provider: 'openai',
      providers: { anthropic: { stored: false }, openai: { stored: true } },
    })
  })

  it('saves OpenAI config independently of Anthropic config', async () => {
    // Seed both providers. Keys need to be >16 chars to exercise the
    // head+tail mask branch (maskKey returns bullets for short keys).
    await call('PUT', '/settings', { provider: 'anthropic', apiKey: 'sk-ant-api03-aaaaaaaaaaaa', model: 'claude-x' })
    await call('PUT', '/settings', { provider: 'openai', apiKey: 'sk-openai-bbbbbbbbbbbbbbb', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o' })

    // Switch back to anthropic and verify only its config is exposed.
    await call('PUT', '/settings', { provider: 'anthropic' })
    const antBody = await (await call('GET', '/settings')).json() as { provider: string; maskedKey: string; baseURL: string; model: string }
    expect(antBody.provider).toBe('anthropic')
    // maskKey uses first 8 + ... + last 8 of 'sk-ant-api03-aaaaaaaaaaaa'
    // (24 chars): 'sk-ant-a' + ... + 'aaaaaaaa'
    expect(antBody.maskedKey).toBe('sk-ant-a...aaaaaaaa')
    expect(antBody.baseURL).toBe('')
    expect(antBody.model).toBe('claude-x')

    // Switch to openai and verify its config is intact.
    await call('PUT', '/settings', { provider: 'openai' })
    const oaBody = await (await call('GET', '/settings')).json() as { provider: string; maskedKey: string; baseURL: string; model: string }
    expect(oaBody.provider).toBe('openai')
    // maskKey of 'sk-openai-bbbbbbbbbbbbbbb' (24 chars):
    // first 8 = 'sk-opena', last 8 = 'bbbbbbbb'
    expect(oaBody.maskedKey).toBe('sk-opena...bbbbbbbb')
    expect(oaBody.baseURL).toBe('https://api.openai.com/v1')
    expect(oaBody.model).toBe('gpt-4o')
  })

  it('normalizes an OpenAI API-root Base URL and rejects a full endpoint', async () => {
    const normalized = await call('PUT', '/settings', {
      provider: 'openai',
      baseURL: ' https://gateway.example/openai/v1/// ',
    })
    expect(normalized.status).toBe(200)
    expect((await normalized.json() as { baseURL: string }).baseURL)
      .toBe('https://gateway.example/openai/v1')

    const rejected = await call('PUT', '/settings', {
      provider: 'openai',
      baseURL: 'https://gateway.example/openai/v1/chat/completions',
    })
    expect(rejected.status).toBe(400)
    expect(await rejected.json()).toMatchObject({ code: 'openai-base-url-invalid' })
  })

  it('rejects an unknown provider value', async () => {
    const r = await call('PUT', '/settings', { provider: 'gemini' })
    expect(r.status).toBe(400)
  })

  it('switches active provider without touching other fields', async () => {
    await call('PUT', '/settings', { provider: 'anthropic', apiKey: 'sk-ant-pp', model: 'claude-pp' })
    const r = await call('PUT', '/settings', { provider: 'openai' })
    expect(r.status).toBe(200)
    const body = await r.json() as { provider: string; configured: boolean; maskedKey: string; model: string }
    expect(body.provider).toBe('openai')
    // OpenAI had no key saved yet → configured: false, maskedKey empty.
    expect(body.configured).toBe(false)
    expect(body.maskedKey).toBe('')
    // Anthropic's saved config stays intact server-side.
    expect(body.model).toBe('gpt-4o')  // openai default
  })

  it('rejects unreasonable AI settings input', async () => {
    const longKey = await call('PUT', '/settings', { apiKey: 'x'.repeat(257) })
    expect(longKey.status).toBe(400)

    const badUrl = await call('PUT', '/settings', { baseURL: 'not a url' })
    expect(badUrl.status).toBe(400)

    const badProtocol = await call('PUT', '/settings', { baseURL: 'ftp://example.com' })
    expect(badProtocol.status).toBe(400)

    const badModel = await call('PUT', '/settings', { model: 'claude test' })
    expect(badModel.status).toBe(400)

    const shellMeta = await call('PUT', '/settings', { model: 'claude;rm -rf /' })
    expect(shellMeta.status).toBe(400)
  })

  it('accepts model names with brackets, slashes, and version tags', async () => {
    // Regression for the `MiniMax-M3[1m]` case (and similar version-tag
    // naming conventions). The character allow-list must permit
    // brackets and slashes while still rejecting shell metacharacters.
    const bracket = await call('PUT', '/settings', { model: 'MiniMax-M3[1m]' })
    expect(bracket.status).toBe(200)

    const slashed = await call('PUT', '/settings', { model: 'anthropic/claude-3' })
    expect(slashed.status).toBe(200)

    const coloned = await call('PUT', '/settings', { model: 'claude-3.5:onnet' })
    expect(coloned.status).toBe(200)
  })
})

describe('GET /api/ai/active', () => {
  it('returns { activeId: null, configured: true } when DB API key is set and no active session', async () => {
    await call('PUT', '/settings', { apiKey: 'sk-ant-test-key' })
    const r = await call('GET', '/active')
    expect(r.status).toBe(200)
    const body = await r.json() as { activeId: number | null; configured: boolean }
    expect(body.activeId).toBeNull()
    expect(body.configured).toBe(true)
  })

  it('reports configured: false when no DB API key is set', async () => {
    const r = await call('GET', '/active')
    const body = await r.json() as { configured: boolean }
    expect(body.configured).toBe(false)
  })

  it('reports configured: true when the DB API key is set', async () => {
    await call('PUT', '/settings', { apiKey: 'sk-ant-db-123456' })
    const r = await call('GET', '/active')
    const body = await r.json() as { configured: boolean }
    expect(body.configured).toBe(true)
  })

  it('reports configured: false after clearing the DB API key', async () => {
    await call('PUT', '/settings', { apiKey: 'sk-ant-db-123456' })
    await call('DELETE', '/settings/key')
    const r = await call('GET', '/active')
    const body = await r.json() as { configured: boolean }
    expect(body.configured).toBe(false)
  })
})

describe('PUT /api/ai/active', () => {
  it('sets the active session and round-trips on GET', async () => {
    const created = (await (await call('POST', '/sessions')).json()) as { id: number }
    const r = await call('PUT', '/active', { sessionId: created.id })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ sessionId: created.id })

    const get = await call('GET', '/active')
    const getBody = await get.json() as { activeId: number | null; configured: boolean; activeSession?: { id: number; title: string } }
    expect(getBody.activeId).toEqual(created.id)
    expect(getBody.activeSession).toMatchObject({ id: created.id, title: '' })
  })

  it('clears the active session when sessionId is null', async () => {
    const created = (await (await call('POST', '/sessions')).json()) as { id: number }
    await call('PUT', '/active', { sessionId: created.id })
    const r = await call('PUT', '/active', { sessionId: null })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ sessionId: null })
  })

  it('returns 400 when sessionId is not a number or null', async () => {
    const r = await call('PUT', '/active', { sessionId: 'abc' })
    expect(r.status).toBe(400)
  })

  it('returns 404 when sessionId points to a non-existent session', async () => {
    const r = await call('PUT', '/active', { sessionId: 999 })
    expect(r.status).toBe(404)
  })
})

import * as chatModule from '../ai/chat'
import { ChatError } from '../ai/errors'

// We mock runChat so the route test doesn't drag in the SDK or
// need a real DB session for the chat flow. The mock emits the
// expected events: a user id, two tokens, and a done with both ids.
vi.mock('../ai/chat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ai/chat')>()
  return {
    ...actual,
    runChat: vi.fn(async ({ onEvent }: any) => {
      await onEvent({ type: 'user', id: 101 })
      await onEvent({ type: 'token', text: 'hello ' })
      await onEvent({ type: 'token', text: 'world' })
      await onEvent({ type: 'done', userId: 101, assistantId: 202 })
      return { userId: 101, assistantId: 202, fullText: 'hello world' }
    }),
  }
})

function sseBodyChunks(res: Response): Promise<string[]> {
  // Read the SSE body as a single string then split on \n\n blocks.
  return res.text().then((text) => {
    return text.split('\n\n').filter((b) => b.trim().length > 0)
  })
}

function parseEvent(block: string): { event: string; data: string } {
  const event = (block.match(/^event:\s*(.+)$/m) ?? ['', ''])[1].trim()
  const data = (block.match(/^data:\s*(.+)$/m) ?? ['', ''])[1].trim()
  return { event, data }
}

describe('POST /api/ai/chat', () => {
  // Settings are DB-backed only. The chat route 503s before reading
  // the body if no DB key is set, so we seed a plaintext key per test
  // (readStoredAiSettings detects legacy plaintext and migrates it to
  // encrypted on first read — see settings.ts).
  beforeEach(() => {
    testDbRef.value!.prepare(`
      INSERT INTO settings (key, value) VALUES ('ai.anthropic.apiKey', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run('sk-ant-test-key')
  })

  it('returns 503 when no DB API key is configured', async () => {
    testDbRef.value!.prepare('DELETE FROM settings WHERE key = ?').run('ai.anthropic.apiKey')
    const r = await call('POST', '/chat', { sessionId: 1, content: 'hi' })
    expect(r.status).toBe(503)
    expect(await r.json()).toEqual({ ok: false, reason: 'no-api-key' })
  })

  it('returns 400 when the body is invalid', async () => {
    const r = await call('POST', '/chat', { content: 'hi' })
    expect(r.status).toBe(400)
  })

  it('streams user → token* → done in order on success', async () => {
    // Create a session so the body validates.
    const created = (await (await call('POST', '/sessions')).json()) as { id: number }
    const r = await call('POST', '/chat', { sessionId: created.id, content: 'hi' })
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toMatch(/text\/event-stream/)
    const blocks = await sseBodyChunks(r)
    const events = blocks.map(parseEvent)
    expect(events.map((e) => e.event)).toEqual(['user', 'token', 'token', 'done'])
    expect(JSON.parse(events[0].data)).toEqual({ id: 101 })
    expect(JSON.parse(events[1].data)).toEqual({ text: 'hello ' })
    expect(JSON.parse(events[2].data)).toEqual({ text: 'world' })
    expect(JSON.parse(events[3].data)).toEqual({ userId: 101, assistantId: 202 })
  })

  it('emits an error event when runChat throws not-found', async () => {
    vi.mocked(chatModule.runChat).mockRejectedValueOnce(new ChatError('not-found'))
    // 999 is not a real session — the mock throws, so the route
    // emits the SSE error.
    const r = await call('POST', '/chat', { sessionId: 999, content: 'hi' })
    const blocks = await sseBodyChunks(r)
    const last = parseEvent(blocks[blocks.length - 1])
    expect(last.event).toBe('error')
    expect(JSON.parse(last.data)).toEqual({ reason: 'not-found' })
  })

  it('preserves the safe upstream message for an LLM error', async () => {
    vi.mocked(chatModule.runChat).mockRejectedValueOnce(
      new ChatError('llm-error', '404 Not Found: /v1/chat/completions'),
    )
    const r = await call('POST', '/chat', { sessionId: 1, content: 'hi' })
    const blocks = await sseBodyChunks(r)
    const last = parseEvent(blocks[blocks.length - 1])
    expect(last.event).toBe('error')
    expect(JSON.parse(last.data)).toEqual({
      reason: 'llm-error',
      message: '404 Not Found: /v1/chat/completions',
    })
  })

  it('preserves a compatibility code and redacts the configured key in SSE diagnostics', async () => {
    vi.mocked(chatModule.runChat).mockRejectedValueOnce(
      new ChatError(
        'llm-error',
        '400 unsupported parameter: tools; invalid credential sk-ant-test-key',
        undefined,
        'openai-tools-unsupported',
      ),
    )
    const r = await call('POST', '/chat', { sessionId: 1, content: 'hi' })
    const blocks = await sseBodyChunks(r)
    const last = parseEvent(blocks[blocks.length - 1])
    const payload = JSON.parse(last.data) as { reason: string; code: string; message: string }
    expect(payload.reason).toBe('llm-error')
    expect(payload.code).toBe('openai-tools-unsupported')
    expect(payload.message).toContain('[redacted]')
    expect(payload.message).not.toContain('sk-ant-test-key')
    expect(payload.message.length).toBeLessThanOrEqual(4001)
  })

  // ── Edit-10.3: the route normalizes the raw request into the ONE
  // ChatContext authority (live > legacy-path > none) BEFORE any SSE
  // starts, and never falls back to the legacy path when a live
  // context is present but invalid.
  describe('ChatContext normalization', () => {
    function liveDocument(overrides: Record<string, unknown> = {}) {
      return {
        v: 1,
        kind: 'document',
        capturedAt: 1_750_000_000_000,
        vaultId: 'vault-a',
        workspaceTabId: 'notes/a',
        identity: { documentId: 'doc-a', path: 'notes/a' },
        title: 'A',
        raw: 'ROUTE_LIVE_BODY',
        revision: 3,
        savedRevision: 2,
        dirty: true,
        saveStatus: 'dirty',
        ...overrides,
      }
    }

    beforeEach(() => {
      vi.mocked(chatModule.runChat).mockClear()
    })

    it('normalizes a valid liveContext into { kind: live } for runChat', async () => {
      const created = (await (await call('POST', '/sessions')).json()) as { id: number }
      const liveContext = liveDocument()
      const r = await call('POST', '/chat', { sessionId: created.id, content: 'hi', liveContext })
      expect(r.status).toBe(200)
      const opts = vi.mocked(chatModule.runChat).mock.calls[0][0]
      expect(opts.ctx).toEqual({ kind: 'live', liveContext })
    })

    it('keeps legacy currentNotePath as { kind: legacy-path } for old clients', async () => {
      const created = (await (await call('POST', '/sessions')).json()) as { id: number }
      await call('POST', '/chat', { sessionId: created.id, content: 'hi', currentNotePath: 'archive/old.md' })
      const opts = vi.mocked(chatModule.runChat).mock.calls[0][0]
      expect(opts.ctx).toEqual({ kind: 'legacy-path', currentNotePath: 'archive/old.md' })
    })

    it.each([
      ['legacy currentNotePath', { currentNotePath: 'diary/2026-08-30' }],
      ['attached contextPath', { contextPaths: ['diary/2026-08-30'] }],
    ])('rejects managed Diary paths in %s before provider setup', async (_label, fields) => {
      const created = (await (await call('POST', '/sessions')).json()) as { id: number }
      const r = await call('POST', '/chat', { sessionId: created.id, content: 'hi', ...fields })
      expect(r.status).toBe(422)
      expect(r.headers.get('cache-control')).toBe('no-store')
      expect(await r.json()).toEqual({
        error: 'Diary AI context is unavailable while encrypted Diary bodies are managed',
        code: 'diary-ai-context-unsupported',
      })
      expect(chatModule.runChat).not.toHaveBeenCalled()
    })

    it('lets liveContext win when both fields are present (legacy fully ignored)', async () => {
      const created = (await (await call('POST', '/sessions')).json()) as { id: number }
      const liveContext = liveDocument()
      await call('POST', '/chat', {
        sessionId: created.id,
        content: 'hi',
        liveContext,
        currentNotePath: 'archive/ignored.md',
      })
      const opts = vi.mocked(chatModule.runChat).mock.calls[0][0]
      expect(opts.ctx).toEqual({ kind: 'live', liveContext })
      expect(JSON.stringify(opts.ctx)).not.toContain('archive/ignored.md')
    })

    it('returns 400 invalid-live-context for a malformed liveContext and NEVER falls back to the legacy path', async () => {
      const created = (await (await call('POST', '/sessions')).json()) as { id: number }
      const r = await call('POST', '/chat', {
        sessionId: created.id,
        content: 'hi',
        liveContext: liveDocument({ v: 2 }),
        currentNotePath: 'archive/valid-legacy.md',
      })
      expect(r.status).toBe(400)
      expect(await r.json()).toEqual({ ok: false, reason: 'invalid-live-context' })
      expect(chatModule.runChat).not.toHaveBeenCalled()
    })

    it('returns 413 context-too-large for an oversized liveContext without calling runChat', async () => {
      const created = (await (await call('POST', '/sessions')).json()) as { id: number }
      const r = await call('POST', '/chat', {
        sessionId: created.id,
        content: 'hi',
        liveContext: liveDocument({ raw: 'x'.repeat(512 * 1024 + 1) }),
      })
      expect(r.status).toBe(413)
      expect(await r.json()).toEqual({ ok: false, reason: 'context-too-large' })
      expect(chatModule.runChat).not.toHaveBeenCalled()
    })

    it('normalizes the absence of both fields to { kind: none }', async () => {
      const created = (await (await call('POST', '/sessions')).json()) as { id: number }
      await call('POST', '/chat', { sessionId: created.id, content: 'hi' })
      const opts = vi.mocked(chatModule.runChat).mock.calls[0][0]
      expect(opts.ctx).toEqual({ kind: 'none' })
    })

    it('passes validated attached document paths to runChat', async () => {
      const created = (await (await call('POST', '/sessions')).json()) as { id: number }
      await call('POST', '/chat', {
        sessionId: created.id,
        content: 'hi',
        contextPaths: ['notes/reference.md', 'archive/example'],
      })
      const opts = vi.mocked(chatModule.runChat).mock.calls[0][0]
      expect(opts.ctx).toEqual({
        kind: 'none',
        contextPaths: ['notes/reference', 'archive/example'],
      })
    })

    it.each([
      ['absolute', '/etc/passwd'],
      ['parent traversal', '../secret'],
      ['hidden path', '.nuvyn/vault-id'],
      ['duplicate', ['notes/a', 'notes/a']],
    ])('rejects invalid attached context paths: %s', async (_label, contextPaths) => {
      const created = (await (await call('POST', '/sessions')).json()) as { id: number }
      const r = await call('POST', '/chat', {
        sessionId: created.id,
        content: 'hi',
        contextPaths: Array.isArray(contextPaths) ? contextPaths : [contextPaths],
      })
      expect(r.status).toBe(400)
      expect(await r.json()).toEqual({ ok: false, reason: 'invalid-context-paths' })
      expect(chatModule.runChat).not.toHaveBeenCalled()
    })

    it('never echoes the live context back over SSE', async () => {
      const created = (await (await call('POST', '/sessions')).json()) as { id: number }
      const r = await call('POST', '/chat', {
        sessionId: created.id,
        content: 'hi',
        liveContext: liveDocument({ raw: 'SSE_MUST_NOT_CARRY_THIS_BODY' }),
      })
      const text = await r.text()
      expect(text).not.toContain('SSE_MUST_NOT_CARRY_THIS_BODY')
      expect(text).not.toContain('liveContext')
    })
  })
})

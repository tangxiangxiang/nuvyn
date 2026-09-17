// Tests for the typed fetch wrappers. We stub global.fetch so no
// real network is hit; the assertions are about request shape
// (method, URL, body) and response mapping.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as api from '../ai-api'
import { streamChat } from '../ai-api'

type FetchCall = { url: string; init: RequestInit }

let calls: FetchCall[] = []
let responses: { status: number; body: unknown }[] = []

beforeEach(() => {
  calls = []
  responses = []
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const next = responses.shift() ?? { status: 200, body: {} }
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
})

describe('ai-api', () => {
  it('listSessions GETs /api/ai/sessions', async () => {
    responses.push({ status: 200, body: [{ id: 1, title: 'x', createdAt: 1, updatedAt: 2 }] })
    const list = await api.listSessions()
    expect(calls[0].url).toBe('/api/ai/sessions')
    expect(calls[0].init.method).toBe('GET')
    expect(list).toEqual([{ id: 1, title: 'x', createdAt: 1, updatedAt: 2 }])
  })

  it('createSessions POSTs to /api/ai/sessions', async () => {
    responses.push({ status: 201, body: { id: 7, title: '', createdAt: 1, updatedAt: 1 } })
    const s = await api.createSession()
    expect(calls[0].url).toBe('/api/ai/sessions')
    expect(calls[0].init.method).toBe('POST')
    expect(s.id).toBe(7)
  })

  it('renameSession PATCHes with the title body', async () => {
    responses.push({ status: 200, body: { id: 1, title: 'New', createdAt: 1, updatedAt: 1 } })
    await api.renameSession(1, 'New')
    expect(calls[0].url).toBe('/api/ai/sessions/1')
    expect(calls[0].init.method).toBe('PATCH')
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ title: 'New' })
  })

  it('deleteSession DELETEs the session', async () => {
    responses.push({ status: 200, body: { ok: true } })
    await api.deleteSession(1)
    expect(calls[0].url).toBe('/api/ai/sessions/1')
    expect(calls[0].init.method).toBe('DELETE')
  })

  it('listMessages GETs /api/ai/sessions/:id/messages', async () => {
    responses.push({ status: 200, body: [{ id: 1, sessionId: 1, role: 'user', content: 'hi', createdAt: 1 }] })
    const list = await api.listMessages(1)
    expect(calls[0].url).toBe('/api/ai/sessions/1/messages')
    expect(list[0].content).toBe('hi')
  })

  it('appendMessage POSTs to /api/ai/sessions/:id/messages with role and content', async () => {
    responses.push({ status: 201, body: { id: 9, sessionId: 1, role: 'user', content: 'x', createdAt: 1 } })
    await api.appendMessage(1, 'user', 'x')
    expect(calls[0].url).toBe('/api/ai/sessions/1/messages')
    expect(calls[0].init.method).toBe('POST')
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ role: 'user', content: 'x' })
  })

  it('getActiveSessionId returns just the activeId from /api/ai/active', async () => {
    responses.push({ status: 200, body: { activeId: 42, configured: true } })
    const id = await api.getActiveSessionId()
    expect(calls[0].url).toBe('/api/ai/active')
    expect(id).toBe(42)
  })

  it('setActiveSessionId PUTs to /api/ai/active', async () => {
    responses.push({ status: 200, body: { sessionId: 42 } })
    await api.setActiveSessionId(42)
    expect(calls[0].url).toBe('/api/ai/active')
    expect(calls[0].init.method).toBe('PUT')
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ sessionId: 42 })
  })

  it('getAiSettings GETs /api/ai/settings', async () => {
    responses.push({
      status: 200,
      body: {
        provider: 'anthropic',
        configured: true,
        source: 'db',
        maskedKey: 'sk-a...1234',
        baseURL: '',
        model: 'claude-test',
      },
    })
    const settings = await api.getAiSettings()
    expect(calls[0].url).toBe('/api/ai/settings')
    expect(calls[0].init.method).toBe('GET')
    expect(settings.model).toBe('claude-test')
  })

  it('saveAiSettings PUTs the editable fields', async () => {
    responses.push({ status: 200, body: { provider: 'anthropic', configured: true, source: 'db', maskedKey: 'sk-a...1234', baseURL: 'https://x', model: 'm' } })
    await api.saveAiSettings({ apiKey: 'secret', baseURL: 'https://x', model: 'm' })
    expect(calls[0].url).toBe('/api/ai/settings')
    expect(calls[0].init.method).toBe('PUT')
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ apiKey: 'secret', baseURL: 'https://x', model: 'm' })
  })

  it('clearAiApiKey DELETEs the stored key', async () => {
    responses.push({ status: 200, body: { cleared: true, provider: 'anthropic' } })
    await api.clearAiApiKey()
    expect(calls[0].url).toBe('/api/ai/settings/key')
    expect(calls[0].init.method).toBe('DELETE')
  })

  it('testAiConnection posts transient provider settings and forwards AbortSignal', async () => {
    responses.push({
      status: 200,
      body: { ok: true, provider: 'openai', model: 'probe-model', checkedAt: 10, latencyMs: 12 },
    })
    const controller = new AbortController()
    const result = await api.testAiConnection({
      provider: 'openai',
      apiKey: 'sk-transient',
      baseURL: 'https://gateway.example/v1',
      model: 'probe-model',
    }, controller.signal)
    expect(calls[0].url).toBe('/api/ai/settings/test-connection')
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.signal).toBe(controller.signal)
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      provider: 'openai',
      apiKey: 'sk-transient',
      baseURL: 'https://gateway.example/v1',
      model: 'probe-model',
    })
    expect(result.latencyMs).toBe(12)
  })

  it('includes a selected provider in the credential clear request', async () => {
    responses.push({ status: 200, body: { cleared: true, provider: 'openai' } })
    await api.clearAiApiKey('openai')
    expect(calls[0].url).toBe('/api/ai/settings/key?provider=openai')
  })

  it('preserves structured AI error codes on failed requests', async () => {
    responses.push({ status: 503, body: { error: 'master key required', code: 'master-key-required' } })
    await expect(api.getAiSettings()).rejects.toMatchObject({
      status: 503,
      code: 'master-key-required',
      body: { code: 'master-key-required' },
    })
  })

  it('throws with the server error message on a 4xx response', async () => {
    responses.push({ status: 404, body: { error: 'not found' } })
    await expect(api.getActiveSessionId()).rejects.toMatchObject({ status: 404 })
  })
})

// Build a Response whose body is a ReadableStream of UTF-8 bytes
// carrying the given SSE text. Mirrors what Hono's streamSSE
// actually emits on the wire.
function sseResponse(events: { event: string; data: unknown }[]): Response {
  const text = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('')
  const enc = new TextEncoder()
  return new Response(enc.encode(text), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

describe('streamChat', () => {
  it('yields typed ChatEvents in order from a streaming SSE response', async () => {
    const events = [
      { event: 'user', data: { id: 11 } },
      { event: 'token', data: { text: 'a' } },
      { event: 'token', data: { text: 'b' } },
      { event: 'done', data: { userId: 11, assistantId: 12 } },
    ]
    globalThis.fetch = vi.fn(async () => sseResponse(events)) as unknown as typeof fetch
    const collected: unknown[] = []
    for await (const ev of streamChat({ sessionId: 1, content: 'x' })) {
      collected.push(ev)
    }
    expect(collected).toEqual([
      { type: 'user', id: 11 },
      { type: 'token', text: 'a' },
      { type: 'token', text: 'b' },
      { type: 'done', userId: 11, assistantId: 12 },
    ])
  })

  it('yields { type: error } on a non-2xx response', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ reason: 'no-api-key' }), { status: 503, headers: { 'content-type': 'application/json' } })
    ) as unknown as typeof fetch
    const collected: unknown[] = []
    for await (const ev of streamChat({ sessionId: 1, content: 'x' })) {
      collected.push(ev)
    }
    expect(collected).toEqual([{ type: 'error', reason: 'no-api-key' }])
  })

  it('preserves a structured key code from a chat preflight response', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'master key required', code: 'master-key-required' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      })
    ) as unknown as typeof fetch
    const collected: unknown[] = []
    for await (const ev of streamChat({ sessionId: 1, content: 'x' })) {
      collected.push(ev)
    }
    expect(collected).toEqual([{ type: 'error', reason: 'http-503', code: 'master-key-required' }])
  })

  it('preserves an upstream message from a chat SSE error event', async () => {
    globalThis.fetch = vi.fn(async () => sseResponse([
      { event: 'error', data: { reason: 'llm-error', message: '400 unsupported parameter: tools' } },
    ])) as unknown as typeof fetch
    const collected: unknown[] = []
    for await (const ev of streamChat({ sessionId: 1, content: 'x' })) {
      collected.push(ev)
    }
    expect(collected).toEqual([{
      type: 'error',
      reason: 'llm-error',
      message: '400 unsupported parameter: tools',
    }])
  })

  it('preserves OpenAI compatibility codes from a chat SSE error event', async () => {
    globalThis.fetch = vi.fn(async () => sseResponse([
      {
        event: 'error',
        data: {
          reason: 'llm-error',
          code: 'openai-tools-unsupported',
          message: 'This endpoint does not support tool calling',
        },
      },
    ])) as unknown as typeof fetch
    const collected: unknown[] = []
    for await (const ev of streamChat({ sessionId: 1, content: 'x' })) collected.push(ev)
    expect(collected).toEqual([{
      type: 'error',
      reason: 'llm-error',
      code: 'openai-tools-unsupported',
      message: 'This endpoint does not support tool calling',
    }])
  })

  // ── Edit-10.3: the request body carries the ONE live-context
  // authority verbatim; the legacy currentNotePath field is gone from
  // the new client wire contract.
  const liveContext = {
    v: 1 as const,
    kind: 'document' as const,
    capturedAt: 1,
    vaultId: 'vault-a',
    workspaceTabId: 'notes/a',
    identity: { documentId: 'doc-a', path: 'notes/a' },
    title: 'A',
    raw: 'WIRE_BODY_SENTINEL',
    revision: 2,
    savedRevision: 1,
    dirty: true,
    saveStatus: 'dirty' as const,
  }

  async function collectRequestBody(req: Parameters<typeof streamChat>[0]): Promise<Record<string, unknown>> {
    globalThis.fetch = vi.fn(async () =>
      sseResponse([{ event: 'done', data: { userId: 1, assistantId: 2 } }]),
    ) as unknown as typeof fetch
    for await (const _ev of streamChat(req)) { /* drain */ }
    const init = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0][1]
    expect(String((globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0][0])).toBe('/api/ai/chat')
    return JSON.parse(init.body as string) as Record<string, unknown>
  }

  it('serializes liveContext verbatim and never sends currentNotePath', async () => {
    const body = await collectRequestBody({ sessionId: 3, content: 'hello', liveContext })
    expect(body).toEqual({ sessionId: 3, content: 'hello', liveContext })
    expect('currentNotePath' in body).toBe(false)
    // No truncation, no rewriting of the Markdown body.
    expect((body.liveContext as { raw: string }).raw).toBe('WIRE_BODY_SENTINEL')
  })

  it('serializes attached context paths as a separate request field', async () => {
    const body = await collectRequestBody({
      sessionId: 3,
      content: 'hello',
      contextPaths: ['notes/reference'],
    })
    expect(body).toEqual({
      sessionId: 3,
      content: 'hello',
      contextPaths: ['notes/reference'],
    })
  })

  it('omits the liveContext key entirely when no context is given (not null)', async () => {
    const body = await collectRequestBody({ sessionId: 1, content: 'x' })
    expect(body).toEqual({ sessionId: 1, content: 'x' })
    expect('liveContext' in body).toBe(false)
    expect('currentNotePath' in body).toBe(false)
  })

  it('yields the server reason on HTTP 400 invalid-live-context', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, reason: 'invalid-live-context' }), { status: 400, headers: { 'content-type': 'application/json' } })
    ) as unknown as typeof fetch
    const collected: unknown[] = []
    for await (const ev of streamChat({ sessionId: 1, content: 'x', liveContext })) {
      collected.push(ev)
    }
    expect(collected).toEqual([{ type: 'error', reason: 'invalid-live-context' }])
  })

  it('yields the server reason on HTTP 413 context-too-large', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, reason: 'context-too-large' }), { status: 413, headers: { 'content-type': 'application/json' } })
    ) as unknown as typeof fetch
    const collected: unknown[] = []
    for await (const ev of streamChat({ sessionId: 1, content: 'x', liveContext })) {
      collected.push(ev)
    }
    expect(collected).toEqual([{ type: 'error', reason: 'context-too-large' }])
  })
})

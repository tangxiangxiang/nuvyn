// Real-wire OpenAI-compatible tests. Unlike openai-llm.test.ts, this file
// does not mock the OpenAI SDK: a local HTTP server verifies the request path,
// auth header, JSON body, streaming chunks, and bounded compatibility retry.
import { createServer, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyMigrations } from '../db'
import { saveAiSettings } from '../ai/settings'
import { ChatError } from '../ai/errors'
import { AiConnectionError, clearChatBackendCache, generateText, getChatBackend, probeAiConnection } from '../ai/llm'
import { generateSlug } from '../ai/slug'
import * as sessions from '../ai/sessions'
import * as messages from '../ai/messages'
import { runChat } from '../ai/chat'
import aiRoutes from '../ai/routes'

const { testDbRef } = vi.hoisted(() => ({
  testDbRef: { value: null as Database.Database | null },
}))

vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>()
  return { ...actual, getDb: () => testDbRef.value! }
})

type ReceivedRequest = {
  method: string
  url: string
  authorization: string | undefined
  xApiKey: string | undefined
  body: Record<string, any>
}

type Handler = (request: ReceivedRequest, response: ServerResponse) => void

async function startFakeOpenAiServer(handler: Handler): Promise<{
  baseURL: string
  requests: ReceivedRequest[]
  close: () => Promise<void>
}> {
  const requests: ReceivedRequest[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      let body: Record<string, any> = {}
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* empty */ }
      const received = {
        method: req.method ?? '',
        url: req.url ?? '',
        authorization: req.headers.authorization,
        xApiKey: typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : undefined,
        body,
      }
      requests.push(received)
      handler(received, res)
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fake server did not bind to a port')
  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.close()
      await once(server, 'close')
    },
  }
}

function writeSse(response: ServerResponse, events: unknown[]): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`)
  response.end('data: [DONE]\n\n')
}

const TEST_MASTER_KEY = '44'.repeat(32)
const previousMasterKey = process.env.NUVYN_MASTER_KEY

describe('OpenAI-compatible HTTP protocol', () => {
  let db: Database.Database
  let server: Awaited<ReturnType<typeof startFakeOpenAiServer>> | undefined

  beforeEach(() => {
    process.env.NUVYN_MASTER_KEY = TEST_MASTER_KEY
    db = new Database(':memory:')
    applyMigrations(db)
    testDbRef.value = db
    clearChatBackendCache()
  })

  afterEach(async () => {
    clearChatBackendCache()
    if (server) await server.close()
    server = undefined
    db.close()
    testDbRef.value = null
    if (previousMasterKey === undefined) delete process.env.NUVYN_MASTER_KEY
    else process.env.NUVYN_MASTER_KEY = previousMasterKey
  })

  it('sends streamed text to the correct API-root path with Bearer auth', async () => {
    server = await startFakeOpenAiServer((_request, response) => writeSse(response, [
      { choices: [{ delta: { content: 'hello ' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'world' }, finish_reason: 'stop' }] },
    ]))
    saveAiSettings(db, {
      provider: 'openai',
      apiKey: 'test-api-key',
      baseURL: `${server.baseURL}/v1`,
      model: 'test-model',
    })

    const tokens: string[] = []
    const result = await getChatBackend(db, 'openai').streamRound({
      db,
      model: 'test-model',
      system: 'system',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      onToken: (token) => { tokens.push(token) },
    })

    expect(tokens).toEqual(['hello ', 'world'])
    expect(result.text).toBe('hello world')
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]).toMatchObject({
      method: 'POST',
      url: '/v1/chat/completions',
      authorization: 'Bearer test-api-key',
    })
    expect(server.requests[0].body).toMatchObject({ model: 'test-model', stream: true })
    expect(server.requests[0].body.tools).toBeUndefined()
  })

  it('tests the transient Settings configuration with a non-streaming tool probe', async () => {
    server = await startFakeOpenAiServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] }))
    })
    saveAiSettings(db, {
      provider: 'openai',
      apiKey: 'stored-api-key',
      baseURL: `${server.baseURL}/saved/v1`,
      model: 'saved-model',
    })
    const result = await aiRoutes.fetch(new Request('http://localhost/settings/test-connection', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'openai',
        apiKey: 'transient-api-key',
        baseURL: `${server.baseURL}/transient/v1`,
        model: 'transient-model',
      }),
    }))

    expect(result.status).toBe(200)
    expect(await result.json()).toMatchObject({
      ok: true,
      provider: 'openai',
      model: 'transient-model',
    })
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]).toMatchObject({
      method: 'POST',
      url: '/transient/v1/chat/completions',
      authorization: 'Bearer transient-api-key',
    })
    expect(server.requests[0].body).toMatchObject({
      model: 'transient-model',
      stream: false,
      tool_choice: 'auto',
    })
    expect(server.requests[0].body.tools?.[0]?.function?.name).toBe('nuvyn_connection_probe')
    const saved = db.prepare('SELECT value FROM settings WHERE key = ?').get('ai.openai.apiKey') as { value: string }
    expect(saved.value).not.toContain('transient-api-key')
    expect((db.prepare('SELECT value FROM settings WHERE key = ?').get('ai.openai.model') as { value: string }).value)
      .toBe('saved-model')
  })

  it('uses the saved provider key when the transient key is omitted', async () => {
    server = await startFakeOpenAiServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }))
    })
    saveAiSettings(db, {
      provider: 'openai',
      apiKey: 'saved-api-key',
      baseURL: `${server.baseURL}/v1`,
      model: 'saved-model',
    })
    const result = await aiRoutes.fetch(new Request('http://localhost/settings/test-connection', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'openai', baseURL: `${server.baseURL}/v1`, model: 'new-model' }),
    }))
    expect(result.status).toBe(200)
    expect(server.requests[0].authorization).toBe('Bearer saved-api-key')
    expect(server.requests[0].body.model).toBe('new-model')
  })

  it('redacts the transient API key from connection errors', async () => {
    server = await startFakeOpenAiServer((_request, response) => {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'bad credential transient-secret' } }))
    })
    const result = await aiRoutes.fetch(new Request('http://localhost/settings/test-connection', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'openai',
        apiKey: 'transient-secret',
        baseURL: `${server.baseURL}/v1`,
        model: 'test-model',
      }),
    }))
    const body = await result.json() as { error?: string; code?: string }
    expect(result.status).toBe(401)
    expect(body.code).toBe('ai-authentication-failed')
    expect(body.error).toContain('[redacted]')
    expect(body.error).not.toContain('transient-secret')
  })

  it.each([400, 404])('keeps a generic upstream %i response as a connection failure', async (status) => {
    server = await startFakeOpenAiServer((_request, response) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: status === 404 ? 'Not Found' : 'Bad Request' } }))
    })
    const result = await aiRoutes.fetch(new Request('http://localhost/settings/test-connection', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'openai',
        apiKey: 'transient-api-key',
        baseURL: `${server.baseURL}/v1`,
        model: 'test-model',
      }),
    }))
    const body = await result.json() as { code?: string }
    expect(result.status).toBe(502)
    expect(body.code).toBe('ai-connection-failed')
    expect(body.code).not.toBe('ai-model-unavailable')
  })

  it('classifies an explicit model error as model unavailable', async () => {
    server = await startFakeOpenAiServer((_request, response) => {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: "The model 'missing-model' does not exist" } }))
    })
    const result = await aiRoutes.fetch(new Request('http://localhost/settings/test-connection', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'openai',
        apiKey: 'transient-api-key',
        baseURL: `${server.baseURL}/v1`,
        model: 'missing-model',
      }),
    }))
    const body = await result.json() as { code?: string }
    expect(result.status).toBe(502)
    expect(body.code).toBe('ai-model-unavailable')
  })

  it('reports unsupported tools through the Settings connection-test route without retrying', async () => {
    server = await startFakeOpenAiServer((_request, response) => {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'unsupported parameter: tools' } }))
    })
    const result = await aiRoutes.fetch(new Request('http://localhost/settings/test-connection', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'openai',
        apiKey: 'transient-api-key',
        baseURL: `${server.baseURL}/v1`,
        model: 'test-model',
      }),
    }))
    const body = await result.json() as { code?: string }
    expect(result.status).toBe(502)
    expect(body.code).toBe('openai-tools-unsupported')
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0].body.tools).toBeDefined()
  })

  it('uses the max_completion_tokens fallback through the Settings connection-test route', async () => {
    server = await startFakeOpenAiServer((request, response) => {
      if (request.body.max_tokens !== undefined) {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'unsupported parameter: max_tokens' } }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] }))
    })
    const result = await aiRoutes.fetch(new Request('http://localhost/settings/test-connection', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'openai',
        apiKey: 'transient-api-key',
        baseURL: `${server.baseURL}/v1`,
        model: 'test-model',
      }),
    }))
    expect(result.status).toBe(200)
    expect(await result.json()).toMatchObject({ ok: true, model: 'test-model' })
    expect(server.requests).toHaveLength(2)
    expect(server.requests[0].body.max_tokens).toBe(16)
    expect(server.requests[0].body.max_completion_tokens).toBeUndefined()
    expect(server.requests[1].body.max_tokens).toBeUndefined()
    expect(server.requests[1].body.max_completion_tokens).toBe(16)
  })

  it('keeps the Settings connection probe read-only when using a saved key', async () => {
    server = await startFakeOpenAiServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] }))
    })
    saveAiSettings(db, {
      provider: 'openai',
      apiKey: 'saved-api-key',
      baseURL: `${server.baseURL}/v1`,
      model: 'saved-model',
    })
    const before = db.prepare('SELECT key, value FROM settings ORDER BY key').all()
    const result = await aiRoutes.fetch(new Request('http://localhost/settings/test-connection', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'openai', baseURL: `${server.baseURL}/v1`, model: 'saved-model' }),
    }))
    expect(result.status).toBe(200)
    expect(db.prepare('SELECT key, value FROM settings ORDER BY key').all()).toEqual(before)
  })

  it('preserves an explicit timeout classification for connection probes', async () => {
    server = await startFakeOpenAiServer(() => {
      // Deliberately leave the request open; the probe's short test timeout
      // must abort it without waiting for the production ten-second limit.
    })
    await expect(probeAiConnection({
      provider: 'openai',
      apiKey: 'transient-api-key',
      baseURL: `${server.baseURL}/v1`,
      model: 'test-model',
    }, undefined, 25)).rejects.toMatchObject({
      name: 'AiConnectionError',
      code: 'ai-connection-timeout',
    } satisfies Partial<AiConnectionError>)
  })

  it('runs an equivalent transient Messages probe for Anthropic', async () => {
    server = await startFakeOpenAiServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        id: 'msg_probe',
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        content: [{ type: 'text', text: 'OK' }],
        stop_reason: 'end_turn',
      }))
    })
    saveAiSettings(db, {
      provider: 'anthropic',
      apiKey: 'anthropic-secret',
      baseURL: server.baseURL,
      model: 'claude-test',
    })
    const result = await aiRoutes.fetch(new Request('http://localhost/settings/test-connection', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'anthropic', baseURL: server.baseURL, model: 'claude-test' }),
    }))
    expect(result.status).toBe(200)
    expect(server.requests[0]).toMatchObject({ method: 'POST', url: '/v1/messages', xApiKey: 'anthropic-secret' })
    expect(server.requests[0].body).toMatchObject({ model: 'claude-test', max_tokens: 16 })
    expect(server.requests[0].body.tools?.[0]?.name).toBe('nuvyn_connection_probe')
  })

  it('preserves arbitrary API path prefixes without adding an extra version', async () => {
    server = await startFakeOpenAiServer((_request, response) => writeSse(response, [
      { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
    ]))
    saveAiSettings(db, {
      provider: 'openai',
      apiKey: 'test-api-key',
      baseURL: `${server.baseURL}/custom/openai/v1`,
      model: 'test-model',
    })

    await getChatBackend(db, 'openai').streamRound({
      db,
      model: 'test-model',
      system: 'system',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      onToken: () => {},
    })
    expect(server.requests[0].url).toBe('/custom/openai/v1/chat/completions')
  })

  it('carries real streamed content through runChat into assistant persistence', async () => {
    server = await startFakeOpenAiServer((_request, response) => writeSse(response, [
      { choices: [{ delta: { content: 'hello ' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'world' }, finish_reason: 'stop' }] },
    ]))
    saveAiSettings(db, {
      provider: 'openai',
      apiKey: 'test-api-key',
      baseURL: `${server.baseURL}/v1`,
      model: 'test-model',
    })
    const session = sessions.createSession(db)
    const result = await runChat({
      db,
      sessionId: session.id,
      userContent: 'hi',
      model: 'test-model',
      ctx: { kind: 'none' },
      onEvent: () => {},
    })
    expect(result.fullText).toBe('hello world')
    expect(messages.listMessages(db, session.id)?.map((message) => [message.role, message.content]))
      .toEqual([['user', 'hi'], ['assistant', 'hello world']])
  })

  it('assembles fragmented tool calls from a real streaming response', async () => {
    server = await startFakeOpenAiServer((_request, response) => writeSse(response, [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_123', type: 'function', function: { name: 'read_' } }] }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'file', arguments: '{"path":"' } }] }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'notes/a"}' } }] }, finish_reason: 'tool_calls' }] },
    ]))
    saveAiSettings(db, {
      provider: 'openai',
      apiKey: 'test-api-key',
      baseURL: `${server.baseURL}/v1`,
      model: 'test-model',
    })

    const result = await getChatBackend(db, 'openai').streamRound({
      db,
      model: 'test-model',
      system: 'system',
      messages: [{ role: 'user', content: 'read it' }],
      tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object' } }],
      onToken: () => {},
    })
    expect(result.toolCalls).toEqual([{ id: 'call_123', name: 'read_file', input: { path: 'notes/a' } }])
    expect(server.requests[0].body.tools).toHaveLength(1)
    expect(server.requests[0].body.tool_choice).toBe('auto')
  })

  it('retries once with max_completion_tokens after an explicit legacy-parameter error', async () => {
    server = await startFakeOpenAiServer((request, response) => {
      if (request.body.max_tokens !== undefined) {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'unsupported parameter: max_tokens' } }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: 'helper works' } }] }))
    })
    saveAiSettings(db, {
      provider: 'openai',
      apiKey: 'test-api-key',
      baseURL: `${server.baseURL}/v1`,
      model: 'test-model',
    })

    const result = await generateText({
      system: 'system',
      user: 'hello',
      model: 'test-model',
      maxTokens: 123,
    })
    expect(result.text).toBe('helper works')
    expect(server.requests).toHaveLength(2)
    expect(server.requests[0].body.max_tokens).toBe(123)
    expect(server.requests[0].body.max_completion_tokens).toBeUndefined()
    expect(server.requests[1].body.max_tokens).toBeUndefined()
    expect(server.requests[1].body.max_completion_tokens).toBe(123)
  })

  it('retries a null length-limited slug response through the real HTTP wire path', async () => {
    let semanticAttempt = 0
    server = await startFakeOpenAiServer((_request, response) => {
      semanticAttempt += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: semanticAttempt === 1 ? null : 'first-principles',
          },
          finish_reason: semanticAttempt === 1 ? 'length' : 'stop',
        }],
      }))
    })
    saveAiSettings(db, {
      provider: 'openai',
      apiKey: 'test-api-key',
      baseURL: `${server.baseURL}/v1`,
      model: 'test-model',
    })

    await expect(generateSlug({ input: '第一性原理', kind: 'file' }))
      .resolves.toBe('first-principles')
    expect(server.requests).toHaveLength(2)
    expect(server.requests[0].url).toBe('/v1/chat/completions')
    expect(server.requests[0].body.max_tokens).toBe(256)
    expect(server.requests[1].body.max_tokens).toBe(512)
  })

  it('returns a stable diagnostic when the provider rejects tools', async () => {
    server = await startFakeOpenAiServer((_request, response) => {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'unsupported parameter: tools; invalid credential test-api-key' } }))
    })
    saveAiSettings(db, {
      provider: 'openai',
      apiKey: 'test-api-key',
      baseURL: `${server.baseURL}/v1`,
      model: 'test-model',
    })

    await expect(getChatBackend(db, 'openai').streamRound({
      db,
      model: 'test-model',
      system: 'system',
      messages: [{ role: 'user', content: 'edit it' }],
      tools: [{ name: 'write_file', description: 'write', parameters: { type: 'object' } }],
      onToken: () => {},
    })).rejects.toMatchObject({
      reason: 'llm-error',
      code: 'openai-tools-unsupported',
    } satisfies Partial<ChatError>)
    await expect(getChatBackend(db, 'openai').streamRound({
      db,
      model: 'test-model',
      system: 'system',
      messages: [{ role: 'user', content: 'edit it' }],
      tools: [{ name: 'write_file', description: 'write', parameters: { type: 'object' } }],
      onToken: () => {},
    })).rejects.toMatchObject({ message: expect.not.stringContaining('test-api-key') })
  })

  it('propagates a real provider 4xx through ChatError and the chat SSE route safely', async () => {
    server = await startFakeOpenAiServer((_request, response) => {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'unsupported parameter: tools; invalid credential test-api-key' } }))
    })
    saveAiSettings(db, {
      provider: 'openai',
      apiKey: 'test-api-key',
      baseURL: `${server.baseURL}/v1`,
      model: 'test-model',
    })
    const session = sessions.createSession(db)
    const response = await aiRoutes.fetch(new Request('http://localhost/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, content: 'edit it' }),
    }))
    const body = await response.text()
    expect(response.status).toBe(200)
    expect(body).toContain('"reason":"llm-error"')
    expect(body).toContain('"code":"openai-tools-unsupported"')
    expect(body).toContain('[redacted]')
    expect(body).not.toContain('test-api-key')
  })
})

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { applyMigrations } from '../db'
import { saveAiSettings } from '../ai/settings'
import * as sessions from '../ai/sessions'
import * as messages from '../ai/messages'
import { ChatError } from '../ai/errors'

const { createRef } = vi.hoisted(() => ({
  createRef: { value: vi.fn() },
}))

vi.mock('openai', () => ({
  default: class FakeOpenAI {
    chat = { completions: { create: (...args: unknown[]) => createRef.value(...args) } }
  },
}))

import { clearChatBackendCache, getChatBackend } from '../ai/llm'
import { runChat } from '../ai/chat'

const TEST_MASTER_KEY = '11'.repeat(32)
const previousMasterKey = process.env.NUVYN_MASTER_KEY

describe('OpenAI Chat Completions backend', () => {
  let db: Database.Database

  beforeEach(() => {
    process.env.NUVYN_MASTER_KEY = TEST_MASTER_KEY
    db = new Database(':memory:')
    applyMigrations(db)
    saveAiSettings(db, {
      provider: 'openai',
      apiKey: 'test-api-key',
      baseURL: 'https://example.invalid/v1',
      model: 'test-model',
    })
    createRef.value = vi.fn(async () => [
      { choices: [{ delta: { content: 'hello ' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'world' }, finish_reason: 'stop' }] },
    ])
    clearChatBackendCache()
  })

  afterEach(() => {
    db.close()
    clearChatBackendCache()
    if (previousMasterKey === undefined) delete process.env.NUVYN_MASTER_KEY
    else process.env.NUVYN_MASTER_KEY = previousMasterKey
  })

  it('forwards streamed OpenAI text to onToken for persistence and UI streaming', async () => {
    const backend = getChatBackend(db, 'openai')
    const tokens: string[] = []
    const result = await backend.streamRound({
      db,
      model: 'test-model',
      system: 'system',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      onToken: (token) => { tokens.push(token) },
    })

    expect(tokens).toEqual(['hello ', 'world'])
    expect(result.text).toBe('hello world')
    expect(result.finishReason).toBe('stop')
  })

  it('persists a plain OpenAI response through runChat', async () => {
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
    expect(messages.listMessages(db, session.id)?.map((m) => [m.role, m.content])).toEqual([
      ['user', 'hi'],
      ['assistant', 'hello world'],
    ])
  })

  it('reassembles fragmented tool-call names, ids, and JSON arguments', async () => {
    createRef.value = vi.fn(async () => [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_123', type: 'function', function: { name: 'read_' } }] }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'file', arguments: '{"path":"' } }] }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'notes/a"}' } }] }, finish_reason: 'tool_calls' }] },
    ])
    const result = await getChatBackend(db, 'openai').streamRound({
      db,
      model: 'test-model',
      system: 'system',
      messages: [{ role: 'user', content: 'read it' }],
      tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object' } }],
      onToken: () => {},
    })

    expect(result.finishReason).toBe('tool_calls')
    expect(result.toolCalls).toEqual([{ id: 'call_123', name: 'read_file', input: { path: 'notes/a' } }])
  })

  it('retries max_completion_tokens exactly once after an explicit max_tokens rejection', async () => {
    createRef.value = vi.fn()
      .mockRejectedValueOnce(new Error('unsupported parameter: max_tokens'))
      .mockResolvedValueOnce([
        { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
      ])
    await getChatBackend(db, 'openai').streamRound({
      db,
      model: 'test-model',
      system: 'system',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      onToken: () => {},
    })

    expect(createRef.value).toHaveBeenCalledTimes(2)
    expect(createRef.value.mock.calls[0][0]).toMatchObject({ max_tokens: 4096 })
    expect(createRef.value.mock.calls[1][0]).toMatchObject({ max_completion_tokens: 4096 })
    expect(createRef.value.mock.calls[1][0].max_tokens).toBeUndefined()
  })

  it('reports unsupported OpenAI tools without silently retrying without tools', async () => {
    createRef.value = vi.fn(async () => {
      throw new Error('400 unsupported parameter: tools')
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
    expect(createRef.value).toHaveBeenCalledTimes(1)
    expect(createRef.value.mock.calls[0][0]).toHaveProperty('tools')
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { pumpStream, resolveAiRuntimeConfig } from '../ai/llm'
import { ChatError } from '../ai/errors'
import { saveAiSettings } from '../ai/settings'
import { applyMigrations } from '../db'

// Settings are DB-backed only, so streamClaude's no-api-key check now
// reads from the DB. Mock getDb() to a fresh in-memory instance per
// test so the result depends on what we seed — not on whatever the
// dev machine's ./data/nuvyn.db happens to contain.
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

beforeEach(() => {
  testDbRef.value = new Database(':memory:')
  applyMigrations(testDbRef.value)
})

// A minimal MessageStream-shaped object: on(event, cb) registers
// handlers, finalMessage() returns a promise that resolves on demand.
function fakeStream() {
  const handlers: Record<string, (arg: any) => void> = {}
  let resolveFinal!: (msg: unknown) => void
  const finalPromise = new Promise<unknown>((r) => { resolveFinal = r })
  return {
    handlers,
    stream: {
      on: (event: string, cb: (arg: any) => void) => { handlers[event] = cb },
      finalMessage: () => finalPromise,
    },
    resolveFinal: (msg: unknown = { content: [], stop_reason: 'end_turn' }) => resolveFinal(msg),
  }
}

describe('pumpStream', () => {
  it('accumulates text events and resolves with {text, finalMessage}', async () => {
    const f = fakeStream()
    const onToken = vi.fn()
    const p = pumpStream(f.stream, onToken)
    f.handlers.text('Hello, ')
    f.handlers.text('world!')
    f.resolveFinal({ content: [{ type: 'text', text: 'Hello, world!' }], stop_reason: 'end_turn' })
    const result = await p
    expect(result.text).toBe('Hello, world!')
    expect(result.finalMessage.stop_reason).toBe('end_turn')
    expect(onToken).toHaveBeenNthCalledWith(1, 'Hello, ')
    expect(onToken).toHaveBeenNthCalledWith(2, 'world!')
  })

  it('rejects with ChatError(aborted) when the signal is pre-aborted', async () => {
    const f = fakeStream()
    const ac = new AbortController()
    ac.abort()
    await expect(pumpStream(f.stream, () => {}, ac.signal)).rejects.toBeInstanceOf(ChatError)
    await expect(pumpStream(f.stream, () => {}, ac.signal)).rejects.toMatchObject({ reason: 'aborted' })
  })

  it('rejects with ChatError(aborted) when the signal aborts mid-stream', async () => {
    const f = fakeStream()
    const ac = new AbortController()
    const onToken = vi.fn()
    const p = pumpStream(f.stream, onToken, ac.signal)
    f.handlers.text('partial ')
    ac.abort()
    await expect(p).rejects.toMatchObject({ reason: 'aborted' })
  })

  it('rejects with ChatError(llm-error) on a stream error event', async () => {
    const f = fakeStream()
    const p = pumpStream(f.stream, () => {})
    f.handlers.error(new Error('boom'))
    await expect(p).rejects.toMatchObject({ reason: 'llm-error' })
  })
})

import { streamClaude } from '../ai/llm'

describe('streamClaude', () => {
  it('throws ChatError(no-api-key) when no DB API key is set', async () => {
    await expect(
      streamClaude({ system: 's', messages: [], model: 'm', onToken: () => {} })
    ).rejects.toMatchObject({ reason: 'no-api-key' })
  })
})

describe('AI runtime configuration', () => {
  it('reads provider, credentials, model, and base URL only from SQLite settings', () => {
    const previous = {
      masterKey: process.env.NUVYN_MASTER_KEY,
      anthropicKey: process.env.ANTHROPIC_API_KEY,
      anthropicModel: process.env.ANTHROPIC_MODEL,
      anthropicBaseURL: process.env.ANTHROPIC_BASE_URL,
    }
    process.env.NUVYN_MASTER_KEY = '11'.repeat(32)
    process.env.ANTHROPIC_API_KEY = 'env-key-must-be-ignored'
    process.env.ANTHROPIC_MODEL = 'env-model-must-be-ignored'
    process.env.ANTHROPIC_BASE_URL = 'https://env.example.invalid'

    try {
      saveAiSettings(testDbRef.value!, {
        provider: 'openai',
        apiKey: 'db-key',
        model: 'db-model',
        baseURL: 'https://db.example.invalid/v1',
      })
      expect(resolveAiRuntimeConfig(testDbRef.value!)).toEqual({
        apiKey: 'db-key',
        provider: 'openai',
        model: 'db-model',
        baseURL: 'https://db.example.invalid/v1',
        source: 'db',
      })
    } finally {
      if (previous.masterKey === undefined) delete process.env.NUVYN_MASTER_KEY
      else process.env.NUVYN_MASTER_KEY = previous.masterKey
      if (previous.anthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = previous.anthropicKey
      if (previous.anthropicModel === undefined) delete process.env.ANTHROPIC_MODEL
      else process.env.ANTHROPIC_MODEL = previous.anthropicModel
      if (previous.anthropicBaseURL === undefined) delete process.env.ANTHROPIC_BASE_URL
      else process.env.ANTHROPIC_BASE_URL = previous.anthropicBaseURL
    }
  })
})

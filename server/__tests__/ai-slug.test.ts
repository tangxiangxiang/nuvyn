import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { applyMigrations } from '../db'
import { saveAiSettings } from '../ai/settings'
import { generateText } from '../ai/llm'
import { generateSlug } from '../ai/slug'

const { anthropicCreateRef, openAiCreateRef, testDbRef } = vi.hoisted(() => ({
  anthropicCreateRef: { value: vi.fn() },
  openAiCreateRef: { value: vi.fn() },
  testDbRef: { value: null as Database.Database | null },
}))

vi.mock('openai', () => ({
  default: class FakeOpenAI {
    chat = { completions: { create: (...args: unknown[]) => openAiCreateRef.value(...args) } }
  },
}))

vi.mock('@anthropic-ai/sdk', () => ({
  default: class FakeAnthropic {
    messages = { create: (...args: unknown[]) => anthropicCreateRef.value(...args) }
  },
}))

vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>()
  return { ...actual, getDb: () => testDbRef.value! }
})

const TEST_MASTER_KEY = '55'.repeat(32)
const previousMasterKey = process.env.NUVYN_MASTER_KEY

function openAiCompletion(content: string | null, finishReason: string) {
  return {
    choices: [{
      message: { role: 'assistant', content },
      finish_reason: finishReason,
    }],
  }
}

function configure(provider: 'openai' | 'anthropic'): void {
  saveAiSettings(testDbRef.value!, {
    provider,
    apiKey: 'test-api-key',
    baseURL: 'https://example.invalid/v1',
    model: 'test-model',
  })
}

async function callGenerateText() {
  return generateText({
    system: 'system',
    user: 'user',
    model: 'test-model',
    maxTokens: 123,
  })
}

describe('AI slug generation', () => {
  beforeEach(() => {
    process.env.NUVYN_MASTER_KEY = TEST_MASTER_KEY
    testDbRef.value = new Database(':memory:')
    applyMigrations(testDbRef.value)
    configure('openai')
    openAiCreateRef.value = vi.fn()
    anthropicCreateRef.value = vi.fn()
  })

  afterEach(() => {
    testDbRef.value?.close()
    testDbRef.value = null
    if (previousMasterKey === undefined) delete process.env.NUVYN_MASTER_KEY
    else process.env.NUVYN_MASTER_KEY = previousMasterKey
  })

  it('generates a normal OpenAI slug with the initial budget', async () => {
    openAiCreateRef.value = vi.fn().mockResolvedValue(openAiCompletion('first-principles', 'stop'))

    await expect(generateSlug({ input: '第一性原理', kind: 'file' }))
      .resolves.toBe('first-principles')
    expect(openAiCreateRef.value).toHaveBeenCalledTimes(1)
    expect(openAiCreateRef.value.mock.calls[0][0]).toMatchObject({ max_tokens: 256 })
  })

  it('retries a null length-limited OpenAI response once with a larger budget', async () => {
    openAiCreateRef.value = vi.fn()
      .mockResolvedValueOnce({
        choices: [{
          message: { role: 'assistant', content: null, reasoning_content: 'not a final answer' },
          finish_reason: 'length',
        }],
      })
      .mockResolvedValueOnce(openAiCompletion('first-principles', 'stop'))

    await expect(generateSlug({ input: '第一性原理', kind: 'file' }))
      .resolves.toBe('first-principles')
    expect(openAiCreateRef.value).toHaveBeenCalledTimes(2)
    expect(openAiCreateRef.value.mock.calls[0][0]).toMatchObject({ max_tokens: 256 })
    expect(openAiCreateRef.value.mock.calls[1][0]).toMatchObject({ max_tokens: 512 })
    expect(openAiCreateRef.value.mock.calls[1][0].messages[0].content)
      .toContain('Return the final slug only')
  })

  it('retries unusable OpenAI output even after a normal stop', async () => {
    openAiCreateRef.value = vi.fn()
      .mockResolvedValueOnce(openAiCompletion('', 'stop'))
      .mockResolvedValueOnce(openAiCompletion('first-principles', 'stop'))

    await expect(generateSlug({ input: '第一性原理', kind: 'file' }))
      .resolves.toBe('first-principles')
    expect(openAiCreateRef.value).toHaveBeenCalledTimes(2)
  })

  it('fails after exactly two unusable OpenAI responses', async () => {
    openAiCreateRef.value = vi.fn()
      .mockResolvedValue(openAiCompletion(null, 'length'))

    await expect(generateSlug({ input: '第一性原理', kind: 'file' }))
      .rejects.toMatchObject({
        reason: 'parse-failed',
        message: 'bad slug from model after retry: output limit reached',
      })
    expect(openAiCreateRef.value).toHaveBeenCalledTimes(2)
  })

  it('does not retry after the signal is aborted during the first attempt', async () => {
    const controller = new AbortController()
    openAiCreateRef.value = vi.fn().mockImplementationOnce(async () => {
      controller.abort()
      return openAiCompletion('', 'stop')
    })

    await expect(generateSlug({
      input: '第一性原理',
      kind: 'file',
      signal: controller.signal,
    })).rejects.toMatchObject({ reason: 'aborted' })
    expect(openAiCreateRef.value).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['shorter than 3 characters', 'a', 'slug too short (1 characters)'],
    ['longer than 60 characters', 'a'.repeat(61), 'slug too long (61 characters)'],
  ])('rejects a cleaned slug %s after one retry', async (_case, output, diagnostic) => {
    openAiCreateRef.value = vi.fn().mockResolvedValue(openAiCompletion(output, 'stop'))

    await expect(generateSlug({ input: 'test', kind: 'folder' }))
      .rejects.toMatchObject({
        reason: 'parse-failed',
        message: `bad slug from model after retry: ${diagnostic}`,
      })
    expect(openAiCreateRef.value).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['"first principles"', 'first-principles'],
    ['first_principles', 'first-principles'],
    ['`first-principles`', 'first-principles'],
    ['```text\nfirst-principles\n```', 'first-principles'],
    ['Here is the slug: first-principles', 'first-principles'],
    ['../first/principles\\', 'first-principles'],
  ])('normalizes harmless formatting while returning a safe slug: %s', async (output, expected) => {
    openAiCreateRef.value = vi.fn().mockResolvedValue(openAiCompletion(output, 'stop'))

    const slug = await generateSlug({ input: 'test', kind: 'file' })
    expect(slug).toBe(expected)
    expect(slug).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
  })

  it.each([
    ['stop', 'stop'],
    ['length', 'length'],
    ['content_filter', 'other'],
  ] as const)('normalizes OpenAI finish_reason=%s to %s', async (upstream, expected) => {
    openAiCreateRef.value = vi.fn().mockResolvedValue(openAiCompletion('answer', upstream))

    await expect(callGenerateText()).resolves.toMatchObject({
      text: 'answer',
      finishReason: expected,
    })
  })

  it('does not treat a missing OpenAI message as a normal completion', async () => {
    openAiCreateRef.value = vi.fn().mockResolvedValue({
      choices: [{ finish_reason: 'stop' }],
    })

    await expect(callGenerateText()).resolves.toEqual({ text: '', finishReason: 'other' })
  })

  it('keeps valid Anthropic slug generation to one request', async () => {
    configure('anthropic')
    anthropicCreateRef.value = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'first-principles' }],
      stop_reason: 'end_turn',
    })

    await expect(generateSlug({ input: '第一性原理', kind: 'file' }))
      .resolves.toBe('first-principles')
    expect(anthropicCreateRef.value).toHaveBeenCalledTimes(1)
    expect(anthropicCreateRef.value.mock.calls[0][0]).toMatchObject({ max_tokens: 256 })
  })

  it.each([
    ['end_turn', 'stop'],
    ['max_tokens', 'length'],
    ['tool_use', 'other'],
  ] as const)('normalizes Anthropic stop_reason=%s to %s', async (upstream, expected) => {
    configure('anthropic')
    anthropicCreateRef.value = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'answer' }],
      stop_reason: upstream,
    })

    await expect(callGenerateText()).resolves.toEqual({
      text: 'answer',
      finishReason: expected,
    })
  })
})

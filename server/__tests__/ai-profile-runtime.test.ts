import Database from 'better-sqlite3'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
const state = vi.hoisted(() => ({ db: null as Database.Database | null, clients: [] as Array<{ provider: string; config: any; params: any }>, rounds: 0, tools: false, text: 'safe-title' }))
vi.mock('../db', async (original) => ({ ...await original<typeof import('../db')>(), getDb: () => state.db! }))
vi.mock('../ai/tools', () => ({ TOOL_DEFINITIONS: [], executeToolCall: vi.fn(async () => ({ content: 'done', isError: false })) }))
vi.mock('openai', () => ({ default: class {
  constructor(private config: any) {}
  chat = { completions: { create: async (params: any) => {
    state.clients.push({ provider: 'openai', config: this.config, params })
    if (!params.stream) return { choices: [{ message: { content: state.text }, finish_reason: 'stop' }] }
    const tool = state.tools && ++state.rounds === 1
    return [{ choices: [{ delta: { content: 'hello', ...(tool ? { tool_calls: [{ index: 0, id: 'call1', function: { name: 'list_files', arguments: '{}' } }] } : {}) }, finish_reason: tool ? 'tool_calls' : 'stop' }] }]
  } } }
} }))
vi.mock('@anthropic-ai/sdk', () => ({ default: class {
  constructor(private config: any) {}
  messages = {
    create: async (params: any) => {
      state.clients.push({ provider: 'anthropic', config: this.config, params })
      return { content: [{ type: 'text', text: state.text }], stop_reason: 'end_turn' }
    },
    stream: (params: any) => {
      state.clients.push({ provider: 'anthropic', config: this.config, params })
      return { on: (event: string, cb: (text: string) => void) => { if (event === 'text') cb('hello') }, finalMessage: async () => ({ content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn' }) }
    },
  }
} }))
import { applyMigrations } from '../db'
import { activateAiProfile, createAiProfile, profileRuntime } from '../ai/profiles'
import { generateText, getChatBackend, clearChatBackendCache } from '../ai/llm'
import { runChat } from '../ai/chat'
import { createSession } from '../ai/sessions'
import { listMessages } from '../ai/messages'
import { generateTitle } from '../ai/title'
import { generateSummary } from '../ai/summary'
import { generateTags } from '../ai/tags'
import { generateSlug } from '../ai/slug'
import { generateCommitMessage } from '../ai/commitMessage'
const previous = process.env.NUVYN_MASTER_KEY
beforeEach(() => {
  process.env.NUVYN_MASTER_KEY = '99'.repeat(32)
  state.db = new Database(':memory:'); applyMigrations(state.db)
  state.clients = []; state.rounds = 0; state.tools = false; state.text = 'safe-title'
  clearChatBackendCache()
})
afterEach(() => { state.db!.close(); clearChatBackendCache(); if (previous === undefined) delete process.env.NUVYN_MASTER_KEY; else process.env.NUVYN_MASTER_KEY = previous })
const add = (name: string, provider: 'openai' | 'anthropic' = 'openai') => createAiProfile(state.db!, { name, provider, apiKey: `sk-${name}-fixture`, baseURL: `https://${name}.example.test/v1`, model: `model-${name}` })

describe('Profile runtime snapshots', () => {
  it('keeps both streaming tool rounds on the original profile while the next run uses the new default', async () => {
    const a = add('a'), b = add('b', 'anthropic')
    activateAiProfile(state.db!, a.id)
    const session = createSession(state.db!)
    state.tools = true
    await runChat({ db: state.db!, model: 'model-a', sessionId: session.id, userContent: 'hello', ctx: { kind: 'none' },
      onEvent: (e) => { if (e.type === 'token') activateAiProfile(state.db!, b.id) } })
    expect(state.clients).toHaveLength(2)
    for (const client of state.clients) expect(client).toMatchObject({ provider: 'openai', config: { apiKey: 'sk-a-fixture', baseURL: 'https://a.example.test/v1' }, params: { model: 'model-a' } })
    expect(listMessages(state.db!, session.id)).toHaveLength(2)
    await runChat({ db: state.db!, model: 'model-b', sessionId: session.id, userContent: 'next', ctx: { kind: 'none' }, onEvent: () => {} })
    expect(state.clients.at(-1)).toMatchObject({ provider: 'anthropic', config: { apiKey: 'sk-b-fixture', baseURL: 'https://b.example.test/v1' }, params: { model: 'model-b' } })
    expect(listMessages(state.db!, session.id)).toHaveLength(4)
  })
  it('does not pollute same-protocol backend reuse with another profile credentials or endpoint', async () => {
    const a = add('a'), b = add('b')
    for (const profile of [a, b, a]) {
      activateAiProfile(state.db!, profile.id)
      await generateText({ db: state.db!, model: `model-${profile.name}`, system: 'system', user: 'user', maxTokens: 16 })
      await getChatBackend(state.db!).streamRound({ db: state.db!, model: `model-${profile.name}`, messages: [], system: '', tools: [], onToken: () => {} })
      for (const client of state.clients.slice(-2)) expect(client.config).toMatchObject({ apiKey: `sk-${profile.name}-fixture`, baseURL: `https://${profile.name}.example.test/v1` })
    }
  })
  it('uses an explicit request snapshot even after the default profile changes', async () => {
    const a = add('a'), b = add('b', 'anthropic')
    const snapshot = profileRuntime(state.db!, a.id)
    activateAiProfile(state.db!, b.id)
    await generateText({ db: state.db!, runtimeConfig: snapshot, model: snapshot.model, system: '', user: '', maxTokens: 16 })
    expect(state.clients[0]).toMatchObject({ provider: 'openai', config: { apiKey: 'sk-a-fixture' }, params: { model: 'model-a' } })
  })
  it('routes Title, Summary, Tags, Slug and commit-message generation through the default profile', async () => {
    const a = add('a', 'anthropic'), b = add('b')
    activateAiProfile(state.db!, a.id)
    await generateTitle({ path: 'inbox/test.md', content: 'document' })
    activateAiProfile(state.db!, b.id)
    await generateSummary({ path: 'inbox/test.md', content: 'document' })
    state.text = '["topic"]'
    await generateTags({ path: 'inbox/test.md', content: 'document' })
    state.text = 'safe-title'
    await generateSlug({ kind: 'file', input: '文档' })
    await generateCommitMessage({ paths: ['inbox/test.md'], changes: [] })
    expect(state.clients.map((c) => c.provider)).toEqual(['anthropic', 'openai', 'openai', 'openai', 'openai'])
    expect(state.clients.map((c) => c.params.model)).toEqual(['model-a', 'model-b', 'model-b', 'model-b', 'model-b'])
  })
})

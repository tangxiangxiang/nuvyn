import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { applyMigrations } from '../db'
import * as messages from '../ai/messages'
import * as sessions from '../ai/sessions'

const { generateTextMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(async (_options: {
    system: string
    user: string
    model?: string
    runtimeConfig?: unknown
    signal?: AbortSignal
  }) => ({ text: 'Durable memory', finishReason: 'stop' as const })),
}))

vi.mock('../ai/llm.js', () => ({ generateText: generateTextMock }))

import { compactAiThreadIfNeeded, compactLedgerAiThreadIfNeeded } from '../ai/compaction'

describe('AI thread compaction', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applyMigrations(db)
    generateTextMock.mockReset()
    generateTextMock.mockResolvedValue({ text: 'Durable memory', finishReason: 'stop' })
  })

  afterEach(() => db.close())

  it('summarizes complete older turns while keeping raw history and a recent window', async () => {
    const thread = sessions.ensureAiThread(db, {
      kind: 'document',
      vaultId: 'vault-a',
      documentId: 'note-a',
      path: 'guide.md',
      title: 'Guide',
    })
    const rows: Array<{ id: number; role: 'user' | 'assistant'; content: string }> = []
    for (let index = 0; index < 36; index++) {
      const role = index % 2 === 0 ? 'user' : 'assistant'
      const result = messages.appendMessage(
        db,
        thread.session.id,
        role,
        `${role}-${index}: ${'x'.repeat(1_000)}`,
      )
      if (result.ok) rows.push({ id: result.message.id, role, content: result.message.content })
    }

    await compactAiThreadIfNeeded({ db, sessionId: thread.session.id, model: 'test-model' })

    const state = sessions.getAiThreadCompactionState(db, thread.session.id)
    expect(state?.compactSummary).toBe('Durable memory')
    expect(state?.compactedThroughMessageId).toBe(rows[17].id)
    expect(messages.listMessages(db, thread.session.id)).toHaveLength(36)
    expect(messages.listMessagesAfter(db, thread.session.id, state?.compactedThroughMessageId ?? 0))
      .toHaveLength(18)
    expect(generateTextMock).toHaveBeenCalledTimes(2)
    expect(generateTextMock.mock.calls[0][0].system).toContain('Current goal')
  })

  it('leaves ordinary legacy sessions out of background compaction', async () => {
    const session = sessions.createSession(db)
    for (let index = 0; index < 40; index++) {
      messages.appendMessage(
        db,
        session.id,
        index % 2 === 0 ? 'user' : 'assistant',
        `Message ${index}`,
      )
    }

    await compactAiThreadIfNeeded({ db, sessionId: session.id, model: 'test-model' })

    expect(generateTextMock).not.toHaveBeenCalled()
    expect(messages.listMessages(db, session.id)).toHaveLength(40)
  })

  it('automatically archives older Ledger turns with the triggering model and keeps six recent turns', async () => {
    const thread = sessions.ensureLedgerAiThread(db, 41)
    for (let index = 1; index <= 8; index++) {
      messages.appendMessage(db, thread.session.id, 'user', `Finance topic ${index}`, { privateLedgerAnalysis: true })
      messages.appendMessage(db, thread.session.id, 'assistant', JSON.stringify({
        v: 2,
        text: `Finance answer ${index}`,
        rounds: [],
        toolCalls: [],
        privateLedgerAnalysis: true,
      }))
    }
    const runtimeConfig = { provider: 'openai' as const, source: 'db' as const, model: 'selected-model', apiKey: 'test-key' }

    await compactLedgerAiThreadIfNeeded({
      db,
      sessionId: thread.session.id,
      model: 'selected-model',
      runtimeConfig,
    })

    expect(generateTextMock).toHaveBeenCalledOnce()
    expect(generateTextMock.mock.calls[0]![0].model).toBe('selected-model')
    expect(generateTextMock.mock.calls[0]![0].runtimeConfig).toBe(runtimeConfig)
    expect(generateTextMock.mock.calls[0]![0].user).toContain('Finance topic 1')
    expect(generateTextMock.mock.calls[0]![0].user).toContain('Finance topic 2')
    expect(generateTextMock.mock.calls[0]![0].user).not.toContain('Finance topic 3')

    const state = sessions.getAiThreadCompactionState(db, thread.session.id)
    expect(state?.compactedThroughMessageId).toBe(4)
    expect(messages.listMessages(db, thread.session.id)).toHaveLength(16)
    expect(messages.listMessagesAfter(db, thread.session.id, state?.compactedThroughMessageId ?? 0)).toHaveLength(12)
  })

  it('deduplicates simultaneous automatic Ledger compaction requests', async () => {
    const thread = sessions.ensureLedgerAiThread(db, 42)
    for (let index = 1; index <= 8; index++) {
      messages.appendMessage(db, thread.session.id, 'user', `Finance topic ${index}`, { privateLedgerAnalysis: true })
      messages.appendMessage(db, thread.session.id, 'assistant', JSON.stringify({
        v: 2,
        text: `Finance answer ${index}`,
        rounds: [],
        toolCalls: [],
        privateLedgerAnalysis: true,
      }))
    }
    let finish!: (value: { text: string; finishReason: 'stop' }) => void
    generateTextMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const options = { db, sessionId: thread.session.id, model: 'test-model' }
    const first = compactLedgerAiThreadIfNeeded(options)
    const second = compactLedgerAiThreadIfNeeded(options)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    finish({ text: 'One durable memory', finishReason: 'stop' })
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
    expect(generateTextMock).toHaveBeenCalledOnce()
  })

  it('uses the effective text threshold before the eight-turn window is full', async () => {
    const thread = sessions.ensureLedgerAiThread(db, 43)
    for (let index = 1; index <= 7; index++) {
      const long = index > 2 ? 'x'.repeat(3_500) : 'short'
      messages.appendMessage(db, thread.session.id, 'user', `Finance topic ${index} ${long}`, { privateLedgerAnalysis: true })
      messages.appendMessage(db, thread.session.id, 'assistant', JSON.stringify({
        v: 2,
        text: `Finance answer ${index} ${long}`,
        rounds: [],
        toolCalls: [],
        privateLedgerAnalysis: true,
      }))
    }

    await compactLedgerAiThreadIfNeeded({ db, sessionId: thread.session.id, model: 'test-model' })

    expect(generateTextMock).toHaveBeenCalledOnce()
    expect(generateTextMock.mock.calls[0]![0].user).toContain('Finance topic 1')
    expect(generateTextMock.mock.calls[0]![0].user).not.toContain('Finance topic 2')
    expect(sessions.getAiThreadCompactionState(db, thread.session.id)?.compactedThroughMessageId).toBe(2)
  })

  it('skips interrupted or cancelled Ledger turns and catches up multi-batch backlogs', async () => {
    const thread = sessions.ensureLedgerAiThread(db, 44)
    for (let index = 1; index <= 14; index++) {
      messages.appendMessage(db, thread.session.id, 'user', `Backlog topic ${index}`, { privateLedgerAnalysis: true })
      messages.appendMessage(db, thread.session.id, 'assistant', JSON.stringify({
        v: 2,
        text: `Backlog answer ${index}`,
        rounds: [],
        toolCalls: [],
        privateLedgerAnalysis: true,
      }))
      if (index === 3 || index === 9) {
        messages.appendMessage(db, thread.session.id, 'user', `Bad topic ${index}`, { privateLedgerAnalysis: true })
        messages.appendMessage(db, thread.session.id, 'assistant', JSON.stringify({
          v: 2,
          text: '',
          rounds: [],
          toolCalls: [],
          privateLedgerAnalysis: true,
          cancelled: true,
          interrupted: true,
        }))
      }
    }

    await compactLedgerAiThreadIfNeeded({ db, sessionId: thread.session.id, model: 'test-model' })

    const state = sessions.getAiThreadCompactionState(db, thread.session.id)
    expect(state?.compactSummary).toBe('Durable memory')
    expect(generateTextMock).toHaveBeenCalledOnce()
    expect(generateTextMock.mock.calls[0]![0].user).not.toContain('Bad topic')
    const remaining = messages.listMessagesAfter(db, thread.session.id, state?.compactedThroughMessageId ?? 0) ?? []
    expect(messages.extractCompleteLedgerTurns(remaining)).toHaveLength(6)
  })
})

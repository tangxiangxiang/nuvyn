import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { applyMigrations } from '../db'
import * as messages from '../ai/messages'
import * as sessions from '../ai/sessions'

const { generateTextMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(async () => ({ text: 'Durable memory', finishReason: 'stop' as const })),
}))

vi.mock('../ai/llm.js', () => ({ generateText: generateTextMock }))

import { compactAiThreadIfNeeded } from '../ai/compaction'

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
})

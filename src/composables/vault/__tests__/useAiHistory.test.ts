// @vitest-environment jsdom
// Tests for the useAiHistory composable. We stub global.fetch (the
// same pattern as src/lib/__tests__/ai-api.test.ts) so the
// composable exercises the full flow without hitting the network.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { defineComponent, h, type Ref } from 'vue'
import { mount } from '@vue/test-utils'
import { useAiHistory, __resetForTesting, type AiHistory } from '../useAiHistory'

interface Harness {
  activeSession: Ref<{ id: number; title: string; createdAt: number; updatedAt: number } | null>
  messages: Ref<{ id: number; sessionId: number; role: 'user' | 'assistant'; content: string; createdAt: number; blocks?: { v: 1; text: string; toolCalls: { id: string; name: string; input: Record<string, unknown>; result: { content: string; is_error: boolean } }[] } }[]>
  sessions: Ref<{ id: number; title: string; createdAt: number; updatedAt: number }[]>
  isLoading: Ref<boolean>
  busy: Ref<boolean>
  errorState: Ref<string | null>
  api: AiHistory
}

function setup(): Harness {
  let captured: AiHistory | null = null
  const Comp = defineComponent({
    setup() {
      const api = useAiHistory()
      captured = api
      return () => h('div')
    },
  })
  mount(Comp)
  const api = captured!
  return { ...api, api } as unknown as Harness
}

type FetchResponse = { status: number; body: unknown }
let queue: FetchResponse[] = []

beforeEach(() => {
  queue = []
  globalThis.fetch = vi.fn(async () => {
    const r = queue.shift() ?? { status: 200, body: {} }
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  __resetForTesting()
})

describe('useAiHistory', () => {
  it('starts with no active session, empty messages, and isLoading=false', () => {
    const h = setup()
    expect(h.activeSession.value).toBeNull()
    expect(h.messages.value).toEqual([])
    expect(h.sessions.value).toEqual([])
    expect(h.isLoading.value).toBe(false)
  })

  describe('loadActive', () => {
    it('with no active session, leaves activeSession null and messages empty', async () => {
      queue.push({ status: 200, body: { activeId: null, configured: true } })
      const h = setup()
      await h.api.loadActive()
      expect(h.activeSession.value).toBeNull()
      expect(h.messages.value).toEqual([])
    })

    it('with an active session, populates activeSession and messages', async () => {
      queue.push({ status: 200, body: {
        activeId: 42,
        activeSession: { id: 42, title: 'Existing conversation', createdAt: 10, updatedAt: 20 },
        configured: true,
      } })
      queue.push({ status: 200, body: [{ id: 1, sessionId: 42, role: 'user', content: 'hi', createdAt: 100 }] })
      const h = setup()
      await h.api.loadActive()
      expect(h.activeSession.value).toEqual({ id: 42, title: 'Existing conversation', createdAt: 10, updatedAt: 20 })
      expect(h.messages.value[0].content).toBe('hi')
    })
  })

  describe('sendMessage', () => {
    it('auto-creates a session when none is active, then appends the message', async () => {
      // loadActive: no active
      queue.push({ status: 200, body: { activeId: null, configured: true } })
      // createSession
      queue.push({ status: 201, body: { id: 1, title: '', createdAt: 1, updatedAt: 1 } })
      // setActiveSessionId (called inside createSession)
      queue.push({ status: 200, body: { sessionId: 1 } })
      // refreshSessions after done
      queue.push({ status: 200, body: [{ id: 1, title: 'x', createdAt: 1, updatedAt: 2 }] })

      const h = setup()
      await h.api.loadActive()
      await h.api.sendMessage('x')
      expect(h.activeSession.value?.id).toBe(1)
      expect(h.activeSession.value?.title).toBe('x')
      expect(h.messages.value).toHaveLength(2)
      expect(h.messages.value[0]).toMatchObject({ id: 7, role: 'user', content: 'x' })
      expect(h.messages.value[1]).toMatchObject({ id: 8, role: 'assistant' })
    })

    it('is a no-op for empty / whitespace content', async () => {
      const h = setup()
      await h.api.sendMessage('   ')
      expect(h.messages.value).toEqual([])
    })

    it('replaces the optimistic message with the server response', async () => {
      queue.push({ status: 200, body: { activeId: 5, configured: true } })
      queue.push({ status: 200, body: [] })
      // refreshSessions after done
      queue.push({ status: 200, body: [] })

      const h = setup()
      await h.api.loadActive()
      await h.api.sendMessage('hello')
      expect(h.messages.value).toHaveLength(2)
      expect(h.messages.value[0]).toMatchObject({ id: 7, role: 'user', content: 'hello' })
      expect(h.messages.value[1]).toMatchObject({ id: 8, role: 'assistant' })
    })
  })

  describe('switchSession', () => {
    it('sets the active session, fetches messages, and updates state', async () => {
      queue.push({ status: 200, body: { sessionId: 42 } }) // setActive
      queue.push({ status: 200, body: [{ id: 1, sessionId: 42, role: 'user', content: 'm', createdAt: 1 }] })
      const h = setup()
      await h.api.switchSession(42)
      expect(h.activeSession.value?.id).toBe(42)
      expect(h.messages.value[0].content).toBe('m')
    })
  })

  describe('refreshSessions', () => {
    it('populates the sessions list', async () => {
      queue.push({ status: 200, body: [{ id: 1, title: 'a', createdAt: 1, updatedAt: 1 }] })
      const h = setup()
      await h.api.refreshSessions()
      expect(h.sessions.value).toHaveLength(1)
      expect(h.sessions.value[0].title).toBe('a')
    })
  })
})

// streamChat is mocked at the module boundary. The default mock
// produces a happy-path event sequence: user id, two tokens, done.
vi.mock('../../../lib/ai-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/ai-api')>()
  return {
    ...actual,
    streamChat: vi.fn(async function* () {
      yield { type: 'user', id: 7 }
      yield { type: 'token', text: 'hi ' }
      yield { type: 'token', text: 'there' }
      yield { type: 'done', userId: 7, assistantId: 8 }
    }),
  }
})

describe('sendAndStream', () => {
  it('optimistically inserts user + assistant, then replaces ids on done', async () => {
    // loadActive
    queue.push({ status: 200, body: { activeId: 1, configured: true } })
    queue.push({ status: 200, body: [] })
    // refreshSessions after done
    queue.push({ status: 200, body: [] })

    const h = setup()
    await h.api.loadActive()
    await h.api.sendAndStream('hello')
    expect(h.messages.value).toHaveLength(2)
    expect(h.messages.value[0]).toMatchObject({ id: 7, role: 'user', content: 'hello' })
    expect(h.messages.value[1]).toMatchObject({
      id: 8, role: 'assistant', content: 'hi there',
    })
    expect(h.busy.value).toBe(false)
    expect(h.errorState.value).toBeNull()
  })

  it('appends [error: ...] to the assistant and sets errorState on error event', async () => {
    const { streamChat } = await import('../../../lib/ai-api')
    vi.mocked(streamChat).mockImplementationOnce(async function* () {
      yield { type: 'user', id: 9 }
      yield { type: 'token', text: 'partial ' }
      yield { type: 'error', reason: 'llm-error' }
    })

    queue.push({ status: 200, body: { activeId: 1, configured: true } })
    queue.push({ status: 200, body: [] })

    const h = setup()
    await h.api.loadActive()
    await h.api.sendAndStream('hi')
    expect(h.messages.value[0].id).toBe(9)
    expect(h.messages.value[1].id).toBe(-1)
    expect(h.messages.value[1].content).toContain('partial ')
    expect(h.messages.value[1].content).toContain('[error: llm-error]')
    expect(h.errorState.value).toBe('llm-error')
  })

  it('is a no-op when called while busy is true', async () => {
    const { streamChat } = await import('../../../lib/ai-api')
    // First call: hangs (returns a never-resolving async gen).
    // Second call: would yield, but should be a no-op.
    vi.mocked(streamChat)
      .mockImplementationOnce(async function* () {
        // hang forever
        await new Promise(() => {})
      })
      .mockImplementationOnce(async function* () {
        yield { type: 'user', id: 1 }
        yield { type: 'done', userId: 1, assistantId: 2 }
      })

    queue.push({ status: 200, body: { activeId: 1, configured: true } })
    queue.push({ status: 200, body: [] })

    const h = setup()
    await h.api.loadActive()
    const p1 = h.api.sendAndStream('first')
    // Don't await — busy is now true.
    await h.api.sendAndStream('second')
    // The second call should not have queued any messages beyond
    // what the first one already optimistically inserted.
    expect(h.messages.value.filter((m) => m.content === 'second')).toHaveLength(0)
    // Clean up: resolve p1 by aborting. (Not strictly needed; the
    // test will end and vitest will GC the dangling promise.)
    void p1
  })

  it('accumulates tool_use / tool_result into the assistant blocks and forwards file_changed to the bus', async () => {
    const { streamChat } = await import('../../../lib/ai-api')
    // Reset the mockImplementationOnce queue from previous tests
    // (the "busy" test leaves a hanging implementation) and re-set
    // the file-level default before adding our own.
    vi.mocked(streamChat).mockReset()
    vi.mocked(streamChat).mockImplementation(async function* () {
      yield { type: 'user', id: 7 }
      yield { type: 'token', text: 'hi ' }
      yield { type: 'token', text: 'there' }
      yield { type: 'done', userId: 7, assistantId: 8 }
    })
    vi.mocked(streamChat).mockImplementationOnce(async function* () {
      yield { type: 'user', id: 7 }
      yield { type: 'token', text: '我先看下文件 ' }
      yield { type: 'tool_use', id: 'toolu_01', name: 'read_file', input: { path: 'a' } }
      yield { type: 'tool_result', tool_use_id: 'toolu_01', content: 'file body', is_error: false }
      yield { type: 'file_changed', path: 'a', kind: 'write', newMtime: 1, newRaw: 'file body' }
      yield { type: 'token', text: '改好了' }
      yield { type: 'done', userId: 7, assistantId: 8 }
    })

    queue.push({ status: 200, body: { activeId: 1, configured: true } })
    queue.push({ status: 200, body: [] })
    queue.push({ status: 200, body: [] }) // refreshSessions after done

    const { __resetFallbackFileChangesForTesting, getFallbackVaultFileChanges } = await import('../context/fileChanges')
    __resetFallbackFileChangesForTesting()
    __resetForTesting()
    const bus = getFallbackVaultFileChanges().events

    const h = setup()
    await h.api.loadActive()
    await h.api.sendAndStream('hi')
    const assistant = h.messages.value[1]
    expect(assistant.content).toBe('我先看下文件 改好了')
    expect(assistant.blocks?.toolCalls).toHaveLength(1)
    expect(assistant.blocks?.toolCalls[0]).toMatchObject({
      id: 'toolu_01',
      name: 'read_file',
      input: { path: 'a' },
      result: { content: 'file body', is_error: false },
    })
    expect(bus.value).toHaveLength(1)
    expect(bus.value[0]).toMatchObject({ path: 'a', kind: 'write', newMtime: 1, newRaw: 'file body', seq: 1 })
    expect(h.messages.value[0].id).toBe(7)
    expect(h.messages.value[1].id).toBe(8)
  })

  it('stop() aborts an in-flight stream, clears busy, and tags the assistant with [aborted]', async () => {
    const { streamChat } = await import('../../../lib/ai-api')
    vi.mocked(streamChat).mockReset()
    // The mock has to honor the AbortSignal: when stop() fires,
    // useAiHistory's AbortController rejects the signal, and the
    // in-flight generator's hang needs to bail out at that point.
    // In production streamChat passes the signal to fetch (which
    // raises AbortError on abort); here we replicate that by
    // listening to the signal ourselves.
    vi.mocked(streamChat).mockImplementation(async function* (_req, signal) {
      yield { type: 'user', id: 7 }
      yield { type: 'token', text: 'partial' }
      await new Promise<void>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException('aborted', 'AbortError'))
          return
        }
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    })

    queue.push({ status: 200, body: { activeId: 1, configured: true } })
    queue.push({ status: 200, body: [] })

    const h = setup()
    await h.api.loadActive()
    const p = h.api.sendAndStream('hi')
    // Give the microtask queue a chance to enter the streamChat
    // generator and start hanging.
    await Promise.resolve()
    expect(h.busy.value).toBe(true)

    h.api.stop()
    await p

    expect(h.busy.value).toBe(false)
    const assistant = h.messages.value[1]
    expect(assistant.id).toBe(-1)
    expect(assistant.content).toContain('partial')
    expect(assistant.content).toContain('[aborted]')
    // No errorState — abort is a user action, not an error.
    expect(h.errorState.value).toBeNull()
  })

  it('stop() is a no-op when nothing is in flight', async () => {
    const h = setup()
    // Just call it. Should not throw, should not flip busy.
    h.api.stop()
    expect(h.busy.value).toBe(false)
  })
})

// Edit-10.3: sendAndStream forwards the caller's send-time snapshot
// (options.liveContext) to streamChat untouched — it never re-reads
// workspace state, never adds a legacy path, and never persists the
// snapshot into message state.
describe('sendAndStream liveContext transport (Edit-10.3)', () => {
  function documentSnapshot(raw = 'SNAPSHOT_BODY') {
    return {
      v: 1 as const,
      kind: 'document' as const,
      capturedAt: 1,
      vaultId: 'vault-a',
      workspaceTabId: 'notes/a',
      identity: { documentId: 'doc-a', path: 'notes/a' },
      title: 'A',
      raw,
      revision: 2,
      savedRevision: 1,
      dirty: true,
      saveStatus: 'dirty' as const,
    }
  }

  async function resetHappyStream() {
    const { streamChat } = await import('../../../lib/ai-api')
    vi.mocked(streamChat).mockReset()
    vi.mocked(streamChat).mockImplementation(async function* () {
      yield { type: 'user', id: 7 }
      yield { type: 'done', userId: 7, assistantId: 8 }
    })
    return vi.mocked(streamChat)
  }

  it('forwards options.liveContext to streamChat verbatim, with no currentNotePath', async () => {
    const streamChatMock = await resetHappyStream()
    queue.push({ status: 200, body: { activeId: 1, configured: true } })
    queue.push({ status: 200, body: [] })
    queue.push({ status: 200, body: [] }) // refreshSessions

    const h = setup()
    await h.api.loadActive()
    const liveContext = documentSnapshot()
    await h.api.sendAndStream('hi', { liveContext })

    const req = streamChatMock.mock.calls[0][0] as unknown as Record<string, unknown>
    expect(req).toEqual({ sessionId: 1, content: 'hi', liveContext })
    expect(req.liveContext).toBe(liveContext) // same object, not a re-read
    expect('currentNotePath' in req).toBe(false)
  })

  it('omits the liveContext key entirely when the option is not provided', async () => {
    const streamChatMock = await resetHappyStream()
    queue.push({ status: 200, body: { activeId: 1, configured: true } })
    queue.push({ status: 200, body: [] })
    queue.push({ status: 200, body: [] })

    const h = setup()
    await h.api.loadActive()
    await h.api.sendAndStream('hi')

    const req = streamChatMock.mock.calls[0][0] as unknown as Record<string, unknown>
    expect(req).toEqual({ sessionId: 1, content: 'hi' })
    expect('liveContext' in req).toBe(false)
    expect('currentNotePath' in req).toBe(false)
  })

  it('keeps the send-time snapshot when the session must be created asynchronously first', async () => {
    const streamChatMock = await resetHappyStream()
    // No active session: sendAndStream awaits createSession() +
    // setActiveSessionId BEFORE streaming. The snapshot handed in at
    // call time must be exactly what reaches the wire afterwards.
    queue.push({ status: 200, body: { activeId: null, configured: true } }) // loadActive
    queue.push({ status: 201, body: { id: 5, title: '', createdAt: 1, updatedAt: 1 } }) // createSession
    queue.push({ status: 200, body: { sessionId: 5 } }) // setActiveSessionId
    queue.push({ status: 200, body: [] }) // refreshSessions

    const h = setup()
    await h.api.loadActive()
    const liveContext = documentSnapshot('CAPTURED_BEFORE_SESSION_CREATE')
    await h.api.sendAndStream('hi', { liveContext })

    const req = streamChatMock.mock.calls[0][0] as unknown as Record<string, unknown>
    expect(req.sessionId).toBe(5)
    expect(req.liveContext).toBe(liveContext)
    expect((req.liveContext as { raw: string }).raw).toBe('CAPTURED_BEFORE_SESSION_CREATE')
  })

  it('does not add the live context to message state or user content', async () => {
    await resetHappyStream()
    queue.push({ status: 200, body: { activeId: 1, configured: true } })
    queue.push({ status: 200, body: [] })
    queue.push({ status: 200, body: [] })

    const h = setup()
    await h.api.loadActive()
    await h.api.sendAndStream('plain text', {
      liveContext: documentSnapshot('MSG_STATE_SENTINEL_XYZ'),
    })

    expect(h.messages.value[0]).toMatchObject({ role: 'user', content: 'plain text' })
    expect(JSON.stringify(h.messages.value)).not.toContain('MSG_STATE_SENTINEL_XYZ')
  })

  it('abort/stop behavior is unchanged with a liveContext in flight', async () => {
    const { streamChat } = await import('../../../lib/ai-api')
    vi.mocked(streamChat).mockReset()
    vi.mocked(streamChat).mockImplementation(async function* (_req, signal) {
      yield { type: 'user', id: 7 }
      await new Promise<void>((_resolve, reject) => {
        // Mirror production: fetch raises AbortError whether the
        // signal is already aborted or aborts mid-flight.
        if (signal?.aborted) {
          reject(new DOMException('aborted', 'AbortError'))
          return
        }
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    })
    queue.push({ status: 200, body: { activeId: 1, configured: true } })
    queue.push({ status: 200, body: [] })

    const h = setup()
    await h.api.loadActive()
    const p = h.api.sendAndStream('hi', { liveContext: documentSnapshot() })
    await Promise.resolve()
    h.api.stop()
    await p
    expect(h.busy.value).toBe(false)
    expect(h.messages.value[1].content).toContain('[aborted]')
  })
})

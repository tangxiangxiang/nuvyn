// @vitest-environment jsdom
// Tests for the client-side link index composable. We stub
// global.fetch so the test exercises the full refresh + bus
// debounce flow without hitting the network.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import {
  getLinkIndex,
  refreshLinkIndex,
  useLinkIndexSubscription,
  __resetLinkIndexForTesting,
  __resetLinkIndexSubscriptionForTesting,
} from '../useLinkIndex'
import { __resetFallbackFileChangesForTesting, createVaultFileChanges } from '../context/fileChanges'

type FetchCall = { url: string; init: RequestInit }
type FetchResponse = { status: number; body: unknown }

let calls: FetchCall[] = []
let responses: FetchResponse[] = []
let pendingRoutes: Map<string, FetchResponse> = new Map()
let testFileChanges = createVaultFileChanges()

function enqueue(method: string, path: string, response: FetchResponse) {
  pendingRoutes.set(`${method} ${path}`, response)
}

beforeEach(() => {
  calls = []
  responses = []
  pendingRoutes = new Map()
  testFileChanges = createVaultFileChanges()
  __resetLinkIndexForTesting()
  __resetLinkIndexSubscriptionForTesting()
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    const m = init?.method ?? 'GET'
    calls.push({ url: u, init: init ?? {} })
    const key = `${m} ${u}`
    const next = pendingRoutes.get(key) ?? responses.shift() ?? { status: 200, body: {} }
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
})

afterEach(() => {
  vi.useRealTimers()
  __resetLinkIndexForTesting()
  __resetLinkIndexSubscriptionForTesting()
})

describe('useLinkIndex', () => {
  describe('initial state', () => {
    it('returns an empty initial state from getLinkIndex', () => {
      const idx = getLinkIndex()
      expect(idx.value.paths.size).toBe(0)
      expect(idx.value.outgoing).toEqual({})
      expect(idx.value.titles).toEqual({})
      expect(idx.value.lastFetched).toBe(0)
    })

    it('returns the same ref on subsequent calls (singleton)', () => {
      const a = getLinkIndex()
      const b = getLinkIndex()
      expect(a).toBe(b)
    })

    it('keeps indexes owned by different vaults isolated', () => {
      const vaultA = createVaultFileChanges()
      const vaultB = createVaultFileChanges()
      const a = getLinkIndex(vaultA)
      const b = getLinkIndex(vaultB)

      a.value = { paths: new Set(['a']), outgoing: {}, titles: { a: 'A' }, lastFetched: 1 }

      expect(a).not.toBe(b)
      expect(Array.from(a.value.paths)).toEqual(['a'])
      expect(b.value.paths.size).toBe(0)
      expect(b.value.titles).toEqual({})
    })

    it('uses the replacement fallback after its test reset', () => {
      getLinkIndex().value = { paths: new Set(['old']), outgoing: {}, titles: {}, lastFetched: 1 }
      __resetFallbackFileChangesForTesting()
      expect(getLinkIndex().value.paths.size).toBe(0)
    })
  })

  describe('refreshLinkIndex', () => {
    it('fetches /api/links/index and populates the state', async () => {
      enqueue('GET', '/api/links/index', {
        status: 200,
        body: {
          paths: ['a', 'b'],
          outgoing: { a: [{ target: 'b', kind: 'wiki' }] },
          titles: { a: 'Alpha', b: 'Beta' },
        },
      })
      await refreshLinkIndex()
      const state = getLinkIndex().value
      expect(Array.from(state.paths)).toEqual(['a', 'b'])
      expect(state.outgoing).toEqual({ a: [{ target: 'b', kind: 'wiki' }] })
      expect(state.titles).toEqual({ a: 'Alpha', b: 'Beta' })
      expect(state.lastFetched).toBeGreaterThan(0)
    })

    it('keeps compatibility with older snapshots that do not include titles', async () => {
      enqueue('GET', '/api/links/index', {
        status: 200,
        body: {
          paths: ['a'],
          outgoing: {},
        },
      })
      await refreshLinkIndex()
      expect(getLinkIndex().value.titles).toEqual({})
    })

    it('keeps the previous state if the fetch fails', async () => {
      enqueue('GET', '/api/links/index', { status: 200, body: { paths: ['a'], outgoing: {} } })
      await refreshLinkIndex()
      const before = getLinkIndex().value
      // Now the second fetch returns 500.
      enqueue('GET', '/api/links/index', { status: 500, body: { error: 'oops' } })
      await refreshLinkIndex()
      const after = getLinkIndex().value
      expect(after.paths).toBe(before.paths)
      expect(after.lastFetched).toBe(before.lastFetched)
    })
  })

  describe('useLinkIndexSubscription', () => {
    function mountWithSubscription() {
      // useLinkIndexSubscription uses onMounted, so we need a real
      // component context.
      let installed = false
      const Comp = defineComponent({
        setup() {
          useLinkIndexSubscription(testFileChanges)
          installed = true
          return () => h('div')
        },
      })
      mount(Comp)
      return { installed }
    }

    it('triggers an initial refresh on mount', async () => {
      enqueue('GET', '/api/links/index', {
        status: 200,
        body: { paths: ['a'], outgoing: {} },
      })
      mountWithSubscription()
      // onMounted is sync; the refresh is async — wait for it.
      await new Promise((r) => setTimeout(r, 10))
      const fetched = calls.some((c) => c.url === '/api/links/index')
      expect(fetched).toBe(true)
    })

    it('coalesces two bus events within the debounce window into a single refresh', async () => {
      vi.useFakeTimers()
      enqueue('GET', '/api/links/index', { status: 200, body: { paths: [], outgoing: {} } })
      mountWithSubscription()
      // Let the on-mount refresh resolve (it has no debounce).
      await vi.runAllTimersAsync()

      // Drain the initial fetch from the call list so we only count
      // the debounced refresh.
      const beforeCount = calls.length
      // Two rapid bus publishes.
      testFileChanges.publish({ path: 'a.md', kind: 'write' })
      testFileChanges.publish({ path: 'b.md', kind: 'write' })
      // Advance less than 400ms — the debounce should not have fired.
      await vi.advanceTimersByTimeAsync(200)
      expect(calls.length).toBe(beforeCount)
      // Advance past 400ms — the debounce fires once.
      await vi.advanceTimersByTimeAsync(300)
      expect(calls.length - beforeCount).toBe(1)
    })

    it('a second debounced refresh fires after the first completes', async () => {
      vi.useFakeTimers()
      enqueue('GET', '/api/links/index', { status: 200, body: { paths: [], outgoing: {} } })
      enqueue('GET', '/api/links/index', { status: 200, body: { paths: [], outgoing: {} } })
      mountWithSubscription()
      await vi.runAllTimersAsync()
      const initial = calls.length

      testFileChanges.publish({ path: 'a.md', kind: 'write' })
      await vi.advanceTimersByTimeAsync(500)
      expect(calls.length - initial).toBe(1)

      testFileChanges.publish({ path: 'b.md', kind: 'write' })
      await vi.advanceTimersByTimeAsync(500)
      expect(calls.length - initial).toBe(2)
    })
  })

  describe('__resetLinkIndexForTesting', () => {
    it('clears the singleton state', async () => {
      enqueue('GET', '/api/links/index', { status: 200, body: { paths: ['a'], outgoing: {} } })
      await refreshLinkIndex()
      expect(getLinkIndex().value.paths.size).toBe(1)
      __resetLinkIndexForTesting()
      expect(getLinkIndex().value.paths.size).toBe(0)
      expect(getLinkIndex().value.outgoing).toEqual({})
    })
  })
})

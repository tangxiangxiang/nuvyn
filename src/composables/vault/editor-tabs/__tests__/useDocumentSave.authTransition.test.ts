// @vitest-environment jsdom
import { ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PostSummary } from '../../../../lib/api'
import type { Tab } from '../../../../components/vault/tabs'
import { createVaultFileChanges } from '../../context/fileChanges'
import { useDocumentSave } from '../useDocumentSave'

function tab(path: string, raw: string): Tab {
  return {
    path,
    title: path,
    raw,
    originalRaw: raw,
    revision: 0,
    savedRevision: 0,
    savingRevision: null,
    saveStatus: 'idle',
    error: null,
    loadError: null,
    loading: false,
    serverMtime: 1,
    externalRaw: null,
  }
}

function saveResponse(path: string, raw: string): Response {
  const post: PostSummary = {
    path,
    title: path,
    created: '2026-01-01',
    updated: '2026-01-01',
    tags: [],
    summary: '',
    size: raw.length,
    mtime: 2,
  }
  return new Response(JSON.stringify({ ok: true, raw, post }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function setup(tabs: Tab[]) {
  const tabRef = ref(tabs)
  const save = useDocumentSave({
    tabs: tabRef,
    activePath: ref<string | null>(tabs[0]?.path ?? null),
    applyPostSummary: vi.fn(),
    fileChanges: createVaultFileChanges(),
    toastError: vi.fn(),
  })
  return { tabs: tabRef, save }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useDocumentSave authentication transition seams', () => {
  it('saves every legal dirty tab and reports unresolved external work', async () => {
    const sent: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { raw: string }
      sent.push(`${url}:${body.raw}`)
      return saveResponse(url.replace('/api/posts/', ''), body.raw)
    }))
    const h = setup([tab('a', 'A'), tab('b', 'B'), tab('c', 'C')])
    h.save.onEditorChange('a', 'A1')
    h.save.onEditorChange('b', 'B1')
    h.tabs.value[2].saveStatus = 'external'
    h.tabs.value[2].externalRaw = 'server C'

    const transition = await h.save.prepareAuthTransition('logout')
    const result = await h.save.saveAllForActiveLogout()

    expect(result.attempted).toEqual(['a', 'b'])
    expect(result.unsafe).toEqual([{ path: 'c', reason: 'external' }])
    expect(sent).toEqual(['/api/posts/a:A1', '/api/posts/b:B1'])
    transition.release(false)
  })

  it('keeps the auth transition quiescent until a cancellation resumes autosave', async () => {
    vi.useFakeTimers()
    const sent: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { raw: string }
      sent.push(`${url}:${body.raw}`)
      return saveResponse(url.replace('/api/posts/', ''), body.raw)
    }))
    const h = setup([tab('a', 'A')])
    h.save.onEditorChange('a', 'A1')

    const transition = await h.save.prepareAuthTransition('logout')
    // The auth transition, unlike a normal rename barrier, prevents new
    // editor revisions while the final decision is pending.
    h.save.onEditorChange('a', 'A2')
    expect(h.tabs.value[0].raw).toBe('A1')
    transition.release(false)
    transition.release(true)

    await vi.advanceTimersByTimeAsync(800)
    expect(sent).toEqual(['/api/posts/a:A1'])
  })

  it('waits for a running save before exposing the transition handle', async () => {
    let finish!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => { finish = resolve })
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(pending))
    const h = setup([tab('a', 'A')])
    h.save.onEditorChange('a', 'A1')
    const saving = h.save.doSave('a')
    await vi.waitFor(() => expect(h.tabs.value[0].savingRevision).toBe(1))

    let prepared = false
    const transitionPromise = h.save.prepareAuthTransition('logout').then((value) => {
      prepared = true
      return value
    })
    await Promise.resolve()
    expect(prepared).toBe(false)

    finish(saveResponse('a', 'A1'))
    await saving
    const transition = await transitionPromise
    expect(prepared).toBe(true)
    transition.release(true)
  })

  it('blocks new server saves during a session-expiry transition', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const h = setup([tab('a', 'A')])
    h.save.onEditorChange('a', 'A1')
    const transition = await h.save.prepareAuthTransition('expired')

    await h.save.doSave('a')
    expect(fetchMock).not.toHaveBeenCalled()
    transition.release(false)
  })
})

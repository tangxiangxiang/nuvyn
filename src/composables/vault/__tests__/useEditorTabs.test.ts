// @vitest-environment jsdom
// Tests for useEditorTabs — the most stateful composable in the vault.
//
// The composable owns:
//   - the tab list + active path,
//   - the save state machine (idle / dirty / saving / saved / error),
//   - the 800ms debounce on editor edits,
//   - the route sync (`/vault/notes/draft` → openPost),
//   - the keyboard shortcuts (Cmd-S, Cmd-W, Cmd-B, Ctrl-Tab),
//   - and the command-palette "new" flow (slugify + createPost + openPost).
//
// We stub the network (fetch), the router (vue-router with a real
// memory router), and the toast/confirm modules so the tests are
// deterministic. The debounce is exercised via vi.useFakeTimers().

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref, computed, type Ref } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount } from '@vue/test-utils'

// Stubs for the toast / confirm composables. The real ones render a
// <ToastHost /> / <ConfirmHost /> mounted at <body>; here we just
// capture the calls so the test can assert on them.
const toastCalls: { type: string; message: string }[] = []
const confirmAnswer: Ref<boolean | null> = ref(null)
vi.mock('../../useToast', () => ({
  useToast: () => ({
    info: (m: string) => toastCalls.push({ type: 'info', message: m }),
    success: (m: string) => toastCalls.push({ type: 'success', message: m }),
    error: (m: string) => toastCalls.push({ type: 'error', message: m }),
  }),
}))
vi.mock('../../useConfirm', () => ({
  useConfirm: () => ({
    confirm: (_msg: string) => new Promise<boolean>((resolve) => {
      // Capture the resolve so the test can drive the answer.
      confirmResolve = resolve
    }),
  }),
}))
let confirmResolve: ((ok: boolean) => void) | null = null
function answerConfirm(ok: boolean) {
  confirmResolve?.(ok)
  confirmResolve = null
}

import { useEditorTabs, __setVaultIdForTesting, resetTabPersistenceForTesting } from '../useEditorTabs'
import EditorTabs from '../../../components/vault/EditorTabs.vue'
import { deriveDocumentSavePresentation } from '../editor-tabs/savePresentation'
import { createVaultFileChanges, type VaultFileChanges } from '../context/fileChanges'
import { useI18n } from '../../useI18n'
import type { PostSummary, TreeNode } from '../../../lib/api'
import {
  getMarkdownModel,
  registerMarkdownModel,
  resetMarkdownModelsForTesting,
} from '../../../components/vault/monacoModelRegistry'

// --- helpers ---------------------------------------------------------------

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/vault', component: { template: '<div/>' } },
      // The composable reads `route.params.pathMatch` as a string[]; vue-
      // router's splat turns `/vault/a/b` into `['a', 'b']`.
      { path: '/vault/:pathMatch(.*)*', component: { template: '<div/>' } },
    ],
  })
}

interface Harness {
  unmount: () => void
  fileChanges: VaultFileChanges
  openPost: (p: string) => Promise<void>
  closeTab: (p: string) => Promise<boolean>
  closeMany: (paths: string[]) => Promise<boolean>
  selectTab: (p: string) => void
  doSaveNow: () => Promise<void>
  resolveExternal: (path: string, strategy: 'disk' | 'local') => Promise<void>
  pollExternalChanges: () => Promise<void>
  onEditorChange: (p: string, v: string) => void
  onKeydown: (e: KeyboardEvent) => void
  onCommandPaletteNew: (t: string) => Promise<void>
  refresh: () => Promise<void>
  resumeDeferredDiaryTabs: () => Promise<void>
  applyPostSummary: (post: PostSummary) => void
  renameOpenDocuments: (mappings: ReadonlyArray<{ from: string; to: string }>) => void
  removeOpenDocuments: (paths: readonly string[]) => void
  reorderOpenDocuments: (paths: readonly string[]) => boolean
  activePath: Ref<string | null>
  activeSize: Ref<number>
  posts: Ref<PostSummary[]>
  tree: Ref<TreeNode[]>
  tabs: Ref<{
    path: string
    title: string
    raw: string
    originalRaw: string
    revision: number
    savedRevision: number
    savingRevision: number | null
    saveStatus: string
    loading: boolean
    loadError: string | null
    serverMtime?: number
    externalRaw?: string | null
    externalKind?: 'modified' | 'deleted' | 'unreadable' | null
  }[]>
  // The selectPanel / toggleViewMode spies are captured separately
  // because the composable receives them as constructor args and
  // doesn't return them.
  selectPanel: ReturnType<typeof vi.fn>
  toggleViewMode: ReturnType<typeof vi.fn>
}

const mountedWrappers = new Set<{ unmount: () => void }>()

afterEach(() => {
  for (const wrapper of mountedWrappers) {
    wrapper.unmount()
  }
  mountedWrappers.clear()
})

function setup(
  overrides: Partial<Parameters<typeof useEditorTabs>[0]> = {},
  initialPath = '/vault',
): Promise<Harness> {
  return new Promise(async (resolveOuter) => {
    let captured: Harness | null = null
    const Comp = defineComponent({
      setup() {
        const selectPanel = vi.fn()
        const toggleViewMode = vi.fn()
        const fileChanges = createVaultFileChanges()
        const api = useEditorTabs({ vaultId: 'test-vault', selectPanel, toggleViewMode, fileChanges, ...overrides })
        captured = { ...(api as unknown as Omit<Harness, 'selectPanel' | 'toggleViewMode' | 'fileChanges' | 'unmount'>), selectPanel, toggleViewMode, fileChanges, unmount: () => {} }
        return () => h('div')
      },
    })
    const router = makeRouter()
    router.push(initialPath).catch(() => {})
    await router.isReady()
    const wrapper = mount(Comp, { global: { plugins: [router] } })
    mountedWrappers.add(wrapper)
    captured!.unmount = () => {
      if (!mountedWrappers.delete(wrapper)) return
      wrapper.unmount()
    }
    // useEditorTabs runs refresh() in onMounted; wait for it to settle.
    await nextTick()
    await flushPromises()
    resolveOuter(captured!)
  })
}

async function mountWithRouter(
  overrides: Partial<Parameters<typeof useEditorTabs>[0]> = {},
  initialPath = '/vault',
  beforeMount?: (router: ReturnType<typeof makeRouter>) => void,
): Promise<{ harness: Harness; router: ReturnType<typeof makeRouter> }> {
  let captured: Harness | null = null
  const router = makeRouter()
  await router.push(initialPath)
  await router.isReady()
  beforeMount?.(router)
  const Comp = defineComponent({
    setup() {
      const selectPanel = vi.fn()
      const toggleViewMode = vi.fn()
      const fileChanges = createVaultFileChanges()
      const api = useEditorTabs({
        vaultId: 'test-vault',
        selectPanel,
        toggleViewMode,
        fileChanges,
        ...overrides,
      })
      captured = {
        ...(api as unknown as Omit<Harness, 'selectPanel' | 'toggleViewMode' | 'fileChanges' | 'unmount'>),
        selectPanel,
        toggleViewMode,
        fileChanges,
        unmount: () => {},
      }
      return () => h('div')
    },
  })
  const wrapper = mount(Comp, { global: { plugins: [router] } })
  mountedWrappers.add(wrapper)
  captured!.unmount = () => {
    if (!mountedWrappers.delete(wrapper)) return
    wrapper.unmount()
  }
  await nextTick()
  await flushPromises()
  return { harness: captured!, router }
}

function stubFetch(handlers: Record<string, (body?: unknown) => unknown | Promise<unknown>>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const key = `${method} ${url.split('?')[0]}`
    const handler = handlers[key]
    if (!handler) {
      throw new Error(`Unexpected fetch: ${key}`)
    }
    const body = init?.body ? JSON.parse(init.body as string) : undefined
    const result = await handler(body)
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => result,
    }
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function saveResult(path: string, raw: string, size = raw.length, mtime = 2) {
  return {
    ok: true,
    raw,
    post: {
      path,
      title: path.toUpperCase(),
      created: '',
      updated: '',
      tags: [],
      summary: '',
      size,
      mtime,
    },
  }
}

function postSummary(path: string, overrides: Partial<PostSummary> = {}): PostSummary {
  return {
    path,
    title: path.toUpperCase(),
    created: '',
    updated: '',
    tags: [],
    summary: '',
    size: 1,
    mtime: 1,
    ...overrides,
  }
}

function treeFor(...posts: PostSummary[]): TreeNode[] {
  return [{
    kind: 'folder',
    name: 'content',
    path: '',
    children: posts.map((post) => ({
      kind: 'file' as const,
      name: post.path.split('/').pop()!,
      path: post.path,
      title: post.title,
      mtime: post.mtime,
    })),
  }]
}

function findTreeFile(nodes: readonly TreeNode[], path: string): Extract<TreeNode, { kind: 'file' }> | null {
  for (const node of nodes) {
    if (node.kind === 'file' && node.path === path) return node
    if (node.kind === 'folder') {
      const found = findTreeFile(node.children, path)
      if (found) return found
    }
  }
  return null
}

// --- tests -----------------------------------------------------------------

describe('useEditorTabs', () => {
  beforeEach(() => {
    useI18n().setLocale('zh')
    toastCalls.length = 0
    confirmResolve = null
    confirmAnswer.value = null
    // localStorage carries persisted tab state across tests — clear it
    // so each test starts from a known-empty session. The composable
    // reads from it in onMounted (restore) and writes to it via a
    // debounced watcher (persist).
    localStorage.clear()
    // The composable's onMounted calls refresh() → fetch('/api/tree') +
    // fetch('/api/posts'). Tests that need a richer API stub override
    // fetch *after* this default. We can't put a "no-op" stub in afterEach
    // because the real fetch is what crashes here — the default has to be
    // a real stub that returns the minimal shapes the composable reads.
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
    }))
  })

  afterEach(() => {
    resetMarkdownModelsForTesting()
    resetTabPersistenceForTesting()
    useI18n().setLocale('zh')
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('starts with no tabs and no active path', async () => {
    const h = await setup()
    expect(h.tabs.value).toEqual([])
    expect(h.activePath.value).toBeNull()
  })

  it('openPost creates a tab, loads content, and sets active path', async () => {
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/inbox/hello': () => ({
        path: 'inbox/hello',
        raw: '# Hello',
        content: '# Hello',
        frontmatter: { title: 'Hello' },
        size: 7,
        mtime: 0,
      }),
    }))
    const h = await setup()
    await h.openPost('inbox/hello')
    expect(h.tabs.value).toHaveLength(1)
    expect(h.tabs.value[0].path).toBe('inbox/hello')
    expect(h.tabs.value[0].raw).toBe('# Hello')
    expect(h.tabs.value[0].originalRaw).toBe('# Hello')
    expect(h.tabs.value[0].loadError).toBeNull()
    expect(h.activePath.value).toBe('inbox/hello')
  })

  it('openPost reuses an existing tab rather than re-fetching', async () => {
    let getPostCalls = 0
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/inbox/hello': () => {
        getPostCalls++
        return { path: 'inbox/hello', raw: '# Hello', content: '# Hello', frontmatter: {}, size: 7, mtime: 0 }
      },
    }))
    const h = await setup()
    await h.openPost('inbox/hello')
    await h.openPost('inbox/hello')
    expect(getPostCalls).toBe(1)
    expect(h.tabs.value).toHaveLength(1)
  })

  it('strictly reorders existing document proxies and persists immediately', async () => {
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/a': () => ({ path: 'a', raw: 'A', content: 'A', frontmatter: {}, size: 1, mtime: 0 }),
      'GET /api/posts/b': () => ({ path: 'b', raw: 'B', content: 'B', frontmatter: {}, size: 1, mtime: 0 }),
      'GET /api/posts/c': () => ({ path: 'c', raw: 'C', content: 'C', frontmatter: {}, size: 1, mtime: 0 }),
    }))
    const h = await setup()
    await h.openPost('a')
    await h.openPost('b')
    await h.openPost('c')
    const identities = new Map(h.tabs.value.map((tab) => [tab.path, tab]))
    const active = h.activePath.value

    expect(h.reorderOpenDocuments(['c', 'a', 'b'])).toBe(true)
    expect(h.tabs.value.map((tab) => tab.path)).toEqual(['c', 'a', 'b'])
    expect(h.tabs.value.every((tab) => tab === identities.get(tab.path))).toBe(true)
    expect(h.activePath.value).toBe(active)
    expect(JSON.parse(localStorage.getItem('nuvyn:tabs:v1:test-vault')!).paths).toEqual(['c', 'a', 'b'])
    expect(h.reorderOpenDocuments(['c', 'a', 'b'])).toBe(false)
    expect(h.reorderOpenDocuments(['c', 'a'])).toBe(false)
    expect(h.reorderOpenDocuments(['c', 'a', 'unknown'])).toBe(false)
    expect(h.reorderOpenDocuments(['c', 'c', 'a'])).toBe(false)
  })

  it('migrates an open tab path, active route, persistence signal, and Monaco registry', async () => {
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/a': () => ({ path: 'a', raw: 'A', content: 'A', frontmatter: {}, size: 1, mtime: 0 }),
    }))
    const h = await setup()
    await h.openPost('a')
    const oldModel = { isDisposed: vi.fn(() => false), dispose: vi.fn() }
    const staleTarget = { isDisposed: vi.fn(() => false), dispose: vi.fn() }
    registerMarkdownModel('a', oldModel)
    registerMarkdownModel('b', staleTarget)

    h.renameOpenDocuments([{ from: 'a', to: 'b' }])
    await nextTick()

    expect(h.tabs.value[0].path).toBe('b')
    expect(h.activePath.value).toBe('b')
    expect(oldModel.dispose).toHaveBeenCalledOnce()
    expect(staleTarget.dispose).toHaveBeenCalledOnce()
    expect(getMarkdownModel('a')).toBeUndefined()
    expect(getMarkdownModel('b')).toBeUndefined()
    resetMarkdownModelsForTesting()
  })

  it('openPost sets loadError when getPost fails and keeps the tab', async () => {
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/inbox/missing': () => {
        throw new Error('HTTP 404')
      },
    }))
    const h = await setup()
    await h.openPost('inbox/missing')
    expect(h.tabs.value).toHaveLength(1)
    expect(h.tabs.value[0].loadError).toContain('HTTP 404')
  })

  it('openPost switches freely while the previous tab remains dirty', async () => {
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/a': () => ({ path: 'a', raw: 'A', content: 'A', frontmatter: {}, size: 1, mtime: 0 }),
      'GET /api/posts/b': () => ({ path: 'b', raw: 'B', content: 'B', frontmatter: {}, size: 1, mtime: 0 }),
    }))
    const h = await setup()
    await h.openPost('a')
    h.onEditorChange('a', 'A modified')         // mark dirty
    await h.openPost('b')
    expect(h.tabs.value).toHaveLength(2)
    expect(h.tabs.value.find((t) => t.path === 'a')?.saveStatus).toBe('dirty')
    expect(h.activePath.value).toBe('b')
    expect(confirmResolve).toBeNull()
  })

  it('closeTab removes a tab and switches to the next sibling', async () => {
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/a': () => ({ path: 'a', raw: 'A', content: 'A', frontmatter: {}, size: 1, mtime: 0 }),
      'GET /api/posts/b': () => ({ path: 'b', raw: 'B', content: 'B', frontmatter: {}, size: 1, mtime: 0 }),
    }))
    const h = await setup()
    await h.openPost('a')
    await h.openPost('b')
    expect(h.tabs.value.map((t) => t.path)).toEqual(['a', 'b'])
    await h.closeTab('a')
    // 'a' removed; 'b' becomes active (it's the next one).
    expect(h.tabs.value.map((t) => t.path)).toEqual(['b'])
    expect(h.activePath.value).toBe('b')
  })

  it('closeTab asks for confirmation when closing a dirty tab', async () => {
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/a': () => ({ path: 'a', raw: 'A', content: 'A', frontmatter: {}, size: 1, mtime: 0 }),
    }))
    const h = await setup()
    await h.openPost('a')
    h.onEditorChange('a', 'A modified')
    const closeA = h.closeTab('a')
    await Promise.resolve()
    await Promise.resolve()
    // Still in tabs because confirm is pending.
    expect(h.tabs.value).toHaveLength(1)
    answerConfirm(true)
    await closeA
    expect(h.tabs.value).toHaveLength(0)
  })

  it('asks for confirmation before closing a clean externally deleted tab', async () => {
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/a': () => ({ path: 'a', raw: 'A', content: 'A', frontmatter: {}, size: 1, mtime: 0 }),
    }))
    const h = await setup()
    await h.openPost('a')
    Object.assign(h.tabs.value[0], {
      saveStatus: 'external',
      externalKind: 'deleted',
      externalRaw: null,
    })

    const closing = h.closeTab('a')
    await Promise.resolve()
    expect(h.tabs.value).toHaveLength(1)
    answerConfirm(false)
    await expect(closing).resolves.toBe(false)
    expect(h.tabs.value).toHaveLength(1)
  })

  it('closeMany closes all listed tabs in reverse-index order so the active jump is consistent', async () => {
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/a': () => ({ path: 'a', raw: 'A', content: 'A', frontmatter: {}, size: 1, mtime: 0 }),
      'GET /api/posts/b': () => ({ path: 'b', raw: 'B', content: 'B', frontmatter: {}, size: 1, mtime: 0 }),
      'GET /api/posts/c': () => ({ path: 'c', raw: 'C', content: 'C', frontmatter: {}, size: 1, mtime: 0 }),
    }))
    const h = await setup()
    await h.openPost('a')
    await h.openPost('b')
    await h.openPost('c')
    expect(h.tabs.value.map((t) => t.path)).toEqual(['a', 'b', 'c'])
    await h.closeMany(['a', 'b', 'c'])
    expect(h.tabs.value).toEqual([])
    // No active tab left → router replaced to /vault.
    expect(h.activePath.value).toBeNull()
  })

  it('closeMany shows ONE prompt for a batch with multiple dirty tabs (not N)', async () => {
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/a': () => ({ path: 'a', raw: 'A', content: 'A', frontmatter: {}, size: 1, mtime: 0 }),
      'GET /api/posts/b': () => ({ path: 'b', raw: 'B', content: 'B', frontmatter: {}, size: 1, mtime: 0 }),
      'GET /api/posts/c': () => ({ path: 'c', raw: 'C', content: 'C', frontmatter: {}, size: 1, mtime: 0 }),
    }))
    const h = await setup()
    await h.openPost('a')
    await h.openPost('b')
    await h.openPost('c')
    h.onEditorChange('a', 'A modified')
    h.onEditorChange('b', 'B modified')
    // c stays clean
    const closePromise = h.closeMany(['a', 'b', 'c'])
    await Promise.resolve()
    await Promise.resolve()
    // ONE confirm covering both dirty tabs.
    answerConfirm(true)
    await expect(closePromise).resolves.toBe(true)
    expect(h.tabs.value).toEqual([])
  })

  it('asks once before batch closing tabs that include an externally deleted document', async () => {
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/a': () => ({ path: 'a', raw: 'A', content: 'A', frontmatter: {}, size: 1, mtime: 0 }),
      'GET /api/posts/b': () => ({ path: 'b', raw: 'B', content: 'B', frontmatter: {}, size: 1, mtime: 0 }),
    }))
    const h = await setup()
    await h.openPost('a')
    await h.openPost('b')
    Object.assign(h.tabs.value[0], {
      saveStatus: 'external',
      externalKind: 'deleted',
      externalRaw: null,
    })

    const closing = h.closeMany(['a', 'b'])
    await Promise.resolve()
    answerConfirm(false)
    await expect(closing).resolves.toBe(false)
    expect(h.tabs.value.map((tab) => tab.path)).toEqual(['a', 'b'])
  })

  it('closeMany aborts entirely when the user declines the dirty prompt', async () => {
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/a': () => ({ path: 'a', raw: 'A', content: 'A', frontmatter: {}, size: 1, mtime: 0 }),
      'GET /api/posts/b': () => ({ path: 'b', raw: 'B', content: 'B', frontmatter: {}, size: 1, mtime: 0 }),
    }))
    const h = await setup()
    await h.openPost('a')
    await h.openPost('b')
    h.onEditorChange('a', 'A modified')
    const closePromise = h.closeMany(['a', 'b'])
    await Promise.resolve()
    await Promise.resolve()
    answerConfirm(false)                          // user says no
    await expect(closePromise).resolves.toBe(false)
    // BOTH tabs stay — the batch is all-or-nothing on the dirty prompt.
    expect(h.tabs.value.map((t) => t.path)).toEqual(['a', 'b'])
  })

  it('restores autosave after a single or batch dirty close is cancelled', async () => {
    vi.useFakeTimers()
    const saved: string[] = []
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/a': () => ({ path: 'a', raw: 'A', content: 'A', frontmatter: {}, size: 1, mtime: 0 }),
      'GET /api/posts/b': () => ({ path: 'b', raw: 'B', content: 'B', frontmatter: {}, size: 1, mtime: 0 }),
      'PUT /api/posts/a': (body) => { saved.push((body as { raw: string }).raw); return saveResult('a', (body as { raw: string }).raw) },
      'PUT /api/posts/b': (body) => { saved.push((body as { raw: string }).raw); return saveResult('b', (body as { raw: string }).raw) },
    }))
    const h = await setup()
    await h.openPost('a')
    await h.openPost('b')
    h.onEditorChange('a', 'A dirty')
    const single = h.closeTab('a')
    await Promise.resolve()
    await Promise.resolve()
    answerConfirm(false)
    await expect(single).resolves.toBe(false)
    await vi.advanceTimersByTimeAsync(800)
    expect(saved).toContain('A dirty')

    h.onEditorChange('a', 'A dirty again')
    h.onEditorChange('b', 'B dirty')
    const batch = h.closeMany(['a', 'b'])
    await Promise.resolve()
    await Promise.resolve()
    answerConfirm(false)
    await expect(batch).resolves.toBe(false)
    await vi.advanceTimersByTimeAsync(800)
    expect(saved).toEqual(expect.arrayContaining(['A dirty again', 'B dirty']))
  })

  it('closeMany skips the dirty prompt when no tab in the batch is dirty', async () => {
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/a': () => ({ path: 'a', raw: 'A', content: 'A', frontmatter: {}, size: 1, mtime: 0 }),
      'GET /api/posts/b': () => ({ path: 'b', raw: 'B', content: 'B', frontmatter: {}, size: 1, mtime: 0 }),
    }))
    const h = await setup()
    await h.openPost('a')
    await h.openPost('b')
    // No edits — both clean.
    await h.closeMany(['a', 'b'])
    expect(h.tabs.value).toEqual([])
  })

  it('doSave sends PUT and flips saveStatus idle → saving → saved', async () => {
    let putBody: { raw: string } | null = null
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/a': () => ({ path: 'a', raw: 'A', content: 'A', frontmatter: {}, size: 1, mtime: 0 }),
      'PUT /api/posts/a': (body) => {
        putBody = body as { raw: string }
        // Server echoes the post-bump raw; mock returns the same shape.
        return saveResult('a', putBody.raw)
      },
    }))
    const h = await setup()
    await h.openPost('a')
    h.onEditorChange('a', 'A modified')
    expect(h.tabs.value[0].saveStatus).toBe('dirty')
    await h.doSaveNow()
    expect(putBody).toEqual({ raw: 'A modified', baseRaw: 'A' })
    expect(h.tabs.value[0].saveStatus).toBe('saved')
    expect(h.tabs.value[0].originalRaw).toBe('A modified')
  })

  it('serializes saves and persists edits made while a request is in flight', async () => {
    let releaseFirst!: () => void
    const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve })
    const sent: string[] = []
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/a': () => ({ path: 'a', raw: 'A', content: 'A', frontmatter: {}, size: 1, mtime: 0 }),
      'PUT /api/posts/a': async (body) => {
        const raw = (body as { raw: string }).raw
        sent.push(raw)
        if (sent.length === 1) await firstPending
        return saveResult('a', raw, sent.length === 1 ? 10 : 20, sent.length === 1 ? 10 : 20)
      },
    }))
    const h = await setup()
    await h.openPost('a')
    h.onEditorChange('a', 'A1')
    const saving = h.doSaveNow()
    await Promise.resolve()
    h.onEditorChange('a', 'A2')
    releaseFirst()
    await saving
    expect(sent).toEqual(['A1', 'A2'])
    expect(h.tabs.value[0].originalRaw).toBe('A2')
    expect(h.tabs.value[0].saveStatus).toBe('saved')
    expect(h.tabs.value[0].serverMtime).toBe(20)
    expect(h.posts.value[0]).toMatchObject({ size: 20, mtime: 20 })
    expect(findTreeFile(h.tree.value, 'a')).toMatchObject({ mtime: 20 })
  })

  it('updates posts, tree, activeSize, and mtime from PUT without a full refresh', async () => {
    const oldPost = postSummary('a', { title: 'Old', size: 1, mtime: 1 })
    const savedPost = postSummary('a', { title: 'New', size: 20, mtime: 2 })
    const fetchMock = stubFetch({
      'GET /api/posts/a': () => ({ path: 'a', raw: 'A', content: 'A', frontmatter: {}, size: 1, mtime: 1 }),
      'GET /api/tree': () => treeFor(oldPost),
      'GET /api/posts': () => [oldPost],
      'PUT /api/posts/a': (body) => ({
        ok: true,
        raw: (body as { raw: string }).raw,
        post: savedPost,
      }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const h = await setup()
    await h.openPost('a')
    fetchMock.mockClear()

    h.onEditorChange('a', 'A with more content')
    await h.doSaveNow()

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/posts/a')
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ method: 'PUT' }))
    expect(h.posts.value).toEqual([savedPost])
    expect(findTreeFile(h.tree.value, 'a')).toMatchObject({ title: 'New', mtime: 2 })
    expect(h.activeSize.value).toBe(20)
    expect(h.tabs.value[0]).toMatchObject({ title: 'New', serverMtime: 2 })
    expect(h.fileChanges.events.value.at(-1)).toMatchObject({
      path: 'a', kind: 'write', source: 'editor-save', newMtime: 2,
    })
    expect(h.fileChanges.events.value.at(-1)).not.toHaveProperty('newRaw')
  })

  it('keeps concurrent saves for different documents isolated without full GETs', async () => {
    const oldA = postSummary('a')
    const oldB = postSummary('b')
    const responseA = deferred<unknown>()
    const responseB = deferred<unknown>()
    const fetchMock = stubFetch({
      'GET /api/posts/a': () => ({ path: 'a', raw: 'A', content: 'A', frontmatter: {}, size: 1, mtime: 1 }),
      'GET /api/posts/b': () => ({ path: 'b', raw: 'B', content: 'B', frontmatter: {}, size: 1, mtime: 1 }),
      'GET /api/tree': () => treeFor(oldA, oldB),
      'GET /api/posts': () => [oldA, oldB],
      'PUT /api/posts/a': () => responseA.promise,
      'PUT /api/posts/b': () => responseB.promise,
    })
    vi.stubGlobal('fetch', fetchMock)
    const h = await setup()
    await h.openPost('a')
    await h.openPost('b')
    fetchMock.mockClear()

    h.selectTab('a')
    h.onEditorChange('a', 'A2')
    const savingA = h.doSaveNow()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    h.selectTab('b')
    h.onEditorChange('b', 'B2')
    const savingB = h.doSaveNow()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    const savedB = postSummary('b', { title: 'New B', size: 22, mtime: 22 })
    const savedA = postSummary('a', { title: 'New A', size: 11, mtime: 11 })
    responseB.resolve({ ok: true, raw: 'B2', post: savedB })
    responseA.resolve({ ok: true, raw: 'A2', post: savedA })
    await Promise.all([savingA, savingB])

    expect(fetchMock.mock.calls.every(([, init]) => init?.method === 'PUT')).toBe(true)
    expect(h.posts.value).toEqual([savedA, savedB])
    expect(findTreeFile(h.tree.value, 'a')).toMatchObject({ title: 'New A', mtime: 11 })
    expect(findTreeFile(h.tree.value, 'b')).toMatchObject({ title: 'New B', mtime: 22 })
  })

  it('merges a save during refresh with unrelated returned structure', async () => {
    const h = await setup()
    const oldA = postSummary('a', { title: 'Old A', mtime: 1 })
    const newA = postSummary('a', { title: 'New A', size: 20, mtime: 2 })
    const newB = postSummary('b', { title: 'New B', mtime: 3 })
    const pendingTree = deferred<TreeNode[]>()
    const pendingPosts = deferred<PostSummary[]>()
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve({
      ok: true,
      status: 200,
      json: () => url === '/api/tree' ? pendingTree.promise : pendingPosts.promise,
    })))

    const refreshing = h.refresh()
    h.applyPostSummary(newA)
    pendingTree.resolve(treeFor(oldA, newB))
    pendingPosts.resolve([oldA, newB])
    await refreshing

    expect(h.posts.value).toEqual([newA, newB])
    expect(findTreeFile(h.tree.value, 'a')).toMatchObject({ title: 'New A', mtime: 2 })
    expect(findTreeFile(h.tree.value, 'b')).toMatchObject({ title: 'New B', mtime: 3 })
  })

  it('retains a locally confirmed missing path and the newest same-path patch', async () => {
    const h = await setup()
    h.applyPostSummary(postSummary('new/path', { title: 'First', mtime: 1 }))
    const pendingTree = deferred<TreeNode[]>()
    const pendingPosts = deferred<PostSummary[]>()
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve({
      ok: true,
      status: 200,
      json: () => url === '/api/tree' ? pendingTree.promise : pendingPosts.promise,
    })))

    const refreshing = h.refresh()
    const latest = postSummary('new/path', { title: 'Latest', size: 30, mtime: 3 })
    h.applyPostSummary(latest)
    pendingTree.resolve(treeFor())
    pendingPosts.resolve([])
    await refreshing

    expect(h.posts.value).toEqual([latest])
    expect(findTreeFile(h.tree.value, 'new/path')).toMatchObject({ title: 'Latest', mtime: 3 })
    const rootNode = h.tree.value.find((node) => node.kind === 'folder' && node.path === '') as Extract<TreeNode, { kind: 'folder' }>
    const newFolder = rootNode.children.find((node) => node.kind === 'folder' && node.path === 'new') as Extract<TreeNode, { kind: 'folder' }>
    expect(newFolder.children.filter((node) => node.kind === 'file' && node.path === 'new/path')).toHaveLength(1)
  })

  it('lets accepted refreshes take over patches that existed before they started', async () => {
    const h = await setup()
    const localA = postSummary('a', { title: 'Local A', size: 20, mtime: 2 })
    const serverA = postSummary('a', { title: 'Server A', size: 30, mtime: 3 })
    const laterA = postSummary('a', { title: 'Later A', size: 40, mtime: 4 })
    h.applyPostSummary(localA)

    let treeCalls = 0
    let postsCalls = 0
    const fetchMock = stubFetch({
      'GET /api/tree': () => (++treeCalls === 1 ? treeFor(serverA) : treeFor(laterA)),
      'GET /api/posts': () => (++postsCalls === 1 ? [serverA] : [laterA]),
    })
    vi.stubGlobal('fetch', fetchMock)

    await h.refresh()
    expect(h.posts.value).toEqual([serverA])
    expect(findTreeFile(h.tree.value, 'a')).toMatchObject({ title: 'Server A', mtime: 3 })

    await h.refresh()
    expect(h.posts.value).toEqual([laterA])
    expect(findTreeFile(h.tree.value, 'a')).toMatchObject({ title: 'Later A', mtime: 4 })
  })

  it('ignores an older Vault refresh that resolves after a newer one', async () => {
    const h = await setup()
    const treeA = deferred<unknown[]>()
    const postsA = deferred<unknown[]>()
    const treeB = deferred<unknown[]>()
    const postsB = deferred<unknown[]>()
    let treeCalls = 0
    let postCalls = 0
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      const payload = url === '/api/tree'
        ? (++treeCalls === 1 ? treeA.promise : treeB.promise)
        : (++postCalls === 1 ? postsA.promise : postsB.promise)
      return Promise.resolve({ ok: true, status: 200, json: () => payload })
    }))

    const older = h.refresh()
    const newer = h.refresh()
    treeB.resolve([])
    postsB.resolve([{ path: 'new.md', title: 'New', tags: [], size: 1, mtime: 2 }])
    await newer
    treeA.resolve([])
    postsA.resolve([{ path: 'old.md', title: 'Old', tags: [], size: 1, mtime: 1 }])
    await older

    expect(h.posts.value.map((post) => post.path)).toEqual(['new.md'])
  })

  it('waits for an in-flight autosave before closing the document tab', async () => {
    let releaseSave!: () => void
    const pendingSave = new Promise<void>((resolve) => { releaseSave = resolve })
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/a': () => ({ path: 'a', raw: 'A', content: 'A', frontmatter: {}, size: 1, mtime: 0 }),
      'PUT /api/posts/a': async (body) => {
        await pendingSave
        return saveResult('a', (body as { raw: string }).raw)
      },
    }))
    const h = await setup()
    await h.openPost('a')
    await flushPromises()
    h.onEditorChange('a', 'A saved while closing')
    const saving = h.doSaveNow()
    await vi.waitFor(() => expect(h.tabs.value[0].saveStatus).toBe('saving'))

    const closing = h.closeTab('a')
    await Promise.resolve()
    expect(h.tabs.value).toHaveLength(1)

    releaseSave()
    await saving
    await expect(closing).resolves.toBe(true)
    expect(h.tabs.value).toEqual([])
    expect(confirmResolve).toBeNull()
  })

  it('blocks page unload while a tab is dirty', async () => {
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/a': () => ({ path: 'a', raw: 'A', content: 'A', frontmatter: {}, size: 1, mtime: 0 }),
    }))
    const h = await setup()
    await h.openPost('a')
    h.onEditorChange('a', 'unsaved')
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('doSave is a no-op when the tab content matches originalRaw', async () => {
    const fetchSpy = stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/a': () => ({ path: 'a', raw: 'A', content: 'A', frontmatter: {}, size: 1, mtime: 0 }),
      'PUT /api/posts/a': () => { throw new Error('should not PUT') },
    })
    vi.stubGlobal('fetch', fetchSpy)
    const h = await setup()
    await h.openPost('a')
    await h.doSaveNow()
    expect(h.tabs.value[0].saveStatus).toBe('idle')
  })

  it('doSave flips to error on HTTP failure and pushes a toast', async () => {
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/a': () => ({ path: 'a', raw: 'A', content: 'A', frontmatter: {}, size: 1, mtime: 0 }),
      'PUT /api/posts/a': () => { throw new Error('HTTP 500') },
    }))
    const h = await setup()
    await h.openPost('a')
    h.onEditorChange('a', 'A modified')
    await h.doSaveNow()
    expect(h.tabs.value[0].saveStatus).toBe('error')
    expect(toastCalls).toEqual([{ type: 'error', message: expect.stringContaining('保存失败') }])
  })

  it('resolves an external conflict with the disk version', async () => {
    let reads = 0
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [], 'GET /api/posts': () => [],
      'GET /api/posts/a': () => {
        reads += 1
        return { path: 'a', raw: reads === 1 ? 'A' : 'disk', content: '', frontmatter: {}, size: 4, mtime: 2 }
      },
    }))
    const h = await setup()
    await h.openPost('a')
    h.onEditorChange('a', 'local')
    h.tabs.value[0].saveStatus = 'external'
    h.tabs.value[0].externalRaw = 'disk'
    await h.resolveExternal('a', 'disk')
    expect(h.tabs.value[0]).toMatchObject({ raw: 'disk', originalRaw: 'disk', saveStatus: 'idle', externalRaw: null })
  })

  it('keeps the local version after an external conflict and saves it', async () => {
    vi.useFakeTimers()
    const writes: Array<{ raw: string; baseRaw: string }> = []
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [], 'GET /api/posts': () => [],
      'GET /api/posts/a': () => ({ path: 'a', raw: 'A', content: '', frontmatter: {}, size: 1, mtime: 1 }),
      'PUT /api/posts/a': (body) => {
        const input = body as { raw: string; baseRaw: string }
        writes.push(input)
        return saveResult('a', input.raw)
      },
    }))
    const h = await setup()
    await h.openPost('a')
    h.onEditorChange('a', 'local')
    h.tabs.value[0].saveStatus = 'external'
    h.tabs.value[0].externalRaw = 'disk'
    await h.resolveExternal('a', 'local')
    await vi.advanceTimersByTimeAsync(1)
    expect(writes).toEqual([{ raw: 'local', baseRaw: 'disk' }])
    expect(h.tabs.value[0].saveStatus).toBe('saved')
  })

  it('keeps local without a redundant PUT when it already equals the disk snapshot', async () => {
    vi.useFakeTimers()
    let putCount = 0
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [], 'GET /api/posts': () => [],
      'GET /api/posts/a': () => ({ path: 'a', raw: 'A', content: '', frontmatter: {}, size: 1, mtime: 1 }),
      'PUT /api/posts/a': () => {
        putCount += 1
        return saveResult('a', 'disk')
      },
    }))
    const h = await setup()
    await h.openPost('a')
    h.onEditorChange('a', 'disk')
    h.tabs.value[0].saveStatus = 'external'
    h.tabs.value[0].externalRaw = 'disk'

    await h.resolveExternal('a', 'local')
    await vi.advanceTimersByTimeAsync(800)

    expect(putCount).toBe(0)
    expect(h.tabs.value[0]).toMatchObject({
      raw: 'disk',
      originalRaw: 'disk',
      externalRaw: null,
      saveStatus: 'idle',
    })
    expect(h.tabs.value[0].revision).toBe(h.tabs.value[0].savedRevision)
  })

  it('marks a failed save offline and retries when connectivity returns', async () => {
    let online = false
    let attempts = 0
    vi.spyOn(window.navigator, 'onLine', 'get').mockImplementation(() => online)
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [], 'GET /api/posts': () => [],
      'GET /api/posts/a': () => ({ path: 'a', raw: 'A', content: '', frontmatter: {}, size: 1, mtime: 1 }),
      'PUT /api/posts/a': () => {
        attempts += 1
        if (!online) throw new Error('network unavailable')
        return saveResult('a', 'local')
      },
    }))
    const h = await setup()
    await h.openPost('a')
    h.onEditorChange('a', 'local')
    await h.doSaveNow()
    expect(h.tabs.value[0].saveStatus).toBe('offline')
    online = true
    window.dispatchEvent(new Event('online'))
    await flushPromises()
    expect(attempts).toBe(2)
    expect(h.tabs.value[0].saveStatus).toBe('saved')
  })

  it('reloads a clean tab when its file changes on disk', async () => {
    let reads = 0
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [], 'GET /api/posts': () => [],
      'GET /api/posts/a': () => ({ path: 'a', raw: reads++ ? 'disk' : 'A', content: '', frontmatter: {}, size: 4, mtime: reads > 1 ? 2 : 1 }),
      'POST /api/files/state': () => [{ path: 'a', exists: true, mtime: 2, size: 4 }],
    }))
    const h = await setup()
    await h.openPost('a')
    await h.pollExternalChanges()
    expect(h.tabs.value[0]).toMatchObject({ raw: 'disk', originalRaw: 'disk', saveStatus: 'idle', serverMtime: 2 })
  })

  it('preserves a dirty buffer and records the external disk snapshot', async () => {
    let reads = 0
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [], 'GET /api/posts': () => [],
      'GET /api/posts/a': () => ({ path: 'a', raw: reads++ ? 'disk' : 'A', content: '', frontmatter: {}, size: 4, mtime: reads > 1 ? 2 : 1 }),
      'POST /api/files/state': () => [{ path: 'a', exists: true, mtime: 2, size: 4 }],
    }))
    const h = await setup()
    await h.openPost('a')
    h.onEditorChange('a', 'local')
    await h.pollExternalChanges()
    expect(h.tabs.value[0]).toMatchObject({ raw: 'local', externalRaw: 'disk', saveStatus: 'external' })
  })

  it('marks an externally deleted file without discarding its buffer', async () => {
    let recovered = ''
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [], 'GET /api/posts': () => [],
      'GET /api/posts/a': () => ({ path: 'a', raw: 'A', content: '', frontmatter: {}, size: 1, mtime: 1 }),
      'POST /api/files/state': () => [{ path: 'a', exists: false, mtime: 0, size: 0 }],
      'PUT /api/recover/a': (body) => {
        recovered = (body as { raw: string }).raw
        return {
          ok: true,
          raw: recovered,
          mtime: 3,
          post: postSummary('a', { size: recovered.length, mtime: 3 }),
        }
      },
    }))
    const h = await setup()
    await h.openPost('a')
    await h.pollExternalChanges()
    expect(h.tabs.value[0]).toMatchObject({ raw: 'A', saveStatus: 'external', error: '文件已从磁盘删除' })
    await h.resolveExternal('a', 'local')
    expect(recovered).toBe('A')
    expect(h.tabs.value[0]).toMatchObject({ saveStatus: 'saved', serverMtime: 3 })
  })

  it('onEditorChange marks the tab dirty and debounces a save', async () => {
    vi.useFakeTimers()
    let putCount = 0
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/a': () => ({ path: 'a', raw: 'A', content: 'A', frontmatter: {}, size: 1, mtime: 0 }),
      'PUT /api/posts/a': () => { putCount++; return saveResult('a', 'A3') },
    }))
    const h = await setup()
    await h.openPost('a')
    h.onEditorChange('a', 'A1')
    h.onEditorChange('a', 'A2')
    h.onEditorChange('a', 'A3')
    expect(h.tabs.value[0].saveStatus).toBe('dirty')
    // 800ms debounce — not yet saved.
    expect(putCount).toBe(0)
    await vi.advanceTimersByTimeAsync(850)
    // The debounce fired exactly once despite three rapid edits.
    expect(putCount).toBe(1)
    expect(h.tabs.value[0].originalRaw).toBe('A3')
  })

  it('onEditorChange reverts status to idle when content matches originalRaw', async () => {
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/a': () => ({ path: 'a', raw: 'A', content: 'A', frontmatter: {}, size: 1, mtime: 0 }),
    }))
    const h = await setup()
    await h.openPost('a')
    h.onEditorChange('a', 'A modified')
    expect(h.tabs.value[0].saveStatus).toBe('dirty')
    h.onEditorChange('a', 'A')                       // back to original
    expect(h.tabs.value[0].saveStatus).toBe('idle')
  })

  it('selectTab is a no-op for the active tab and for unknown paths', async () => {
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/a': () => ({ path: 'a', raw: 'A', content: 'A', frontmatter: {}, size: 1, mtime: 0 }),
    }))
    const h = await setup()
    await h.openPost('a')
    const before = h.activePath.value
    h.selectTab('a')                                  // active — no-op
    expect(h.activePath.value).toBe(before)
    h.selectTab('does-not-exist')                     // unknown — no-op
    expect(h.activePath.value).toBe(before)
  })

  it('onKeydown Cmd-S triggers doSaveNow', async () => {
    let saved = 0
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/a': () => ({ path: 'a', raw: 'A', content: 'A', frontmatter: {}, size: 1, mtime: 0 }),
      'PUT /api/posts/a': () => { saved++; return saveResult('a', 'A modified') },
    }))
    const h = await setup()
    await h.openPost('a')
    h.onEditorChange('a', 'A modified')
    const evt = new KeyboardEvent('keydown', { key: 's', metaKey: true, cancelable: true })
    h.onKeydown(evt)
    // doSaveNow awaits; give it a tick.
    await Promise.resolve()
    await Promise.resolve()
    expect(saved).toBe(1)
    expect(evt.defaultPrevented).toBe(true)
  })

  it('onKeydown Cmd-W closes the active tab', async () => {
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/a': () => ({ path: 'a', raw: 'A', content: 'A', frontmatter: {}, size: 1, mtime: 0 }),
    }))
    const h = await setup()
    await h.openPost('a')
    const evt = new KeyboardEvent('keydown', { key: 'w', metaKey: true, cancelable: true })
    h.onKeydown(evt)
    await Promise.resolve()
    await Promise.resolve()
    expect(h.tabs.value).toHaveLength(0)
  })

  it('onKeydown Cmd-B calls selectPanel with files', async () => {
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
    }))
    const h = await setup()
    const evt = new KeyboardEvent('keydown', { key: 'b', metaKey: true, cancelable: true })
    h.onKeydown(evt)
    expect(h.selectPanel).toHaveBeenCalledWith('files')
  })

  it('onKeydown Cmd+E calls toggleViewMode (NavBar toggle button)', async () => {
    // Assert by spy rather than reading the layout ref because the spy
    // is the seam the production caller uses (see VaultView.vue), so a
    // regression that renames the field or wires the bit directly would
    // still surface here.
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
    }))
    const h = await setup()
    const evt = new KeyboardEvent('keydown', { key: 'e', metaKey: true, cancelable: true })
    h.onKeydown(evt)
    expect(h.toggleViewMode).toHaveBeenCalledOnce()

    // Ctrl on Windows / Linux maps to metaKey in the handler — make
    // sure the shortcut isn't gated to macOS only.
    h.toggleViewMode.mockClear()
    const ctrlEvt = new KeyboardEvent('keydown', { key: 'e', ctrlKey: true, cancelable: true })
    h.onKeydown(ctrlEvt)
    expect(h.toggleViewMode).toHaveBeenCalledOnce()
  })

  it('onKeydown Ctrl-Tab cycles through open tabs', async () => {
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/a': () => ({ path: 'a', raw: 'A', content: 'A', frontmatter: {}, size: 1, mtime: 0 }),
      'GET /api/posts/b': () => ({ path: 'b', raw: 'B', content: 'B', frontmatter: {}, size: 1, mtime: 0 }),
      'GET /api/posts/c': () => ({ path: 'c', raw: 'C', content: 'C', frontmatter: {}, size: 1, mtime: 0 }),
    }))
    const h = await setup()
    await h.openPost('a')
    await h.openPost('b')
    await h.openPost('c')
    expect(h.activePath.value).toBe('c')
    h.onKeydown(new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, cancelable: true }))
    expect(h.activePath.value).toBe('a')             // wrapped forward
    h.onKeydown(new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, shiftKey: true, cancelable: true }))
    expect(h.activePath.value).toBe('c')             // wrapped backward
  })

  it('onCommandPaletteNew creates the post and opens it', async () => {
    // No active path → the new file lands at the root. Slugify of
    // "New Note" → "new-note". The composable then opens it.
    let created: { path: string; title?: string } | null = null
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/new-note': () => ({ path: 'new-note', raw: '', content: '', frontmatter: {}, size: 0, mtime: 0 }),
      'POST /api/posts': (body) => {
        created = body as { path: string; title?: string }
        return { path: 'new-note', title: 'New Note', created: '', updated: '', tags: [], size: 0, mtime: 0 }
      },
    }))
    const h = await setup()
    await h.onCommandPaletteNew('New Note')
    expect(created).toEqual({ path: 'new-note', title: 'New Note' })
    expect(h.tabs.value.map((t) => t.path)).toContain('new-note')
    expect(h.activePath.value).toBe('new-note')
    expect(toastCalls).toContainEqual({ type: 'success', message: expect.stringContaining('已创建') })
  })

  it('onCommandPaletteNew with empty title is a no-op', async () => {
    const fetchSpy = stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'POST /api/posts': () => { throw new Error('should not POST') },
    })
    vi.stubGlobal('fetch', fetchSpy)
    const h = await setup()
    await h.onCommandPaletteNew('   ')
    expect(h.tabs.value).toHaveLength(0)
  })
})

// --- file-change bus integration ------------------------------------------

describe('useEditorTabs — file-change bus', () => {
  beforeEach(() => {
    // The confirm mock captures the resolve into a module-level
    // variable; clear it so each test starts from a clean state.
    confirmResolve = null
  })
  afterEach(() => {
    confirmResolve = null
  })

  it('auto-refreshes a clean tab when the bus publishes a write for its path', async () => {
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/bus-a': () => ({ path: 'bus-a', raw: 'A', content: 'A', frontmatter: {}, size: 1, mtime: 0 }),
    }))
    const h = await setup()
    await h.openPost('bus-a')
    expect(h.tabs.value[0].raw).toBe('A')
    h.fileChanges.publish({ path: 'bus-a', kind: 'write', newMtime: 100, newRaw: 'A from AI' })
    await flushPromises()
    expect(h.tabs.value[0].raw).toBe('A from AI')
    expect(h.tabs.value[0].serverMtime).toBe(100)
    // No confirm call should have been queued
    expect(confirmResolve).toBeNull()
  })

  it('prompts a dirty tab; 覆盖本地 refreshes, 保留本地 keeps edits', async () => {
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/bus-b': () => ({ path: 'bus-b', raw: 'B', content: 'B', frontmatter: {}, size: 1, mtime: 0 }),
    }))
    const h = await setup()
    await h.openPost('bus-b')
    h.onEditorChange('bus-b', 'B modified by user')  // dirty
    h.fileChanges.publish({ path: 'bus-b', kind: 'write', newMtime: 200, newRaw: 'B from AI' })
    await flushPromises()
    // Confirm should be pending
    await vi.waitFor(() => expect(confirmResolve).not.toBeNull())
    // User picks 保留本地 (false)
    answerConfirm(false)
    await flushPromises()
    expect(h.tabs.value[0].raw).toBe('B modified by user')
    expect(h.tabs.value[0].serverMtime).toBe(200)
    // saveStatus should NOT be reset to idle (still dirty)
    expect(h.tabs.value[0].saveStatus).toBe('dirty')

    // Second publish, user picks 覆盖 (true)
    h.fileChanges.publish({ path: 'bus-b', kind: 'write', newMtime: 201, newRaw: 'B from AI 2' })
    await flushPromises()
    await vi.waitFor(() => expect(confirmResolve).not.toBeNull())
    answerConfirm(true)
    await flushPromises()
    expect(h.tabs.value[0].raw).toBe('B from AI 2')
    expect(h.tabs.value[0].serverMtime).toBe(201)
  })

  it('drops the event while savingRevision is in flight even when status is dirty', async () => {
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/bus-c': () => ({ path: 'bus-c', raw: 'C', content: 'C', frontmatter: {}, size: 1, mtime: 0 }),
    }))
    const h = await setup()
    await h.openPost('bus-c')
    h.tabs.value[0].saveStatus = 'dirty'
    h.tabs.value[0].savingRevision = h.tabs.value[0].revision
    h.fileChanges.publish({ path: 'bus-c', kind: 'write', newMtime: 1, newRaw: 'irrelevant' })
    await flushPromises()
    expect(h.tabs.value[0].raw).toBe('C')  // unchanged
    expect(confirmResolve).toBeNull()
  })

  it('marks a tab with a loadError on a delete event so the user sees the file is gone', async () => {
    let recovered = ''
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/bus-d': () => ({ path: 'bus-d', raw: 'D', content: 'D', frontmatter: {}, size: 1, mtime: 0 }),
      'PUT /api/recover/bus-d': (body) => {
        recovered = (body as { raw: string }).raw
        return {
          ok: true,
          raw: recovered,
          mtime: 4,
          post: postSummary('bus-d', { size: recovered.length, mtime: 4 }),
        }
      },
    }))
    const h = await setup()
    await h.openPost('bus-d')
    h.fileChanges.publish({ path: 'bus-d', kind: 'delete' })
    await flushPromises()
    expect(h.tabs.value[0].loadError).toMatch(/已被 AI 删除/)
    expect(h.tabs.value[0]).toMatchObject({ saveStatus: 'external', externalKind: 'deleted' })
    await h.resolveExternal('bus-d', 'local')
    expect(recovered).toBe('D')
    expect(h.tabs.value[0]).toMatchObject({
      saveStatus: 'saved',
      externalKind: null,
      loadError: null,
      serverMtime: 4,
    })
    expect(h.posts.value.find((post) => post.path === 'bus-d')).toMatchObject({ size: 1, mtime: 4 })
  })

  it('closes the old tab and opens the new one on a rename event', async () => {
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/bus-old': () => ({ path: 'bus-old', raw: 'OLD', content: 'OLD', frontmatter: {}, size: 3, mtime: 0 }),
    }))
    const h = await setup()
    await h.openPost('bus-old')
    expect(h.tabs.value.map((t) => t.path)).toEqual(['bus-old'])
    h.fileChanges.publish({ path: 'bus-new', kind: 'rename', oldPath: 'bus-old', newMtime: 1, newRaw: 'NEW' })
    await flushPromises()
    expect(h.tabs.value.map((t) => t.path)).toEqual(['bus-new'])
    expect(h.tabs.value[0].raw).toBe('NEW')
    expect(h.tabs.value[0].serverMtime).toBe(1)
    expect(h.activePath.value).toBe('bus-new')
    expect(toastCalls).toContainEqual({ type: 'info', message: 'AI 已将 bus-old 重命名为 bus-new' })
  })

  it('keeps the source position and persists immediately for an external rename', async () => {
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/order-b': () => ({ path: 'order-b', raw: 'B', content: 'B', frontmatter: {}, size: 1, mtime: 0 }),
      'GET /api/posts/order-a': () => ({ path: 'order-a', raw: 'A', content: 'A', frontmatter: {}, size: 1, mtime: 0 }),
      'GET /api/posts/order-c': () => ({ path: 'order-c', raw: 'C', content: 'C', frontmatter: {}, size: 1, mtime: 0 }),
    }))
    const h = await setup()
    await h.openPost('order-b')
    await h.openPost('order-a')
    await h.openPost('order-c')

    h.fileChanges.publish({
      path: 'order-x',
      kind: 'rename',
      oldPath: 'order-a',
      newMtime: 7,
      newRaw: 'X',
    })
    await flushPromises()

    expect(h.tabs.value.map((tab) => tab.path)).toEqual(['order-b', 'order-x', 'order-c'])
    expect(h.activePath.value).toBe('order-c')
    expect(JSON.parse(localStorage.getItem(PERSIST_KEY)!).paths)
      .toEqual(['order-b', 'order-x', 'order-c'])
    h.unmount()
  })

  it('leaves order and persistence unchanged when a dirty external rename is cancelled', async () => {
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/cancel-b': () => ({ path: 'cancel-b', raw: 'B', content: 'B', frontmatter: {}, size: 1, mtime: 0 }),
      'GET /api/posts/cancel-a': () => ({ path: 'cancel-a', raw: 'A', content: 'A', frontmatter: {}, size: 1, mtime: 0 }),
      'GET /api/posts/cancel-c': () => ({ path: 'cancel-c', raw: 'C', content: 'C', frontmatter: {}, size: 1, mtime: 0 }),
    }))
    const h = await setup()
    await h.openPost('cancel-b')
    await h.openPost('cancel-a')
    await h.openPost('cancel-c')
    expect(h.tabs.value.map((tab) => tab.path)).toEqual(['cancel-b', 'cancel-a', 'cancel-c'])
    h.onEditorChange('cancel-a', 'A dirty')
    const before = localStorage.getItem(PERSIST_KEY)

    h.fileChanges.publish({ path: 'cancel-x', kind: 'rename', oldPath: 'cancel-a', newRaw: 'X' })
    await Promise.resolve()
    await Promise.resolve()
    answerConfirm(false)
    await flushPromises()

    expect(h.tabs.value.map((tab) => tab.path)).toEqual(['cancel-b', 'cancel-a', 'cancel-c'])
    expect(localStorage.getItem(PERSIST_KEY)).toBe(before)
    h.unmount()
  })

  it('gives the rename source position priority when the external target is already open', async () => {
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/duplicate-b': () => ({ path: 'duplicate-b', raw: 'B', content: 'B', frontmatter: {}, size: 1, mtime: 0 }),
      'GET /api/posts/duplicate-a': () => ({ path: 'duplicate-a', raw: 'A', content: 'A', frontmatter: {}, size: 1, mtime: 0 }),
      'GET /api/posts/duplicate-x': () => ({ path: 'duplicate-x', raw: 'old X', content: 'old X', frontmatter: {}, size: 5, mtime: 0 }),
      'GET /api/posts/duplicate-c': () => ({ path: 'duplicate-c', raw: 'C', content: 'C', frontmatter: {}, size: 1, mtime: 0 }),
    }))
    const h = await setup()
    await h.openPost('duplicate-b')
    await h.openPost('duplicate-a')
    await h.openPost('duplicate-x')
    await h.openPost('duplicate-c')
    expect(h.tabs.value.map((tab) => tab.path))
      .toEqual(['duplicate-b', 'duplicate-a', 'duplicate-x', 'duplicate-c'])
    const source = h.tabs.value.find((tab) => tab.path === 'duplicate-a')

    h.fileChanges.publish({
      path: 'duplicate-x',
      kind: 'rename',
      oldPath: 'duplicate-a',
      newRaw: 'new X',
    })
    await flushPromises()

    expect(h.tabs.value.map((tab) => tab.path))
      .toEqual(['duplicate-b', 'duplicate-x', 'duplicate-c'])
    expect(h.tabs.value.find((tab) => tab.path === 'duplicate-x')).toBe(source)
    expect(source?.raw).toBe('new X')
    h.unmount()
  })

  it('preserves a dirty target when the external rename target is already open', async () => {
    __setVaultIdForTesting('dirty-target-rename')
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/dirty-target-a': () => ({ path: 'dirty-target-a', raw: 'A', content: 'A', frontmatter: {}, size: 1, mtime: 0 }),
      'GET /api/posts/dirty-target-x': () => ({ path: 'dirty-target-x', raw: 'old X', content: 'old X', frontmatter: {}, size: 5, mtime: 0 }),
    }))
    const h = await setup()
    await h.openPost('dirty-target-a')
    await h.openPost('dirty-target-x')
    const target = h.tabs.value.find((tab) => tab.path === 'dirty-target-x')!
    h.onEditorChange('dirty-target-x', 'unsaved target')

    h.fileChanges.publish({
      path: 'dirty-target-x',
      kind: 'rename',
      oldPath: 'dirty-target-a',
      newRaw: 'renamed file bytes',
      newMtime: 9,
    })
    await flushPromises()

    expect(h.tabs.value.map((tab) => tab.path)).toEqual(['dirty-target-x'])
    expect(h.tabs.value[0]).toBe(target)
    expect(target.raw).toBe('unsaved target')
    expect(target.externalRaw).toBe('renamed file bytes')
    expect(target.saveStatus).toBe('external')
    expect(JSON.parse(localStorage.getItem('nuvyn:tabs:v1:dirty-target-rename')!).paths)
      .toEqual(['dirty-target-x'])
    h.unmount()
    resetTabPersistenceForTesting()
  })

  it('restores a no-body external rename at the source position after loading the target', async () => {
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/load-b': () => ({ path: 'load-b', raw: 'B', content: 'B', frontmatter: {}, size: 1, mtime: 0 }),
      'GET /api/posts/load-a': () => ({ path: 'load-a', raw: 'A', content: 'A', frontmatter: {}, size: 1, mtime: 0 }),
      'GET /api/posts/load-c': () => ({ path: 'load-c', raw: 'C', content: 'C', frontmatter: {}, size: 1, mtime: 0 }),
      'GET /api/posts/load-x': () => ({ path: 'load-x', raw: 'X loaded', content: 'X loaded', frontmatter: {}, size: 8, mtime: 9 }),
    }))
    const h = await setup()
    await h.openPost('load-b')
    await h.openPost('load-a')
    await h.openPost('load-c')
    expect(h.tabs.value.map((tab) => tab.path)).toEqual(['load-b', 'load-a', 'load-c'])

    h.fileChanges.publish({ path: 'load-x', kind: 'rename', oldPath: 'load-a' })
    await flushPromises()

    expect(h.tabs.value.map((tab) => tab.path)).toEqual(['load-b', 'load-x', 'load-c'])
    expect(h.tabs.value[1].raw).toBe('X loaded')
    h.unmount()
  })

  it('does not overwrite source edits made while rename target content is loading', async () => {
    const targetPost = deferred<unknown>()
    const targetRequested = deferred<void>()
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/loading-edit-a': () => ({ path: 'loading-edit-a', raw: 'A', content: 'A', frontmatter: {}, size: 1, mtime: 0 }),
      'GET /api/posts/loading-edit-x': () => {
        targetRequested.resolve()
        return targetPost.promise
      },
    }))
    const h = await setup()
    await h.openPost('loading-edit-a')

    h.fileChanges.publish({ path: 'loading-edit-x', kind: 'rename', oldPath: 'loading-edit-a' })
    await targetRequested.promise
    h.onEditorChange('loading-edit-a', 'edit during load')
    targetPost.resolve({
      path: 'loading-edit-x',
      raw: 'disk X',
      content: 'disk X',
      frontmatter: {},
      size: 6,
      mtime: 8,
    })
    await flushPromises()

    expect(h.tabs.value.map((tab) => tab.path)).toEqual(['loading-edit-a'])
    expect(h.tabs.value[0].raw).toBe('edit during load')
    expect(h.tabs.value[0].saveStatus).toBe('dirty')
    h.unmount()
  })

  it('does not overwrite target edits made while rename content is loading', async () => {
    const targetPost = deferred<unknown>()
    const targetRequested = deferred<void>()
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/loading-target-a': () => ({ path: 'loading-target-a', raw: 'A', content: 'A', frontmatter: {}, size: 1, mtime: 0 }),
      'GET /api/posts/loading-target-x': (() => {
        let calls = 0
        return () => {
          calls++
          if (calls === 1) {
            return {
              path: 'loading-target-x',
              raw: 'old X',
              content: 'old X',
              frontmatter: {},
              size: 5,
              mtime: 0,
            }
          }
          targetRequested.resolve()
          return targetPost.promise
        }
      })(),
    }))
    const h = await setup()
    await h.openPost('loading-target-a')
    await h.openPost('loading-target-x')
    const source = h.tabs.value.find((tab) => tab.path === 'loading-target-a')!
    const target = h.tabs.value.find((tab) => tab.path === 'loading-target-x')!

    h.fileChanges.publish({
      path: 'loading-target-x',
      kind: 'rename',
      oldPath: 'loading-target-a',
    })
    await targetRequested.promise
    h.onEditorChange('loading-target-x', 'target edit during load')
    targetPost.resolve({
      path: 'loading-target-x',
      raw: 'disk X',
      content: 'disk X',
      frontmatter: {},
      size: 6,
      mtime: 8,
    })
    await flushPromises()

    expect(h.tabs.value.map((tab) => tab.path))
      .toEqual(['loading-target-a', 'loading-target-x'])
    expect(h.tabs.value[0]).toBe(source)
    expect(h.tabs.value[1]).toBe(target)
    expect(source.raw).toBe('A')
    expect(target.raw).toBe('target edit during load')
    expect(target.saveStatus).toBe('dirty')
    h.unmount()
  })

  it('does not mutate a source tab that was closed and reopened while rename content loads', async () => {
    const targetPost = deferred<unknown>()
    const targetRequested = deferred<void>()
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/reopen-a': () => ({ path: 'reopen-a', raw: 'A', content: 'A', frontmatter: {}, size: 1, mtime: 0 }),
      'GET /api/posts/reopen-x': () => {
        targetRequested.resolve()
        return targetPost.promise
      },
    }))
    const h = await setup()
    await h.openPost('reopen-a')
    const original = h.tabs.value[0]

    h.fileChanges.publish({ path: 'reopen-x', kind: 'rename', oldPath: 'reopen-a' })
    await targetRequested.promise
    await h.closeTab('reopen-a')
    await h.openPost('reopen-a')
    const reopened = h.tabs.value[0]
    expect(reopened).not.toBe(original)
    targetPost.resolve({
      path: 'reopen-x',
      raw: 'disk X',
      content: 'disk X',
      frontmatter: {},
      size: 6,
      mtime: 8,
    })
    await flushPromises()

    expect(h.tabs.value.map((tab) => tab.path)).toEqual(['reopen-a'])
    expect(h.tabs.value[0]).toBe(reopened)
    expect(h.tabs.value[0].raw).toBe('A')
    h.unmount()
  })

  it('migrates the current order instead of restoring a stale order after rename loading', async () => {
    __setVaultIdForTesting('async-rename-order')
    const targetPost = deferred<unknown>()
    const targetRequested = deferred<void>()
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/order-load-b': () => ({ path: 'order-load-b', raw: 'B', content: 'B', frontmatter: {}, size: 1, mtime: 0 }),
      'GET /api/posts/order-load-a': () => ({ path: 'order-load-a', raw: 'A', content: 'A', frontmatter: {}, size: 1, mtime: 0 }),
      'GET /api/posts/order-load-c': () => ({ path: 'order-load-c', raw: 'C', content: 'C', frontmatter: {}, size: 1, mtime: 0 }),
      'GET /api/posts/order-load-x': () => {
        targetRequested.resolve()
        return targetPost.promise
      },
    }))
    const h = await setup()
    await h.openPost('order-load-b')
    await h.openPost('order-load-a')
    await h.openPost('order-load-c')

    h.fileChanges.publish({ path: 'order-load-x', kind: 'rename', oldPath: 'order-load-a' })
    await targetRequested.promise
    expect(h.reorderOpenDocuments(['order-load-c', 'order-load-a', 'order-load-b'])).toBe(true)
    targetPost.resolve({
      path: 'order-load-x',
      raw: 'X',
      content: 'X',
      frontmatter: {},
      size: 1,
      mtime: 8,
    })
    await flushPromises()

    expect(h.tabs.value.map((tab) => tab.path))
      .toEqual(['order-load-c', 'order-load-x', 'order-load-b'])
    expect(JSON.parse(localStorage.getItem('nuvyn:tabs:v1:async-rename-order')!).paths)
      .toEqual(['order-load-c', 'order-load-x', 'order-load-b'])
    h.unmount()
    resetTabPersistenceForTesting()
  })

  it('does not close or reorder the source when a newer event supersedes rename confirmation', async () => {
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/stale-b': () => ({ path: 'stale-b', raw: 'B', content: 'B', frontmatter: {}, size: 1, mtime: 0 }),
      'GET /api/posts/stale-a': () => ({ path: 'stale-a', raw: 'A', content: 'A', frontmatter: {}, size: 1, mtime: 0 }),
      'GET /api/posts/stale-c': () => ({ path: 'stale-c', raw: 'C', content: 'C', frontmatter: {}, size: 1, mtime: 0 }),
    }))
    const h = await setup()
    await h.openPost('stale-b')
    await h.openPost('stale-a')
    await h.openPost('stale-c')
    expect(h.tabs.value.map((tab) => tab.path)).toEqual(['stale-b', 'stale-a', 'stale-c'])
    h.onEditorChange('stale-a', 'A dirty')

    h.fileChanges.publish({
      path: 'stale-x',
      kind: 'rename',
      oldPath: 'stale-a',
      newRaw: 'stale X',
    })
    await Promise.resolve()
    await Promise.resolve()
    h.fileChanges.publish({ path: 'stale-x', kind: 'write', newRaw: 'newer X' })
    answerConfirm(true)
    await flushPromises()

    expect(h.tabs.value.map((tab) => tab.path)).toEqual(['stale-b', 'stale-a', 'stale-c'])
    expect(h.tabs.value.find((tab) => tab.path === 'stale-a')?.raw).toBe('A dirty')
    h.unmount()
  })

  it('does not refresh a tab whose path does not match the event', async () => {
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/bus-e': () => ({ path: 'bus-e', raw: 'E', content: 'E', frontmatter: {}, size: 1, mtime: 0 }),
    }))
    const h = await setup()
    await h.openPost('bus-e')
    h.fileChanges.publish({ path: 'unrelated', kind: 'write', newMtime: 1, newRaw: 'X' })
    await flushPromises()
    expect(h.tabs.value[0].raw).toBe('E')
    expect(confirmResolve).toBeNull()
  })

  it('stops reacting to file changes after unmount', async () => {
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/bus-unmount': () => ({ path: 'bus-unmount', raw: 'before', content: 'before', frontmatter: {}, size: 6, mtime: 0 }),
    }))
    const h = await setup()
    await h.openPost('bus-unmount')
    h.onEditorChange('bus-unmount', 'local edit')
    h.unmount()

    h.fileChanges.publish({ path: 'bus-unmount', kind: 'write', newRaw: 'after' })
    await flushPromises()

    expect(h.tabs.value[0].raw).toBe('local edit')
    expect(confirmResolve).toBeNull()
  })
})

// --- tab persistence ------------------------------------------------------
//
// On refresh the composable reads the previous session's tab set from
// localStorage and restores it. The default beforeEach fetch stub
// returns [] for tree/posts and throws for anything else, so each
// test here overrides it with per-path getPost handlers.

const PERSIST_KEY = 'nuvyn:tabs:v1:test-vault'

function stubFetchForPaths(paths: Record<string, unknown>): void {
  vi.stubGlobal('fetch', stubFetch({
    'GET /api/tree': () => [],
    'GET /api/posts': () => [],
    ...Object.fromEntries(
      Object.entries(paths).map(([p, raw]) => [
        `GET /api/posts/${p}`,
        () => ({ path: p, raw: raw as string, content: raw as string, frontmatter: { title: p }, size: 1, mtime: 0 }),
      ]),
    ),
  }))
}

describe('useEditorTabs — tab persistence', () => {
  beforeEach(() => {
    localStorage.clear()
    // Reset toast capture here too — this nested describe doesn't
    // inherit the outer describe's beforeEach.
    toastCalls.length = 0
  })

  it('persists the tab set + active path after openPost (debounced)', async () => {
    stubFetchForPaths({ a: 'A', b: 'B' })
    const h = await setup()
    await h.openPost('a')
    await flushPromises()
    await h.openPost('b')
    await flushPromises()
    // debouncedPersist has a 100ms delay; advance and flush.
    await new Promise((r) => setTimeout(r, 150))
    const raw = localStorage.getItem(PERSIST_KEY)
    expect(raw).not.toBeNull()
    const data = JSON.parse(raw!)
    expect(data.v).toBe(1)
    expect(data.paths).toEqual(['a', 'b'])
    expect(data.active).toBe('b')
  })

  it('removes the path from persistence when a tab is closed', async () => {
    stubFetchForPaths({ a: 'A', b: 'B' })
    const h = await setup()
    await h.openPost('a')
    await flushPromises()
    await h.openPost('b')
    await flushPromises()
    await h.closeTab('a')
    await flushPromises()
    await new Promise((r) => setTimeout(r, 150))
    const data = JSON.parse(localStorage.getItem(PERSIST_KEY)!)
    expect(data.paths).toEqual(['b'])
    expect(data.active).toBe('b')
  })

  it('writes an empty session when the last tab is closed', async () => {
    stubFetchForPaths({ a: 'A' })
    const h = await setup()
    await h.openPost('a')
    await flushPromises()
    await h.closeTab('a')
    await flushPromises()
    await new Promise((r) => setTimeout(r, 150))
    const data = JSON.parse(localStorage.getItem(PERSIST_KEY)!)
    expect(data.paths).toEqual([])
    expect(data.active).toBeNull()
  })

  it('restores the tab set from localStorage on mount', async () => {
    stubFetchForPaths({ a: 'A', b: 'B' })
    localStorage.setItem(PERSIST_KEY, JSON.stringify({
      v: 1, paths: ['a', 'b'], active: 'a',
    }))
    const h = await setup()
    await flushPromises()
    expect(h.tabs.value.map((t) => t.path)).toEqual(['a', 'b'])
    expect(h.tabs.value[0].raw).toBe('A')
    expect(h.tabs.value[1].raw).toBe('B')
    expect(h.activePath.value).toBe('a')
  })

  it('defers persisted managed Diary tabs without reading their body while locked', async () => {
    let diaryBodyReads = 0
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/diary/2026-08-27': () => {
        diaryBodyReads += 1
        return { path: 'diary/2026-08-27', raw: 'secret', content: 'secret', frontmatter: {}, size: 6, mtime: 1 }
      },
    }))
    localStorage.setItem(PERSIST_KEY, JSON.stringify({
      v: 1, paths: ['diary/2026-08-27'], active: 'diary/2026-08-27',
    }))

    const h = await setup({
      isDiaryAccessReady: () => false,
      authorizeDocumentPath: vi.fn(async () => false),
    })

    expect(h.tabs.value).toEqual([])
    expect(h.activePath.value).toBeNull()
    expect(diaryBodyReads).toBe(0)
  })

  it('does not read a locked managed Diary deep link when access is cancelled', async () => {
    let diaryBodyReads = 0
    const authorizeDocumentPath = vi.fn(async () => false)
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/diary/2026-08-27': () => {
        diaryBodyReads += 1
        return { path: 'diary/2026-08-27', raw: 'secret', content: 'secret', frontmatter: {}, size: 6, mtime: 1 }
      },
    }))

    const h = await setup(
      {
        isDiaryAccessReady: () => false,
        authorizeDocumentPath,
      },
      '/vault/diary/2026-08-27',
    )

    expect(authorizeDocumentPath).toHaveBeenCalledWith('diary/2026-08-27')
    expect(h.tabs.value).toEqual([])
    expect(h.activePath.value).toBeNull()
    expect(diaryBodyReads).toBe(0)
  })

  it('resumes a deferred managed Diary tab exactly once after access becomes ready', async () => {
    let diaryBodyReads = 0
    let ready = false
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/diary/2026-08-27': () => {
        diaryBodyReads += 1
        return { path: 'diary/2026-08-27', raw: 'secret', content: 'secret', frontmatter: {}, size: 6, mtime: 1 }
      },
    }))
    localStorage.setItem(PERSIST_KEY, JSON.stringify({
      v: 1, paths: ['diary/2026-08-27'], active: 'diary/2026-08-27',
    }))

    const h = await setup({
      isDiaryAccessReady: () => ready,
      authorizeDocumentPath: vi.fn(async () => true),
    })

    expect(h.tabs.value).toEqual([])
    expect(diaryBodyReads).toBe(0)

    ready = true
    await h.resumeDeferredDiaryTabs()
    await h.resumeDeferredDiaryTabs()

    expect(diaryBodyReads).toBe(1)
    expect(h.tabs.value.map((tab) => tab.path)).toEqual(['diary/2026-08-27'])
  })

  it('loads an authorized managed Diary deep link once after access is granted', async () => {
    let diaryBodyReads = 0
    const authorizeDocumentPath = vi.fn(async () => true)
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/diary/2026-08-27': () => {
        diaryBodyReads += 1
        return { path: 'diary/2026-08-27', raw: 'secret', content: 'secret', frontmatter: {}, size: 6, mtime: 1 }
      },
    }))

    const h = await setup(
      {
        isDiaryAccessReady: () => false,
        authorizeDocumentPath,
      },
      '/vault/diary/2026-08-27',
    )

    expect(authorizeDocumentPath).toHaveBeenCalledOnce()
    expect(diaryBodyReads).toBe(1)
    expect(h.tabs.value.map((tab) => tab.path)).toEqual(['diary/2026-08-27'])
    expect(h.activePath.value).toBe('diary/2026-08-27')
  })

  it('falls back to the first restored tab when the saved active path no longer exists', async () => {
    stubFetchForPaths({ a: 'A', b: 'B' })
    localStorage.setItem(PERSIST_KEY, JSON.stringify({
      v: 1, paths: ['a', 'b'], active: 'c', // c never persisted as a tab
    }))
    const h = await setup()
    await flushPromises()
    expect(h.tabs.value.map((t) => t.path)).toEqual(['a', 'b'])
    expect(h.activePath.value).toBe('a')
  })

  it('drops paths that 404 on restore and reports them in a single toast', async () => {
    stubFetchForPaths({ a: 'A' })
    // b is NOT stubbed → fetch throws "Unexpected fetch" → treated as missing.
    localStorage.setItem(PERSIST_KEY, JSON.stringify({
      v: 1, paths: ['a', 'b'], active: 'b',
    }))
    const h = await setup()
    await flushPromises()
    expect(h.tabs.value.map((t) => t.path)).toEqual(['a'])
    expect(h.activePath.value).toBe('a')
    const toasts = toastCalls.filter((t) => t.type === 'info')
    expect(toasts.length).toBe(1)
    expect(toasts[0].message).toContain('1 个标签页对应的文件已不存在')
    expect(toasts[0].message).toContain('· b')
  })

  it('caps the restored set at TAB_HARD_LIMIT so the UI never overflows', async () => {
    const many = Array.from({ length: 12 }, (_, i) => `f${i}`).reduce(
      (acc, p) => { acc[p] = 'X'; return acc },
      {} as Record<string, unknown>,
    )
    stubFetchForPaths(many)
    localStorage.setItem(PERSIST_KEY, JSON.stringify({
      v: 1, paths: Object.keys(many), active: 'f0',
    }))
    const h = await setup()
    await flushPromises()
    expect(h.tabs.value.length).toBe(9)
  })

  it('lists at most 3 missing paths in the toast, with an overflow count', async () => {
    // 5 missing paths; only the first 3 should appear by name.
    localStorage.setItem(PERSIST_KEY, JSON.stringify({
      v: 1, paths: ['m1', 'm2', 'm3', 'm4', 'm5'], active: 'm1',
    }))
    // No per-path handlers — all 5 will 404.
    const h = await setup()
    await flushPromises()
    expect(h.tabs.value.length).toBe(0)
    const toasts = toastCalls.filter((t) => t.type === 'info')
    expect(toasts.length).toBe(1)
    expect(toasts[0].message).toContain('5 个标签页对应的文件已不存在')
    expect(toasts[0].message).toContain('· m1')
    expect(toasts[0].message).toContain('· m2')
    expect(toasts[0].message).toContain('· m3')
    expect(toasts[0].message).not.toContain('· m4')
    expect(toasts[0].message).toContain('另有 2 个')
  })

  it('treats corrupt JSON in localStorage as empty (no crash)', async () => {
    stubFetchForPaths({ a: 'A' })
    localStorage.setItem(PERSIST_KEY, '{not valid json')
    const h = await setup()
    await flushPromises()
    expect(h.tabs.value.length).toBe(0)
    expect(h.activePath.value).toBeNull()
  })

  it('ignores entries with the wrong schema version', async () => {
    stubFetchForPaths({ a: 'A' })
    localStorage.setItem(PERSIST_KEY, JSON.stringify({
      v: 999, paths: ['a'], active: 'a', // future version → drop
    }))
    const h = await setup()
    await flushPromises()
    expect(h.tabs.value.length).toBe(0)
  })

  it('keeps restored tabs when a deep-link override opens a different path', async () => {
    stubFetchForPaths({ a: 'A', b: 'B', c: 'C' })
    localStorage.setItem(PERSIST_KEY, JSON.stringify({
      v: 1, paths: ['a', 'b'], active: 'b',
    }))
    // Stand up a router pointed at /vault/c BEFORE mounting.
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/vault', component: { template: '<div/>' } },
        { path: '/vault/:pathMatch(.*)*', component: { template: '<div/>' } },
      ],
    })
    router.push('/vault/c').catch(() => {})
    await router.isReady()
    // Use `harness` (not `h`) here — `h` shadows the module-level
    // hyperscript import and the render closure would hit a TDZ when
    // mount() fires it before this binding initializes. The standard
    // helper sidesteps this by mounting inside its own scope; an
    // inline mount doesn't, so we have to pick a non-colliding name.
    let captured: Harness | null = null
    const Comp = defineComponent({
      setup() {
        const selectPanel = vi.fn()
        const toggleViewMode = vi.fn()
        const api = useEditorTabs({ vaultId: 'test-vault', selectPanel, toggleViewMode, fileChanges: createVaultFileChanges() })
        captured = { ...(api as unknown as Omit<Harness, 'selectPanel' | 'toggleViewMode'>), selectPanel, toggleViewMode }
        return () => h('div')
      },
    })
    const wrapper = mount(Comp, { global: { plugins: [router] } })
    mountedWrappers.add(wrapper)
    await nextTick()
    await Promise.resolve()
    await flushPromises()
    const harness = captured!
    // a + b restored from persistence, then c opened via deep-link.
    expect(harness.tabs.value.map((t) => t.path).sort()).toEqual(['a', 'b', 'c'])
    // Deep-link wins for active.
    expect(harness.activePath.value).toBe('c')
  })

  it('does not navigate to a persisted active tab before an ordinary deep link wins', async () => {
    stubFetchForPaths({ 'inbox/a': 'A', 'inbox/b': 'B' })
    localStorage.setItem(PERSIST_KEY, JSON.stringify({
      v: 1,
      paths: ['inbox/a', 'inbox/b'],
      active: 'inbox/a',
    }))

    const replacements: string[] = []
    const { harness, router } = await mountWithRouter({}, '/vault/inbox/b', (router) => {
      const originalReplace = router.replace.bind(router)
      vi.spyOn(router, 'replace').mockImplementation((to) => {
        replacements.push(typeof to === 'string' ? to : router.resolve(to).fullPath)
        return originalReplace(to)
      })
    })
    expect(harness.activePath.value).toBe('inbox/b')
    expect(router.currentRoute.value.path).toBe('/vault/inbox/b')
    expect(replacements).not.toContain('/vault/inbox/a')
  })

  it('keeps a locked Diary deep link authoritative while persisted Note tabs restore', async () => {
    stubFetchForPaths({
      'inbox/fallback': 'fallback',
      'diary/2026-08-30': 'secret',
    })
    localStorage.setItem(PERSIST_KEY, JSON.stringify({
      v: 1,
      paths: ['inbox/fallback', 'diary/2026-08-30'],
      active: 'diary/2026-08-30',
    }))

    let accessReady = false
    const authorizeDocumentPath = vi.fn(async () => false)
    const { harness, router } = await mountWithRouter({
      isDiaryAccessReady: () => accessReady,
      authorizeDocumentPath,
    }, '/vault/diary/2026-08-30')

    expect(router.currentRoute.value.path).toBe('/vault/diary/2026-08-30')
    expect(router.currentRoute.value.path).not.toBe('/vault/inbox/fallback')
    expect(harness.activePath.value).toBeNull()
    expect(harness.tabs.value.map((tab) => tab.path)).toEqual(['inbox/fallback'])
    expect(authorizeDocumentPath).toHaveBeenCalledWith('diary/2026-08-30')

    accessReady = true
    await harness.resumeDeferredDiaryTabs()
    await flushPromises()

    expect(harness.tabs.value.map((tab) => tab.path)).toEqual([
      'inbox/fallback',
      'diary/2026-08-30',
    ])
    expect(harness.activePath.value).toBe('diary/2026-08-30')
    expect(router.currentRoute.value.path).toBe('/vault/diary/2026-08-30')
  })

  it('restores the persisted active tab only when the initial route is the Vault home', async () => {
    stubFetchForPaths({ 'inbox/saved': 'saved' })
    localStorage.setItem(PERSIST_KEY, JSON.stringify({
      v: 1,
      paths: ['inbox/saved'],
      active: 'inbox/saved',
    }))

    const { harness, router } = await mountWithRouter({}, '/vault')

    expect(harness.activePath.value).toBe('inbox/saved')
    expect(router.currentRoute.value.path).toBe('/vault/inbox/saved')
  })

  it('does not fall back to a persisted Note when a locked Diary deep link is cancelled', async () => {
    stubFetchForPaths({ 'inbox/fallback': 'fallback' })
    localStorage.setItem(PERSIST_KEY, JSON.stringify({
      v: 1,
      paths: ['inbox/fallback', 'diary/2026-08-30'],
      active: 'diary/2026-08-30',
    }))

    const authorizeDocumentPath = vi.fn(async () => false)
    const { harness, router } = await mountWithRouter({
      isDiaryAccessReady: () => false,
      authorizeDocumentPath,
    }, '/vault/diary/2026-08-30')

    expect(authorizeDocumentPath).toHaveBeenCalledWith('diary/2026-08-30')
    expect(router.currentRoute.value.path).toBe('/vault/diary/2026-08-30')
    expect(harness.activePath.value).toBeNull()
    expect(harness.tabs.value.map((tab) => tab.path)).toEqual(['inbox/fallback'])
    await harness.resumeDeferredDiaryTabs()
    expect(harness.tabs.value.map((tab) => tab.path)).toEqual(['inbox/fallback'])
  })

  it('does nothing on mount when localStorage is empty', async () => {
    stubFetchForPaths({ a: 'A' })
    // localStorage cleared by outer beforeEach; just mount.
    const h = await setup()
    await flushPromises()
    expect(h.tabs.value.length).toBe(0)
    expect(h.activePath.value).toBeNull()
    // No missing-tab toast either.
    expect(toastCalls.filter((t) => t.type === 'info')).toEqual([])
  })
})

// --- tab persistence: vault isolation -------------------------------------
//
// Production VaultView supplies the protected vault identity before the
// composable mounts. Unit harnesses use an explicit deterministic identity.

describe('useEditorTabs — vault-scoped persistence', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('uses the scoped key in the default test harness identity', async () => {
    resetTabPersistenceForTesting()
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
    }))
    const h = await setup()
    await flushPromises()
    await h.openPost('inbox/a')
    await flushPromises()
    await new Promise((r) => setTimeout(r, 150))
    expect(localStorage.getItem('nuvyn:tabs:v1:test-vault')).toBeTruthy()
    expect(localStorage.getItem('nuvyn:tabs:v1:vault-1234')).toBeNull()
  })

  it('scopes the persistence key by the supplied authoritative vault id', async () => {
    __setVaultIdForTesting('vault-1234')
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
    }))
    const h = await setup()
    await flushPromises()
    await h.openPost('inbox/a')
    await flushPromises()
    await new Promise((r) => setTimeout(r, 150))
    expect(localStorage.getItem('nuvyn:tabs:v1:vault-1234')).toBeTruthy()
    expect(localStorage.getItem('nuvyn:tabs:v1:test-vault')).toBeNull()
  })
})

// --- round-4 regressions --------------------------------------------------
//
// The review identified two P1 issues:
//
//   1. The last opened tab's async title did not always surface in
//      the strip — Vue's reactivity should track the inner `tab.title`
//      mutation, but it relies on the workspace→tab mapping reading
//      `tab.title` on every recompute. These tests pin the contract
//      from the VaultView workspaceTabs computed: the title shown to
//      the user is whatever `tab.title` holds at read time, with no
//      need for a subsequent push / refresh / select.
//
//   2. Closing a tab only updated the in-memory `tabs.value`. The
//      debounced persistence watcher could lose the write if the
//      user refreshed inside the 100ms debounce window. Every close
//      path (single / closeMany / close others / close right /
//      close all / file delete / rename) now writes synchronously,
//      and a closed-during-pending-restore tab is dropped from both
//      memory and persistence.

describe('useEditorTabs — round-4 async-title reactivity', () => {
  beforeEach(() => {
    localStorage.clear()
    toastCalls.length = 0
    confirmResolve = null
    resetTabPersistenceForTesting()
  })
  afterEach(() => {
    resetTabPersistenceForTesting()
  })

  it('single open: strip title flips to the async title the moment getPost resolves', async () => {
    const titleDeferred = deferred<unknown>()
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/inbox/c': () => titleDeferred.promise,
    }))
    const h = await setup()
    const opening = h.openPost('inbox/c')
    // While getPost is pending, the strip shows the path-derived
    // basename (no title yet).
    expect(h.tabs.value).toHaveLength(1)
    expect(h.tabs.value[0]!.title).toBe('inbox/c')
    titleDeferred.resolve({
      path: 'inbox/c', raw: 'C', content: 'C',
      frontmatter: { title: '文档 C' }, size: 1, mtime: 0,
    })
    await opening
    expect(h.tabs.value[0]!.title).toBe('文档 C')
    // No subsequent mutation is needed — the strip would already
    // read '文档 C' through the VaultView workspaceTabs computed.
  })

  it('three sequential opens: the LAST opened tab surfaces its async title without a follow-up push', async () => {
    const getPostCalls: Array<{ path: string, deferred: ReturnType<typeof deferred<unknown>> }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/tree' || url === '/api/posts') {
        return { ok: true, status: 200, json: async () => [] }
      }
      const match = url.match(/\/api\/posts\/(.+)$/)
      if (!match) throw new Error(`Unexpected fetch: ${url}`)
      const path = match[1]!
      let entry = getPostCalls.find((e) => e.path === path)
      if (!entry) {
        entry = { path, deferred: deferred<unknown>() }
        getPostCalls.push(entry)
      }
      return { ok: true, status: 200, json: async () => entry!.deferred.promise }
    }))
    const h = await setup()
    const openA = h.openPost('a')
    const openB = h.openPost('b')
    const openC = h.openPost('c')
    // Resolve a → b → c in order. Resolve each before the next so
    // the test mirrors real "user clicks docs in sequence".
    const a = getPostCalls.find((e) => e.path === 'a')!
    a.deferred.resolve({ path: 'a', raw: 'A', content: 'A', frontmatter: { title: '文档 A' }, size: 1, mtime: 0 })
    await openA
    const b = getPostCalls.find((e) => e.path === 'b')!
    b.deferred.resolve({ path: 'b', raw: 'B', content: 'B', frontmatter: { title: '文档 B' }, size: 1, mtime: 0 })
    await openB
    const c = getPostCalls.find((e) => e.path === 'c')!
    c.deferred.resolve({ path: 'c', raw: 'C', content: 'C', frontmatter: { title: '文档 C' }, size: 1, mtime: 0 })
    await openC

    // The last opened tab C has the correct title — without any
    // subsequent openPost / selectTab / refresh.
    const cTab = h.tabs.value.find((t) => t.path === 'c')!
    expect(cTab.title).toBe('文档 C')
    expect(h.activePath.value).toBe('c')
    // Sanity: every tab got its title.
    expect(h.tabs.value.find((t) => t.path === 'a')!.title).toBe('文档 A')
    expect(h.tabs.value.find((t) => t.path === 'b')!.title).toBe('文档 B')
  })

  it('save response carrying a new title updates the in-memory tab immediately', async () => {
    const oldPost = postSummary('a', { title: 'Old', size: 1, mtime: 1 })
    const newPost = postSummary('a', { title: 'New', size: 20, mtime: 2 })
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [oldPost],
      // The getPost detail omits a frontmatter title so the opened
      // tab starts with title='a' (the path-derived fallback).
      'GET /api/posts/a': () => ({ path: 'a', raw: 'A', content: 'A', frontmatter: {}, size: 1, mtime: 1 }),
      'PUT /api/posts/a': () => ({ ok: true, raw: 'A2', post: newPost }),
    }))
    const h = await setup()
    await h.openPost('a')
    // On open, the title is the path-derived fallback (no metadata
    // title in frontmatter). After a save the server returns a new
    // title in `post`, and `applyPostSummary` writes it back into
    // the tab immediately.
    expect(h.tabs.value[0]!.title).toBe('a')
    h.onEditorChange('a', 'A2')
    await h.doSaveNow()
    expect(h.tabs.value[0]!.title).toBe('New')
  })
})

describe('useEditorTabs — round-4 synchronous persistence', () => {
  beforeEach(() => {
    localStorage.clear()
    toastCalls.length = 0
    confirmResolve = null
    resetTabPersistenceForTesting()
  })
  afterEach(() => {
    resetTabPersistenceForTesting()
  })

  function readPersisted(): { paths: string[]; active: string | null } | null {
    const raw = localStorage.getItem(PERSIST_KEY)
    if (!raw) return null
    return JSON.parse(raw)
  }

  it('closing a single tab updates persistence immediately, no debounce wait', async () => {
    stubFetchForPaths({ a: 'A', b: 'B' })
    const h = await setup()
    await h.openPost('a')
    await flushPromises()
    await h.openPost('b')
    await flushPromises()
    await h.closeTab('b')
    // NO setTimeout — the synchronous persist must already be on disk.
    expect(readPersisted()).toMatchObject({ paths: ['a'], active: 'a' })
  })

  it('closing the only remaining tab clears persistence synchronously', async () => {
    stubFetchForPaths({ a: 'A' })
    const h = await setup()
    await h.openPost('a')
    await flushPromises()
    await h.closeTab('a')
    expect(readPersisted()).toMatchObject({ paths: [], active: null })
  })

  it('closing the last tab then refreshing restores nothing', async () => {
    stubFetchForPaths({ a: 'A' })
    const h1 = await setup()
    await h1.openPost('a')
    await flushPromises()
    await h1.closeTab('a')
    // Refresh — second mount.
    const h2 = await setup()
    await flushPromises()
    expect(h2.tabs.value).toEqual([])
    expect(h2.activePath.value).toBeNull()
  })

  it('closeMany on "close all" persists an empty tab set', async () => {
    stubFetchForPaths({ a: 'A', b: 'B', c: 'C' })
    const h = await setup()
    await h.openPost('a')
    await h.openPost('b')
    await h.openPost('c')
    await flushPromises()
    await h.closeMany(['a', 'b', 'c'])
    expect(readPersisted()).toMatchObject({ paths: [], active: null })
  })

  it('cancelling the dirty-close prompt does NOT mutate persistence', async () => {
    stubFetchForPaths({ a: 'A', b: 'B' })
    const h = await setup()
    await h.openPost('a')
    await h.openPost('b')
    await flushPromises()
    h.onEditorChange('a', 'A modified')
    // Capture the persistence state set up by the previous opens.
    const beforeClose = readPersisted()
    expect(beforeClose).toMatchObject({ paths: ['a', 'b'], active: 'b' })
    const closing = h.closeTab('a')
    await Promise.resolve()
    answerConfirm(false)
    await expect(closing).resolves.toBe(false)
    // Persistence is still { a, b } — neither tab was actually closed.
    expect(readPersisted()).toMatchObject({ paths: ['a', 'b'], active: 'b' })
  })

  it('a tab closed while its restore is pending is NOT restored by the pending getPost', async () => {
    const deferredPost = deferred<unknown>()
    vi.stubGlobal('fetch', stubFetch({
      'GET /api/tree': () => [],
      'GET /api/posts': () => [],
      'GET /api/posts/inbox/restore-pending': () => deferredPost.promise,
    }))
    localStorage.setItem(PERSIST_KEY, JSON.stringify({
      v: 1, paths: ['inbox/restore-pending'], active: 'inbox/restore-pending',
    }))
    const h = await setup()
    // Restore has pushed the empty tab; getPost is pending.
    await flushPromises()
    expect(h.tabs.value).toHaveLength(1)
    expect(h.tabs.value[0]!.loading).toBe(true)
    // User closes the tab before the pending restore resolves.
    await h.closeTab('inbox/restore-pending')
    expect(h.tabs.value).toHaveLength(0)
    // Old getPost finally returns — must NOT resurrect the tab.
    deferredPost.resolve({
      path: 'inbox/restore-pending', raw: 'R', content: 'R',
      frontmatter: { title: 'R' }, size: 1, mtime: 0,
    })
    await flushPromises()
    await flushPromises()
    expect(h.tabs.value).toEqual([])
    // Persistence also reflects the close (no stale entry).
    expect(readPersisted()).toMatchObject({ paths: [], active: null })
  })

  it('closing B after mount (restore A+B in progress) keeps only A on the next mount', async () => {
    const aDeferred = deferred<unknown>()
    const bDeferred = deferred<unknown>()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/tree' || url === '/api/posts') {
        return { ok: true, status: 200, json: async () => [] }
      }
      const path = url.match(/\/api\/posts\/(.+)$/)![1]!
      const handler = path === 'a' ? aDeferred.promise : bDeferred.promise
      return { ok: true, status: 200, json: async () => handler }
    }))
    localStorage.setItem(PERSIST_KEY, JSON.stringify({
      v: 1, paths: ['a', 'b'], active: 'b',
    }))
    const h = await setup()
    // Restore runs sequentially: A is pushed and awaited first.
    // While A's getPost is pending, only A is in memory.
    await flushPromises()
    expect(h.tabs.value.map((t) => t.path)).toEqual(['a'])
    // Resolve A — the restore loop pushes B and awaits it.
    aDeferred.resolve({ path: 'a', raw: 'A', content: 'A', frontmatter: { title: 'A' }, size: 1, mtime: 0 })
    await flushPromises()
    await flushPromises()
    expect(h.tabs.value.map((t) => t.path)).toEqual(['a', 'b'])
    // Close B before its getPost resolves.
    await h.closeTab('b')
    expect(h.tabs.value.map((t) => t.path)).toEqual(['a'])
    // Late B resolves — must NOT resurrect B.
    bDeferred.resolve({ path: 'b', raw: 'B', content: 'B', frontmatter: { title: 'B' }, size: 1, mtime: 0 })
    await flushPromises()
    await flushPromises()
    expect(h.tabs.value.map((t) => t.path)).toEqual(['a'])
  })

  it('removing the only open tab via the file-delete path persists an empty session', async () => {
    stubFetchForPaths({ a: 'A' })
    const h = await setup()
    await h.openPost('a')
    await flushPromises()
    // Simulate the file-change bus reporting a delete — the
    // composable's removeOpenDocuments path drives a synchronous
    // closeManyConfirmed.
    h.removeOpenDocuments(['a'])
    expect(h.tabs.value).toEqual([])
    expect(readPersisted()).toMatchObject({ paths: [], active: null })
  })
})

// --- round-5 DOM regressions ------------------------------------------------
//
// The previous round only checked `tabs.value[i].title` after the
// await — but the underlying plain object IS mutated either way, so
// the assertion passed even when the reactive Proxy never received
// the update. These tests mount a minimal component that mirrors
// VaultView's `tabs → workspaceTabs → EditorTabs` chain and check
// the DOM directly. If async writes bypass the Proxy, the strip
// title stays at the path-derived basename until some other array
// mutation triggers a recompute (e.g. opening a fourth tab, which
// is exactly the screenshot symptom).

interface DomHarness {
  unmount: () => void
  openPost: (p: string) => Promise<void>
  closeTab: (p: string) => Promise<boolean>
  tabTitles: () => string[]
  /** Last tab row text, for targeted assertions. */
  lastTabTitle: () => string
  activePath: Ref<string | null>
  tabs: Ref<{ path: string; title: string }[]>
}

function mountWorkspaceTabsDom(): Promise<DomHarness> {
  return new Promise(async (resolveOuter) => {
    let captured: DomHarness | null = null
    const router = makeRouter()
    router.push('/vault').catch(() => {})
    await router.isReady()
    const Comp = defineComponent({
      setup() {
        const selectPanel = vi.fn()
        const toggleViewMode = vi.fn()
        const api = useEditorTabs({
          vaultId: 'test-vault',
          selectPanel,
          toggleViewMode,
          fileChanges: createVaultFileChanges(),
        })
        const tabs = api.tabs
        const activePath = api.activePath
        const basename = (p: string) => (p.split('/').pop() ?? p).replace(/\.md$/, '')
        // Mirror VaultView's workspaceTabs mapping exactly. The
        // `title: tab.title || tab.path` fallback is the load-state
        // behavior before getPost resolves.
        const workspaceTabs = computed(() => tabs.value.map((tab) => ({
          id: tab.path,
          label: basename(tab.path),
          title: tab.title || tab.path,
          save: deriveDocumentSavePresentation(tab),
          kind: 'document' as const,
        })))
        captured = {
          unmount: () => {},
          openPost: (p) => api.openPost(p),
          closeTab: (p) => api.closeTab(p),
          tabTitles: () => [...document.querySelectorAll('.tab-title')].map((el) => el.textContent ?? ''),
          lastTabTitle: () => {
            const nodes = document.querySelectorAll('.tab-title')
            return nodes[nodes.length - 1]?.textContent ?? ''
          },
          activePath: api.activePath,
          tabs: api.tabs,
        }
        // Render via JSX-equivalent using the template compiler
        // instead of h() so child re-renders track reactive reads.
        return () => h('div', { class: 'test-host' }, workspaceTabs.value.length > 0
          ? [h(EditorTabs, {
              tabs: workspaceTabs.value,
              activePath: activePath.value,
              onSelect: (id: string) => api.selectTab(id),
              onClose: (id: string) => api.closeTab(id),
            })]
          : [])
      },
    })
    const wrapper = mount(Comp, {
      global: { plugins: [router] },
      attachTo: document.body,
    })
    mountedWrappers.add(wrapper)
    captured!.unmount = () => {
      if (!mountedWrappers.delete(wrapper)) return
      wrapper.unmount()
    }
    // Wait for onMounted's refresh() to settle.
    await nextTick()
    await flushPromises()
    resolveOuter(captured!)
  })
}

describe('useEditorTabs — round-5 real-DOM async-title reactivity', () => {
  beforeEach(() => {
    localStorage.clear()
    toastCalls.length = 0
    confirmResolve = null
    resetTabPersistenceForTesting()
  })
  afterEach(() => {
    resetTabPersistenceForTesting()
    document.querySelectorAll('.tab-context-menu').forEach((el) => el.remove())
  })

  it('last opened tab flips its strip title the moment getPost resolves', async () => {
    const aDeferred = deferred<unknown>()
    const bDeferred = deferred<unknown>()
    const cDeferred = deferred<unknown>()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/tree' || url === '/api/posts') {
        return { ok: true, status: 200, json: async () => [] }
      }
      const path = url.match(/\/api\/posts\/(.+)$/)![1]!
      const handler = ({ a: aDeferred, b: bDeferred, c: cDeferred } as Record<string, ReturnType<typeof deferred<unknown>>>)[path]!
      return { ok: true, status: 200, json: async () => handler.promise }
    }))
    const h = await mountWorkspaceTabsDom()
    // Open A, B, C in sequence with getPost still pending on C.
    const openA = h.openPost('a')
    await flushPromises()
    // While pending, the strip shows the path-derived basename.
    expect(h.lastTabTitle()).toBe('a')
    aDeferred.resolve({ path: 'a', raw: 'A', content: 'A', frontmatter: { title: '英语-主语' }, size: 1, mtime: 0 })
    await openA

    const openB = h.openPost('b')
    await flushPromises()
    expect(h.lastTabTitle()).toBe('b')
    bDeferred.resolve({ path: 'b', raw: 'B', content: 'B', frontmatter: { title: '英语-宾语' }, size: 1, mtime: 0 })
    await openB

    const openC = h.openPost('c')
    await flushPromises()
    // CRITICAL: before resolving C, the strip shows the basename.
    expect(h.lastTabTitle()).toBe('c')
    expect(h.lastTabTitle()).not.toBe('英语-主语')
    expect(h.lastTabTitle()).not.toContain('english-su')

    // Resolve C WITHOUT opening a fourth tab or switching.
    cDeferred.resolve({ path: 'c', raw: 'C', content: 'C', frontmatter: { title: '英语-谓语' }, size: 1, mtime: 0 })
    await openC
    await flushPromises()
    await nextTick()

    // The DOM must reflect the metadata title for C — without any
    // subsequent openPost / selectTab / refresh.
    const titles = h.tabTitles()
    expect(titles).toEqual(['英语-主语', '英语-宾语', '英语-谓语'])
    expect(h.lastTabTitle()).toBe('英语-谓语')
    expect(h.lastTabTitle()).not.toContain('c')

    h.unmount()
  })

  it('restoreOnMount: the last restored tab shows its metadata title without a follow-up push', async () => {
    const aDeferred = deferred<unknown>()
    const bDeferred = deferred<unknown>()
    const cDeferred = deferred<unknown>()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/tree' || url === '/api/posts') {
        return { ok: true, status: 200, json: async () => [] }
      }
      const path = url.match(/\/api\/posts\/(.+)$/)![1]!
      const handler = ({ a: aDeferred, b: bDeferred, c: cDeferred } as Record<string, ReturnType<typeof deferred<unknown>>>)[path]!
      return { ok: true, status: 200, json: async () => handler.promise }
    }))
    localStorage.setItem(PERSIST_KEY, JSON.stringify({
      v: 1, paths: ['a', 'b', 'c'], active: 'c',
    }))
    const h = await mountWorkspaceTabsDom()
    // Restore runs sequentially. Resolve each as restore reaches it.
    await flushPromises()
    expect(h.lastTabTitle()).toBe('a')
    aDeferred.resolve({ path: 'a', raw: 'A', content: 'A', frontmatter: { title: '英语-主语' }, size: 1, mtime: 0 })
    await flushPromises()
    await flushPromises()
    expect(h.lastTabTitle()).toBe('b')
    bDeferred.resolve({ path: 'b', raw: 'B', content: 'B', frontmatter: { title: '英语-宾语' }, size: 1, mtime: 0 })
    await flushPromises()
    await flushPromises()
    expect(h.lastTabTitle()).toBe('c')
    cDeferred.resolve({ path: 'c', raw: 'C', content: 'C', frontmatter: { title: '英语-谓语' }, size: 1, mtime: 0 })
    await flushPromises()
    await flushPromises()
    await nextTick()

    expect(h.tabTitles()).toEqual(['英语-主语', '英语-宾语', '英语-谓语'])
    expect(h.lastTabTitle()).toBe('英语-谓语')
    h.unmount()
  })

  it('loading indicator clears on the tab whose getPost just resolved (even if it is the last tab)', async () => {
    // Round-5 surface test for the broader "async field never
    // notifies" bug: `loading=false` and `serverMtime` must also
    // land on the Proxy so the editor pane clears its spinner.
    const cDeferred = deferred<unknown>()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/tree' || url === '/api/posts') {
        return { ok: true, status: 200, json: async () => [] }
      }
      const path = url.match(/\/api\/posts\/(.+)$/)![1]!
      if (path !== 'c') throw new Error(`Unexpected getPost: ${path}`)
      return { ok: true, status: 200, json: async () => cDeferred.promise }
    }))
    const h = await mountWorkspaceTabsDom()
    const opening = h.openPost('c')
    await flushPromises()
    // Tab exists with loading=true until getPost resolves.
    expect(h.tabs.value[0]!.title).toBe('c') // path fallback
    cDeferred.resolve({ path: 'c', raw: 'C', content: 'C', frontmatter: { title: '英语-谓语' }, size: 1, mtime: 7 })
    await opening
    await flushPromises()
    await nextTick()
    expect(h.tabs.value[0]!.title).toBe('英语-谓语')
    expect(h.lastTabTitle()).toBe('英语-谓语')
    h.unmount()
  })
})

// --- round-6 restore-failure-vs-reopen race --------------------------------
//
// Reproducing the time-of-check / time-of-use race:
//
//   1. Restore A → placeholder pushed, R1 pending.
//   2. User closes the placeholder.
//   3. User reopens A from the file tree → a NEW tab Q is created
//      and the user starts editing it.
//   4. R1 (the old restore) finally FAILS.
//
// The failure branch must:
//   - splice by plain-object identity, NOT by path — otherwise it
//     would silently delete the user's new tab Q.
//   - preserve Q's local edits.
//   - keep A in persistence (the new Q is now the canonical tab).
//   - NOT report a "missing-tab" toast (the file is open again).

describe('useEditorTabs — round-6 restore-failure race vs reopen', () => {
  beforeEach(() => {
    localStorage.clear()
    toastCalls.length = 0
    confirmResolve = null
    resetTabPersistenceForTesting()
  })
  afterEach(() => {
    resetTabPersistenceForTesting()
  })

  it('a same-path tab reopened while the old restore is pending survives the old restore failure', async () => {
    const oldRestore = deferred<unknown>()
    const newOpen = deferred<unknown>()
    let openCount = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/tree' || url === '/api/posts') {
        return { ok: true, status: 200, json: async () => [] }
      }
      const path = url.match(/\/api\/posts\/(.+)$/)![1]!
      if (path !== 'english-subject') throw new Error(`Unexpected getPost: ${path}`)
      openCount++
      return {
        ok: true,
        status: 200,
        json: async () => (openCount === 1 ? oldRestore.promise : newOpen.promise),
      }
    }))
    // Pre-seed persistence with the restored path so the onMounted
    // restore loop tries to open it.
    localStorage.setItem(PERSIST_KEY, JSON.stringify({
      v: 1, paths: ['english-subject'], active: 'english-subject',
    }))
    const h = await setup()
    // Restore has pushed the placeholder; R1 is pending.
    await flushPromises()
    expect(h.tabs.value).toHaveLength(1)
    expect(h.tabs.value[0]!.loading).toBe(true)
    // User closes the placeholder.
    await h.closeTab('english-subject')
    expect(h.tabs.value).toHaveLength(0)
    // User reopens A from the file tree — a NEW tab Q is pushed and
    // a new request R2 fires. openPost's "already open" check does
    // NOT match because the previous placeholder was closed.
    const reopening = h.openPost('english-subject')
    await flushPromises()
    expect(h.tabs.value).toHaveLength(1)
    // R2 succeeds, populating Q.
    newOpen.resolve({
      path: 'english-subject', raw: 'live', content: 'live',
      frontmatter: { title: '英语-主语' }, size: 4, mtime: 1,
    })
    await reopening
    expect(h.tabs.value[0]!.title).toBe('英语-主语')
    // User edits the buffer — this dirties the tab.
    h.onEditorChange('english-subject', 'local edit')
    expect(h.tabs.value[0]!.saveStatus).toBe('dirty')
    expect(h.tabs.value[0]!.raw).toBe('local edit')
    // Old R1 finally FAILS. The old restoreOneTab's catch must NOT
    // splice the user's Q (which is a different plain object).
    oldRestore.reject(new Error('HTTP 500'))
    await flushPromises()
    await flushPromises()
    // Q survives with its title AND its dirty edit intact.
    expect(h.tabs.value).toHaveLength(1)
    expect(h.tabs.value[0]!.title).toBe('英语-主语')
    expect(h.tabs.value[0]!.raw).toBe('local edit')
    expect(h.tabs.value[0]!.saveStatus).toBe('dirty')
    // Persistence still has the path — the user's tab is canonical.
    const persisted = JSON.parse(localStorage.getItem(PERSIST_KEY)!)
    expect(persisted.paths).toEqual(['english-subject'])
    // No "missing-tab" toast — the file is open again.
    const toasts = toastCalls.filter((t) => t.type === 'info' && t.message.includes('已不存在'))
    expect(toasts).toEqual([])
  })

  it('late failure of an old restore does NOT remove a same-path tab opened during the await', async () => {
    // Variant: the restore-then-close-then-reopen flow without
    // explicitly seeding persistence — the restore happens via the
    // session restore loop on mount, then the user closes the
    // loading tab and reopens it via the file tree.
    const restore = deferred<unknown>()
    const reopen = deferred<unknown>()
    let openCount = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/tree' || url === '/api/posts') {
        return { ok: true, status: 200, json: async () => [] }
      }
      openCount++
      return {
        ok: true,
        status: 200,
        json: async () => (openCount === 1 ? restore.promise : reopen.promise),
      }
    }))
    localStorage.setItem(PERSIST_KEY, JSON.stringify({
      v: 1, paths: ['a'], active: 'a',
    }))
    const h = await setup()
    await flushPromises()
    expect(h.tabs.value).toHaveLength(1)
    await h.closeTab('a')
    const reopening = h.openPost('a')
    await flushPromises()
    reopen.resolve({ path: 'a', raw: 'A', content: 'A', frontmatter: { title: 'A' }, size: 1, mtime: 1 })
    await reopening
    h.onEditorChange('a', 'edit')
    expect(h.tabs.value[0]!.saveStatus).toBe('dirty')
    restore.reject(new Error('HTTP 500'))
    await flushPromises()
    await flushPromises()
    expect(h.tabs.value).toHaveLength(1)
    expect(h.tabs.value[0]!.saveStatus).toBe('dirty')
    expect(h.tabs.value[0]!.raw).toBe('edit')
  })
})

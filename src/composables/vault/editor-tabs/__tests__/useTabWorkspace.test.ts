import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  getPost: vi.fn(),
  getTree: vi.fn(),
  listPosts: vi.fn(),
}))

vi.mock('../../../../lib/api', () => api)
vi.mock('vue-router', () => ({ useRouter: () => ({ replace: vi.fn() }) }))

import { useTabWorkspace, type PreviewCloseBarrier } from '../useTabWorkspace'
import { getMarkdownModel, registerMarkdownModel, resetMarkdownModelsForTesting } from '../../../../components/vault/monacoModelRegistry'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function workspaceOptions() {
  return {
    confirm: async () => true,
    toastError: vi.fn(),
    toastInfo: vi.fn(),
  }
}

function postDetail(path: string) {
  return {
    path, raw: 'body', content: 'body', frontmatter: {},
    metadata: {
      id: 'doc', path, title: 'title', summary: '', tags: [],
      createdAt: 1, updatedAt: 1,
    },
    size: 4, mtime: 1,
  }
}

describe('useTabWorkspace openPost workspace refresh', () => {
  beforeEach(() => {
    api.getPost.mockReset()
    api.getTree.mockReset()
    api.listPosts.mockReset()
    api.getTree.mockResolvedValue([])
    api.listPosts.mockResolvedValue([])
  })

  it('propagates a workspace refresh failure by default', async () => {
    api.getPost.mockResolvedValue(postDetail('notes/a'))
    api.getTree.mockRejectedValue(new Error('tree refresh failed'))
    const workspace = useTabWorkspace(workspaceOptions())

    await expect(workspace.openPost('notes/a')).rejects.toThrow('tree refresh failed')

    // The document itself loaded — only the tree/posts refresh failed.
    const tab = workspace.tabs.value[0]
    expect(tab?.raw).toBe('body')
    expect(tab?.loadError).toBeNull()
    expect(tab?.loading).toBe(false)
  })

  it('loads the document and skips the workspace refresh with refresh: false', async () => {
    api.getPost.mockResolvedValue(postDetail('notes/b'))
    // A refresh failure that would reject a default openPost.
    api.getTree.mockRejectedValue(new Error('tree refresh failed'))
    api.listPosts.mockRejectedValue(new Error('posts refresh failed'))
    const workspace = useTabWorkspace(workspaceOptions())

    await expect(workspace.openPost('notes/b', { refresh: false })).resolves.toBeUndefined()

    expect(api.getTree).not.toHaveBeenCalled()
    expect(api.listPosts).not.toHaveBeenCalled()
    const tab = workspace.tabs.value[0]
    expect(tab?.raw).toBe('body')
    expect(tab?.loadError).toBeNull()
    expect(tab?.loading).toBe(false)
  })
})

describe('Note preview slots', () => {
  beforeEach(() => {
    resetMarkdownModelsForTesting()
    api.getPost.mockReset().mockImplementation(async (path: string) => postDetail(path))
    api.getTree.mockResolvedValue([])
    api.listPosts.mockResolvedValue([])
  })

  function createWorkspace() {
    const commit = vi.fn()
    const rollback = vi.fn()
    const preparePreviewClose = vi.fn<() => Promise<PreviewCloseBarrier | null>>(async () => ({ commit, rollback }))
    const onPreviewReplaced = vi.fn()
    const persist = vi.fn()
    const options = { ...workspaceOptions(), preparePreviewClose, onPreviewReplaced, persist }
    return { workspace: useTabWorkspace(options), options, commit, rollback }
  }
  const preview = { refresh: false, mode: 'preview' as const }

  it('keeps one preview in its original sorted slot without replacing pinned tabs or retaining its model', async () => {
    const { workspace, options } = createWorkspace()
    await workspace.openPost('inbox/x', { refresh: false })
    await workspace.openPost('inbox/a', preview)
    await workspace.openPost('inbox/y', { refresh: false })
    workspace.reorderTabs(['inbox/a', 'inbox/y', 'inbox/x'])
    const dispose = vi.fn()
    registerMarkdownModel('inbox/a', { isDisposed: () => false, dispose })
    await workspace.openPost('inbox/b', preview)
    expect(workspace.tabs.value.map((tab) => [tab.path, tab.mode])).toEqual([
      ['inbox/b', 'preview'], ['inbox/y', 'pinned'], ['inbox/x', 'pinned'],
    ])
    expect(workspace.activePath.value).toBe('inbox/b')
    expect(getMarkdownModel('inbox/a')).toBeUndefined()
    expect(dispose).toHaveBeenCalledOnce()
    expect(options.onPreviewReplaced).toHaveBeenCalledWith('inbox/a', 'inbox/b')
  })

  it('pins in place without loading, changing revision, saving or reordering', async () => {
    const { workspace, options } = createWorkspace()
    await workspace.openPost('inbox/a', preview)
    const tab = workspace.tabs.value[0]!
    const snapshot = { ...tab }
    expect(workspace.pinTab('inbox/a')).toBe(true)
    expect(workspace.pinTab('inbox/a')).toBe(false)
    expect(workspace.tabs.value[0]).toBe(tab)
    expect(tab).toEqual({ ...snapshot, mode: 'pinned' })
    await workspace.openPost('inbox/a', preview)
    expect(tab.mode).toBe('pinned')
    expect(api.getPost).toHaveBeenCalledOnce()
    expect(options.persist).toHaveBeenCalled()
    await workspace.openPost('inbox/b', preview)
    await workspace.openPost('inbox/b', { refresh: false })
    expect(workspace.tabs.value.map((item) => item.mode)).toEqual(['pinned', 'pinned'])
  })

  it.each(['dirty', 'saving', 'error', 'offline', 'external'] as const)('retains and pins a preview with %s save status', async (status) => {
    const { workspace, options } = createWorkspace()
    await workspace.openPost('inbox/a', preview)
    workspace.tabs.value[0]!.saveStatus = status
    await workspace.openPost('inbox/b', preview)
    expect(workspace.tabs.value.map((tab) => [tab.path, tab.mode])).toEqual([['inbox/a', 'pinned'], ['inbox/b', 'preview']])
    expect(options.preparePreviewClose).not.toHaveBeenCalled()
  })

  it.each([{ raw: 'local body' }, { revision: 1 }, { savingRevision: 0 }, { externalRaw: 'disk body' }, { externalKind: 'deleted' as const }])('preserves unresolved content independently of the status label: %j', async (patch) => {
    const { workspace } = createWorkspace()
    await workspace.openPost('inbox/a', preview)
    Object.assign(workspace.tabs.value[0]!, patch)
    await workspace.openPost('inbox/b', preview)
    expect(workspace.tabs.value).toHaveLength(2)
    expect(workspace.tabs.value[0]).toMatchObject({ ...patch, mode: 'pinned' })
  })

  it('requires a successful close barrier; uncertainty never discards the existing preview', async () => {
    const { workspace, options } = createWorkspace()
    await workspace.openPost('inbox/a', preview)
    options.preparePreviewClose.mockResolvedValueOnce(null)
    await workspace.openPost('inbox/b', preview)
    expect(workspace.tabs.value.map((tab) => tab.mode)).toEqual(['pinned', 'preview'])
  })

  it('rechecks edits and an explicit pin while preparing a replacement', async () => {
    const { workspace, options, rollback } = createWorkspace()
    await workspace.openPost('inbox/a', preview)
    const barrier = deferred<{ commit: () => void; rollback: () => void }>()
    options.preparePreviewClose.mockReturnValueOnce(barrier.promise)
    const opening = workspace.openPost('inbox/b', preview)
    await Promise.resolve()
    workspace.pinTab('inbox/a')
    barrier.resolve({ commit: vi.fn(), rollback })
    await opening
    expect(rollback).toHaveBeenCalledOnce()
    expect(workspace.tabs.value.map((tab) => tab.mode)).toEqual(['pinned', 'preview'])
  })

  it('serializes close preparation and lets the last navigation win', async () => {
    const { workspace, options, commit, rollback } = createWorkspace()
    await workspace.openPost('inbox/a', preview)
    const barrier = deferred<{ commit: () => void; rollback: () => void }>()
    options.preparePreviewClose.mockReturnValueOnce(barrier.promise)
    const b = workspace.openPost('inbox/b', preview)
    await Promise.resolve()
    const c = workspace.openPost('inbox/c', preview)
    barrier.resolve({ commit, rollback })
    await Promise.all([b, c])
    expect(workspace.tabs.value.map((tab) => tab.path)).toEqual(['inbox/c'])
    expect(rollback).toHaveBeenCalledOnce()
    expect(api.getPost.mock.calls.map(([path]) => path)).not.toContain('inbox/b')
  })

  it('pins a double-click target in the preview slot even while prior close preparation is pending', async () => {
    const { workspace, options, commit, rollback } = createWorkspace()
    await workspace.openPost('inbox/a', preview)
    const barrier = deferred<{ commit: () => void; rollback: () => void }>()
    options.preparePreviewClose.mockReturnValueOnce(barrier.promise)
    const single = workspace.openPost('inbox/b', preview)
    await Promise.resolve()
    const double = workspace.openPost('inbox/b', { refresh: false, mode: 'pinned', reusePreview: true })
    barrier.resolve({ commit, rollback })
    await Promise.all([single, double])
    expect(workspace.tabs.value.map((tab) => [tab.path, tab.mode])).toEqual([['inbox/b', 'pinned']])
  })

  it('drops delayed replaced/closed loads and never resurrects their tabs', async () => {
    const { workspace } = createWorkspace()
    const slow = deferred<ReturnType<typeof postDetail>>()
    api.getPost.mockImplementation((path: string) => path === 'inbox/a' ? slow.promise : Promise.resolve(postDetail(path)))
    const a = workspace.openPost('inbox/a', preview)
    await workspace.openPost('inbox/b', preview)
    await workspace.openPost('inbox/c', preview)
    slow.resolve(postDetail('inbox/a'))
    await a
    expect(workspace.tabs.value.map((tab) => tab.path)).toEqual(['inbox/c'])
    const closed = deferred<ReturnType<typeof postDetail>>()
    api.getPost.mockReturnValueOnce(closed.promise)
    const d = workspace.openPost('inbox/d', preview)
    await vi.waitFor(() => expect(api.getPost).toHaveBeenCalledWith('inbox/d'))
    await workspace.closeTab('inbox/d')
    closed.resolve(postDetail('inbox/d'))
    await d
    expect(workspace.tabs.value).toEqual([])
  })

  it('does not apply old-path responses after rename, or any response after disposal', async () => {
    const { workspace } = createWorkspace()
    const slow = deferred<ReturnType<typeof postDetail>>()
    api.getPost.mockReturnValueOnce(slow.promise)
    const opening = workspace.openPost('inbox/a', preview)
    workspace.renameOpenDocuments([{ from: 'inbox/a', to: 'archive/a' }])
    slow.resolve({ ...postDetail('inbox/a'), raw: 'obsolete' })
    await opening
    expect(workspace.tabs.value[0]).toMatchObject({ path: 'archive/a', raw: 'body', loading: false })
    expect(api.getPost).toHaveBeenLastCalledWith('archive/a')
    const closed = deferred<ReturnType<typeof postDetail>>()
    api.getPost.mockReturnValueOnce(closed.promise)
    const b = workspace.openPost('inbox/b', { refresh: false })
    workspace.dispose()
    closed.resolve({ ...postDetail('inbox/b'), raw: 'must not apply' })
    await b
    expect(workspace.tabs.value.find((tab) => tab.path === 'inbox/b')?.raw).toBe('')
  })

  it('recovers from failed preview loading by replacing its slot', async () => {
    const { workspace } = createWorkspace()
    api.getPost.mockRejectedValueOnce(new Error('offline load'))
    await workspace.openPost('inbox/a', preview)
    expect(workspace.tabs.value[0]?.loadError).toBe('offline load')
    await workspace.openPost('inbox/b', preview)
    expect(workspace.tabs.value).toHaveLength(1)
    expect(workspace.activeTab.value).toMatchObject({ path: 'inbox/b', loadError: null })
  })

  it('keeps the 6/9 limits without evicting pinned documents; preview replacement works at nine', async () => {
    const { workspace, options } = createWorkspace()
    for (let index = 0; index < 8; index++) await workspace.openPost(`inbox/${index}`, { refresh: false })
    await workspace.openPost('inbox/a', preview)
    await workspace.openPost('inbox/b', preview)
    expect(workspace.tabs.value).toHaveLength(9)
    workspace.pinTab('inbox/b')
    await workspace.openPost('inbox/c', preview)
    expect(workspace.tabs.value).toHaveLength(9)
    expect(options.toastError).toHaveBeenCalledOnce()
    expect(options.toastInfo).toHaveBeenCalled()
  })

  it('does not enable preview policy for Diary or Ledger paths', async () => {
    const { workspace } = createWorkspace()
    await workspace.openPost('diary/2026-10-24', preview)
    await workspace.openPost('ledger/data', preview)
    await workspace.openPost('inbox/a', preview)
    expect(workspace.tabs.value.map((tab) => tab.mode)).toEqual([undefined, undefined, 'preview'])
  })
})

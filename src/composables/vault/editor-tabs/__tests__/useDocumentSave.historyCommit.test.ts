// @vitest-environment jsdom
import { ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useDocumentSave } from '../useDocumentSave'
import type { Tab } from '../../../../components/vault/tabs'
import { createVaultFileChanges } from '../../context/fileChanges'

function tab(overrides: Partial<Tab> = {}): Tab {
  return {
    path: 'inbox/a',
    title: 'A',
    raw: '# Newer editor content',
    originalRaw: '# Saved content',
    revision: 2,
    savedRevision: 1,
    savingRevision: null,
    saveStatus: 'dirty',
    error: null,
    loadError: null,
    loading: false,
    serverMtime: 1,
    ...overrides,
  }
}

function saveResponse(raw: string): Response {
  return new Response(JSON.stringify({
    ok: true,
    raw,
    post: {
      path: 'inbox/a', title: 'A', created: '', updated: '', tags: [], summary: '',
      size: raw.length, mtime: 2,
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => vi.restoreAllMocks())

describe('useDocumentSave prepareHistoryCommit', () => {
  it('flushes selected open editor content through the existing save pipeline', async () => {
    const current = tab()
    const fetchMock = vi.fn().mockResolvedValue(saveResponse(current.raw))
    vi.stubGlobal('fetch', fetchMock)
    const save = useDocumentSave({
      tabs: ref([current]),
      activePath: ref(current.path),
      applyPostSummary: vi.fn(),
      fileChanges: createVaultFileChanges(),
      toastError: vi.fn(),
    })

    await save.prepareHistoryCommit(['inbox/a.md'])

    expect(fetchMock).toHaveBeenCalledWith('/api/posts/inbox/a', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({
        raw: '# Newer editor content',
        baseRaw: '# Saved content',
      }),
    }))
    expect(current.originalRaw).toBe('# Newer editor content')
    expect(current.savedRevision).toBe(current.revision)
  })

  it('blocks version creation coordination when a selected editor cannot be saved', async () => {
    const current = tab()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500 })))
    const save = useDocumentSave({
      tabs: ref([current]),
      activePath: ref(current.path),
      applyPostSummary: vi.fn(),
      fileChanges: createVaultFileChanges(),
      toastError: vi.fn(),
    })

    await expect(save.prepareHistoryCommit(['inbox/a.md'])).rejects.toThrow('HTTP 500')
    expect(fetch).toHaveBeenCalledOnce()
    expect(current.raw).toBe('# Newer editor content')
    expect(current.saveStatus).toBe('error')
  })

  it('stops version creation and preserves external state when saving conflicts', async () => {
    const current = tab()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: 'document changed on disk',
      code: 'EDIT_CONFLICT',
      current: { raw: '# Disk content', mtime: 9, size: 14 },
    }), { status: 409, headers: { 'content-type': 'application/json' } })))
    const save = useDocumentSave({
      tabs: ref([current]),
      activePath: ref(current.path),
      applyPostSummary: vi.fn(),
      fileChanges: createVaultFileChanges(),
      toastError: vi.fn(),
    })

    await expect(save.prepareHistoryCommit(['inbox/a.md'])).rejects.toThrow()
    expect(current).toMatchObject({
      raw: '# Newer editor content',
      originalRaw: '# Saved content',
      savedRevision: 1,
      externalRaw: '# Disk content',
      serverMtime: 9,
      saveStatus: 'external',
    })
  })

  it('does not touch open documents that are not selected', async () => {
    const current = tab()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const save = useDocumentSave({
      tabs: ref([current]),
      activePath: ref(current.path),
      applyPostSummary: vi.fn(),
      fileChanges: createVaultFileChanges(),
      toastError: vi.fn(),
    })

    await save.prepareHistoryCommit(['inbox/other.md'])
    expect(fetchMock).not.toHaveBeenCalled()
    expect(current.raw).toBe('# Newer editor content')
    expect(current.saveStatus).toBe('dirty')
  })

  it('commits the click-time snapshot and saves edits made behind the barrier afterward', async () => {
    const current = tab()
    let finishSnapshotSave!: (response: Response) => void
    const snapshotSave = new Promise<Response>((resolve) => { finishSnapshotSave = resolve })
    const fetchMock = vi.fn()
      .mockReturnValueOnce(snapshotSave)
      .mockResolvedValueOnce(saveResponse('# Typed after click'))
    vi.stubGlobal('fetch', fetchMock)
    const save = useDocumentSave({
      tabs: ref([current]),
      activePath: ref(current.path),
      applyPostSummary: vi.fn(),
      fileChanges: createVaultFileChanges(),
      toastError: vi.fn(),
    })

    const preparing = save.prepareHistoryCommit(['inbox/a.md'])
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    save.onEditorChange(current.path, '# Typed after click')
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalledOnce()

    finishSnapshotSave(saveResponse('# Newer editor content'))
    const release = await preparing

    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      body: JSON.stringify({
        raw: '# Newer editor content',
        baseRaw: '# Saved content',
      }),
    }))
    expect(current.raw).toBe('# Typed after click')
    expect(current.revision).not.toBe(current.savedRevision)

    await release()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      body: JSON.stringify({
        raw: '# Typed after click',
        baseRaw: '# Newer editor content',
      }),
    }))
    expect(current.revision).toBe(current.savedRevision)
  })

  it('keeps the dirty state when manual save is pressed behind an active barrier', async () => {
    const current = tab()
    const fetchMock = vi.fn().mockResolvedValue(saveResponse(current.raw))
    vi.stubGlobal('fetch', fetchMock)
    const save = useDocumentSave({
      tabs: ref([current]),
      activePath: ref(current.path),
      applyPostSummary: vi.fn(),
      fileChanges: createVaultFileChanges(),
      toastError: vi.fn(),
    })
    const release = await save.prepareHistoryCommit(['inbox/a.md'])
    save.onEditorChange(current.path, '# After click')

    await save.doSave(current.path)

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(current.revision).not.toBe(current.savedRevision)
    expect(current.saveStatus).toBe('dirty')
    await release()
  })
})

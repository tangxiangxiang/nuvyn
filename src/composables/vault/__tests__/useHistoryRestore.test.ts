import { ref } from 'vue'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { Tab } from '../../../components/vault/tabs'
import { createVaultFileChanges } from '../context/fileChanges'
import { useDocumentSave } from '../editor-tabs/useDocumentSave'
import {
  useHistoryRestore,
  type HistoryRestoreRequest,
  type HistoryRestoreSource,
} from '../useHistoryRestore'
import { useI18n } from '../../useI18n'

function tab(overrides: Partial<Tab> = {}): Tab {
  return {
    path: 'inbox/redis',
    title: 'Redis Notes',
    raw: '# Current',
    originalRaw: '# Saved',
    revision: 2,
    savedRevision: 1,
    savingRevision: null,
    saveStatus: 'dirty',
    error: 'old save error',
    loadError: null,
    loading: false,
    externalRaw: 'stale external',
    serverMtime: 10,
    ...overrides,
  }
}

function source(overrides: Partial<HistoryRestoreSource> = {}): HistoryRestoreSource {
  return {
    documentPath: 'inbox/redis',
    documentTitle: 'Redis Notes',
    revisionId: 'revision-a',
    revisionTime: 1_752_548_260_000,
    historicalRaw: '# Historical',
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function harness(options: {
  tabs?: Tab[]
  confirm?: (request: HistoryRestoreRequest) => Promise<boolean>
  restoreFile?: Mock
  refreshVault?: Mock
  refreshComparison?: Mock
  acquireMutation?: (paths: readonly string[]) => (() => void) | null
  onConflict?: Mock
  prepareEditorRestore?: Mock
} = {}) {
  const tabs = ref(options.tabs ?? [tab()])
  const fileChanges = createVaultFileChanges()
  const prepareEditorRestore = options.prepareEditorRestore ?? vi.fn().mockResolvedValue({
    paths: ['inbox/redis'],
    commit: vi.fn(),
    rollback: vi.fn(),
  })
  const refreshVault = options.refreshVault ?? vi.fn().mockResolvedValue(undefined)
  const refreshComparison = options.refreshComparison ?? vi.fn().mockResolvedValue(true)
  const onSuccess = vi.fn()
  const onError = vi.fn()
  const restoreFile = options.restoreFile ?? vi.fn().mockResolvedValue({
    path: 'inbox/redis.md',
    ref: 'revision-a',
    raw: '# Historical',
    mtime: 100,
  })
  const restore = useHistoryRestore({
    tabs,
    fileChanges,
    confirm: options.confirm ?? vi.fn().mockResolvedValue(true),
    prepareEditorRestore,
    refreshVault,
    refreshComparison,
    acquireMutation: options.acquireMutation,
    onConflict: options.onConflict,
    restoreFile,
    onSuccess,
    onError,
  })
  return {
    restore,
    tabs,
    fileChanges,
    prepareEditorRestore,
    refreshVault,
    refreshComparison,
    restoreFile,
    onSuccess,
    onError,
  }
}

describe('useHistoryRestore', () => {
  beforeEach(() => {
    useI18n().setLocale('en')
  })

  it('requires confirmation and performs no work when cancelled', async () => {
    const confirm = vi.fn().mockResolvedValue(false)
    const h = harness({ confirm })

    await expect(h.restore.restore(source())).resolves.toBe(false)

    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
      documentTitle: 'Redis Notes',
      revisionTime: 1_752_548_260_000,
      currentDirty: true,
    }))
    expect(h.restoreFile).not.toHaveBeenCalled()
    expect(h.tabs.value[0]?.raw).toBe('# Current')
  })

  it('restores exactly one file and updates the existing editor tab without duplicating it', async () => {
    const h = harness()

    await expect(h.restore.restore(source())).resolves.toBe(true)

    expect(h.restoreFile).toHaveBeenCalledOnce()
    expect(h.restoreFile).toHaveBeenCalledWith('inbox/redis.md', 'revision-a')
    expect(h.tabs.value).toHaveLength(1)
    expect(h.tabs.value[0]).toMatchObject({
      raw: '# Historical',
      originalRaw: '# Historical',
      revision: 3,
      savedRevision: 3,
      saveStatus: 'idle',
      error: null,
      loadError: null,
      externalRaw: null,
      serverMtime: 100,
    })
    expect(h.restore.buildRequest(source()).currentDirty).toBe(false)
    expect(h.prepareEditorRestore).toHaveBeenCalledWith('inbox/redis')
    expect(h.refreshComparison).toHaveBeenCalledWith('inbox/redis')
    expect(h.fileChanges.events.value).toEqual([
      expect.objectContaining({
        path: 'inbox/redis',
        kind: 'write',
        newRaw: '# Historical',
        source: 'history-restore',
      }),
    ])
    expect(h.onSuccess).toHaveBeenCalledWith(expect.any(Object), { refreshFailed: false })
  })

  it('restores a closed document and refreshes vault state without opening a tab', async () => {
    const h = harness({ tabs: [] })

    await h.restore.restore(source())

    expect(h.tabs.value).toEqual([])
    expect(h.refreshVault).toHaveBeenCalledOnce()
    expect(h.fileChanges.events.value).toHaveLength(1)
  })

  it('leaves editor and history navigation state untouched when the API fails', async () => {
    const restoreFile = vi.fn().mockRejectedValue(new Error('disk denied'))
    const h = harness({ restoreFile })
    const before = { ...h.tabs.value[0]! }

    await expect(h.restore.restore(source())).resolves.toBe(false)

    expect(h.tabs.value[0]).toEqual(before)
    expect(h.fileChanges.events.value).toEqual([])
    expect(h.refreshVault).not.toHaveBeenCalled()
    expect(h.refreshComparison).not.toHaveBeenCalled()
    expect(h.onError).toHaveBeenCalledWith(expect.any(Object), expect.any(Error))
    expect(h.restore.error.value).toBe('disk denied')
  })

  it('prevents duplicate requests while a restore is in flight', async () => {
    const response = deferred<{ path: string; ref: string; raw: string; mtime: number }>()
    const restoreFile = vi.fn().mockReturnValue(response.promise)
    const h = harness({ restoreFile })

    const first = h.restore.restore(source())
    await vi.waitFor(() => expect(h.restore.restoring.value).toBe(true))
    await expect(h.restore.restore(source({ revisionId: 'revision-b' }))).resolves.toBe(false)
    response.resolve({ path: 'inbox/redis.md', ref: 'revision-a', raw: '# Historical', mtime: 100 })
    await first

    expect(restoreFile).toHaveBeenCalledOnce()
  })

  it('preserves edits made while restore is pending and resumes saving after commit', async () => {
    const response = deferred<{ path: string; ref: string; raw: string; mtime: number }>()
    const barrier = { paths: ['inbox/redis'], commit: vi.fn(), rollback: vi.fn() }
    const h = harness({
      restoreFile: vi.fn().mockReturnValue(response.promise),
      prepareEditorRestore: vi.fn().mockResolvedValue(barrier),
    })

    const restoring = h.restore.restore(source())
    await vi.waitFor(() => expect(h.restore.restoring.value).toBe(true))
    h.tabs.value[0]!.raw = '# New edit'
    h.tabs.value[0]!.revision += 1
    h.tabs.value[0]!.saveStatus = 'dirty'
    response.resolve({ path: 'inbox/redis.md', ref: 'revision-a', raw: '# Historical', mtime: 100 })

    await expect(restoring).resolves.toBe(true)
    expect(h.tabs.value[0]).toMatchObject({
      raw: '# New edit',
      originalRaw: '# Historical',
      saveStatus: 'dirty',
    })
    expect(barrier.commit).toHaveBeenCalledWith(['inbox/redis'])
    expect(barrier.rollback).not.toHaveBeenCalled()
  })

  it('rolls back the editor save barrier when restore fails', async () => {
    const barrier = { paths: ['inbox/redis'], commit: vi.fn(), rollback: vi.fn() }
    const h = harness({
      restoreFile: vi.fn().mockRejectedValue(new Error('restore failed')),
      prepareEditorRestore: vi.fn().mockResolvedValue(barrier),
    })

    await expect(h.restore.restore(source())).resolves.toBe(false)
    expect(barrier.rollback).toHaveBeenCalledOnce()
    expect(barrier.commit).not.toHaveBeenCalled()
  })

  it('holds the real save barrier for the entire restore and saves a newer edit afterward', async () => {
    vi.useFakeTimers()
    const tabs = ref([tab({ raw: '# Current', originalRaw: '# Current', revision: 2, savedRevision: 2 })])
    const fileChanges = createVaultFileChanges()
    const save = useDocumentSave({
      tabs,
      activePath: ref('inbox/redis'),
      applyPostSummary: vi.fn(),
      fileChanges,
      toastError: vi.fn(),
    })
    const response = deferred<{ path: string; ref: string; raw: string; mtime: number }>()
    const put = vi.fn(async (_url: string, init?: RequestInit) => {
      const raw = (JSON.parse(String(init?.body)) as { raw: string }).raw
      return new Response(JSON.stringify({
        ok: true,
        raw,
        post: {
          path: 'inbox/redis', title: 'Redis', created: '', updated: '', tags: [], summary: '',
          size: raw.length, mtime: 2,
        },
      }), { status: 200 })
    })
    vi.stubGlobal('fetch', put)
    const restore = useHistoryRestore({
      tabs,
      fileChanges,
      confirm: vi.fn().mockResolvedValue(true),
      prepareEditorRestore: save.prepareHistoryRestore,
      refreshVault: vi.fn().mockResolvedValue(undefined),
      refreshComparison: vi.fn().mockResolvedValue(true),
      acquireMutation: () => () => {},
      restoreFile: vi.fn().mockReturnValue(response.promise),
      onSuccess: vi.fn(),
      onError: vi.fn(),
    })

    const restoring = restore.restore(source())
    await vi.waitFor(() => expect(restore.restoring.value).toBe(true))
    save.onEditorChange('inbox/redis', '# Temporary edit')
    save.onEditorChange('inbox/redis', '# Current')
    await vi.advanceTimersByTimeAsync(800)
    expect(put).not.toHaveBeenCalled()

    response.resolve({ path: 'inbox/redis.md', ref: 'revision-a', raw: '# Historical', mtime: 100 })
    await restoring
    expect(tabs.value[0]).toMatchObject({ raw: '# Current', originalRaw: '# Historical', saveStatus: 'dirty' })
    expect(tabs.value[0]!.revision).not.toBe(tabs.value[0]!.savedRevision)
    const beforeUnload = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent
    save.handleBeforeUnload(beforeUnload)
    expect(beforeUnload.defaultPrevented).toBe(true)
    await vi.advanceTimersByTimeAsync(800)
    expect(put).toHaveBeenCalledOnce()
    expect(JSON.parse(String(put.mock.calls[0]?.[1]?.body))).toEqual({
      raw: '# Current',
      baseRaw: '# Historical',
    })
  })

  it('allows manual save after restore when editing returned to the old baseline', async () => {
    const tabs = ref([tab({ raw: 'A', originalRaw: 'A', revision: 2, savedRevision: 2 })])
    const fileChanges = createVaultFileChanges()
    const put = vi.fn(async (_url: string, init?: RequestInit) => {
      const raw = (JSON.parse(String(init?.body)) as { raw: string }).raw
      return new Response(JSON.stringify({
        ok: true,
        raw,
        post: {
          path: 'inbox/redis', title: 'Redis', created: '', updated: '', tags: [], summary: '',
          size: raw.length, mtime: 2,
        },
      }), { status: 200 })
    })
    vi.stubGlobal('fetch', put)
    const save = useDocumentSave({
      tabs, activePath: ref('inbox/redis'),
      applyPostSummary: vi.fn(), fileChanges, toastError: vi.fn(),
    })
    const response = deferred<{ path: string; ref: string; raw: string; mtime: number }>()
    const restore = useHistoryRestore({
      tabs, fileChanges, confirm: vi.fn().mockResolvedValue(true),
      prepareEditorRestore: save.prepareHistoryRestore,
      refreshVault: vi.fn().mockResolvedValue(undefined),
      refreshComparison: vi.fn().mockResolvedValue(true),
      restoreFile: vi.fn().mockReturnValue(response.promise),
      onSuccess: vi.fn(), onError: vi.fn(),
    })
    const restoring = restore.restore(source({ historicalRaw: 'H' }))
    await vi.waitFor(() => expect(restore.restoring.value).toBe(true))
    save.onEditorChange('inbox/redis', 'B')
    save.onEditorChange('inbox/redis', 'A')
    response.resolve({ path: 'inbox/redis.md', ref: 'revision-a', raw: 'H', mtime: 100 })
    await restoring

    await save.doSaveNow()
    expect(put).toHaveBeenCalledOnce()
    expect(JSON.parse(String(put.mock.calls[0]?.[1]?.body))).toEqual({
      raw: 'A',
      baseRaw: 'H',
    })
  })

  it('does not restore a document locked by Create Version', async () => {
    const acquireMutation = vi.fn().mockReturnValue(null)
    const onConflict = vi.fn()
    const h = harness({ acquireMutation, onConflict })

    await expect(h.restore.restore(source())).resolves.toBe(false)

    expect(acquireMutation).toHaveBeenCalledWith(['inbox/redis.md'])
    expect(h.prepareEditorRestore).not.toHaveBeenCalled()
    expect(h.restoreFile).not.toHaveBeenCalled()
    expect(h.restore.error.value).toBe('Another change is in progress for this document. Try again shortly.')
    expect(onConflict).toHaveBeenCalledWith(expect.objectContaining({ documentPath: 'inbox/redis' }))
  })

  it('captures revision A even if the mutable viewer source changes before confirmation resolves', async () => {
    const answer = deferred<boolean>()
    const h = harness({ confirm: () => answer.promise })
    const selected = source()
    const operation = h.restore.restore(selected)
    selected.revisionId = 'revision-b'
    selected.historicalRaw = '# Revision B'
    answer.resolve(true)
    await operation

    expect(h.restoreFile).toHaveBeenCalledWith('inbox/redis.md', 'revision-a')
    expect(h.tabs.value[0]?.raw).toBe('# Historical')
  })

  it('does not treat loading or failed editor tabs as valid dirty current state', () => {
    const loading = harness({ tabs: [tab({ loading: true, raw: '', originalRaw: '' })] })
    const failed = harness({ tabs: [tab({ loading: false, loadError: 'HTTP 500' })] })

    expect(loading.restore.buildRequest(source()).currentDirty).toBe(false)
    expect(failed.restore.buildRequest(source()).currentDirty).toBe(false)
  })

  it('reports partial refresh failure without treating a completed restore as failed', async () => {
    const h = harness({
      refreshVault: vi.fn().mockRejectedValue(new Error('refresh failed')),
      refreshComparison: vi.fn().mockResolvedValue(false),
    })

    await expect(h.restore.restore(source())).resolves.toBe(true)

    expect(h.tabs.value[0]?.raw).toBe('# Historical')
    expect(h.onSuccess).toHaveBeenCalledWith(expect.any(Object), { refreshFailed: true })
    expect(h.onError).not.toHaveBeenCalled()
  })
})

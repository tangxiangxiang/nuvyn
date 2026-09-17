// @vitest-environment jsdom
import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../components/vault/tabs'
import * as api from '../../../lib/api'
import { createVaultFileChanges } from '../context/fileChanges'
import {
  createDraftStore,
  createMemoryDraftBackend,
} from '../draft-recovery/draftStore'
import type { DraftFileTransactionResult } from '../draft-recovery/useDraftFileTransactions'
import type { DraftBufferSnapshot } from '../draft-recovery/useUnsavedDraftPersistence'
import { createUnsavedDraftPersistence } from '../draft-recovery/useUnsavedDraftPersistence'
import { useDocumentSave } from '../editor-tabs/useDocumentSave'
import { createPathMutationLock } from '../pathMutationLock'
import {
  DocumentMutationConflictError,
  useDocumentLifecycle,
  type LifecycleOptions,
} from '../useDocumentLifecycle'

function tab(path = 'inbox/a', raw = 'saved'): Tab {
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

function saveResponse(raw: string): Response {
  return new Response(JSON.stringify({
    ok: true,
    raw,
    post: {
      path: 'inbox/a', title: 'A', created: '', updated: '', tags: [], summary: '',
      size: raw.length, mtime: 2,
    },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function setup(
  initialTabs: Tab[] = [tab()],
  applyReferenceWrites = vi.fn().mockResolvedValue(undefined),
  lifecycleExtras: Partial<LifecycleOptions> = {},
) {
  const tabs = ref(initialTabs)
  const activePath = ref(initialTabs[0]?.path ?? null)
  const fileChanges = createVaultFileChanges()
  const refresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const mutationLock = createPathMutationLock()
  const save = useDocumentSave({
    tabs,
    activePath,
    applyPostSummary: vi.fn(),
    fileChanges,
    toastError: vi.fn(),
  })
  const renamed: Array<{ from: string; to: string }> = []
  const removed: string[] = []
  const lifecycle = useDocumentLifecycle({
    fileChanges,
    mutationLock,
    prepareDocumentMutation: save.prepareDocumentMutation,
    getOpenDocumentPaths: () => tabs.value.map((item) => item.path),
    applyReferenceWrites,
    renameOpenDocuments(mappings) {
      renamed.push(...mappings)
      for (const mapping of mappings) {
        const current = tabs.value.find((item) => item.path === mapping.from)
        if (current) current.path = mapping.to
        if (activePath.value === mapping.from) activePath.value = mapping.to
      }
    },
    removeOpenDocuments(paths) {
      removed.push(...paths)
      tabs.value = tabs.value.filter((item) => !paths.includes(item.path))
      if (activePath.value && paths.includes(activePath.value)) activePath.value = tabs.value[0]?.path ?? null
    },
    refresh,
    ...lifecycleExtras,
  })
  return { tabs, activePath, fileChanges, refresh, save, lifecycle, mutationLock, renamed, removed }
}

beforeEach(() => vi.restoreAllMocks())
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useDocumentLifecycle rename', () => {
  it('commits a draft move with the actual suffixed server path after identity validation', async () => {
    vi.spyOn(api, 'patchPost').mockResolvedValue({
      path: 'archive/a-2', title: 'A', created: '', updated: '', tags: [], size: 1, mtime: 2,
    })
    const commitMoves = vi.fn().mockResolvedValue([{
      documentId: 'doc-a',
      oldPath: 'inbox/a',
      newPath: 'archive/a-2',
      status: 'moved',
    }])
    const rollback = vi.fn()
    let h!: ReturnType<typeof setup>
    const finalizeAfterTabMigration = vi.fn(() => {
      expect(h.tabs.value[0].path).toBe('archive/a-2')
      return Promise.resolve()
    })
    const resolveDocumentIdentity = vi.fn(async (path: string) => ({
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: path,
    }))
    h = setup([tab()], undefined, {
      resolveDocumentIdentity,
      prepareDraftFileMutation: vi.fn().mockResolvedValue({
        commitMoves,
        commitDeletes: vi.fn(),
        finalizeAfterTabMigration,
        rollback,
      }),
    })

    await h.lifecycle.renameFile('inbox/a', { targetPath: 'archive/a' })

    expect(commitMoves).toHaveBeenCalledWith([{
      vaultId: 'vault',
      documentId: 'doc-a',
      fromPath: 'inbox/a',
      toPath: 'archive/a-2',
    }])
    expect(rollback).not.toHaveBeenCalled()
    expect(finalizeAfterTabMigration).toHaveBeenCalledOnce()
  })

  it('keeps file success when draft migration reports a warning', async () => {
    vi.spyOn(api, 'patchPost').mockResolvedValue({
      path: 'inbox/b', title: 'B', created: '', updated: '', tags: [], size: 1, mtime: 2,
    })
    const warnings = vi.fn()
    const h = setup([tab()], undefined, {
      resolveDocumentIdentity: vi.fn(async (path: string) => ({
        vaultId: 'vault',
        documentId: 'doc-a',
        documentPath: path,
      })),
      prepareDraftFileMutation: vi.fn().mockResolvedValue({
        commitMoves: vi.fn().mockResolvedValue([{
          documentId: 'doc-a',
          oldPath: 'inbox/a',
          newPath: 'inbox/b',
          status: 'failed',
        }]),
        commitDeletes: vi.fn(),
        rollback: vi.fn(),
      }),
      warnDraftTransaction: warnings,
    })

    await expect(h.lifecycle.renameFile('inbox/a', { name: 'b' }))
      .resolves.toMatchObject({ path: 'inbox/b' })
    expect(h.tabs.value[0].path).toBe('inbox/b')
    expect(warnings).toHaveBeenCalledOnce()
  })

  it('pauses and preserves a path-matched draft when source identity cannot be resolved', async () => {
    vi.spyOn(api, 'patchPost').mockResolvedValue({
      path: 'inbox/b', title: 'B', created: '', updated: '', tags: [], size: 1, mtime: 2,
    })
    const unresolved = {
      vaultId: 'vault',
      documentId: 'draft-doc',
      documentPath: 'inbox/a',
    }
    const commitMoves = vi.fn().mockResolvedValue([])
    const finalizeAfterTabMigration = vi.fn()
    const warnings = vi.fn()
    const prepareDraftFileMutation = vi.fn().mockResolvedValue({
      commitMoves,
      commitDeletes: vi.fn(),
      finalizeAfterTabMigration,
      rollback: vi.fn(),
    })
    const h = setup([tab()], undefined, {
      resolveDocumentIdentity: vi.fn().mockResolvedValue(null),
      findDraftsByPaths: vi.fn().mockResolvedValue([unresolved]),
      prepareDraftFileMutation,
      warnDraftTransaction: warnings,
    })

    await h.lifecycle.renameFile('inbox/a', { name: 'b' })

    expect(prepareDraftFileMutation).toHaveBeenCalledWith([unresolved])
    // The actual server target is the new third argument: identity
    // mismatch passes the server target to the barrier so it can
    // quarantine the entry instead of preserving it on the old path.
    expect(commitMoves).toHaveBeenCalledWith([], [], [{
      vaultId: 'vault',
      documentId: 'draft-doc',
      fromPath: 'inbox/a',
      toPath: 'inbox/b',
    }])
    expect(h.tabs.value[0].path).toBe('inbox/b')
    expect(finalizeAfterTabMigration).toHaveBeenCalledOnce()
    expect(warnings).toHaveBeenCalledWith([
      expect.objectContaining({
        documentId: 'draft-doc',
        status: 'identity-mismatch',
      }),
    ])
  })

  it('keeps server success and finalizes the barrier when tab path migration throws', async () => {
    // The server rename has already succeeded by the time Tab
    // migration runs — throwing here must NOT cause the rename to
    // report failure, because the file has actually moved on disk.
    // The barrier must still finalize (so draft persistence isn't
    // permanently locked) and the rename event must still publish +
    // refresh.
    vi.spyOn(api, 'patchPost').mockResolvedValue({
      path: 'inbox/b', title: 'B', created: '', updated: '', tags: [], size: 1, mtime: 2,
    })
    const finalizeAfterTabMigration = vi.fn().mockResolvedValue(undefined)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = setup([tab()], undefined, {
      resolveDocumentIdentity: vi.fn(async (path: string) => ({
        vaultId: 'vault',
        documentId: 'doc-a',
        documentPath: path,
      })),
      prepareDraftFileMutation: vi.fn().mockResolvedValue({
        commitMoves: vi.fn().mockResolvedValue([]),
        commitDeletes: vi.fn(),
        finalizeAfterTabMigration,
        rollback: vi.fn(),
      }),
      renameOpenDocuments: vi.fn(() => {
        throw new Error('tab migration failed')
      }),
    })

    const result = await h.lifecycle.renameFile('inbox/a', { name: 'b' })
    // Server result returned even though Tab migration threw.
    expect(result.path).toBe('inbox/b')
    expect(finalizeAfterTabMigration).toHaveBeenCalledOnce()
    // Non-blocking warning was logged so the issue is still visible
    // in dev tools.
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('keeps server success when folder tab path migration throws (with draft barrier)', async () => {
    // Round-3 regression: previously the folder-rename path with a
    // draft barrier did NOT swallow Tab-migration throws, so the
    // rename event + reference writes + barrier commit + refresh
    // were skipped. The user saw 'rename failed' even though the
    // server had moved the folder.
    vi.spyOn(api, 'renameFolder').mockResolvedValue({
      path: 'renamed', moved: ['renamed/a'], updatedReferences: [],
    })
    const finalizeAfterTabMigration = vi.fn().mockResolvedValue(undefined)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = setup([tab('folder/a')], undefined, {
      resolveDocumentIdentity: vi.fn(async (path: string) => ({
        vaultId: 'vault',
        documentId: 'doc-a',
        documentPath: path,
      })),
      prepareDraftFileMutation: vi.fn().mockResolvedValue({
        commitMoves: vi.fn().mockResolvedValue([]),
        commitDeletes: vi.fn(),
        finalizeAfterTabMigration,
        rollback: vi.fn(),
      }),
      renameOpenDocuments: vi.fn(() => {
        throw new Error('folder tab migration failed')
      }),
    })

    const result = await h.lifecycle.renameFolder('folder', 'renamed', ['folder/a'])
    expect(result.path).toBe('renamed')
    expect(finalizeAfterTabMigration).toHaveBeenCalledOnce()
    // The folder rename event still publishes despite Tab migration throwing.
    const renameEvents = h.fileChanges.events.value.filter((event) => event.kind === 'rename')
    expect(renameEvents).toHaveLength(1)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('waits for an in-flight save before PATCH rename', async () => {
    let finishSave!: (response: Response) => void
    const pendingSave = new Promise<Response>((resolve) => { finishSave = resolve })
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(pendingSave))
    const patch = vi.spyOn(api, 'patchPost').mockResolvedValue({
      path: 'inbox/b', title: 'B', created: '', updated: '', tags: [], size: 1, mtime: 2,
    })
    const h = setup()
    h.save.onEditorChange('inbox/a', 'v1')
    const saving = h.save.doSave('inbox/a')
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())

    const renaming = h.lifecycle.renameFile('inbox/a', { name: 'b' })
    await Promise.resolve()
    expect(patch).not.toHaveBeenCalled()

    finishSave(saveResponse('v1'))
    await saving
    await renaming
    expect(patch).toHaveBeenCalledOnce()
    expect(h.tabs.value[0].path).toBe('inbox/b')
  })

  it('waits for in-flight saves in reference sources before rewriting backlinks', async () => {
    let finishSave!: (response: Response) => void
    const pendingSave = new Promise<Response>((resolve) => { finishSave = resolve })
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(pendingSave))
    const patch = vi.spyOn(api, 'patchPost').mockResolvedValue({
      path: 'inbox/b', title: 'B', created: '', updated: '', tags: [], size: 1, mtime: 2,
      updatedReferences: [{ path: 'refs/source', raw: 'rewritten', mtime: 10 }],
    })
    const h = setup([tab('inbox/a'), tab('refs/source')])
    h.save.onEditorChange('refs/source', 'editing backlink')
    const saving = h.save.doSave('refs/source')
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())

    const renaming = h.lifecycle.renameFile('inbox/a', { name: 'b', updateReferences: true }, ['refs/source'])
    await Promise.resolve()
    expect(patch).not.toHaveBeenCalled()

    finishSave(saveResponse('editing backlink'))
    await saving
    await renaming
    expect(patch).toHaveBeenCalledOnce()
  })

  it('keeps every open document save-locked until reference conflicts are resolved', async () => {
    vi.useFakeTimers()
    let finishPatch!: (value: api.PostSummary) => void
    const patchPending = new Promise<api.PostSummary>((resolve) => { finishPatch = resolve })
    let finishReferenceApply!: () => void
    const referenceApplyPending = new Promise<void>((resolve) => { finishReferenceApply = resolve })
    const applyReferenceWrites = vi.fn().mockReturnValue(referenceApplyPending)
    vi.spyOn(api, 'patchPost').mockReturnValue(patchPending)
    const puts: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const raw = (JSON.parse(String(init?.body)) as { raw: string }).raw
      puts.push(`${url}:${raw}`)
      return saveResponse(raw)
    }))
    const h = setup([tab('inbox/a'), tab('refs/previewed'), tab('refs/new')], applyReferenceWrites)
    const renaming = h.lifecycle.renameFile(
      'inbox/a',
      { name: 'b', updateReferences: true },
      ['refs/previewed'],
    )
    await Promise.resolve()

    // refs/new was absent from the preview set, but updateReferences uses a
    // global save barrier so a newly discovered backlink cannot race PATCH.
    h.save.onEditorChange('refs/new', 'new local edit')
    await vi.advanceTimersByTimeAsync(800)
    expect(puts).toEqual([])

    finishPatch({
      path: 'inbox/b', title: 'B', created: '', updated: '', tags: [], size: 1, mtime: 2,
      updatedReferences: [{ path: 'refs/new', raw: 'server rewritten', mtime: 11 }],
    })
    await vi.waitFor(() => expect(applyReferenceWrites).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(800)
    expect(puts).toEqual([])

    finishReferenceApply()
    await renaming
    await vi.advanceTimersByTimeAsync(800)
    expect(puts).toEqual(['/api/posts/refs/new:new local edit'])
  })

  it('cancels the old timer, preserves edits during PATCH, and saves only to the actual new path', async () => {
    vi.useFakeTimers()
    let finishRename!: (value: api.PostSummary) => void
    const pendingRename = new Promise<api.PostSummary>((resolve) => { finishRename = resolve })
    vi.spyOn(api, 'patchPost').mockReturnValue(pendingRename)
    const puts: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const raw = (JSON.parse(String(init?.body)) as { raw: string }).raw
      puts.push(`${url}:${raw}`)
      return saveResponse(raw)
    }))
    const h = setup()
    h.save.onEditorChange('inbox/a', 'v1')
    const renaming = h.lifecycle.renameFile('inbox/a', { targetPath: 'archive/a' })
    await Promise.resolve()
    h.save.onEditorChange('inbox/a', 'v2')
    await vi.advanceTimersByTimeAsync(800)
    expect(puts).toEqual([])

    finishRename({
      path: 'archive/a-2', title: 'A', created: '', updated: '', tags: [], size: 2, mtime: 2,
    })
    await renaming
    expect(h.tabs.value[0]).toMatchObject({ path: 'archive/a-2', raw: 'v2', revision: 2, savedRevision: 0 })
    await vi.advanceTimersByTimeAsync(800)
    expect(puts).toEqual(['/api/posts/archive/a-2:v2'])
    expect(h.tabs.value[0]).toMatchObject({ originalRaw: 'v2', savedRevision: 2, saveStatus: 'saved' })
    expect(h.fileChanges.events.value[0]).toMatchObject({
      oldPath: 'inbox/a', path: 'archive/a-2', kind: 'rename', source: 'editor-lifecycle',
    })
    expect(h.fileChanges.events.value[0]).not.toHaveProperty('newRaw')
  })

  it('rolls back a failed rename and resumes dirty autosave on the old path', async () => {
    vi.useFakeTimers()
    vi.spyOn(api, 'patchPost').mockRejectedValue(new Error('rename failed'))
    const puts: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const raw = (JSON.parse(String(init?.body)) as { raw: string }).raw
      puts.push(`${url}:${raw}`)
      return saveResponse(raw)
    }))
    const h = setup()
    h.save.onEditorChange('inbox/a', 'dirty')

    await expect(h.lifecycle.renameFile('inbox/a', { name: 'b' })).rejects.toThrow('rename failed')
    expect(h.tabs.value[0].path).toBe('inbox/a')
    expect(h.fileChanges.events.value).toEqual([])
    await vi.advanceTimersByTimeAsync(800)
    expect(puts).toEqual(['/api/posts/inbox/a:dirty'])
  })

  it('resumes a newly opened dirty tab when a global rename rolls back', async () => {
    vi.useFakeTimers()
    let rejectRename!: (error: Error) => void
    vi.spyOn(api, 'patchPost').mockReturnValue(new Promise((_, reject) => { rejectRename = reject }))
    const puts: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const raw = (JSON.parse(String(init?.body)) as { raw: string }).raw
      puts.push(`${url}:${raw}`)
      return saveResponse(raw)
    }))
    const h = setup([tab('inbox/a')])
    const renaming = h.lifecycle.renameFile('inbox/a', { name: 'b', updateReferences: true })
    await vi.waitFor(() => expect(api.patchPost).toHaveBeenCalledOnce())

    h.tabs.value.push(tab('inbox/c'))
    h.save.onEditorChange('inbox/c', 'new dirty content')
    await vi.advanceTimersByTimeAsync(800)
    expect(puts).toEqual([])

    rejectRename(new Error('rename failed'))
    await expect(renaming).rejects.toThrow('rename failed')
    await vi.advanceTimersByTimeAsync(800)
    expect(puts).toEqual(['/api/posts/inbox/c:new dirty content'])
  })

  it('publishes rename identity before deduplicated reference writes, including destination writes', async () => {
    vi.spyOn(api, 'patchPost').mockResolvedValue({
      path: 'inbox/b', title: 'B', created: '', updated: '', tags: [], size: 1, mtime: 2,
      updatedReferences: [
        { path: 'inbox/b', raw: 'self rewritten', mtime: 20 },
        { path: 'refs/c', raw: 'ref rewritten', mtime: 21 },
        { path: 'refs/c', raw: 'ref rewritten', mtime: 21 },
      ],
    })
    const h = setup()
    await h.lifecycle.renameFile('inbox/a', { name: 'b', updateReferences: true })
    expect(h.fileChanges.events.value.map(({ kind, path, newRaw }) => ({ kind, path, newRaw }))).toEqual([
      { kind: 'rename', path: 'inbox/b', newRaw: undefined },
      { kind: 'write', path: 'inbox/b', newRaw: 'self rewritten' },
      { kind: 'write', path: 'refs/c', newRaw: 'ref rewritten' },
    ])
  })
})

describe('useDocumentLifecycle folder and delete operations', () => {
  it('preserves drafts by default and uses explicit discard policy from FileTree', async () => {
    vi.spyOn(api, 'deletePost').mockResolvedValue({ ok: true })
    const commitDeletes = vi.fn().mockResolvedValue([])
    const h = setup([tab()], undefined, {
      resolveDocumentIdentity: vi.fn(async (path: string) => ({
        vaultId: 'vault',
        documentId: 'doc-a',
        documentPath: path,
      })),
      prepareDraftFileMutation: vi.fn().mockResolvedValue({
        commitMoves: vi.fn(),
        commitDeletes,
        rollback: vi.fn(),
      }),
    })
    await h.lifecycle.deleteFile('inbox/a')
    expect(commitDeletes).toHaveBeenLastCalledWith([expect.objectContaining({
      policy: 'preserve',
    })])

    const explicit = setup([tab()], undefined, {
      resolveDocumentIdentity: vi.fn(async (path: string) => ({
        vaultId: 'vault',
        documentId: 'doc-a',
        documentPath: path,
      })),
      prepareDraftFileMutation: vi.fn().mockResolvedValue({
        commitMoves: vi.fn(),
        commitDeletes,
        rollback: vi.fn(),
      }),
    })
    await explicit.lifecycle.deleteFile('inbox/a', {
      draftPolicy: 'discard-confirmed',
    })
    expect(commitDeletes).toHaveBeenLastCalledWith([expect.objectContaining({
      policy: 'discard-confirmed',
    })])
  })

  it('migrates every exact folder descendant and leaves prefix-similar paths alone', async () => {
    vi.spyOn(api, 'renameFolder').mockResolvedValue({
      path: 'renamed', moved: ['renamed/a', 'renamed/sub/b'], updatedReferences: [],
    })
    const h = setup([tab('folder/a'), tab('folder/sub/b'), tab('folderish/c')])
    h.activePath.value = 'folder/sub/b'
    await h.lifecycle.renameFolder('folder', 'renamed', ['folder/a', 'folder/sub/b'])
    expect(h.tabs.value.map((item) => item.path)).toEqual(['renamed/a', 'renamed/sub/b', 'folderish/c'])
    expect(h.activePath.value).toBe('renamed/sub/b')
    expect(h.fileChanges.events.value.filter((event) => event.kind === 'rename')).toHaveLength(2)
  })

  it('uses a global namespace lock for folder mutations and blocks concurrent create', async () => {
    let finishRename!: (value: { path: string; moved: string[]; updatedReferences: [] }) => void
    const pendingRename = new Promise<{ path: string; moved: string[]; updatedReferences: [] }>((resolve) => {
      finishRename = resolve
    })
    vi.spyOn(api, 'renameFolder').mockReturnValue(pendingRename)
    const create = vi.spyOn(api, 'createPost')
    const createFolder = vi.spyOn(api, 'createFolder')
    const h = setup([tab('folder/a')])

    const renaming = h.lifecycle.renameFolder('folder', 'renamed', ['folder/a'])
    await vi.waitFor(() => expect(api.renameFolder).toHaveBeenCalledOnce())
    await expect(h.lifecycle.createFile({ path: 'folder/new' }))
      .rejects.toBeInstanceOf(DocumentMutationConflictError)
    expect(create).not.toHaveBeenCalled()
    await expect(h.lifecycle.createFolder('folder/new-folder'))
      .rejects.toBeInstanceOf(DocumentMutationConflictError)
    expect(createFolder).not.toHaveBeenCalled()

    finishRename({ path: 'renamed', moved: ['renamed/a'], updatedReferences: [] })
    await renaming
  })

  it('waits for an in-flight save before delete, then closes and publishes once', async () => {
    let finishSave!: (response: Response) => void
    const pendingSave = new Promise<Response>((resolve) => { finishSave = resolve })
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(pendingSave))
    const remove = vi.spyOn(api, 'deletePost').mockResolvedValue({ ok: true })
    const h = setup()
    h.save.onEditorChange('inbox/a', 'v1')
    const saving = h.save.doSave('inbox/a')
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    const deleting = h.lifecycle.deleteFile('inbox/a')
    await Promise.resolve()
    expect(remove).not.toHaveBeenCalled()
    finishSave(saveResponse('v1'))
    await saving
    await deleting
    expect(h.tabs.value).toEqual([])
    expect(h.fileChanges.events.value.at(-1)).toMatchObject({
      path: 'inbox/a', kind: 'delete', source: 'editor-lifecycle',
    })
  })

  it('keeps the tab open when the draft handoff reports failed', async () => {
    // A failed conflict handoff means the local bytes never reached the
    // conflict store — the open editor tab is the only copy left. Closing
    // it here would permanently lose content the recovery system was
    // supposed to preserve, so the tab must survive the file delete.
    vi.spyOn(api, 'deletePost').mockResolvedValue({ ok: true })
    const warnings = vi.fn()
    const h = setup([tab()], undefined, {
      resolveDocumentIdentity: vi.fn(async (path: string) => ({
        vaultId: 'vault',
        documentId: 'doc-a',
        documentPath: path,
      })),
      prepareDraftFileMutation: vi.fn().mockResolvedValue({
        commitMoves: vi.fn(),
        commitDeletes: vi.fn().mockResolvedValue([{
          documentId: 'doc-a',
          oldPath: 'inbox/a',
          status: 'failed',
        }]),
        rollback: vi.fn(),
      }),
      warnDraftTransaction: warnings,
    })

    await h.lifecycle.deleteFile('inbox/a')
    expect(h.tabs.value.map((item) => item.path)).toEqual(['inbox/a'])
    expect(warnings).toHaveBeenCalledOnce()
  })

  it('still closes the tab when the draft handoff succeeds as a conflict', async () => {
    // Contrast for the guard above: a 'conflict' result means the local
    // bytes WERE preserved in the conflict store, so the tab no longer
    // holds the only copy and should close with the deleted file.
    vi.spyOn(api, 'deletePost').mockResolvedValue({ ok: true })
    const h = setup([tab()], undefined, {
      resolveDocumentIdentity: vi.fn(async (path: string) => ({
        vaultId: 'vault',
        documentId: 'doc-a',
        documentPath: path,
      })),
      prepareDraftFileMutation: vi.fn().mockResolvedValue({
        commitMoves: vi.fn(),
        commitDeletes: vi.fn().mockResolvedValue([{
          documentId: 'doc-a',
          oldPath: 'inbox/a',
          status: 'conflict',
        }]),
        rollback: vi.fn(),
      }),
      warnDraftTransaction: vi.fn(),
    })

    await h.lifecycle.deleteFile('inbox/a')
    expect(h.tabs.value).toEqual([])
  })

  it('closes only server-confirmed folder deletions', async () => {
    vi.spyOn(api, 'deleteFolder').mockResolvedValue({ deleted: ['folder/a', 'folder/sub/b'] })
    const h = setup([tab('folder/a'), tab('folder/sub/b'), tab('folderish/c')])
    await h.lifecycle.deleteFolder('folder', ['folder/a', 'folder/sub/b'])
    expect(h.tabs.value.map((item) => item.path)).toEqual(['folderish/c'])
    expect(h.fileChanges.events.value.map((event) => event.path)).toEqual(['folder/a', 'folder/sub/b'])
  })

  it('keeps only failed-handoff tabs open after folder delete', async () => {
    // One document's conflict handoff failed — its bytes live only in
    // the in-memory persistence entry, so its tab must survive the
    // folder delete. Its sibling deleted cleanly and closes; the
    // failure must not hold every sibling tab open (and the old
    // unconditional close would have lost the failed document's bytes).
    vi.spyOn(api, 'deleteFolder').mockResolvedValue({ deleted: ['folder/a', 'folder/b'] })
    const warnings = vi.fn()
    const h = setup([tab('folder/a'), tab('folder/b')], undefined, {
      resolveDocumentIdentity: vi.fn(async (path: string) => ({
        vaultId: 'vault',
        documentId: path === 'folder/a' ? 'doc-a' : 'doc-b',
        documentPath: path,
      })),
      prepareDraftFileMutation: vi.fn().mockResolvedValue({
        commitMoves: vi.fn(),
        commitDeletes: vi.fn().mockResolvedValue([
          { documentId: 'doc-a', oldPath: 'folder/a', status: 'failed' },
          { documentId: 'doc-b', oldPath: 'folder/b', status: 'deleted' },
        ]),
        rollback: vi.fn(),
      }),
      warnDraftTransaction: warnings,
    })

    await h.lifecycle.deleteFolder('folder', ['folder/a', 'folder/b'])
    expect(h.tabs.value.map((item) => item.path)).toEqual(['folder/a'])
    expect(h.removed).toEqual(['folder/b'])
    expect(warnings).toHaveBeenCalledOnce()
  })

  it('closes successfully preserved conflict tabs after folder delete', async () => {
    // Contrast for the guard above: a 'conflict' result means the bytes
    // WERE persisted as a conflict candidate (recoverable through the
    // Recovery panel), so the tab no longer holds the only copy and
    // closes with the folder delete.
    vi.spyOn(api, 'deleteFolder').mockResolvedValue({ deleted: ['folder/a'] })
    const h = setup([tab('folder/a')], undefined, {
      resolveDocumentIdentity: vi.fn(async (path: string) => ({
        vaultId: 'vault',
        documentId: 'doc-a',
        documentPath: path,
      })),
      prepareDraftFileMutation: vi.fn().mockResolvedValue({
        commitMoves: vi.fn(),
        commitDeletes: vi.fn().mockResolvedValue([
          { documentId: 'doc-a', oldPath: 'folder/a', status: 'conflict' },
        ]),
        rollback: vi.fn(),
      }),
      warnDraftTransaction: vi.fn(),
    })

    await h.lifecycle.deleteFolder('folder', ['folder/a'])
    expect(h.tabs.value).toEqual([])
  })

  it('rolls back delete failure and refresh failure does not roll back success', async () => {
    vi.useFakeTimers()
    const remove = vi.spyOn(api, 'deletePost').mockRejectedValueOnce(new Error('delete failed'))
      .mockResolvedValueOnce({ ok: true })
    const puts: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const raw = (JSON.parse(String(init?.body)) as { raw: string }).raw
      puts.push(`${url}:${raw}`)
      return saveResponse(raw)
    }))
    const h = setup()
    h.save.onEditorChange('inbox/a', 'dirty')
    await expect(h.lifecycle.deleteFile('inbox/a')).rejects.toThrow('delete failed')
    expect(h.tabs.value).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(800)
    expect(puts).toEqual(['/api/posts/inbox/a:dirty'])

    const clean = setup()
    clean.refresh.mockRejectedValueOnce(new Error('refresh failed'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await clean.lifecycle.deleteFile('inbox/a')
    expect(remove).toHaveBeenCalledTimes(2)
    expect(clean.tabs.value).toEqual([])
    expect(clean.fileChanges.events.value).toHaveLength(1)
  })

  it('does not call the API when the shared History mutation lock owns the path', async () => {
    const mutationLock = createPathMutationLock()
    const release = mutationLock.acquire(['inbox/a.md'])!
    const remove = vi.spyOn(api, 'deletePost')
    const h = setup()
    const lifecycle = useDocumentLifecycle({
      fileChanges: h.fileChanges,
      mutationLock,
      prepareDocumentMutation: h.save.prepareDocumentMutation,
      getOpenDocumentPaths: () => h.tabs.value.map((item) => item.path),
      applyReferenceWrites: vi.fn().mockResolvedValue(undefined),
      renameOpenDocuments: vi.fn(),
      removeOpenDocuments: vi.fn(),
      refresh: h.refresh,
    })
    await expect(lifecycle.deleteFile('inbox/a')).rejects.toBeInstanceOf(DocumentMutationConflictError)
    expect(remove).not.toHaveBeenCalled()
    release()
  })

  it('publishes create only after POST succeeds', async () => {
    const create = vi.spyOn(api, 'createPost')
      .mockResolvedValueOnce({ path: 'inbox/new', title: 'New', created: '', updated: '', tags: [], size: 1, mtime: 1 })
      .mockRejectedValueOnce(new Error('create failed'))
    const h = setup([])
    await h.lifecycle.createFile({ path: 'inbox/new', title: 'New' })
    expect(h.fileChanges.events.value[0]).toMatchObject({
      path: 'inbox/new', kind: 'write', source: 'editor-lifecycle',
    })
    expect(h.fileChanges.events.value[0]).not.toHaveProperty('newRaw')
    await expect(h.lifecycle.createFile({ path: 'inbox/fail' })).rejects.toThrow('create failed')
    expect(create).toHaveBeenCalledTimes(2)
    expect(h.fileChanges.events.value).toHaveLength(1)
  })

  it('creates folders through the shared lifecycle and keeps refresh best-effort', async () => {
    const create = vi.spyOn(api, 'createFolder').mockResolvedValue({ path: 'inbox/new-folder' })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = setup([])
    h.refresh.mockRejectedValueOnce(new Error('refresh failed'))

    await expect(h.lifecycle.createFolder('inbox/new-folder'))
      .resolves.toEqual({ path: 'inbox/new-folder' })
    expect(create).toHaveBeenCalledWith('inbox/new-folder')
  })

  it('resumes the autosave of a dirty document sharing the created folder path', async () => {
    vi.useFakeTimers()
    vi.spyOn(api, 'createFolder').mockResolvedValue({ path: 'inbox/notes' })
    const puts: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const raw = (JSON.parse(String(init?.body)) as { raw: string }).raw
      puts.push(`${url}:${raw}`)
      return saveResponse(raw)
    }))
    const h = setup([tab('inbox/notes')])

    h.save.onEditorChange('inbox/notes', 'dirty notes')
    await h.lifecycle.createFolder('inbox/notes')
    await vi.advanceTimersByTimeAsync(800)

    expect(puts).toEqual(['/api/posts/inbox/notes:dirty notes'])
  })

  it('keeps a successful create successful when refresh fails', async () => {
    vi.spyOn(api, 'createPost').mockResolvedValue({
      path: 'inbox/new', title: 'New', created: '', updated: '', tags: [], size: 1, mtime: 1,
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = setup([])
    h.refresh.mockRejectedValueOnce(new Error('refresh failed'))

    await expect(h.lifecycle.createFile({ path: 'inbox/new' })).resolves.toMatchObject({ path: 'inbox/new' })
    expect(h.fileChanges.events.value).toHaveLength(1)
  })
})

// The delete transaction releases every persistence entry when it
// reports, but the lifecycle still awaits Recovery synchronization
// (onDraftTransactionSettled) before closing tabs. An edit typed during
// that async window arms a fresh debounce that the tab close could
// outrun — if the write later failed, the bytes would exist nowhere
// visible. These tests drive the REAL persistence barrier through the
// lifecycle and simulate the window edit inside onDraftTransactionSettled.

describe('useDocumentLifecycle draft settlement window', () => {
  function draftSnapshot(
    content: string,
    documentPath: string,
    documentId: string,
    revision: number,
  ): DraftBufferSnapshot {
    return {
      vaultId: 'vault',
      documentId,
      documentPath,
      content,
      authoritativeContent: 'disk',
      baseContentHash: 'base-hash',
      baseModifiedAt: 10.5,
      revision,
      loaded: true,
    }
  }

  it('preserves an edit typed while recovery settlement is pending and arms no timer after close', async () => {
    vi.useFakeTimers()
    vi.spyOn(api, 'deletePost').mockResolvedValue({ ok: true })
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const persistence = createUnsavedDraftPersistence({
      store,
      debounceMs: 800,
      now: () => 10,
      targetWindow: undefined,
    })
    const saveDraft = vi.spyOn(store, 'saveDraft')
    const settled: string[][] = []
    let h!: ReturnType<typeof setup>
    h = setup([tab()], undefined, {
      resolveDocumentIdentity: vi.fn(async (path: string) => ({
        vaultId: 'vault',
        documentId: 'doc-a',
        documentPath: path,
      })),
      prepareDraftFileMutation: (identities) => persistence.prepareFileMutation(identities),
      onDraftTransactionSettled: vi.fn(async (results: readonly DraftFileTransactionResult[]) => {
        settled.push(results.map((result) => result.status))
        if (settled.length === 1) {
          // The first pass runs BEFORE any tab close — the window is
          // open. The transaction has already released the entry, so
          // this edit arms a fresh 800ms debounce, exactly like a user
          // typing while the Recovery panel refreshes.
          expect(h.removed).toEqual([])
          persistence.schedule(draftSnapshot('typed-during-settle', 'inbox/a', 'doc-a', 2))
        } else {
          // The second pass completes the Recovery sync AFTER the tab
          // closed — the successful settlement write reports
          // 'preserved' so the identity refreshes to the window edit.
          expect(h.removed).toEqual(['inbox/a'])
        }
      }),
    })
    // A dirty editor buffer exists at delete time.
    persistence.schedule(draftSnapshot('unsaved', 'inbox/a', 'doc-a', 1))

    await h.lifecycle.deleteFile('inbox/a')

    // First settlement reported the preserve; the successful finalize
    // write reports 'preserved' (never warns) and triggers the second
    // pass, which refreshes the Recovery identity to the window edit
    // instead of keeping the stale pre-window record.
    expect(settled).toEqual([['preserved'], ['preserved']])
    // The settlement-window edit was persisted BEFORE the tab closed —
    // the store holds it as the document's orphan recovery record.
    expect((await store.getDraft('vault', 'doc-a'))?.content).toBe('typed-during-settle')
    expect(h.removed).toEqual(['inbox/a'])
    expect(h.tabs.value).toEqual([])
    // After the tab closes, no draft timer may fire: the finalize gate
    // cleared the window timer. Advancing the clock produces no
    // further write.
    const writes = saveDraft.mock.calls.length
    expect(writes).toBe(2) // the preserve write + the finalize write
    await vi.advanceTimersByTimeAsync(2400)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    expect(saveDraft.mock.calls.length).toBe(writes)
    expect((await store.getDraft('vault', 'doc-a'))?.content).toBe('typed-during-settle')
    await persistence.dispose()
  })

  it('keeps the tab open when the final pre-close persistence fails', async () => {
    vi.useFakeTimers()
    vi.spyOn(api, 'deletePost').mockResolvedValue({ ok: true })
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const persistence = createUnsavedDraftPersistence({
      store,
      debounceMs: 800,
      now: () => 10,
      targetWindow: undefined,
    })
    const warnings = vi.fn()
    const settled: string[][] = []
    let h!: ReturnType<typeof setup>
    h = setup([tab()], undefined, {
      resolveDocumentIdentity: vi.fn(async (path: string) => ({
        vaultId: 'vault',
        documentId: 'doc-a',
        documentPath: path,
      })),
      prepareDraftFileMutation: (identities) => persistence.prepareFileMutation(identities),
      onDraftTransactionSettled: vi.fn(async (results: readonly DraftFileTransactionResult[]) => {
        settled.push(results.map((result) => result.status))
        if (settled.length === 1) {
          // Edit typed during settlement — and IndexedDB rejects the
          // pre-close write that must seal it.
          persistence.schedule(draftSnapshot('typed-during-settle', 'inbox/a', 'doc-a', 2))
          backend.failNext('save')
        }
      }),
      warnDraftTransaction: warnings,
    })

    await h.lifecycle.deleteFile('inbox/a')

    // The settlement-window write failed, so the edit is still only
    // in-memory: the tab must survive the file delete — it is the only
    // surface still holding those bytes.
    expect(h.tabs.value.map((item) => item.path)).toEqual(['inbox/a'])
    expect(h.removed).toEqual([])
    expect(persistence.findTrackedIdentitiesByPaths(['inbox/a'])).toEqual([{
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'inbox/a',
    }])
    // Two settlement passes ran: the preserve report, then the failed
    // finalize — and only the failure produced a user-visible warning.
    expect(settled).toEqual([['preserved'], ['failed']])
    expect(warnings).toHaveBeenCalledOnce()
    expect(warnings).toHaveBeenCalledWith([expect.objectContaining({
      documentId: 'doc-a',
      oldPath: 'inbox/a',
      status: 'failed',
    })])
    await persistence.dispose()
  })

  it('covers the settlement window for folder delete, per path', async () => {
    vi.useFakeTimers()
    vi.spyOn(api, 'deleteFolder').mockResolvedValue({ deleted: ['folder/a', 'folder/b'] })
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const persistence = createUnsavedDraftPersistence({
      store,
      debounceMs: 800,
      now: () => 10,
      targetWindow: undefined,
    })
    const warnings = vi.fn()
    let settled = false
    let h!: ReturnType<typeof setup>
    h = setup([tab('folder/a'), tab('folder/b')], undefined, {
      resolveDocumentIdentity: vi.fn(async (path: string) => ({
        vaultId: 'vault',
        documentId: path === 'folder/b' ? 'doc-b' : 'doc-a',
        documentPath: path,
      })),
      prepareDraftFileMutation: (identities) => persistence.prepareFileMutation(identities),
      onDraftTransactionSettled: vi.fn(async () => {
        if (!settled) {
          settled = true
          // An edit lands on folder/a during settlement, and its
          // pre-close write fails — folder/b stays clean.
          persistence.schedule(draftSnapshot('typed-during-settle', 'folder/a', 'doc-a', 2))
          backend.failNext('save')
        }
      }),
      warnDraftTransaction: warnings,
    })

    await h.lifecycle.deleteFolder('folder', ['folder/a', 'folder/b'])

    // One failed document must not hold its successfully deleted
    // sibling's tab open — and must not close its own.
    expect(h.tabs.value.map((item) => item.path)).toEqual(['folder/a'])
    expect(h.removed).toEqual(['folder/b'])
    expect(warnings).toHaveBeenCalledOnce()
    expect(warnings).toHaveBeenCalledWith([expect.objectContaining({
      documentId: 'doc-a',
      oldPath: 'folder/a',
      status: 'failed',
    })])
    await persistence.dispose()
  })

  it('reports failed when the post-tab-migration primary write fails', async () => {
    vi.spyOn(api, 'patchPost').mockResolvedValue({
      path: 'archive/a-2', title: 'A', created: '', updated: '', tags: [], size: 1, mtime: 2,
    })
    const warnings = vi.fn()
    const h = setup([tab()], undefined, {
      resolveDocumentIdentity: vi.fn(async (path: string) => ({
        vaultId: 'vault',
        documentId: 'doc-a',
        documentPath: path,
      })),
      prepareDraftFileMutation: vi.fn().mockResolvedValue({
        commitMoves: vi.fn().mockResolvedValue([{
          documentId: 'doc-a',
          oldPath: 'inbox/a',
          newPath: 'archive/a-2',
          status: 'moved',
        }]),
        commitDeletes: vi.fn(),
        // The immediate write of the transaction-time snapshot to the
        // actual new path was rejected by IndexedDB.
        finalizeAfterTabMigration: vi.fn().mockResolvedValue([{
          documentId: 'doc-a',
          oldPath: 'inbox/a',
          newPath: 'archive/a-2',
          status: 'failed',
        }]),
        rollback: vi.fn(),
      }),
      warnDraftTransaction: warnings,
    })

    const result = await h.lifecycle.renameFile('inbox/a', { targetPath: 'archive/a' })

    // The server rename stays successful — a draft write failure never
    // reverses it.
    expect(result.path).toBe('archive/a-2')
    // The tab keeps the actual server-suffixed path.
    expect(h.tabs.value[0].path).toBe('archive/a-2')
    // The finalize failure is merged into the reported transaction
    // results: a user-visible warning instead of silent success.
    expect(warnings).toHaveBeenCalledOnce()
    expect(warnings).toHaveBeenCalledWith([expect.objectContaining({
      documentId: 'doc-a',
      oldPath: 'inbox/a',
      newPath: 'archive/a-2',
      status: 'failed',
    })])
  })

  it('folder rename aggregates finalize write failures into the reported results', async () => {
    vi.spyOn(api, 'renameFolder').mockResolvedValue({
      path: 'renamed', moved: ['renamed/a', 'renamed/b'], updatedReferences: [],
    })
    const warnings = vi.fn()
    const h = setup([tab('folder/a'), tab('folder/b')], undefined, {
      resolveDocumentIdentity: vi.fn(async (path: string) => ({
        vaultId: 'vault',
        // Identity survives the rename: match by path suffix so both
        // 'folder/a' and 'renamed/a' resolve to the same documentId.
        documentId: path.endsWith('/a') ? 'doc-a' : 'doc-b',
        documentPath: path,
      })),
      prepareDraftFileMutation: vi.fn().mockResolvedValue({
        commitMoves: vi.fn().mockResolvedValue([
          { documentId: 'doc-a', oldPath: 'folder/a', newPath: 'renamed/a', status: 'moved' },
          { documentId: 'doc-b', oldPath: 'folder/b', newPath: 'renamed/b', status: 'moved' },
        ]),
        commitDeletes: vi.fn(),
        // One document's post-migration write failed; the other is
        // clean — the warning must name exactly the failed one.
        finalizeAfterTabMigration: vi.fn().mockResolvedValue([{
          documentId: 'doc-b',
          oldPath: 'folder/b',
          newPath: 'renamed/b',
          status: 'failed',
        }]),
        rollback: vi.fn(),
      }),
      warnDraftTransaction: warnings,
    })

    const result = await h.lifecycle.renameFolder('folder', 'renamed', ['folder/a', 'folder/b'])

    // The server folder rename stays successful and both tabs migrated.
    expect(result.path).toBe('renamed')
    expect(h.tabs.value.map((item) => item.path)).toEqual(['renamed/a', 'renamed/b'])
    expect(warnings).toHaveBeenCalledOnce()
    expect(warnings).toHaveBeenCalledWith([expect.objectContaining({
      documentId: 'doc-b',
      oldPath: 'folder/b',
      newPath: 'renamed/b',
      status: 'failed',
    })])
  })

  it('still reports finalize failures when single-file tab migration throws', async () => {
    vi.spyOn(api, 'patchPost').mockResolvedValue({
      path: 'archive/a-2', title: 'A', created: '', updated: '', tags: [], size: 1, mtime: 2,
    })
    const warnings = vi.fn()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = setup([tab()], undefined, {
      resolveDocumentIdentity: vi.fn(async (path: string) => ({
        vaultId: 'vault',
        documentId: 'doc-a',
        documentPath: path,
      })),
      prepareDraftFileMutation: vi.fn().mockResolvedValue({
        commitMoves: vi.fn().mockResolvedValue([{
          documentId: 'doc-a',
          oldPath: 'inbox/a',
          newPath: 'archive/a-2',
          status: 'moved',
        }]),
        commitDeletes: vi.fn(),
        // The post-migration write failed — previously the Tab
        // migration throw below escaped to the outer catch, skipped
        // reportDraftResults, and this failure never reached the user.
        finalizeAfterTabMigration: vi.fn().mockResolvedValue([{
          documentId: 'doc-a',
          oldPath: 'inbox/a',
          newPath: 'archive/a-2',
          status: 'failed',
        }]),
        rollback: vi.fn(),
      }),
      renameOpenDocuments: vi.fn(() => {
        throw new Error('tab migration failed')
      }),
      warnDraftTransaction: warnings,
    })

    const result = await h.lifecycle.renameFile('inbox/a', { targetPath: 'archive/a' })

    // The server rename stays successful despite the Tab migration
    // throw — and the finalize failure is still reported and warned,
    // matching the folder rename's internal-catch structure.
    expect(result.path).toBe('archive/a-2')
    expect(warnings).toHaveBeenCalledOnce()
    expect(warnings).toHaveBeenCalledWith([expect.objectContaining({
      documentId: 'doc-a',
      oldPath: 'inbox/a',
      newPath: 'archive/a-2',
      status: 'failed',
    })])
    warnSpy.mockRestore()
  })

  it('never splits the draft family when the user edits the tab after a failed family move', async () => {
    // server rename succeeds → draft family move fails → Tab becomes
    // the actual new path → user edits the renamed Tab → primary and
    // conflicts never split across paths. The failed move quarantines
    // the entry: the post-rename edit retries the atomic family move
    // BEFORE any primary write on the new path.
    vi.useFakeTimers()
    vi.spyOn(api, 'patchPost').mockResolvedValue({
      path: 'archive/a-2', title: 'A', created: '', updated: '', tags: [], size: 1, mtime: 2,
    })
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const persistence = createUnsavedDraftPersistence({
      store,
      debounceMs: 800,
      now: () => 10,
      targetWindow: undefined,
    })
    await store.saveDraft({
      version: 1,
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'inbox/a',
      content: 'primary',
      baseContentHash: 'base-hash',
      baseModifiedAt: 10.5,
      createdAt: 5,
      // Below this describe's persistence clock (now: () => 10) so the
      // post-rename edit's first buildDraft (updatedAt 10) wins the
      // store's strictly-newer CAS.
      updatedAt: 5,
    })
    await store.saveConflictDraft({
      version: 1,
      conflictId: 'conflict-a',
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'inbox/a',
      content: 'local orphan',
      baseContentHash: 'base-hash',
      baseModifiedAt: 10.5,
      createdAt: 5,
      updatedAt: 31,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 30,
      recordedAt: 31,
    })
    const warnings = vi.fn()
    const h = setup([tab()], undefined, {
      resolveDocumentIdentity: vi.fn(async (path: string) => ({
        vaultId: 'vault',
        documentId: 'doc-a',
        documentPath: path,
      })),
      prepareDraftFileMutation: (identities) => persistence.prepareFileMutation(identities),
      warnDraftTransaction: warnings,
    })

    // The server rename succeeds; the draft family move fails as a
    // unit and the user is warned once.
    backend.failNext('moveFamilyConflicts')
    await h.lifecycle.renameFile('inbox/a', { targetPath: 'archive/a' })
    expect(warnings).toHaveBeenCalledOnce()
    expect(warnings).toHaveBeenCalledWith([expect.objectContaining({
      documentId: 'doc-a',
      oldPath: 'inbox/a',
      newPath: 'archive/a-2',
      status: 'failed',
    })])
    // The lifecycle migrated the tab to the server's actual path while
    // the draft family stayed whole at the OLD path.
    expect(h.tabs.value[0].path).toBe('archive/a-2')
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      documentPath: 'inbox/a',
      content: 'primary',
    })
    expect((await store.listConflictDrafts('vault')).map((c) => c.documentPath))
      .toEqual(['inbox/a'])

    // The user edits the renamed tab. A plain primary write here would
    // move the primary alone to archive/a-2 (DraftStore accepts the
    // newer draft's path wholesale) and strand the conflict on inbox/a
    // — the quarantine routes the debounced write through the atomic
    // move retry instead, which now succeeds.
    persistence.schedule(draftSnapshot('after-rename', 'archive/a-2', 'doc-a', 2))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()

    // Primary and conflicts never split across paths: the retry united
    // the whole family at the tab's actual path.
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      documentPath: 'archive/a-2',
      content: 'after-rename',
    })
    expect((await store.listConflictDrafts('vault')).map((c) => c.documentPath))
      .toEqual(['archive/a-2'])
    await persistence.dispose()
  })
})

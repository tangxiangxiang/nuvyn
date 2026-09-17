// @vitest-environment jsdom
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../components/vault/tabs'
import type { PostSummary } from '../../../../lib/api'
import { createMemoryDraftBackend, createDraftStore } from '../../draft-recovery/draftStore'
import type { UnsavedDraft } from '../../draft-recovery/draftTypes'
import { createUnsavedDraftPersistence } from '../../draft-recovery/useUnsavedDraftPersistence'
import { createVaultFileChanges } from '../../context/fileChanges'
import { useDocumentSave } from '../useDocumentSave'

function tab(): Tab {
  return {
    path: 'inbox/a',
    documentId: 'document-a',
    title: 'A',
    raw: 'disk',
    originalRaw: 'disk',
    revision: 0,
    savedRevision: 0,
    savingRevision: null,
    saveStatus: 'idle',
    error: null,
    loadError: null,
    loading: false,
    serverMtime: 10,
    externalRaw: null,
  }
}

function response(raw: string): Response {
  const post: PostSummary = {
    path: 'inbox/a',
    title: 'A',
    created: '2026-01-01',
    updated: '2026-01-01',
    tags: [],
    size: raw.length,
    mtime: 20,
  }
  return new Response(JSON.stringify({ ok: true, raw, post }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}

function setup() {
  const current = tab()
  const store = createDraftStore({ backend: createMemoryDraftBackend() })
  const drafts = createUnsavedDraftPersistence({ store })
  const save = useDocumentSave({
    tabs: ref([current]),
    activePath: ref(current.path),
    applyPostSummary: vi.fn(),
    fileChanges: createVaultFileChanges(),
    toastError: vi.fn(),
    draftPersistence: drafts,
    draftVaultId: () => 'vault-1',
  })
  return { current, store, drafts, save }
}

function recoveredDraft(content = 'recovered unsaved content'): UnsavedDraft {
  return {
    version: 1,
    vaultId: 'vault-1',
    documentId: 'document-a',
    documentPath: 'inbox/a',
    content,
    baseContentHash: null,
    baseModifiedAt: 10,
    createdAt: 100,
    updatedAt: 100,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('useDocumentSave draft persistence wiring', () => {
  it('applies recovered content as dirty without scheduling a server save', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const h = setup()
    const draft = recoveredDraft()
    await h.store.saveDraft(draft)

    await expect(h.save.applyRecoveredDraft({
      draft,
      expectedDiskRaw: 'disk',
      expectedDiskMtime: 10,
    })).resolves.toEqual({ status: 'applied', path: 'inbox/a' })

    expect(h.current.raw).toBe('recovered unsaved content')
    expect(h.current.originalRaw).toBe('disk')
    expect(h.current.revision).toBe(1)
    expect(h.current.savedRevision).toBe(0)
    expect(h.current.saveStatus).toBe('dirty')
    expect((await h.store.getDraft('vault-1', 'document-a'))?.updatedAt).toBe(100)
    await vi.advanceTimersByTimeAsync(1_600)
    await h.drafts.flush('vault-1', 'document-a')
    expect(fetch).not.toHaveBeenCalled()
    expect((await h.store.getDraft('vault-1', 'document-a'))?.content)
      .toBe('recovered unsaved content')
    vi.useRealTimers()
  })

  it('does not apply or rewrite a draft changed before recovery adoption', async () => {
    const h = setup()
    const stale = recoveredDraft('v1')
    await h.store.saveDraft(stale)
    await h.store.saveDraft({ ...stale, content: 'v2', updatedAt: 101 })

    await expect(h.save.applyRecoveredDraft({
      draft: stale,
      expectedDiskRaw: 'disk',
      expectedDiskMtime: 10,
    })).resolves.toEqual({ status: 'stale' })

    expect(h.current.raw).toBe('disk')
    expect(await h.store.getDraft('vault-1', 'document-a')).toMatchObject({
      content: 'v2',
      updatedAt: 101,
    })
  })

  it('does not invalidate a newer draft owner when the tab changes after adoption', async () => {
    vi.useFakeTimers()
    const h = setup()
    const draft = recoveredDraft()
    await h.store.saveDraft(draft)
    const adopt = h.drafts.adoptRecoveredDraft.bind(h.drafts)
    const invalidateOwner = vi.spyOn(h.drafts, 'invalidateOwner')
    vi.spyOn(h.drafts, 'adoptRecoveredDraft').mockImplementation(async (...args) => {
      const owner = await adopt(...args)
      h.current.raw = 'new local edit'
      h.current.revision = 1
      h.drafts.schedule({
        vaultId: 'vault-1',
        documentId: 'document-a',
        documentPath: 'inbox/a',
        content: 'new local edit',
        authoritativeContent: 'disk',
        baseContentHash: null,
        baseModifiedAt: 10,
        revision: 1,
      })
      return owner
    })

    await expect(h.save.applyRecoveredDraft({
      draft,
      expectedDiskRaw: 'disk',
      expectedDiskMtime: 10,
    })).resolves.toEqual({ status: 'stale' })
    await vi.advanceTimersByTimeAsync(800)
    await h.drafts.flush('vault-1', 'document-a')

    expect(invalidateOwner).toHaveBeenCalledTimes(1)
    expect((await h.store.getDraft('vault-1', 'document-a'))?.content)
      .toBe('new local edit')
    vi.useRealTimers()
  })

  it('fails closed when the recovery target changed or is unsafe', async () => {
    const stale = setup()
    await expect(stale.save.applyRecoveredDraft({
      draft: recoveredDraft('draft'),
      expectedDiskRaw: 'other',
      expectedDiskMtime: 10,
    })).resolves.toEqual({ status: 'stale' })
    expect(stale.current.raw).toBe('disk')

    const dirty = setup()
    dirty.current.raw = 'local edit'
    dirty.current.revision = 1
    await expect(dirty.save.applyRecoveredDraft({
      draft: recoveredDraft('draft'),
      expectedDiskRaw: 'disk',
      expectedDiskMtime: 10,
    })).resolves.toEqual({ status: 'dirty' })

    const external = setup()
    external.current.saveStatus = 'external'
    external.current.externalRaw = 'changed disk'
    await expect(external.save.applyRecoveredDraft({
      draft: recoveredDraft('draft'),
      expectedDiskRaw: 'disk',
      expectedDiskMtime: 10,
    })).resolves.toEqual({ status: 'external' })
  })

  it('deletes the owned draft after the acknowledged revision stays clean', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response('edited')))
    const h = setup()
    h.save.onEditorChange(h.current.path, 'edited')
    await h.drafts.flush('vault-1', 'document-a')
    expect(await h.store.getDraft('vault-1', 'document-a')).not.toBeNull()

    await h.save.doSave(h.current.path)
    await flushPromises()

    expect(h.current.revision).toBe(h.current.savedRevision)
    expect(await h.store.getDraft('vault-1', 'document-a')).toBeNull()
  })

  it('preserves newer input when an older save succeeds', async () => {
    const pending = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(pending.promise))
    const h = setup()
    h.save.onEditorChange(h.current.path, 'sent')
    await h.drafts.flush('vault-1', 'document-a')

    const saving = h.save.doSave(h.current.path)
    h.save.onEditorChange(h.current.path, 'newer')
    pending.resolve(response('sent'))
    await saving
    await h.drafts.flush('vault-1', 'document-a')
    await flushPromises()

    expect(h.current.raw).toBe('newer')
    expect(h.current.revision).toBeGreaterThan(h.current.savedRevision)
    expect((await h.store.getDraft('vault-1', 'document-a'))?.content).toBe('newer')
  })

  it('keeps drafts after save failure and external conflict', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500 })))
    const failed = setup()
    failed.save.onEditorChange(failed.current.path, 'failed edit')
    await failed.drafts.flush('vault-1', 'document-a')
    await failed.save.doSave(failed.current.path)
    expect(await failed.store.getDraft('vault-1', 'document-a')).not.toBeNull()

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: 'document changed on disk',
      code: 'EDIT_CONFLICT',
      current: { raw: 'external', mtime: 30, size: 8 },
    }), { status: 409, headers: { 'content-type': 'application/json' } })))
    const conflict = setup()
    conflict.save.onEditorChange(conflict.current.path, 'local')
    await conflict.drafts.flush('vault-1', 'document-a')
    await conflict.save.doSave(conflict.current.path)
    expect(conflict.current.saveStatus).toBe('external')
    expect(await conflict.store.getDraft('vault-1', 'document-a')).not.toBeNull()
  })

  it('deletes on return to baseline and explicit discard, but not cancelled discard', async () => {
    const h = setup()
    h.save.onEditorChange(h.current.path, 'dirty')
    await h.drafts.flush('vault-1', 'document-a')

    h.save.onEditorChange(h.current.path, 'disk')
    await flushPromises()
    expect(await h.store.getDraft('vault-1', 'document-a')).toBeNull()

    h.save.onEditorChange(h.current.path, 'dirty again')
    await h.drafts.flush('vault-1', 'document-a')
    // Merely preparing/cancelling a close does not touch the draft.
    const barrier = await h.save.prepareDocumentClose([h.current.path])
    barrier.rollback()
    expect(await h.store.getDraft('vault-1', 'document-a')).not.toBeNull()

    await h.save.discardDocumentDrafts([h.current.path])
    expect(await h.store.getDraft('vault-1', 'document-a')).toBeNull()
  })

  it('skips unloaded tabs and tabs without stable document identity', async () => {
    const h = setup()
    h.current.loading = true
    h.save.onEditorChange(h.current.path, 'loading edit')
    await expect(h.drafts.flush('vault-1', 'document-a')).resolves.toBe(false)

    h.current.loading = false
    h.current.documentId = null
    h.save.onEditorChange(h.current.path, 'identity missing')
    await expect(h.drafts.flush('vault-1', 'document-a')).resolves.toBe(false)
  })
})

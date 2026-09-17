import { describe, expect, it, vi } from 'vitest'
import type { PostDetail } from '../../../../lib/api'
import {
  createDraftStore,
  createMemoryDraftBackend,
} from '../draftStore'
import {
  UNSAVED_DRAFT_VERSION,
  type DraftConflictRecord,
  type UnsavedDraft,
} from '../draftTypes'
import {
  createUnsavedDraftRecovery,
  hasUnsafeOpenDraftDocument,
} from '../useUnsavedDraftRecovery'

function draft(id: string, path = `notes/${id}`): UnsavedDraft {
  return {
    version: UNSAVED_DRAFT_VERSION,
    vaultId: 'vault',
    documentId: id,
    documentPath: path,
    content: `draft:${id}`,
    baseContentHash: null,
    baseModifiedAt: 10,
    createdAt: 1,
    updatedAt: 2,
  }
}

function post(id: string, path = `notes/${id}`): PostDetail {
  return {
    path,
    raw: `disk:${id}`,
    content: `disk:${id}`,
    frontmatter: {},
    metadata: {
      id,
      path,
      title: id,
      summary: '',
      tags: [],
      mood: null,
      createdAt: 1,
      updatedAt: 1,
    },
    size: 1,
    mtime: 10,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}

async function seededStore(...drafts: UnsavedDraft[]) {
  const store = createDraftStore({ backend: createMemoryDraftBackend() })
  await Promise.all(drafts.map((value) => store.saveDraft(value)))
  return store
}

describe('createUnsavedDraftRecovery', () => {
  it('discovers primary and local conflict candidates for the same document independently', async () => {
    const primary = draft('a')
    const store = await seededStore(primary)
    const conflict: DraftConflictRecord = {
      version: 1,
      conflictId: 'local-after-delete',
      vaultId: 'vault',
      documentId: 'a',
      documentPath: 'notes/a',
      content: 'local candidate',
      baseContentHash: null,
      baseModifiedAt: 10,
      createdAt: 1,
      updatedAt: 3,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 2,
      recordedAt: 3,
    }
    await store.saveConflictDraft(conflict)
    const recovery = createUnsavedDraftRecovery({
      store,
      loadPost: vi.fn().mockRejectedValue(
        Object.assign(new Error('gone'), { status: 404 }),
      ),
    })

    await recovery.discover('vault')

    expect(recovery.items.value).toHaveLength(2)
    expect(recovery.items.value.map((item) => ({
      source: item.source,
      content: item.draft.content,
      kind: item.decision?.kind,
    }))).toEqual([
      { source: 'primary', content: 'draft:a', kind: 'missing-source' },
      { source: 'conflict', content: 'local candidate', kind: 'missing-source' },
    ])
    expect(new Set(recovery.items.value.map((item) => item.recoveryId)).size).toBe(2)
  })

  it('upserts a newly orphaned draft into the current recovery session', async () => {
    const store = await seededStore()
    const recovery = createUnsavedDraftRecovery({
      store,
      loadPost: vi.fn().mockRejectedValue(
        Object.assign(new Error('gone'), { status: 404 }),
      ),
    })
    await recovery.discover('vault')
    await store.saveDraft(draft('orphan'))

    await recovery.refreshIdentity('vault', 'orphan')

    expect(recovery.items.value).toHaveLength(1)
    expect(recovery.items.value[0]).toMatchObject({
      draft: { documentId: 'orphan' },
      status: 'ready',
      decision: { kind: 'missing-source' },
    })
  })

  it('ignores an older identity refresh that finishes after a newer one', async () => {
    const original = draft('orphan')
    const updated = {
      ...original,
      content: 'new orphan content',
      updatedAt: original.updatedAt + 1,
    }
    const store = await seededStore(original)
    const originalGet = store.getDraft.bind(store)
    const staleRead = deferred<UnsavedDraft | null>()
    vi.spyOn(store, 'getDraft')
      .mockImplementationOnce(() => staleRead.promise)
      .mockImplementation((vaultId, documentId) => originalGet(vaultId, documentId))
    const recovery = createUnsavedDraftRecovery({
      store,
      loadPost: vi.fn().mockRejectedValue(
        Object.assign(new Error('gone'), { status: 404 }),
      ),
    })

    const olderRefresh = recovery.refreshIdentity('vault', 'orphan')
    await store.saveDraft(updated)
    await recovery.refreshIdentity('vault', 'orphan')
    staleRead.resolve(original)
    await olderRefresh

    expect(recovery.items.value[0]?.draft).toEqual(updated)
  })

  it('removes a settled draft identity from the current recovery session', async () => {
    const store = await seededStore(draft('a'))
    const recovery = createUnsavedDraftRecovery({
      store,
      loadPost: vi.fn().mockResolvedValue(post('a')),
    })
    await recovery.discover('vault')
    expect(recovery.items.value).toHaveLength(1)

    recovery.removeIdentity('vault', 'a')

    expect(recovery.items.value).toEqual([])
  })

  it('blocks discard while the matching document is dirty, saving, or external', () => {
    const clean = {
      documentId: 'a',
      raw: 'disk',
      originalRaw: 'disk',
      savingRevision: null,
      saveStatus: 'idle',
      externalRaw: null,
    }
    expect(hasUnsafeOpenDraftDocument([clean], 'a')).toBe(false)
    expect(hasUnsafeOpenDraftDocument([{ ...clean, raw: 'dirty' }], 'a')).toBe(true)
    expect(hasUnsafeOpenDraftDocument([{ ...clean, savingRevision: 2 }], 'a')).toBe(true)
    expect(hasUnsafeOpenDraftDocument([{
      ...clean,
      saveStatus: 'external',
      externalRaw: 'disk changed',
    }], 'a')).toBe(true)
  })

  it('discovers only the requested vault without deleting or opening documents', async () => {
    const store = await seededStore(draft('a'))
    await store.saveDraft({ ...draft('other'), vaultId: 'other-vault' })
    const loadPost = vi.fn(async (path: string) => post('a', path))
    const recovery = createUnsavedDraftRecovery({ store, loadPost })

    await recovery.discover('vault')

    expect(recovery.items.value).toHaveLength(1)
    expect(recovery.items.value[0]).toMatchObject({
      status: 'ready',
      decision: { kind: 'baseline-match' },
    })
    expect(loadPost).toHaveBeenCalledTimes(1)
    expect(await store.getDraft('vault', 'a')).not.toBeNull()
  })

  it('maps 404, read failures, and reused paths to safe decisions', async () => {
    const store = await seededStore(
      draft('missing'),
      draft('broken'),
      draft('old', 'notes/reused'),
    )
    const loadPost = vi.fn(async (path: string) => {
      if (path.endsWith('missing')) throw Object.assign(new Error('gone'), { status: 404 })
      if (path.endsWith('broken')) throw new Error('private')
      return post('replacement', path)
    })
    const recovery = createUnsavedDraftRecovery({ store, loadPost })

    await recovery.discover('vault')

    const kinds = Object.fromEntries(recovery.items.value.map((item) => [
      item.draft.documentId,
      item.decision?.kind,
    ]))
    expect(kinds).toEqual({
      broken: 'unknown',
      missing: 'missing-source',
      old: 'identity-mismatch',
    })
  })

  it('bounds classification concurrency', async () => {
    const drafts = Array.from({ length: 10 }, (_, index) => draft(`d${index}`))
    const store = await seededStore(...drafts)
    let active = 0
    let maximum = 0
    const gates = drafts.map(() => deferred<PostDetail>())
    const loadPost = vi.fn((path: string) => {
      const index = Number(path.slice(path.lastIndexOf('d') + 1))
      active += 1
      maximum = Math.max(maximum, active)
      return gates[index].promise.finally(() => { active -= 1 })
    })
    const recovery = createUnsavedDraftRecovery({ store, loadPost, concurrency: 4 })

    const discovering = recovery.discover('vault')
    await vi.waitFor(() => expect(loadPost).toHaveBeenCalledTimes(4))
    expect(maximum).toBe(4)
    for (let index = 0; index < gates.length; index += 1) {
      gates[index].resolve(post(`d${index}`))
      if (index + 4 < gates.length) {
        await vi.waitFor(() => expect(loadPost).toHaveBeenCalledTimes(index + 5))
      }
    }
    await discovering
    expect(maximum).toBe(4)
  })

  it('lets a new discovery replace stale classification results', async () => {
    const firstStore = await seededStore(draft('a'))
    const first = deferred<PostDetail>()
    const loadPost = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(post('a'))
    const recovery = createUnsavedDraftRecovery({ store: firstStore, loadPost })

    const stale = recovery.discover('vault')
    await vi.waitFor(() => expect(loadPost).toHaveBeenCalledTimes(1))
    const current = recovery.discover('vault')
    await vi.waitFor(() => expect(loadPost).toHaveBeenCalledTimes(2))
    await current
    first.resolve(post('replacement'))
    await stale

    expect(recovery.items.value[0]?.decision?.kind).toBe('baseline-match')
  })

  it('lets retry replace an older per-item request', async () => {
    const store = await seededStore(draft('a'))
    const first = deferred<PostDetail>()
    const loadPost = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(post('a'))
    const recovery = createUnsavedDraftRecovery({ store, loadPost })

    const discovering = recovery.discover('vault')
    await vi.waitFor(() => expect(recovery.items.value).toHaveLength(1))
    const id = recovery.items.value[0]!.recoveryId
    await recovery.retry(id)
    first.resolve(post('replacement'))
    await discovering

    expect(recovery.items.value[0]?.decision?.kind).toBe('baseline-match')
  })

  it('reloads the stored draft before retrying a recovery action', async () => {
    const store = await seededStore(draft('a'))
    const recovery = createUnsavedDraftRecovery({
      store,
      loadPost: async (path) => post('a', path),
    })
    await recovery.discover('vault')
    const id = recovery.items.value[0]!.recoveryId

    await store.saveDraft({
      ...draft('a'),
      content: 'newer draft',
      updatedAt: 3,
    })
    await recovery.retry(id)

    expect(recovery.items.value[0]?.draft).toMatchObject({
      content: 'newer draft',
      updatedAt: 3,
    })
  })

  it('clears an orphan decision and protects the item while retry classification is pending', async () => {
    const store = await seededStore(draft('a'))
    const pending = deferred<PostDetail>()
    const loadPost = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('gone'), { status: 404 }))
      .mockReturnValueOnce(pending.promise)
    const recovery = createUnsavedDraftRecovery({ store, loadPost })
    await recovery.discover('vault')
    const id = recovery.items.value[0]!.recoveryId
    expect(recovery.items.value[0]?.decision?.kind).toBe('missing-source')

    const retrying = recovery.retry(id)
    await vi.waitFor(() => expect(recovery.items.value[0]?.status).toBe('loading'))

    expect(recovery.items.value[0]?.decision).toBeNull()
    expect(recovery.classifyingRecoveryIds.value.has(id)).toBe(true)
    expect(recovery.classifyingIdentityIds.value.has(JSON.stringify(['vault', 'a']))).toBe(true)

    pending.resolve(post('a'))
    await retrying
    expect(recovery.items.value[0]?.decision?.kind).toBe('baseline-match')
    expect(recovery.classifyingRecoveryIds.value.has(id)).toBe(false)
  })

  it('protects identity refresh from Store read through disk classification', async () => {
    const store = await seededStore(draft('a'))
    const pending = deferred<PostDetail>()
    const loadPost = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('gone'), { status: 404 }))
      .mockReturnValueOnce(pending.promise)
    const recovery = createUnsavedDraftRecovery({ store, loadPost })
    await recovery.discover('vault')

    const refreshing = recovery.refreshIdentity('vault', 'a')
    await vi.waitFor(() => expect(recovery.items.value[0]?.status).toBe('loading'))
    expect(recovery.items.value[0]?.decision).toBeNull()
    expect(recovery.classifyingIdentityIds.value.has(JSON.stringify(['vault', 'a']))).toBe(true)

    pending.resolve(post('a'))
    await refreshing
    expect(recovery.items.value[0]?.decision?.kind).toBe('baseline-match')
  })

  it('fails closed when the stored draft disappears before retry', async () => {
    const store = await seededStore(draft('a'))
    const recovery = createUnsavedDraftRecovery({
      store,
      loadPost: async (path) => post('a', path),
    })
    await recovery.discover('vault')
    const id = recovery.items.value[0]!.recoveryId
    await store.deleteDraft('vault', 'a')

    await recovery.retry(id)

    expect(recovery.items.value[0]).toMatchObject({
      status: 'error',
      decision: null,
    })
  })

  it('ignores late work after dispose and dismisses only for the session', async () => {
    const store = await seededStore(draft('a'))
    const pending = deferred<PostDetail>()
    const recovery = createUnsavedDraftRecovery({
      store,
      loadPost: () => pending.promise,
    })
    const discovering = recovery.discover('vault')
    await vi.waitFor(() => expect(recovery.items.value).toHaveLength(1))
    const id = recovery.items.value[0]!.recoveryId
    recovery.dismissForSession(id)
    expect(recovery.items.value[0]?.status).toBe('dismissed')
    expect(await store.getDraft('vault', 'a')).not.toBeNull()

    recovery.dispose()
    pending.resolve(post('a'))
    await discovering
    expect(recovery.items.value[0]?.status).toBe('dismissed')
  })

  it('keeps Later dismissed across a full discovery in the same session', async () => {
    const store = await seededStore(draft('a'))
    const recovery = createUnsavedDraftRecovery({ store, loadPost: async () => post('a') })
    await recovery.discover('vault')
    const id = recovery.items.value[0]!.recoveryId
    recovery.dismissForSession(id)

    await recovery.discover('vault')

    expect(recovery.items.value[0]?.status).toBe('ready')
    expect(recovery.pendingItem.value).toBeNull()
  })

  it('keeps a safe baseline match out of the exceptional prompt queue', async () => {
    const store = await seededStore(draft('a'))
    const recovery = createUnsavedDraftRecovery({ store, loadPost: async () => post('a') })

    await recovery.discover('vault')

    expect(recovery.items.value[0]?.decision?.kind).toBe('baseline-match')
    expect(recovery.pendingItem.value).toBeNull()
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDraftStore,
  createMemoryDraftBackend,
  type DraftStore,
} from '../draftStore'
import {
  createUnsavedDraftPersistence,
  type DraftBufferSnapshot,
} from '../useUnsavedDraftPersistence'
import type { UnsavedDraft } from '../draftTypes'
import { MAX_DRAFT_CONTENT_BYTES } from '../draftCleanup'

function snapshot(
  documentId: string,
  content: string,
  revision = 1,
): DraftBufferSnapshot {
  return {
    vaultId: 'vault-1',
    documentId,
    documentPath: `notes/${documentId}`,
    content,
    authoritativeContent: 'disk',
    baseContentHash: 'baseline-hash',
    baseModifiedAt: 10,
    revision,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe('createUnsavedDraftPersistence', () => {
  let store: DraftStore

  beforeEach(() => {
    vi.useFakeTimers()
    store = createDraftStore({ backend: createMemoryDraftBackend() })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('reports a durable transition flush and exposes pending work read-only', async () => {
    const persistence = createUnsavedDraftPersistence({ store })
    persistence.schedule(snapshot('flush', 'pending'))
    expect(persistence.hasPendingWrites()).toBe(true)

    await expect(persistence.flushAll()).resolves.toBe(true)
    expect(persistence.hasPendingWrites()).toBe(false)
    expect((await store.getDraft('vault-1', 'flush'))?.content).toBe('pending')
  })

  it('reports a failed transition flush without discarding the pending channel', async () => {
    const failingStore: DraftStore = {
      ...store,
      saveDraft: vi.fn().mockRejectedValue(new Error('storage unavailable')),
    }
    const persistence = createUnsavedDraftPersistence({ store: failingStore })
    persistence.schedule(snapshot('failed', 'pending'))

    await expect(persistence.flushAll()).resolves.toBe(false)
    expect(persistence.hasPendingWrites()).toBe(true)
  })

  it('debounces each document independently and snapshots input synchronously', async () => {
    const persistence = createUnsavedDraftPersistence({ store, now: () => 100 })
    const a = snapshot('a', 'a1')
    persistence.schedule(a)
    a.content = 'mutated after schedule'
    vi.advanceTimersByTime(400)
    persistence.schedule(snapshot('a', 'a2', 2))
    persistence.schedule(snapshot('b', 'b1'))

    await vi.advanceTimersByTimeAsync(400)
    expect(await store.getDraft('vault-1', 'a')).toBeNull()
    expect(await store.getDraft('vault-1', 'b')).toBeNull()

    await vi.advanceTimersByTimeAsync(400)
    expect((await store.getDraft('vault-1', 'a'))?.content).toBe('a2')
    expect((await store.getDraft('vault-1', 'b'))?.content).toBe('b1')
  })

  it('persists drafts with fractional filesystem mtime', async () => {
    const persistence = createUnsavedDraftPersistence({ store })
    persistence.schedule({
      ...snapshot('a', 'dirty'),
      baseModifiedAt: 1_721_234_567_890.625,
    })

    await vi.advanceTimersByTimeAsync(800)

    expect((await store.getDraft('vault-1', 'a'))?.baseModifiedAt)
      .toBe(1_721_234_567_890.625)
  })

  it('does not let an old pending write recreate a discarded draft', async () => {
    const write = deferred<import('../draftStore').DraftSaveOutcome>()
    const saveDraft = vi.fn()
      .mockImplementationOnce(() => write.promise)
      .mockResolvedValue({ status: 'saved', stored: { ...snapshot('a', 'old') } as unknown as UnsavedDraft })
    const persistence = createUnsavedDraftPersistence({
      store: { ...store, saveDraft },
    })

    const owner = persistence.schedule(snapshot('a', 'old'))!
    await vi.advanceTimersByTimeAsync(800)
    const discarded = persistence.discard(owner)
    write.resolve({ status: 'saved', stored: { ...snapshot('a', 'old') } as unknown as UnsavedDraft })
    await discarded

    expect(await store.getDraft('vault-1', 'a')).toBeNull()
    expect(saveDraft).toHaveBeenCalledTimes(1)
  })

  it('markClean waits for an in-flight draft write and deletes the exact result', async () => {
    const write = deferred<void>()
    const saveDraft = vi.fn(async (draft: UnsavedDraft) => {
      await write.promise
      return store.saveDraft(draft)
    })
    const persistence = createUnsavedDraftPersistence({
      store: { ...store, saveDraft },
    })

    const owner = persistence.schedule(snapshot('a', 'dirty'))!
    await vi.advanceTimersByTimeAsync(800)
    const clean = persistence.markClean(owner, 1)

    write.resolve()
    await clean

    expect(await store.getDraft('vault-1', 'a')).toBeNull()
  })

  it('returnedToBaseline waits for an in-flight draft write', async () => {
    const write = deferred<void>()
    const saveDraft = vi.fn(async (draft: UnsavedDraft) => {
      await write.promise
      return store.saveDraft(draft)
    })
    const persistence = createUnsavedDraftPersistence({
      store: { ...store, saveDraft },
    })

    persistence.schedule(snapshot('a', 'dirty'))
    await vi.advanceTimersByTimeAsync(800)
    const returned = persistence.returnedToBaseline('vault-1', 'a')

    write.resolve()
    await returned

    expect(await store.getDraft('vault-1', 'a')).toBeNull()
  })

  it('discard waits for an in-flight draft write', async () => {
    const write = deferred<void>()
    const saveDraft = vi.fn(async (draft: UnsavedDraft) => {
      await write.promise
      return store.saveDraft(draft)
    })
    const persistence = createUnsavedDraftPersistence({
      store: { ...store, saveDraft },
    })

    const owner = persistence.schedule(snapshot('a', 'dirty'))!
    await vi.advanceTimersByTimeAsync(800)
    const discarded = persistence.discard(owner)

    write.resolve()
    await expect(discarded).resolves.toBe(true)
    expect(await store.getDraft('vault-1', 'a')).toBeNull()
  })

  it('aborts cleanup when a new schedule appears while waiting for a write', async () => {
    const write = deferred<void>()
    const saveDraft = vi.fn()
      .mockImplementationOnce(async (draft: UnsavedDraft) => {
        await write.promise
        return store.saveDraft(draft)
      })
      .mockImplementation((draft: UnsavedDraft) => store.saveDraft(draft))
    const persistence = createUnsavedDraftPersistence({
      store: { ...store, saveDraft },
    })

    const owner = persistence.schedule(snapshot('a', 'old', 1))!
    await vi.advanceTimersByTimeAsync(800)
    const clean = persistence.markClean(owner, 1)
    persistence.schedule(snapshot('a', 'new', 2))

    write.resolve()
    await clean
    await vi.advanceTimersByTimeAsync(800)
    await persistence.flush('vault-1', 'a')

    expect((await store.getDraft('vault-1', 'a'))?.content).toBe('new')
  })

  it('does not let a clean deletion remove a newer scheduled generation', async () => {
    const oldWrite = deferred<import('../draftStore').DraftSaveOutcome>()
    const saveDraft = vi.fn()
      .mockImplementationOnce(() => oldWrite.promise)
      .mockImplementation((draft) => store.saveDraft(draft))
    const persistence = createUnsavedDraftPersistence({
      store: { ...store, saveDraft },
    })

    const owner = persistence.schedule(snapshot('a', 'old', 1))!
    await vi.advanceTimersByTimeAsync(800)
    const clean = persistence.markClean(owner, 1)
    persistence.schedule(snapshot('a', 'new', 2))
    await vi.advanceTimersByTimeAsync(800)

    oldWrite.resolve({ status: 'saved', stored: { ...snapshot('a', 'old') } as unknown as UnsavedDraft })
    await clean
    await persistence.flush('vault-1', 'a')

    expect((await store.getDraft('vault-1', 'a'))?.content).toBe('new')
  })

  it('serializes a reopened document write after discard deletion', async () => {
    const deletion = deferred<{ status: 'deleted' }>()
    const deleteDraftIfUnchanged = vi.fn().mockReturnValue(deletion.promise)
    const persistence = createUnsavedDraftPersistence({
      store: { ...store, deleteDraftIfUnchanged },
    })

    const owner = persistence.schedule(snapshot('a', 'old', 1))!
    await persistence.flush('vault-1', 'a')
    const discarded = persistence.discard(owner)
    persistence.schedule(snapshot('a', 'reopened', 1))
    await vi.advanceTimersByTimeAsync(800)

    expect((await store.getDraft('vault-1', 'a'))?.content).toBe('old')
    deletion.resolve({ status: 'deleted' })
    await discarded
    await persistence.flush('vault-1', 'a')

    expect((await store.getDraft('vault-1', 'a'))?.content).toBe('reopened')
  })

  it('does not discard a newer stored draft through an older recovery snapshot', async () => {
    const persistence = createUnsavedDraftPersistence({ store, debounceMs: 0 })
    persistence.schedule(snapshot('a', 'v1', 1))
    await vi.runAllTimersAsync()
    const original = (await store.getDraft('vault-1', 'a'))!

    persistence.schedule(snapshot('a', 'v2', 2))
    await vi.runAllTimersAsync()

    await expect(persistence.discardIdentityIfUnchanged(original)).resolves.toBe(false)
    expect((await store.getDraft('vault-1', 'a'))?.content).toBe('v2')
  })

  it('adopts an existing recovery draft without changing its timestamp', async () => {
    const expected: UnsavedDraft = {
      version: 1,
      vaultId: 'vault-1',
      documentId: 'a',
      documentPath: 'notes/a',
      content: 'recovered',
      baseContentHash: 'baseline-hash',
      baseModifiedAt: 10,
      createdAt: 25,
      updatedAt: 40,
    }
    await store.saveDraft(expected)
    const saveDraft = vi.spyOn(store, 'saveDraft')
    const persistence = createUnsavedDraftPersistence({ store })

    await expect(
      persistence.adoptRecoveredDraft(expected, snapshot('a', 'recovered', 1)),
    ).resolves.toMatchObject({
      vaultId: 'vault-1',
      documentId: 'a',
    })

    expect(saveDraft).not.toHaveBeenCalled()
    expect(await store.getDraft('vault-1', 'a')).toEqual(expected)
  })

  it('does not adopt a recovery draft updated by another context', async () => {
    const expected: UnsavedDraft = {
      version: 1,
      vaultId: 'vault-1',
      documentId: 'a',
      documentPath: 'notes/a',
      content: 'v1',
      baseContentHash: 'baseline-hash',
      baseModifiedAt: 10,
      createdAt: 25,
      updatedAt: 40,
    }
    await store.saveDraft(expected)
    await store.saveDraft({ ...expected, content: 'v2', updatedAt: 41 })
    const persistence = createUnsavedDraftPersistence({ store })

    await expect(
      persistence.adoptRecoveredDraft(expected, snapshot('a', 'v1', 1)),
    ).resolves.toBeNull()
    expect((await store.getDraft('vault-1', 'a'))?.content).toBe('v2')
  })

  it('preserves a local draft scheduled while recovery adoption is reading storage', async () => {
    const expected: UnsavedDraft = {
      version: 1,
      vaultId: 'vault-1',
      documentId: 'a',
      documentPath: 'notes/a',
      content: 'recovered',
      baseContentHash: 'baseline-hash',
      baseModifiedAt: 10,
      createdAt: 25,
      updatedAt: 40,
    }
    await store.saveDraft(expected)
    const read = deferred<UnsavedDraft | null>()
    const getDraft = vi.fn()
      .mockReturnValueOnce(read.promise)
      .mockImplementation((vaultId, documentId) =>
        store.getDraft(vaultId, documentId))
    const persistence = createUnsavedDraftPersistence({
      store: { ...store, getDraft },
    })

    const adoption = persistence.adoptRecoveredDraft(
      expected,
      snapshot('a', 'recovered', 1),
    )
    persistence.schedule(snapshot('a', 'new local edit', 2))
    read.resolve(expected)

    await expect(adoption).resolves.toBeNull()
    await vi.advanceTimersByTimeAsync(800)

    expect((await store.getDraft('vault-1', 'a'))?.content).toBe('new local edit')
  })

  it('does not invalidate a newer owner when rolling back an adoption owner', async () => {
    const expected: UnsavedDraft = {
      version: 1,
      vaultId: 'vault-1',
      documentId: 'a',
      documentPath: 'notes/a',
      content: 'recovered',
      baseContentHash: 'baseline-hash',
      baseModifiedAt: 10,
      createdAt: 25,
      updatedAt: 40,
    }
    await store.saveDraft(expected)
    const persistence = createUnsavedDraftPersistence({ store })
    const adoptedOwner = await persistence.adoptRecoveredDraft(
      expected,
      snapshot('a', 'recovered', 1),
    )
    expect(adoptedOwner).not.toBeNull()

    persistence.schedule(snapshot('a', 'new local edit', 2))
    persistence.invalidateOwner(adoptedOwner!)
    await vi.advanceTimersByTimeAsync(800)

    expect((await store.getDraft('vault-1', 'a'))?.content).toBe('new local edit')
  })

  it('safely discards by identity and does not delete a newer generation', async () => {
    const deletion = deferred<{ status: 'deleted' }>()
    const deleteDraft = vi.fn().mockReturnValue(deletion.promise)
    const persistence = createUnsavedDraftPersistence({
      store: { ...store, deleteDraft },
    })

    persistence.schedule(snapshot('a', 'old', 1))
    await persistence.flush('vault-1', 'a')
    const discarded = persistence.discardIdentity('vault-1', 'a')
    persistence.schedule(snapshot('a', 'new', 2))
    await vi.advanceTimersByTimeAsync(800)

    deletion.resolve({ status: 'deleted' })
    await discarded
    await persistence.flush('vault-1', 'a')

    expect((await store.getDraft('vault-1', 'a'))?.content).toBe('new')
  })

  it('isolates a reopened document from work owned by the closed tab', async () => {
    const persistence = createUnsavedDraftPersistence({ store })
    persistence.schedule(snapshot('a', 'old'))
    persistence.invalidate('vault-1', 'a')
    persistence.schedule(snapshot('a', 'new', 1))

    await vi.advanceTimersByTimeAsync(800)
    expect((await store.getDraft('vault-1', 'a'))?.content).toBe('new')
  })

  it('releases conflict-channel protection after the owner is invalidated', async () => {
    await store.saveDraft({
      version: 1,
      vaultId: 'vault-1',
      documentId: 'a',
      documentPath: 'notes/a',
      content: 'other context',
      baseContentHash: null,
      baseModifiedAt: null,
      createdAt: 100,
      updatedAt: 100,
    })
    const persistence = createUnsavedDraftPersistence({ store, now: () => 10 })
    persistence.schedule(snapshot('a', 'local candidate', 1))
    await persistence.flush('vault-1', 'a')
    expect(await store.listConflictDrafts('vault-1')).toHaveLength(1)
    expect(persistence.getDraftCleanupProtection('vault-1').identityIds)
      .toContain(JSON.stringify(['vault-1', 'a']))

    persistence.invalidate('vault-1', 'a')

    expect(persistence.getDraftCleanupProtection('vault-1').identityIds)
      .not.toContain(JSON.stringify(['vault-1', 'a']))
    expect(await store.listConflictDrafts('vault-1')).toHaveLength(1)
  })

  it('does not let a stale asynchronous baseline hash write for a new owner', async () => {
    const firstHash = deferred<ArrayBuffer>()
    const digest = vi.fn()
      .mockReturnValueOnce(firstHash.promise)
      .mockResolvedValueOnce(new Uint8Array([2]).buffer)
    vi.stubGlobal('crypto', { subtle: { digest } })
    const persistence = createUnsavedDraftPersistence({ store })

    persistence.schedule({ ...snapshot('a', 'old'), baseContentHash: null })
    await vi.advanceTimersByTimeAsync(800)
    persistence.schedule({
      ...snapshot('a', 'new', 2),
      baseContentHash: null,
      authoritativeContent: 'new baseline',
    })
    firstHash.resolve(new Uint8Array([1]).buffer)
    await persistence.flush('vault-1', 'a')

    const draft = await store.getDraft('vault-1', 'a')
    expect(draft?.content).toBe('new')
    expect(draft?.baseContentHash).toBe('02')
  })

  it('deletes only a clean acknowledged revision owned by the current generation', async () => {
    const persistence = createUnsavedDraftPersistence({ store })
    const first = persistence.schedule(snapshot('a', 'v1', 1))!
    await persistence.flush('vault-1', 'a')

    const second = persistence.schedule(snapshot('a', 'v2', 2))!
    await persistence.markClean(first, 1)
    expect((await store.getDraft('vault-1', 'a'))?.content).toBe('v1')

    await persistence.flush('vault-1', 'a')
    await persistence.markClean(second, 1)
    expect(await store.getDraft('vault-1', 'a')).not.toBeNull()

    await persistence.markClean(second, 2)
    expect(await store.getDraft('vault-1', 'a')).toBeNull()
  })

  it('keeps a newer cross-context draft when an older owner becomes clean', async () => {
    const persistence = createUnsavedDraftPersistence({ store, now: () => 100 })
    const owner = persistence.schedule(snapshot('a', 'local v1', 1))!
    await persistence.flush('vault-1', 'a')
    const local = (await store.getDraft('vault-1', 'a'))!
    await store.saveDraft({
      ...local,
      content: 'other context v2',
      updatedAt: local.updatedAt + 1,
    })

    await persistence.markClean(owner, 1)

    expect(await store.getDraft('vault-1', 'a')).toMatchObject({
      content: 'other context v2',
      updatedAt: local.updatedAt + 1,
    })
  })

  it('keeps a newer cross-context draft when local content returns to baseline', async () => {
    const persistence = createUnsavedDraftPersistence({ store, now: () => 100 })
    persistence.schedule(snapshot('a', 'local v1', 1))
    await persistence.flush('vault-1', 'a')
    const local = (await store.getDraft('vault-1', 'a'))!
    await store.saveDraft({
      ...local,
      content: 'other context v2',
      updatedAt: local.updatedAt + 1,
    })

    await persistence.returnedToBaseline('vault-1', 'a')

    expect((await store.getDraft('vault-1', 'a'))?.content)
      .toBe('other context v2')
  })

  it('keeps a newer cross-context draft when an older tab is discarded', async () => {
    const persistence = createUnsavedDraftPersistence({ store, now: () => 100 })
    const owner = persistence.schedule(snapshot('a', 'local v1', 1))!
    await persistence.flush('vault-1', 'a')
    const local = (await store.getDraft('vault-1', 'a'))!
    await store.saveDraft({
      ...local,
      content: 'other context v2',
      updatedAt: local.updatedAt + 1,
    })

    await expect(persistence.discard(owner)).resolves.toBe(false)
    expect((await store.getDraft('vault-1', 'a'))?.content)
      .toBe('other context v2')
  })

  it('conditionally deletes the exact adopted recovery record after save', async () => {
    const expected: UnsavedDraft = {
      version: 1,
      vaultId: 'vault-1',
      documentId: 'a',
      documentPath: 'notes/a',
      content: 'recovered',
      baseContentHash: 'baseline-hash',
      baseModifiedAt: 10,
      createdAt: 25,
      updatedAt: 40,
    }
    await store.saveDraft(expected)
    const persistence = createUnsavedDraftPersistence({ store })
    const owner = await persistence.adoptRecoveredDraft(
      expected,
      snapshot('a', 'recovered', 1),
    )

    expect(owner).not.toBeNull()
    await persistence.markClean(owner!, 1)
    expect(await store.getDraft('vault-1', 'a')).toBeNull()
  })

  it('cancels and deletes when content returns to the authoritative baseline', async () => {
    const persistence = createUnsavedDraftPersistence({ store })
    persistence.schedule(snapshot('a', 'dirty'))
    await persistence.flush('vault-1', 'a')

    await persistence.returnedToBaseline('vault-1', 'a')
    await vi.advanceTimersByTimeAsync(800)
    expect(await store.getDraft('vault-1', 'a')).toBeNull()
  })

  it('treats deleted and missing discard outcomes as success without throwing', async () => {
    const persistence = createUnsavedDraftPersistence({ store })
    const owner = persistence.schedule(snapshot('a', 'dirty'))!
    await persistence.flush('vault-1', 'a')
    await expect(persistence.discard(owner)).resolves.toBe(true)

    const nextOwner = persistence.schedule(snapshot('a', 'again', 2))!
    await persistence.flush('vault-1', 'a')
    await store.deleteDraft('vault-1', 'a')
    await expect(persistence.discard(nextOwner)).resolves.toBe(true)
  })

  it('flushes only the latest dirty snapshot once during idempotent dispose', async () => {
    const saveDraft = vi.spyOn(store, 'saveDraft')
    const persistence = createUnsavedDraftPersistence({ store })
    persistence.schedule(snapshot('a', 'a1'))
    persistence.schedule(snapshot('a', 'a2', 2))
    persistence.schedule(snapshot('b', 'b1'))
    await persistence.returnedToBaseline('vault-1', 'b')

    await persistence.dispose()
    await persistence.dispose()

    expect(saveDraft).toHaveBeenCalledTimes(1)
    expect((await store.getDraft('vault-1', 'a'))?.content).toBe('a2')
    expect(await store.getDraft('vault-1', 'b')).toBeNull()
  })

  it('contains save, delete, and rejected store failures and retries later input', async () => {
    const saveDraft = vi.fn()
      .mockRejectedValueOnce(new Error('write failed'))
      .mockResolvedValueOnce({ status: 'saved', stored: { ...snapshot('a', 'v2', 2) } as unknown as UnsavedDraft })
    const deleteDraftIfUnchanged = vi.fn()
      .mockRejectedValue(new Error('delete failed'))
    const persistence = createUnsavedDraftPersistence({
      store: { ...store, saveDraft, deleteDraftIfUnchanged },
    })

    persistence.schedule(snapshot('a', 'v1'))
    await vi.advanceTimersByTimeAsync(800)
    const owner = persistence.schedule(snapshot('a', 'v2', 2))!
    await vi.advanceTimersByTimeAsync(800)
    await expect(persistence.discard(owner)).resolves.toBe(false)

    expect(saveDraft).toHaveBeenCalledTimes(2)
  })

  it('reports a write failure once per revision without blocking later input', async () => {
    const issues: Array<{ kind: string; revision?: number }> = []
    const saveDraft = vi.fn()
      .mockResolvedValueOnce({ status: 'failed' })
      .mockResolvedValueOnce({
        status: 'saved',
        stored: { ...snapshot('a', 'v2', 2), version: 1, createdAt: 1, updatedAt: 2 } as unknown as UnsavedDraft,
      })
    const persistence = createUnsavedDraftPersistence({
      store: { ...store, saveDraft },
      onIssue: (issue) => issues.push(issue),
    })

    persistence.schedule(snapshot('a', 'v1', 1))
    await vi.advanceTimersByTimeAsync(800)
    await persistence.flush('vault-1', 'a')
    expect(issues).toEqual([{ kind: 'storage-write-failed', revision: 1,
      vaultId: 'vault-1', documentId: 'a' }])

    persistence.schedule(snapshot('a', 'v2', 2))
    await vi.advanceTimersByTimeAsync(800)
    expect(saveDraft).toHaveBeenCalledTimes(2)
  })

  it('does not schedule snapshots with unavailable identity or unloaded documents', async () => {
    const saveDraft = vi.spyOn(store, 'saveDraft')
    const persistence = createUnsavedDraftPersistence({ store })

    expect(persistence.schedule({ ...snapshot('a', 'x'), vaultId: '' })).toBeNull()
    expect(persistence.schedule({ ...snapshot('a', 'x'), documentId: '' })).toBeNull()
    expect(persistence.schedule({ ...snapshot('a', 'x'), loaded: false })).toBeNull()

    await vi.advanceTimersByTimeAsync(800)
    expect(saveDraft).not.toHaveBeenCalled()
  })

  it('fails closed for an oversized revision and retries once content fits', async () => {
    const issues: unknown[] = []
    const persistence = createUnsavedDraftPersistence({
      store,
      onIssue: (issue) => issues.push(issue),
    })
    const oversized = 'x'.repeat(MAX_DRAFT_CONTENT_BYTES + 1)

    persistence.schedule(snapshot('a', oversized, 1))
    await vi.advanceTimersByTimeAsync(800)
    await persistence.flush('vault-1', 'a')
    expect(await store.getDraft('vault-1', 'a')).toBeNull()
    expect(issues).toHaveLength(1)

    // Repeating the same revision does not produce warning spam.
    await persistence.flush('vault-1', 'a')
    expect(issues).toHaveLength(1)

    persistence.schedule(snapshot('a', 'fits again', 2))
    await vi.advanceTimersByTimeAsync(800)
    expect((await store.getDraft('vault-1', 'a'))?.content).toBe('fits again')
  })

  it('fails closed when a document timestamp reaches MAX_SAFE_INTEGER', async () => {
    const persistence = createUnsavedDraftPersistence({
      store,
      now: () => Number.MAX_SAFE_INTEGER,
    })
    persistence.schedule(snapshot('a', 'v1'))
    await vi.advanceTimersByTimeAsync(800)
    persistence.schedule(snapshot('a', 'v2', 2))
    await vi.advanceTimersByTimeAsync(800)

    const draft = await store.getDraft('vault-1', 'a')
    expect(draft?.createdAt).toBe(Number.MAX_SAFE_INTEGER)
    expect(draft?.updatedAt).toBe(Number.MAX_SAFE_INTEGER)
    expect(draft?.content).toBe('v1')
  })

  it('registers one pagehide listener and removes it on dispose', async () => {
    const targetWindow = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }
    const persistence = createUnsavedDraftPersistence({ store, targetWindow })

    expect(targetWindow.addEventListener).toHaveBeenCalledOnce()
    expect(targetWindow.addEventListener).toHaveBeenCalledWith(
      'pagehide',
      expect.any(Function),
    )
    await persistence.dispose()
    expect(targetWindow.removeEventListener).toHaveBeenCalledOnce()
    expect(targetWindow.removeEventListener).toHaveBeenCalledWith(
      'pagehide',
      expect.any(Function),
    )
  })
})

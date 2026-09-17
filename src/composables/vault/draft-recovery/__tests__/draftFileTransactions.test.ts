import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDraftStore,
  createMemoryDraftBackend,
  type DraftStore,
} from '../draftStore'
import type { DraftConflictRecord, UnsavedDraft } from '../draftTypes'
import {
  createUnsavedDraftPersistence,
  type DraftBufferSnapshot,
} from '../useUnsavedDraftPersistence'
import { createUnsavedDraftRecovery } from '../useUnsavedDraftRecovery'
import { createDraftRecoveryManagement } from '../useDraftRecoveryManagement'

function snapshot(
  content: string,
  documentPath = 'notes/a',
  revision = 1,
): DraftBufferSnapshot {
  return {
    vaultId: 'vault',
    documentId: 'doc-a',
    documentPath,
    content,
    authoritativeContent: 'disk',
    baseContentHash: 'base-hash',
    baseModifiedAt: 10.5,
    revision,
    loaded: true,
  }
}

function draft(
  content: string,
  documentPath = 'notes/a',
  updatedAt = 10,
): UnsavedDraft {
  return {
    version: 1,
    vaultId: 'vault',
    documentId: 'doc-a',
    documentPath,
    content,
    baseContentHash: 'base-hash',
    baseModifiedAt: 10.5,
    createdAt: 5,
    updatedAt,
  }
}

describe('draft file transaction integration', () => {
  it('protects a Store-only closed document while its file barrier is active', async () => {
    const store = createDraftStore({ backend: createMemoryDraftBackend() })
    await store.saveDraft(draft('stored-only'))
    const persistence = createUnsavedDraftPersistence({ store, targetWindow: undefined })
    const identity = { vaultId: 'vault', documentId: 'doc-a', documentPath: 'notes/a' }

    const barrier = await persistence.prepareFileMutation([identity])

    expect(persistence.getDraftCleanupProtection('vault').identityIds)
      .toContain(JSON.stringify(['vault', 'doc-a']))
    const recovery = createUnsavedDraftRecovery({
      store,
      loadPost: async () => { throw Object.assign(new Error('missing'), { status: 404 }) },
    })
    const management = createDraftRecoveryManagement({
      store,
      recovery,
      getPersistenceProtection: (vaultId) => persistence.getDraftCleanupProtection(vaultId),
      now: () => 31 * 24 * 60 * 60 * 1000,
    })
    await recovery.discover('vault')
    await management.refresh('vault')
    const cleanup = await management.cleanupNow()
    expect(cleanup.skippedProtected).toHaveLength(1)
    expect(await store.getDraft('vault', 'doc-a')).not.toBeNull()

    await barrier.rollback()
    expect(persistence.getDraftCleanupProtection('vault').identityIds)
      .not.toContain(JSON.stringify(['vault', 'doc-a']))
  })

  it('discards an unpersisted debounce snapshot captured at confirmation', async () => {
    vi.useFakeTimers()
    const store = createDraftStore({ backend: createMemoryDraftBackend() })
    const persistence = createUnsavedDraftPersistence({
      store,
      debounceMs: 800,
      now: () => 10,
      targetWindow: undefined,
    })
    const identity = {
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'notes/a',
    }
    persistence.schedule(snapshot('confirmed'))
    const confirmation = persistence.captureDeleteConfirmation(identity, 1)
    const barrier = await persistence.prepareFileMutation([identity])

    const [result] = await barrier.commitDeletes([{
      ...identity,
      policy: 'discard-confirmed',
      confirmation,
    }])
    vi.advanceTimersByTime(800)

    expect(result.status).toBe('missing')
    expect(await store.getDraft('vault', 'doc-a')).toBeNull()
    expect(persistence.findTrackedIdentitiesByPaths(['notes/a'])).toEqual([])
    expect(persistence.captureDeleteConfirmation(identity, 1)).toMatchObject({
      expectedDraft: null,
      expectedSnapshot: null,
    })
    await persistence.dispose()
    vi.useRealTimers()
  })

  it('discards a confirmation-time pending write after it completes', async () => {
    vi.useFakeTimers()
    const store = createDraftStore({ backend: createMemoryDraftBackend() })
    const originalSave = store.saveDraft.bind(store)
    let releaseSave!: () => void
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve
    })
    vi.spyOn(store, 'saveDraft').mockImplementation(async (value) => {
      await saveGate
      return originalSave(value)
    })
    const persistence = createUnsavedDraftPersistence({
      store,
      debounceMs: 800,
      now: () => 10,
      targetWindow: undefined,
    })
    const identity = {
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'notes/a',
    }
    persistence.schedule(snapshot('confirmed'))
    const confirmation = persistence.captureDeleteConfirmation(identity, 1)
    vi.advanceTimersByTime(800)
    const preparing = persistence.prepareFileMutation([identity])
    releaseSave()
    const barrier = await preparing
    const [result] = await barrier.commitDeletes([{
      ...identity,
      policy: 'discard-confirmed',
      confirmation,
    }])

    expect(result.status).toBe('deleted')
    expect(await store.getDraft('vault', 'doc-a')).toBeNull()
    await persistence.dispose()
    vi.useRealTimers()
  })

  it('rolls a confirmation snapshot back when the server delete fails', async () => {
    vi.useFakeTimers()
    const store = createDraftStore({ backend: createMemoryDraftBackend() })
    const persistence = createUnsavedDraftPersistence({
      store,
      debounceMs: 800,
      now: () => 10,
      targetWindow: undefined,
    })
    const identity = {
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'notes/a',
    }
    persistence.schedule(snapshot('confirmed'))
    persistence.captureDeleteConfirmation(identity, 1)
    const barrier = await persistence.prepareFileMutation([identity])

    await barrier.rollback()
    await vi.advanceTimersByTimeAsync(800)

    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      documentPath: 'notes/a',
      content: 'confirmed',
    })
    await persistence.dispose()
    vi.useRealTimers()
  })

  it('prefers the coordinator-owned draft over a stale recovery snapshot', async () => {
    const store = createDraftStore({ backend: createMemoryDraftBackend() })
    const stale = draft('stale', 'notes/a', 10)
    const current = draft('current', 'notes/a', 20)
    await store.saveDraft(current)
    const persistence = createUnsavedDraftPersistence({
      store,
      targetWindow: undefined,
    })
    await persistence.adoptRecoveredDraft(current, snapshot('current'))
    const confirmation = persistence.captureDeleteConfirmation({
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'notes/a',
    }, 1, stale)

    expect(confirmation.expectedDraft).toEqual(current)
    await persistence.dispose()
  })

  it('holds edits during a move and writes only the actual server path', async () => {
    vi.useFakeTimers()
    const store = createDraftStore({ backend: createMemoryDraftBackend() })
    const persistence = createUnsavedDraftPersistence({
      store,
      debounceMs: 800,
      now: () => 20,
      targetWindow: undefined,
    })

    persistence.schedule(snapshot('before'))
    const barrier = await persistence.prepareFileMutation([{
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'notes/a',
    }])
    persistence.schedule(snapshot('during-1', 'notes/a', 2))
    persistence.schedule(snapshot('during-2', 'notes/a', 3))

    await vi.advanceTimersByTimeAsync(1_600)
    expect(await store.getDraft('vault', 'doc-a')).toBeNull()

    const [result] = await barrier.commitMoves([{
      vaultId: 'vault',
      documentId: 'doc-a',
      fromPath: 'notes/a',
      toPath: 'archive/a-2',
    }])
    await barrier.finalizeAfterTabMigration()

    expect(result.status).toBe('missing')
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      documentPath: 'archive/a-2',
      content: 'during-2',
    })
    await persistence.dispose()
    vi.useRealTimers()
  })

  it('moves an exact persisted draft without changing its timestamps or baseline', async () => {
    const store = createDraftStore({ backend: createMemoryDraftBackend() })
    const original = draft('unsaved')
    await store.saveDraft(original)
    const persistence = createUnsavedDraftPersistence({
      store,
      targetWindow: undefined,
    })
    const barrier = await persistence.prepareFileMutation([{
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'notes/a',
    }])
    const [result] = await barrier.commitMoves([{
      vaultId: 'vault',
      documentId: 'doc-a',
      fromPath: 'notes/a',
      toPath: 'archive/a-2',
    }])

    expect(result.status).toBe('moved')
    expect(await store.getDraft('vault', 'doc-a')).toEqual({
      ...original,
      documentPath: 'archive/a-2',
    })
    await persistence.dispose()
  })

  it('rolls edits captured during a failed rename back to the old path', async () => {
    vi.useFakeTimers()
    const store = createDraftStore({ backend: createMemoryDraftBackend() })
    const persistence = createUnsavedDraftPersistence({
      store,
      debounceMs: 800,
      now: () => 20,
      targetWindow: undefined,
    })

    const barrier = await persistence.prepareFileMutation([{
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'notes/a',
    }])
    persistence.schedule(snapshot('latest', 'notes/a', 2))
    await barrier.rollback()
    await vi.advanceTimersByTimeAsync(800)

    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      documentPath: 'notes/a',
      content: 'latest',
    })
    await persistence.dispose()
    vi.useRealTimers()
  })

  it('preserves by default and conditionally deletes only the confirmed draft', async () => {
    const store = createDraftStore({ backend: createMemoryDraftBackend() })
    const original = draft('confirmed')
    await store.saveDraft(original)
    const persistence = createUnsavedDraftPersistence({
      store,
      targetWindow: undefined,
    })
    await persistence.adoptRecoveredDraft(original, snapshot('confirmed'))

    const preserved = await persistence.prepareFileMutation([{
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'notes/a',
    }])
    expect((await preserved.commitDeletes([{
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'notes/a',
      policy: 'preserve',
    }]))[0].status).toBe('preserved')
    expect(await store.getDraft('vault', 'doc-a')).toEqual(original)

    const discarded = await persistence.prepareFileMutation([{
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'notes/a',
    }])
    const confirmation = persistence.captureDeleteConfirmation({
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'notes/a',
    }, 1)
    expect((await discarded.commitDeletes([{
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'notes/a',
      policy: 'discard-confirmed',
      confirmation,
    }]))[0].status).toBe('deleted')
    expect(await store.getDraft('vault', 'doc-a')).toBeNull()
    await persistence.dispose()
  })

  it('preserves edits created after delete confirmation', async () => {
    const store = createDraftStore({ backend: createMemoryDraftBackend() })
    const persistence = createUnsavedDraftPersistence({
      store,
      debounceMs: 0,
      now: () => 30,
      targetWindow: undefined,
    })
    const owner = persistence.schedule(snapshot('confirmed', 'notes/a', 1))!
    await persistence.flush('vault', 'doc-a')
    const identity = {
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'notes/a',
    }
    const confirmation = persistence.captureDeleteConfirmation(identity, 1)
    const barrier = await persistence.prepareFileMutation([identity])

    persistence.schedule(snapshot('after-confirmation', 'notes/a', 2))
    const [result] = await barrier.commitDeletes([{
      ...identity,
      policy: 'discard-confirmed',
      confirmation,
    }])

    expect(owner.generation).toBe(1)
    expect(result.status).toBe('stale')
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      content: 'after-confirmation',
      documentPath: 'notes/a',
    })
    await persistence.dispose()
  })

  it('keeps move scheduling paused until the tab path migration is finalized', async () => {
    const store = createDraftStore({ backend: createMemoryDraftBackend() })
    const persistence = createUnsavedDraftPersistence({
      store,
      debounceMs: 0,
      now: () => 40,
      targetWindow: undefined,
    })
    const identity = {
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'notes/a',
    }
    const barrier = await persistence.prepareFileMutation([identity])
    await barrier.commitMoves([{
      ...identity,
      fromPath: 'notes/a',
      toPath: 'archive/a-2',
    }])

    // The UI can still emit an old-path snapshot until its tab migration.
    persistence.schedule(snapshot('during-report-gap', 'notes/a', 2))
    expect(await store.getDraft('vault', 'doc-a')).toBeNull()

    await barrier.finalizeAfterTabMigration()
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      content: 'during-report-gap',
      documentPath: 'archive/a-2',
    })
    await persistence.dispose()
  })

  it('persists transaction-time edits at the old path when identity is preserved', async () => {
    const store = createDraftStore({ backend: createMemoryDraftBackend() })
    const persistence = createUnsavedDraftPersistence({
      store,
      debounceMs: 0,
      now: () => 50,
      targetWindow: undefined,
    })
    const identity = {
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'notes/a',
    }
    const barrier = await persistence.prepareFileMutation([identity])
    persistence.schedule(snapshot('orphan-latest', 'notes/a', 2))

    await barrier.commitMoves([], [identity])
    await barrier.finalizeAfterTabMigration()

    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      content: 'orphan-latest',
      documentPath: 'notes/a',
    })
    await persistence.dispose()
  })

  it('keeps a newer cross-context draft after delete confirmation', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    await store.saveDraft(draft('confirmed', 'notes/a', 10))
    const persistence = createUnsavedDraftPersistence({
      store,
      targetWindow: undefined,
    })
    const barrier = await persistence.prepareFileMutation([{
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'notes/a',
    }])
    await store.saveDraft(draft('newer', 'notes/a', 11))

    const [result] = await barrier.commitDeletes([{
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'notes/a',
      policy: 'discard-confirmed',
    }])

    expect(result.status).toBe('stale')
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      content: 'newer',
    })
    await persistence.dispose()
  })

  it('preserves and persists edits made after delete confirmation', async () => {
    const store = createDraftStore({ backend: createMemoryDraftBackend() })
    await store.saveDraft(draft('confirmed'))
    const persistence = createUnsavedDraftPersistence({
      store,
      debounceMs: 800,
      now: () => 20,
      targetWindow: undefined,
    })
    const barrier = await persistence.prepareFileMutation([{
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'notes/a',
    }])
    persistence.schedule(snapshot('after-confirmation', 'notes/a', 2))

    const [result] = await barrier.commitDeletes([{
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'notes/a',
      policy: 'discard-confirmed',
    }])
    await persistence.flush('vault', 'doc-a')

    expect(result.status).toBe('stale')
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      content: 'after-confirmation',
      documentPath: 'notes/a',
    })
    await persistence.dispose()
  })

  it('persists edits captured by a preserve delete as orphan recovery', async () => {
    const store = createDraftStore({ backend: createMemoryDraftBackend() })
    const persistence = createUnsavedDraftPersistence({
      store,
      debounceMs: 800,
      now: () => 20,
      targetWindow: undefined,
    })
    const barrier = await persistence.prepareFileMutation([{
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'notes/a',
    }])
    persistence.schedule(snapshot('orphan', 'notes/a', 2))
    await barrier.commitDeletes([{
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'notes/a',
      policy: 'preserve',
    }])
    await persistence.flush('vault', 'doc-a')

    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      content: 'orphan',
      documentPath: 'notes/a',
    })
    await persistence.dispose()
  })

  it('settles a barrier only once', async () => {
    const store = createDraftStore({ backend: createMemoryDraftBackend() })
    const persistence = createUnsavedDraftPersistence({
      store,
      targetWindow: undefined,
    })
    const barrier = await persistence.prepareFileMutation([{
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'notes/a',
    }])

    await barrier.rollback()
    await expect(barrier.commitMoves([])).resolves.toEqual([])
    await expect(barrier.commitDeletes([])).resolves.toEqual([])
    await expect(barrier.rollback()).resolves.toBeUndefined()
    await persistence.dispose()
  })
})

// --- round-2 conditional-delete race regressions --------------------------
//
// The previous round's commitDeletes() did its ownership check
// BEFORE awaiting IndexedDB CAS, but trusted the CAS result
// blindly after the await — leading to three race windows:
//   (a) new local edits during CAS got silently cleared when CAS
//       returned 'deleted'
//   (b) CAS returning 'stale' triggered a fresh-timestamp
//       queueWrite() that could overwrite the cross-context record
//   (c) CAS returning 'missing' for a record that existed at
//       prepare time was indistinguishable from a real missing
//       record, leaving Recovery to silently drop the identity

describe('draft file transactions — post-CAS race regression', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function makePersistence(store = createDraftStore({ backend: createMemoryDraftBackend() })) {
    return {
      store,
      persistence: createUnsavedDraftPersistence({
        store,
        debounceMs: 800,
        now: () => 10,
        targetWindow: undefined,
      }),
    }
  }

  it('preserves an edit created while the conditional delete is in flight', async () => {
    // Wire a deferred deleteIfUnchanged so we can mutate the entry
    // (simulate a post-CAS edit) while the IndexedDB CAS is awaiting.
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    let releaseDelete!: () => void
    const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve })
    let deleteStarted = false
    const originalDelete = backend.deleteIfUnchanged
    backend.deleteIfUnchanged = vi.fn(async (expected) => {
      deleteStarted = true
      await deleteGate
      return originalDelete.call(backend, expected)
    })
    const persistence = createUnsavedDraftPersistence({
      store,
      debounceMs: 800,
      now: () => 10,
      targetWindow: undefined,
    })
    const identity = {
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'notes/a',
    }
    persistence.schedule(snapshot('rev1', 'notes/a', 1))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    const persistedBefore = await store.getDraft('vault', 'doc-a')
    expect(persistedBefore?.content).toBe('rev1')
    const confirmation = persistence.captureDeleteConfirmation(identity, 1)
    expect(confirmation.expectedDraft).not.toBeNull()

    const barrier = await persistence.prepareFileMutation([identity])
    const deleting = barrier.commitDeletes([{
      ...identity,
      policy: 'discard-confirmed',
      confirmation,
    }])
    // Wait until the CAS has actually started awaiting.
    await vi.waitFor(() => expect(deleteStarted).toBe(true))
    // Simulate the user typing a new edit while CAS is in flight.
    persistence.schedule(snapshot('rev2', 'notes/a', 2))
    // Now release CAS. It must succeed (rev1 matches the stored
    // record), but the post-CAS check sees the entry advanced, so
    // we must NOT clear the entry — instead re-queue rev2.
    releaseDelete()
    const [result] = await deleting
    expect(result.status).toBe('conflict')
    // Let the post-CAS write of rev2 land.
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    const stored = await store.getDraft('vault', 'doc-a')
    expect(stored?.content).toBe('rev2')
    await persistence.dispose()
  })

  it('does not overwrite a cross-context draft after conditional delete returns stale', async () => {
    // Wire a deferred deleteIfUnchanged so we can mutate the entry
    // (simulate a post-CAS edit that pushes latestSnapshotNeedsWrite=true)
    // while the IndexedDB CAS is awaiting a newer cross-context record.
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    let releaseDelete!: () => void
    const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve })
    let deleteStarted = false
    const originalDelete = backend.deleteIfUnchanged
    backend.deleteIfUnchanged = vi.fn(async (expected) => {
      deleteStarted = true
      await deleteGate
      return originalDelete.call(backend, expected)
    })
    const persistence = createUnsavedDraftPersistence({
      store,
      debounceMs: 800,
      now: () => 100,
      targetWindow: undefined,
    })
    const identity = {
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'notes/a',
    }
    // Local session has v2 with the latestSnapshot revision we'll
    // confirm for delete.
    persistence.schedule(snapshot('local-v2', 'notes/a', 2))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    const localStored = await store.getDraft('vault', 'doc-a')
    expect(localStored?.content).toBe('local-v2')
    expect(localStored?.updatedAt).toBe(100)
    // Another context seeds v3 with a NEWER updatedAt. The CAS
    // will see the newer record and return 'stale'.
    await backend.seedRaw({
      version: 1,
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'notes/a',
      content: 'remote-v3',
      baseContentHash: 'base-hash',
      baseModifiedAt: 10.5,
      createdAt: 5,
      updatedAt: 110,
    })
    const confirmation = persistence.captureDeleteConfirmation(identity, 2)
    const barrier = await persistence.prepareFileMutation([identity])
    const deleting = barrier.commitDeletes([{
      ...identity,
      policy: 'discard-confirmed',
      confirmation,
    }])
    // Wait until the CAS is awaiting.
    await vi.waitFor(() => expect(deleteStarted).toBe(true))
    // User typed a new edit during CAS — entry generation / snapshot
    // advance and latestSnapshotNeedsWrite flips to true.
    persistence.schedule(snapshot('local-v3', 'notes/a', 3))
    releaseDelete()
    const [result] = await deleting

    expect(result.status).toBe('conflict')
    // IndexedDB must still hold the cross-context record — the fix
    // path does NOT call queueWrite() with a fresh timestamp when
    // CAS returned stale, even with a post-CAS local edit.
    await vi.advanceTimersByTimeAsync(2000)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    const stored = await store.getDraft('vault', 'doc-a')
    expect(stored?.content).toBe('remote-v3')
    expect(stored?.updatedAt).toBe(110)
    // The local post-CAS edit was promoted to a separate conflict
    // record so the user can still see both candidates in Recovery
    // — the primary draft keeps the cross-context source, the
    // conflict record keeps the local orphan.
    const conflicts = await store.listConflictDrafts('vault')
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.content).toBe('local-v3')
    expect(conflicts[0]?.origin).toBe('delete-conflict')
    expect(conflicts[0]?.crossContextUpdatedAt).toBe(110)
    expect(conflicts[0]?.vaultId).toBe('vault')
    expect(conflicts[0]?.documentId).toBe('doc-a')
    await persistence.dispose()
  })

  it('does not overwrite the cross-context draft during dispose (pagehide simulation)', async () => {
    // Regression: after a stale + post-CAS edit, the entry's
    // pendingConflictId is set. dispose() (called on pagehide or
    // unmount) runs flushAllInternal — that path MUST skip the
    // conflict-pinned entry, otherwise safeTimestamp() would mint a
    // fresh updatedAt > 110 and overwrite the cross-context record.
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    let releaseDelete!: () => void
    const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve })
    let deleteStarted = false
    const originalDelete = backend.deleteIfUnchanged
    backend.deleteIfUnchanged = vi.fn(async (expected) => {
      deleteStarted = true
      await deleteGate
      return originalDelete.call(backend, expected)
    })
    const targetWindow = new EventTarget()
    const persistence = createUnsavedDraftPersistence({
      store,
      debounceMs: 800,
      now: () => 100,
      targetWindow: targetWindow as unknown as Pick<
        Window,
        'addEventListener' | 'removeEventListener'
      >,
    })
    const identity = {
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'notes/a',
    }
    // Pre-persist a local draft so the CAS path runs (an empty
    // expected would short-circuit to `missing` without calling
    // deleteIfUnchanged).
    persistence.schedule(snapshot('local-v2', 'notes/a', 2))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    const localStored = await store.getDraft('vault', 'doc-a')
    expect(localStored?.content).toBe('local-v2')
    expect(localStored?.updatedAt).toBe(100)
    // Another context seeds v3 with a NEWER updatedAt.
    await backend.seedRaw({
      version: 1,
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'notes/a',
      content: 'remote-v3',
      baseContentHash: 'base-hash',
      baseModifiedAt: 10.5,
      createdAt: 5,
      updatedAt: 110,
    })
    const confirmation = persistence.captureDeleteConfirmation(identity, 2)
    const barrier = await persistence.prepareFileMutation([identity])
    const deleting = barrier.commitDeletes([{
      ...identity,
      policy: 'discard-confirmed',
      confirmation,
    }])
    await vi.waitFor(() => expect(deleteStarted).toBe(true))
    persistence.schedule(snapshot('local-v3', 'notes/a', 3))
    releaseDelete()
    await deleting

    targetWindow.dispatchEvent(new Event('pagehide'))
    await Promise.resolve()
    await Promise.resolve()
    expect((await store.getDraft('vault', 'doc-a'))?.content).toBe('remote-v3')

    // dispose() must likewise NOT overwrite the cross-context record
    // with a fresh timestamp.
    await persistence.dispose()
    const stored = await store.getDraft('vault', 'doc-a')
    expect(stored?.content).toBe('remote-v3')
    expect(stored?.updatedAt).toBe(110)
  })

  it('does not retry the confirmed snapshot with a newer timestamp after stale (no post-CAS edit)', async () => {
    // No post-CAS edit: latestSnapshotNeedsWrite stays false, so
    // the stale branch must not produce ANY IndexedDB write. Even
    // though `releaseEntry(writeLatest=true)` would no-op here, the
    // test pins the contract so a future refactor doesn't
    // accidentally bypass that guard.
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const persistence = createUnsavedDraftPersistence({
      store,
      debounceMs: 800,
      now: () => 100,
      targetWindow: undefined,
    })
    const identity = {
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'notes/a',
    }
    persistence.schedule(snapshot('local', 'notes/a', 1))
    await backend.seedRaw({
      version: 1,
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'notes/a',
      content: 'cross-context',
      baseContentHash: 'base-hash',
      baseModifiedAt: 10.5,
      createdAt: 5,
      updatedAt: 200,
    })
    const confirmation = persistence.captureDeleteConfirmation(identity, 1)
    const barrier = await persistence.prepareFileMutation([identity])
    const [result] = await barrier.commitDeletes([{
      ...identity,
      policy: 'discard-confirmed',
      confirmation,
    }])

    expect(result.status).toBe('stale')
    await vi.advanceTimersByTimeAsync(2000)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    const stored = await store.getDraft('vault', 'doc-a')
    expect(stored?.content).toBe('cross-context')
    expect(stored?.updatedAt).toBe(200)
    await persistence.dispose()
  })

  it('reports stale (not missing) when CAS finds no record but prepare saw one', async () => {
    // Refinement of the medium issue: confirmedDraft was non-null
    // at prepareFileMutation, but the IndexedDB record vanished
    // before CAS ran. Surface as 'stale' so the UI can refresh
    // Recovery instead of silently dropping the identity.
    const { store, persistence } = makePersistence()
    const identity = {
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'notes/a',
    }
    // Schedule a snapshot so the entry has a latestSnapshot, then
    // seed a matching IndexedDB record, then let the debounce write.
    persistence.schedule(snapshot('seeded', 'notes/a', 1))
    await vi.advanceTimersByTimeAsync(800)
    // Let the queueWrite microtask chain run to completion so
    // entry.persistedDraft is populated.
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    const persistedAfter = await store.getDraft('vault', 'doc-a')
    expect(persistedAfter?.content).toBe('seeded')
    const confirmation = persistence.captureDeleteConfirmation(identity, 1)
    expect(confirmation.expectedDraft?.content).toBe('seeded')
    // Delete the IndexedDB record between capture and prepare.
    await store.deleteDraft('vault', 'doc-a')
    const barrier = await persistence.prepareFileMutation([identity])
    const [result] = await barrier.commitDeletes([{
      ...identity,
      policy: 'discard-confirmed',
      confirmation,
    }])

    // The IndexedDB record vanished — but at prepare time the store
    // getDraft() populated confirmedDraft, so the refined outcome
    // must be 'stale' (refresh Recovery) rather than 'missing'
    // (drop the identity silently).
    expect(result.status).toBe('stale')
    await persistence.dispose()
  })
})

// --- conflict handoff atomicity & conflict channel -------------------------
//
// These cover the round-3/round-4/round-5 findings: the conflict handoff
// is bounded to TWO saves — it persists the current snapshot, and an
// edit typed during that save is persisted as the latest snapshot by a
// second immediate attempt, so the transaction never reports success
// while the newest bytes are still only in-memory; yet a steady typer
// cannot keep the file transaction open on a moving target — after two
// attempts the handoff fails closed (tab kept open, conflict debounce
// armed for a background retry). Immediate orphan writes on the delete
// paths are observed: a rejected write maps to 'failed' (never
// preserved / stale / conflict) so the lifecycle keeps the tab open.
// Edits made after conflict mode is entered must stay on the conflict
// channel (never overwrite the cross-context primary); conflict records
// must follow renames as one pre-flight-validated family; a confirmed
// delete must remove the conflict records frozen at confirmation time,
// hold its transaction until that cleanup and the final re-verification
// complete (an edit typed during the cleanup is persisted as a conflict
// BEFORE anything reports deleted), treat an unread conflict store as
// failed, and treat an unreadable same-identity survivor row as
// unsupported rather than an empty list.

describe('draft file transactions — conflict handoff & channel', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const identity = {
    vaultId: 'vault',
    documentId: 'doc-a',
    documentPath: 'notes/a',
  }

  function remoteV3() {
    return {
      version: 1 as const,
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'notes/a',
      content: 'remote-v3',
      baseContentHash: 'base-hash',
      baseModifiedAt: 10.5,
      createdAt: 5,
      updatedAt: 110,
    }
  }

  function gatedStore() {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    let releaseDelete!: () => void
    const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve })
    let deleteStarted = false
    const originalDelete = backend.deleteIfUnchanged
    backend.deleteIfUnchanged = vi.fn(async (expected) => {
      deleteStarted = true
      await deleteGate
      return originalDelete.call(backend, expected)
    })
    return {
      backend,
      store,
      releaseDelete: () => releaseDelete(),
      waitDeleteStarted: () => vi.waitFor(() => expect(deleteStarted).toBe(true)),
    }
  }

  function makePersistence(store: ReturnType<typeof createDraftStore>, targetWindow?: EventTarget) {
    return createUnsavedDraftPersistence({
      store,
      debounceMs: 800,
      now: () => 100,
      targetWindow: targetWindow as unknown as Pick<
        Window,
        'addEventListener' | 'removeEventListener'
      > | undefined,
    })
  }

  // Drive the entry to the stale + post-CAS-edit branch: persist local-v2,
  // seed a newer cross-context remote-v3, confirm delete, then land local-v3
  // while the CAS is in flight. Returns the in-flight commitDeletes promise
  // wrapped in an object — returning the bare promise from an async helper
  // would make `await enterConflictHandoff(...)` block until commitDeletes
  // settles, deadlocking any test that gates the conflict save mid-flight.
  async function enterConflictHandoff(
    persistence: ReturnType<typeof makePersistence>,
    store: ReturnType<typeof createDraftStore>,
    backend: ReturnType<typeof createMemoryDraftBackend>,
    gate: ReturnType<typeof gatedStore>,
  ) {
    persistence.schedule(snapshot('local-v2', 'notes/a', 2))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    expect((await store.getDraft('vault', 'doc-a'))?.content).toBe('local-v2')
    await backend.seedRaw(remoteV3())
    const confirmation = persistence.captureDeleteConfirmation(identity, 2)
    const barrier = await persistence.prepareFileMutation([identity])
    const deleting = barrier.commitDeletes([{
      ...identity,
      policy: 'discard-confirmed',
      confirmation,
    }])
    await gate.waitDeleteStarted()
    persistence.schedule(snapshot('local-v3', 'notes/a', 3))
    gate.releaseDelete()
    return { deleting }
  }

  it('persists an edit typed during the conflict save with a bounded second attempt', async () => {
    const gate = gatedStore()
    const { backend, store } = gate
    // Gate only the FIRST conflict save so we can land local-v4 mid-save.
    let conflictCalls = 0
    let releaseConflict!: () => void
    const conflictGate = new Promise<void>((resolve) => { releaseConflict = resolve })
    const originalSaveCandidate = store.saveConflictCandidate.bind(store)
    vi.spyOn(store, 'saveConflictCandidate').mockImplementation(async (record) => {
      conflictCalls += 1
      if (conflictCalls === 1) await conflictGate
      return originalSaveCandidate(record)
    })
    const persistence = makePersistence(store)
    const { deleting } = await enterConflictHandoff(persistence, store, backend, gate)
    // First conflict save (local-v3) is now awaiting the gate.
    await vi.waitFor(() => expect(conflictCalls).toBe(1))
    persistence.schedule(snapshot('local-v4', 'notes/a', 4))
    releaseConflict()
    const [result] = await deleting

    expect(result.status).toBe('conflict')
    // Primary keeps the cross-context record.
    expect((await store.getDraft('vault', 'doc-a'))?.content).toBe('remote-v3')
    // The handoff is BOUNDED but OBSERVABLE: exactly two conflict saves
    // ran inside the file transaction — attempt 1 persisted local-v3,
    // and the mid-save edit triggered attempt 2, which persisted the
    // NEW latest snapshot (local-v4) BEFORE the transaction reported.
    // The old single-save path reported 'conflict' here with local-v4
    // still pending in an 800ms debounce: if that save later failed,
    // the tab was already closed and the bytes were lost.
    expect(conflictCalls).toBe(2)
    const contents = (await store.listConflictDrafts('vault'))
      .map((conflict) => conflict.content)
      .sort()
    expect(contents).toEqual(['local-v3', 'local-v4'])
    // The latest snapshot was verified durable inside the transaction —
    // nothing is left tracked in memory for the lifecycle to lose.
    expect(persistence.findTrackedIdentitiesByPaths(['notes/a'])).toEqual([])
    // And the primary was never touched by either write.
    expect((await store.getDraft('vault', 'doc-a'))?.content).toBe('remote-v3')
    await persistence.dispose()
  })

  it('reports failed when the latest conflict save fails on the second attempt', async () => {
    const gate = gatedStore()
    const { backend, store } = gate
    // Attempt 1 succeeds (after the gate); attempt 2 — the save that
    // covers the mid-save edit — is rejected by the store.
    let conflictCalls = 0
    let releaseConflict!: () => void
    const conflictGate = new Promise<void>((resolve) => { releaseConflict = resolve })
    const originalSaveCandidate = store.saveConflictCandidate.bind(store)
    const saveConflict = vi.spyOn(store, 'saveConflictCandidate')
      .mockImplementation(async (record) => {
        conflictCalls += 1
        if (conflictCalls === 1) {
          await conflictGate
          return originalSaveCandidate(record)
        }
        if (conflictCalls === 2) return { status: 'failed' }
        return originalSaveCandidate(record)
      })
    const persistence = makePersistence(store)
    const { deleting } = await enterConflictHandoff(persistence, store, backend, gate)
    await vi.waitFor(() => expect(conflictCalls).toBe(1))
    persistence.schedule(snapshot('local-v4', 'notes/a', 4))
    releaseConflict()
    const [result] = await deleting

    // Attempt 2 failed, so local-v4 is still only in-memory: the
    // transaction must NOT report 'conflict' (the lifecycle would close
    // the tab on it) — 'failed' keeps the tab open as the only visible
    // surface holding local-v4.
    expect(result.status).toBe('failed')
    expect(conflictCalls).toBe(2)
    expect((await store.getDraft('vault', 'doc-a'))?.content).toBe('remote-v3')
    expect((await store.listConflictDrafts('vault')).map((c) => c.content))
      .toEqual(['local-v3'])
    expect(persistence.findTrackedIdentitiesByPaths(['notes/a'])).toEqual([identity])
    // The release armed the conflict debounce: once the store
    // recovers, the background retry persists local-v4 without any
    // further user action — the failed delete still converges.
    saveConflict.mockRestore()
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    expect((await store.listConflictDrafts('vault')).map((c) => c.content).sort())
      .toEqual(['local-v3', 'local-v4'])
    expect((await store.getDraft('vault', 'doc-a'))?.content).toBe('remote-v3')
    await persistence.dispose()
  })

  it('reports failed when edits keep landing across both bounded attempts', async () => {
    const gate = gatedStore()
    const { backend, store } = gate
    // Gate BOTH in-transaction saves so an edit lands during each —
    // the handoff must terminate after two attempts instead of chasing
    // a moving target indefinitely.
    let conflictCalls = 0
    const gates: Array<() => void> = []
    const originalSaveCandidate = store.saveConflictCandidate.bind(store)
    vi.spyOn(store, 'saveConflictCandidate').mockImplementation(async (record) => {
      const callIndex = conflictCalls
      conflictCalls += 1
      if (callIndex <= 1) {
        await new Promise<void>((resolve) => { gates[callIndex] = resolve })
      }
      return originalSaveCandidate(record)
    })
    const persistence = makePersistence(store)
    const { deleting } = await enterConflictHandoff(persistence, store, backend, gate)
    // local-v4 lands during attempt 1 → triggers attempt 2.
    await vi.waitFor(() => expect(conflictCalls).toBe(1))
    persistence.schedule(snapshot('local-v4', 'notes/a', 4))
    gates[0]!()
    // local-v5 lands during attempt 2 → the handoff must fail closed
    // instead of starting an attempt 3.
    await vi.waitFor(() => expect(conflictCalls).toBe(2))
    persistence.schedule(snapshot('local-v5', 'notes/a', 5))
    gates[1]!()
    const [result] = await deleting

    expect(result.status).toBe('failed')
    // Bounded: exactly two saves inside the transaction, no matter how
    // fast the user keeps typing — the mutation lock / tab / tree must
    // not wait on a moving target.
    expect(conflictCalls).toBe(2)
    // Both saved candidates are durable; local-v5 is not (yet).
    expect((await store.listConflictDrafts('vault')).map((c) => c.content).sort())
      .toEqual(['local-v3', 'local-v4'])
    // 'failed' keeps the tab open — the only surface holding local-v5 —
    // while the armed conflict debounce retries it in the background.
    expect(persistence.findTrackedIdentitiesByPaths(['notes/a'])).toEqual([identity])
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    expect((await store.listConflictDrafts('vault')).map((c) => c.content).sort())
      .toEqual(['local-v3', 'local-v4', 'local-v5'])
    expect((await store.getDraft('vault', 'doc-a'))?.content).toBe('remote-v3')
    await persistence.dispose()
  })

  it('reports failed and keeps the content visible when the conflict save fails', async () => {
    const gate = gatedStore()
    const { backend, store } = gate
    vi.spyOn(store, 'saveConflictCandidate').mockResolvedValue({ status: 'failed' })
    const persistence = makePersistence(store)
    const { deleting } = await enterConflictHandoff(persistence, store, backend, gate)
    const [result] = await deleting

    // A failed handoff surfaces as 'failed' so the lifecycle keeps the
    // tab open (the only surface still holding the bytes).
    expect(result.status).toBe('failed')
    // Primary untouched.
    expect((await store.getDraft('vault', 'doc-a'))?.content).toBe('remote-v3')
    // No conflict record was written...
    expect(await store.listConflictDrafts('vault')).toEqual([])
    // ...but the local content is still held in memory, not dropped.
    expect(persistence.findTrackedIdentitiesByPaths(['notes/a'])).toEqual([identity])
    // Flushing must not overwrite the primary either (conflict channel).
    await persistence.flush('vault', 'doc-a')
    expect((await store.getDraft('vault', 'doc-a'))?.content).toBe('remote-v3')
    expect(persistence.findTrackedIdentitiesByPaths(['notes/a'])).toEqual([identity])
    await persistence.dispose()
  })

  it('routes post-conflict edits to the conflict channel, never the primary', async () => {
    const gate = gatedStore()
    const { backend, store } = gate
    const persistence = makePersistence(store)
    const { deleting } = await enterConflictHandoff(persistence, store, backend, gate)
    const [result] = await deleting
    expect(result.status).toBe('conflict')

    // The entry is now conflict-pinned. The user types again before the
    // tab closes — this must NOT revert to a primary write.
    persistence.schedule(snapshot('local-v4', 'notes/a', 4))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()

    const stored = await store.getDraft('vault', 'doc-a')
    expect(stored?.content).toBe('remote-v3')
    expect(stored?.updatedAt).toBe(110)
    const contents = (await store.listConflictDrafts('vault'))
      .map((conflict) => conflict.content)
      .sort()
    expect(contents).toEqual(['local-v3', 'local-v4'])
    await persistence.dispose()
  })

  it('keeps both candidates across pagehide and dispose', async () => {
    const gate = gatedStore()
    const { backend, store } = gate
    const targetWindow = new EventTarget()
    const persistence = makePersistence(store, targetWindow)
    const { deleting } = await enterConflictHandoff(persistence, store, backend, gate)
    await deleting

    targetWindow.dispatchEvent(new Event('pagehide'))
    await Promise.resolve()
    await Promise.resolve()
    await persistence.dispose()

    expect((await store.getDraft('vault', 'doc-a'))?.content).toBe('remote-v3')
    expect((await store.listConflictDrafts('vault')).map((c) => c.content))
      .toEqual(['local-v3'])
  })

  it('flushes a pending conflict-channel edit on pagehide', async () => {
    const gate = gatedStore()
    const { backend, store } = gate
    const targetWindow = new EventTarget()
    const persistence = makePersistence(store, targetWindow)
    const { deleting } = await enterConflictHandoff(persistence, store, backend, gate)
    await deleting
    // The entry is conflict-pinned with local-v3 persisted. The user
    // types again and pagehide fires BEFORE the debounce timer elapses
    // — the edit is still only in-memory. flushAll must route it to
    // the conflict channel instead of skipping it (which would drop
    // bytes that live in neither store).
    persistence.schedule(snapshot('local-v4', 'notes/a', 4))
    targetWindow.dispatchEvent(new Event('pagehide'))
    await vi.waitFor(async () => {
      expect((await store.listConflictDrafts('vault')).map((c) => c.content).sort())
        .toEqual(['local-v3', 'local-v4'])
    })
    await persistence.dispose()
  })

  it('flushes a pending conflict-channel edit on dispose', async () => {
    const gate = gatedStore()
    const { backend, store } = gate
    const persistence = makePersistence(store)
    const { deleting } = await enterConflictHandoff(persistence, store, backend, gate)
    await deleting
    // Same data-loss window as pagehide, hit through dispose (tab
    // unmount / vault switch) before the debounce timer elapses.
    persistence.schedule(snapshot('local-v4', 'notes/a', 4))
    await persistence.dispose()
    expect((await store.listConflictDrafts('vault')).map((c) => c.content).sort())
      .toEqual(['local-v3', 'local-v4'])
  })

  it('does not overwrite the primary while flushing the conflict channel', async () => {
    const gate = gatedStore()
    const { backend, store } = gate
    const targetWindow = new EventTarget()
    const persistence = makePersistence(store, targetWindow)
    const { deleting } = await enterConflictHandoff(persistence, store, backend, gate)
    await deleting
    persistence.schedule(snapshot('local-v4', 'notes/a', 4))
    // Flush the pending conflict-channel edit through pagehide, then
    // dispose: the flush must persist the edit as a conflict candidate
    // and never mint a fresh primary timestamp that overwrites the
    // cross-context record.
    targetWindow.dispatchEvent(new Event('pagehide'))
    await vi.waitFor(async () => {
      expect((await store.listConflictDrafts('vault')).map((c) => c.content).sort())
        .toEqual(['local-v3', 'local-v4'])
    })
    await persistence.dispose()
    const stored = await store.getDraft('vault', 'doc-a')
    expect(stored?.content).toBe('remote-v3')
    expect(stored?.updatedAt).toBe(110)
  })

  it('keeps failed local bytes visible after folder delete and dispose', async () => {
    const gate = gatedStore()
    const { backend, store } = gate
    // Every conflict save fails during the delete transaction — the
    // handoff cannot persist the local bytes and reports 'failed' (a
    // folder delete keeps this path's tab open on that result).
    const saveConflict = vi.spyOn(store, 'saveConflictCandidate')
      .mockResolvedValue({ status: 'failed' })
    const persistence = makePersistence(store)
    const { deleting } = await enterConflictHandoff(persistence, store, backend, gate)
    const [result] = await deleting
    expect(result.status).toBe('failed')
    expect(await store.listConflictDrafts('vault')).toEqual([])
    // The bytes are still only in-memory. Once the store recovers,
    // dispose (the unmount that follows the failed delete) must retry
    // the conflict write instead of dropping them.
    saveConflict.mockRestore()
    await persistence.dispose()
    expect((await store.getDraft('vault', 'doc-a'))?.content).toBe('remote-v3')
    expect((await store.listConflictDrafts('vault')).map((c) => c.content))
      .toEqual(['local-v3'])
  })

  it('reports failed instead of preserved when the immediate orphan write fails', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const persistence = makePersistence(store)
    const barrier = await persistence.prepareFileMutation([identity])
    persistence.schedule(snapshot('orphan', 'notes/a', 2))
    // The server file is deleted, and the preserve path must write the
    // pending snapshot as an orphan IMMEDIATELY — but IndexedDB
    // rejects the write.
    backend.failNext('save')
    const [result] = await barrier.commitDeletes([{
      ...identity,
      policy: 'preserve',
    }])

    // The snapshot is still only in-memory: 'failed' (not 'preserved')
    // keeps the tab open — it is the only surface holding these bytes.
    expect(result.status).toBe('failed')
    expect(await store.getDraft('vault', 'doc-a')).toBeNull()
    expect(persistence.findTrackedIdentitiesByPaths(['notes/a'])).toEqual([identity])
    await persistence.dispose()
  })

  it('reports failed instead of conflict when the post-CAS orphan write fails', async () => {
    const gate = gatedStore()
    const { backend, store } = gate
    const persistence = makePersistence(store)
    persistence.schedule(snapshot('local-v2', 'notes/a', 2))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    expect((await store.getDraft('vault', 'doc-a'))?.content).toBe('local-v2')
    const confirmation = persistence.captureDeleteConfirmation(identity, 2)
    const barrier = await persistence.prepareFileMutation([identity])
    // The immediate orphan write of the post-CAS edit will be rejected.
    backend.failNext('save')
    const deleting = barrier.commitDeletes([{
      ...identity,
      policy: 'discard-confirmed',
      confirmation,
    }])
    await gate.waitDeleteStarted()
    // CAS succeeds on the confirmed record, but this edit lands while
    // the CAS is in flight — the post-CAS branch re-queues it as a new
    // orphan immediately.
    persistence.schedule(snapshot('local-v3', 'notes/a', 3))
    gate.releaseDelete()
    const [result] = await deleting

    // The orphan write failed, so the new edit is still only in-memory:
    // 'failed' (not 'conflict') keeps the tab open.
    expect(result.status).toBe('failed')
    expect(await store.getDraft('vault', 'doc-a')).toBeNull()
    expect(persistence.findTrackedIdentitiesByPaths(['notes/a'])).toEqual([identity])
    await persistence.dispose()
  })

  it('reports failed instead of stale when the confirmation-mismatch orphan write fails', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const persistence = makePersistence(store)
    persistence.schedule(snapshot('confirmed', 'notes/a', 1))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    const confirmation = persistence.captureDeleteConfirmation(identity, 1)
    const barrier = await persistence.prepareFileMutation([identity])
    // A newer snapshot than the confirmation's — the stale branch
    // re-queues it as an orphan immediately.
    persistence.schedule(snapshot('after-confirmation', 'notes/a', 2))
    backend.failNext('save')
    const [result] = await barrier.commitDeletes([{
      ...identity,
      policy: 'discard-confirmed',
      confirmation,
    }])

    // The immediate write failed — the newer snapshot is still only
    // in-memory: 'failed' (not 'stale') keeps the tab open.
    expect(result.status).toBe('failed')
    expect(persistence.findTrackedIdentitiesByPaths(['notes/a'])).toEqual([identity])
    await persistence.dispose()
  })

  it('reports unsupported when an unreadable conflict row survives the confirmed delete', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const original = draft('confirmed')
    await store.saveDraft(original)
    // A future-version conflict row for the SAME identity, seeded
    // behind the store's validation. The UI could never see it, so it
    // was never frozen at confirmation — it always survives the
    // frozen-cleanup deletes.
    await backend.seedRawConflict({
      version: 2,
      conflictId: 'conflict-future',
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'notes/a',
      content: 'future data',
      baseContentHash: 'base-hash',
      baseModifiedAt: 10.5,
      createdAt: 5,
      updatedAt: 31,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 30,
      recordedAt: 31,
    })
    const persistence = createUnsavedDraftPersistence({ store, targetWindow: undefined })
    await persistence.adoptRecoveredDraft(original, snapshot('confirmed'))
    const confirmation = persistence.captureDeleteConfirmation(identity, 1, null, [])
    const barrier = await persistence.prepareFileMutation([identity])
    const [result] = await barrier.commitDeletes([{
      ...identity,
      policy: 'discard-confirmed',
      confirmation,
    }])

    // The strict survivor read sees the unreadable same-identity row
    // and refuses to certify a clean delete: 'unsupported' keeps the
    // Recovery identity visible (and warns) instead of removeIdentity()
    // outliving a row the store could not read.
    expect(result.status).toBe('unsupported')
    expect(await store.getDraft('vault', 'doc-a')).toBeNull()
    expect(await backend.listConflicts('vault')).toHaveLength(1)
    await persistence.dispose()
  })

  it('moves conflict record paths along with the primary draft on rename', async () => {
    const store = createDraftStore({ backend: createMemoryDraftBackend() })
    await store.saveDraft(draft('primary', 'notes/a', 10))
    await store.saveConflictDraft({
      version: 1,
      conflictId: 'conflict-a',
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'notes/a',
      content: 'local orphan',
      baseContentHash: 'base-hash',
      baseModifiedAt: 10.5,
      createdAt: 5,
      updatedAt: 31,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 30,
      recordedAt: 31,
    })
    const persistence = createUnsavedDraftPersistence({ store, targetWindow: undefined })
    const barrier = await persistence.prepareFileMutation([identity])
    const [result] = await barrier.commitMoves([{
      ...identity,
      fromPath: 'notes/a',
      toPath: 'archive/a',
    }])

    expect(result.status).toBe('moved')
    expect((await store.getDraft('vault', 'doc-a'))?.documentPath).toBe('archive/a')
    const conflicts = await store.listConflictDrafts('vault')
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({
      conflictId: 'conflict-a',
      documentPath: 'archive/a',
      content: 'local orphan',
      origin: 'delete-conflict',
    })
    await persistence.dispose()
  })

  it('reports a failed rename when the family move cannot migrate conflicts', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    await store.saveDraft(draft('primary', 'notes/a', 10))
    await store.saveConflictDraft({
      version: 1,
      conflictId: 'conflict-a',
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'notes/a',
      content: 'local orphan',
      baseContentHash: 'base-hash',
      baseModifiedAt: 10.5,
      createdAt: 5,
      updatedAt: 31,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 30,
      recordedAt: 31,
    })
    backend.failNext('moveFamilyConflicts')
    const persistence = createUnsavedDraftPersistence({ store, targetWindow: undefined })
    const barrier = await persistence.prepareFileMutation([identity])
    const [result] = await barrier.commitMoves([{
      ...identity,
      fromPath: 'notes/a',
      toPath: 'archive/a',
    }])

    // The family move fails as a unit: no split state where the primary
    // is renamed while conflicts are stranded on the pre-rename path,
    // and no silent 'moved' — reportDraftResults turns 'failed' into a
    // user-visible warning and Recovery refreshes the identity.
    expect(result.status).toBe('failed')
    expect((await store.getDraft('vault', 'doc-a'))?.documentPath).toBe('notes/a')
    expect((await store.listConflictDrafts('vault')).map((c) => c.documentPath))
      .toEqual(['notes/a'])
    await persistence.dispose()
  })

  it('removes the conflict records frozen at confirmation on a conflict-only delete', async () => {
    const store = createDraftStore({ backend: createMemoryDraftBackend() })
    await store.saveConflictDraft({
      version: 1,
      conflictId: 'conflict-a',
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'notes/a',
      content: 'local orphan',
      baseContentHash: 'base-hash',
      baseModifiedAt: 10.5,
      createdAt: 5,
      updatedAt: 31,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 30,
      recordedAt: 31,
    })
    const persistence = createUnsavedDraftPersistence({ store, targetWindow: undefined })
    // No primary record, no in-memory snapshot: freeze the conflict id
    // directly, as the UI does from its discovered recovery items.
    const confirmation = persistence.captureDeleteConfirmation(identity, 0, null, ['conflict-a'])
    expect(confirmation.expectedConflictIds).toEqual(['conflict-a'])
    const barrier = await persistence.prepareFileMutation([identity])
    const [result] = await barrier.commitDeletes([{
      ...identity,
      policy: 'discard-confirmed',
      confirmation,
    }])

    expect(result.status).toBe('missing')
    expect(await store.listConflictDrafts('vault')).toEqual([])
    await persistence.dispose()
  })

  it('reports failed when a frozen conflict delete fails instead of full success', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const original = draft('confirmed')
    await store.saveDraft(original)
    await store.saveConflictDraft({
      version: 1,
      conflictId: 'conflict-a',
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'notes/a',
      content: 'local orphan',
      baseContentHash: 'base-hash',
      baseModifiedAt: 10.5,
      createdAt: 5,
      updatedAt: 31,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 30,
      recordedAt: 31,
    })
    const persistence = createUnsavedDraftPersistence({ store, targetWindow: undefined })
    await persistence.adoptRecoveredDraft(original, snapshot('confirmed'))
    const confirmation = persistence.captureDeleteConfirmation(identity, 1, null, ['conflict-a'])
    const barrier = await persistence.prepareFileMutation([identity])
    backend.failNext('deleteConflict')
    const [result] = await barrier.commitDeletes([{
      ...identity,
      policy: 'discard-confirmed',
      confirmation,
    }])

    // The primary CAS succeeded, but the frozen conflict delete hit a
    // store error — the row survives. Reporting full success ('deleted')
    // would make the UI remove the identity and close its tabs, hiding
    // the survivor until the next refresh. Fail closed: 'failed' keeps
    // the identity visible via refreshIdentity and warns the user.
    expect(result.status).toBe('failed')
    expect(await store.getDraft('vault', 'doc-a')).toBeNull()
    expect((await store.listConflictDrafts('vault')).map((c) => c.conflictId))
      .toEqual(['conflict-a'])
    await persistence.dispose()
  })

  it('persists a cleanup-window edit as a conflict before reporting the delete', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const original = draft('confirmed')
    await store.saveDraft(original)
    await store.saveConflictDraft({
      version: 1,
      conflictId: 'conflict-a',
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'notes/a',
      content: 'local orphan',
      baseContentHash: 'base-hash',
      baseModifiedAt: 10.5,
      createdAt: 5,
      updatedAt: 31,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 30,
      recordedAt: 31,
    })
    const persistence = createUnsavedDraftPersistence({
      store,
      debounceMs: 800,
      now: () => 100,
      targetWindow: undefined,
    })
    await persistence.adoptRecoveredDraft(original, snapshot('confirmed'))
    const confirmation = persistence.captureDeleteConfirmation(identity, 1, null, ['conflict-a'])
    const barrier = await persistence.prepareFileMutation([identity])
    // Gate the frozen conflict delete to open the cleanup window AFTER
    // the primary CAS has already succeeded — the deferred
    // deleteConflictDraft() is the window an earlier revision missed
    // (it released the file transaction before the cleanup ran).
    let conflictDeleteStarted = false
    let releaseConflictDelete!: () => void
    const conflictDeleteGate = new Promise<void>((resolve) => { releaseConflictDelete = resolve })
    const originalDeleteConflict = store.deleteConflictDraft.bind(store)
    vi.spyOn(store, 'deleteConflictDraft')
      .mockImplementation(async (vaultId, documentId, conflictId) => {
        conflictDeleteStarted = true
        await conflictDeleteGate
        return originalDeleteConflict(vaultId, documentId, conflictId)
      })
    const deleting = barrier.commitDeletes([{
      ...identity,
      policy: 'discard-confirmed',
      confirmation,
    }])
    await vi.waitFor(() => expect(conflictDeleteStarted).toBe(true))
    // The user types while the frozen conflicts are being deleted.
    persistence.schedule(snapshot('cleanup-edit', 'notes/a', 2))
    // The file transaction must still be held: no primary debounce may
    // fire during the cleanup window. The old code released the
    // transaction up front, armed a primary write here, and could close
    // the tab before it fired — losing bytes that existed only in
    // coordinator memory while the identity was already reported
    // deleted.
    await vi.advanceTimersByTimeAsync(5000)
    expect(await store.getDraft('vault', 'doc-a')).toBeNull()
    releaseConflictDelete()
    const [result] = await deleting

    // The cleanup-window edit was persisted as a conflict candidate
    // BEFORE the transaction reported — never an unpersisted orphan
    // behind a 'deleted' result. The frozen row was removed.
    expect(result.status).toBe('conflict')
    expect(await store.getDraft('vault', 'doc-a')).toBeNull()
    expect((await store.listConflictDrafts('vault')).map((c) => c.content))
      .toEqual(['cleanup-edit'])
    // The primary channel was never armed for the cleanup-window edit.
    expect(persistence.findTrackedIdentitiesByPaths(['notes/a'])).toEqual([])
    await persistence.dispose()
  })

  it('reports failed when the surviving conflict list cannot be read', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const original = draft('confirmed')
    await store.saveDraft(original)
    await store.saveConflictDraft({
      version: 1,
      conflictId: 'conflict-a',
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'notes/a',
      content: 'local orphan',
      baseContentHash: 'base-hash',
      baseModifiedAt: 10.5,
      createdAt: 5,
      updatedAt: 31,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 30,
      recordedAt: 31,
    })
    const persistence = createUnsavedDraftPersistence({ store, targetWindow: undefined })
    await persistence.adoptRecoveredDraft(original, snapshot('confirmed'))
    const confirmation = persistence.captureDeleteConfirmation(identity, 1, null, ['conflict-a'])
    const barrier = await persistence.prepareFileMutation([identity])
    // The frozen delete succeeds, but the survivor read that follows
    // hits a store error — commitDeletes must fail closed instead of
    // falling back to "no survivors" and reporting a full delete.
    backend.failNext('listConflicts')
    const [result] = await barrier.commitDeletes([{
      ...identity,
      policy: 'discard-confirmed',
      confirmation,
    }])

    expect(result.status).toBe('failed')
    expect(await store.getDraft('vault', 'doc-a')).toBeNull()
    expect((await store.listConflictDrafts('vault')).map((c) => c.conflictId))
      .toEqual([])
    await persistence.dispose()
  })

  it('does not remove conflicts recorded after the confirmation was captured', async () => {
    const store = createDraftStore({ backend: createMemoryDraftBackend() })
    const frozen: DraftConflictRecord = {
      version: 1,
      conflictId: 'conflict-frozen',
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'notes/a',
      content: 'frozen',
      baseContentHash: 'base-hash',
      baseModifiedAt: 10.5,
      createdAt: 5,
      updatedAt: 31,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 30,
      recordedAt: 31,
    }
    await store.saveConflictDraft(frozen)
    const persistence = createUnsavedDraftPersistence({ store, targetWindow: undefined })
    // Only 'conflict-frozen' is frozen. A later conflict appears in the
    // store before the transaction commits but was never confirmed.
    const confirmation = persistence.captureDeleteConfirmation(identity, 0, null, ['conflict-frozen'])
    await store.saveConflictDraft({ ...frozen, conflictId: 'conflict-late', content: 'late', updatedAt: 32, recordedAt: 32 })
    const barrier = await persistence.prepareFileMutation([identity])
    const [result] = await barrier.commitDeletes([{
      ...identity,
      policy: 'discard-confirmed',
      confirmation,
    }])

    const remaining = (await store.listConflictDrafts('vault')).map((c) => c.conflictId)
    expect(remaining).toEqual(['conflict-late'])
    // The surviving post-confirmation candidate must keep the identity
    // visible: 'conflict' (not 'missing') makes the UI refresh the
    // identity instead of removing it wholesale and closing its tabs.
    expect(result.status).toBe('conflict')
    await persistence.dispose()
  })
})

// The delete transaction releases every entry when it reports, but the
// lifecycle still awaits Recovery synchronization before closing tabs.
// An edit typed during that settlement window arms a fresh debounce
// (the file transaction is already gone) that the tab close could
// outrun — if that write later failed, the bytes would exist nowhere
// visible. finalizeBeforeDocumentClose() seals the window: it persists
// anything still pending IMMEDIATELY (on the entry's active channel)
// and reports 'failed' when the write is rejected, so the lifecycle
// keeps that tab open. finalizeAfterTabMigration() must likewise
// OBSERVE its immediate post-rename writes: a rejected write reports
// 'failed' (with the actual server-suffixed newPath) so the lifecycle
// can warn — the server rename stays successful, but a silent success
// would hide a transaction-time edit that never reached the store.

describe('draft file transactions — UI commit boundary sealing', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const identity = {
    vaultId: 'vault',
    documentId: 'doc-a',
    documentPath: 'notes/a',
  }

  function remoteV3() {
    return {
      version: 1 as const,
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'notes/a',
      content: 'remote-v3',
      baseContentHash: 'base-hash',
      baseModifiedAt: 10.5,
      createdAt: 5,
      updatedAt: 110,
    }
  }

  function gatedStore() {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    let releaseDelete!: () => void
    const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve })
    let deleteStarted = false
    const originalDelete = backend.deleteIfUnchanged
    backend.deleteIfUnchanged = vi.fn(async (expected) => {
      deleteStarted = true
      await deleteGate
      return originalDelete.call(backend, expected)
    })
    return {
      backend,
      store,
      releaseDelete: () => releaseDelete(),
      waitDeleteStarted: () => vi.waitFor(() => expect(deleteStarted).toBe(true)),
    }
  }

  function makePersistence(
    store: ReturnType<typeof createDraftStore>,
    targetWindow?: EventTarget,
    resolveCurrentDocumentPath?: (
      vaultId: string,
      documentId: string,
    ) => Promise<{ path: string; version: string | number } | null>,
  ) {
    return createUnsavedDraftPersistence({
      store,
      debounceMs: 800,
      now: () => 100,
      targetWindow,
      resolveCurrentDocumentPath,
    })
  }

  // Drive the entry to the stale + post-CAS-edit branch and resolve the
  // handoff: persist local-v2, seed newer remote-v3, confirm, land
  // local-v3 while the CAS awaits, release. With conflict saves healthy
  // this settles to a stable 'conflict' (entry pinned to the conflict
  // channel, snapshot promoted); with conflict saves mocked to fail it
  // settles to 'failed'. Returns the in-flight commitDeletes promise
  // plus the barrier so tests can run the finalize gate afterwards.
  async function enterConflictHandoff(
    persistence: ReturnType<typeof makePersistence>,
    store: ReturnType<typeof createDraftStore>,
    backend: ReturnType<typeof createMemoryDraftBackend>,
    gate: ReturnType<typeof gatedStore>,
  ) {
    persistence.schedule(snapshot('local-v2', 'notes/a', 2))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    expect((await store.getDraft('vault', 'doc-a'))?.content).toBe('local-v2')
    await backend.seedRaw(remoteV3())
    const confirmation = persistence.captureDeleteConfirmation(identity, 2)
    const barrier = await persistence.prepareFileMutation([identity])
    const deleting = barrier.commitDeletes([{
      ...identity,
      policy: 'discard-confirmed',
      confirmation,
    }])
    await gate.waitDeleteStarted()
    persistence.schedule(snapshot('local-v3', 'notes/a', 3))
    gate.releaseDelete()
    return { deleting, barrier }
  }

  it('preserves an edit typed while recovery settlement is pending', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const persistence = makePersistence(store)
    const saveDraft = vi.spyOn(store, 'saveDraft')
    const barrier = await persistence.prepareFileMutation([identity])
    persistence.schedule(snapshot('orphan', 'notes/a', 2))
    const [result] = await barrier.commitDeletes([{
      ...identity,
      policy: 'preserve',
    }])
    expect(result.status).toBe('preserved')
    // The transaction has released the entry; the lifecycle now awaits
    // Recovery synchronization. An edit typed during that window arms a
    // fresh 800ms debounce — the file transaction no longer holds it.
    persistence.schedule(snapshot('settlement-edit', 'notes/a', 3))

    // finalizeBeforeDocumentClose must persist it IMMEDIATELY (not let
    // the debounce race the imminent tab close) and clear the armed
    // timer.
    const finalizeResults = await barrier.finalizeBeforeDocumentClose()
    // The successful settlement write is reported (non-warning) so the
    // lifecycle's second sync refreshes the Recovery identity to the
    // new content instead of keeping the pre-window record.
    expect(finalizeResults).toEqual([{
      documentId: 'doc-a',
      oldPath: 'notes/a',
      status: 'preserved',
    }])
    expect((await store.getDraft('vault', 'doc-a'))?.content).toBe('settlement-edit')
    expect(saveDraft).toHaveBeenCalledTimes(2)
    // After the tab closes, no draft timer may fire: advancing the
    // clock produces no further write — the window timer was cleared,
    // not left armed behind a closed tab.
    await vi.advanceTimersByTimeAsync(2400)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    expect(saveDraft).toHaveBeenCalledTimes(2)
    expect((await store.getDraft('vault', 'doc-a'))?.content).toBe('settlement-edit')
    await persistence.dispose()
  })

  it('reports failed when the final pre-close persistence fails', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const persistence = makePersistence(store)
    const barrier = await persistence.prepareFileMutation([identity])
    persistence.schedule(snapshot('orphan', 'notes/a', 2))
    const [result] = await barrier.commitDeletes([{
      ...identity,
      policy: 'preserve',
    }])
    expect(result.status).toBe('preserved')
    persistence.schedule(snapshot('settlement-edit', 'notes/a', 3))
    // IndexedDB rejects the settlement-window write.
    backend.failNext('save')
    const finalizeResults = await barrier.finalizeBeforeDocumentClose()

    // The settlement edit is still only in-memory: 'failed' keeps the
    // tab open — it is the only surface still holding those bytes.
    expect(finalizeResults).toEqual([{
      documentId: 'doc-a',
      oldPath: 'notes/a',
      status: 'failed',
    }])
    expect(persistence.findTrackedIdentitiesByPaths(['notes/a'])).toEqual([identity])
    await persistence.dispose()
  })

  it('persists a conflict-channel edit typed during settlement before closing', async () => {
    const gate = gatedStore()
    const { backend, store } = gate
    const persistence = makePersistence(store)
    const { deleting, barrier } = await enterConflictHandoff(persistence, store, backend, gate)
    const [result] = await deleting
    expect(result.status).toBe('conflict')
    // The entry is pinned to the conflict channel (local-v3 promoted,
    // snapshot dropped). The user types during Recovery synchronization
    // — the edit arms a conflict-channel debounce.
    persistence.schedule(snapshot('local-v4', 'notes/a', 4))

    const finalizeResults = await barrier.finalizeBeforeDocumentClose()
    // Successful conflict-channel write → non-warning 'preserved' for
    // the post-close Recovery refresh.
    expect(finalizeResults).toEqual([{
      documentId: 'doc-a',
      oldPath: 'notes/a',
      status: 'preserved',
    }])
    // Persisted as a conflict record IMMEDIATELY — never the primary
    // store (the cross-context record must not be overwritten).
    expect((await store.getDraft('vault', 'doc-a'))?.content).toBe('remote-v3')
    expect((await store.listConflictDrafts('vault')).map((c) => c.content).sort())
      .toEqual(['local-v3', 'local-v4'])
    // The window timer was cleared: no further conflict write fires
    // after the tab closes.
    await vi.advanceTimersByTimeAsync(2400)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    expect((await store.listConflictDrafts('vault')).map((c) => c.content).sort())
      .toEqual(['local-v3', 'local-v4'])
    await persistence.dispose()
  })

  it('skips identities the delete transaction already reported failed', async () => {
    const gate = gatedStore()
    const { backend, store } = gate
    // Every conflict save fails during the delete transaction → the
    // handoff reports 'failed' and arms the background debounce.
    const saveConflict = vi.spyOn(store, 'saveConflictCandidate')
      .mockResolvedValue({ status: 'failed' })
    const persistence = makePersistence(store)
    const { deleting, barrier } = await enterConflictHandoff(persistence, store, backend, gate)
    const [result] = await deleting
    expect(result.status).toBe('failed')

    // finalize must NOT re-report the identity — its tab stays open on
    // the transaction's own 'failed' result, and re-running the write
    // could only duplicate the user-visible warning.
    expect(await barrier.finalizeBeforeDocumentClose()).toEqual([])
    // The armed background retry is untouched: once the store
    // recovers, the debounce persists local-v3 without any further
    // user action.
    saveConflict.mockRestore()
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    expect((await store.listConflictDrafts('vault')).map((c) => c.content))
      .toEqual(['local-v3'])
    expect((await store.getDraft('vault', 'doc-a'))?.content).toBe('remote-v3')
    await persistence.dispose()
  })

  it('reports failed when the post-tab-migration primary write fails', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const persistence = makePersistence(store)
    await store.saveDraft(draft('primary', 'notes/a', 10))
    const barrier = await persistence.prepareFileMutation([identity])
    // An edit typed during the rename request.
    persistence.schedule(snapshot('during', 'notes/a', 2))
    const [move] = await barrier.commitMoves([{
      vaultId: 'vault',
      documentId: 'doc-a',
      fromPath: 'notes/a',
      toPath: 'archive/a-2',
    }])
    expect(move.status).toBe('moved')
    // The immediate write of the transaction-time snapshot to the
    // actual new path is rejected by IndexedDB.
    backend.failNext('save')
    const finalizeResults = await barrier.finalizeAfterTabMigration()

    // The failure is OBSERVABLE: 'failed' with the actual server-
    // suffixed path, so the lifecycle can merge it into the reported
    // results and warn. The family move itself succeeded and is NOT
    // reversed — no draft is recreated on the old path; the record
    // holds the moved content at the new path.
    expect(finalizeResults).toEqual([{
      documentId: 'doc-a',
      oldPath: 'notes/a',
      newPath: 'archive/a-2',
      status: 'failed',
    }])
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      documentPath: 'archive/a-2',
      content: 'primary',
    })
    // The edit is still only in-memory — tracked under the actual new
    // path so flush/dispose can still reach it.
    expect(persistence.findTrackedIdentitiesByPaths(['archive/a-2'])).toEqual([{
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'archive/a-2',
    }])
    await persistence.dispose()
  })

  it('reports failed when the post-tab-migration conflict write fails', async () => {
    const gate = gatedStore()
    const { backend, store } = gate
    const persistence = makePersistence(store)
    const { deleting } = await enterConflictHandoff(persistence, store, backend, gate)
    const [deleteResult] = await deleting
    expect(deleteResult.status).toBe('conflict')
    // The entry is pinned to the conflict channel; a later edit keeps
    // it there, and then the file is renamed: the second transaction
    // moves the family (primary + conflict candidates) to the actual
    // new path.
    persistence.schedule(snapshot('local-v4', 'notes/a', 4))
    const renameBarrier = await persistence.prepareFileMutation([identity])
    const [move] = await renameBarrier.commitMoves([{
      vaultId: 'vault',
      documentId: 'doc-a',
      fromPath: 'notes/a',
      toPath: 'archive/a-2',
    }])
    expect(move.status).toBe('moved')
    // The conflict-channel write of the latest snapshot is rejected.
    vi.spyOn(store, 'saveConflictCandidate').mockResolvedValue({ status: 'failed' })
    const finalizeResults = await renameBarrier.finalizeAfterTabMigration()

    expect(finalizeResults).toEqual([{
      documentId: 'doc-a',
      oldPath: 'notes/a',
      newPath: 'archive/a-2',
      status: 'failed',
    }])
    // The family already moved — the finalize failure must not reverse
    // it: primary at the new path, the promoted candidate moved with it.
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      documentPath: 'archive/a-2',
      content: 'remote-v3',
    })
    expect((await store.listConflictDrafts('vault')).map((c) => c.content))
      .toEqual(['local-v3'])
    // local-v4 is still only in-memory, tracked under the new path.
    expect(persistence.findTrackedIdentitiesByPaths(['archive/a-2'])).toEqual([{
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'archive/a-2',
    }])
    await persistence.dispose()
  })

  // A failed family move reports 'failed' from commitMoves AND puts the
  // identity into pendingReleases. finalize must still RELEASE the
  // entry — only suppressing the duplicate 'failed' result. Without the
  // release the entry keeps the dead barrier's fileTransaction token
  // forever: schedule() never arms a timer, flush() returns false, and
  // pagehide/dispose cannot persist the tab's subsequent edits — the
  // tab the failure deliberately kept open is permanently locked.

  function conflictRecord(conflictId: string, documentId: string, path: string, content: string) {
    return {
      version: 1 as const,
      conflictId,
      vaultId: 'vault',
      documentId,
      documentPath: path,
      content,
      baseContentHash: 'base-hash',
      baseModifiedAt: 10.5,
      createdAt: 5,
      updatedAt: 31,
      origin: 'delete-conflict' as const,
      crossContextUpdatedAt: 30,
      recordedAt: 31,
    }
  }

  it('clears the cached primary when a conflict-only move reports missing', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const persistence = makePersistence(store)
    // The local session persists its primary, then another context
    // deletes the record leaving a conflict-only family behind.
    await store.saveDraft(draft('primary', 'notes/a', 10))
    persistence.schedule(snapshot('rev1', 'notes/a', 1))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await drainWriteQueue()
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({ content: 'rev1' })
    await store.deleteDraft('vault', 'doc-a')
    await store.saveConflictDraft(conflictRecord('conflict-x', 'doc-a', 'notes/a', 'cross-context orphan'))

    // The server rename completes: no primary to move ('missing'), the
    // conflict candidate travels. completeFamilyMove rewrites the cached
    // persistedDraft's path — that phantom must NOT survive the missing
    // move, or a later confirmed delete CASes against a record that no
    // longer exists and reports 'stale' instead of cleaning the family.
    const barrier = await persistence.prepareFileMutation([identity])
    const [move] = await barrier.commitMoves([{
      ...identity,
      fromPath: 'notes/a',
      toPath: 'archive/a',
    }])
    expect(move.status).toBe('missing')
    expect(await barrier.finalizeAfterTabMigration()).toEqual([])

    // A confirmed delete must see the store's truth — no primary — not
    // the phantom record. Freeze the conflict id so the confirmed
    // discard removes the conflict-only family's last row.
    const migrated = { vaultId: 'vault', documentId: 'doc-a', documentPath: 'archive/a' }
    const confirmation = persistence.captureDeleteConfirmation(migrated, 1, undefined, ['conflict-x'])
    const deleteBarrier = await persistence.prepareFileMutation([migrated])
    const [deleted] = await deleteBarrier.commitDeletes([{
      ...migrated,
      policy: 'discard-confirmed',
      confirmation,
    }])

    // 'missing' with no prepare-time confirmed draft: a clean discard
    // accompanied by the frozen-conflict cleanup — not 'stale' (which
    // would keep the phantom identity visible and leave the conflict
    // row alive behind removeIdentity()).
    expect(deleted.status).toBe('missing')
    expect(await store.listConflictDrafts('vault')).toEqual([])
    await persistence.dispose()
  })

  it('releases the entry after a failed family move', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const persistence = makePersistence(store)
    await store.saveDraft(draft('primary', 'notes/a', 10))
    await store.saveConflictDraft(conflictRecord('conflict-a', 'doc-a', 'notes/a', 'local orphan'))
    const barrier = await persistence.prepareFileMutation([identity])
    // An edit typed during the rename request.
    persistence.schedule(snapshot('during', 'notes/a', 2))
    backend.failNext('moveFamilyConflicts')
    const [move] = await barrier.commitMoves([{
      vaultId: 'vault',
      documentId: 'doc-a',
      fromPath: 'notes/a',
      toPath: 'archive/a',
    }])
    expect(move.status).toBe('failed')

    // finalize must NOT re-report the failure the commit already
    // surfaced ...
    expect(await barrier.finalizeAfterTabMigration()).toEqual([])
    // ... but it MUST release the entry, persisting the transaction-
    // time snapshot at the unchanged old path on the way out.
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      documentPath: 'notes/a',
      content: 'during',
    })
    // The family stays intact on the old path.
    expect((await store.listConflictDrafts('vault')).map((c) => c.documentPath))
      .toEqual(['notes/a'])
    // The entry is functional again — flush is no longer blocked by a
    // transaction token that outlived its barrier.
    expect(await persistence.flush('vault', 'doc-a')).toBe(true)
    await persistence.dispose()
  })

  it('allows scheduling and flushing after a failed family move', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const persistence = makePersistence(store)
    await store.saveDraft(draft('primary', 'notes/a', 10))
    await store.saveConflictDraft(conflictRecord('conflict-a', 'doc-a', 'notes/a', 'local orphan'))
    const barrier = await persistence.prepareFileMutation([identity])
    backend.failNext('moveFamilyConflicts')
    const [move] = await barrier.commitMoves([{
      vaultId: 'vault',
      documentId: 'doc-a',
      fromPath: 'notes/a',
      toPath: 'archive/a',
    }])
    expect(move.status).toBe('failed')
    expect(await barrier.finalizeAfterTabMigration()).toEqual([])

    // A post-rename edit arms the debounce again — before the fix the
    // pinned transaction token swallowed the timer and the edit never
    // left memory.
    persistence.schedule(snapshot('after', 'notes/a', 2))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    expect((await store.getDraft('vault', 'doc-a'))?.content).toBe('after')
    // An explicit flush persists a further edit instead of returning
    // false behind the dead token.
    persistence.schedule(snapshot('flushed', 'notes/a', 3))
    expect(await persistence.flush('vault', 'doc-a')).toBe(true)
    expect((await store.getDraft('vault', 'doc-a'))?.content).toBe('flushed')
    await persistence.dispose()
  })

  it('flushes on pagehide after a failed family move', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const targetWindow = new EventTarget()
    const persistence = makePersistence(store, targetWindow)
    await store.saveDraft(draft('primary', 'notes/a', 10))
    await store.saveConflictDraft(conflictRecord('conflict-a', 'doc-a', 'notes/a', 'local orphan'))
    const barrier = await persistence.prepareFileMutation([identity])
    backend.failNext('moveFamilyConflicts')
    const [move] = await barrier.commitMoves([{
      vaultId: 'vault',
      documentId: 'doc-a',
      fromPath: 'notes/a',
      toPath: 'archive/a',
    }])
    expect(move.status).toBe('failed')
    expect(await barrier.finalizeAfterTabMigration()).toEqual([])

    // The user keeps editing after the failed rename; the page hides
    // BEFORE the fresh debounce fires — flushAll must reach the entry.
    persistence.schedule(snapshot('pagehide-edit', 'notes/a', 2))
    targetWindow.dispatchEvent(new Event('pagehide'))
    await vi.waitFor(async () => {
      expect((await store.getDraft('vault', 'doc-a'))?.content).toBe('pagehide-edit')
    })
    await persistence.dispose()
  })

  it('releases every failed identity in a partial folder rename', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const persistence = makePersistence(store)
    const identityB = { vaultId: 'vault', documentId: 'doc-b', documentPath: 'notes/b' }
    await store.saveDraft(draft('primary-a', 'notes/a', 10))
    await store.saveDraft({ ...draft('primary-b', 'notes/b', 10), documentId: 'doc-b' })
    await store.saveConflictDraft(conflictRecord('conflict-a', 'doc-a', 'notes/a', 'local orphan a'))
    await store.saveConflictDraft(conflictRecord('conflict-b', 'doc-b', 'notes/b', 'local orphan b'))
    const barrier = await persistence.prepareFileMutation([identity, identityB])
    // doc-a's family move fails (the injected failure is consumed by
    // the first family move); doc-b's succeeds.
    backend.failNext('moveFamilyConflicts')
    const [moveA, moveB] = await barrier.commitMoves([
      { vaultId: 'vault', documentId: 'doc-a', fromPath: 'notes/a', toPath: 'archive/a' },
      { vaultId: 'vault', documentId: 'doc-b', fromPath: 'notes/b', toPath: 'archive/b' },
    ])
    expect(moveA.status).toBe('failed')
    expect(moveB.status).toBe('moved')

    // finalize must release BOTH entries — the failed one included —
    // without re-reporting the failure commitMoves already surfaced.
    expect(await barrier.finalizeAfterTabMigration()).toEqual([])
    // Both accept new edits again: the failed identity at its unchanged
    // old path, the moved one at the actual new path.
    persistence.schedule(snapshot('after-a', 'notes/a', 2))
    persistence.schedule({ ...snapshot('after-b', 'archive/b', 2), documentId: 'doc-b' })
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      documentPath: 'notes/a',
      content: 'after-a',
    })
    expect(await store.getDraft('vault', 'doc-b')).toMatchObject({
      documentPath: 'archive/b',
      content: 'after-b',
    })
    await persistence.dispose()
  })

  // A write reports durability of the LATEST content, not of whatever
  // revision it happened to save: an edit landing mid-save replaces the
  // snapshot and advances the generation, and the in-flight write must
  // fail closed instead of certifying the entry durable behind a
  // revision that is no longer the latest.

  it('fails closed when a primary finalize write is superseded', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const persistence = makePersistence(store)
    // Gate ONLY the settlement-window primary write so it stays in
    // flight while a newer revision lands.
    const originalSaveDraft = store.saveDraft.bind(store)
    let finalizeSaveStarted = false
    let releaseFinalizeSave!: () => void
    const finalizeSaveGate = new Promise<void>((resolve) => { releaseFinalizeSave = resolve })
    vi.spyOn(store, 'saveDraft').mockImplementation(async (value) => {
      if (value.content === 'settlement-edit') {
        finalizeSaveStarted = true
        await finalizeSaveGate
      }
      return originalSaveDraft(value)
    })
    const barrier = await persistence.prepareFileMutation([identity])
    persistence.schedule(snapshot('orphan', 'notes/a', 2))
    const [result] = await barrier.commitDeletes([{
      ...identity,
      policy: 'preserve',
    }])
    expect(result.status).toBe('preserved')
    persistence.schedule(snapshot('settlement-edit', 'notes/a', 3))
    const finalizing = barrier.finalizeBeforeDocumentClose()
    await vi.waitFor(() => expect(finalizeSaveStarted).toBe(true))
    // The user keeps typing while the rev3 save is in flight. That
    // save will succeed at the store level, but rev4 is not durable —
    // a write that returned true here (the old lenient `return saved`)
    // would certify the entry and let the lifecycle close the tab
    // that is the only surface holding rev4.
    persistence.schedule(snapshot('superseding', 'notes/a', 4))
    releaseFinalizeSave()
    const finalizeResults = await finalizing

    // The superseded write fails closed: the tab stays open ...
    expect(finalizeResults).toEqual([{
      documentId: 'doc-a',
      oldPath: 'notes/a',
      status: 'failed',
    }])
    // ... the store holds the outdated revision (lost nowhere — just
    // not the latest) ...
    expect((await store.getDraft('vault', 'doc-a'))?.content).toBe('settlement-edit')
    // ... and the released seal re-armed the background retry, which
    // persists the latest revision without further user action.
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    expect((await store.getDraft('vault', 'doc-a'))?.content).toBe('superseding')
    await persistence.dispose()
  })

  it('flush fails closed when its write is superseded by a newer edit', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const persistence = makePersistence(store)
    const originalSaveDraft = store.saveDraft.bind(store)
    let saveStarted = false
    let releaseSave!: () => void
    const saveGate = new Promise<void>((resolve) => { releaseSave = resolve })
    vi.spyOn(store, 'saveDraft').mockImplementation(async (value) => {
      if (value.content === 'buffered') {
        saveStarted = true
        await saveGate
      }
      return originalSaveDraft(value)
    })
    persistence.schedule(snapshot('buffered', 'notes/a', 2))
    const flushing = persistence.flush('vault', 'doc-a')
    await vi.waitFor(() => expect(saveStarted).toBe(true))
    // A newer edit lands while the flush's rev2 save is in flight.
    persistence.schedule(snapshot('superseding', 'notes/a', 3))
    releaseSave()

    // The rev2 write reaches the store, but the flush must not report
    // success: the latest revision is still only in memory.
    expect(await flushing).toBe(false)
    expect((await store.getDraft('vault', 'doc-a'))?.content).toBe('buffered')
    // The debounce armed by the newer edit persists rev3.
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    expect((await store.getDraft('vault', 'doc-a'))?.content).toBe('superseding')
    await persistence.dispose()
  })

  it('keeps a tab open when its edit lands during another document\'s finalize write', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const persistence = makePersistence(store)
    const identityB = { vaultId: 'vault', documentId: 'doc-b', documentPath: 'notes/b' }
    // Gate ONLY doc-b's settlement write: doc-a's write settles while
    // the window stays open — the old sequential per-identity finalize
    // verified doc-a here and would close its tab before doc-b's write
    // even started.
    const originalSaveDraft = store.saveDraft.bind(store)
    let bSaveStarted = false
    let releaseBSave!: () => void
    const bSaveGate = new Promise<void>((resolve) => { releaseBSave = resolve })
    vi.spyOn(store, 'saveDraft').mockImplementation(async (value) => {
      if (value.documentId === 'doc-b' && value.content === 'b-window') {
        bSaveStarted = true
        await bSaveGate
      }
      return originalSaveDraft(value)
    })
    const barrier = await persistence.prepareFileMutation([identity, identityB])
    persistence.schedule(snapshot('a-orphan', 'notes/a', 2))
    persistence.schedule({ ...snapshot('b-orphan', 'notes/b', 2), documentId: 'doc-b' })
    const commitResults = await barrier.commitDeletes([
      { ...identity, policy: 'preserve' },
      { ...identityB, policy: 'preserve' },
    ])
    expect(commitResults.map((r) => r.status)).toEqual(['preserved', 'preserved'])
    persistence.schedule(snapshot('a-window', 'notes/a', 3))
    persistence.schedule({ ...snapshot('b-window', 'notes/b', 3), documentId: 'doc-b' })
    const finalizing = barrier.finalizeBeforeDocumentClose()
    await vi.waitFor(() => expect(bSaveStarted).toBe(true))
    // The user keeps typing in doc-a while doc-b's write is in flight.
    persistence.schedule(snapshot('a-late', 'notes/a', 4))
    releaseBSave()
    const finalizeResults = await finalizing

    // doc-a fails closed — its latest revision was never verified
    // durable — while doc-b's verified write reports preserved.
    expect(finalizeResults).toEqual([
      { documentId: 'doc-a', oldPath: 'notes/a', status: 'failed' },
      { documentId: 'doc-b', oldPath: 'notes/b', status: 'preserved' },
    ])
    expect((await store.getDraft('vault', 'doc-b'))?.content).toBe('b-window')
    // doc-a's latest revision lands via the re-armed background retry.
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    expect((await store.getDraft('vault', 'doc-a'))?.content).toBe('a-late')
    await persistence.dispose()
  })

  it('seals all folder-delete identities across the complete finalize phase', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const persistence = makePersistence(store)
    const identityB = { vaultId: 'vault', documentId: 'doc-b', documentPath: 'notes/b' }
    const originalSaveDraft = store.saveDraft.bind(store)
    let bSaveStarted = false
    let releaseBSave!: () => void
    const bSaveGate = new Promise<void>((resolve) => { releaseBSave = resolve })
    const saveDraft = vi.spyOn(store, 'saveDraft').mockImplementation(async (value) => {
      if (value.documentId === 'doc-b' && value.content === 'b-window') {
        bSaveStarted = true
        await bSaveGate
      }
      return originalSaveDraft(value)
    })
    const barrier = await persistence.prepareFileMutation([identity, identityB])
    persistence.schedule(snapshot('a-orphan', 'notes/a', 2))
    persistence.schedule({ ...snapshot('b-orphan', 'notes/b', 2), documentId: 'doc-b' })
    await barrier.commitDeletes([
      { ...identity, policy: 'preserve' },
      { ...identityB, policy: 'preserve' },
    ])
    persistence.schedule(snapshot('a-window', 'notes/a', 3))
    persistence.schedule({ ...snapshot('b-window', 'notes/b', 3), documentId: 'doc-b' })
    const finalizing = barrier.finalizeBeforeDocumentClose()
    await vi.waitFor(() => expect(bSaveStarted).toBe(true))
    // BOTH documents are edited while doc-b's write is in flight.
    persistence.schedule(snapshot('a-late', 'notes/a', 4))
    persistence.schedule({ ...snapshot('b-late', 'notes/b', 4), documentId: 'doc-b' })
    const saveCallsBefore = saveDraft.mock.calls.length
    // The seal spans the COMPLETE finalize phase: no debounce may arm
    // and fire on any sealed identity until the barrier is done. A
    // seal released per identity (or never installed) would let these
    // edits write behind an in-progress close decision.
    await vi.advanceTimersByTimeAsync(5000)
    expect(saveDraft.mock.calls.length).toBe(saveCallsBefore)
    releaseBSave()
    const finalizeResults = await finalizing

    // Both identities were re-dirtied during the phase — both fail
    // closed and keep their tabs open.
    expect(finalizeResults).toEqual([
      { documentId: 'doc-a', oldPath: 'notes/a', status: 'failed' },
      { documentId: 'doc-b', oldPath: 'notes/b', status: 'failed' },
    ])
    // Both latest revisions persist via the re-armed retries.
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    expect((await store.getDraft('vault', 'doc-a'))?.content).toBe('a-late')
    expect((await store.getDraft('vault', 'doc-b'))?.content).toBe('b-late')
    await persistence.dispose()
  })

  // A failed family move quarantines the entry: the tab migrates to the
  // server's new path while the draft family stays whole at the old one.
  // An edit made on the new path must retry the atomic family move
  // BEFORE any primary write — DraftStore accepts the higher-updatedAt
  // draft's path wholesale, so a plain write would move the primary
  // alone and re-split the family. While the retry keeps failing, the
  // latest content lands as a separate move-quarantine candidate and the
  // old family stays whole; a later successful retry unites everyone
  // (candidates travel with the family).

  it('retries the family move when an edit arrives on the post-rename path', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const persistence = makePersistence(store)
    await store.saveDraft(draft('primary', 'notes/a', 10))
    await store.saveConflictDraft(conflictRecord('conflict-a', 'doc-a', 'notes/a', 'local orphan'))
    const barrier = await persistence.prepareFileMutation([identity])
    backend.failNext('moveFamilyConflicts')
    const [move] = await barrier.commitMoves([{
      ...identity,
      fromPath: 'notes/a',
      toPath: 'archive/a',
    }])
    expect(move.status).toBe('failed')
    expect(await barrier.finalizeAfterTabMigration()).toEqual([])

    // The tab now shows the server's new path and the user edits it.
    persistence.schedule(snapshot('after-rename', 'archive/a', 2))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()

    // The debounced write retried the atomic move first — and it
    // succeeded: the family unites at the tab's actual path, primary
    // and conflicts together.
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      documentPath: 'archive/a',
      content: 'after-rename',
    })
    expect((await store.listConflictDrafts('vault')).map((c) => c.documentPath))
      .toEqual(['archive/a'])
    await persistence.dispose()
  })

  it('never writes the primary alone while the move retry keeps failing', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const persistence = makePersistence(store)
    await store.saveDraft(draft('primary', 'notes/a', 10))
    await store.saveConflictDraft(conflictRecord('conflict-a', 'doc-a', 'notes/a', 'local orphan'))
    const barrier = await persistence.prepareFileMutation([identity])
    // Two consecutive family-move failures: the commit consumes
    // 'moveFamily', the first debounced retry consumes
    // 'moveFamilyConflicts', the second retry succeeds.
    backend.failNext('moveFamily')
    backend.failNext('moveFamilyConflicts')
    const [move] = await barrier.commitMoves([{
      ...identity,
      fromPath: 'notes/a',
      toPath: 'archive/a',
    }])
    expect(move.status).toBe('failed')
    expect(await barrier.finalizeAfterTabMigration()).toEqual([])

    // First post-rename edit: the retry fails again. The primary
    // record must NOT move alone — the latest content persists as a
    // separate move-quarantine candidate ON the family's actual path
    // (oldPath). Pinning it to the tab's renamed path would split
    // the family immediately: the primary and the existing candidate
    // stay at notes/a.
    persistence.schedule(snapshot('after-rename', 'archive/a', 2))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      documentPath: 'notes/a',
      content: 'primary',
    })
    const conflicts = await store.listConflictDrafts('vault')
    expect(conflicts).toHaveLength(2)
    expect(conflicts.find((c) => c.conflictId === 'conflict-a')?.documentPath)
      .toBe('notes/a')
    expect(conflicts.find((c) => c.conflictId !== 'conflict-a')).toMatchObject({
      content: 'after-rename',
      documentPath: 'notes/a',
      origin: 'move-conflict',
    })

    // The next edit retries once more — the move succeeds and the
    // whole family (primary plus BOTH candidates) unites at the tab's
    // path. The quarantine candidate recorded by the failed retry
    // travels with the family instead of being stranded.
    persistence.schedule(snapshot('healed', 'archive/a', 3))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      documentPath: 'archive/a',
      content: 'healed',
    })
    expect((await store.listConflictDrafts('vault')).map((c) => c.documentPath).sort())
      .toEqual(['archive/a', 'archive/a'])
    await persistence.dispose()
  })

  // Blockers 1 + 2 tests follow.

  it('fails closed when another context replaces the primary between save and readback', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const persistence = makePersistence(store)
    // Race the write: saveDraft returns true, but the very next
    // store.getDraft() must find a NEWER cross-context record (a higher
    // `updatedAt`) — DraftStore accepts the higher-`updatedAt` draft's
    // path wholesale, so a `saveDraft === true` that ignores the
    // readback would certify content durable that is already gone from
    // the store, and a close seal acting on that true would close the
    // tab holding the only remaining copy.
    const originalSaveDraft = store.saveDraft.bind(store)
    vi.spyOn(store, 'saveDraft').mockImplementation(async (value) => {
      if (value.content === 'local-v3') {
        const result = await originalSaveDraft(value)
        await backend.seedRaw({
          ...remoteV3(),
          content: 'remote-v4',
          updatedAt: 110,
        })
        return result
      }
      return originalSaveDraft(value)
    })
    const barrier = await persistence.prepareFileMutation([identity])
    persistence.schedule(snapshot('orphan', 'notes/a', 2))
    const [result] = await barrier.commitDeletes([{
      ...identity,
      policy: 'preserve',
    }])
    expect(result.status).toBe('preserved')
    persistence.schedule(snapshot('local-v3', 'notes/a', 3))
    const finalizeResults = await barrier.finalizeBeforeDocumentClose()

    // The close seal fails closed — the tab stays open …
    expect(finalizeResults).toEqual([{
      documentId: 'doc-a',
      oldPath: 'notes/a',
      status: 'failed',
    }])
    // … the cross-context record is byte-identical (no fresh-timestamp
    // overwrite that would have buried it) …
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      content: 'remote-v4',
      updatedAt: 110,
    })
    // … the local snapshot survives as an independent conflict
    // candidate pinned to the cross-context marker.
    const conflicts = await store.listConflictDrafts('vault')
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({
      content: 'local-v3',
      documentPath: 'notes/a',
      crossContextUpdatedAt: 110,
      origin: 'delete-conflict',
    })
    expect(conflicts[0].recordedAt).toBeGreaterThan(110)
    // The tab stays tracked on its old path.
    expect(persistence.findTrackedIdentitiesByPaths(['notes/a'])).toEqual([identity])
    // needsWrite was cleared by the handoff: no background retry may
    // re-attempt the primary write behind a no-longer-existing
    // cross-context record.
    const saveDraftSpy = (store.saveDraft as unknown as ReturnType<typeof vi.fn>)
    const beforeAdvance = saveDraftSpy.mock.calls.length
    await vi.advanceTimersByTimeAsync(2400)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    expect(saveDraftSpy.mock.calls.length).toBe(beforeAdvance)
    await persistence.dispose()
  })

  it('preserves the local candidate without overwriting the newer remote draft', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const persistence = makePersistence(store)
    // Warm up the entry so it has a persisted primary + a known
    // previousUpdatedAt baseline.
    persistence.schedule(snapshot('primary', 'notes/a', 1))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    expect((await store.getDraft('vault', 'doc-a'))?.content).toBe('primary')
    // Race the next write: saveDraft returns true, but a cross-context
    // record with a higher updatedAt lands before the readback.
    const originalSaveDraft = store.saveDraft.bind(store)
    vi.spyOn(store, 'saveDraft').mockImplementation(async (value) => {
      if (value.content === 'local-v3') {
        const result = await originalSaveDraft(value)
        await backend.seedRaw({
          ...remoteV3(),
          content: 'remote-v4',
          updatedAt: 110,
        })
        return result
      }
      return originalSaveDraft(value)
    })
    persistence.schedule(snapshot('local-v3', 'notes/a', 2))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()

    // The primary is byte-identical to the cross-context record —
    // never overwritten with a fresh timestamp.
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      content: 'remote-v4',
      updatedAt: 110,
    })
    // Exactly one candidate with the local content and the cross-
    // context marker.
    const conflicts = await store.listConflictDrafts('vault')
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({
      content: 'local-v3',
      documentPath: 'notes/a',
      crossContextUpdatedAt: 110,
    })

    // The entry is pinned to the conflict channel: a follow-up edit
    // lands on a SECOND candidate rather than overwriting the primary
    // behind the cross-context record's back.
    persistence.schedule(snapshot('local-v5', 'notes/a', 3))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    const afterPin = await store.listConflictDrafts('vault')
    expect(afterPin).toHaveLength(2)
    expect(afterPin.map((c) => c.content).sort()).toEqual(['local-v3', 'local-v5'])
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      content: 'remote-v4',
    })
    await persistence.dispose()
  })

  it('keeps the tab open when conflict handoff after readback mismatch fails', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const persistence = makePersistence(store)
    // Race the write: saveDraft returns true but a newer cross-context
    // record lands before the readback.
    const originalSaveDraft = store.saveDraft.bind(store)
    vi.spyOn(store, 'saveDraft').mockImplementation(async (value) => {
      if (value.content === 'local-v3') {
        const result = await originalSaveDraft(value)
        await backend.seedRaw({
          ...remoteV3(),
          content: 'remote-v4',
          updatedAt: 110,
        })
        return result
      }
      return originalSaveDraft(value)
    })
    // The conflict-channel handoff is the last line of defence — when
    // IT fails, the bytes are still only in memory. The close seal
    // must keep the tab open and the background retry must keep
    // retrying the conflict channel instead of falling back to a
    // primary write.
    backend.failNext('saveConflict')
    const barrier = await persistence.prepareFileMutation([identity])
    persistence.schedule(snapshot('orphan', 'notes/a', 2))
    const [result] = await barrier.commitDeletes([{
      ...identity,
      policy: 'preserve',
    }])
    expect(result.status).toBe('preserved')
    persistence.schedule(snapshot('local-v3', 'notes/a', 3))
    const finalizeResults = await barrier.finalizeBeforeDocumentClose()

    // Tab stays open — the only surface still holding local-v3.
    expect(finalizeResults).toEqual([{
      documentId: 'doc-a',
      oldPath: 'notes/a',
      status: 'failed',
    }])
    expect(persistence.findTrackedIdentitiesByPaths(['notes/a'])).toEqual([identity])
    // The primary is still the cross-context record.
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      content: 'remote-v4',
      updatedAt: 110,
    })
    // Re-armed conflict-channel retry persists the candidate once the
    // store recovers — the write flag was NOT cleared by the rejected
    // handoff.
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    const conflicts = await store.listConflictDrafts('vault')
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({
      content: 'local-v3',
      crossContextUpdatedAt: 110,
    })
    // The retry stayed on the conflict channel — the primary is still
    // the cross-context record.
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      content: 'remote-v4',
    })
    await persistence.dispose()
  })

  // Quarantine completeness (blocker 2): every incomplete commitMoves
  // outcome — including 'unsupported' (whole family blocked) and
  // identity mismatch — must quarantine the entry so the store-level
  // family-aware save can reunite the family on the next new-path edit.
  // The store backstop is stateless across page reloads; the in-memory
  // quarantine is the smart orchestrator on top.

  it('unsupported family move followed by an edit on the renamed Tab', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const persistence = makePersistence(store)
    await store.saveDraft(draft('primary', 'notes/a', 10))
    await store.saveConflictDraft(conflictRecord('conflict-a', 'doc-a', 'notes/a', 'local orphan'))
    // An unreadable future-version conflict row blocks the whole
    // family move at the store pre-flight — the entry must quarantine
    // anyway so the tab's next edit cannot bypass the backstop and
    // write the primary alone at the new path.
    await backend.seedRawConflict({
      ...conflictRecord('bad-row', 'doc-a', 'notes/a', 'unreadable'),
      version: 2,
    })
    const barrier = await persistence.prepareFileMutation([identity])
    const [move] = await barrier.commitMoves([{
      ...identity,
      fromPath: 'notes/a',
      toPath: 'archive/a',
    }])
    expect(move.status).toBe('unsupported')
    expect(await barrier.finalizeAfterTabMigration()).toEqual([])

    // The retry fails again at the store pre-flight, so the primary
    // is never moved alone and the unreadable row survives intact. The
    // latest content lands as a separate move-quarantine candidate ON
    // the old family's path (notes/a) — the tab's renamed path would
    // split the family the quarantine exists to keep whole.
    persistence.schedule(snapshot('after-rename', 'archive/a', 2))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      documentPath: 'notes/a',
      content: 'primary',
    })
    const conflicts = await store.listConflictDrafts('vault')
    const quarantineCandidate = conflicts.find((c) => c.conflictId !== 'conflict-a' && c.conflictId !== 'bad-row')
    expect(quarantineCandidate).toMatchObject({
      content: 'after-rename',
      documentPath: 'notes/a',
      origin: 'move-conflict',
    })
    // The original conflict candidate stays on the old path …
    expect(conflicts.find((c) => c.conflictId === 'conflict-a')?.documentPath)
      .toBe('notes/a')
    // … and the unreadable row is still present (the backstop refuses
    // to silently drop it).
    const rawRows = await backend.listConflicts('vault')
    expect(rawRows.some((row) => (
      (row as { conflictId?: string }).conflictId === 'bad-row'
    ))).toBe(true)
    persistence.invalidate('vault', 'doc-a')
    expect(persistence.getDraftCleanupProtection('vault').identityIds)
      .not.toContain(JSON.stringify(['vault', 'doc-a']))
    await persistence.dispose()
  })

  // Drives the entry into the conflict channel at notes/a: a
  // cross-context primary with a higher updatedAt makes the first
  // edit's primary save stale, promoting it to a candidate and pinning
  // pendingConflictId + conflictDocumentPath to notes/a.
  async function pinConflictChannelAtNotesA(
    store: ReturnType<typeof createDraftStore>,
    persistence: ReturnType<typeof makePersistence>,
  ) {
    await store.saveDraft(draft('remote', 'notes/a', 110))
    persistence.schedule(snapshot('local-edit', 'notes/a', 1))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    expect((await store.listConflictDrafts('vault')).map((c) => c.content))
      .toEqual(['local-edit'])
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      content: 'remote',
      documentPath: 'notes/a',
    })
  }

  it('keeps every family member on oldPath when pagehide follows a failed quarantine retry', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const persistence = makePersistence(store)
    await store.saveDraft(draft('primary', 'notes/a', 10))
    await store.saveConflictDraft(conflictRecord('conflict-a', 'doc-a', 'notes/a', 'local orphan'))
    const barrier = await persistence.prepareFileMutation([identity])
    backend.failNext('moveFamily')
    const [move] = await barrier.commitMoves([{
      ...identity,
      fromPath: 'notes/a',
      toPath: 'archive/a',
    }])
    expect(move.status).toBe('failed')
    expect(await barrier.finalizeAfterTabMigration()).toEqual([])

    // The post-rename edit's retry fails once more: the latest content
    // lands as a quarantine candidate ON the old family path (the
    // renamed Tab path would split the family), clearing the write
    // flag — the bytes are durable as a candidate.
    backend.failNext('moveFamilyConflicts')
    persistence.schedule(snapshot('after-rename', 'archive/a', 2))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()

    // pagehide: flush must NOT write a primary record at the renamed
    // path — the quarantine candidate already holds the latest bytes
    // next to the intact old family.
    expect(await persistence.flush('vault', 'doc-a')).toBe(true)
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      documentPath: 'notes/a',
      content: 'primary',
    })
    const conflicts = await store.listConflictDrafts('vault')
    expect(conflicts).toHaveLength(2)
    // Every family member — the existing candidate AND the quarantine
    // candidate — sits at oldPath. Pinning the quarantine candidate to
    // the renamed path would show up here as an archive/a row.
    expect(conflicts.map((c) => c.documentPath).sort())
      .toEqual(['notes/a', 'notes/a'])
    expect(conflicts.find((c) => c.conflictId !== 'conflict-a')).toMatchObject({
      content: 'after-rename',
      origin: 'move-conflict',
    })
    await persistence.dispose()
  })

  it('conflict-pinned transaction-time edit finalizes at newPath when the rename succeeds', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const persistence = makePersistence(store)
    await pinConflictChannelAtNotesA(store, persistence)

    // Rename transaction with a transaction-time edit: the family move
    // succeeds, and the release persists the pending edit on the
    // conflict channel — which must follow the moved family to
    // newPath.
    const barrier = await persistence.prepareFileMutation([identity])
    persistence.schedule(snapshot('tx-edit', 'notes/a', 2))
    const [move] = await barrier.commitMoves([{
      ...identity,
      fromPath: 'notes/a',
      toPath: 'archive/a',
    }])
    expect(move.status).toBe('moved')
    expect(await barrier.finalizeAfterTabMigration()).toEqual([])

    const conflicts = await store.listConflictDrafts('vault')
    // With the pin NOT synced to the move, this candidate would land
    // at notes/a — splitting the family the move just united.
    expect(conflicts.find((c) => c.content === 'tx-edit')).toMatchObject({
      documentPath: 'archive/a',
    })
    // The pre-rename candidate traveled with the family move itself.
    expect(conflicts.find((c) => c.content === 'local-edit')).toMatchObject({
      documentPath: 'archive/a',
    })
    // The primary record moved atomically with its family.
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      content: 'remote',
      documentPath: 'archive/a',
    })
    await persistence.dispose()
  })

  it('conflict-pinned entry keeps writing candidates at newPath after a successful rename', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const persistence = makePersistence(store)
    await pinConflictChannelAtNotesA(store, persistence)

    const barrier = await persistence.prepareFileMutation([identity])
    const [move] = await barrier.commitMoves([{
      ...identity,
      fromPath: 'notes/a',
      toPath: 'archive/a',
    }])
    expect(move.status).toBe('moved')
    expect(await barrier.finalizeAfterTabMigration()).toEqual([])

    // The next keystroke on the migrated Tab persists on the conflict
    // channel — at newPath, following the moved family, never back at
    // the pin's pre-rename path.
    persistence.schedule(snapshot('after-move-edit', 'archive/a', 2))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    const conflicts = await store.listConflictDrafts('vault')
    expect(conflicts.map((c) => c.content).sort())
      .toEqual(['after-move-edit', 'local-edit'])
    expect(conflicts.every((c) => c.documentPath === 'archive/a')).toBe(true)
    // The cross-context primary is untouched (still remote-owned).
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      content: 'remote',
      documentPath: 'archive/a',
    })
    await persistence.dispose()
  })

  it('quarantine healing succeeds while conflict-pinned → next edit stays at newPath', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const persistence = makePersistence(store)
    await pinConflictChannelAtNotesA(store, persistence)

    // The rename's family move fails: quarantine, release at oldPath.
    const barrier = await persistence.prepareFileMutation([identity])
    persistence.schedule(snapshot('tx-edit', 'notes/a', 2))
    backend.failNext('moveFamily')
    const [move] = await barrier.commitMoves([{
      ...identity,
      fromPath: 'notes/a',
      toPath: 'archive/a',
    }])
    expect(move.status).toBe('failed')
    expect(await barrier.finalizeAfterTabMigration()).toEqual([])
    // While the family is still whole at notes/a, the transaction-time
    // edit correctly persists there.
    expect((await store.listConflictDrafts('vault'))
      .find((c) => c.content === 'tx-edit')).toMatchObject({
      documentPath: 'notes/a',
    })

    // The post-rename edit heals the quarantine: the move succeeds and
    // the conflict channel must follow the family to newPath.
    persistence.schedule(snapshot('heal-edit', 'archive/a', 3))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      content: 'remote',
      documentPath: 'archive/a',
    })
    const conflicts = await store.listConflictDrafts('vault')
    expect(conflicts.map((c) => c.content).sort())
      .toEqual(['heal-edit', 'local-edit', 'tx-edit'])
    // Every candidate — the stale-handoff pin, the transaction-time
    // edit AND the healing edit — sits at newPath. Without the pin
    // sync the healing edit would land at notes/a and split the
    // family the move just united.
    expect(conflicts.every((c) => c.documentPath === 'archive/a')).toBe(true)
    await persistence.dispose()
  })

  it('re-pins the conflict channel when the family moved in another context', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const persistence = makePersistence(store)
    await pinConflictChannelAtNotesA(store, persistence)

    // Another context moves the whole family notes/a → archive/a in
    // one atomic family move.
    expect(await store.moveDraftFamily('vault', 'doc-a', 'archive/a'))
      .toMatchObject({ status: 'moved', movedConflicts: 1 })

    // The pinned entry's next edit still carries the stale snapshot
    // path. Its write must discover the moved family and re-pin —
    // writing NOTHING at notes/a (a candidate stranded there would
    // split the family the other context's move just united).
    persistence.schedule(snapshot('local-edit-2', 'notes/a', 2))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await drainWriteQueue()
    const midConflicts = await store.listConflictDrafts('vault')
    expect(midConflicts).toHaveLength(1)
    expect(midConflicts[0]).toMatchObject({
      content: 'local-edit',
      documentPath: 'archive/a',
    })

    // The flush's re-pinned write persists the new candidate at the
    // family's new path — the family ends up whole at archive/a.
    expect(await persistence.flush('vault', 'doc-a')).toBe(true)
    const conflicts = await store.listConflictDrafts('vault')
    expect(conflicts).toHaveLength(2)
    expect(conflicts.every((c) => c.documentPath === 'archive/a')).toBe(true)
    expect(conflicts.map((c) => c.content).sort()).toEqual(['local-edit', 'local-edit-2'])
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      documentPath: 'archive/a',
      content: 'remote',
    })
    await persistence.dispose()
  })

  it('pins an unsupported conflict-only family candidate at the family path, not the stale Tab path', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const persistence = makePersistence(store)
    // Conflict-only family: a single future-version row the store
    // cannot validate, sitting at archive/a. No primary record.
    await backend.seedRawConflict({
      ...conflictRecord('bad-row', 'doc-a', 'archive/a', 'unreadable'),
      version: 2,
    })

    // The stale Tab still edits at notes/a.
    persistence.schedule(snapshot('stale-edit', 'notes/a', 1))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()

    // No primary record is created at the stale path …
    expect(await store.getDraft('vault', 'doc-a')).toBeNull()
    // … the local content lands as a candidate ON the family's path
    // (the raw row's readable documentPath), never at notes/a.
    const conflicts = await store.listConflictDrafts('vault')
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({
      content: 'stale-edit',
      documentPath: 'archive/a',
      origin: 'delete-conflict',
    })
    // The entry is pinned to the conflict channel at archive/a: the
    // next edit follows the family path even though the Tab keeps
    // reporting notes/a.
    persistence.schedule(snapshot('stale-edit-2', 'notes/a', 2))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    const conflicts2 = await store.listConflictDrafts('vault')
    expect(conflicts2).toHaveLength(2)
    expect(conflicts2.every((c) => c.documentPath === 'archive/a')).toBe(true)
    expect(await store.getDraft('vault', 'doc-a')).toBeNull()
    await persistence.dispose()
  })

  it('writes no candidate at the stale path when an unsupported family is split across paths', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const persistence = makePersistence(store)
    // Two raw rows disagree on the path (and one is unreadable): the
    // family location is indeterminate — the store reports
    // familyPath: null and the edit must fail closed.
    await backend.seedRawConflict({
      ...conflictRecord('bad-row', 'doc-a', 'archive/a', 'unreadable'),
      version: 2,
    })
    await store.saveConflictDraft(conflictRecord('valid-row', 'doc-a', 'legacy/a', 'older local'))

    persistence.schedule(snapshot('stale-edit', 'notes/a', 1))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()

    // Nothing new is written anywhere: no candidate at the stale
    // snapshot path (the split the old code created), no candidate at
    // either family side (the store cannot certify either), and no
    // primary record.
    expect(await store.getDraft('vault', 'doc-a')).toBeNull()
    const conflicts = await store.listConflictDrafts('vault')
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].conflictId).toBe('valid-row')
    // The write flag stays set: flush fails closed so the tab stays
    // open — the only surface still holding the bytes.
    expect(await persistence.flush('vault', 'doc-a')).toBe(false)
    expect(await store.getDraft('vault', 'doc-a')).toBeNull()
    expect(await store.listConflictDrafts('vault')).toHaveLength(1)
    persistence.invalidate('vault', 'doc-a')
    expect(persistence.getDraftCleanupProtection('vault').identityIds)
      .not.toContain(JSON.stringify(['vault', 'doc-a']))
    await persistence.dispose()
  })

  it('moved-write-failed settles the family then auto-retries the write without user input', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const settlements: Array<{
      status: 'moved-and-persisted' | 'moved-write-failed' | 'path-authentication-pending' | 'conflict'
    }> = []
    const persistence = createUnsavedDraftPersistence({
      store,
      debounceMs: 800,
      now: () => 100,
      onDraftFamilyMoveSettled: (settlement) => {
        settlements.push(settlement)
      },
    })
    await store.saveDraft(draft('primary', 'notes/a', 10))
    await store.saveConflictDraft(conflictRecord('conflict-a', 'doc-a', 'notes/a', 'local orphan'))
    const barrier = await persistence.prepareFileMutation([identity])
    backend.failNext('moveFamily')
    const [move] = await barrier.commitMoves([{
      ...identity,
      fromPath: 'notes/a',
      toPath: 'archive/a',
    }])
    expect(move.status).toBe('failed')
    expect(await barrier.finalizeAfterTabMigration()).toEqual([])

    // The retry heals the family at newPath, but the final primary
    // write is rejected once — settlement reports moved-write-failed.
    const originalSaveDraft = store.saveDraft.bind(store)
    let saveCalls = 0
    vi.spyOn(store, 'saveDraft').mockImplementation(async (value) => {
      saveCalls += 1
      if (saveCalls === 1) return { status: 'failed' as const }
      return originalSaveDraft(value)
    })
    persistence.schedule(snapshot('after-rename', 'archive/a', 2))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    // The failed final write reports moved-write-failed; the bounded
    // auto-retry's success reports moved-and-persisted, which is what
    // refreshes the Recovery identity and open tabs against the
    // durable state.
    expect(settlements.map((s) => s.status))
      .toEqual(['moved-write-failed', 'moved-and-persisted'])
    // The bounded auto-retry (800ms first backoff step) fired with NO
    // user input,
    // manual flush or pagehide, and persisted the latest snapshot on
    // the entry's active channel — the toast promise is real.
    expect(saveCalls).toBe(2)
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      documentPath: 'archive/a',
      content: 'after-rename',
    })
    // Nothing left to retry: a long wait fires no further save.
    await vi.advanceTimersByTimeAsync(120000)
    expect(saveCalls).toBe(2)
    await persistence.dispose()
  })

  it('bounds the moved-write-failed auto-retry to its backoff budget', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const settlements: Array<{
      status: 'moved-and-persisted' | 'moved-write-failed' | 'path-authentication-pending' | 'conflict'
    }> = []
    const persistence = createUnsavedDraftPersistence({
      store,
      debounceMs: 800,
      now: () => 100,
      onDraftFamilyMoveSettled: (settlement) => {
        settlements.push(settlement)
      },
    })
    await store.saveDraft(draft('primary', 'notes/a', 10))
    await store.saveConflictDraft(conflictRecord('conflict-a', 'doc-a', 'notes/a', 'local orphan'))
    const barrier = await persistence.prepareFileMutation([identity])
    backend.failNext('moveFamily')
    const [move] = await barrier.commitMoves([{
      ...identity,
      fromPath: 'notes/a',
      toPath: 'archive/a',
    }])
    expect(move.status).toBe('failed')
    expect(await barrier.finalizeAfterTabMigration()).toEqual([])

    // Every write is rejected: the family heals at newPath but the
    // snapshot can never persist.
    const saveDraft = vi.spyOn(store, 'saveDraft')
      .mockRejectedValue(new Error('store down'))
    persistence.schedule(snapshot('after-rename', 'archive/a', 2))
    await vi.advanceTimersByTimeAsync(800)
    // runAllTimersAsync drains the WHOLE retry budget
    // (800ms + 2s + 5s) and terminates — no infinite high-frequency
    // retry loop.
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(settlements.map((s) => s.status)).toEqual(['moved-write-failed'])
    // One failed final write + exactly three bounded retries.
    expect(saveDraft).toHaveBeenCalledTimes(4)
    // The snapshot is still only in memory — the write flag stayed set
    // so flush / pagehide keep failing closed.
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      documentPath: 'archive/a',
      content: 'primary',
    })
    // A long wait arms no further retry: the budget is per settlement
    // event and deliberately not extended by failures.
    await vi.advanceTimersByTimeAsync(600000)
    expect(saveDraft).toHaveBeenCalledTimes(4)
    // A manual flush still retries the channel (the tab is the visible
    // surface holding the bytes).
    expect(await persistence.flush('vault', 'doc-a')).toBe(false)
    expect(saveDraft).toHaveBeenCalledTimes(5)
    await persistence.dispose()
  })

  async function drainWriteQueue(times = 6): Promise<void> {
    for (let i = 0; i < times; i += 1) await Promise.resolve()
  }

  it('arms the first moved-write-failed auto-retry at the 800ms backoff step', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const settlements: Array<{
      status: 'moved-and-persisted' | 'moved-write-failed' | 'path-authentication-pending' | 'conflict'
    }> = []
    const persistence = createUnsavedDraftPersistence({
      store,
      debounceMs: 800,
      now: () => 100,
      onDraftFamilyMoveSettled: (settlement) => {
        settlements.push(settlement)
      },
    })
    await store.saveDraft(draft('primary', 'notes/a', 10))
    await store.saveConflictDraft(conflictRecord('conflict-a', 'doc-a', 'notes/a', 'local orphan'))
    const barrier = await persistence.prepareFileMutation([identity])
    backend.failNext('moveFamily')
    const [move] = await barrier.commitMoves([{
      ...identity,
      fromPath: 'notes/a',
      toPath: 'archive/a',
    }])
    expect(move.status).toBe('failed')
    expect(await barrier.finalizeAfterTabMigration()).toEqual([])

    const originalSaveDraft = store.saveDraft.bind(store)
    let saveCalls = 0
    vi.spyOn(store, 'saveDraft').mockImplementation(async (value) => {
      saveCalls += 1
      if (saveCalls === 1) return { status: 'failed' as const }
      return originalSaveDraft(value)
    })
    persistence.schedule(snapshot('after-rename', 'archive/a', 2))
    await vi.advanceTimersByTimeAsync(800)
    await drainWriteQueue()
    expect(settlements.map((s) => s.status)).toEqual(['moved-write-failed'])
    expect(saveCalls).toBe(1)

    // Just before the first backoff step nothing has re-run …
    await vi.advanceTimersByTimeAsync(799)
    await drainWriteQueue()
    expect(saveCalls).toBe(1)
    // … and AT 800ms the retry fires with no user input, manual flush
    // or pagehide — the first step of the bounded backoff schedule.
    await vi.advanceTimersByTimeAsync(1)
    await drainWriteQueue()
    expect(saveCalls).toBe(2)
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      documentPath: 'archive/a',
      content: 'after-rename',
    })
    await persistence.dispose()
  })

  it('reports moved-and-persisted when the bounded auto-retry finally persists the snapshot', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const settlements: Array<{
      status: 'moved-and-persisted' | 'moved-write-failed' | 'path-authentication-pending' | 'conflict'
      oldPath: string | null
      newPath: string
    }> = []
    const persistence = createUnsavedDraftPersistence({
      store,
      debounceMs: 800,
      now: () => 100,
      onDraftFamilyMoveSettled: (settlement) => {
        settlements.push(settlement)
      },
    })
    await store.saveDraft(draft('primary', 'notes/a', 10))
    await store.saveConflictDraft(conflictRecord('conflict-a', 'doc-a', 'notes/a', 'local orphan'))
    const barrier = await persistence.prepareFileMutation([identity])
    backend.failNext('moveFamily')
    const [move] = await barrier.commitMoves([{
      ...identity,
      fromPath: 'notes/a',
      toPath: 'archive/a',
    }])
    expect(move.status).toBe('failed')
    expect(await barrier.finalizeAfterTabMigration()).toEqual([])

    const originalSaveDraft = store.saveDraft.bind(store)
    let saveCalls = 0
    vi.spyOn(store, 'saveDraft').mockImplementation(async (value) => {
      saveCalls += 1
      if (saveCalls === 1) return { status: 'failed' as const }
      return originalSaveDraft(value)
    })
    persistence.schedule(snapshot('after-rename', 'archive/a', 2))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await drainWriteQueue()

    // The failed final write reports moved-write-failed; when the
    // auto-retry persists the snapshot the persistence layer must
    // report moved-and-persisted — that settlement is what refreshes
    // the Recovery identity and every open Recovery tab against the
    // durable state (VaultView's settlement handler), and it clears
    // the retry state.
    expect(settlements.map((s) => s.status))
      .toEqual(['moved-write-failed', 'moved-and-persisted'])
    expect(settlements[1]).toMatchObject({
      oldPath: 'notes/a',
      newPath: 'archive/a',
    })
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      documentPath: 'archive/a',
      content: 'after-rename',
    })
    // Retry state cleared: nothing left to persist, flush reports
    // clean instead of re-running the channel.
    expect(await persistence.flush('vault', 'doc-a')).toBe(true)
    expect(saveCalls).toBe(2)
    await persistence.dispose()
  })

  it('a new user edit resets the moved-write-failed backoff instead of stacking retries', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const settlements: Array<{
      status: 'moved-and-persisted' | 'moved-write-failed' | 'path-authentication-pending' | 'conflict'
    }> = []
    const persistence = createUnsavedDraftPersistence({
      store,
      debounceMs: 800,
      now: () => 100,
      onDraftFamilyMoveSettled: (settlement) => {
        settlements.push(settlement)
      },
    })
    await store.saveDraft(draft('primary', 'notes/a', 10))
    await store.saveConflictDraft(conflictRecord('conflict-a', 'doc-a', 'notes/a', 'local orphan'))
    const barrier = await persistence.prepareFileMutation([identity])
    backend.failNext('moveFamily')
    const [move] = await barrier.commitMoves([{
      ...identity,
      fromPath: 'notes/a',
      toPath: 'archive/a',
    }])
    expect(move.status).toBe('failed')
    expect(await barrier.finalizeAfterTabMigration()).toEqual([])

    const saveDraft = vi.spyOn(store, 'saveDraft')
      .mockRejectedValue(new Error('store down'))
    persistence.schedule(snapshot('after-rename', 'archive/a', 2))
    await vi.advanceTimersByTimeAsync(800)
    await drainWriteQueue()
    expect(settlements.map((s) => s.status)).toEqual(['moved-write-failed'])
    expect(saveDraft).toHaveBeenCalledTimes(1)
    // Halfway into the first backoff step …
    await vi.advanceTimersByTimeAsync(400)
    await drainWriteQueue()
    expect(saveDraft).toHaveBeenCalledTimes(1)
    // … the user types again: schedule() clears the armed retry and
    // the new debounce owns persistence — the old backoff chain must
    // NOT fire on top of it.
    persistence.schedule(snapshot('user-edit', 'archive/a', 3))
    await vi.advanceTimersByTimeAsync(800)
    await drainWriteQueue()
    expect(saveDraft).toHaveBeenCalledTimes(2)
    // No stray timer survives from the cleared chain.
    await vi.advanceTimersByTimeAsync(600000)
    expect(saveDraft).toHaveBeenCalledTimes(2)
    // Pending stays set — a manual flush retries the channel.
    expect(await persistence.flush('vault', 'doc-a')).toBe(false)
    expect(saveDraft).toHaveBeenCalledTimes(3)
    await persistence.dispose()
  })

  it('an indeterminate family stops re-probing the store until the next user edit', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const persistence = makePersistence(store)
    // Split family: the rows disagree on the path (and one is
    // unreadable) — the store reports familyPath: null, reason
    // split-conflict-paths, and the entry turns indeterminate.
    await backend.seedRawConflict({
      ...conflictRecord('bad-row', 'doc-a', 'archive/a', 'unreadable'),
      version: 2,
    })
    await store.saveConflictDraft(conflictRecord('valid-row', 'doc-a', 'legacy/a', 'older local'))
    const saveDraft = vi.spyOn(store, 'saveDraft')

    persistence.schedule(snapshot('stale-edit', 'notes/a', 1))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await drainWriteQueue()
    expect(saveDraft).toHaveBeenCalledTimes(1)
    expect(await store.getDraft('vault', 'doc-a')).toBeNull()

    // Indeterminate entries fail closed WITHOUT hammering the store
    // with speculative re-reads on every flush / pagehide …
    expect(await persistence.flush('vault', 'doc-a')).toBe(false)
    expect(saveDraft).toHaveBeenCalledTimes(1)

    // … until the user edits again: schedule() re-arms the probe (the
    // family may have been healed server-side in the meantime).
    persistence.schedule(snapshot('user-edit', 'notes/a', 2))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await drainWriteQueue()
    expect(saveDraft).toHaveBeenCalledTimes(2)
    expect(await store.getDraft('vault', 'doc-a')).toBeNull()
    expect(await store.listConflictDrafts('vault')).toHaveLength(1)
    await persistence.dispose()
  })

  it('close seal fails closed while the family stays indeterminate', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const persistence = makePersistence(store)
    await backend.seedRawConflict({
      ...conflictRecord('bad-row', 'doc-a', 'archive/a', 'unreadable'),
      version: 2,
    })
    await store.saveConflictDraft(conflictRecord('valid-row', 'doc-a', 'legacy/a', 'older local'))

    // Delete transaction preserves the identity and releases the entry;
    // the user edits during the settlement window.
    const barrier = await persistence.prepareFileMutation([identity])
    const [result] = await barrier.commitDeletes([{
      ...identity,
      policy: 'preserve',
    }])
    expect(result.status).toBe('preserved')
    persistence.schedule(snapshot('stale-edit', 'notes/a', 1))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await drainWriteQueue()
    // Split family → no safe path → the debounce write fails closed.
    expect(await store.getDraft('vault', 'doc-a')).toBeNull()

    // The lifecycle tries to close the tab: the seal must fail closed
    // too — the bytes are still only in memory, so the tab stays open
    // and no candidate is written to any guessed path.
    expect(await barrier.finalizeBeforeDocumentClose()).toEqual([{
      documentId: 'doc-a',
      oldPath: 'notes/a',
      status: 'failed',
    }])
    expect(await store.getDraft('vault', 'doc-a')).toBeNull()
    expect(await store.listConflictDrafts('vault')).toHaveLength(1)
    await persistence.dispose()
  })

  it('close seal fails closed for an indeterminate family whose rename could not move', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const persistence = makePersistence(store)
    // Split family: the stale tab's edit turns the entry indeterminate
    // — the store cannot certify ANY family path.
    await backend.seedRawConflict({
      ...conflictRecord('bad-row', 'doc-a', 'archive/a', 'unreadable'),
      version: 2,
    })
    await store.saveConflictDraft(conflictRecord('valid-row', 'doc-a', 'legacy/a', 'older local'))
    persistence.schedule(snapshot('stale-edit', 'notes/a', 1))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await drainWriteQueue()
    expect(await store.getDraft('vault', 'doc-a')).toBeNull()

    // The server rename succeeds; the draft family move is blocked by
    // the unreadable row. The entry must NOT receive a guessed family
    // path from the rename's fromPath — there is no certified path.
    const barrier = await persistence.prepareFileMutation([identity])
    const [move] = await barrier.commitMoves([{
      ...identity,
      fromPath: 'notes/a',
      toPath: 'archive/b',
    }])
    expect(move.status).toBe('unsupported')
    // The entry is move-indeterminate: the family has NO certified
    // path, so the release's immediate move retry writes NOTHING and
    // fails closed — finalize reports 'failed' (the transaction-time
    // edit is still only in-memory; the lifecycle keeps the tab open
    // and warns). The old code reported [] here because the release
    // wrote the primary record at the rename's GUESSED fromPath.
    expect(await barrier.finalizeAfterTabMigration()).toEqual([{
      documentId: 'doc-a',
      oldPath: 'notes/a',
      newPath: 'archive/b',
      status: 'failed',
    }])

    // The post-rename edit is the only copy of those bytes. The
    // identity already carries a fail-closed 'failed' report (its tab
    // stays open on it), so the close seal deliberately skips a
    // duplicate report — while the write itself stays blocked: no
    // candidate at any guessed path (neither the rename's fromPath nor
    // the tab path), the write flag stays set and flush keeps failing
    // closed until a safe probe succeeds.
    persistence.schedule(snapshot('after-rename', 'archive/b', 2))
    expect(await barrier.finalizeBeforeDocumentClose()).toEqual([])
    expect(await persistence.flush('vault', 'doc-a')).toBe(false)
    // The bytes stay tracked (the tab the 'failed' report keeps open
    // is still the only surface holding them).
    expect(persistence.findTrackedIdentitiesByPaths(['archive/b'])).toEqual([{
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'archive/b',
    }])
    expect(await store.getDraft('vault', 'doc-a')).toBeNull()
    const conflicts = await store.listConflictDrafts('vault')
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({
      conflictId: 'valid-row',
      documentPath: 'legacy/a',
    })
    await persistence.dispose()
  })

  it('an indeterminate family move re-verifies the current path and adopts it instead of blind-moving', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const settlements: Array<{
      oldPath: string | null
      newPath: string
      status: 'moved-and-persisted' | 'moved-write-failed' | 'path-authentication-pending' | 'conflict'
    }> = []
    const persistence = createUnsavedDraftPersistence({
      store,
      debounceMs: 800,
      now: () => 100,
      onDraftFamilyMoveSettled: (settlement) => {
        settlements.push(settlement)
      },
    })
    await backend.seedRawConflict({
      ...conflictRecord('bad-row', 'doc-a', 'archive/a', 'unreadable'),
      version: 2,
    })
    await store.saveConflictDraft(conflictRecord('valid-row', 'doc-a', 'legacy/a', 'older local'))
    persistence.schedule(snapshot('stale-edit', 'notes/a', 1))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await drainWriteQueue()

    // Indeterminate family + successful server rename + blocked draft
    // move: the entry keeps attempting the atomic family move toward
    // the server path — with NO certified oldPath to fall back to.
    const barrier = await persistence.prepareFileMutation([identity])
    const [move] = await barrier.commitMoves([{
      ...identity,
      fromPath: 'notes/a',
      toPath: 'archive/b',
    }])
    expect(move.status).toBe('unsupported')
    // move-indeterminate: the release's immediate move retry has no
    // certified oldPath, writes nothing and fails closed — finalize
    // reports 'failed', the write flag stays set for the next probe.
    expect(await barrier.finalizeAfterTabMigration()).toEqual([{
      documentId: 'doc-a',
      oldPath: 'notes/a',
      newPath: 'archive/b',
      status: 'failed',
    }])
    persistence.schedule(snapshot('after-rename', 'archive/b', 2))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await drainWriteQueue()
    // The retry still fails — nothing is written, the write flag stays
    // set, and flush fails closed.
    expect(await persistence.flush('vault', 'doc-a')).toBe(false)
    expect(await store.getDraft('vault', 'doc-a')).toBeNull()

    // The unreadable row disappears server-side — but the family does
    // NOT sit at the stale serverPath: it lives at legacy/a (the valid
    // candidate's certified path). The retry must re-verify the family
    // FIRST and never blind-move "whatever is there" to the stale
    // server target: it finds the certified current path legacy/a ≠
    // serverPath archive/b, moves NOTHING, and persists the latest
    // bytes as a candidate at the certified current path.
    await backend.deleteConflict('vault', 'doc-a', 'bad-row')
    expect(await persistence.flush('vault', 'doc-a')).toBe(true)
    // No primary was minted toward the stale server path — the blind
    // move that used to drag the family to archive/b is gone.
    expect(await store.getDraft('vault', 'doc-a')).toBeNull()
    // The bytes are durable as a candidate at the certified current
    // path, beside the family's existing candidate — the family itself
    // never moved toward archive/b.
    const conflicts = await store.listConflictDrafts('vault')
    expect(conflicts).toHaveLength(2)
    expect(conflicts.map((c) => c.documentPath).sort())
      .toEqual(['legacy/a', 'legacy/a'])
    expect(conflicts.find((c) => c.conflictId !== 'valid-row')).toMatchObject({
      content: 'after-rename',
      origin: 'move-conflict',
      documentPath: 'legacy/a',
    })
    // The adoption settles as a conflict — never a move completion
    // toward the unverified server path.
    expect(settlements.some((s) => s.status === 'conflict')).toBe(true)
    expect(settlements.some((s) => s.status === 'moved-and-persisted')).toBe(false)
    await persistence.dispose()
  })

  it('dispose after a failed quarantine retry persists the candidate at oldPath', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const persistence = makePersistence(store)
    await store.saveDraft(draft('primary', 'notes/a', 10))
    await store.saveConflictDraft(conflictRecord('conflict-a', 'doc-a', 'notes/a', 'local orphan'))
    const barrier = await persistence.prepareFileMutation([identity])
    backend.failNext('moveFamily')
    const [move] = await barrier.commitMoves([{
      ...identity,
      fromPath: 'notes/a',
      toPath: 'archive/a',
    }])
    expect(move.status).toBe('failed')
    expect(await barrier.finalizeAfterTabMigration()).toEqual([])

    // The post-rename edit's debounce has not fired when the app shuts
    // down: dispose's final flush must route the write through the
    // quarantine retry and — when that fails — persist the latest
    // bytes as a candidate at oldPath, never at the renamed Tab path.
    backend.failNext('moveFamilyConflicts')
    persistence.schedule(snapshot('after-rename', 'archive/a', 2))
    await persistence.dispose()

    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      documentPath: 'notes/a',
      content: 'primary',
    })
    const conflicts = await store.listConflictDrafts('vault')
    expect(conflicts).toHaveLength(2)
    expect(conflicts.map((c) => c.documentPath).sort())
      .toEqual(['notes/a', 'notes/a'])
    expect(conflicts.find((c) => c.conflictId !== 'conflict-a')).toMatchObject({
      content: 'after-rename',
      origin: 'move-conflict',
    })
  })

  // Dual-window chained rename: context A's rename A→B succeeds on the
  // server but its draft family move fails (quarantine
  // {familyPath: notes/a, serverPath: archive/a}). Context B then
  // renames B→C and moves the family to final/a. A stale retry from
  // context A must NOT drag the family back from final/a to its old
  // server target archive/a — the store refuses the move (CAS against
  // the expected path), and A adopts the certified current path: its
  // bytes persist as a candidate at final/a, the family stays where
  // the server put it.

  it('a stale quarantine retry fired by manual flush adopts the certified current path', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    // Context B shares the same draft database.
    const storeB = createDraftStore({ backend })
    const settlements: Array<{
      oldPath: string | null
      newPath: string
      status: 'moved-and-persisted' | 'moved-write-failed' | 'path-authentication-pending' | 'conflict'
    }> = []
    const persistence = createUnsavedDraftPersistence({
      store,
      debounceMs: 800,
      now: () => 100,
      onDraftFamilyMoveSettled: (settlement) => {
        settlements.push(settlement)
      },
    })
    await store.saveDraft(draft('primary', 'notes/a', 10))
    await store.saveConflictDraft(conflictRecord('conflict-a', 'doc-a', 'notes/a', 'local orphan'))
    // Context A's rename notes/a→archive/a: server succeeds, draft
    // family move fails → quarantine at familyPath notes/a.
    const barrier = await persistence.prepareFileMutation([identity])
    backend.failNext('moveFamily')
    const [move] = await barrier.commitMoves([{
      ...identity,
      fromPath: 'notes/a',
      toPath: 'archive/a',
    }])
    expect(move.status).toBe('failed')
    expect(await barrier.finalizeAfterTabMigration()).toEqual([])
    // Context B's verified rename moves the whole family to final/a.
    expect((await storeB.moveDraftFamily('vault', 'doc-a', 'final/a')).status)
      .toBe('moved')

    // Context A's stale quarantine retry fires via manual flush — the
    // CAS move refuses (the family no longer sits at notes/a) and A
    // adopts the certified current path: its bytes persist as a
    // candidate at final/a, the family is never dragged to archive/a.
    persistence.schedule(snapshot('after-rename', 'archive/a', 2))
    expect(await persistence.flush('vault', 'doc-a')).toBe(true)
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      documentPath: 'final/a',
      content: 'primary',
    })
    const conflicts = await store.listConflictDrafts('vault')
    expect(conflicts).toHaveLength(2)
    expect(conflicts.map((c) => c.documentPath).sort())
      .toEqual(['final/a', 'final/a'])
    expect(conflicts.find((c) => c.conflictId !== 'conflict-a')).toMatchObject({
      content: 'after-rename',
      origin: 'move-conflict',
      documentPath: 'final/a',
    })
    expect(settlements.some((s) => s.status === 'conflict')).toBe(true)
    expect(settlements.some((s) => s.status === 'moved-and-persisted')).toBe(false)

    // The entry now writes on the conflict channel at the certified
    // current path: the next edit lands as a candidate at final/a,
    // never as a primary write at the stale server target.
    persistence.schedule(snapshot('next-edit', 'archive/a', 3))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await drainWriteQueue()
    expect((await store.listConflictDrafts('vault'))
      .find((c) => c.content === 'next-edit')).toMatchObject({
      documentPath: 'final/a',
    })
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      documentPath: 'final/a',
      content: 'primary',
    })
    await persistence.dispose()
  })

  it('a stale quarantine retry fired by the debounce adopts the certified current path', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const storeB = createDraftStore({ backend })
    const settlements: Array<{
      status: 'moved-and-persisted' | 'moved-write-failed' | 'path-authentication-pending' | 'conflict'
    }> = []
    const persistence = createUnsavedDraftPersistence({
      store,
      debounceMs: 800,
      now: () => 100,
      onDraftFamilyMoveSettled: (settlement) => {
        settlements.push(settlement)
      },
    })
    await store.saveDraft(draft('primary', 'notes/a', 10))
    await store.saveConflictDraft(conflictRecord('conflict-a', 'doc-a', 'notes/a', 'local orphan'))
    const barrier = await persistence.prepareFileMutation([identity])
    backend.failNext('moveFamily')
    const [move] = await barrier.commitMoves([{
      ...identity,
      fromPath: 'notes/a',
      toPath: 'archive/a',
    }])
    expect(move.status).toBe('failed')
    expect(await barrier.finalizeAfterTabMigration()).toEqual([])
    expect((await storeB.moveDraftFamily('vault', 'doc-a', 'final/a')).status)
      .toBe('moved')

    // Same stale retry, fired by the post-rename edit's debounce
    // instead of a manual flush.
    persistence.schedule(snapshot('after-rename', 'archive/a', 2))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await drainWriteQueue()
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      documentPath: 'final/a',
      content: 'primary',
    })
    const conflicts = await store.listConflictDrafts('vault')
    expect(conflicts).toHaveLength(2)
    expect(conflicts.map((c) => c.documentPath).sort())
      .toEqual(['final/a', 'final/a'])
    expect(conflicts.find((c) => c.conflictId !== 'conflict-a')).toMatchObject({
      content: 'after-rename',
      origin: 'move-conflict',
      documentPath: 'final/a',
    })
    expect(settlements.some((s) => s.status === 'conflict')).toBe(true)
    expect(settlements.some((s) => s.status === 'moved-and-persisted')).toBe(false)
    await persistence.dispose()
  })

  it('a stale quarantine retry fired by pagehide adopts the certified current path', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const storeB = createDraftStore({ backend })
    const targetWindow = new EventTarget()
    const persistence = makePersistence(store, targetWindow)
    await store.saveDraft(draft('primary', 'notes/a', 10))
    await store.saveConflictDraft(conflictRecord('conflict-a', 'doc-a', 'notes/a', 'local orphan'))
    const barrier = await persistence.prepareFileMutation([identity])
    backend.failNext('moveFamily')
    const [move] = await barrier.commitMoves([{
      ...identity,
      fromPath: 'notes/a',
      toPath: 'archive/a',
    }])
    expect(move.status).toBe('failed')
    expect(await barrier.finalizeAfterTabMigration()).toEqual([])
    expect((await storeB.moveDraftFamily('vault', 'doc-a', 'final/a')).status)
      .toBe('moved')

    // Same stale retry, fired by pagehide before the debounce elapses.
    persistence.schedule(snapshot('after-rename', 'archive/a', 2))
    targetWindow.dispatchEvent(new Event('pagehide'))
    await vi.waitFor(async () => {
      const conflicts = await store.listConflictDrafts('vault')
      expect(conflicts.some(
        (c) => c.content === 'after-rename' && c.documentPath === 'final/a',
      )).toBe(true)
    })
    // The family stays at B's certified path — pagehide's flush must
    // not drag it back to the quarantine's old server target.
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      documentPath: 'final/a',
      content: 'primary',
    })
    await persistence.dispose()
  })

  it('a stale quarantine retry fired by dispose adopts the certified current path', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const storeB = createDraftStore({ backend })
    const persistence = makePersistence(store)
    await store.saveDraft(draft('primary', 'notes/a', 10))
    await store.saveConflictDraft(conflictRecord('conflict-a', 'doc-a', 'notes/a', 'local orphan'))
    const barrier = await persistence.prepareFileMutation([identity])
    backend.failNext('moveFamily')
    const [move] = await barrier.commitMoves([{
      ...identity,
      fromPath: 'notes/a',
      toPath: 'archive/a',
    }])
    expect(move.status).toBe('failed')
    expect(await barrier.finalizeAfterTabMigration()).toEqual([])
    expect((await storeB.moveDraftFamily('vault', 'doc-a', 'final/a')).status)
      .toBe('moved')

    // Same stale retry, fired by dispose's final flush before the
    // debounce elapses (app shutdown mid-quarantine).
    persistence.schedule(snapshot('after-rename', 'archive/a', 2))
    await persistence.dispose()
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      documentPath: 'final/a',
      content: 'primary',
    })
    const conflicts = await store.listConflictDrafts('vault')
    expect(conflicts).toHaveLength(2)
    expect(conflicts.map((c) => c.documentPath).sort())
      .toEqual(['final/a', 'final/a'])
    expect(conflicts.find((c) => c.conflictId !== 'conflict-a')).toMatchObject({
      content: 'after-rename',
      origin: 'move-conflict',
      documentPath: 'final/a',
    })
  })

  it('a move-indeterminate retry completes once the family is re-verified at the server path', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const storeB = createDraftStore({ backend })
    const settlements: Array<{
      oldPath: string | null
      newPath: string
      status: 'moved-and-persisted' | 'moved-write-failed' | 'path-authentication-pending' | 'conflict'
    }> = []
    const persistence = createUnsavedDraftPersistence({
      store,
      debounceMs: 800,
      now: () => 100,
      onDraftFamilyMoveSettled: (settlement) => {
        settlements.push(settlement)
      },
    })
    await backend.seedRawConflict({
      ...conflictRecord('bad-row', 'doc-a', 'archive/a', 'unreadable'),
      version: 2,
    })
    await store.saveConflictDraft(conflictRecord('valid-row', 'doc-a', 'legacy/a', 'older local'))
    persistence.schedule(snapshot('stale-edit', 'notes/a', 1))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await drainWriteQueue()
    const barrier = await persistence.prepareFileMutation([identity])
    const [move] = await barrier.commitMoves([{
      ...identity,
      fromPath: 'notes/a',
      toPath: 'archive/b',
    }])
    expect(move.status).toBe('unsupported')
    expect(await barrier.finalizeAfterTabMigration()).toEqual([{
      documentId: 'doc-a',
      oldPath: 'notes/a',
      newPath: 'archive/b',
      status: 'failed',
    }])
    persistence.schedule(snapshot('after-rename', 'archive/b', 2))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await drainWriteQueue()
    expect(await persistence.flush('vault', 'doc-a')).toBe(false)
    expect(await store.getDraft('vault', 'doc-a')).toBeNull()

    // The unreadable row disappears AND context B moves the family to
    // the server path: the retry's probe re-verifies the family AT
    // serverPath and completes the move in-memory (no blind move was
    // needed — the probe certifies it). The pending snapshot then
    // establishes the primary record at the server path.
    await backend.deleteConflict('vault', 'doc-a', 'bad-row')
    expect((await storeB.moveDraftFamily('vault', 'doc-a', 'archive/b')).status)
      .toBe('missing')
    expect(await persistence.flush('vault', 'doc-a')).toBe(true)
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      documentPath: 'archive/b',
      content: 'after-rename',
    })
    const conflicts = await store.listConflictDrafts('vault')
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({
      conflictId: 'valid-row',
      documentPath: 'archive/b',
    })
    // The old path was never certified — the settlement reports null.
    expect(settlements.some(
      (s) => s.status === 'moved-and-persisted'
        && s.newPath === 'archive/b'
        && s.oldPath === null,
    )).toBe(true)
    await persistence.dispose()
  })

  it('a move-indeterminate retry completes for an emptied family and establishes the primary', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const settlements: Array<{
      oldPath: string | null
      newPath: string
      status: 'moved-and-persisted' | 'moved-write-failed' | 'path-authentication-pending' | 'conflict'
    }> = []
    const persistence = createUnsavedDraftPersistence({
      store,
      debounceMs: 800,
      now: () => 100,
      onDraftFamilyMoveSettled: (settlement) => {
        settlements.push(settlement)
      },
      // An emptied family is re-verified against the server before the
      // retry mints a primary: the resolver certifies the rename's
      // target (this test's server truth) with a version token.
      resolveCurrentDocumentPath: async () => ({ path: 'archive/b', version: 1 }),
    })
    await backend.seedRawConflict({
      ...conflictRecord('bad-row', 'doc-a', 'archive/a', 'unreadable'),
      version: 2,
    })
    await store.saveConflictDraft(conflictRecord('valid-row', 'doc-a', 'legacy/a', 'older local'))
    persistence.schedule(snapshot('stale-edit', 'notes/a', 1))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await drainWriteQueue()
    const barrier = await persistence.prepareFileMutation([identity])
    const [move] = await barrier.commitMoves([{
      ...identity,
      fromPath: 'notes/a',
      toPath: 'archive/b',
    }])
    expect(move.status).toBe('unsupported')
    expect(await barrier.finalizeAfterTabMigration()).toEqual([{
      documentId: 'doc-a',
      oldPath: 'notes/a',
      newPath: 'archive/b',
      status: 'failed',
    }])
    persistence.schedule(snapshot('after-rename', 'archive/b', 2))
    expect(await persistence.flush('vault', 'doc-a')).toBe(false)

    // Every row of the identity disappears server-side: the probe
    // reports an empty family ('none') — there is nothing left to
    // drag anywhere. The retry re-validates the server path through
    // the wired resolver (which certifies serverPath archive/b here)
    // before completing: the pending snapshot establishes the primary
    // record at the RE-VALIDATED path. Nothing is blind-moved, and an
    // absent or failing resolver fails closed instead of trusting the
    // stale serverPath.
    await backend.deleteConflict('vault', 'doc-a', 'bad-row')
    await store.deleteConflictDraft('vault', 'doc-a', 'valid-row')
    expect(await persistence.flush('vault', 'doc-a')).toBe(true)
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      documentPath: 'archive/b',
      content: 'after-rename',
    })
    expect(await store.listConflictDrafts('vault')).toEqual([])
    expect(settlements.some(
      (s) => s.status === 'moved-and-persisted'
        && s.newPath === 'archive/b'
        && s.oldPath === null,
    )).toBe(true)
    await persistence.dispose()
  })

  it('a successful re-probe exits indeterminate so the next rename uses quarantine semantics', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const storeB = createDraftStore({ backend })
    const settlements: Array<{
      oldPath: string | null
      newPath: string
      status: 'moved-and-persisted' | 'moved-write-failed' | 'path-authentication-pending' | 'conflict'
    }> = []
    const persistence = createUnsavedDraftPersistence({
      store,
      debounceMs: 800,
      now: () => 100,
      onDraftFamilyMoveSettled: (settlement) => {
        settlements.push(settlement)
      },
    })
    // A split family (an unreadable row at archive/a beside a readable
    // candidate at legacy/a) certifies NO path — the entry turns
    // indeterminate.
    await backend.seedRawConflict({
      ...conflictRecord('bad-row', 'doc-a', 'archive/a', 'unreadable'),
      version: 2,
    })
    await store.saveConflictDraft(conflictRecord('valid-row', 'doc-a', 'legacy/a', 'older local'))
    persistence.schedule(snapshot('stale-edit', 'notes/a', 1))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await drainWriteQueue()
    expect(await store.getDraft('vault', 'doc-a')).toBeNull()

    // The family is repaired server-side (both rows disappear, so the
    // snapshot's own path is safe again); the user edit arms the
    // re-probe and the primary save/readback succeeds.
    await backend.deleteConflict('vault', 'doc-a', 'bad-row')
    await store.deleteConflictDraft('vault', 'doc-a', 'valid-row')
    persistence.schedule(snapshot('repaired-edit', 'notes/a', 2))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await drainWriteQueue()
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      documentPath: 'notes/a',
      content: 'repaired-edit',
    })

    // The successful re-probe MUST have exited indeterminate: the next
    // edit uses the normal primary channel …
    persistence.schedule(snapshot('normal-edit', 'notes/a', 3))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await drainWriteQueue()
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      documentPath: 'notes/a',
      content: 'normal-edit',
    })

    // … and the following rename failure uses normal move-quarantine
    // semantics: context B moves the family to final/a before A's
    // stale retry fires. A quarantine retries the move with its
    // CERTIFIED oldPath (notes/a) — the CAS refuses, A adopts final/a.
    // An entry still stuck in indeterminate would become
    // move-indeterminate instead and blind-move the family from
    // final/a back to its stale server target archive/a.
    expect((await storeB.moveDraftFamily('vault', 'doc-a', 'final/a')).status)
      .toBe('moved')
    const barrier = await persistence.prepareFileMutation([identity])
    backend.failNext('moveFamily')
    const [move] = await barrier.commitMoves([{
      ...identity,
      fromPath: 'notes/a',
      toPath: 'archive/a',
    }])
    expect(move.status).toBe('failed')
    expect(await barrier.finalizeAfterTabMigration()).toEqual([])
    persistence.schedule(snapshot('after-rename', 'archive/a', 4))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await drainWriteQueue()
    // The family stays at B's certified path — the stale retry adopted
    // it instead of dragging the family back to archive/a.
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      documentPath: 'final/a',
      content: 'normal-edit',
    })
    expect((await store.listConflictDrafts('vault'))
      .find((c) => c.content === 'after-rename')).toMatchObject({
      documentPath: 'final/a',
      origin: 'move-conflict',
    })
    expect(settlements.some((s) => s.status === 'conflict')).toBe(true)
    await persistence.dispose()
  })

  it('a quarantine whose CAS retry fails discards the stale serverPath when the fallback candidate meets path-mismatch', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const storeB = createDraftStore({ backend })
    const settlements: Array<{
      oldPath: string | null
      newPath: string
      status: 'moved-and-persisted' | 'moved-write-failed' | 'path-authentication-pending' | 'conflict'
    }> = []
    const persistence = createUnsavedDraftPersistence({
      store,
      debounceMs: 800,
      now: () => 100,
      onDraftFamilyMoveSettled: (settlement) => {
        settlements.push(settlement)
      },
    })
    await store.saveDraft(draft('primary', 'notes/a', 10))
    await store.saveConflictDraft(conflictRecord('conflict-a', 'doc-a', 'notes/a', 'local orphan'))
    // Context A's rename notes/a→archive/a: server succeeds, draft
    // family move fails → quarantine{familyPath notes/a, serverPath
    // archive/a}.
    const barrier = await persistence.prepareFileMutation([identity])
    backend.failNext('moveFamily')
    const [move] = await barrier.commitMoves([{
      ...identity,
      fromPath: 'notes/a',
      toPath: 'archive/a',
    }])
    expect(move.status).toBe('failed')
    expect(await barrier.finalizeAfterTabMigration()).toEqual([])
    // The CAS retry itself then hits a TRANSIENT STORE FAILURE (not a
    // path verdict), and while it is down context B completes its own
    // verified rename, moving the whole family to final/a.
    persistence.schedule(snapshot('after-rename', 'archive/a', 2))
    backend.failNext('moveFamilyIfAtPath')
    expect((await storeB.moveDraftFamily('vault', 'doc-a', 'final/a')).status)
      .toBe('moved')

    // The retry's fallback candidate write at the quarantine's
    // certified oldPath (notes/a) now comes back path-mismatch with
    // the family's certified current path final/a. That verdict
    // supersedes the quarantine's stale serverPath: the quarantine is
    // DISCARDED, the pending content persists as a move-conflict
    // candidate AT final/a and the entry pins to the plain conflict
    // channel there. Keeping serverPath archive/a alive would make a
    // later flush retry the stale move AGAIN — a CAS re-derived
    // against the family's real path would then drag it from final/a
    // back to archive/a. The CAS runs exactly once.
    const casCalls = vi.spyOn(store, 'moveDraftFamilyIfAtPath')
    expect(await persistence.flush('vault', 'doc-a')).toBe(true)
    expect(casCalls).toHaveBeenCalledTimes(1)
    // The primary record stays exactly where B's verified rename put
    // it; A's bytes survive as a candidate beside it.
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      documentPath: 'final/a',
      content: 'primary',
    })
    const conflicts = await store.listConflictDrafts('vault')
    expect(conflicts).toHaveLength(2)
    expect(conflicts.map((c) => c.documentPath).sort())
      .toEqual(['final/a', 'final/a'])
    expect(conflicts.find((c) => c.conflictId !== 'conflict-a')).toMatchObject({
      content: 'after-rename',
      origin: 'move-conflict',
      documentPath: 'final/a',
    })
    expect(settlements.some((s) => s.status === 'conflict')).toBe(true)
    expect(settlements.some((s) => s.status === 'moved-and-persisted')).toBe(false)

    // The entry now writes on the conflict channel at final/a: the
    // next edit lands as a candidate there and NEVER re-runs the
    // stale move retry (casCalls stays 1 — a surviving quarantine
    // would retry and drag the family to archive/a).
    persistence.schedule(snapshot('next-edit', 'archive/a', 3))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await drainWriteQueue()
    expect(casCalls).toHaveBeenCalledTimes(1)
    expect((await store.listConflictDrafts('vault'))
      .find((c) => c.content === 'next-edit')).toMatchObject({
      documentPath: 'final/a',
    })
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      documentPath: 'final/a',
      content: 'primary',
    })
    await persistence.dispose()
  })

  it('a conflict-pinned quarantine discards the stale serverPath when its candidate meets path-mismatch', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const storeB = createDraftStore({ backend })
    const settlements: Array<{
      oldPath: string | null
      newPath: string
      status: 'moved-and-persisted' | 'moved-write-failed' | 'path-authentication-pending' | 'conflict'
    }> = []
    const persistence = createUnsavedDraftPersistence({
      store,
      debounceMs: 800,
      now: () => 100,
      onDraftFamilyMoveSettled: (settlement) => {
        settlements.push(settlement)
      },
    })
    // A cross-context record newer than any timestamp this entry can
    // mint (now: () => 100): the first edit's primary save comes back
    // stale and pins the entry to the conflict channel.
    await store.saveDraft(draft('primary', 'notes/a', 10))
    await store.saveDraft(draft('cross', 'notes/a', 500))
    persistence.schedule(snapshot('edit-1', 'notes/a', 1))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await drainWriteQueue()
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      documentPath: 'notes/a',
      content: 'cross',
    })
    expect((await store.listConflictDrafts('vault'))
      .some((c) => c.content === 'edit-1' && c.documentPath === 'notes/a'))
      .toBe(true)
    // The rename then fails the same way: server succeeds, draft
    // family move fails → quarantine{familyPath notes/a, serverPath
    // archive/a, conflict PIN kept}.
    const barrier = await persistence.prepareFileMutation([identity])
    backend.failNext('moveFamily')
    const [move] = await barrier.commitMoves([{
      ...identity,
      fromPath: 'notes/a',
      toPath: 'archive/a',
    }])
    expect(move.status).toBe('failed')
    expect(await barrier.finalizeAfterTabMigration()).toEqual([])
    // The CAS retry hits a transient store failure; context B
    // completes archive/a→final/a whole.
    persistence.schedule(snapshot('after-rename', 'archive/a', 2))
    backend.failNext('moveFamilyIfAtPath')
    expect((await storeB.moveDraftFamily('vault', 'doc-a', 'final/a')).status)
      .toBe('moved')

    // The retry's conflict-channel candidate (pinned at notes/a)
    // meets path-mismatch. The pinned case takes the SAME transition
    // as the plain one: the stale serverPath is discarded, the
    // candidate joins the family at final/a, and the entry pins to
    // the plain conflict channel there.
    const casCalls = vi.spyOn(store, 'moveDraftFamilyIfAtPath')
    expect(await persistence.flush('vault', 'doc-a')).toBe(true)
    expect(casCalls).toHaveBeenCalledTimes(1)
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      documentPath: 'final/a',
      content: 'cross',
    })
    const conflicts = await store.listConflictDrafts('vault')
    expect(conflicts).toHaveLength(2)
    expect(conflicts.map((c) => c.documentPath).sort())
      .toEqual(['final/a', 'final/a'])
    expect(conflicts.some(
      (c) => c.content === 'edit-1' && c.documentPath === 'final/a',
    )).toBe(true)
    expect(conflicts.some(
      (c) => c.content === 'after-rename' && c.documentPath === 'final/a',
    )).toBe(true)
    expect(settlements.some((s) => s.status === 'conflict')).toBe(true)
    expect(settlements.some((s) => s.status === 'moved-and-persisted')).toBe(false)

    // The plain conflict channel at final/a owns the next write —
    // never the stale move retry.
    persistence.schedule(snapshot('next-edit', 'archive/a', 3))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await drainWriteQueue()
    expect(casCalls).toHaveBeenCalledTimes(1)
    expect((await store.listConflictDrafts('vault'))
      .some((c) => c.content === 'next-edit' && c.documentPath === 'final/a'))
      .toBe(true)
    await persistence.dispose()
  })

  it('a quarantine whose CAS retry fails discards the stale serverPath when the stale retry fires by debounce', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const storeB = createDraftStore({ backend })
    const settlements: Array<{
      status: 'moved-and-persisted' | 'moved-write-failed' | 'path-authentication-pending' | 'conflict'
    }> = []
    const persistence = createUnsavedDraftPersistence({
      store,
      debounceMs: 800,
      now: () => 100,
      onDraftFamilyMoveSettled: (settlement) => {
        settlements.push(settlement)
      },
    })
    await store.saveDraft(draft('primary', 'notes/a', 10))
    await store.saveConflictDraft(conflictRecord('conflict-a', 'doc-a', 'notes/a', 'local orphan'))
    const barrier = await persistence.prepareFileMutation([identity])
    backend.failNext('moveFamily')
    const [move] = await barrier.commitMoves([{
      ...identity,
      fromPath: 'notes/a',
      toPath: 'archive/a',
    }])
    expect(move.status).toBe('failed')
    expect(await barrier.finalizeAfterTabMigration()).toEqual([])
    persistence.schedule(snapshot('after-rename', 'archive/a', 2))
    backend.failNext('moveFamilyIfAtPath')
    expect((await storeB.moveDraftFamily('vault', 'doc-a', 'final/a')).status)
      .toBe('moved')

    // Same scenario, fired by the post-rename edit's debounce instead
    // of a manual flush: the failed CAS's fallback candidate meets
    // path-mismatch and the quarantine is discarded at final/a.
    const casCalls = vi.spyOn(store, 'moveDraftFamilyIfAtPath')
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await drainWriteQueue()
    expect(casCalls).toHaveBeenCalledTimes(1)
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      documentPath: 'final/a',
      content: 'primary',
    })
    const conflicts = await store.listConflictDrafts('vault')
    expect(conflicts).toHaveLength(2)
    expect(conflicts.map((c) => c.documentPath).sort())
      .toEqual(['final/a', 'final/a'])
    expect(conflicts.find((c) => c.conflictId !== 'conflict-a')).toMatchObject({
      content: 'after-rename',
      origin: 'move-conflict',
      documentPath: 'final/a',
    })
    expect(settlements.some((s) => s.status === 'conflict')).toBe(true)
    expect(settlements.some((s) => s.status === 'moved-and-persisted')).toBe(false)
    await persistence.dispose()
  })

  it('a quarantine whose CAS retry fails discards the stale serverPath when the stale retry fires by pagehide', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const storeB = createDraftStore({ backend })
    const targetWindow = new EventTarget()
    const persistence = makePersistence(store, targetWindow)
    await store.saveDraft(draft('primary', 'notes/a', 10))
    await store.saveConflictDraft(conflictRecord('conflict-a', 'doc-a', 'notes/a', 'local orphan'))
    const barrier = await persistence.prepareFileMutation([identity])
    backend.failNext('moveFamily')
    const [move] = await barrier.commitMoves([{
      ...identity,
      fromPath: 'notes/a',
      toPath: 'archive/a',
    }])
    expect(move.status).toBe('failed')
    expect(await barrier.finalizeAfterTabMigration()).toEqual([])
    persistence.schedule(snapshot('after-rename', 'archive/a', 2))
    backend.failNext('moveFamilyIfAtPath')
    expect((await storeB.moveDraftFamily('vault', 'doc-a', 'final/a')).status)
      .toBe('moved')

    // Same scenario, fired by pagehide before the debounce elapses.
    const casCalls = vi.spyOn(store, 'moveDraftFamilyIfAtPath')
    targetWindow.dispatchEvent(new Event('pagehide'))
    await vi.waitFor(async () => {
      const conflicts = await store.listConflictDrafts('vault')
      expect(conflicts.some(
        (c) => c.content === 'after-rename' && c.documentPath === 'final/a',
      )).toBe(true)
    })
    expect(casCalls).toHaveBeenCalledTimes(1)
    // The family stays at B's certified path — pagehide's flush must
    // not keep a quarantine alive that would drag it to archive/a.
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      documentPath: 'final/a',
      content: 'primary',
    })
    await persistence.dispose()
  })

  it('a quarantine whose CAS retry fails discards the stale serverPath when the stale retry fires by dispose', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const storeB = createDraftStore({ backend })
    const persistence = makePersistence(store)
    await store.saveDraft(draft('primary', 'notes/a', 10))
    await store.saveConflictDraft(conflictRecord('conflict-a', 'doc-a', 'notes/a', 'local orphan'))
    const barrier = await persistence.prepareFileMutation([identity])
    backend.failNext('moveFamily')
    const [move] = await barrier.commitMoves([{
      ...identity,
      fromPath: 'notes/a',
      toPath: 'archive/a',
    }])
    expect(move.status).toBe('failed')
    expect(await barrier.finalizeAfterTabMigration()).toEqual([])
    persistence.schedule(snapshot('after-rename', 'archive/a', 2))
    backend.failNext('moveFamilyIfAtPath')
    expect((await storeB.moveDraftFamily('vault', 'doc-a', 'final/a')).status)
      .toBe('moved')

    // Same scenario, fired by dispose's final flush (app shutdown
    // mid-quarantine while the CAS is broken).
    const casCalls = vi.spyOn(store, 'moveDraftFamilyIfAtPath')
    await persistence.dispose()
    expect(casCalls).toHaveBeenCalledTimes(1)
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      documentPath: 'final/a',
      content: 'primary',
    })
    const conflicts = await store.listConflictDrafts('vault')
    expect(conflicts).toHaveLength(2)
    expect(conflicts.map((c) => c.documentPath).sort())
      .toEqual(['final/a', 'final/a'])
    expect(conflicts.find((c) => c.conflictId !== 'conflict-a')).toMatchObject({
      content: 'after-rename',
      origin: 'move-conflict',
      documentPath: 'final/a',
    })
  })

  it('a failed re-probe re-closes the entry until the next user edit', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const persistence = createUnsavedDraftPersistence({
      store,
      debounceMs: 800,
      now: () => 100,
    })
    // A split family turns the entry indeterminate (no certifiable
    // path → the save blocks closed).
    await backend.seedRawConflict({
      ...conflictRecord('bad-row', 'doc-a', 'archive/a', 'unreadable'),
      version: 2,
    })
    await store.saveConflictDraft(conflictRecord('valid-row', 'doc-a', 'legacy/a', 'older local'))
    persistence.schedule(snapshot('stale-edit', 'notes/a', 1))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await drainWriteQueue()
    expect(await store.getDraft('vault', 'doc-a')).toBeNull()

    // A user edit arms the re-probe: ONE save attempt is the probe.
    // When that probe fails at the store (a transient outage, not a
    // family verdict) the entry must RE-CLOSE — reprobePending
    // cleared — or every manual flush / pagehide / dispose would
    // re-fire the probe against the broken store, contradicting the
    // "one probe per user edit" contract.
    persistence.schedule(snapshot('armed-edit', 'notes/a', 2))
    backend.failNext('save')
    expect(await persistence.flush('vault', 'doc-a')).toBe(false)

    // Re-closed: a manual flush must NOT touch the store again until
    // a user edit re-arms the probe.
    const saveCalls = vi.spyOn(store, 'saveDraft')
    expect(await persistence.flush('vault', 'doc-a')).toBe(false)
    expect(saveCalls).not.toHaveBeenCalled()
    expect(await store.getDraft('vault', 'doc-a')).toBeNull()

    // The family heals server-side; the NEXT user edit re-arms the
    // probe and the save succeeds.
    await backend.deleteConflict('vault', 'doc-a', 'bad-row')
    await store.deleteConflictDraft('vault', 'doc-a', 'valid-row')
    persistence.schedule(snapshot('healed-edit', 'notes/a', 3))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await drainWriteQueue()
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      documentPath: 'notes/a',
      content: 'healed-edit',
    })
    await persistence.dispose()
  })

  // Drive a move-indeterminate entry to the emptied-family retry:
  // split family → blocked save (indeterminate) → server rename
  // succeeds while the draft move stays unsupported → first post-
  // rename flush blocked by the still-unreadable row → every row of
  // the identity then disappears, so the NEXT retry's probe reports
  // 'none'. The entry is now one flush away from minting a primary —
  // the point where the stale serverPath must be re-validated against
  // the server instead of trusted.
  async function setupEmptiedFamilyRetry(options: {
    resolveCurrentDocumentPath?: (
      vaultId: string,
      documentId: string,
    ) => Promise<{ path: string; version: string | number } | null>
    targetWindow?: EventTarget
  } = {}) {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const settlements: Array<{
      oldPath: string | null
      newPath: string
      status: 'moved-and-persisted' | 'moved-write-failed' | 'path-authentication-pending' | 'conflict'
    }> = []
    const persistence = createUnsavedDraftPersistence({
      store,
      debounceMs: 800,
      now: () => 100,
      targetWindow: options.targetWindow,
      onDraftFamilyMoveSettled: (settlement) => {
        settlements.push(settlement)
      },
      resolveCurrentDocumentPath: options.resolveCurrentDocumentPath,
    })
    await backend.seedRawConflict({
      ...conflictRecord('bad-row', 'doc-a', 'archive/a', 'unreadable'),
      version: 2,
    })
    await store.saveConflictDraft(conflictRecord('valid-row', 'doc-a', 'legacy/a', 'older local'))
    persistence.schedule(snapshot('stale-edit', 'notes/a', 1))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await drainWriteQueue()
    const barrier = await persistence.prepareFileMutation([identity])
    const [move] = await barrier.commitMoves([{
      ...identity,
      fromPath: 'notes/a',
      toPath: 'archive/b',
    }])
    expect(move.status).toBe('unsupported')
    expect(await barrier.finalizeAfterTabMigration()).toEqual([{
      documentId: 'doc-a',
      oldPath: 'notes/a',
      newPath: 'archive/b',
      status: 'failed',
    }])
    persistence.schedule(snapshot('after-rename', 'archive/b', 2))
    // First post-rename flush: the probe still sees the unreadable
    // row → fail closed.
    expect(await persistence.flush('vault', 'doc-a')).toBe(false)
    // The whole identity disappears server-side: the next probe
    // reports an empty family.
    await backend.deleteConflict('vault', 'doc-a', 'bad-row')
    await store.deleteConflictDraft('vault', 'doc-a', 'valid-row')
    return { backend, store, persistence, settlements }
  }

  it('an emptied-family move-indeterminate retry revalidates the server path before establishing the primary', async () => {
    // Another window renamed the document again (archive/b→final/b)
    // and cleared the draft rows; the probe only sees "no family".
    // The resolver certifies the document's CURRENT server path by
    // stable identity — the retry must establish the primary there,
    // not at the stale serverPath archive/b.
    const resolverCalls: Array<{ vaultId: string; documentId: string }> = []
    const { store, persistence, settlements } = await setupEmptiedFamilyRetry({
      resolveCurrentDocumentPath: async (vaultId, documentId) => {
        resolverCalls.push({ vaultId, documentId })
        return { path: 'final/b', version: 7 }
      },
    })
    expect(await persistence.flush('vault', 'doc-a')).toBe(true)
    // Two queries: the pre-write resolve AND the post-write server
    // revalidation that authenticates the mint.
    expect(resolverCalls).toEqual([
      { vaultId: 'vault', documentId: 'doc-a' },
      { vaultId: 'vault', documentId: 'doc-a' },
    ])
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      documentPath: 'final/b',
      content: 'after-rename',
    })
    expect(await store.listConflictDrafts('vault')).toEqual([])
    expect(settlements.some(
      (s) => s.status === 'moved-and-persisted'
        && s.newPath === 'final/b'
        && s.oldPath === null,
    )).toBe(true)
    await persistence.dispose()
  })

  it('an emptied-family retry fails closed when the server path revalidation returns nothing', async () => {
    const { store, persistence, settlements } = await setupEmptiedFamilyRetry({
      resolveCurrentDocumentPath: async () => null,
    })
    expect(await persistence.flush('vault', 'doc-a')).toBe(false)
    // No primary was minted at the stale serverPath — nothing was
    // written anywhere.
    expect(await store.getDraft('vault', 'doc-a')).toBeNull()
    expect(await store.listDrafts('vault')).toEqual([])
    // Still blocked on the next flush.
    expect(await persistence.flush('vault', 'doc-a')).toBe(false)
    expect(await store.getDraft('vault', 'doc-a')).toBeNull()
    expect(settlements.some((s) => s.status === 'moved-and-persisted')).toBe(false)
    await persistence.dispose()
  })

  it('an emptied-family retry fails closed when the server path revalidation throws', async () => {
    const { store, persistence } = await setupEmptiedFamilyRetry({
      resolveCurrentDocumentPath: async () => {
        throw new Error('server unavailable')
      },
    })
    expect(await persistence.flush('vault', 'doc-a')).toBe(false)
    expect(await store.getDraft('vault', 'doc-a')).toBeNull()
    expect(await store.listDrafts('vault')).toEqual([])
    await persistence.dispose()
  })

  it('an emptied-family retry fails closed when no path resolver is wired', async () => {
    const { store, persistence } = await setupEmptiedFamilyRetry()
    expect(await persistence.flush('vault', 'doc-a')).toBe(false)
    expect(await store.getDraft('vault', 'doc-a')).toBeNull()
    expect(await store.listDrafts('vault')).toEqual([])
    await persistence.dispose()
  })

  // Bounded TOCTOU recovery: between the server path query and the
  // primary write (or between the write and the final revalidation)
  // another window may rename the document again. The retry must
  // re-query after writing, converge the just-written family to the
  // newest server path via an expected-path CAS, revalidate once more,
  // and fail closed when the path keeps changing beyond the bound —
  // never leaving a primary minted at a path the server has abandoned.
  describe('emptied-family retry under a racing server rename', () => {
    // The scripted "server": a mutable {path, version} the resolver
    // closure reads, renamed at deterministic resolver call counts.
    type ServerState = { path: string; version: number }

    it('R1: converges via CAS when the rename lands between the primary write and the revalidation (manual flush)', async () => {
      const serverState: ServerState = { path: 'path/b', version: 1 }
      let calls = 0
      const { store, persistence, settlements } = await setupEmptiedFamilyRetry({
        resolveCurrentDocumentPath: async () => {
          calls += 1
          // Context B renames B→C in the window between the primary
          // write and this revalidation query.
          if (calls === 2) {
            serverState.path = 'path/c'
            serverState.version = 2
          }
          return { ...serverState }
        },
      })
      expect(await persistence.flush('vault', 'doc-a')).toBe(true)
      // No primary remains at path/b: the CAS moved the just-written
      // family to path/c and the final revalidation authenticated it.
      expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
        documentPath: 'path/c',
        content: 'after-rename',
      })
      expect(calls).toBe(3) // resolve + recheck + final revalidation
      expect(settlements.some(
        (s) => s.status === 'moved-and-persisted' && s.newPath === 'path/c' && s.oldPath === null,
      )).toBe(true)
      await persistence.dispose()
    })

    it('R2: converges when the rename lands after the resolve returns but before the primary write', async () => {
      const serverState: ServerState = { path: 'path/b', version: 1 }
      let calls = 0
      const { store, persistence } = await setupEmptiedFamilyRetry({
        resolveCurrentDocumentPath: async () => {
          calls += 1
          const response = { ...serverState }
          // The rename lands AFTER this response is computed: the
          // resolver returned path/b, the write still goes to path/b,
          // but the server is already at path/c.
          if (calls === 1) {
            serverState.path = 'path/c'
            serverState.version = 2
          }
          return response
        },
      })
      expect(await persistence.flush('vault', 'doc-a')).toBe(true)
      // The post-write revalidation must catch the drift: the family
      // converges to path/c, nothing stays at the abandoned path/b.
      expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
        documentPath: 'path/c',
        content: 'after-rename',
      })
      expect(await store.getDraft('vault', 'doc-a')).not.toMatchObject({ documentPath: 'path/b' })
      await persistence.dispose()
    })

    it.each(['manual flush', 'pagehide', 'dispose'] as const)(
      'adopts a cross-context primary family as the recovery anchor on %s',
      async (trigger) => {
        const targetWindow = trigger === 'pagehide' ? new EventTarget() : undefined
        const setup = await setupEmptiedFamilyRetry({
          targetWindow,
          resolveCurrentDocumentPath: async () => ({ path: 'path/b', version: 1 }),
        })
        const { store, persistence, settlements } = setup
        const saveDraft = store.saveDraft.bind(store)
        let raced = false
        vi.spyOn(store, 'saveDraft').mockImplementation(async (value) => {
          if (!raced) {
            raced = true
            // Another context establishes the family at C after our
            // initial empty probe but before the first mint at B. The
            // local write is preserved as a candidate next to C.
            await saveDraft(draft('remote-family', 'path/c', 1_000))
          }
          return saveDraft(value)
        })

        if (trigger === 'manual flush') {
          expect(await persistence.flush('vault', 'doc-a')).toBe(true)
        } else if (trigger === 'pagehide') {
          targetWindow!.dispatchEvent(new Event('pagehide'))
          await vi.waitFor(async () => {
            expect((await store.getDraft('vault', 'doc-a'))?.documentPath).toBe('path/b')
          })
        } else {
          await persistence.dispose()
        }

        expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
          documentPath: 'path/b',
          content: 'remote-family',
        })
        expect(await store.listConflictDrafts('vault')).toEqual([
          expect.objectContaining({
            documentPath: 'path/b',
            content: 'after-rename',
          }),
        ])
        expect(settlements.filter(
          (item) => item.status === 'moved-and-persisted',
        )).toHaveLength(1)
        if (trigger !== 'dispose') await persistence.dispose()
      },
    )

    it('adopts a conflict-only family that wins the first-mint race', async () => {
      const setup = await setupEmptiedFamilyRetry({
        resolveCurrentDocumentPath: async () => ({ path: 'path/b', version: 1 }),
      })
      const { store, persistence } = setup
      const saveDraft = store.saveDraft.bind(store)
      let raced = false
      vi.spyOn(store, 'saveDraft').mockImplementation(async (value) => {
        if (!raced) {
          raced = true
          await store.saveConflictDraft(
            conflictRecord('remote-only', 'doc-a', 'path/c', 'remote candidate'),
          )
        }
        return saveDraft(value)
      })

      expect(await persistence.flush('vault', 'doc-a')).toBe(true)
      expect(await store.getDraft('vault', 'doc-a')).toBeNull()
      expect(await store.listConflictDrafts('vault')).toEqual(expect.arrayContaining([
        expect.objectContaining({ documentPath: 'path/b', content: 'remote candidate' }),
        expect.objectContaining({ documentPath: 'path/b', content: 'after-rename' }),
      ]))
      await persistence.dispose()
    })

    it('adopts the candidate family path after a first-mint readback mismatch', async () => {
      const setup = await setupEmptiedFamilyRetry({
        resolveCurrentDocumentPath: async () => ({ path: 'path/b', version: 1 }),
      })
      const { backend, store, persistence, settlements } = setup
      const getDraft = store.getDraft.bind(store)
      let raced = false
      vi.spyOn(store, 'getDraft').mockImplementation(async (vaultId, documentId) => {
        if (!raced) {
          raced = true
          // The first mint at B succeeded, but another context replaced
          // the primary at C before writePrimary's exact readback. The
          // attempted bytes are handed off as a candidate at C.
          await backend.seedRaw(draft('remote-readback', 'path/c', 1_000))
        }
        return getDraft(vaultId, documentId)
      })

      expect(await persistence.flush('vault', 'doc-a')).toBe(true)
      expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
        documentPath: 'path/b',
        content: 'remote-readback',
      })
      expect(await store.listConflictDrafts('vault')).toEqual([
        expect.objectContaining({
          documentPath: 'path/b',
          content: 'after-rename',
        }),
      ])
      expect(settlements.filter(
        (item) => item.status === 'moved-and-persisted',
      )).toHaveLength(1)
      await persistence.dispose()
    })

    it.each(['manual flush', 'pagehide', 'dispose'] as const)(
      'keeps the conflict channel after a failed first candidate on %s',
      async (trigger) => {
        const targetWindow = trigger === 'pagehide' ? new EventTarget() : undefined
        const setup = await setupEmptiedFamilyRetry({
          targetWindow,
          resolveCurrentDocumentPath: async () => ({ path: 'path/b', version: 1 }),
        })
        const { store, persistence } = setup
        const saveDraft = store.saveDraft.bind(store)
        let raced = false
        vi.spyOn(store, 'saveDraft').mockImplementation(async (value) => {
          if (!raced) {
            raced = true
            await saveDraft(draft('remote-primary', 'path/c', 1_000))
          }
          return saveDraft(value)
        })
        vi.spyOn(store, 'saveConflictCandidate')
          .mockResolvedValueOnce({ status: 'failed' })

        // First authentication adopts C but the local candidate is not
        // durable yet. It must fail closed with the conflict pin intact.
        expect(await persistence.flush('vault', 'doc-a')).toBe(false)
        expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
          documentPath: 'path/c',
          content: 'remote-primary',
        })

        if (trigger === 'manual flush') {
          expect(await persistence.flush('vault', 'doc-a')).toBe(true)
        } else if (trigger === 'pagehide') {
          targetWindow!.dispatchEvent(new Event('pagehide'))
          await vi.waitFor(async () => {
            expect(await store.listConflictDrafts('vault')).toEqual([
              expect.objectContaining({ documentPath: 'path/b', content: 'after-rename' }),
            ])
          })
        } else {
          await persistence.dispose()
        }

        // Authentication moved the remote primary and saved the local
        // bytes as a candidate. It never promoted local content to the
        // primary winner after the first candidate transaction failed.
        expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
          documentPath: 'path/b',
          content: 'remote-primary',
        })
        expect(await store.listConflictDrafts('vault')).toEqual([
          expect.objectContaining({ documentPath: 'path/b', content: 'after-rename' }),
        ])
        if (trigger !== 'dispose') await persistence.dispose()
      },
    )

    it('keeps a conflict-only family primary-free after a failed first candidate', async () => {
      const setup = await setupEmptiedFamilyRetry({
        resolveCurrentDocumentPath: async () => ({ path: 'path/b', version: 1 }),
      })
      const { store, persistence } = setup
      const saveDraft = store.saveDraft.bind(store)
      let raced = false
      vi.spyOn(store, 'saveDraft').mockImplementation(async (value) => {
        if (!raced) {
          raced = true
          await store.saveConflictDraft(
            conflictRecord('remote-only-failed', 'doc-a', 'path/c', 'remote candidate'),
          )
        }
        return saveDraft(value)
      })
      vi.spyOn(store, 'saveConflictCandidate')
        .mockResolvedValueOnce({ status: 'failed' })

      expect(await persistence.flush('vault', 'doc-a')).toBe(false)
      expect(await persistence.flush('vault', 'doc-a')).toBe(true)
      expect(await store.getDraft('vault', 'doc-a')).toBeNull()
      expect(await store.listConflictDrafts('vault')).toEqual(expect.arrayContaining([
        expect.objectContaining({ documentPath: 'path/b', content: 'remote candidate' }),
        expect.objectContaining({ documentPath: 'path/b', content: 'after-rename' }),
      ]))
      await persistence.dispose()
    })

    it('keeps the conflict channel after a readback handoff candidate fails', async () => {
      const setup = await setupEmptiedFamilyRetry({
        resolveCurrentDocumentPath: async () => ({ path: 'path/b', version: 1 }),
      })
      const { backend, store, persistence } = setup
      const getDraft = store.getDraft.bind(store)
      let raced = false
      vi.spyOn(store, 'getDraft').mockImplementation(async (vaultId, documentId) => {
        if (!raced) {
          raced = true
          await backend.seedRaw(draft('remote-readback-failed', 'path/c', 1_000))
        }
        return getDraft(vaultId, documentId)
      })
      vi.spyOn(store, 'saveConflictCandidate')
        .mockResolvedValueOnce({ status: 'failed' })

      expect(await persistence.flush('vault', 'doc-a')).toBe(false)
      expect(await persistence.flush('vault', 'doc-a')).toBe(true)
      expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
        documentPath: 'path/b',
        content: 'remote-readback-failed',
      })
      expect(await store.listConflictDrafts('vault')).toEqual([
        expect.objectContaining({ documentPath: 'path/b', content: 'after-rename' }),
      ])
      await persistence.dispose()
    })

    it('R3: a second rename during the convergence window is caught by the bounded second attempt', async () => {
      const serverState: ServerState = { path: 'path/b', version: 1 }
      let calls = 0
      const { store, persistence } = await setupEmptiedFamilyRetry({
        resolveCurrentDocumentPath: async () => {
          calls += 1
          // Rename at the revalidation (B→C) AND again at the final
          // revalidation (C→D): the first attempt cannot authenticate,
          // the bounded second attempt re-resolves and converges at D.
          if (calls === 2) {
            serverState.path = 'path/c'
            serverState.version = 2
          } else if (calls === 3) {
            serverState.path = 'path/d'
            serverState.version = 3
          }
          return { ...serverState }
        },
      })
      expect(await persistence.flush('vault', 'doc-a')).toBe(true)
      expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
        documentPath: 'path/d',
        content: 'after-rename',
      })
      expect(calls).toBe(5) // b, c, d | d (CAS), d (final)
      await persistence.dispose()
    })

    it('R4: fails closed when the server keeps changing beyond the bounded attempts', async () => {
      let calls = 0
      const { store, persistence, settlements } = await setupEmptiedFamilyRetry({
        resolveCurrentDocumentPath: async () => {
          calls += 1
          // Every query sees a different path — the document is being
          // renamed continuously by another window.
          return { path: `path/p${calls}`, version: calls }
        },
      })
      expect(await persistence.flush('vault', 'doc-a')).toBe(false)
      // The latest bytes are still recoverable: persisted at the last
      // server-authoritative path the bounded flow reached (the second
      // attempt's convergence target), not abandoned in memory only.
      expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
        documentPath: 'path/p5',
        content: 'after-rename',
      })
      expect(settlements.some(
        (s) => s.status === 'path-authentication-pending' && s.newPath === 'path/p5',
      )).toBe(true)
      expect(settlements.some((s) => s.status === 'moved-write-failed')).toBe(false)
      await persistence.dispose()
    })

    it('R4a: a failed first mint retries through server authentication instead of the stale resolved path', async () => {
      let serverPath = 'path/b'
      let calls = 0
      const setup = await setupEmptiedFamilyRetry({
        resolveCurrentDocumentPath: async () => {
          calls += 1
          return { path: serverPath, version: calls }
        },
      })
      const { backend, store, persistence } = setup
      backend.failNext('save')

      expect(await persistence.flush('vault', 'doc-a')).toBe(false)
      expect(await store.getDraft('vault', 'doc-a')).toBeNull()

      // The server moves after the resolver returned B but before the
      // automatic retry. That retry must resolve again and mint at C;
      // a normal primary retry would incorrectly write B directly.
      serverPath = 'path/c'
      await vi.advanceTimersByTimeAsync(800)
      await vi.runAllTimersAsync()
      await drainWriteQueue()

      expect(calls).toBeGreaterThanOrEqual(3)
      expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
        documentPath: 'path/c',
        content: 'after-rename',
      })
      await persistence.dispose()
    })

    it('R4b: bounded exhaustion remains pending until a later flush authenticates a stable path', async () => {
      let calls = 0
      let stablePath: string | null = null
      const { store, persistence } = await setupEmptiedFamilyRetry({
        resolveCurrentDocumentPath: async () => {
          calls += 1
          return {
            path: stablePath ?? `path/p${calls}`,
            version: calls,
          }
        },
      })

      expect(await persistence.flush('vault', 'doc-a')).toBe(false)
      const callsAfterFailure = calls
      expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
        content: 'after-rename',
      })

      stablePath = 'path/stable'
      expect(await persistence.flush('vault', 'doc-a')).toBe(true)
      expect(calls).toBeGreaterThan(callsAfterFailure)
      expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
        documentPath: 'path/stable',
        content: 'after-rename',
      })
      await persistence.dispose()
    })

    it('persists a newer revision before authenticating an existing anchor on manual flush', async () => {
      let calls = 0
      let serverAvailable = false
      const { store, persistence } = await setupEmptiedFamilyRetry({
        resolveCurrentDocumentPath: async () => {
          calls += 1
          return calls === 1 || serverAvailable
            ? { path: 'path/b', version: calls }
            : null
        },
      })

      expect(await persistence.flush('vault', 'doc-a')).toBe(false)
      expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
        documentPath: 'path/b',
        content: 'after-rename',
      })

      persistence.schedule(snapshot('revision-2', 'path/b', 3))
      serverAvailable = true
      expect(await persistence.flush('vault', 'doc-a')).toBe(true)
      expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
        documentPath: 'path/b',
        content: 'revision-2',
      })
      await persistence.dispose()
    })

    it('persists a newer revision during pending authentication on pagehide', async () => {
      const targetWindow = new EventTarget()
      let calls = 0
      let serverAvailable = false
      const { store, persistence } = await setupEmptiedFamilyRetry({
        targetWindow,
        resolveCurrentDocumentPath: async () => {
          calls += 1
          return calls === 1 || serverAvailable
            ? { path: 'path/b', version: calls }
            : null
        },
      })

      expect(await persistence.flush('vault', 'doc-a')).toBe(false)
      persistence.schedule(snapshot('pagehide-revision', 'path/b', 3))
      serverAvailable = true
      targetWindow.dispatchEvent(new Event('pagehide'))

      await vi.waitFor(async () => {
        expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
          documentPath: 'path/b',
          content: 'pagehide-revision',
        })
      })
      await persistence.dispose()
    })

    it('persists a newer revision during pending authentication on dispose', async () => {
      let calls = 0
      let serverAvailable = false
      const { store, persistence } = await setupEmptiedFamilyRetry({
        resolveCurrentDocumentPath: async () => {
          calls += 1
          return calls === 1 || serverAvailable
            ? { path: 'path/b', version: calls }
            : null
        },
      })

      expect(await persistence.flush('vault', 'doc-a')).toBe(false)
      persistence.schedule(snapshot('dispose-revision', 'path/b', 3))
      serverAvailable = true
      await persistence.dispose()

      expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
        documentPath: 'path/b',
        content: 'dispose-revision',
      })
    })

    it('bounds automatic retries when the server resolver stays unavailable', async () => {
      let calls = 0
      const { persistence } = await setupEmptiedFamilyRetry({
        resolveCurrentDocumentPath: async () => {
          calls += 1
          return null
        },
      })

      expect(await persistence.flush('vault', 'doc-a')).toBe(false)
      await vi.runAllTimersAsync()
      await drainWriteQueue()

      expect(calls).toBe(4)
      expect(vi.getTimerCount()).toBe(0)
      await persistence.dispose()
    })

    it('bounds automatic retries when the first primary mint keeps failing', async () => {
      let calls = 0
      const setup = await setupEmptiedFamilyRetry({
        resolveCurrentDocumentPath: async () => {
          calls += 1
          return { path: 'path/b', version: calls }
        },
      })
      const { store, persistence, settlements } = setup
      const saveDraft = vi.spyOn(store, 'saveDraft').mockResolvedValue({ status: 'failed' })

      expect(await persistence.flush('vault', 'doc-a')).toBe(false)
      await vi.runAllTimersAsync()
      await drainWriteQueue()

      expect(calls).toBe(4)
      expect(saveDraft).toHaveBeenCalledTimes(4)
      expect(vi.getTimerCount()).toBe(0)
      // Notify once for the initial failure and once when the bounded
      // retry budget is exhausted; intermediate attempts stay quiet.
      expect(settlements.filter((item) => item.status === 'moved-write-failed')).toHaveLength(2)
      saveDraft.mockRestore()
      await persistence.dispose()
    })

    it('R5: the same convergence happens on the debounce flush', async () => {
      const serverState: ServerState = { path: 'path/b', version: 1 }
      let calls = 0
      const { store, persistence, settlements } = await setupEmptiedFamilyRetry({
        resolveCurrentDocumentPath: async () => {
          calls += 1
          if (calls === 2) {
            serverState.path = 'path/c'
            serverState.version = 2
          }
          return { ...serverState }
        },
      })
      // The pending edit persists through the debounce timer instead
      // of a manual flush.
      persistence.schedule(snapshot('debounced-edit', 'archive/b', 3))
      await vi.advanceTimersByTimeAsync(800)
      await vi.runAllTimersAsync()
      await drainWriteQueue()
      await vi.waitFor(async () => {
        expect(settlements.some(
          (s) => s.status === 'moved-and-persisted' && s.newPath === 'path/c',
        )).toBe(true)
      })
      expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
        documentPath: 'path/c',
        content: 'debounced-edit',
      })
      await persistence.dispose()
    })

    it('R6: the same convergence happens on pagehide', async () => {
      const targetWindow = new EventTarget()
      const serverState: ServerState = { path: 'path/b', version: 1 }
      let calls = 0
      const { store, persistence } = await setupEmptiedFamilyRetry({
        targetWindow,
        resolveCurrentDocumentPath: async () => {
          calls += 1
          if (calls === 2) {
            serverState.path = 'path/c'
            serverState.version = 2
          }
          return { ...serverState }
        },
      })
      targetWindow.dispatchEvent(new Event('pagehide'))
      await vi.waitFor(async () => {
        expect((await store.getDraft('vault', 'doc-a'))?.documentPath).toBe('path/c')
      })
      expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
        content: 'after-rename',
      })
      await persistence.dispose()
    })

    it('R7: the same convergence happens on dispose', async () => {
      const serverState: ServerState = { path: 'path/b', version: 1 }
      let calls = 0
      const { store, persistence } = await setupEmptiedFamilyRetry({
        resolveCurrentDocumentPath: async () => {
          calls += 1
          if (calls === 2) {
            serverState.path = 'path/c'
            serverState.version = 2
          }
          return { ...serverState }
        },
      })
      await persistence.dispose()
      expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
        documentPath: 'path/c',
        content: 'after-rename',
      })
    })

    it('R8a: a transient revalidation failure is retried by the bounded second attempt', async () => {
      let calls = 0
      const { store, persistence } = await setupEmptiedFamilyRetry({
        resolveCurrentDocumentPath: async () => {
          calls += 1
          if (calls === 2) throw new Error('transient network failure')
          return { path: 'path/b', version: 1 }
        },
      })
      expect(await persistence.flush('vault', 'doc-a')).toBe(true)
      expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
        documentPath: 'path/b',
        content: 'after-rename',
      })
      // attempt 1: resolve + throwing recheck; attempt 2: resolve + recheck
      expect(calls).toBe(4)
      await persistence.dispose()
    })

    it('R8b: persistent revalidation failures fail closed with the bytes persisted', async () => {
      let calls = 0
      const { store, persistence, settlements } = await setupEmptiedFamilyRetry({
        resolveCurrentDocumentPath: async () => {
          calls += 1
          if (calls >= 2) throw new Error('server keeps failing')
          return { path: 'path/b', version: 1 }
        },
      })
      expect(await persistence.flush('vault', 'doc-a')).toBe(false)
      // The primary WAS minted at the server-authoritative path before
      // revalidation started failing — the bytes remain recoverable.
      expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
        documentPath: 'path/b',
        content: 'after-rename',
      })
      expect(settlements.some(
        (s) => s.status === 'path-authentication-pending' && s.newPath === 'path/b',
      )).toBe(true)
      await persistence.dispose()
    })

    it('R9: converges when the family already sits at the revalidated path (CAS path-mismatch)', async () => {
      const serverState: ServerState = { path: 'path/b', version: 1 }
      let calls = 0
      let storeRef: ReturnType<typeof createDraftStore> | null = null
      const setup = await setupEmptiedFamilyRetry({
        resolveCurrentDocumentPath: async () => {
          calls += 1
          if (calls === 2) {
            // Context B renames B→C AND moves the draft family itself
            // (its rename found rows this time): by the time the CAS
            // runs, the family already sits at path/c.
            serverState.path = 'path/c'
            serverState.version = 2
            await storeRef!.moveDraftFamily('vault', 'doc-a', 'path/c')
          }
          return { ...serverState }
        },
      })
      storeRef = setup.store
      const { store, persistence } = setup
      expect(await persistence.flush('vault', 'doc-a')).toBe(true)
      // The CAS expected path/b but certified path/c as the family's
      // current location — the retry adopts it and revalidates, never
      // dragging the family back to path/b.
      expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
        documentPath: 'path/c',
        content: 'after-rename',
      })
      await persistence.dispose()
    })
  })

  describe('draft family state machine invariants', () => {
    type InvariantScenario = { name: string; run: () => Promise<void> }
    const scenarios: InvariantScenario[] = []
    function scenario(name: string, run: () => Promise<void>): void {
      scenarios.push({ name, run })
    }

    scenario('Invariant 1 — every readable record of one identity shares a single path', async () => {
      const backend = createMemoryDraftBackend()
      const store = createDraftStore({ backend })
      const persistence = makePersistence(store)
      // Unsupported conflict-only family at archive/a; a stale Tab
      // keeps editing at notes/a.
      await backend.seedRawConflict({
        ...conflictRecord('bad-row', 'doc-a', 'archive/a', 'unreadable'),
        version: 2,
      })
      persistence.schedule(snapshot('stale-edit', 'notes/a', 1))
      await vi.advanceTimersByTimeAsync(800)
      await vi.runAllTimersAsync()
      await drainWriteQueue()
      persistence.schedule(snapshot('stale-edit-2', 'notes/a', 2))
      await vi.advanceTimersByTimeAsync(800)
      await vi.runAllTimersAsync()
      await drainWriteQueue()

      const primary = await store.getDraft('vault', 'doc-a')
      const conflicts = await store.listConflictDrafts('vault')
      const readablePaths = [
        ...(primary ? [primary.documentPath] : []),
        ...conflicts.map((c) => c.documentPath),
      ]
      // The only readable records all share the family path — the
      // lone exception is the unreadable raw row, invisible here.
      // Normal writes never widened the split.
      expect(readablePaths.length).toBeGreaterThan(0)
      expect(new Set(readablePaths).size).toBe(1)
      expect(readablePaths[0]).toBe('archive/a')
      await persistence.dispose()
    })

    scenario('Invariant 2 — conflict-mode candidates always land on the pinned family path', async () => {
      const backend = createMemoryDraftBackend()
      const store = createDraftStore({ backend })
      const persistence = makePersistence(store)
      await pinConflictChannelAtNotesA(store, persistence)
      persistence.schedule(snapshot('edit-two', 'notes/a', 2))
      await vi.advanceTimersByTimeAsync(800)
      await vi.runAllTimersAsync()
      await drainWriteQueue()
      persistence.schedule(snapshot('edit-three', 'notes/a', 3))
      await vi.advanceTimersByTimeAsync(800)
      await vi.runAllTimersAsync()
      await drainWriteQueue()

      const conflicts = await store.listConflictDrafts('vault')
      expect(conflicts.map((c) => c.content).sort())
        .toEqual(['edit-three', 'edit-two', 'local-edit'])
      // mode.kind === 'conflict' → every new candidate path === the
      // pinned familyPath, even though the Tab's snapshot path could
      // drift.
      expect(conflicts.every((c) => c.documentPath === 'notes/a')).toBe(true)
      await persistence.dispose()
    })

    scenario('Invariant 3 — a failed quarantine retry writes new candidates only at the family path', async () => {
      const backend = createMemoryDraftBackend()
      const store = createDraftStore({ backend })
      const persistence = makePersistence(store)
      await store.saveDraft(draft('primary', 'notes/a', 10))
      await store.saveConflictDraft(conflictRecord('conflict-a', 'doc-a', 'notes/a', 'local orphan'))
      const barrier = await persistence.prepareFileMutation([identity])
      backend.failNext('moveFamily')
      const [move] = await barrier.commitMoves([{
        ...identity,
        fromPath: 'notes/a',
        toPath: 'archive/a',
      }])
      expect(move.status).toBe('failed')
      expect(await barrier.finalizeAfterTabMigration()).toEqual([])

      backend.failNext('moveFamilyConflicts')
      persistence.schedule(snapshot('after-rename', 'archive/a', 2))
      await vi.advanceTimersByTimeAsync(800)
      await vi.runAllTimersAsync()
      await drainWriteQueue()

      // mode.kind === 'move-quarantine' + failed retry → every new
      // candidate path === mode.familyPath (oldPath); nothing at the
      // server/Tab path.
      expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
        documentPath: 'notes/a',
      })
      const conflicts = await store.listConflictDrafts('vault')
      expect(conflicts).toHaveLength(2)
      expect(conflicts.every((c) => c.documentPath === 'notes/a')).toBe(true)
      await persistence.dispose()
    })

    scenario('Invariant 4a — a conflict-only family follows a verified rename in one transition', async () => {
      const backend = createMemoryDraftBackend()
      const store = createDraftStore({ backend })
      const persistence = makePersistence(store)
      // Conflict-only family at notes/a (no primary record).
      await store.saveConflictDraft(conflictRecord('orphan-a', 'doc-a', 'notes/a', 'older local'))
      // A stale edit on a different path pins the conflict channel at
      // the family path (path-mismatch handoff).
      persistence.schedule(snapshot('stale-edit', 'archive/a', 1))
      await vi.advanceTimersByTimeAsync(800)
      await vi.runAllTimersAsync()
      await drainWriteQueue()
      expect(await store.getDraft('vault', 'doc-a')).toBeNull()
      expect((await store.listConflictDrafts('vault'))
        .every((c) => c.documentPath === 'notes/a')).toBe(true)

      // Verified rename: the barrier reports 'missing' (no primary)
      // while the conflicts travel; the pinned channel must switch to
      // newPath in the same transition as the family move.
      const barrier = await persistence.prepareFileMutation([identity])
      const [move] = await barrier.commitMoves([{
        ...identity,
        fromPath: 'notes/a',
        toPath: 'archive/a',
      }])
      expect(move.status).toBe('missing')
      expect(await barrier.finalizeAfterTabMigration()).toEqual([])

      persistence.schedule(snapshot('after-move', 'archive/a', 2))
      await vi.advanceTimersByTimeAsync(800)
      await vi.runAllTimersAsync()
      await drainWriteQueue()

      expect(await store.getDraft('vault', 'doc-a')).toBeNull()
      const conflicts = await store.listConflictDrafts('vault')
      expect(conflicts).toHaveLength(3)
      // mode.familyPath, snapshot path and persisted candidate paths
      // all switched to newPath as one transition; nothing remains at
      // notes/a.
      expect(conflicts.every((c) => c.documentPath === 'archive/a')).toBe(true)
      await persistence.dispose()
    })

    scenario('Invariant 4b — a folder rename moves every family atomically to the new path', async () => {
      const backend = createMemoryDraftBackend()
      const store = createDraftStore({ backend })
      const persistence = makePersistence(store)
      const identityB = { vaultId: 'vault', documentId: 'doc-b', documentPath: 'notes/b' }
      await store.saveDraft(draft('primary-a', 'notes/a', 10))
      await store.saveConflictDraft(conflictRecord('orphan-a', 'doc-a', 'notes/a', 'local a'))
      await store.saveDraft({
        ...draft('primary-b', 'notes/b', 10),
        documentId: 'doc-b',
      })
      await store.saveConflictDraft(conflictRecord('orphan-b', 'doc-b', 'notes/b', 'local b'))

      const barrier = await persistence.prepareFileMutation([identity, identityB])
      const results = await barrier.commitMoves([
        { ...identity, fromPath: 'notes/a', toPath: 'archive/a' },
        { ...identityB, fromPath: 'notes/b', toPath: 'archive/b' },
      ])
      expect(results.map((r) => r.status)).toEqual(['moved', 'moved'])
      expect(await barrier.finalizeAfterTabMigration()).toEqual([])

      // Every readable record of BOTH identities lives at its new
      // path; nothing remains at either old path.
      expect(await store.getDraft('vault', 'doc-a'))
        .toMatchObject({ documentPath: 'archive/a', content: 'primary-a' })
      expect(await store.getDraft('vault', 'doc-b'))
        .toMatchObject({ documentPath: 'archive/b', content: 'primary-b' })
      const conflicts = await store.listConflictDrafts('vault')
      expect(conflicts).toHaveLength(2)
      expect(conflicts.find((c) => c.documentId === 'doc-a'))
        .toMatchObject({ documentPath: 'archive/a' })
      expect(conflicts.find((c) => c.documentId === 'doc-b'))
        .toMatchObject({ documentPath: 'archive/b' })
      await persistence.dispose()
    })

    scenario('Invariant 5 — an indeterminate family accepts no write on either split side', async () => {
      const backend = createMemoryDraftBackend()
      const store = createDraftStore({ backend })
      const persistence = makePersistence(store)
      await backend.seedRawConflict({
        ...conflictRecord('bad-row', 'doc-a', 'archive/a', 'unreadable'),
        version: 2,
      })
      await store.saveConflictDraft(conflictRecord('valid-row', 'doc-a', 'legacy/a', 'older local'))

      // An edit at split side A …
      persistence.schedule(snapshot('edit-side-a', 'archive/a', 1))
      await vi.advanceTimersByTimeAsync(800)
      await vi.runAllTimersAsync()
      await drainWriteQueue()
      expect(await store.getDraft('vault', 'doc-a')).toBeNull()
      expect(await store.listConflictDrafts('vault')).toHaveLength(1)

      // … and at split side B: still no primary, no new candidate, no
      // guessed path — the write flag stays set and flush fails closed.
      persistence.schedule(snapshot('edit-side-b', 'legacy/a', 2))
      await vi.advanceTimersByTimeAsync(800)
      await vi.runAllTimersAsync()
      await drainWriteQueue()
      expect(await store.getDraft('vault', 'doc-a')).toBeNull()
      const conflicts = await store.listConflictDrafts('vault')
      expect(conflicts).toHaveLength(1)
      expect(conflicts[0].conflictId).toBe('valid-row')
      expect(await persistence.flush('vault', 'doc-a')).toBe(false)
      await persistence.dispose()
    })

    scenario('Invariant 6 — an incomplete rename of an indeterminate family writes no guessed-path candidate', async () => {
      const backend = createMemoryDraftBackend()
      const store = createDraftStore({ backend })
      const persistence = makePersistence(store)
      // Split family → the stale tab's edit turns the entry
      // indeterminate: no certifiable family path exists.
      await backend.seedRawConflict({
        ...conflictRecord('bad-row', 'doc-a', 'archive/a', 'unreadable'),
        version: 2,
      })
      await store.saveConflictDraft(conflictRecord('valid-row', 'doc-a', 'legacy/a', 'older local'))
      persistence.schedule(snapshot('stale-edit', 'notes/a', 1))
      await vi.advanceTimersByTimeAsync(800)
      await vi.runAllTimersAsync()
      await drainWriteQueue()
      expect(await store.getDraft('vault', 'doc-a')).toBeNull()

      // The server rename succeeds; the draft family move is blocked by
      // the unreadable row. The entry must NOT receive a guessed
      // familyPath from the rename's fromPath — a candidate later
      // written there would anchor the family to a path the store
      // never certified.
      const barrier = await persistence.prepareFileMutation([identity])
      const [move] = await barrier.commitMoves([{
        ...identity,
        fromPath: 'notes/a',
        toPath: 'archive/b',
      }])
      expect(move.status).toBe('unsupported')
      // move-indeterminate: no certified path → the release's
      // immediate move retry writes nothing and fails closed.
      expect(await barrier.finalizeAfterTabMigration()).toEqual([{
        documentId: 'doc-a',
        oldPath: 'notes/a',
        newPath: 'archive/b',
        status: 'failed',
      }])

      // The post-rename edit retries the atomic family move — blocked
      // again — and writes NOTHING: no primary at the tab path, no
      // candidate at the rename's fromPath. The write flag stays set
      // and flush fails closed until a safe probe succeeds.
      persistence.schedule(snapshot('after-rename', 'archive/b', 2))
      await vi.advanceTimersByTimeAsync(800)
      await vi.runAllTimersAsync()
      await drainWriteQueue()
      expect(await persistence.flush('vault', 'doc-a')).toBe(false)
      expect(await store.getDraft('vault', 'doc-a')).toBeNull()
      const conflicts = await store.listConflictDrafts('vault')
      expect(conflicts).toHaveLength(1)
      expect(conflicts[0]).toMatchObject({
        conflictId: 'valid-row',
        documentPath: 'legacy/a',
      })
      await persistence.dispose()
    })

    for (const { name, run } of scenarios) {
      it(name, run)
    }
  })

  it('identity mismatch followed by a new-path edit', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const persistence = makePersistence(store)
    await store.saveDraft(draft('primary', 'notes/a', 10))
    await store.saveConflictDraft(conflictRecord('conflict-a', 'doc-a', 'notes/a', 'local orphan'))
    const barrier = await persistence.prepareFileMutation([identity])
    // Identity mismatch: the lifecycle reports it, but the barrier
    // receives the actual server target so it can quarantine the
    // entry. commitMoves produces no result for these identities.
    const commitResults = await barrier.commitMoves([], [], [{
      ...identity,
      fromPath: 'notes/a',
      toPath: 'archive/a',
    }])
    expect(commitResults).toEqual([])
    expect(await barrier.finalizeAfterTabMigration()).toEqual([])

    // The next edit on the new path retries the atomic move FIRST
    // (instead of writing the primary alone at archive/a — which would
    // strand the family on notes/a). The retry succeeds and the whole
    // family — primary and the existing conflict — moves to archive/a.
    persistence.schedule(snapshot('after-mismatch', 'archive/a', 2))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      documentPath: 'archive/a',
      content: 'after-mismatch',
    })
    expect((await store.listConflictDrafts('vault')).map((c) => c.documentPath))
      .toEqual(['archive/a'])
    await persistence.dispose()
  })

  it('failed move → reload persistence → edit renamed Tab', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const persistence = makePersistence(store)
    await store.saveDraft(draft('primary', 'notes/a', 10))
    await store.saveConflictDraft(conflictRecord('conflict-a', 'doc-a', 'notes/a', 'local orphan'))
    const barrier = await persistence.prepareFileMutation([identity])
    backend.failNext('moveFamilyConflicts')
    const [move] = await barrier.commitMoves([{
      ...identity,
      fromPath: 'notes/a',
      toPath: 'archive/a',
    }])
    expect(move.status).toBe('failed')
    expect(await barrier.finalizeAfterTabMigration()).toEqual([])

    // Simulate a page reload: dispose this persistence (no snapshot
    // was scheduled, so nothing flushes) and create a fresh instance
    // against the same store. The new instance has no quarantine
    // state. A plain cross-path primary write from the stale Tab must
    // NOT silently drag the family to the new path — the family
    // (primary record + every same-identity conflict candidate) is
    // still whole on the OLD path. The stale Tab's edit becomes an
    // independent conflict candidate next to the family, and the
    // remote primary remains untouched.
    await persistence.dispose()
    const reloaded = makePersistence(store)
    reloaded.schedule(snapshot('after-reload', 'archive/a', 2))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    // The remote primary stays at the family's actual path.
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      documentPath: 'notes/a',
      content: 'primary',
    })
    // The stale Tab's edit lands as a separate candidate pinned to
    // the family's actual path (so a later moveDraftFamily() can
    // migrate it with the rest of the family).
    const conflicts = await store.listConflictDrafts('vault')
    expect(conflicts).toHaveLength(2)
    expect(conflicts.map((c) => c.documentPath).sort())
      .toEqual(['notes/a', 'notes/a'])
    const staleEdit = conflicts.find((c) => c.content === 'after-reload')!
    expect(staleEdit.documentPath).toBe('notes/a')
    expect(staleEdit.origin).toBe('delete-conflict')
    await reloaded.dispose()
  })

  it('A→B fails → B→C succeeds → edit C', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const persistence = makePersistence(store)
    await store.saveDraft(draft('primary', 'notes/a', 10))
    await store.saveConflictDraft(conflictRecord('conflict-a', 'doc-a', 'notes/a', 'local orphan'))
    const barrier = await persistence.prepareFileMutation([{
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'notes/a',
    }])
    // First rename (A→B): the family move fails. Quarantine points at
    // the actual server target.
    backend.failNext('moveFamilyConflicts')
    const [moveA] = await barrier.commitMoves([{
      vaultId: 'vault',
      documentId: 'doc-a',
      fromPath: 'notes/a',
      toPath: 'archive/b',
    }])
    expect(moveA.status).toBe('failed')
    expect(await barrier.finalizeAfterTabMigration()).toEqual([])

    // Second rename (B→C): the server rename succeeded. The barrier
    // must CLEAR the stale quarantine on a successful move — keeping
    // it would let the next edit at C retry the move against the
    // OLD target B and drag the family back from the path it actually
    // lives on now.
    const identityC = {
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'archive/b',
    }
    const barrier2 = await persistence.prepareFileMutation([identityC])
    const [moveBC] = await barrier2.commitMoves([{
      vaultId: 'vault',
      documentId: 'doc-a',
      fromPath: 'archive/b',
      toPath: 'archive/c',
    }])
    expect(moveBC.status).toBe('moved')
    expect(await barrier2.finalizeAfterTabMigration()).toEqual([])

    // Edit at C: no quarantine (it was cleared by the successful
    // move), ordinary write at archive/c — primary and the conflict
    // candidate both end up at archive/c.
    persistence.schedule(snapshot('edit-c', 'archive/c', 2))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      documentPath: 'archive/c',
      content: 'edit-c',
    })
    expect((await store.listConflictDrafts('vault')).map((c) => c.documentPath))
      .toEqual(['archive/c'])
    await persistence.dispose()
  })

  it('notifies the owner when a background family move settles', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const settlements: Array<{
      vaultId: string
      documentId: string
      oldPath: string | null
      newPath: string
      status: 'moved-and-persisted' | 'moved-write-failed' | 'path-authentication-pending' | 'conflict'
    }> = []
    const persistence = createUnsavedDraftPersistence({
      store,
      debounceMs: 800,
      now: () => 100,
      onDraftFamilyMoveSettled: (settlement) => {
        settlements.push(settlement)
      },
    })
    await store.saveDraft(draft('primary', 'notes/a', 10))
    await store.saveConflictDraft(conflictRecord('conflict-a', 'doc-a', 'notes/a', 'local orphan'))
    const barrier = await persistence.prepareFileMutation([identity])
    backend.failNext('moveFamilyConflicts')
    const [move] = await barrier.commitMoves([{
      ...identity,
      fromPath: 'notes/a',
      toPath: 'archive/a',
    }])
    expect(move.status).toBe('failed')
    expect(await barrier.finalizeAfterTabMigration()).toEqual([])

    // First retry: still fails. The latest content lands as a
    // quarantine candidate next to the old family — Recovery must
    // learn about the new candidate.
    backend.failNext('moveFamilyConflicts')
    persistence.schedule(snapshot('after-rename', 'archive/a', 2))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    expect(settlements).toEqual([{
      vaultId: 'vault',
      documentId: 'doc-a',
      oldPath: 'notes/a',
      newPath: 'archive/a',
      status: 'conflict',
    }])

    // Second retry: succeeds. The family moved in the background, and
    // Recovery must follow — the settlement is fired AFTER the
    // latest snapshot is persisted on the new path's primary record
    // (moved-and-persisted), not when the move alone succeeds.
    persistence.schedule(snapshot('healed', 'archive/a', 3))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    expect(settlements).toEqual([
      {
        vaultId: 'vault',
        documentId: 'doc-a',
        oldPath: 'notes/a',
        newPath: 'archive/a',
        status: 'conflict',
      },
      {
        vaultId: 'vault',
        documentId: 'doc-a',
        oldPath: 'notes/a',
        newPath: 'archive/a',
        status: 'moved-and-persisted',
      },
    ])
    await persistence.dispose()
  })

  // Save-outcome and path-authority invariants added for the post-09.5
  // blockers: saveDraft returns a structured outcome (no more boolean
  // compression), the timer reads its channel at fire time (no more
  // schedule-time capture), and a plain primary save refuses to migrate
  // the family across paths without an authoritative mapping.
  it('converts a pre-existing stale primary save into a conflict candidate', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const persistence = makePersistence(store)
    // Warm up the entry so it has a persisted primary at a known timestamp.
    persistence.schedule(snapshot('local-v1', 'notes/a', 1))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    // A cross-context write lands with a strictly newer updatedAt
    // BEFORE the next local save completes — the new saveDraft must
    // surface 'stale' (not silently compress it to false), and the
    // caller must route the local content to the conflict channel
    // instead of dropping it.
    const local = await store.getDraft('vault', 'doc-a')
    await store.saveDraft({ ...local!, content: 'remote-v2', updatedAt: 200 })
    persistence.schedule(snapshot('local-v3', 'notes/a', 2))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()

    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      content: 'remote-v2',
      updatedAt: 200,
    })
    const conflicts = await store.listConflictDrafts('vault')
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({
      content: 'local-v3',
      documentPath: 'notes/a',
      crossContextUpdatedAt: 200,
    })
    await persistence.dispose()
  })

  it('preserves a new edit after reload when family save returns unsupported', async () => {
    // A future-version / corrupt same-identity conflict row forces the
    // family save to surface 'unsupported' — the caller must persist
    // the local content as a separate conflict candidate, not drop it
    // (a plain `saveDraft === false` would have silently thrown the
    // bytes away).
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    await store.saveDraft(draft('primary', 'notes/a', 10))
    await backend.seedRawConflict({
      version: 2,
      conflictId: 'future-conflict',
      vaultId: 'vault',
      documentId: 'doc-a',
      documentPath: 'notes/a',
      content: 'future data',
      baseContentHash: 'base-hash',
      baseModifiedAt: 10.5,
      createdAt: 5,
      updatedAt: 31,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 30,
      recordedAt: 31,
    })
    const persistence = makePersistence(store)
    persistence.schedule(snapshot('new-edit', 'notes/a', 2))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()

    // The primary is left untouched.
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      content: 'primary',
      documentPath: 'notes/a',
    })
    // The new edit lands as a candidate — it must NEVER be silently
    // dropped by a saveDraft==false compression.
    const conflicts = await store.listConflictDrafts('vault')
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({
      content: 'new-edit',
      documentPath: 'notes/a',
    })
    // The future-version row is still in the backend (preserved), but
    // invisible to the lossy `listConflictDrafts` filter. The strict
    // strict read surfaces it as `unsupported` so callers can warn.
    await expect(store.listConflictDraftsStrict('vault', 'doc-a'))
      .resolves.toMatchObject({ status: 'unsupported' })
    const raw = await backend.listConflicts('vault')
    expect(raw.map((value) => (value as { conflictId?: string }).conflictId))
      .toContain('future-conflict')
    await persistence.dispose()
  })

  it('does not silently drop a same-timestamp primary conflict', async () => {
    // Two contexts save at the same `updatedAt` with different bodies
    // — the second save returns 'conflict' (not false). The caller
    // routes the local content to the conflict channel.
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    await store.saveDraft(draft('remote', 'notes/a', 100))
    const persistence = makePersistence(store)
    persistence.schedule(snapshot('local', 'notes/a', 100))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()

    // The primary is byte-identical to the cross-context record —
    // never overwritten with a fresh timestamp.
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      content: 'remote',
      updatedAt: 100,
    })
    // The local edit survives as a conflict candidate.
    const conflicts = await store.listConflictDrafts('vault')
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({
      content: 'local',
      crossContextUpdatedAt: 100,
    })
    await persistence.dispose()
  })

  it('routes an edit made during readback-conflict handoff to the conflict channel', async () => {
    // A local-v3 save is in flight (already returned 'saved' from
    // saveDraft). Before the readback completes, an async candidate
    // save starts. A new local-v5 edit arriving at this exact moment
    // must be routed to the conflict channel when its debounce timer
    // fires — not to the primary store, which would silently bury
    // the cross-context record that won the readback.
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const persistence = makePersistence(store)
    persistence.schedule(snapshot('primary', 'notes/a', 1))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    // Plant a cross-context record with a higher updatedAt.
    const local = await store.getDraft('vault', 'doc-a')
    await store.saveDraft({ ...local!, content: 'remote-v2', updatedAt: 200 })

    // Schedule the local edit; the timer captures NO channel state
    // up front. During the debounce the readback-conflict handoff
    // pins the entry to the conflict channel — when the timer fires
    // it must read the CURRENT (conflict-channel) state and route
    // there, not to the primary store.
    persistence.schedule(snapshot('local-v3', 'notes/a', 2))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()

    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      content: 'remote-v2',
    })
    const conflicts = await store.listConflictDrafts('vault')
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({ content: 'local-v3' })
    await persistence.dispose()
  })

  it('never writes primary from a timer created before the conflict pin', async () => {
    // Variant: the timer is created BEFORE the conflict pin lands.
    // A subsequent edit that schedules against the same entry must
    // also see the pin at fire time. Specifically: schedule the edit,
    // then during the debounce plant a conflict pin by triggering a
    // handoff; when the timer fires it must read the pin and route
    // to the conflict channel.
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const persistence = makePersistence(store)
    persistence.schedule(snapshot('primary', 'notes/a', 1))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    // First edit on the new path lands — its timer reads conflict
    // channel = false (no prior handoff).
    const local = await store.getDraft('vault', 'doc-a')
    await store.saveDraft({ ...local!, content: 'remote-v2', updatedAt: 200 })
    persistence.schedule(snapshot('local-v3', 'notes/a', 2))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    // A second edit arrives AFTER the first handoff pinned the entry.
    persistence.schedule(snapshot('local-v5', 'notes/a', 3))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()

    // Primary is still the cross-context record — never overwritten.
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      content: 'remote-v2',
    })
    // Both local edits are recorded as separate candidates.
    const conflicts = await store.listConflictDrafts('vault')
    expect(conflicts).toHaveLength(2)
    expect(conflicts.map((c) => c.content).sort()).toEqual(['local-v3', 'local-v5'])
    await persistence.dispose()
  })

  it('remote rename moves family to B → stale tab at A edits → family remains at B', async () => {
    // The path-authority invariant: a plain cross-path primary save
    // MUST NOT silently migrate the family. The server file
    // operation is the only authoritative path source.
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    await store.saveDraft(draft('primary', 'archive/a', 100))
    await store.saveConflictDraft(conflictRecord('orphan', 'doc-a', 'archive/a', 'orphan at B'))
    const persistence = makePersistence(store)
    persistence.schedule(snapshot('stale-tab-edit', 'notes/a', 2))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()

    // The family is intact at the path the server actually lives on.
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      documentPath: 'archive/a',
      content: 'primary',
    })
    // The stale-tab edit lands as a separate candidate pinned to the
    // family's actual path — it would migrate with the rest of the
    // family on a future moveDraftFamily(), not be stranded on the
    // stale path forever.
    const conflicts = await store.listConflictDrafts('vault')
    expect(conflicts).toHaveLength(2)
    const staleEdit = conflicts.find((c) => c.content === 'stale-tab-edit')!
    expect(staleEdit.documentPath).toBe('archive/a')
    expect(staleEdit.origin).toBe('delete-conflict')
    await persistence.dispose()
  })

  it('primary at B → stale tab at A edits twice → every candidate remains at B', async () => {
    // The conflict channel must be pinned to the family's authoritative
    // path: the FIRST stale edit lands at B via the path-mismatch
    // handoff, and the SECOND — routed through the conflict channel by
    // the timer — must follow it instead of falling back to the stale
    // tab path the editor still reports (which would re-split the
    // family the channel exists to keep whole).
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    // Primary updatedAt BELOW the persistence clock (now()=100) so the
    // stale edits take the genuine path-mismatch route (a
    // higher-updatedAt save refused on path), not the same-timestamp
    // conflict route.
    await store.saveDraft(draft('primary', 'archive/a', 50))
    const persistence = makePersistence(store)
    persistence.schedule(snapshot('stale-edit-1', 'notes/a', 2))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    persistence.schedule(snapshot('stale-edit-2', 'notes/a', 3))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()

    // The primary is untouched at the family's actual path.
    expect(await store.getDraft('vault', 'doc-a')).toMatchObject({
      documentPath: 'archive/a',
      content: 'primary',
    })
    // BOTH stale edits persisted as candidates at the family path —
    // never at the stale tab path.
    const conflicts = await store.listConflictDrafts('vault')
    expect(conflicts).toHaveLength(2)
    for (const candidate of conflicts) {
      expect(candidate.documentPath).toBe('archive/a')
    }
    expect(conflicts.map((c) => c.content).sort())
      .toEqual(['stale-edit-1', 'stale-edit-2'])
    await persistence.dispose()
  })

  it('primary missing + conflicts at B → stale tab at A edit → candidate at B, no primary created', async () => {
    // A conflict-only document is still a family: its candidates'
    // shared path is authoritative, so a stale tab's edit must NOT
    // create a primary at the stale path (splitting the family) — it
    // becomes a candidate at the family path instead.
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    await store.saveConflictDraft(conflictRecord('orphan-1', 'doc-a', 'archive/a', 'orphan at B'))
    const persistence = makePersistence(store)
    persistence.schedule(snapshot('stale-edit', 'notes/a', 2))
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()

    // No primary was created at the stale path.
    expect(await store.getDraft('vault', 'doc-a')).toBeNull()
    const conflicts = await store.listConflictDrafts('vault')
    expect(conflicts).toHaveLength(2)
    const staleEdit = conflicts.find((c) => c.content === 'stale-edit')!
    expect(staleEdit.documentPath).toBe('archive/a')
    // The candidate records its divergence from the newest family
    // member (the conflict-only anchor's updatedAt).
    expect(staleEdit.crossContextUpdatedAt).toBe(31)
    await persistence.dispose()
  })

  // Gates writePrimary's final readback: the first store.getDraft()
  // call blocks until releaseReadback(), so a test can land a newer
  // edit inside the readback window. readbackStarted resolves once the
  // gate is engaged (pure microtask waiting — safe under fake timers).
  function gatedReadback(store: DraftStore) {
    const originalGetDraft = store.getDraft.bind(store)
    let releaseReadback!: () => void
    const readbackGate = new Promise<void>((resolve) => { releaseReadback = resolve })
    let notifyStarted!: () => void
    const readbackStarted = new Promise<void>((resolve) => { notifyStarted = resolve })
    let gated = false
    vi.spyOn(store, 'getDraft').mockImplementation(async (vaultId, documentId) => {
      if (!gated) {
        gated = true
        notifyStarted()
        await readbackGate
      }
      return originalGetDraft(vaultId, documentId)
    })
    return {
      waitReadbackStarted: () => readbackStarted,
      releaseReadback: () => releaseReadback(),
    }
  }

  it('keeps latestSnapshotNeedsWrite set after readback supersession', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const persistence = makePersistence(store)
    const gate = gatedReadback(store)
    persistence.schedule(snapshot('local-v2', 'notes/a', 2))
    // Fire the debounce: writePrimary saves revision 2, then blocks on
    // the gated final readback.
    await vi.advanceTimersByTimeAsync(800)
    await gate.waitReadbackStarted()
    // A newer edit lands inside the readback window. The readback will
    // still return the just-written revision 2 (equal to the attempted
    // draft) — clearing the write flag on that stale match would leave
    // revision 3 displayed in the editor while every flush path
    // believes it is already persisted.
    persistence.schedule(snapshot('local-v3', 'notes/a', 3))
    gate.releaseReadback()
    // Let revision 2's write settle completely BEFORE flushing: the
    // bug is observable only once the stale readback match has
    // (wrongly) cleared the superseding edit's write flag. Flushing
    // earlier would chain a write behind the in-flight task and mask
    // the flag. advanceTimersByTimeAsync(0) drains microtasks without
    // firing revision 3's 800ms debounce.
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    await Promise.resolve()

    // flush must still see revision 3 as pending and persist it.
    const flushed = await persistence.flush('vault', 'doc-a')
    expect(flushed).toBe(true)
    expect((await store.getDraft('vault', 'doc-a'))?.content).toBe('local-v3')
    await persistence.dispose()
  })

  it('flushes the newer edit on pagehide after readback supersession', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const targetWindow = new EventTarget()
    const persistence = makePersistence(store, targetWindow)
    const gate = gatedReadback(store)
    persistence.schedule(snapshot('local-v2', 'notes/a', 2))
    await vi.advanceTimersByTimeAsync(800)
    await gate.waitReadbackStarted()
    persistence.schedule(snapshot('local-v3', 'notes/a', 3))
    gate.releaseReadback()
    // Let revision 2's write settle completely first (see the flush
    // variant for the rationale): the stale readback match must have
    // done its (wrong) flag clear before pagehide observes the entry.
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    await Promise.resolve()

    // pagehide fires before the newer edit's debounce elapses. Its
    // flush queues the write synchronously; the explicit flush chains
    // on the same pending write and awaits it to completion (under
    // the old bug both saw the cleared flag and queued nothing).
    targetWindow.dispatchEvent(new Event('pagehide'))
    await persistence.flush('vault', 'doc-a')
    expect((await store.getDraft('vault', 'doc-a'))?.content).toBe('local-v3')
    await persistence.dispose()
  })

  it('fails closed when an edit lands during the final readback of a close seal write', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const persistence = makePersistence(store)
    const barrier = await persistence.prepareFileMutation([identity])
    // Install the gate AFTER prepareFileMutation (its confirmedDraft
    // read would otherwise engage the gate first).
    const gate = gatedReadback(store)
    // Release the entry without writing anything (no snapshot yet) so
    // the close seal can pick it up — the seal skips identities still
    // holding the barrier token.
    const [preserve] = await barrier.commitDeletes([{ ...identity, policy: 'preserve' }])
    expect(preserve.status).toBe('preserved')
    persistence.schedule(snapshot('local-v2', 'notes/a', 2))
    // The seal's phase-2 write saves revision 2, then blocks on the
    // gated final readback.
    const sealing = barrier.finalizeBeforeDocumentClose()
    await gate.waitReadbackStarted()
    // An edit typed during the seal's readback window: schedule()
    // advances the generation and snapshot but arms no timer (the
    // close seal holds the fileTransaction token).
    persistence.schedule(snapshot('local-v3', 'notes/a', 3))
    gate.releaseReadback()
    const results = await sealing

    // The seal fails closed — the tab stays open …
    expect(results).toEqual([{
      documentId: 'doc-a',
      oldPath: 'notes/a',
      status: 'failed',
    }])
    // … and because the stale readback did NOT clear the superseding
    // edit's write flag, the seal's re-arm persists revision 3 in the
    // background (the old bug cleared it, so the re-arm never fired
    // and revision 3 existed only in coordinator memory while every
    // flush path believed it was durable).
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    expect((await store.getDraft('vault', 'doc-a'))?.content).toBe('local-v3')
    await persistence.dispose()
  })
})

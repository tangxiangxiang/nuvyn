import { beforeEach, describe, expect, it } from 'vitest'
import {
  createDraftStore,
  createMemoryDraftBackend,
  type MemoryDraftStorageBackend,
} from '../draftStore'
import type { DraftConflictRecord, UnsavedDraft } from '../draftTypes'

function draft(
  documentId: string,
  updatedAt: number,
  overrides: Partial<UnsavedDraft> = {},
): UnsavedDraft {
  return {
    version: 1,
    vaultId: 'vault-a',
    documentId,
    documentPath: `notes/${documentId}`,
    content: `content:${documentId}:${updatedAt}`,
    baseContentHash: `hash:${documentId}`,
    baseModifiedAt: 100,
    createdAt: 10,
    updatedAt,
    ...overrides,
  }
}

describe('draftStore characterization', () => {
  let backend: MemoryDraftStorageBackend
  let store: ReturnType<typeof createDraftStore>

  beforeEach(() => {
    backend = createMemoryDraftBackend()
    store = createDraftStore({ backend })
  })

  it('round-trips valid drafts without sharing mutable references', async () => {
    const value = draft('a', 20)

    const outcome = await store.saveDraft(value)
    expect(outcome.status).toBe('saved')
    value.content = 'caller mutation'

    const firstRead = await store.getDraft('vault-a', 'a')
    expect(firstRead?.content).toBe('content:a:20')

    firstRead!.content = 'read mutation'
    expect((await store.getDraft('vault-a', 'a'))?.content).toBe('content:a:20')
  })

  it('stores immutable parallel conflict candidates without replacing the primary draft', async () => {
    const primary = draft('a', 30, { content: 'cross-context' })
    const conflict: DraftConflictRecord = {
      version: 1,
      conflictId: 'local-conflict',
      vaultId: 'vault-a',
      documentId: 'a',
      documentPath: 'notes/a',
      content: 'local edit',
      baseContentHash: 'hash:a',
      baseModifiedAt: 100,
      createdAt: 10,
      updatedAt: 31,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 30,
      recordedAt: 31,
    }
    await store.saveDraft(primary)

    await expect(store.saveConflictDraft(conflict))
      .resolves.toEqual({ status: 'saved' })
    await expect(store.saveConflictDraft({ ...conflict, content: 'replacement' }))
      .resolves.toEqual({ status: 'failed' })

    expect(await store.getDraft('vault-a', 'a')).toEqual(primary)
    expect(await store.listConflictDrafts('vault-a')).toEqual([conflict])
    await expect(store.deleteConflictDraft('vault-a', 'a', 'local-conflict'))
      .resolves.toBe('deleted')
    await expect(store.deleteConflictDraft('vault-a', 'a', 'local-conflict'))
      .resolves.toBe('missing')
  })

  it('keeps vaults isolated and lists newest drafts first deterministically', async () => {
    await store.saveDraft(draft('b', 30))
    await store.saveDraft(draft('a', 30))
    await store.saveDraft(draft('old', 20))
    await store.saveDraft(draft('other', 99, { vaultId: 'vault-b' }))

    expect((await store.listDrafts('vault-a')).map((value) => value.documentId))
      .toEqual(['a', 'b', 'old'])
    expect((await store.listDrafts('vault-b')).map((value) => value.documentId))
      .toEqual(['other'])
  })

  it('rejects stale and conflicting equal-timestamp writes', async () => {
    expect((await store.saveDraft(draft('a', 30))).status).toBe('saved')
    expect((await store.saveDraft(draft('a', 20, { content: 'stale' }))).status).toBe('stale')
    expect((await store.saveDraft(draft('a', 30))).status).toBe('saved')
    expect((await store.saveDraft(draft('a', 30, { content: 'conflict' }))).status).toBe('conflict')

    expect((await store.getDraft('vault-a', 'a'))?.content).toBe('content:a:30')
  })

  it('does not overwrite a future-version record at the same identity', async () => {
    const future = { ...draft('a', 40), version: 2, content: 'future data' }
    await backend.seedRaw(future)

    expect((await store.saveDraft(draft('a', 50))).status).toBe('unsupported')
    expect(await backend.get(['vault-a', 'a'])).toEqual(future)
  })

  it('preserves the original createdAt when updating a draft', async () => {
    await store.saveDraft(draft('a', 20, { createdAt: 5 }))

    const outcome = await store.saveDraft(draft('a', 30, { createdAt: 25 }))
    expect(outcome.status).toBe('saved')
    expect(await store.getDraft('vault-a', 'a')).toEqual(
      draft('a', 30, { createdAt: 5 }),
    )
  })

  it('atomically refuses to delete a draft changed by another context', async () => {
    const original = draft('a', 20, { content: 'v1' })
    const newer = draft('a', 30, { content: 'v2' })
    await expect(store.saveDraft(original)).resolves.toMatchObject({ status: 'saved' })
    await expect(store.saveDraft(newer)).resolves.toMatchObject({ status: 'saved' })

    await expect(store.deleteDraftIfUnchanged(original))
      .resolves.toEqual({ status: 'stale' })
    await expect(store.getDraft('vault-a', 'a')).resolves.toMatchObject({
      content: 'v2',
      updatedAt: 30,
    })
    await expect(store.deleteDraftIfUnchanged(newer))
      .resolves.toEqual({ status: 'deleted' })
  })

  it('rejects invalid records without affecting existing drafts', async () => {
    await store.saveDraft(draft('valid', 20))

    expect((await store.saveDraft(draft('', 20))).status).toBe('unsupported')
    expect((await store.saveDraft(draft('bad-time', 5, { createdAt: 10 }))).status).toBe('unsupported')
    expect((await store.saveDraft({
      ...draft('future', 20),
      version: 2,
    } as unknown as UnsavedDraft)).status).toBe('unsupported')

    expect((await store.listDrafts('vault-a')).map((value) => value.documentId))
      .toEqual(['valid'])
  })

  it('deletes and clears idempotently without crossing vault boundaries', async () => {
    await store.saveDraft(draft('a', 20))
    await store.saveDraft(draft('b', 21))
    await store.saveDraft(draft('a', 22, { vaultId: 'vault-b' }))

    expect(await store.deleteDraft('vault-a', 'a')).toEqual({ status: 'deleted' })
    expect(await store.deleteDraft('vault-a', 'a')).toEqual({ status: 'missing' })
    expect(await store.clearVaultDrafts('vault-a')).toBe(true)
    expect(await store.listDrafts('vault-a')).toEqual([])
    expect((await store.getDraft('vault-b', 'a'))?.content).toBe('content:a:22')
  })

  it('does not delete unsupported records during normal lifecycle cleanup', async () => {
    const future = { ...draft('future', 30), version: 2 }
    const corrupt = { ...draft('corrupt', 31), content: 42 }
    await backend.seedRaw(future)
    await backend.seedRaw(corrupt)
    await store.saveDraft(draft('valid', 32))

    expect(await store.deleteDraft('vault-a', 'future'))
      .toEqual({ status: 'unsupported' })
    expect(await store.clearVaultDrafts('vault-a')).toBe(true)
    expect(await backend.get(['vault-a', 'future'])).toEqual(future)
    expect(await backend.get(['vault-a', 'corrupt'])).toEqual(corrupt)
    expect(await store.getDraft('vault-a', 'valid')).toBeNull()
  })

  it('leaves legacy managed Diary drafts and conflicts untouched', async () => {
    const managed = draft('diary-day', 30, {
      documentPath: 'diary/2026-08-31',
      content: 'legacy plaintext must remain for D8.4',
    })
    const managedConflict: DraftConflictRecord = {
      version: 1,
      conflictId: 'legacy-conflict',
      vaultId: 'vault-a',
      documentId: 'diary-day',
      documentPath: 'diary/2026-08-31',
      content: 'legacy conflict plaintext must remain for D8.4',
      baseContentHash: null,
      baseModifiedAt: null,
      createdAt: 10,
      updatedAt: 31,
      origin: 'delete-conflict',
      crossContextUpdatedAt: null,
      recordedAt: 31,
    }
    await backend.seedRaw(managed)
    await backend.seedRawConflict(managedConflict)

    expect(await store.deleteDraft('vault-a', 'diary-day'))
      .toEqual({ status: 'unsupported' })
    expect(await store.deleteConflictDraft('vault-a', 'diary-day', 'legacy-conflict'))
      .toBe('unsupported')
    expect(await store.moveDraft('vault-a', 'diary-day', 'renamed', 'notes/renamed'))
      .toEqual({ status: 'unsupported' })
    expect(await store.moveConflicts('vault-a', 'diary-day', 'renamed', 'notes/renamed'))
      .toBe(0)
    expect((await store.moveDraftFamily('vault-a', 'diary-day', 'notes/renamed')).status)
      .toBe('unsupported')
    expect(await store.clearVaultDrafts('vault-a')).toBe(true)
    expect(await store.clearVaultConflictDrafts('vault-a')).toBe(true)

    expect(await backend.get(['vault-a', 'diary-day'])).toEqual(managed)
    expect(await backend.listConflicts('vault-a')).toEqual([managedConflict])
    expect(await store.listDrafts('vault-a')).toEqual([])
    expect(await store.listConflictDrafts('vault-a')).toEqual([])
  })

  it('lists safe-integer record timestamps and accepts finite filesystem mtimes', async () => {
    const unsafe = Number.MAX_SAFE_INTEGER + 1

    const safe = await store.saveDraft(draft('boundary', Number.MAX_SAFE_INTEGER, {
      baseModifiedAt: 1_721_234_567_890.625,
    }))
    expect(safe.status).toBe('saved')

    const invalidCreated = await store.saveDraft(draft('created', unsafe, {
      createdAt: unsafe,
    })).catch(() => ({ status: 'unsupported' as const }))
    expect(invalidCreated.status).toBe('unsupported')

    const invalidUpdated = await store.saveDraft(draft('updated', unsafe))
      .catch(() => ({ status: 'unsupported' as const }))
    expect(invalidUpdated.status).toBe('unsupported')

    const largeMtime = await store.saveDraft(draft('large-mtime', 30, {
      baseModifiedAt: unsafe,
    }))
    expect(largeMtime.status).toBe('saved')

    const infiniteMtime = await store.saveDraft(draft('infinite-mtime', 31, {
      baseModifiedAt: Number.POSITIVE_INFINITY,
    })).catch(() => ({ status: 'unsupported' as const }))
    expect(infiniteMtime.status).toBe('unsupported')

    expect((await store.listDrafts('vault-a')).map((value) => value.documentId))
      .toEqual(['boundary', 'large-mtime'])
  })

  it('moves a draft atomically while preserving its content and baseline', async () => {
    const original = draft('a', 20)
    await store.saveDraft(original)

    expect(await store.moveDraft('vault-a', 'a', 'x', 'renamed/x'))
      .toEqual({ status: 'moved' })
    expect(await store.getDraft('vault-a', 'a')).toBeNull()
    expect(await store.getDraft('vault-a', 'x')).toEqual({
      ...original,
      documentId: 'x',
      documentPath: 'renamed/x',
    })
  })

  it('preserves both drafts when a different move target already exists', async () => {
    await store.saveDraft(draft('source', 40, { createdAt: 4 }))
    const target = draft('target', 30, {
      content: 'different target',
      createdAt: 3,
    })
    await store.saveDraft(target)

    expect(await store.moveDraft(
      'vault-a',
      'source',
      'target',
      'renamed/target',
    )).toEqual({ status: 'conflict' })
    expect(await store.getDraft('vault-a', 'source'))
      .toEqual(draft('source', 40, { createdAt: 4 }))
    expect(await store.getDraft('vault-a', 'target')).toEqual(target)
  })

  it('fails an equal-timestamp duplicate move without changing either record', async () => {
    const source = draft('source', 30)
    const target = draft('target', 30, { content: 'different target' })
    await store.saveDraft(source)
    await store.saveDraft(target)

    expect(await store.moveDraft(
      'vault-a',
      'source',
      'target',
      'renamed/target',
    )).toEqual({ status: 'conflict' })
    expect(await store.getDraft('vault-a', 'source')).toEqual(source)
    expect(await store.getDraft('vault-a', 'target')).toEqual(target)
  })

  it('leaves the source intact when an atomic move fails', async () => {
    const original = draft('source', 30)
    await store.saveDraft(original)
    backend.failNext('move')

    expect(await store.moveDraft(
      'vault-a',
      'source',
      'target',
      'renamed/target',
    )).toEqual({ status: 'failed' })
    expect(await store.getDraft('vault-a', 'source')).toEqual(original)
    expect(await store.getDraft('vault-a', 'target')).toBeNull()
  })

  it('does not overwrite a corrupt move target', async () => {
    const source = draft('source', 30)
    const corruptTarget = { ...draft('target', 20), content: 42 }
    await store.saveDraft(source)
    await backend.seedRaw(corruptTarget)

    expect(await store.moveDraft(
      'vault-a',
      'source',
      'target',
      'renamed/target',
    )).toEqual({ status: 'unsupported' })
    expect(await store.getDraft('vault-a', 'source')).toEqual(source)
    expect(await backend.get(['vault-a', 'target'])).toEqual(corruptTarget)
  })

  it('reports a missing source as an idempotent no-op', async () => {
    expect(await store.moveDraft(
      'vault-a',
      'missing',
      'target',
      'renamed/target',
    )).toEqual({ status: 'missing' })
  })

  it('skips corrupt and future records without hiding valid drafts', async () => {
    await backend.seedRaw(draft('valid', 30))
    await backend.seedRaw({ ...draft('future', 40), version: 2 })
    await backend.seedRaw({ ...draft('broken', 50), content: 42 })

    expect((await store.listDrafts('vault-a')).map((value) => value.documentId))
      .toEqual(['valid'])
    expect(await store.getDraft('vault-a', 'future')).toBeNull()
    expect(await store.getDraft('vault-a', 'broken')).toBeNull()
  })

  it('turns backend failures into safe results without rejected promises', async () => {
    backend.failNext('save')
    await expect(store.saveDraft(draft('a', 20))).resolves.toEqual({ status: 'failed' })

    backend.failNext('get')
    await expect(store.getDraft('vault-a', 'a')).resolves.toBeNull()

    backend.failNext('list')
    await expect(store.listDrafts('vault-a')).resolves.toEqual([])

    backend.failNext('delete')
    await expect(store.deleteDraft('vault-a', 'a'))
      .resolves.toEqual({ status: 'failed' })

    backend.failNext('clear')
    await expect(store.clearVaultDrafts('vault-a')).resolves.toBe(false)
  })

  it('fails safely when IndexedDB is unavailable', async () => {
    const unavailable = createDraftStore({ indexedDB: undefined })

    await expect(unavailable.saveDraft(draft('a', 20))).resolves.toEqual({ status: 'failed' })
    await expect(unavailable.getDraft('vault-a', 'a')).resolves.toBeNull()
    await expect(unavailable.listDrafts('vault-a')).resolves.toEqual([])
    await expect(unavailable.deleteDraft('vault-a', 'a'))
      .resolves.toEqual({ status: 'failed' })
    await expect(
      unavailable.moveDraft('vault-a', 'a', 'x', 'notes/x'),
    ).resolves.toEqual({ status: 'failed' })
    await expect(unavailable.clearVaultDrafts('vault-a')).resolves.toBe(false)
    await expect(unavailable.moveConflicts('vault-a', 'a', 'a', 'notes/x'))
      .resolves.toBe(0)
    await expect(unavailable.moveDraftFamily('vault-a', 'a', 'notes/x'))
      .resolves.toEqual({ status: 'failed', movedConflicts: 0 })
    await expect(
      unavailable.moveDraftFamilyIfAtPath('vault-a', 'a', 'notes/x', 'archive/x'),
    ).resolves.toEqual({ status: 'failed' })
    await expect(unavailable.probeDraftFamily('vault-a', 'a'))
      .resolves.toEqual({ status: 'failed' })
  })

  it('migrates every conflict record path on rename, preserving identity and body', async () => {
    const conflictA: DraftConflictRecord = {
      version: 1,
      conflictId: 'conflict-a',
      vaultId: 'vault-a',
      documentId: 'a',
      documentPath: 'notes/a',
      content: 'local orphan A',
      baseContentHash: 'hash:a',
      baseModifiedAt: 100,
      createdAt: 10,
      updatedAt: 31,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 30,
      recordedAt: 31,
    }
    const conflictB: DraftConflictRecord = {
      ...conflictA,
      conflictId: 'conflict-b',
      content: 'local orphan B',
      updatedAt: 32,
      recordedAt: 32,
    }
    const otherDoc: DraftConflictRecord = {
      ...conflictA,
      conflictId: 'conflict-other',
      documentId: 'b',
      documentPath: 'notes/b',
    }
    await store.saveConflictDraft(conflictA)
    await store.saveConflictDraft(conflictB)
    await store.saveConflictDraft(otherDoc)

    await expect(store.moveConflicts('vault-a', 'a', 'a', 'archive/a'))
      .resolves.toBe(2)

    const moved = await store.listConflictDrafts('vault-a')
    const movedA = moved.find((value) => value.conflictId === 'conflict-a')
    const movedB = moved.find((value) => value.conflictId === 'conflict-b')
    const untouched = moved.find((value) => value.conflictId === 'conflict-other')
    // Path follows the rename; conflictId, body, baseline, timestamps,
    // and origin are all preserved.
    expect(movedA).toEqual({ ...conflictA, documentPath: 'archive/a' })
    expect(movedB).toEqual({ ...conflictB, documentPath: 'archive/a' })
    expect(untouched).toEqual(otherDoc)
  })

  it('moves the primary and conflict records as one family operation', async () => {
    const original = draft('a', 20)
    await store.saveDraft(original)
    const conflictA: DraftConflictRecord = {
      version: 1,
      conflictId: 'conflict-a',
      vaultId: 'vault-a',
      documentId: 'a',
      documentPath: 'notes/a',
      content: 'local orphan A',
      baseContentHash: 'hash:a',
      baseModifiedAt: 100,
      createdAt: 10,
      updatedAt: 31,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 30,
      recordedAt: 31,
    }
    const conflictB: DraftConflictRecord = {
      ...conflictA,
      conflictId: 'conflict-b',
      content: 'local orphan B',
      updatedAt: 32,
      recordedAt: 32,
    }
    const otherDoc: DraftConflictRecord = {
      ...conflictA,
      conflictId: 'conflict-other',
      documentId: 'b',
      documentPath: 'notes/b',
    }
    await store.saveConflictDraft(conflictA)
    await store.saveConflictDraft(conflictB)
    await store.saveConflictDraft(otherDoc)

    await expect(store.moveDraftFamily('vault-a', 'a', 'archive/a'))
      .resolves.toEqual({ status: 'moved', movedConflicts: 2 })

    // Primary and conflicts follow the rename together; identity, body,
    // baseline, timestamps, and origin are preserved. Other identities
    // are untouched.
    expect(await store.getDraft('vault-a', 'a')).toEqual({
      ...original,
      documentPath: 'archive/a',
    })
    const moved = await store.listConflictDrafts('vault-a')
    expect(moved.find((value) => value.conflictId === 'conflict-a'))
      .toEqual({ ...conflictA, documentPath: 'archive/a' })
    expect(moved.find((value) => value.conflictId === 'conflict-b'))
      .toEqual({ ...conflictB, documentPath: 'archive/a' })
    expect(moved.find((value) => value.conflictId === 'conflict-other'))
      .toEqual(otherDoc)
  })

  it('moves a conflict-only family and reports the missing primary', async () => {
    const conflict: DraftConflictRecord = {
      version: 1,
      conflictId: 'conflict-a',
      vaultId: 'vault-a',
      documentId: 'a',
      documentPath: 'notes/a',
      content: 'local orphan',
      baseContentHash: 'hash:a',
      baseModifiedAt: 100,
      createdAt: 10,
      updatedAt: 31,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 30,
      recordedAt: 31,
    }
    await store.saveConflictDraft(conflict)

    await expect(store.moveDraftFamily('vault-a', 'a', 'archive/a'))
      .resolves.toEqual({ status: 'missing', movedConflicts: 1 })
    expect(await store.listConflictDrafts('vault-a'))
      .toEqual([{ ...conflict, documentPath: 'archive/a' }])
  })

  it('reports a failed family move without touching either store', async () => {
    const original = draft('a', 20)
    await store.saveDraft(original)
    const conflict: DraftConflictRecord = {
      version: 1,
      conflictId: 'conflict-a',
      vaultId: 'vault-a',
      documentId: 'a',
      documentPath: 'notes/a',
      content: 'local orphan',
      baseContentHash: 'hash:a',
      baseModifiedAt: 100,
      createdAt: 10,
      updatedAt: 31,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 30,
      recordedAt: 31,
    }
    await store.saveConflictDraft(conflict)
    backend.failNext('moveFamily')

    await expect(store.moveDraftFamily('vault-a', 'a', 'archive/a'))
      .resolves.toEqual({ status: 'failed', movedConflicts: 0 })
    expect(await store.getDraft('vault-a', 'a')).toEqual(original)
    expect(await store.listConflictDrafts('vault-a')).toEqual([conflict])
  })

  it('fails a family move atomically when the conflict phase fails', async () => {
    const original = draft('a', 20)
    await store.saveDraft(original)
    const conflict: DraftConflictRecord = {
      version: 1,
      conflictId: 'conflict-a',
      vaultId: 'vault-a',
      documentId: 'a',
      documentPath: 'notes/a',
      content: 'local orphan',
      baseContentHash: 'hash:a',
      baseModifiedAt: 100,
      createdAt: 10,
      updatedAt: 31,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 30,
      recordedAt: 31,
    }
    await store.saveConflictDraft(conflict)
    // The conflict phase fails AFTER the primary decision was computed:
    // the primary must NOT be left renamed with conflicts stranded on
    // the old path (the memory backend applies the family in one step,
    // mirroring the IndexedDB cross-store transaction rollback).
    backend.failNext('moveFamilyConflicts')

    await expect(store.moveDraftFamily('vault-a', 'a', 'archive/a'))
      .resolves.toEqual({ status: 'failed', movedConflicts: 0 })
    expect(await store.getDraft('vault-a', 'a')).toEqual(original)
    expect(await store.listConflictDrafts('vault-a')).toEqual([conflict])
  })

  it('keeps valid conflicts on the old path when the primary is unsupported', async () => {
    // A future-version primary cannot migrate. Moving the conflicts
    // anyway would split the family: persistence keeps the in-memory
    // snapshot on the old path for an unsupported result, so the
    // conflicts must stay with it.
    const future = { ...draft('a', 40), version: 2, content: 'future data' }
    await backend.seedRaw(future)
    const conflict: DraftConflictRecord = {
      version: 1,
      conflictId: 'conflict-a',
      vaultId: 'vault-a',
      documentId: 'a',
      documentPath: 'notes/a',
      content: 'local orphan',
      baseContentHash: 'hash:a',
      baseModifiedAt: 100,
      createdAt: 10,
      updatedAt: 31,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 30,
      recordedAt: 31,
    }
    await store.saveConflictDraft(conflict)

    await expect(store.moveDraftFamily('vault-a', 'a', 'archive/a'))
      .resolves.toEqual({ status: 'unsupported', movedConflicts: 0 })
    expect(await backend.get(['vault-a', 'a'])).toEqual(future)
    expect(await store.listConflictDrafts('vault-a')).toEqual([conflict])
  })

  it('blocks the whole family move on a future-version conflict record', async () => {
    const original = draft('a', 20)
    await store.saveDraft(original)
    const valid: DraftConflictRecord = {
      version: 1,
      conflictId: 'conflict-a',
      vaultId: 'vault-a',
      documentId: 'a',
      documentPath: 'notes/a',
      content: 'local orphan',
      baseContentHash: 'hash:a',
      baseModifiedAt: 100,
      createdAt: 10,
      updatedAt: 31,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 30,
      recordedAt: 31,
    }
    await store.saveConflictDraft(valid)
    await backend.seedRawConflict({
      ...valid,
      conflictId: 'conflict-future',
      version: 2,
      content: 'future conflict data',
    })

    // One unreadable row for this identity blocks the entire move —
    // migrating the valid row would strand the future-version one on
    // the pre-rename path with no warning.
    await expect(store.moveDraftFamily('vault-a', 'a', 'archive/a'))
      .resolves.toEqual({ status: 'unsupported', movedConflicts: 0 })
    expect(await store.getDraft('vault-a', 'a')).toEqual(original)
    expect(await store.listConflictDrafts('vault-a')).toEqual([valid])
    // The future-version row is still there, untouched.
    expect(await backend.listConflicts('vault-a')).toHaveLength(2)
  })

  it('blocks the whole family move on a corrupt conflict record', async () => {
    const original = draft('a', 20)
    await store.saveDraft(original)
    const valid: DraftConflictRecord = {
      version: 1,
      conflictId: 'conflict-a',
      vaultId: 'vault-a',
      documentId: 'a',
      documentPath: 'notes/a',
      content: 'local orphan',
      baseContentHash: 'hash:a',
      baseModifiedAt: 100,
      createdAt: 10,
      updatedAt: 31,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 30,
      recordedAt: 31,
    }
    await store.saveConflictDraft(valid)
    await backend.seedRawConflict({
      ...valid,
      conflictId: 'conflict-corrupt',
      content: 42,
    })

    await expect(store.moveDraftFamily('vault-a', 'a', 'archive/a'))
      .resolves.toEqual({ status: 'unsupported', movedConflicts: 0 })
    expect(await store.getDraft('vault-a', 'a')).toEqual(original)
    expect(await store.listConflictDrafts('vault-a')).toEqual([valid])
  })

  it('reports a failed conflict list read instead of an empty list', async () => {
    const conflict: DraftConflictRecord = {
      version: 1,
      conflictId: 'conflict-a',
      vaultId: 'vault-a',
      documentId: 'a',
      documentPath: 'notes/a',
      content: 'local orphan',
      baseContentHash: 'hash:a',
      baseModifiedAt: 100,
      createdAt: 10,
      updatedAt: 31,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 30,
      recordedAt: 31,
    }
    await store.saveConflictDraft(conflict)

    // Discovery keeps the lossy [] fallback (best-effort by nature)...
    backend.failNext('listConflicts')
    await expect(store.listConflictDrafts('vault-a')).resolves.toEqual([])
    // ...but file transactions get a structured failure so they never
    // mistake an unread store for an empty one and report a full
    // delete on top of unread survivors.
    backend.failNext('listConflicts')
    await expect(store.listConflictDraftsStrict('vault-a'))
      .resolves.toEqual({ status: 'failed' })
    await expect(store.listConflictDraftsStrict('vault-a'))
      .resolves.toEqual({ status: 'ok', records: [conflict] })
  })

  it('reports unsupported when a same-identity conflict row is future-version', async () => {
    const valid: DraftConflictRecord = {
      version: 1,
      conflictId: 'conflict-a',
      vaultId: 'vault-a',
      documentId: 'a',
      documentPath: 'notes/a',
      content: 'local orphan',
      baseContentHash: 'hash:a',
      baseModifiedAt: 100,
      createdAt: 10,
      updatedAt: 31,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 30,
      recordedAt: 31,
    }
    await store.saveConflictDraft(valid)
    // A future-version row the UI can never see — same identity —
    // seeded behind the store's validation.
    await backend.seedRawConflict({
      ...valid,
      conflictId: 'conflict-future',
      version: 2,
      content: 'future conflict data',
    })
    // A different identity's valid row in the same vault.
    const other: DraftConflictRecord = {
      ...valid,
      conflictId: 'conflict-b',
      documentId: 'b',
      documentPath: 'notes/b',
    }
    await store.saveConflictDraft(other)

    // Identity-scoped: the unreadable row for 'a' means the store
    // cannot certify that identity's conflict state — 'unsupported'
    // instead of silently filtering the row behind an empty list (a
    // 'deleted' certified on top would outlive the row with no
    // warning), mirroring the family move's raw-row pre-flight.
    await expect(store.listConflictDraftsStrict('vault-a', 'a'))
      .resolves.toEqual({ status: 'unsupported' })
    // A clean identity in the same vault still reads ok, scoped to its
    // own records.
    await expect(store.listConflictDraftsStrict('vault-a', 'b'))
      .resolves.toEqual({ status: 'ok', records: [other] })
    // A vault-wide strict read fails closed on ANY unreadable row.
    await expect(store.listConflictDraftsStrict('vault-a'))
      .resolves.toEqual({ status: 'unsupported' })
  })

  it('reports unsupported when a same-identity conflict row is corrupt', async () => {
    const valid: DraftConflictRecord = {
      version: 1,
      conflictId: 'conflict-a',
      vaultId: 'vault-a',
      documentId: 'a',
      documentPath: 'notes/a',
      content: 'local orphan',
      baseContentHash: 'hash:a',
      baseModifiedAt: 100,
      createdAt: 10,
      updatedAt: 31,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 30,
      recordedAt: 31,
    }
    await store.saveConflictDraft(valid)
    await backend.seedRawConflict({
      ...valid,
      conflictId: 'conflict-corrupt',
      content: 42,
    })

    await expect(store.listConflictDraftsStrict('vault-a', 'a'))
      .resolves.toEqual({ status: 'unsupported' })
    // The lossy discovery read still filters the corrupt row away.
    expect(await store.listConflictDrafts('vault-a')).toEqual([valid])
  })

  it('reports a conflict delete store error as failed, not missing', async () => {
    const conflict: DraftConflictRecord = {
      version: 1,
      conflictId: 'conflict-a',
      vaultId: 'vault-a',
      documentId: 'a',
      documentPath: 'notes/a',
      content: 'local orphan',
      baseContentHash: 'hash:a',
      baseModifiedAt: 100,
      createdAt: 10,
      updatedAt: 31,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 30,
      recordedAt: 31,
    }
    await store.saveConflictDraft(conflict)

    backend.failNext('deleteConflict')
    // A store error must surface as 'failed' so callers don't treat it
    // as a successful (missing) delete and drop the still-present record.
    await expect(store.deleteConflictDraft('vault-a', 'a', 'conflict-a'))
      .resolves.toBe('failed')
    expect(await store.listConflictDrafts('vault-a')).toEqual([conflict])

    await expect(store.deleteConflictDraft('vault-a', 'a', 'conflict-a'))
      .resolves.toBe('deleted')
    expect(await store.listConflictDrafts('vault-a')).toEqual([])
  })

  // Store-level path authority (the reload-proof invariant for the new
  // blocker 3): a plain primary save must NEVER silently migrate the
  // family to a different path. Path changes are only authoritative
  // when they come from an explicit commitMoves() mapping (or a
  // persistent quarantine) — a stale old-path Tab's edit must surface
  // as `path-mismatch` so the caller can promote the local content to
  // an independent conflict candidate instead of dragging the family
  // back from the path the server actually lives on. Without this, a
  // post-reload write from a stale Tab would re-split the family.

  it('returns path-mismatch on a cross-path primary save and leaves the family intact', async () => {
    await store.saveDraft(draft('a', 10))
    await store.saveConflictDraft({
      version: 1,
      conflictId: 'conflict-a',
      vaultId: 'vault-a',
      documentId: 'a',
      documentPath: 'notes/a',
      content: 'local orphan',
      baseContentHash: 'hash:a',
      baseModifiedAt: 100,
      createdAt: 10,
      updatedAt: 31,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 30,
      recordedAt: 31,
    } as DraftConflictRecord)

    const outcome = await store.saveDraft(draft('a', 20, { documentPath: 'archive/a' }))
    expect(outcome.status).toBe('path-mismatch')
    if (outcome.status === 'path-mismatch') {
      // The caller needs the family's ACTUAL current record to record
      // a candidate with the correct cross-context source.
      expect(outcome.current).toMatchObject({
        documentPath: 'notes/a',
        content: 'content:a:10',
      })
    }

    // The family is unchanged: primary stays at the old path, the
    // conflict candidate stays at the old path.
    expect(await store.getDraft('vault-a', 'a')).toMatchObject({
      documentPath: 'notes/a',
      content: 'content:a:10',
    })
    const conflicts = await store.listConflictDrafts('vault-a')
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({ documentPath: 'notes/a' })
  })

  it('returns path-mismatch on a first primary save when a same-identity conflict already exists at a different path', async () => {
    // Pre-existing conflict candidate with no primary record — the
    // same-identity candidates still form a family with an
    // authoritative path, so a plain first primary write at a
    // different path is refused exactly like a cross-path overwrite
    // (a "fresh write" here would create the primary at the stale
    // path while the candidates stay behind — splitting the family).
    await backend.seedRawConflict({
      version: 1,
      conflictId: 'conflict-orphan',
      vaultId: 'vault-a',
      documentId: 'a',
      documentPath: 'notes/a',
      content: 'orphan before primary',
      baseContentHash: 'hash:a',
      baseModifiedAt: 100,
      createdAt: 10,
      updatedAt: 31,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 30,
      recordedAt: 31,
    })

    const outcome = await store.saveDraft(draft('a', 20, { documentPath: 'archive/a' }))
    expect(outcome.status).toBe('path-mismatch')
    if (outcome.status === 'path-mismatch') {
      // Conflict-only family: the anchor is the newest candidate
      // (there is no primary record to re-read) — it carries the
      // family path and the cross-context source's updatedAt.
      expect(outcome.current).toMatchObject({
        conflictId: 'conflict-orphan',
        documentPath: 'notes/a',
        content: 'orphan before primary',
        updatedAt: 31,
      })
    }
    // No primary was created at the diverging path; the candidate is
    // untouched.
    expect(await store.getDraft('vault-a', 'a')).toBeNull()
    expect(await store.listConflictDrafts('vault-a')).toEqual([
      expect.objectContaining({ conflictId: 'conflict-orphan', documentPath: 'notes/a' }),
    ])
  })

  it('accepts a conflict-only family save at the candidates\' shared path', async () => {
    await backend.seedRawConflict({
      version: 1,
      conflictId: 'conflict-orphan',
      vaultId: 'vault-a',
      documentId: 'a',
      documentPath: 'notes/a',
      content: 'orphan before primary',
      baseContentHash: 'hash:a',
      baseModifiedAt: 100,
      createdAt: 10,
      updatedAt: 31,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 30,
      recordedAt: 31,
    })

    // Same path as the family: the first write unites the family
    // instead of splitting it.
    const outcome = await store.saveDraft(draft('a', 20))
    expect(outcome.status).toBe('saved')
    expect(await store.getDraft('vault-a', 'a')).toMatchObject({
      documentPath: 'notes/a',
      content: 'content:a:20',
    })
    expect(await store.listConflictDrafts('vault-a')).toEqual([
      expect.objectContaining({ conflictId: 'conflict-orphan' }),
    ])
  })

  it('blocks a primary save when conflict-only candidates disagree on the path', async () => {
    const seed = {
      version: 1,
      conflictId: 'conflict-one',
      vaultId: 'vault-a',
      documentId: 'a',
      documentPath: 'notes/a',
      content: 'orphan one',
      baseContentHash: 'hash:a',
      baseModifiedAt: 100,
      createdAt: 10,
      updatedAt: 31,
      origin: 'delete-conflict' as const,
      crossContextUpdatedAt: 30,
      recordedAt: 31,
    }
    await backend.seedRawConflict(seed)
    await backend.seedRawConflict({
      ...seed,
      conflictId: 'conflict-two',
      documentPath: 'archive/a',
      content: 'orphan two',
    })

    // Split candidate paths leave the family indeterminate — the save
    // fails closed instead of guessing which side to create the
    // primary on.
    const notesSide = await store.saveDraft(draft('a', 20))
    expect(notesSide.status).toBe('unsupported')
    const archiveSide = await store.saveDraft(draft('a', 20, { documentPath: 'archive/a' }))
    expect(archiveSide.status).toBe('unsupported')
    expect(await store.getDraft('vault-a', 'a')).toBeNull()
    expect(await store.listConflictDrafts('vault-a')).toHaveLength(2)
  })

  it('blocks a primary save when a same-identity conflict row is unsupported', async () => {
    await store.saveDraft(draft('a', 10))
    await backend.seedRawConflict({
      version: 2,
      conflictId: 'conflict-future',
      vaultId: 'vault-a',
      documentId: 'a',
      documentPath: 'notes/a',
      content: 'future row',
      baseContentHash: 'hash:a',
      baseModifiedAt: 100,
      createdAt: 10,
      updatedAt: 31,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 30,
      recordedAt: 31,
    })

    // The future-version row blocks the WHOLE primary save — a plain
    // overwrite would update the primary while the unreadable row
    // survives in the conflict store, invisible to Recovery.
    const outcome = await store.saveDraft(draft('a', 20))
    expect(outcome.status).toBe('unsupported')
    expect(await store.getDraft('vault-a', 'a')).toMatchObject({
      content: 'content:a:10',
      updatedAt: 10,
    })
  })

  it('reports the readable path of a blocking future-version primary on an unsupported save', async () => {
    const future = {
      ...draft('a', 40, { documentPath: 'archive/a' }),
      version: 2,
      content: 'future data',
    }
    await backend.seedRaw(future)

    // The save is blocked by the unreadable primary, but its
    // documentPath is still readable — the outcome carries it (with
    // the reason the family is unsupported) so the caller pins its
    // candidate ON the family instead of at its own stale snapshot
    // path.
    expect(await store.saveDraft(draft('a', 50)))
      .toEqual({
        status: 'unsupported',
        familyPath: 'archive/a',
        reason: 'unsupported-primary',
      })
  })

  it('reports the agreed path for an unsupported conflict-only family', async () => {
    await backend.seedRawConflict({
      version: 2,
      conflictId: 'conflict-future',
      vaultId: 'vault-a',
      documentId: 'a',
      documentPath: 'archive/a',
      content: 'future row',
      baseContentHash: 'hash:a',
      baseModifiedAt: 100,
      createdAt: 10,
      updatedAt: 31,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 30,
      recordedAt: 31,
    })
    await store.saveConflictDraft({
      version: 1,
      conflictId: 'conflict-valid',
      vaultId: 'vault-a',
      documentId: 'a',
      documentPath: 'archive/a',
      content: 'valid row',
      baseContentHash: 'hash:a',
      baseModifiedAt: 100,
      createdAt: 10,
      updatedAt: 32,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 30,
      recordedAt: 32,
    })

    // Both raw rows — the unreadable one included — agree on
    // archive/a: the outcome reports it (reason: an unreadable
    // conflict row, no primary involved) even though the save is
    // blocked, so the caller's candidate joins the family instead of
    // splitting it at the save's own path.
    expect(await store.saveDraft(draft('a', 20, { documentPath: 'notes/a' })))
      .toEqual({
        status: 'unsupported',
        familyPath: 'archive/a',
        reason: 'unsupported-conflict',
      })
  })

  it('reports a null family path when unsupported-family rows disagree on the path', async () => {
    await backend.seedRawConflict({
      version: 2,
      conflictId: 'conflict-future',
      vaultId: 'vault-a',
      documentId: 'a',
      documentPath: 'archive/a',
      content: 'future row',
      baseContentHash: 'hash:a',
      baseModifiedAt: 100,
      createdAt: 10,
      updatedAt: 31,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 30,
      recordedAt: 31,
    })
    await store.saveConflictDraft({
      version: 1,
      conflictId: 'conflict-valid',
      vaultId: 'vault-a',
      documentId: 'a',
      documentPath: 'legacy/a',
      content: 'valid row',
      baseContentHash: 'hash:a',
      baseModifiedAt: 100,
      createdAt: 10,
      updatedAt: 32,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 30,
      recordedAt: 32,
    })

    // The rows disagree — the family location is indeterminate, so the
    // outcome says so explicitly and the caller must fail closed (no
    // candidate at its own stale path).
    expect(await store.saveDraft(draft('a', 20)))
      .toEqual({
        status: 'unsupported',
        familyPath: null,
        reason: 'split-conflict-paths',
      })
  })

  it('reports a null family path when primary and conflict rows disagree', async () => {
    await store.saveDraft(draft('a', 10))
    await backend.seedRawConflict({
      version: 2,
      conflictId: 'conflict-future',
      vaultId: 'vault-a',
      documentId: 'a',
      documentPath: 'archive/a',
      content: 'future row',
      baseContentHash: 'hash:a',
      baseModifiedAt: 100,
      createdAt: 10,
      updatedAt: 31,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 30,
      recordedAt: 31,
    })

    // Primary at notes/a, unreadable conflict at archive/a — split.
    expect(await store.saveDraft(draft('a', 20)))
      .toEqual({
        status: 'unsupported',
        familyPath: null,
        reason: 'split-conflict-paths',
      })
  })

  it('reports split-conflict-paths even when the primary row is also unreadable', async () => {
    await backend.seedRaw({
      ...draft('a', 40, { documentPath: 'archive/a' }),
      version: 2,
      content: 'future primary',
    })
    await store.saveConflictDraft({
      version: 1,
      conflictId: 'conflict-valid',
      vaultId: 'vault-a',
      documentId: 'a',
      documentPath: 'legacy/a',
      content: 'valid row',
      baseContentHash: 'hash:a',
      baseModifiedAt: 100,
      createdAt: 10,
      updatedAt: 32,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 30,
      recordedAt: 32,
    })

    // Unreadable primary AND a readable row at a different path: the
    // split is the dominant fact — the caller must not be told
    // "unsupported-primary, here is a path" and pin a candidate the
    // readable row disagrees with.
    expect(await store.saveDraft(draft('a', 50)))
      .toEqual({
        status: 'unsupported',
        familyPath: null,
        reason: 'split-conflict-paths',
      })
  })

  it('reports unsupported-conflict when several unreadable conflict rows agree on the path', async () => {
    const seed = {
      version: 2,
      conflictId: 'conflict-future-one',
      vaultId: 'vault-a',
      documentId: 'a',
      documentPath: 'archive/a',
      content: 'future row one',
      baseContentHash: 'hash:a',
      baseModifiedAt: 100,
      createdAt: 10,
      updatedAt: 31,
      origin: 'delete-conflict' as const,
      crossContextUpdatedAt: 30,
      recordedAt: 31,
    }
    await backend.seedRawConflict(seed)
    await backend.seedRawConflict({
      ...seed,
      conflictId: 'conflict-future-two',
      content: 'future row two',
      updatedAt: 32,
      recordedAt: 32,
    })

    // Conflict-only family, every raw row unreadable but all carrying
    // the same readable path: the outcome certifies that path so the
    // caller's candidate joins the family instead of splitting it.
    expect(await store.saveDraft(draft('a', 20, { documentPath: 'notes/a' })))
      .toEqual({
        status: 'unsupported',
        familyPath: 'archive/a',
        reason: 'unsupported-conflict',
      })
  })

  it('reports the agreed path when primary and unsupported conflict rows match', async () => {
    await store.saveDraft(draft('a', 10))
    await backend.seedRawConflict({
      version: 2,
      conflictId: 'conflict-future',
      vaultId: 'vault-a',
      documentId: 'a',
      documentPath: 'notes/a',
      content: 'future row',
      baseContentHash: 'hash:a',
      baseModifiedAt: 100,
      createdAt: 10,
      updatedAt: 31,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 30,
      recordedAt: 31,
    })

    // Both raw rows agree on notes/a — the outcome reports it.
    expect(await store.saveDraft(draft('a', 20)))
      .toEqual({
        status: 'unsupported',
        familyPath: 'notes/a',
        reason: 'unsupported-conflict',
      })
  })

  it('reports a null family path for an unsupported save with no identity', async () => {
    // A malformed incoming draft carries no reliable identity — there
    // is no family to probe, and the incoming primary itself is what
    // cannot be persisted.
    expect(await store.saveDraft({
      ...draft('a', 20),
      version: 2,
    } as unknown as UnsavedDraft))
      .toEqual({
        status: 'unsupported',
        familyPath: null,
        reason: 'unsupported-primary',
      })
  })

  it('accepts a same-path primary save without touching same-identity conflicts', async () => {
    await store.saveDraft(draft('a', 10))
    await store.saveConflictDraft({
      version: 1,
      conflictId: 'conflict-a',
      vaultId: 'vault-a',
      documentId: 'a',
      documentPath: 'notes/a',
      content: 'local orphan',
      baseContentHash: 'hash:a',
      baseModifiedAt: 100,
      createdAt: 10,
      updatedAt: 31,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 30,
      recordedAt: 31,
    } as DraftConflictRecord)

    const outcome = await store.saveDraft(draft('a', 20))
    expect(outcome.status).toBe('saved')
    expect(await store.getDraft('vault-a', 'a')).toMatchObject({
      documentPath: 'notes/a',
      content: 'content:a:20',
    })
    // The conflict is on the same path the primary was already on —
    // no migration attempted.
    const conflicts = await store.listConflictDrafts('vault-a')
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({ documentPath: 'notes/a' })
  })

  it('only an explicit moveDraftFamily migrates an existing family across paths', async () => {
    await store.saveDraft(draft('a', 10))
    await store.saveConflictDraft({
      version: 1,
      conflictId: 'conflict-a',
      vaultId: 'vault-a',
      documentId: 'a',
      documentPath: 'notes/a',
      content: 'local orphan',
      baseContentHash: 'hash:a',
      baseModifiedAt: 100,
      createdAt: 10,
      updatedAt: 31,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 30,
      recordedAt: 31,
    } as DraftConflictRecord)

    // A cross-path primary save is refused.
    const crossPath = await store.saveDraft(draft('a', 20, { documentPath: 'archive/a' }))
    expect(crossPath.status).toBe('path-mismatch')

    // An explicit family move is the only way to migrate the family.
    const move = await store.moveDraftFamily('vault-a', 'a', 'archive/a')
    expect(move).toEqual({ status: 'moved', movedConflicts: 1 })
    expect(await store.getDraft('vault-a', 'a')).toMatchObject({ documentPath: 'archive/a' })
    const conflicts = await store.listConflictDrafts('vault-a')
    expect(conflicts[0]).toMatchObject({ documentPath: 'archive/a' })
  })

  function candidate(
    conflictId: string,
    documentPath: string,
    content = 'local edit',
  ): DraftConflictRecord {
    return {
      version: 1,
      conflictId,
      vaultId: 'vault-a',
      documentId: 'a',
      documentPath,
      content,
      baseContentHash: 'hash:a',
      baseModifiedAt: 100,
      createdAt: 10,
      updatedAt: 31,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 30,
      recordedAt: 31,
    }
  }

  it('saves a conflict candidate inside the family transaction when the path agrees', async () => {
    await store.saveDraft(draft('a', 30, { documentPath: 'notes/a' }))

    const outcome = await store.saveConflictCandidate(candidate('cand-1', 'notes/a'))

    expect(outcome.status).toBe('saved')
    if (outcome.status === 'saved') {
      expect(outcome.stored).toMatchObject({
        conflictId: 'cand-1',
        documentPath: 'notes/a',
      })
    }
    const conflicts = await store.listConflictDrafts('vault-a')
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({ conflictId: 'cand-1', documentPath: 'notes/a' })
  })

  it('refuses a conflict candidate at a stale path and reports the family path', async () => {
    await store.saveDraft(draft('a', 30, { documentPath: 'notes/a' }))
    await store.saveConflictDraft(candidate('cand-1', 'notes/a', 'older local'))
    // Another context moves the whole family to archive/a.
    expect(await store.moveDraftFamily('vault-a', 'a', 'archive/a'))
      .toEqual({ status: 'moved', movedConflicts: 1 })

    // A candidate still pinned at the pre-move path must NOT be
    // written there — the outcome reports where the family lives now
    // so the caller re-pins instead of stranding the candidate.
    const outcome = await store.saveConflictCandidate(candidate('cand-2', 'notes/a'))
    expect(outcome).toEqual({ status: 'path-mismatch', familyPath: 'archive/a' })

    // Nothing was added at the stale path: the family stays whole at
    // archive/a with exactly its original candidate.
    const conflicts = await store.listConflictDrafts('vault-a')
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({ conflictId: 'cand-1', documentPath: 'archive/a' })
  })

  it('agrees a conflict-only family path when validating a candidate', async () => {
    await store.saveConflictDraft(candidate('cand-1', 'archive/a', 'older local'))

    const agreed = await store.saveConflictCandidate(candidate('cand-2', 'archive/a'))
    expect(agreed.status).toBe('saved')

    const diverging = await store.saveConflictCandidate(candidate('cand-3', 'notes/a'))
    expect(diverging).toEqual({ status: 'path-mismatch', familyPath: 'archive/a' })

    const conflicts = await store.listConflictDrafts('vault-a')
    expect(conflicts).toHaveLength(2)
    expect(conflicts.every((record) => record.documentPath === 'archive/a')).toBe(true)
  })

  it('refuses a conflict candidate for a split family without writing either side', async () => {
    // Same identity, two raw rows disagreeing on the path — one
    // unreadable at archive/a, one valid at legacy/a.
    await backend.seedRawConflict({
      ...candidate('bad-row', 'archive/a', 'unreadable'),
      version: 2,
    })
    await store.saveConflictDraft(candidate('valid-row', 'legacy/a', 'older local'))

    const outcome = await store.saveConflictCandidate(candidate('cand-x', 'legacy/a'))
    expect(outcome).toEqual({
      status: 'unsupported',
      familyPath: null,
      reason: 'split-conflict-paths',
    })

    // No candidate written on either side — the caller fails closed.
    const conflicts = await store.listConflictDrafts('vault-a')
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({ conflictId: 'valid-row', documentPath: 'legacy/a' })
  })

  it('allows a first conflict candidate to establish an empty family', async () => {
    const outcome = await store.saveConflictCandidate(candidate('cand-1', 'notes/a'))
    expect(outcome.status).toBe('saved')
    const conflicts = await store.listConflictDrafts('vault-a')
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({ conflictId: 'cand-1', documentPath: 'notes/a' })
  })

  it('reports failed when the candidate family transaction aborts', async () => {
    await store.saveDraft(draft('a', 30, { documentPath: 'notes/a' }))
    backend.failNext('saveConflictCandidate')
    const outcome = await store.saveConflictCandidate(candidate('cand-1', 'notes/a'))
    expect(outcome).toEqual({ status: 'failed' })
    expect(await store.listConflictDrafts('vault-a')).toHaveLength(0)
  })

  it('rejects a malformed conflict candidate as unsupported-conflict', async () => {
    const outcome = await store.saveConflictCandidate({
      version: 1,
      conflictId: '',
      vaultId: 'vault-a',
      documentId: 'a',
      documentPath: 'notes/a',
      content: 'x',
    } as unknown as DraftConflictRecord)
    expect(outcome).toEqual({
      status: 'unsupported',
      familyPath: null,
      reason: 'unsupported-conflict',
    })
  })

  // CAS family move (this round's blocker): quarantine retries must
  // carry the certified expected family path. The store derives the
  // family's CURRENT path from its raw rows (primary + same-identity
  // conflicts) inside one transaction and moves ONLY while it still
  // matches — a stale retry from an old context must never drag the
  // family back from the path another context's verified rename put
  // it on (the server filesystem result is always authoritative).

  it('moves the family when it still sits at the expected path', async () => {
    await store.saveDraft(draft('a', 20))
    await store.saveConflictDraft(candidate('cand-1', 'notes/a', 'local orphan'))

    const outcome = await store.moveDraftFamilyIfAtPath(
      'vault-a', 'a', 'notes/a', 'archive/a',
    )
    expect(outcome).toEqual({ status: 'moved' })
    expect(await store.getDraft('vault-a', 'a')).toMatchObject({
      documentPath: 'archive/a',
      content: 'content:a:20',
    })
    const conflicts = await store.listConflictDrafts('vault-a')
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({
      conflictId: 'cand-1',
      documentPath: 'archive/a',
    })
  })

  it('moves a conflict-only family at the expected path and reports the missing primary', async () => {
    await store.saveConflictDraft(candidate('cand-1', 'notes/a', 'local orphan'))

    const outcome = await store.moveDraftFamilyIfAtPath(
      'vault-a', 'a', 'notes/a', 'archive/a',
    )
    expect(outcome).toEqual({ status: 'missing' })
    const conflicts = await store.listConflictDrafts('vault-a')
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({
      conflictId: 'cand-1',
      documentPath: 'archive/a',
    })
  })

  it('reports a missing family for an empty identity without touching the stores', async () => {
    const outcome = await store.moveDraftFamilyIfAtPath(
      'vault-a', 'a', 'notes/a', 'archive/a',
    )
    expect(outcome).toEqual({ status: 'missing' })
    expect(await store.getDraft('vault-a', 'a')).toBeNull()
    expect(await store.listConflictDrafts('vault-a')).toEqual([])
  })

  it('refuses to drag a family back from another context\'s newer path', async () => {
    // Context B's verified rename already moved the whole family to
    // final/a. A stale quarantine still believes the family sits at
    // notes/a and wants it at its old server target archive/a.
    await store.saveDraft(draft('a', 20, { documentPath: 'final/a' }))
    await store.saveConflictDraft(candidate('cand-1', 'final/a', 'local orphan'))

    const outcome = await store.moveDraftFamilyIfAtPath(
      'vault-a', 'a', 'notes/a', 'archive/a',
    )
    // path-mismatch certifies where the family lives now — and moves
    // NOTHING toward the stale target.
    expect(outcome).toEqual({ status: 'path-mismatch', currentPath: 'final/a' })
    expect(await store.getDraft('vault-a', 'a')).toMatchObject({
      documentPath: 'final/a',
      content: 'content:a:20',
    })
    const conflicts = await store.listConflictDrafts('vault-a')
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({
      conflictId: 'cand-1',
      documentPath: 'final/a',
    })
  })

  it('reports path-mismatch for a conflict-only family at a different path', async () => {
    await store.saveConflictDraft(candidate('cand-1', 'final/a', 'local orphan'))

    const outcome = await store.moveDraftFamilyIfAtPath(
      'vault-a', 'a', 'notes/a', 'archive/a',
    )
    expect(outcome).toEqual({ status: 'path-mismatch', currentPath: 'final/a' })
    const conflicts = await store.listConflictDrafts('vault-a')
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({
      conflictId: 'cand-1',
      documentPath: 'final/a',
    })
  })

  it('fails a CAS move closed on a split family without moving either side', async () => {
    await store.saveConflictDraft(candidate('cand-a', 'notes/a', 'side a'))
    await store.saveConflictDraft(candidate('cand-b', 'legacy/a', 'side b'))

    const outcome = await store.moveDraftFamilyIfAtPath(
      'vault-a', 'a', 'notes/a', 'archive/a',
    )
    expect(outcome).toEqual({ status: 'unsupported' })
    const conflicts = await store.listConflictDrafts('vault-a')
    expect(conflicts).toHaveLength(2)
    expect(conflicts.find((c) => c.conflictId === 'cand-a'))
      .toMatchObject({ documentPath: 'notes/a' })
    expect(conflicts.find((c) => c.conflictId === 'cand-b'))
      .toMatchObject({ documentPath: 'legacy/a' })
  })

  it('fails a CAS move closed on an unreadable conflict row', async () => {
    await store.saveDraft(draft('a', 20))
    await store.saveConflictDraft(candidate('cand-1', 'notes/a', 'local orphan'))
    await backend.seedRawConflict({
      ...candidate('cand-future', 'notes/a', 'future data'),
      version: 2,
    })

    const outcome = await store.moveDraftFamilyIfAtPath(
      'vault-a', 'a', 'notes/a', 'archive/a',
    )
    expect(outcome).toEqual({ status: 'unsupported' })
    expect(await store.getDraft('vault-a', 'a')).toMatchObject({
      documentPath: 'notes/a',
    })
    expect(await store.listConflictDrafts('vault-a')).toEqual([
      expect.objectContaining({ conflictId: 'cand-1', documentPath: 'notes/a' }),
    ])
    expect(await backend.listConflicts('vault-a')).toHaveLength(2)
  })

  it('fails a CAS move closed on an unreadable primary', async () => {
    await backend.seedRaw({ ...draft('a', 40), version: 2, content: 'future data' })
    await store.saveConflictDraft(candidate('cand-1', 'notes/a', 'local orphan'))

    const outcome = await store.moveDraftFamilyIfAtPath(
      'vault-a', 'a', 'notes/a', 'archive/a',
    )
    expect(outcome).toEqual({ status: 'unsupported' })
    expect(await backend.get(['vault-a', 'a'])).toMatchObject({ version: 2 })
    expect(await store.listConflictDrafts('vault-a')).toEqual([
      expect.objectContaining({ conflictId: 'cand-1', documentPath: 'notes/a' }),
    ])
  })

  it('reports a failed CAS move when the transaction aborts', async () => {
    await store.saveDraft(draft('a', 20))
    backend.failNext('moveFamilyIfAtPath')

    const outcome = await store.moveDraftFamilyIfAtPath(
      'vault-a', 'a', 'notes/a', 'archive/a',
    )
    expect(outcome).toEqual({ status: 'failed' })
    expect(await store.getDraft('vault-a', 'a')).toMatchObject({
      documentPath: 'notes/a',
    })
  })

  it('rejects a CAS move with blank paths as failed', async () => {
    await store.saveDraft(draft('a', 20))
    await expect(store.moveDraftFamilyIfAtPath('vault-a', 'a', '', 'archive/a'))
      .resolves.toEqual({ status: 'failed' })
    await expect(store.moveDraftFamilyIfAtPath('vault-a', 'a', 'notes/a', ' '))
      .resolves.toEqual({ status: 'failed' })
    expect(await store.getDraft('vault-a', 'a')).toMatchObject({
      documentPath: 'notes/a',
    })
  })

  // Store-level family probe: a move-indeterminate retry must
  // re-verify the family's CURRENT state before acting — never
  // blind-move "whatever is there" toward a stale serverPath. The
  // probe is a strict read: it certifies the agreed family path (or
  // reports none / unsupported / failed) and writes nothing.

  it('probes the agreed family path without writing anything', async () => {
    await store.saveDraft(draft('a', 20))
    await store.saveConflictDraft(candidate('cand-1', 'notes/a', 'local orphan'))

    expect(await store.probeDraftFamily('vault-a', 'a')).toEqual({
      status: 'path',
      familyPath: 'notes/a',
      hasPrimary: true,
    })
    // Read-only: the family is unchanged.
    expect(await store.getDraft('vault-a', 'a')).toMatchObject({
      documentPath: 'notes/a',
      content: 'content:a:20',
    })
    expect(await store.listConflictDrafts('vault-a')).toHaveLength(1)
  })

  it('probes a conflict-only family path and reports the absent primary', async () => {
    await store.saveConflictDraft(candidate('cand-1', 'legacy/a', 'local orphan'))

    expect(await store.probeDraftFamily('vault-a', 'a')).toEqual({
      status: 'path',
      familyPath: 'legacy/a',
      hasPrimary: false,
    })
  })

  it('probes none for an empty identity', async () => {
    expect(await store.probeDraftFamily('vault-a', 'a')).toEqual({ status: 'none' })
  })

  it('probes unsupported when the family paths are split', async () => {
    await store.saveConflictDraft(candidate('cand-a', 'notes/a', 'side a'))
    await store.saveConflictDraft(candidate('cand-b', 'legacy/a', 'side b'))

    expect(await store.probeDraftFamily('vault-a', 'a')).toEqual({
      status: 'unsupported',
      reason: 'split-conflict-paths',
    })
  })

  it('probes unsupported when a same-identity row is unreadable', async () => {
    await store.saveDraft(draft('a', 20))
    await backend.seedRawConflict({
      ...candidate('cand-future', 'notes/a', 'future data'),
      version: 2,
    })

    expect(await store.probeDraftFamily('vault-a', 'a')).toEqual({
      status: 'unsupported',
      reason: 'unsupported-conflict',
    })
  })

  it('probes failed when the store read aborts', async () => {
    backend.failNext('get')
    expect(await store.probeDraftFamily('vault-a', 'a'))
      .toEqual({ status: 'failed' })
  })
})

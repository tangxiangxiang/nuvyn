import { computed, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { createDraftStore, createMemoryDraftBackend } from '../draftStore'
import type { DraftConflictRecord, UnsavedDraft } from '../draftTypes'
import { createUnsavedDraftRecovery } from '../useUnsavedDraftRecovery'
import { createDraftRecoveryManagement } from '../useDraftRecoveryManagement'
import { recoveryRecordId } from '../draftCleanup'
import { createDraftRecoveryOperationProtection } from '../useDraftRecoveryOperationProtection'

function draft(id: string, updatedAt = 1): UnsavedDraft {
  return {
    version: 1, vaultId: 'vault', documentId: id, documentPath: `notes/${id}`,
    content: id, baseContentHash: null, baseModifiedAt: null,
    createdAt: updatedAt, updatedAt,
  }
}

function conflictRecord(
  id: string, conflictId: string, updatedAt: number, content = id,
): DraftConflictRecord {
  return {
    version: 1, vaultId: 'vault', documentId: id, documentPath: `notes/${id}`,
    conflictId, content, baseContentHash: null, baseModifiedAt: null,
    createdAt: updatedAt, updatedAt, origin: 'delete-conflict',
    crossContextUpdatedAt: null, recordedAt: updatedAt,
  }
}

function post(id: string, raw: string, mtime = 1) {
  return {
    path: `notes/${id}`, raw, content: raw, frontmatter: {},
    metadata: {
      id, path: `notes/${id}`, title: id, summary: '', tags: [],
      mood: null,
      createdAt: 1, updatedAt: 1,
    },
    size: 1, mtime,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}

async function setup() {
  const backend = createMemoryDraftBackend()
  const store = createDraftStore({ backend })
  const recovery = createUnsavedDraftRecovery({
    store,
    loadPost: async () => { throw Object.assign(new Error('missing'), { status: 404 }) },
  })
  const protectedIdentities = new Set<string>()
  const openIds = ref<readonly string[]>([])
  const removed: string[][] = []
  const management = createDraftRecoveryManagement({
    store,
    recovery,
    openRecoveryIds: openIds,
    getPersistenceProtection: () => ({ identityIds: protectedIdentities }),
    onRecordsRemoved: (ids) => removed.push([...ids]),
    now: () => 31 * 24 * 60 * 60 * 1000,
  })
  return { store, backend, recovery, management, protectedIdentities, openIds, removed }
}

describe('draft recovery management', () => {
  it('refreshes real inventory and deletes one exact record', async () => {
    const h = await setup()
    await h.store.saveDraft(draft('a'))
    await h.recovery.discover('vault')
    expect(await h.management.refresh('vault')).toBe(true)
    const record = h.management.records.value[0]!
    expect(h.management.capacity.value.recordCount).toBe(1)
    expect((await h.management.deleteRecord(record)).status).toBe('deleted')
    expect(h.management.records.value).toEqual([])
    expect(h.removed).toEqual([[recoveryRecordId(record)]])
  })

  it('protects dirty identities and open recovery tabs', async () => {
    const h = await setup()
    await h.store.saveDraft(draft('a'))
    await h.recovery.discover('vault')
    await h.management.refresh('vault')
    const record = h.management.records.value[0]!
    h.protectedIdentities.add(JSON.stringify(['vault', 'a']))
    expect((await h.management.deleteRecord(record)).status).toBe('protected')
    h.protectedIdentities.clear()
    h.openIds.value = [recoveryRecordId(record)]
    expect((await h.management.deleteRecord(record)).status).toBe('protected')
    expect(await h.store.getDraft('vault', 'a')).not.toBeNull()
  })

  it('keeps cleanup blocked between two concurrent operations for one recovery ID', async () => {
    const store = createDraftStore({ backend: createMemoryDraftBackend() })
    await store.saveDraft(draft('a'))
    const recovery = createUnsavedDraftRecovery({
      store,
      loadPost: async () => { throw Object.assign(new Error('missing'), { status: 404 }) },
    })
    const operations = createDraftRecoveryOperationProtection()
    const management = createDraftRecoveryManagement({
      store,
      recovery,
      openRecoveryIds: computed(() => [...operations.protectedIds.value]),
      getPersistenceProtection: () => ({ identityIds: new Set() }),
      now: () => 31 * 24 * 60 * 60 * 1000,
    })
    await recovery.discover('vault')
    await management.refresh('vault')
    const id = recoveryRecordId(management.records.value[0]!)
    const first = deferred<void>()
    const second = deferred<void>()
    const a = operations.run([id], () => first.promise)
    const b = operations.run([id], () => second.promise)
    first.resolve()
    await a

    const protectedCleanup = await management.cleanupNow()
    expect(protectedCleanup.skippedProtected).toHaveLength(1)
    expect(await store.getDraft('vault', 'a')).not.toBeNull()

    second.resolve()
    await b
    expect((await management.cleanupNow()).deleted).toHaveLength(1)
  })

  it('coalesces cleanup and re-reads real store state', async () => {
    const h = await setup()
    await h.store.saveDraft(draft('a'))
    await h.recovery.discover('vault')
    await h.management.refresh('vault')
    const first = h.management.cleanupNow()
    const second = h.management.cleanupNow()
    expect(second).toBe(first)
    const report = await first
    expect(report.deleted).toHaveLength(1)
    expect(report.after.recordCount).toBe(0)
  })

  it('waits for reclassification and never retains an old orphan decision', async () => {
    const store = createDraftStore({ backend: createMemoryDraftBackend() })
    await store.saveDraft(draft('a'))
    const disk = deferred<ReturnType<typeof draft>>()
    const loadPost = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('gone'), { status: 404 }))
      .mockImplementationOnce(() => disk.promise.then((value) => ({
        path: value.documentPath,
        raw: value.content,
        content: value.content,
        frontmatter: {},
        metadata: {
          id: value.documentId, path: value.documentPath, title: 'a', summary: '', tags: [],
          mood: null,
          createdAt: 1, updatedAt: 1,
        },
        size: 1,
        mtime: 1,
      })))
    const recovery = createUnsavedDraftRecovery({ store, loadPost })
    const management = createDraftRecoveryManagement({
      store,
      recovery,
      getPersistenceProtection: () => ({ identityIds: new Set() }),
      now: () => 31 * 24 * 60 * 60 * 1000,
    })
    await recovery.discover('vault')
    await management.refresh('vault')
    const refreshing = recovery.refreshIdentity('vault', 'a')
    await vi.waitFor(() => expect(recovery.items.value[0]?.status).toBe('loading'))

    let cleanupSettled = false
    const cleanup = management.cleanupNow().finally(() => { cleanupSettled = true })
    await Promise.resolve()
    expect(cleanupSettled).toBe(false)
    expect(await store.getDraft('vault', 'a')).not.toBeNull()

    disk.resolve({ ...draft('a'), content: 'a' })
    await refreshing
    const report = await cleanup
    expect(report.deleted).toHaveLength(1)
    expect(await store.getDraft('vault', 'a')).toBeNull()
  })

  it('defers cleanup until startup discovery classifies newly found records', async () => {
    const store = createDraftStore({ backend: createMemoryDraftBackend() })
    await store.saveDraft(draft('a'))
    const disk = deferred<{
      path: string
      raw: string
      content: string
      frontmatter: Record<string, never>
      metadata: {
        id: string; path: string; title: string; summary: string; tags: string[]
        mood: string | null
        createdAt: number; updatedAt: number
      }
      size: number
      mtime: number
    }>()
    const recovery = createUnsavedDraftRecovery({ store, loadPost: () => disk.promise })
    const management = createDraftRecoveryManagement({
      store,
      recovery,
      getPersistenceProtection: () => ({ identityIds: new Set() }),
      now: () => 31 * 24 * 60 * 60 * 1000,
    })
    await management.refresh('vault')
    const discovering = recovery.discover('vault')
    await vi.waitFor(() => expect(recovery.discoveringVaultId.value).toBe('vault'))
    const cleanup = management.cleanupNow()
    let settled = false
    void cleanup.finally(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(await store.getDraft('vault', 'a')).not.toBeNull()

    disk.resolve({
      path: 'notes/a', raw: 'disk', content: 'disk', frontmatter: {},
      metadata: {
        id: 'a', path: 'notes/a', title: 'a', summary: '', tags: [],
        mood: null,
        createdAt: 1, updatedAt: 1,
      },
      size: 1, mtime: 1,
    })
    await discovering
    const report = await cleanup
    expect(report.deleted).toEqual([])
    expect(report.status).toBe('completed')
  })

  it('keeps a record another context replaced after safe-redundant classification', async () => {
    const store = createDraftStore({ backend: createMemoryDraftBackend() })
    await store.saveDraft(draft('a'))
    const recovery = createUnsavedDraftRecovery({
      store,
      loadPost: async () => post('a', 'a'),
    })
    const management = createDraftRecoveryManagement({
      store,
      recovery,
      getPersistenceProtection: () => ({ identityIds: new Set() }),
      now: () => 31 * 24 * 60 * 60 * 1000,
    })
    await recovery.discover('vault')
    // R1 is byte-identical to disk under the same stable identity, so
    // cleanup classifies it as safe-redundant.
    expect(recovery.items.value[0]?.status).toBe('ready')

    // Another context replaces the family's record under the SAME
    // recoveryId (newer updatedAt, new body) after classification.
    const replaced = await store.saveDraft({
      ...draft('a', 2), content: 'new unsaved content',
    })
    expect(replaced.status).toBe('saved')

    const report = await management.cleanupNow()

    // The certified verdict belonged to R1: the record the cleanup scan
    // actually inspected was never the one classification certified, so
    // it must stay until a fresh classification certifies it.
    expect(report.status).toBe('completed')
    expect(report.deleted).toEqual([])
    expect((await store.getDraft('vault', 'a'))?.content).toBe('new unsaved content')
  })

  it('keeps a replaced record under a stale missing-source decision', async () => {
    const store = createDraftStore({ backend: createMemoryDraftBackend() })
    await store.saveDraft(draft('a'))
    const recovery = createUnsavedDraftRecovery({
      store,
      loadPost: async () => { throw Object.assign(new Error('gone'), { status: 404 }) },
    })
    const management = createDraftRecoveryManagement({
      store,
      recovery,
      getPersistenceProtection: () => ({ identityIds: new Set() }),
      now: () => 31 * 24 * 60 * 60 * 1000,
    })
    await recovery.discover('vault')
    expect(recovery.items.value[0]?.decision?.kind).toBe('missing-source')

    // Another context writes a new record under the same identity: the
    // source exists again and the certified record is gone. The
    // replacement is old enough to expire on its own merits, so ONLY
    // the record binding protects it here.
    await store.saveDraft(draft('a', 2))

    const report = await management.cleanupNow()

    expect(report.deleted).toEqual([])
    expect(await store.getDraft('vault', 'a')).not.toBeNull()
  })

  it('keeps a conflict candidate another context replaced after classification', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    await backend.seedRawConflict(conflictRecord('doc', 'c-1', 1, 'candidate body'))
    const recovery = createUnsavedDraftRecovery({
      store,
      loadPost: async () => post('doc', 'candidate body'),
    })
    const management = createDraftRecoveryManagement({
      store,
      recovery,
      getPersistenceProtection: () => ({ identityIds: new Set() }),
      now: () => 31 * 24 * 60 * 60 * 1000,
    })
    await recovery.discover('vault')
    expect(recovery.items.value[0]?.source).toBe('conflict')
    expect(recovery.items.value[0]?.status).toBe('ready')

    // Another context replaces the candidate row under the SAME
    // conflictId (new body, new timestamps) after classification.
    await backend.seedRawConflict(conflictRecord('doc', 'c-1', 2, 'fresh candidate'))

    const report = await management.cleanupNow()

    expect(report.deleted).toEqual([])
    const survivors = await store.listConflictDrafts('vault')
    expect(survivors).toHaveLength(1)
    expect(survivors[0]?.content).toBe('fresh candidate')
  })

  it('does not treat an identity-mismatch record as safe-redundant even with identical bodies', async () => {
    const DAY = 24 * 60 * 60 * 1000
    const now = 31 * DAY
    const store = createDraftStore({ backend: createMemoryDraftBackend() })
    // Young enough that orphan expiry cannot be the reason it survives.
    await store.saveDraft(draft('a', now - DAY))
    const recovery = createUnsavedDraftRecovery({
      store,
      // Same path, byte-identical body — but another document's identity
      // now occupies it.
      loadPost: async () => post('another-doc', 'a'),
    })
    const management = createDraftRecoveryManagement({
      store,
      recovery,
      getPersistenceProtection: () => ({ identityIds: new Set() }),
      now: () => now,
    })
    await recovery.discover('vault')
    expect(recovery.items.value[0]?.decision?.kind).toBe('identity-mismatch')

    const report = await management.cleanupNow()

    expect(report.deleted).toEqual([])
    expect(await store.getDraft('vault', 'a')).not.toBeNull()
  })

  it('reports protection that appears after cleanup planning', async () => {
    const store = createDraftStore({ backend: createMemoryDraftBackend() })
    await store.saveDraft(draft('a'))
    const recovery = createUnsavedDraftRecovery({
      store,
      loadPost: async () => { throw Object.assign(new Error('gone'), { status: 404 }) },
    })
    let protectionReads = 0
    const management = createDraftRecoveryManagement({
      store,
      recovery,
      getPersistenceProtection: () => ({
        identityIds: ++protectionReads === 1
          ? new Set()
          : new Set([JSON.stringify(['vault', 'a'])]),
      }),
      now: () => 31 * 24 * 60 * 60 * 1000,
    })
    await recovery.discover('vault')
    await management.refresh('vault')

    const report = await management.cleanupNow()

    expect(report.deleted).toEqual([])
    expect(report.skippedProtected).toHaveLength(1)
    expect(await store.getDraft('vault', 'a')).not.toBeNull()
  })

  it('plans from a fresh Store scan instead of cached Center records', async () => {
    const h = await setup()
    const recent = 31 * 24 * 60 * 60 * 1000 - 1_000
    for (let index = 0; index < 99; index += 1) {
      await h.store.saveDraft(draft(`old-${index}`, recent + index))
    }
    await h.recovery.discover('vault')
    await h.management.refresh('vault')
    for (let index = 0; index < 10; index += 1) {
      await h.store.saveDraft(draft(`cross-${index}`, recent + 100 + index))
    }

    const report = await h.management.cleanupNow()

    expect(report.before.recordCount).toBe(109)
    expect(report.after.recordCount).toBe(109)
    expect(report.deleted).toHaveLength(0)
    expect(report.stillOverCapacity).toBe(true)
  })

  it('runs one trailing cleanup pass when requested during an active pass', async () => {
    const baseStore = createDraftStore({ backend: createMemoryDraftBackend() })
    for (let index = 0; index < 101; index += 1) {
      await baseStore.saveDraft(draft(`doc-${index}`, 1_000 + index))
    }
    const recovery = createUnsavedDraftRecovery({
      store: baseStore,
      loadPost: async () => { throw Object.assign(new Error('missing'), { status: 404 }) },
    })
    const gate = deferred<void>()
    let blockInspection = false
    const store = {
      ...baseStore,
      async inspectVaultRecovery(vaultId: string) {
        if (blockInspection) {
          blockInspection = false
          await gate.promise
        }
        return baseStore.inspectVaultRecovery(vaultId)
      },
    }
    const management = createDraftRecoveryManagement({
      store,
      recovery,
      getPersistenceProtection: () => ({ identityIds: new Set() }),
      now: () => 0,
    })
    await recovery.discover('vault')
    await management.refresh('vault')
    blockInspection = true
    const first = management.cleanupNow()
    await vi.waitFor(() => expect(blockInspection).toBe(false))
    await baseStore.saveDraft(draft('arrived-during-cleanup', 10_000))
    const second = management.cleanupNow()
    expect(second).toBe(first)
    gate.resolve()

    const report = await first
    expect(report.deleted).toHaveLength(0)
    expect(report.after.recordCount).toBe(102)
    expect(report.stillOverCapacity).toBe(true)
  })

  it('sorts the Center inventory newest first', async () => {
    const h = await setup()
    await h.store.saveDraft(draft('old', 1))
    await h.store.saveDraft(draft('new', 2))
    await h.management.refresh('vault')
    expect(h.management.records.value.map((record) => record.record.documentId))
      .toEqual(['new', 'old'])
  })

  it('fails closed when the cleanup before-scan cannot read inventory', async () => {
    const baseStore = createDraftStore({ backend: createMemoryDraftBackend() })
    await baseStore.saveDraft(draft('a'))
    const recovery = createUnsavedDraftRecovery({ store: baseStore })
    let failInspection = false
    const management = createDraftRecoveryManagement({
      store: {
        ...baseStore,
        inspectVaultRecovery: async (vaultId: string) => failInspection
          ? { status: 'failed', reason: 'transaction-failed' } as const
          : baseStore.inspectVaultRecovery(vaultId),
      },
      recovery,
      getPersistenceProtection: () => ({ identityIds: new Set() }),
    })
    await management.refresh('vault')
    failInspection = true

    const report = await management.cleanupNow()

    expect(report.status).toBe('before-scan-failed')
    expect(report.deleted).toEqual([])
    expect(report.stillOverCapacity).toBe(true)
    expect(await baseStore.getDraft('vault', 'a')).not.toBeNull()
  })

  it('reports an unverified after-scan without hiding completed deletes', async () => {
    const baseStore = createDraftStore({ backend: createMemoryDraftBackend() })
    await baseStore.saveDraft(draft('a'))
    const recovery = createUnsavedDraftRecovery({
      store: baseStore,
      loadPost: async () => { throw Object.assign(new Error('missing'), { status: 404 }) },
    })
    let inspections = 0
    const management = createDraftRecoveryManagement({
      store: {
        ...baseStore,
        inspectVaultRecovery: async (vaultId: string) => {
          inspections += 1
          return inspections === 3
            ? { status: 'failed', reason: 'transaction-failed' } as const
            : baseStore.inspectVaultRecovery(vaultId)
        },
      },
      recovery,
      getPersistenceProtection: () => ({ identityIds: new Set() }),
      now: () => 31 * 24 * 60 * 60 * 1000,
    })
    await recovery.discover('vault')
    await management.refresh('vault')

    const report = await management.cleanupNow()

    expect(report.status).toBe('after-scan-failed')
    expect(report.deleted).toHaveLength(1)
    expect(report.stillOverCapacity).toBe(true)
    expect(await baseStore.getDraft('vault', 'a')).toBeNull()
  })

  it('keeps untouched recovery items when the after-scan fails', async () => {
    const baseStore = createDraftStore({ backend: createMemoryDraftBackend() })
    await baseStore.saveDraft(draft('delete-me'))
    await baseStore.saveDraft(draft('keep-me'))
    const recovery = createUnsavedDraftRecovery({
      store: baseStore,
      loadPost: async () => { throw Object.assign(new Error('missing'), { status: 404 }) },
    })
    let inspections = 0
    const openIds = ref<readonly string[]>([])
    const management = createDraftRecoveryManagement({
      store: {
        ...baseStore,
        inspectVaultRecovery: async (vaultId: string) => {
          inspections += 1
          return inspections === 3
            ? { status: 'failed', reason: 'transaction-failed' } as const
            : baseStore.inspectVaultRecovery(vaultId)
        },
      },
      recovery,
      openRecoveryIds: openIds,
      getPersistenceProtection: () => ({ identityIds: new Set() }),
      now: () => 31 * 24 * 60 * 60 * 1000,
    })
    await recovery.discover('vault')
    await management.refresh('vault')
    const kept = management.records.value.find((record) => record.record.documentId === 'keep-me')!
    openIds.value = [recoveryRecordId(kept)]

    const report = await management.cleanupNow()

    expect(report.status).toBe('after-scan-failed')
    expect(recovery.items.value.map((item) => item.draft.documentId)).toEqual(['keep-me'])
    expect(await baseStore.getDraft('vault', 'keep-me')).not.toBeNull()
  })

  it('surfaces the storage failure reason and clears it on a recovered read', async () => {
    const h = await setup()
    await h.store.saveDraft(draft('a'))
    h.backend.failNext('inspect')

    // A failed read must classify itself instead of leaving a silent
    // empty Center: the error carries the storage reason.
    expect(await h.management.refresh('vault')).toBe(false)
    expect(h.management.error.value).toBe('transaction-failed')
    expect(h.management.records.value).toEqual([])

    // The very next successful read must clear the failure explicitly —
    // a retry that recovers leaves the Center in a clean state showing
    // the real inventory (or the empty state, never the error).
    expect(await h.management.refresh('vault')).toBe(true)
    expect(h.management.error.value).toBeNull()
    expect(h.management.records.value.map((record) => record.record.documentId)).toEqual(['a'])
  })

  it('ignores stale refresh results after dispose', async () => {
    const h = await setup()
    h.management.dispose()
    expect(await h.management.refresh('vault')).toBe(false)
    expect(h.management.records.value).toEqual([])
  })
})

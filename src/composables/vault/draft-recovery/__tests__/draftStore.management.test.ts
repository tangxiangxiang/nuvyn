import { describe, expect, it } from 'vitest'
import { createDraftStore, createIndexedDbDraftBackend, createMemoryDraftBackend } from '../draftStore'
import type { DraftConflictRecord, UnsavedDraft } from '../draftTypes'

function primary(content = 'primary'): UnsavedDraft {
  return {
    version: 1, vaultId: 'vault', documentId: 'doc', documentPath: 'notes/doc',
    content, baseContentHash: null, baseModifiedAt: null,
    createdAt: 1, updatedAt: content === 'primary' ? 1 : 2,
  }
}

function conflict(content = 'conflict'): DraftConflictRecord {
  return {
    ...primary(content), conflictId: 'candidate', origin: 'delete-conflict',
    crossContextUpdatedAt: 1, recordedAt: 2,
  }
}

describe('draft recovery management store', () => {
  it('inspects both stores and counts unsupported rows without exposing them', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    await store.saveDraft(primary())
    await store.saveConflictDraft(conflict())
    await backend.seedRaw({ ...primary('future'), documentId: 'future', version: 2 })
    await backend.seedRawConflict({ ...conflict('corrupt'), conflictId: 'bad', version: 2 })

    expect(await store.inspectVaultRecovery('vault')).toEqual({
      status: 'ok',
      inventory: {
        primary: [primary()],
        conflicts: [conflict()],
        unsupportedPrimaryCount: 1,
        unsupportedConflictCount: 1,
      },
    })
  })

  it('conditionally deletes an unchanged conflict and treats missing idempotently', async () => {
    const store = createDraftStore({ backend: createMemoryDraftBackend() })
    const expected = conflict()
    await store.saveConflictDraft(expected)
    expect(await store.deleteConflictDraftIfUnchanged(expected)).toEqual({ status: 'deleted' })
    expect(await store.deleteConflictDraftIfUnchanged(expected)).toEqual({ status: 'missing' })
  })

  it('keeps a changed conflict and unsupported row', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    const expected = conflict()
    await store.saveConflictDraft(expected)
    const changed = { ...expected, content: 'newer', updatedAt: 3, recordedAt: 3 }
    await backend.seedRawConflict(changed)
    expect(await store.deleteConflictDraftIfUnchanged(expected)).toEqual({ status: 'stale' })
    await backend.seedRawConflict({ ...changed, version: 2 })
    expect(await store.deleteConflictDraftIfUnchanged(changed)).toEqual({ status: 'unsupported' })
  })

  it('reports inspect and conditional-delete failures', async () => {
    const backend = createMemoryDraftBackend()
    const store = createDraftStore({ backend })
    await store.saveConflictDraft(conflict())
    backend.failNext('inspect')
    // A transaction abort inside inspect maps to the generic failure
    // reason — the Store must classify, not re-throw.
    expect(await store.inspectVaultRecovery('vault'))
      .toEqual({ status: 'failed', reason: 'transaction-failed' })
    backend.failNext('deleteConflictIfUnchanged')
    expect(await store.deleteConflictDraftIfUnchanged(conflict())).toEqual({ status: 'failed' })
  })

  it('classifies a browser without IndexedDB as indexeddb-unavailable', async () => {
    // jsdom exposes no globalThis.indexedDB, so an explicit `undefined`
    // factory reproduces the production environment (private mode /
    // unsupported engine) the failure toast has to distinguish.
    const store = createDraftStore({ backend: createIndexedDbDraftBackend(undefined) })
    expect(await store.inspectVaultRecovery('vault'))
      .toEqual({ status: 'failed', reason: 'indexeddb-unavailable' })
  })
})

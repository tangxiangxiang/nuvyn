import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from './fixtures/auth'

const DATABASE_NAME = 'nuvyn-draft-recovery'
// The draft-store Playwright config serves this vault directory, so tests
// can modify authoritative disk content directly (external-edit scenarios).
const VAULT_DIR = process.env.NUVYN_DRAFT_E2E_VAULT ?? path.join(os.tmpdir(), 'nuvyn-draft-e2e-vault')

test.beforeEach(async ({ page }) => {
  // Keep the SPA from reopening the database while the per-test cleanup is
  // in flight. The app's startup recovery can otherwise recreate v2 after
  // deleteDatabase() succeeds, leaving schema-sensitive tests with a stale
  // database version before they begin.
  await page.goto('/src/main.ts')
  await page.evaluate(async (databaseName) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(databaseName)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error('Draft database deletion blocked'))
    })
  }, DATABASE_NAME)
  await page.goto('/')
})

test('creates the production schema and persists compound-key records', async ({
  page,
}) => {
  const result = await page.evaluate(async (databaseName) => {
    const { createDraftStore } = await import(
      '/src/composables/vault/draft-recovery/draftStore.ts'
    )
    const store = createDraftStore()
    const makeDraft = (vaultId: string, documentId: string, updatedAt: number) => ({
      version: 1 as const,
      vaultId,
      documentId,
      documentPath: `notes/${documentId}`,
      content: `${vaultId}:${documentId}`,
      baseContentHash: null,
      baseModifiedAt: null,
      createdAt: 10,
      updatedAt,
    })

    await store.saveDraft(makeDraft('vault-a', 'same', 20))
    await store.saveDraft(makeDraft('vault-b', 'same', 30))

    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 2)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const transaction = database.transaction('drafts', 'readonly')
    const objectStore = transaction.objectStore('drafts')
    const schema = {
      keyPath: objectStore.keyPath,
      indexes: [...objectStore.indexNames],
    }
    database.close()

    return {
      schema,
      vaultA: await store.listDrafts('vault-a'),
      vaultB: await store.getDraft('vault-b', 'same'),
    }
  }, DATABASE_NAME)

  expect(result.schema).toEqual({
    keyPath: ['vaultId', 'documentId'],
    indexes: ['vaultUpdatedAt'],
  })
  expect(result.vaultA).toHaveLength(1)
  expect(result.vaultA[0]?.vaultId).toBe('vault-a')
  expect(result.vaultB?.content).toBe('vault-b:same')
})

test('inspects primary and conflict inventory and conditionally preserves a newer conflict', async ({ page }) => {
  const result = await page.evaluate(async (databaseName) => {
    const { createDraftStore } = await import('/src/composables/vault/draft-recovery/draftStore.ts')
    const first = createDraftStore()
    const primary = {
      version: 1 as const,
      vaultId: 'managed-vault',
      documentId: 'doc',
      documentPath: 'notes/doc',
      content: 'primary',
      baseContentHash: null,
      baseModifiedAt: null,
      createdAt: 1,
      updatedAt: 1,
    }
    const conflict = {
      ...primary,
      conflictId: 'candidate',
      content: 'candidate-v1',
      origin: 'delete-conflict' as const,
      crossContextUpdatedAt: null,
      recordedAt: 2,
      updatedAt: 2,
    }
    await first.saveDraft(primary)
    await first.saveConflictDraft(conflict)
    const seedDatabase = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 2)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise<void>((resolve, reject) => {
      const transaction = seedDatabase.transaction('drafts', 'readwrite')
      const drafts = transaction.objectStore('drafts')
      drafts.put({ ...primary, documentId: 'missing-updated', content: 'secret-a', updatedAt: undefined })
      drafts.put({ ...primary, documentId: 'bad-updated', content: 'secret-b', updatedAt: 'bad' })
      drafts.put({ ...primary, documentId: 'future', content: 'secret-c', version: 2 })
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
    seedDatabase.close()
    const inventory = await first.inspectVaultRecovery('managed-vault')
    const newer = {
      ...conflict,
      content: 'candidate-v2',
      updatedAt: 3,
      recordedAt: 3,
    }
    // A second browser context can replace the raw row after cleanup
    // has captured its expected record. Seed that exact IndexedDB race.
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 2)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('draftConflicts', 'readwrite')
      transaction.objectStore('draftConflicts').put(newer)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
    database.close()
    const deletion = await first.deleteConflictDraftIfUnchanged(conflict)
    const remaining = await first.listConflictDrafts('managed-vault')
    return { inventory, deletion, remaining }
  }, DATABASE_NAME)

  expect(result.inventory).toMatchObject({
    status: 'ok',
    inventory: {
      primary: [{ content: 'primary' }],
      conflicts: [{ content: 'candidate-v1' }],
      unsupportedPrimaryCount: 3,
      unsupportedConflictCount: 0,
    },
  })
  expect(JSON.stringify(result.inventory)).not.toContain('secret-')
  expect(result.deletion).toEqual({ status: 'stale' })
  expect(result.remaining).toMatchObject([{ content: 'candidate-v2' }])
})

test('cleans expired recovery records while preserving a protected identity in real IndexedDB', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { createDraftStore } = await import('/src/composables/vault/draft-recovery/draftStore.ts')
    const { createUnsavedDraftRecovery } = await import('/src/composables/vault/draft-recovery/useUnsavedDraftRecovery.ts')
    const { createDraftRecoveryManagement } = await import('/src/composables/vault/draft-recovery/useDraftRecoveryManagement.ts')
    const store = createDraftStore()
    for (let index = 0; index < 101; index += 1) {
      await store.saveDraft({
        version: 1 as const,
        vaultId: 'cleanup-vault',
        documentId: `doc-${index}`,
        documentPath: `missing/doc-${index}`,
        content: `content-${index}`,
        baseContentHash: null,
        baseModifiedAt: null,
        createdAt: index + 1,
        updatedAt: index + 1,
      })
    }
    const recovery = createUnsavedDraftRecovery({
      store,
      loadPost: async () => { throw Object.assign(new Error('missing'), { status: 404 }) },
    })
    const protectedIdentity = JSON.stringify(['cleanup-vault', 'doc-0'])
    const management = createDraftRecoveryManagement({
      store,
      recovery,
      getPersistenceProtection: () => ({ identityIds: new Set([protectedIdentity]) }),
      now: () => 31 * 24 * 60 * 60 * 1000,
    })
    await recovery.discover('cleanup-vault')
    await management.refresh('cleanup-vault')
    const report = await management.cleanupNow()
    const inventory = await store.inspectVaultRecovery('cleanup-vault')
    return { report, inventory }
  })

  expect(result.report.deleted).toHaveLength(100)
  expect(result.report.skippedProtected).toHaveLength(1)
  expect(result.report.after).toMatchObject({ recordCount: 1, overCapacity: false })
  expect(result.inventory).toMatchObject({
    status: 'ok',
    inventory: { primary: [{ documentId: 'doc-0' }] },
  })
})

test('rejects an oversized dirty buffer without truncation and later persists a smaller revision', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { createDraftStore } = await import('/src/composables/vault/draft-recovery/draftStore.ts')
    const { createUnsavedDraftPersistence } = await import('/src/composables/vault/draft-recovery/useUnsavedDraftPersistence.ts')
    const { MAX_DRAFT_CONTENT_BYTES } = await import('/src/composables/vault/draft-recovery/draftCleanup.ts')
    const store = createDraftStore()
    const issues: Array<{ kind: string; bytes: number }> = []
    const persistence = createUnsavedDraftPersistence({
      store,
      debounceMs: 1,
      onIssue: (issue) => issues.push({ kind: issue.kind, bytes: issue.bytes }),
    })
    const base = {
      vaultId: 'size-vault', documentId: 'doc', documentPath: 'notes/doc',
      authoritativeContent: 'disk', baseContentHash: null, baseModifiedAt: null,
    }
    persistence.schedule({ ...base, content: 'x'.repeat(MAX_DRAFT_CONTENT_BYTES + 1), revision: 1 })
    const oversizedFlush = await persistence.flush('size-vault', 'doc')
    const oversizedStored = await store.getDraft('size-vault', 'doc')
    persistence.schedule({ ...base, content: 'small', revision: 2 })
    const smallerFlush = await persistence.flush('size-vault', 'doc')
    const stored = await store.getDraft('size-vault', 'doc')
    return { oversizedFlush, oversizedStored, smallerFlush, stored, issues }
  })

  expect(result.oversizedFlush).toBe(false)
  expect(result.oversizedStored).toBeNull()
  expect(result.issues).toHaveLength(1)
  expect(result.smallerFlush).toBe(true)
  expect(result.stored?.content).toBe('small')
})

test('keeps both IndexedDB records when an atomic move conflicts', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { createDraftStore } = await import(
      '/src/composables/vault/draft-recovery/draftStore.ts'
    )
    const store = createDraftStore()
    const makeDraft = (documentId: string, content: string, updatedAt: number) => ({
      version: 1 as const,
      vaultId: 'vault-a',
      documentId,
      documentPath: `notes/${documentId}`,
      content,
      baseContentHash: null,
      baseModifiedAt: null,
      createdAt: 10,
      updatedAt,
    })

    await store.saveDraft(makeDraft('source', 'source buffer', 40))
    await store.saveDraft(makeDraft('target', 'target buffer', 30))
    const outcome = await store.moveDraft(
      'vault-a',
      'source',
      'target',
      'renamed/target',
    )

    return {
      outcome,
      source: await store.getDraft('vault-a', 'source'),
      target: await store.getDraft('vault-a', 'target'),
    }
  })

  expect(result.outcome).toEqual({ status: 'conflict' })
  expect(result.source?.content).toBe('source buffer')
  expect(result.target?.content).toBe('target buffer')
})

test('persists primary and local conflict recovery candidates in separate IndexedDB stores', async ({
  page,
}) => {
  const result = await page.evaluate(async (databaseName) => {
    const { createDraftStore } = await import(
      '/src/composables/vault/draft-recovery/draftStore.ts'
    )
    const store = createDraftStore()
    const primary = {
      version: 1 as const,
      vaultId: 'vault-a',
      documentId: 'a',
      documentPath: 'notes/a',
      content: 'cross-context candidate',
      baseContentHash: null,
      baseModifiedAt: 10,
      createdAt: 10,
      updatedAt: 30,
    }
    const conflict = {
      version: 1 as const,
      conflictId: 'local-conflict',
      vaultId: 'vault-a',
      documentId: 'a',
      documentPath: 'notes/a',
      content: 'local candidate',
      baseContentHash: null,
      baseModifiedAt: 10,
      createdAt: 10,
      updatedAt: 31,
      origin: 'delete-conflict' as const,
      crossContextUpdatedAt: 30,
      recordedAt: 31,
    }
    await store.saveDraft(primary)
    const saved = await store.saveConflictDraft(conflict)
    const replacement = await store.saveConflictDraft({
      ...conflict,
      content: 'must not replace',
    })
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 2)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const stores = [...database.objectStoreNames]
    database.close()
    return {
      saved,
      replacement,
      stores,
      primary: await store.getDraft('vault-a', 'a'),
      conflicts: await store.listConflictDrafts('vault-a'),
    }
  }, DATABASE_NAME)

  expect(result.saved).toEqual({ status: 'saved' })
  expect(result.replacement).toEqual({ status: 'failed' })
  expect(result.stores).toEqual(['draftConflicts', 'drafts'])
  expect(result.primary?.content).toBe('cross-context candidate')
  expect(result.conflicts).toHaveLength(1)
  expect(result.conflicts[0]?.content).toBe('local candidate')
})

test('atomically keeps a newer draft when conditional deletion is stale', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { createDraftStore } = await import(
      '/src/composables/vault/draft-recovery/draftStore.ts'
    )
    const store = createDraftStore()
    const original = {
      version: 1 as const,
      vaultId: 'vault-a',
      documentId: 'a',
      documentPath: 'notes/a',
      content: 'v1',
      baseContentHash: null,
      baseModifiedAt: 10,
      createdAt: 10,
      updatedAt: 20,
    }
    const newer = { ...original, content: 'v2', updatedAt: 30 }
    await store.saveDraft(original)
    await store.saveDraft(newer)

    return {
      outcome: await store.deleteDraftIfUnchanged(original),
      current: await store.getDraft('vault-a', 'a'),
    }
  })

  expect(result.outcome).toEqual({ status: 'stale' })
  expect(result.current).toMatchObject({ content: 'v2', updatedAt: 30 })
})

test('does not adopt or rewrite a newer cross-context recovery draft', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { createDraftStore } = await import(
      '/src/composables/vault/draft-recovery/draftStore.ts'
    )
    const { createUnsavedDraftPersistence } = await import(
      '/src/composables/vault/draft-recovery/useUnsavedDraftPersistence.ts'
    )
    const store = createDraftStore()
    const original = {
      version: 1 as const,
      vaultId: 'vault-a',
      documentId: 'a',
      documentPath: 'notes/a',
      content: 'v1',
      baseContentHash: null,
      baseModifiedAt: 10,
      createdAt: 10,
      updatedAt: 20,
    }
    await store.saveDraft(original)
    await store.saveDraft({ ...original, content: 'v2', updatedAt: 30 })
    const persistence = createUnsavedDraftPersistence({ store })
    const owner = await persistence.adoptRecoveredDraft(original, {
      vaultId: 'vault-a',
      documentId: 'a',
      documentPath: 'notes/a',
      content: 'v1',
      authoritativeContent: 'disk',
      baseContentHash: null,
      baseModifiedAt: 10,
      revision: 1,
    })
    await persistence.dispose()

    return {
      owner,
      current: await store.getDraft('vault-a', 'a'),
    }
  })

  expect(result.owner).toBeNull()
  expect(result.current).toMatchObject({ content: 'v2', updatedAt: 30 })
})

test('does not rewrite unsupported records in IndexedDB', async ({ page }) => {
  const result = await page.evaluate(async (databaseName) => {
    const { createDraftStore } = await import(
      '/src/composables/vault/draft-recovery/draftStore.ts'
    )
    const store = createDraftStore()
    const validDraft = {
      version: 1 as const,
      vaultId: 'vault-a',
      documentId: 'seed',
      documentPath: 'notes/seed',
      content: 'seed',
      baseContentHash: null,
      baseModifiedAt: null,
      createdAt: 10,
      updatedAt: 20,
    }
    await store.saveDraft(validDraft)

    const future = {
      ...validDraft,
      version: 2,
      documentId: 'future',
      documentPath: 'notes/future',
      content: 'future buffer',
    }
    const corrupt = {
      ...validDraft,
      documentId: 'target',
      documentPath: 'notes/target',
      content: 42,
    }
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 2)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const write = database.transaction('drafts', 'readwrite')
    write.objectStore('drafts').put(future)
    write.objectStore('drafts').put(corrupt)
    await new Promise<void>((resolve, reject) => {
      write.oncomplete = () => resolve()
      write.onerror = () => reject(write.error)
      write.onabort = () => reject(write.error)
    })

    const source = {
      ...validDraft,
      documentId: 'source',
      documentPath: 'notes/source',
      content: 'source buffer',
      updatedAt: 30,
    }
    await store.saveDraft(source)
    const saved = await store.saveDraft({
      ...validDraft,
      documentId: 'future',
      documentPath: 'notes/future',
      content: 'current buffer',
      updatedAt: 40,
    })
    const moved = await store.moveDraft(
      'vault-a',
      'source',
      'target',
      'renamed/target',
    )
    const deleted = await store.deleteDraft('vault-a', 'future')
    const cleared = await store.clearVaultDrafts('vault-a')

    const read = database.transaction('drafts', 'readonly').objectStore('drafts')
    const readRecord = (key: IDBValidKey) => new Promise<unknown>((resolve, reject) => {
      const request = read.get(key)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const [rawFuture, rawTarget, rawSource] = await Promise.all([
      readRecord(['vault-a', 'future']),
      readRecord(['vault-a', 'target']),
      readRecord(['vault-a', 'source']),
    ])
    database.close()

    return {
      saved,
      moved,
      deleted,
      cleared,
      rawFuture,
      rawTarget,
      rawSource,
    }
  }, DATABASE_NAME)

  expect(result.saved).toEqual({
    status: 'unsupported',
    familyPath: 'notes/future',
    reason: 'unsupported-primary',
  })
  expect(result.moved).toEqual({ status: 'unsupported' })
  expect(result.deleted).toEqual({ status: 'unsupported' })
  expect(result.cleared).toBe(true)
  expect(result.rawFuture).toMatchObject({ version: 2, content: 'future buffer' })
  expect(result.rawTarget).toMatchObject({ content: 42 })
  expect(result.rawSource).toBeUndefined()
})

test('keeps the family intact when any row is unsupported in IndexedDB', async ({
  page,
}) => {
  const result = await page.evaluate(async (databaseName) => {
    const { createDraftStore } = await import(
      '/src/composables/vault/draft-recovery/draftStore.ts'
    )
    const store = createDraftStore()
    const makeConflict = (conflictId: string, content: string) => ({
      version: 1 as const,
      conflictId,
      vaultId: 'vault-a',
      documentId: 'doc',
      documentPath: 'notes/doc',
      content,
      baseContentHash: null,
      baseModifiedAt: null,
      createdAt: 10,
      updatedAt: 31,
      origin: 'delete-conflict' as const,
      crossContextUpdatedAt: 30,
      recordedAt: 31,
    })
    await store.saveDraft({
      version: 1 as const,
      vaultId: 'vault-a',
      documentId: 'doc',
      documentPath: 'notes/doc',
      content: 'primary buffer',
      baseContentHash: null,
      baseModifiedAt: null,
      createdAt: 10,
      updatedAt: 20,
    })
    await store.saveConflictDraft(makeConflict('conflict-a', 'local orphan'))

    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 2)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const putRaw = (storeName: string, value: unknown) => new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readwrite')
      transaction.objectStore(storeName).put(value)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
    const deleteRaw = (storeName: string, key: IDBValidKey) => new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readwrite')
      transaction.objectStore(storeName).delete(key)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
    // A future-version conflict row for the same identity, seeded
    // behind the store's validation.
    await putRaw('draftConflicts', {
      ...makeConflict('conflict-future', 'future data'),
      version: 2,
    })

    const futureConflictBlocks = await store.moveDraftFamily('vault-a', 'doc', 'archive/doc')
    const primaryAfterBlockedMove = await store.getDraft('vault-a', 'doc')
    const conflictsAfterBlockedMove = await store.listConflictDrafts('vault-a')

    // Now corrupt the primary instead: an unsupported primary must
    // leave the valid conflict on the old path with it.
    await deleteRaw('draftConflicts', ['vault-a', 'doc', 'conflict-future'])
    await putRaw('drafts', {
      version: 2,
      vaultId: 'vault-a',
      documentId: 'doc',
      documentPath: 'notes/doc',
      content: 'future primary data',
      baseContentHash: null,
      baseModifiedAt: null,
      createdAt: 10,
      updatedAt: 40,
    })
    const futurePrimaryBlocks = await store.moveDraftFamily('vault-a', 'doc', 'archive/doc')
    const conflictsAfterPrimaryBlocked = await store.listConflictDrafts('vault-a')
    database.close()

    return {
      futureConflictBlocks,
      primaryPathAfterBlockedMove: primaryAfterBlockedMove?.documentPath ?? null,
      conflictPathsAfterBlockedMove: conflictsAfterBlockedMove.map((c) => c.documentPath),
      futurePrimaryBlocks,
      conflictPathsAfterPrimaryBlocked: conflictsAfterPrimaryBlocked.map((c) => c.documentPath),
    }
  }, DATABASE_NAME)

  // The future-version conflict blocks the WHOLE family move — the
  // primary and the valid conflict both stay on the old path (a
  // partial migration would strand the unreadable row behind).
  expect(result.futureConflictBlocks).toEqual({ status: 'unsupported', movedConflicts: 0 })
  expect(result.primaryPathAfterBlockedMove).toBe('notes/doc')
  expect(result.conflictPathsAfterBlockedMove).toEqual(['notes/doc'])
  // An unsupported primary likewise keeps its valid conflict with it.
  expect(result.futurePrimaryBlocks).toEqual({ status: 'unsupported', movedConflicts: 0 })
  expect(result.conflictPathsAfterPrimaryBlocked).toEqual(['notes/doc'])
})

test('blocks a primary save in IndexedDB when a same-identity conflict row is unsupported', async ({
  page,
}) => {
  const result = await page.evaluate(async (databaseName) => {
    const { createDraftStore } = await import(
      '/src/composables/vault/draft-recovery/draftStore.ts'
    )
    const store = createDraftStore()
    const makeDraft = (content: string, updatedAt: number) => ({
      version: 1 as const,
      vaultId: 'vault-a',
      documentId: 'doc',
      documentPath: 'notes/doc',
      content,
      baseContentHash: null,
      baseModifiedAt: null,
      createdAt: 10,
      updatedAt,
    })
    await store.saveDraft(makeDraft('primary v1', 20))

    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 2)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    // Seed a future-version conflict row for the SAME identity behind
    // the store's validation.
    const seed = database.transaction('draftConflicts', 'readwrite')
    seed.objectStore('draftConflicts').put({
      version: 2,
      conflictId: 'conflict-future',
      vaultId: 'vault-a',
      documentId: 'doc',
      documentPath: 'notes/doc',
      content: 'future data',
      baseContentHash: null,
      baseModifiedAt: null,
      createdAt: 10,
      updatedAt: 31,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 30,
      recordedAt: 31,
    })
    await new Promise<void>((resolve, reject) => {
      seed.oncomplete = () => resolve()
      seed.onerror = () => reject(seed.error)
      seed.onabort = () => reject(seed.error)
    })

    // The plain primary save must be blocked while the unreadable
    // conflict row survives for the same identity — otherwise the
    // primary would be updated while the row stays invisible to
    // Recovery.
    const blocked = await store.saveDraft(makeDraft('primary v2', 40))
    const primaryAfterBlocked = await store.getDraft('vault-a', 'doc')

    // Remove the invalid row; the identical save then succeeds.
    const cleanup = database.transaction('draftConflicts', 'readwrite')
    cleanup.objectStore('draftConflicts').delete(['vault-a', 'doc', 'conflict-future'])
    await new Promise<void>((resolve, reject) => {
      cleanup.oncomplete = () => resolve()
      cleanup.onerror = () => reject(cleanup.error)
      cleanup.onabort = () => reject(cleanup.error)
    })
    database.close()
    const retry = await store.saveDraft(makeDraft('primary v2', 40))

    return {
      blocked,
      primaryAfterBlocked,
      retry,
      primaryAfterRetry: await store.getDraft('vault-a', 'doc'),
    }
  }, DATABASE_NAME)

  expect(result.blocked).toEqual({
    status: 'unsupported',
    familyPath: 'notes/doc',
    reason: 'unsupported-conflict',
  })
  // The primary record is byte-identical — never overwritten.
  expect(result.primaryAfterBlocked).toMatchObject({
    content: 'primary v1',
    updatedAt: 20,
  })
  expect(result.retry.status).toBe('saved')
  expect(result.primaryAfterRetry).toMatchObject({ content: 'primary v2' })
})

test('reports the family path for an unsupported conflict-only family in IndexedDB', async ({
  page,
}) => {
  const result = await page.evaluate(async (databaseName) => {
    const { createDraftStore } = await import(
      '/src/composables/vault/draft-recovery/draftStore.ts'
    )
    const store = createDraftStore()
    // Establish the schema before seeding raw rows behind the
    // store's validation.
    await store.saveDraft({
      version: 1 as const,
      vaultId: 'vault-a',
      documentId: 'seed',
      documentPath: 'notes/seed',
      content: 'seed',
      baseContentHash: null,
      baseModifiedAt: null,
      createdAt: 10,
      updatedAt: 20,
    })
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 2)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    // Conflict-only family for identity 'doc': one future-version row
    // the store cannot validate, sitting at archive/doc. No primary
    // record exists.
    const seed = database.transaction('draftConflicts', 'readwrite')
    seed.objectStore('draftConflicts').put({
      version: 2,
      conflictId: 'conflict-future',
      vaultId: 'vault-a',
      documentId: 'doc',
      documentPath: 'archive/doc',
      content: 'future data',
      baseContentHash: null,
      baseModifiedAt: null,
      createdAt: 10,
      updatedAt: 31,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 30,
      recordedAt: 31,
    })
    await new Promise<void>((resolve, reject) => {
      seed.oncomplete = () => resolve()
      seed.onerror = () => reject(seed.error)
      seed.onabort = () => reject(seed.error)
    })
    database.close()

    // A stale Tab saves at notes/doc.
    const saved = await store.saveDraft({
      version: 1 as const,
      vaultId: 'vault-a',
      documentId: 'doc',
      documentPath: 'notes/doc',
      content: 'stale tab buffer',
      baseContentHash: null,
      baseModifiedAt: null,
      createdAt: 10,
      updatedAt: 40,
    })
    return {
      saved,
      primaryAfter: await store.getDraft('vault-a', 'doc'),
      conflicts: await store.listConflictDrafts('vault-a'),
    }
  }, DATABASE_NAME)

  // The save is blocked by the unreadable row, but the outcome
  // reports the family's real path (the raw row's readable
  // documentPath) so the caller pins its candidate ON the family
  // instead of creating one at the stale snapshot path — a candidate
  // at notes/doc would split the conflict-only family.
  expect(result.saved).toEqual({
    status: 'unsupported',
    familyPath: 'archive/doc',
    reason: 'unsupported-conflict',
  })
  // No primary record created at the stale path, no candidate written
  // by the store itself.
  expect(result.primaryAfter).toBeNull()
  expect(result.conflicts).toEqual([])
})

test('reports no family path for a split unsupported family in IndexedDB', async ({
  page,
}) => {
  const result = await page.evaluate(async (databaseName) => {
    const { createDraftStore } = await import(
      '/src/composables/vault/draft-recovery/draftStore.ts'
    )
    const store = createDraftStore()
    await store.saveDraft({
      version: 1 as const,
      vaultId: 'vault-a',
      documentId: 'seed',
      documentPath: 'notes/seed',
      content: 'seed',
      baseContentHash: null,
      baseModifiedAt: null,
      createdAt: 10,
      updatedAt: 20,
    })
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 2)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    // Same identity, two raw rows DISAGREEING on the path — one
    // unreadable at archive/doc, one valid at legacy/doc. The family
    // location is indeterminate.
    const seed = database.transaction('draftConflicts', 'readwrite')
    seed.objectStore('draftConflicts').put({
      version: 2,
      conflictId: 'conflict-future',
      vaultId: 'vault-a',
      documentId: 'doc',
      documentPath: 'archive/doc',
      content: 'future data',
      baseContentHash: null,
      baseModifiedAt: null,
      createdAt: 10,
      updatedAt: 31,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 30,
      recordedAt: 31,
    })
    seed.objectStore('draftConflicts').put({
      version: 1,
      conflictId: 'conflict-valid',
      vaultId: 'vault-a',
      documentId: 'doc',
      documentPath: 'legacy/doc',
      content: 'valid data',
      baseContentHash: null,
      baseModifiedAt: null,
      createdAt: 10,
      updatedAt: 32,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 30,
      recordedAt: 32,
    })
    await new Promise<void>((resolve, reject) => {
      seed.oncomplete = () => resolve()
      seed.onerror = () => reject(seed.error)
      seed.onabort = () => reject(seed.error)
    })
    database.close()

    const saved = await store.saveDraft({
      version: 1 as const,
      vaultId: 'vault-a',
      documentId: 'doc',
      documentPath: 'notes/doc',
      content: 'stale tab buffer',
      baseContentHash: null,
      baseModifiedAt: null,
      createdAt: 10,
      updatedAt: 40,
    })
    return {
      saved,
      primaryAfter: await store.getDraft('vault-a', 'doc'),
      conflicts: await store.listConflictDrafts('vault-a'),
    }
  }, DATABASE_NAME)

  // The rows disagree — familyPath is null so the caller fails closed
  // instead of creating a candidate at its stale snapshot path (or
  // guessing a family side).
  expect(result.saved).toEqual({
    status: 'unsupported',
    familyPath: null,
    reason: 'split-conflict-paths',
  })
  expect(result.primaryAfter).toBeNull()
  // Only the valid row is discoverable, untouched.
  expect(result.conflicts).toHaveLength(1)
  expect(result.conflicts[0]).toMatchObject({
    conflictId: 'conflict-valid',
    documentPath: 'legacy/doc',
  })
})

test('persists the quarantine retry candidate at the family path in real IndexedDB', async ({
  page,
}) => {
  const result = await page.evaluate(async (databaseName) => {
    const { createDraftStore } = await import(
      '/src/composables/vault/draft-recovery/draftStore.ts'
    )
    const { createUnsavedDraftPersistence } = await import(
      '/src/composables/vault/draft-recovery/useUnsavedDraftPersistence.ts'
    )
    const store = createDraftStore()
    // A valid primary draft — the family lives at notes/doc.
    await store.saveDraft({
      version: 1 as const,
      vaultId: 'vault-a',
      documentId: 'doc',
      documentPath: 'notes/doc',
      content: 'primary',
      baseContentHash: null,
      baseModifiedAt: null,
      createdAt: 10,
      updatedAt: 20,
    })
    // A future-version conflict row for the same identity: readable
    // path notes/doc (the family still agrees), but the store cannot
    // validate it — the family move's pre-flight blocks the WHOLE
    // move instead of stranding this row on the pre-rename path.
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 2)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const seed = database.transaction('draftConflicts', 'readwrite')
    seed.objectStore('draftConflicts').put({
      version: 2,
      conflictId: 'conflict-future',
      vaultId: 'vault-a',
      documentId: 'doc',
      documentPath: 'notes/doc',
      content: 'future data',
      baseContentHash: null,
      baseModifiedAt: null,
      createdAt: 10,
      updatedAt: 25,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 20,
      recordedAt: 25,
    })
    await new Promise<void>((resolve, reject) => {
      seed.oncomplete = () => resolve()
      seed.onerror = () => reject(seed.error)
      seed.onabort = () => reject(seed.error)
    })
    database.close()

    const persistence = createUnsavedDraftPersistence({ store })
    const identity = {
      vaultId: 'vault-a',
      documentId: 'doc',
      documentPath: 'notes/doc',
    }
    const barrier = await persistence.prepareFileMutation([identity])
    // The server rename succeeded; the draft family move is blocked
    // by the unreadable row — the entry quarantines on oldPath.
    const [move] = await barrier.commitMoves([{
      ...identity,
      fromPath: 'notes/doc',
      toPath: 'archive/doc',
    }])
    await barrier.finalizeAfterTabMigration()

    // The post-rename edit arrives on the Tab's new path. flush routes
    // it through the unified write target: quarantine retry first —
    // blocked again — then the latest bytes persist as a candidate at
    // the family's ACTUAL path notes/doc, never at the Tab path.
    persistence.schedule({
      vaultId: 'vault-a',
      documentId: 'doc',
      documentPath: 'archive/doc',
      content: 'after-rename',
      authoritativeContent: 'primary',
      baseContentHash: null,
      baseModifiedAt: null,
      revision: 2,
    })
    const flushed = await persistence.flush('vault-a', 'doc')
    const primary = await store.getDraft('vault-a', 'doc')
    const conflicts = await store.listConflictDrafts('vault-a')
    await persistence.dispose()

    return { moveStatus: move.status, flushed, primary, conflicts }
  }, DATABASE_NAME)

  expect(result.moveStatus).toBe('unsupported')
  // The candidate persisted at the family path — the bytes are durable
  // and flush reports clean (the quarantine stays armed for the next
  // move attempt).
  expect(result.flushed).toBe(true)
  // The primary record never moved: the family is whole at notes/doc.
  expect(result.primary).toMatchObject({
    documentPath: 'notes/doc',
    content: 'primary',
  })
  // Exactly one discoverable candidate (the future row stays invisible
  // to the validated listing): the quarantine retry's record, pinned
  // at the family path — not at the renamed Tab path.
  expect(result.conflicts).toHaveLength(1)
  expect(result.conflicts[0]).toMatchObject({
    documentPath: 'notes/doc',
    content: 'after-rename',
    origin: 'move-conflict',
  })
})

test('re-pins a conflict candidate when the family moves in another IndexedDB context', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { createDraftStore } = await import(
      '/src/composables/vault/draft-recovery/draftStore.ts'
    )
    const { createUnsavedDraftPersistence } = await import(
      '/src/composables/vault/draft-recovery/useUnsavedDraftPersistence.ts'
    )
    // Context A: a stale tab edits against a newer cross-context
    // primary — the write pins the conflict channel at notes/doc.
    const storeA = createDraftStore()
    await storeA.saveDraft({
      version: 1 as const,
      vaultId: 'vault-a',
      documentId: 'doc',
      documentPath: 'notes/doc',
      content: 'remote',
      baseContentHash: null,
      baseModifiedAt: null,
      createdAt: 10,
      updatedAt: 110,
    })
    const persistence = createUnsavedDraftPersistence({
      store: storeA,
      now: () => 100,
    })
    persistence.schedule({
      vaultId: 'vault-a',
      documentId: 'doc',
      documentPath: 'notes/doc',
      content: 'local-edit',
      authoritativeContent: 'primary',
      baseContentHash: null,
      baseModifiedAt: null,
      revision: 1,
    })
    const firstFlush = await persistence.flush('vault-a', 'doc')

    // Context B (a second store over the SAME IndexedDB) moves the
    // whole family notes/doc → archive/doc in one atomic transaction.
    const storeB = createDraftStore()
    const moved = await storeB.moveDraftFamily('vault-a', 'doc', 'archive/doc')

    // Context A's next edit still carries the stale snapshot path.
    // The family-atomic candidate write must detect the moved family:
    // re-pin without writing (flush #1), then persist at archive/doc
    // (flush #2) — never strand a candidate at notes/doc.
    persistence.schedule({
      vaultId: 'vault-a',
      documentId: 'doc',
      documentPath: 'notes/doc',
      content: 'local-edit-2',
      authoritativeContent: 'primary',
      baseContentHash: null,
      baseModifiedAt: null,
      revision: 2,
    })
    const repinFlush = await persistence.flush('vault-a', 'doc')
    const midConflicts = await storeA.listConflictDrafts('vault-a')
    const persistFlush = await persistence.flush('vault-a', 'doc')
    const primary = await storeA.getDraft('vault-a', 'doc')
    const conflicts = await storeA.listConflictDrafts('vault-a')
    await persistence.dispose()
    return {
      firstFlush,
      moved,
      repinFlush,
      midConflicts,
      persistFlush,
      primary,
      conflicts,
    }
  }, DATABASE_NAME)

  // The stale handoff persists 'local-edit' as a candidate and pins
  // the conflict channel — but reports false BY DESIGN: the bytes are
  // durable as a candidate, not as the primary record, so a close seal
  // keeps the tab open. The pin itself is proven by what follows.
  expect(result.firstFlush).toBe(false)
  expect(result.moved).toMatchObject({ status: 'moved', movedConflicts: 1 })
  // The re-pin attempt persists nothing — the family still has exactly
  // one candidate, at the moved path.
  expect(result.repinFlush).toBe(false)
  expect(result.midConflicts).toHaveLength(1)
  expect(result.midConflicts[0]).toMatchObject({
    content: 'local-edit',
    documentPath: 'archive/doc',
  })
  // The re-pinned write then lands at the family's new path: every
  // readable row of the identity shares archive/doc.
  expect(result.persistFlush).toBe(true)
  expect(result.primary).toMatchObject({
    documentPath: 'archive/doc',
    content: 'remote',
  })
  expect(result.conflicts).toHaveLength(2)
  expect(result.conflicts.every((c) => c.documentPath === 'archive/doc')).toBe(true)
  expect(result.conflicts.map((c) => c.content).sort())
    .toEqual(['local-edit', 'local-edit-2'])
})

test('refuses a diverging first primary save for a conflict-only family in IndexedDB', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { createDraftStore } = await import(
      '/src/composables/vault/draft-recovery/draftStore.ts'
    )
    const store = createDraftStore()
    const makeDraft = (documentPath: string, updatedAt: number) => ({
      version: 1 as const,
      vaultId: 'vault-a',
      documentId: 'doc',
      documentPath,
      content: `primary at ${documentPath}`,
      baseContentHash: null,
      baseModifiedAt: null,
      createdAt: 10,
      updatedAt,
    })
    // Conflict-only family at archive/doc — no primary record.
    await store.saveConflictDraft({
      version: 1 as const,
      conflictId: 'conflict-orphan',
      vaultId: 'vault-a',
      documentId: 'doc',
      documentPath: 'archive/doc',
      content: 'orphan at archive',
      baseContentHash: null,
      baseModifiedAt: null,
      createdAt: 10,
      updatedAt: 31,
      origin: 'delete-conflict' as const,
      crossContextUpdatedAt: 30,
      recordedAt: 31,
    })

    // A first write at a DIVERGING path must not create the primary
    // there (that would split the family); the outcome anchors on the
    // newest candidate so the caller can pin its content to the
    // family path.
    const mismatch = await store.saveDraft(makeDraft('notes/doc', 40))
    const primaryAfterMismatch = await store.getDraft('vault-a', 'doc')

    // A first write at the family's path unites the family.
    const unite = await store.saveDraft(makeDraft('archive/doc', 40))
    const primaryAfterUnite = await store.getDraft('vault-a', 'doc')
    const conflicts = await store.listConflictDrafts('vault-a')

    return {
      mismatch,
      primaryAfterMismatch,
      uniteStatus: unite.status,
      primaryAfterUnite,
      conflictPaths: conflicts.map((c) => c.documentPath),
    }
  })

  expect(result.mismatch.status).toBe('path-mismatch')
  if (result.mismatch.status === 'path-mismatch') {
    expect(result.mismatch.current).toMatchObject({
      conflictId: 'conflict-orphan',
      documentPath: 'archive/doc',
    })
  }
  expect(result.primaryAfterMismatch).toBeNull()
  expect(result.uniteStatus).toBe('saved')
  expect(result.primaryAfterUnite).toMatchObject({
    documentPath: 'archive/doc',
    content: 'primary at archive/doc',
  })
  expect(result.conflictPaths).toEqual(['archive/doc'])
})

test('reports unsupported from the strict conflict read on an unreadable identity row', async ({
  page,
}) => {
  const result = await page.evaluate(async (databaseName) => {
    const { createDraftStore } = await import(
      '/src/composables/vault/draft-recovery/draftStore.ts'
    )
    const store = createDraftStore()
    const makeConflict = (conflictId: string, documentId: string, content: string) => ({
      version: 1 as const,
      conflictId,
      vaultId: 'vault-a',
      documentId,
      documentPath: `notes/${documentId}`,
      content,
      baseContentHash: null,
      baseModifiedAt: null,
      createdAt: 10,
      updatedAt: 31,
      origin: 'delete-conflict' as const,
      crossContextUpdatedAt: 30,
      recordedAt: 31,
    })
    await store.saveConflictDraft(makeConflict('conflict-a', 'doc', 'local orphan'))
    await store.saveConflictDraft(makeConflict('conflict-b', 'other', 'other orphan'))

    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 2)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const putRaw = (storeName: string, value: unknown) => new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readwrite')
      transaction.objectStore(storeName).put(value)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
    // A future-version conflict row for the SAME identity, seeded
    // behind the store's validation — exactly what a newer app version
    // could leave behind.
    await putRaw('draftConflicts', {
      ...makeConflict('conflict-future', 'doc', 'future data'),
      version: 2,
    })

    const scopedUnsupported = await store.listConflictDraftsStrict('vault-a', 'doc')
    const scopedClean = await store.listConflictDraftsStrict('vault-a', 'other')
    const lossy = await store.listConflictDrafts('vault-a')
    database.close()

    return {
      scopedUnsupported,
      scopedClean,
      lossyContents: lossy.map((c) => c.content).sort(),
    }
  }, DATABASE_NAME)

  // The same-identity unreadable row makes the strict read refuse to
  // certify the conflict state — a confirmed delete on top of it must
  // report 'unsupported' (identity kept visible) instead of silently
  // filtering the row behind an empty list.
  expect(result.scopedUnsupported).toEqual({ status: 'unsupported' })
  // A clean identity in the same vault still reads ok, scoped.
  expect(result.scopedClean).toEqual({
    status: 'ok',
    records: [expect.objectContaining({ conflictId: 'conflict-b', content: 'other orphan' })],
  })
  // Discovery keeps the lossy filtering (best-effort by nature).
  expect(result.lossyContents).toEqual(['local orphan', 'other orphan'])
})

test('closes a cached connection when another context upgrades the database', async ({
  page,
}) => {
  const result = await page.evaluate(async (databaseName) => {
    const { createDraftStore } = await import(
      '/src/composables/vault/draft-recovery/draftStore.ts'
    )
    const store = createDraftStore()
    await store.saveDraft({
      version: 1,
      vaultId: 'vault-a',
      documentId: 'a',
      documentPath: 'notes/a',
      content: 'buffer',
      baseContentHash: null,
      baseModifiedAt: null,
      createdAt: 10,
      updatedAt: 20,
    })

    const upgraded = await new Promise<number>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 3)
      request.onsuccess = () => {
        const version = request.result.version
        request.result.close()
        resolve(version)
      }
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error('Cached connection blocked upgrade'))
    })

    return {
      upgraded,
      oldStoreFailsClosed: await store.listDrafts('vault-a'),
    }
  }, DATABASE_NAME)

  expect(result).toEqual({
    upgraded: 3,
    oldStoreFailsClosed: [],
  })
})

test('does not leak a late connection after a blocked open', async ({ page }) => {
  // beforeEach returns to the SPA for the ordinary tests, and startup may
  // recreate the canonical v2 database before this fixture begins. Leave
  // that page and delete the test-owned database again so the held blocker
  // below deterministically owns a real v1 connection.
  await page.goto('/src/main.ts')
  await page.evaluate(async (databaseName) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(databaseName)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error('Draft database deletion blocked'))
    })
  }, DATABASE_NAME)

  const result = await page.evaluate(async (databaseName) => {
    const blocker = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
      // Fail fast rather than hang if this open is ever blocked.
      request.onblocked = () => reject(new Error('blocker open was blocked'))
    })

    let lateOpen: IDBOpenDBRequest | null = null
    let lateBlocked = false
    let lateOpenSettled: Promise<void> | null = null
    const upgradeFactory = {
      open(name: string) {
        lateOpen = indexedDB.open(name, 2)
        lateOpenSettled = new Promise<void>((resolve, reject) => {
          lateOpen!.addEventListener('blocked', () => { lateBlocked = true }, { once: true })
          lateOpen!.addEventListener('success', () => resolve(), { once: true })
          lateOpen!.addEventListener('error', () => reject(lateOpen!.error ?? new Error('late open failed')), { once: true })
        })
        return lateOpen
      },
    } as IDBFactory

    const { createDraftStore } = await import(
      '/src/composables/vault/draft-recovery/draftStore.ts'
    )
    const store = createDraftStore({ indexedDB: upgradeFactory })
    // listDrafts fails closed (returns []) when the open is blocked. The
    // blocker event is observed on the request itself, so this await must
    // resolve through the real production failure path.
    const listed = await store.listDrafts('vault-a')
    blocker.close()
    // The production helper closes the late success connection. Await the
    // actual request completion before deleting; a leaked connection makes
    // this single delete request report blocked and fails the assertion.
    await lateOpenSettled!
    const deletion = await new Promise<'deleted' | 'blocked'>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(databaseName)
      request.onsuccess = () => resolve('deleted')
      request.onerror = () => reject(request.error)
      request.onblocked = () => resolve('blocked')
    })

    return { listed, deletion, lateBlocked }
  }, DATABASE_NAME)

  expect(result).toEqual({
    listed: [],
    deletion: 'deleted',
    lateBlocked: true,
  })
})

test('fails safely when opening the production database fails', async ({
  page,
}) => {
  const result = await page.evaluate(async (databaseName) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 3)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    database.close()

    const { createDraftStore } = await import(
      '/src/composables/vault/draft-recovery/draftStore.ts'
    )
    const store = createDraftStore()
    const draft = {
      version: 1 as const,
      vaultId: 'vault-a',
      documentId: 'a',
      documentPath: 'notes/a',
      content: 'buffer',
      baseContentHash: null,
      baseModifiedAt: null,
      createdAt: 10,
      updatedAt: 20,
    }

    return {
      saved: await store.saveDraft(draft),
      listed: await store.listDrafts('vault-a'),
      moved: await store.moveDraft('vault-a', 'a', 'x', 'notes/x'),
    }
  }, DATABASE_NAME)

  expect(result).toEqual({
    saved: { status: 'failed' },
    listed: [],
    moved: { status: 'failed' },
  })
})

test('a stale quarantine retry in a second IndexedDB context adopts the certified current path', async ({
  page,
}) => {
  const result = await page.evaluate(async (databaseName) => {
    const { createDraftStore } = await import(
      '/src/composables/vault/draft-recovery/draftStore.ts'
    )
    const { createUnsavedDraftPersistence } = await import(
      '/src/composables/vault/draft-recovery/useUnsavedDraftPersistence.ts'
    )
    // Context A's family lives at notes/doc.
    const storeA = createDraftStore()
    await storeA.saveDraft({
      version: 1 as const,
      vaultId: 'vault-a',
      documentId: 'doc',
      documentPath: 'notes/doc',
      content: 'primary',
      baseContentHash: null,
      baseModifiedAt: null,
      createdAt: 10,
      updatedAt: 20,
    })
    // A future-version conflict row blocks context A's family move
    // (the store fails the WHOLE move closed) — the server rename
    // notes/doc→archive/doc succeeds, the entry quarantines on
    // familyPath notes/doc.
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 2)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const seed = database.transaction('draftConflicts', 'readwrite')
    seed.objectStore('draftConflicts').put({
      version: 2,
      conflictId: 'conflict-future',
      vaultId: 'vault-a',
      documentId: 'doc',
      documentPath: 'notes/doc',
      content: 'future data',
      baseContentHash: null,
      baseModifiedAt: null,
      createdAt: 10,
      updatedAt: 25,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 20,
      recordedAt: 25,
    })
    await new Promise<void>((resolve, reject) => {
      seed.oncomplete = () => resolve()
      seed.onerror = () => reject(seed.error)
      seed.onabort = () => reject(seed.error)
    })

    const persistence = createUnsavedDraftPersistence({
      store: storeA,
      now: () => 100,
    })
    const identity = {
      vaultId: 'vault-a',
      documentId: 'doc',
      documentPath: 'notes/doc',
    }
    const barrier = await persistence.prepareFileMutation([identity])
    const [move] = await barrier.commitMoves([{
      ...identity,
      fromPath: 'notes/doc',
      toPath: 'archive/doc',
    }])
    await barrier.finalizeAfterTabMigration()

    // The blocking row disappears; context B (a second store over the
    // SAME IndexedDB) then renames archive/doc→final/doc and moves
    // the family there in one transaction.
    const unblock = database.transaction('draftConflicts', 'readwrite')
    unblock.objectStore('draftConflicts')
      .delete(['vault-a', 'doc', 'conflict-future'])
    await new Promise<void>((resolve, reject) => {
      unblock.oncomplete = () => resolve()
      unblock.onerror = () => reject(unblock.error)
      unblock.onabort = () => reject(unblock.error)
    })
    database.close()
    const storeB = createDraftStore()
    const movedByB = await storeB.moveDraftFamily('vault-a', 'doc', 'final/doc')

    // Context A's stale quarantine retry fires via flush — it must
    // NOT drag the family back from final/doc to its old server
    // target archive/doc.
    persistence.schedule({
      vaultId: 'vault-a',
      documentId: 'doc',
      documentPath: 'archive/doc',
      content: 'after-rename',
      authoritativeContent: 'primary',
      baseContentHash: null,
      baseModifiedAt: null,
      revision: 2,
    })
    const flushed = await persistence.flush('vault-a', 'doc')
    const primary = await storeA.getDraft('vault-a', 'doc')
    const conflicts = await storeA.listConflictDrafts('vault-a')

    // Every raw row of the identity — including rows invisible to the
    // validated listing — must sit at the certified current path.
    const rawDatabase = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 2)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const rawTransaction = rawDatabase.transaction(
      ['drafts', 'draftConflicts'],
      'readonly',
    )
    const rawDrafts = await new Promise<unknown[]>((resolve, reject) => {
      const request = rawTransaction.objectStore('drafts').getAll()
      request.onsuccess = () => resolve(request.result as unknown[])
      request.onerror = () => reject(request.error)
    })
    const rawConflicts = await new Promise<unknown[]>((resolve, reject) => {
      const request = rawTransaction.objectStore('draftConflicts')
        .index('vaultId').getAll('vault-a')
      request.onsuccess = () => resolve(request.result as unknown[])
      request.onerror = () => reject(request.error)
    })
    rawDatabase.close()
    await persistence.dispose()

    return {
      moveStatus: move.status,
      movedByB,
      flushed,
      primary,
      conflicts,
      rawDraftPaths: rawDrafts.map((row) => (row as { documentPath: string }).documentPath),
      rawConflictPaths: rawConflicts.map((row) => (row as { documentPath: string }).documentPath),
    }
  }, DATABASE_NAME)

  expect(result.moveStatus).toBe('unsupported')
  expect(result.movedByB).toMatchObject({ status: 'moved' })
  // The stale retry persisted A's bytes (as a candidate) and reported
  // clean — without moving the family.
  expect(result.flushed).toBe(true)
  // The primary record stays exactly where context B's verified
  // rename put it — never dragged back to the quarantine's old
  // server target archive/doc.
  expect(result.primary).toMatchObject({
    documentPath: 'final/doc',
    content: 'primary',
  })
  // A's bytes are durable as a move-conflict candidate at the
  // certified current path.
  expect(result.conflicts).toHaveLength(1)
  expect(result.conflicts[0]).toMatchObject({
    documentPath: 'final/doc',
    content: 'after-rename',
    origin: 'move-conflict',
  })
  // The raw stores agree: the whole identity lives at final/doc.
  expect(result.rawDraftPaths).toEqual(['final/doc'])
  expect(result.rawConflictPaths).toEqual(['final/doc'])
})

test('a stale move-indeterminate retry in a second IndexedDB context adopts the certified current path', async ({
  page,
}) => {
  const result = await page.evaluate(async (databaseName) => {
    const { createDraftStore } = await import(
      '/src/composables/vault/draft-recovery/draftStore.ts'
    )
    const { createUnsavedDraftPersistence } = await import(
      '/src/composables/vault/draft-recovery/useUnsavedDraftPersistence.ts'
    )
    const storeA = createDraftStore()
    // Open the production database (creating both stores) before the
    // raw seeding transaction below opens it directly.
    await storeA.listDrafts('vault-a')
    // A split, partly unreadable family: no certified path exists.
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 2)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const seed = database.transaction('draftConflicts', 'readwrite')
    const conflictStore = seed.objectStore('draftConflicts')
    conflictStore.put({
      version: 2,
      conflictId: 'conflict-future',
      vaultId: 'vault-a',
      documentId: 'doc',
      documentPath: 'archive/doc',
      content: 'future data',
      baseContentHash: null,
      baseModifiedAt: null,
      createdAt: 10,
      updatedAt: 25,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 20,
      recordedAt: 25,
    })
    conflictStore.put({
      version: 1,
      conflictId: 'conflict-valid',
      vaultId: 'vault-a',
      documentId: 'doc',
      documentPath: 'legacy/doc',
      content: 'older local',
      baseContentHash: null,
      baseModifiedAt: null,
      createdAt: 10,
      updatedAt: 22,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 20,
      recordedAt: 22,
    })
    await new Promise<void>((resolve, reject) => {
      seed.oncomplete = () => resolve()
      seed.onerror = () => reject(seed.error)
      seed.onabort = () => reject(seed.error)
    })

    const persistence = createUnsavedDraftPersistence({
      store: storeA,
      now: () => 100,
    })
    persistence.schedule({
      vaultId: 'vault-a',
      documentId: 'doc',
      documentPath: 'notes/doc',
      content: 'stale-edit',
      authoritativeContent: 'primary',
      baseContentHash: null,
      baseModifiedAt: null,
      revision: 1,
    })
    const staleFlush = await persistence.flush('vault-a', 'doc')

    // Server rename succeeds, draft move is blocked → move-indeterminate
    // (the family path was never certified).
    const identity = {
      vaultId: 'vault-a',
      documentId: 'doc',
      documentPath: 'notes/doc',
    }
    const barrier = await persistence.prepareFileMutation([identity])
    const [move] = await barrier.commitMoves([{
      ...identity,
      fromPath: 'notes/doc',
      toPath: 'archive/doc',
    }])
    const finalized = await barrier.finalizeAfterTabMigration()
    persistence.schedule({
      vaultId: 'vault-a',
      documentId: 'doc',
      documentPath: 'archive/doc',
      content: 'after-rename',
      authoritativeContent: 'primary',
      baseContentHash: null,
      baseModifiedAt: null,
      revision: 2,
    })
    const blockedFlush = await persistence.flush('vault-a', 'doc')

    // The unreadable row disappears and context B moves the family to
    // final/doc — NOT the stale server target archive/doc.
    const unblock = database.transaction('draftConflicts', 'readwrite')
    unblock.objectStore('draftConflicts')
      .delete(['vault-a', 'doc', 'conflict-future'])
    await new Promise<void>((resolve, reject) => {
      unblock.oncomplete = () => resolve()
      unblock.onerror = () => reject(unblock.error)
      unblock.onabort = () => reject(unblock.error)
    })
    database.close()
    const storeB = createDraftStore()
    const movedByB = await storeB.moveDraftFamily('vault-a', 'doc', 'final/doc')

    // Context A's stale retry must re-verify the family FIRST: it
    // finds the certified current path final/doc ≠ serverPath
    // archive/doc, moves NOTHING, and persists A's bytes as a
    // candidate at final/doc.
    const flushed = await persistence.flush('vault-a', 'doc')
    const primary = await storeA.getDraft('vault-a', 'doc')
    const conflicts = await storeA.listConflictDrafts('vault-a')

    const rawDatabase = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 2)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const rawTransaction = rawDatabase.transaction(
      ['drafts', 'draftConflicts'],
      'readonly',
    )
    const rawDrafts = await new Promise<unknown[]>((resolve, reject) => {
      const request = rawTransaction.objectStore('drafts').getAll()
      request.onsuccess = () => resolve(request.result as unknown[])
      request.onerror = () => reject(request.error)
    })
    const rawConflicts = await new Promise<unknown[]>((resolve, reject) => {
      const request = rawTransaction.objectStore('draftConflicts')
        .index('vaultId').getAll('vault-a')
      request.onsuccess = () => resolve(request.result as unknown[])
      request.onerror = () => reject(request.error)
    })
    rawDatabase.close()
    await persistence.dispose()

    return {
      staleFlush,
      moveStatus: move.status,
      finalized,
      blockedFlush,
      movedByB,
      flushed,
      primary,
      conflicts,
      rawDraftCount: rawDrafts.length,
      rawConflictPaths: rawConflicts
        .map((row) => (row as { documentPath: string }).documentPath)
        .sort(),
    }
  }, DATABASE_NAME)

  expect(result.staleFlush).toBe(false)
  expect(result.moveStatus).toBe('unsupported')
  expect(result.finalized).toEqual([{
    documentId: 'doc',
    oldPath: 'notes/doc',
    newPath: 'archive/doc',
    status: 'failed',
  }])
  expect(result.blockedFlush).toBe(false)
  expect(result.movedByB).toMatchObject({ status: 'missing' })
  // The stale retry persisted A's bytes and reported clean — without
  // blind-moving the family toward the stale server target.
  expect(result.flushed).toBe(true)
  // No primary record was minted anywhere — the family is conflict-only
  // and lives at B's certified path.
  expect(result.primary).toBeNull()
  expect(result.conflicts).toHaveLength(2)
  expect(result.conflicts.every((c) => c.documentPath === 'final/doc')).toBe(true)
  expect(result.conflicts.find((c) => c.content === 'after-rename')).toMatchObject({
    documentPath: 'final/doc',
    origin: 'move-conflict',
  })
  // The raw stores agree: no primary row, both candidates at final/doc.
  expect(result.rawDraftCount).toBe(0)
  expect(result.rawConflictPaths).toEqual(['final/doc', 'final/doc'])
})

test('a quarantine retry whose CAS fails discards the stale serverPath when the fallback candidate meets path-mismatch', async ({
  page,
}) => {
  const result = await page.evaluate(async (databaseName) => {
    const { createDraftStore } = await import(
      '/src/composables/vault/draft-recovery/draftStore.ts'
    )
    const { createUnsavedDraftPersistence } = await import(
      '/src/composables/vault/draft-recovery/useUnsavedDraftPersistence.ts'
    )
    // Context A's family lives at notes/doc.
    const storeA = createDraftStore()
    await storeA.saveDraft({
      version: 1 as const,
      vaultId: 'vault-a',
      documentId: 'doc',
      documentPath: 'notes/doc',
      content: 'primary',
      baseContentHash: null,
      baseModifiedAt: null,
      createdAt: 10,
      updatedAt: 20,
    })
    // A future-version conflict row at the family path makes every
    // CAS move 'unsupported' (the transaction validates the whole
    // family) while the raw-path candidate authority can still LOCATE
    // the path — the exact split that forces the retry down the
    // fallback-candidate branch in real IndexedDB.
    const openRaw = () => new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 2)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const runTx = (
      database: IDBDatabase,
      mutate: (store: IDBObjectStore) => void,
    ) => new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('draftConflicts', 'readwrite')
      mutate(transaction.objectStore('draftConflicts'))
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
    const database = await openRaw()
    await runTx(database, (store) => store.put({
      version: 2,
      conflictId: 'conflict-future',
      vaultId: 'vault-a',
      documentId: 'doc',
      documentPath: 'notes/doc',
      content: 'future data',
      baseContentHash: null,
      baseModifiedAt: null,
      createdAt: 10,
      updatedAt: 25,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 20,
      recordedAt: 25,
    }))

    const persistence = createUnsavedDraftPersistence({
      store: storeA,
      now: () => 100,
    })
    const identity = {
      vaultId: 'vault-a',
      documentId: 'doc',
      documentPath: 'notes/doc',
    }
    // Server rename notes/doc→archive/doc succeeds, draft family move
    // is unsupported → quarantine{familyPath notes/doc, serverPath
    // archive/doc}.
    const barrier = await persistence.prepareFileMutation([identity])
    const [move] = await barrier.commitMoves([{
      ...identity,
      fromPath: 'notes/doc',
      toPath: 'archive/doc',
    }])
    await barrier.finalizeAfterTabMigration()

    // The first stale retry: the CAS comes back 'unsupported' (the
    // future row) and the fallback candidate JOINS the family at
    // notes/doc — the retry reports clean, quarantine intact.
    persistence.schedule({
      vaultId: 'vault-a',
      documentId: 'doc',
      documentPath: 'archive/doc',
      content: 'after-rename',
      authoritativeContent: 'primary',
      baseContentHash: null,
      baseModifiedAt: null,
      revision: 2,
    })
    const flushed1 = await persistence.flush('vault-a', 'doc')

    // The blocker disappears; context B completes archive/doc→final/doc
    // and moves the whole family (primary + A's candidate) there.
    await runTx(database, (store) => store
      .delete(['vault-a', 'doc', 'conflict-future']))
    database.close()
    const storeB = createDraftStore()
    const movedByB = await storeB.moveDraftFamily('vault-a', 'doc', 'final/doc')
    // A fresh unreadable row at final/doc keeps the NEXT CAS
    // 'unsupported' while the candidate authority still certifies
    // final/doc — so the retry's fallback candidate write at the
    // stale oldPath notes/doc meets path-mismatch with the family's
    // certified CURRENT path.
    const database2 = await openRaw()
    await runTx(database2, (store) => store.put({
      version: 2,
      conflictId: 'conflict-blocker',
      vaultId: 'vault-a',
      documentId: 'doc',
      documentPath: 'final/doc',
      content: 'future data',
      baseContentHash: null,
      baseModifiedAt: null,
      createdAt: 10,
      updatedAt: 25,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 20,
      recordedAt: 25,
    }))
    database2.close()

    // The second stale retry: CAS 'unsupported' AGAIN, fallback
    // candidate at notes/doc → path-mismatch(final/doc). The stale
    // serverPath archive/doc must now be DISCARDED: A's bytes persist
    // as a candidate at final/doc and the entry pins to the conflict
    // channel there — never a surviving quarantine that would retry
    // archive/doc later.
    persistence.schedule({
      vaultId: 'vault-a',
      documentId: 'doc',
      documentPath: 'archive/doc',
      content: 'second-edit',
      authoritativeContent: 'primary',
      baseContentHash: null,
      baseModifiedAt: null,
      revision: 3,
    })
    const flushed2 = await persistence.flush('vault-a', 'doc')
    const primary = await storeA.getDraft('vault-a', 'doc')
    const conflicts = await storeA.listConflictDrafts('vault-a')

    // The blocker disappears; a final edit must write on the conflict
    // channel at final/doc. A surviving quarantine would instead
    // re-run the CAS — whose expected path now matches the family's
    // real path — and DRAG the family back to archive/doc.
    const database3 = await openRaw()
    await runTx(database3, (store) => store
      .delete(['vault-a', 'doc', 'conflict-blocker']))
    database3.close()
    persistence.schedule({
      vaultId: 'vault-a',
      documentId: 'doc',
      documentPath: 'archive/doc',
      content: 'third-edit',
      authoritativeContent: 'primary',
      baseContentHash: null,
      baseModifiedAt: null,
      revision: 4,
    })
    const flushed3 = await persistence.flush('vault-a', 'doc')

    const rawDatabase = await openRaw()
    const rawTransaction = rawDatabase.transaction(
      ['drafts', 'draftConflicts'],
      'readonly',
    )
    const rawDrafts = await new Promise<unknown[]>((resolve, reject) => {
      const request = rawTransaction.objectStore('drafts').getAll()
      request.onsuccess = () => resolve(request.result as unknown[])
      request.onerror = () => reject(request.error)
    })
    const rawConflicts = await new Promise<unknown[]>((resolve, reject) => {
      const request = rawTransaction.objectStore('draftConflicts')
        .index('vaultId').getAll('vault-a')
      request.onsuccess = () => resolve(request.result as unknown[])
      request.onerror = () => reject(request.error)
    })
    rawDatabase.close()
    await persistence.dispose()

    return {
      moveStatus: move.status,
      flushed1,
      movedByB,
      flushed2,
      primary,
      conflicts,
      flushed3,
      rawDraftPaths: rawDrafts.map((row) => (row as { documentPath: string }).documentPath),
      rawConflictPaths: rawConflicts.map((row) => (row as { documentPath: string }).documentPath),
    }
  }, DATABASE_NAME)

  expect(result.moveStatus).toBe('unsupported')
  // First retry: the fallback candidate joined the family at its then
  // current path — reported clean.
  expect(result.flushed1).toBe(true)
  expect(result.movedByB).toMatchObject({ status: 'moved' })
  // Second retry: the candidate met path-mismatch — the stale
  // quarantine was discarded and A's bytes persisted at the certified
  // current path.
  expect(result.flushed2).toBe(true)
  expect(result.primary).toMatchObject({
    documentPath: 'final/doc',
    content: 'primary',
  })
  expect(result.conflicts).toHaveLength(2)
  expect(result.conflicts.every((c) => c.documentPath === 'final/doc')).toBe(true)
  expect(result.conflicts.find((c) => c.content === 'after-rename')).toMatchObject({
    documentPath: 'final/doc',
    origin: 'move-conflict',
  })
  expect(result.conflicts.find((c) => c.content === 'second-edit')).toMatchObject({
    documentPath: 'final/doc',
    origin: 'move-conflict',
  })
  // The final edit wrote on the conflict channel — no stale move
  // retry dragged the family to archive/doc.
  expect(result.flushed3).toBe(true)
  expect(result.rawDraftPaths).toEqual(['final/doc'])
  expect(result.rawConflictPaths).toEqual(['final/doc', 'final/doc', 'final/doc'])
})

test('a conflict-pinned quarantine discards the stale serverPath when its candidate meets path-mismatch', async ({
  page,
}) => {
  const result = await page.evaluate(async (databaseName) => {
    const { createDraftStore } = await import(
      '/src/composables/vault/draft-recovery/draftStore.ts'
    )
    const { createUnsavedDraftPersistence } = await import(
      '/src/composables/vault/draft-recovery/useUnsavedDraftPersistence.ts'
    )
    const storeA = createDraftStore()
    await storeA.saveDraft({
      version: 1 as const,
      vaultId: 'vault-a',
      documentId: 'doc',
      documentPath: 'notes/doc',
      content: 'primary',
      baseContentHash: null,
      baseModifiedAt: null,
      createdAt: 10,
      updatedAt: 20,
    })
    // A cross-context record newer than any timestamp context A can
    // mint (now: () => 100): A's first edit saves stale and pins the
    // entry to the conflict channel.
    const storeB = createDraftStore()
    await storeB.saveDraft({
      version: 1 as const,
      vaultId: 'vault-a',
      documentId: 'doc',
      documentPath: 'notes/doc',
      content: 'cross',
      baseContentHash: null,
      baseModifiedAt: null,
      createdAt: 10,
      updatedAt: 500,
    })
    const openRaw = () => new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 2)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const runTx = (
      database: IDBDatabase,
      mutate: (store: IDBObjectStore) => void,
    ) => new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('draftConflicts', 'readwrite')
      mutate(transaction.objectStore('draftConflicts'))
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
    const makeFutureRow = (conflictId: string, documentPath: string) => ({
      version: 2,
      conflictId,
      vaultId: 'vault-a',
      documentId: 'doc',
      documentPath,
      content: 'future data',
      baseContentHash: null,
      baseModifiedAt: null,
      createdAt: 10,
      updatedAt: 25,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 20,
      recordedAt: 25,
    })

    const persistence = createUnsavedDraftPersistence({
      store: storeA,
      now: () => 100,
    })
    persistence.schedule({
      vaultId: 'vault-a',
      documentId: 'doc',
      documentPath: 'notes/doc',
      content: 'edit-1',
      authoritativeContent: 'primary',
      baseContentHash: null,
      baseModifiedAt: null,
      revision: 1,
    })
    await persistence.flush('vault-a', 'doc')

    // A future-version row at the family path makes the draft move
    // unsupported → quarantine{familyPath notes/doc, serverPath
    // archive/doc, conflict PIN kept}.
    const database = await openRaw()
    await runTx(database, (store) => store
      .put(makeFutureRow('conflict-blocker', 'notes/doc')))
    const identity = {
      vaultId: 'vault-a',
      documentId: 'doc',
      documentPath: 'notes/doc',
    }
    const barrier = await persistence.prepareFileMutation([identity])
    const [move] = await barrier.commitMoves([{
      ...identity,
      fromPath: 'notes/doc',
      toPath: 'archive/doc',
    }])
    const finalized = await barrier.finalizeAfterTabMigration()

    // The first stale retry: the CAS comes back 'unsupported' and the
    // PINNED conflict channel writes its candidate at notes/doc —
    // reported clean, quarantine intact.
    persistence.schedule({
      vaultId: 'vault-a',
      documentId: 'doc',
      documentPath: 'archive/doc',
      content: 'after-rename',
      authoritativeContent: 'primary',
      baseContentHash: null,
      baseModifiedAt: null,
      revision: 2,
    })
    const flushed1 = await persistence.flush('vault-a', 'doc')

    // The blocker disappears; context B completes archive/doc→final/doc
    // whole, then a fresh unreadable row at final/doc keeps the next
    // CAS 'unsupported' while the candidate authority still certifies
    // final/doc.
    await runTx(database, (store) => store
      .delete(['vault-a', 'doc', 'conflict-blocker']))
    database.close()
    const movedByB = await storeB.moveDraftFamily('vault-a', 'doc', 'final/doc')
    const database2 = await openRaw()
    await runTx(database2, (store) => store
      .put(makeFutureRow('conflict-blocker-2', 'final/doc')))
    database2.close()

    // The second stale retry: CAS 'unsupported' again, the pinned
    // candidate at the stale oldPath notes/doc meets
    // path-mismatch(final/doc). The pinned quarantine takes the SAME
    // transition as the plain one: stale serverPath discarded,
    // candidate persisted at final/doc, entry pinned to the plain
    // conflict channel there.
    persistence.schedule({
      vaultId: 'vault-a',
      documentId: 'doc',
      documentPath: 'archive/doc',
      content: 'second-edit',
      authoritativeContent: 'primary',
      baseContentHash: null,
      baseModifiedAt: null,
      revision: 3,
    })
    const flushed2 = await persistence.flush('vault-a', 'doc')
    const primary = await storeA.getDraft('vault-a', 'doc')
    const conflicts = await storeA.listConflictDrafts('vault-a')

    // The blocker disappears; the next edit must write on the plain
    // conflict channel at final/doc — a surviving quarantine would
    // re-run the CAS and drag the family to archive/doc.
    const database3 = await openRaw()
    await runTx(database3, (store) => store
      .delete(['vault-a', 'doc', 'conflict-blocker-2']))
    database3.close()
    persistence.schedule({
      vaultId: 'vault-a',
      documentId: 'doc',
      documentPath: 'archive/doc',
      content: 'third-edit',
      authoritativeContent: 'primary',
      baseContentHash: null,
      baseModifiedAt: null,
      revision: 4,
    })
    const flushed3 = await persistence.flush('vault-a', 'doc')

    const rawDatabase = await openRaw()
    const rawTransaction = rawDatabase.transaction(
      ['drafts', 'draftConflicts'],
      'readonly',
    )
    const rawDrafts = await new Promise<unknown[]>((resolve, reject) => {
      const request = rawTransaction.objectStore('drafts').getAll()
      request.onsuccess = () => resolve(request.result as unknown[])
      request.onerror = () => reject(request.error)
    })
    const rawConflicts = await new Promise<unknown[]>((resolve, reject) => {
      const request = rawTransaction.objectStore('draftConflicts')
        .index('vaultId').getAll('vault-a')
      request.onsuccess = () => resolve(request.result as unknown[])
      request.onerror = () => reject(request.error)
    })
    rawDatabase.close()
    await persistence.dispose()

    return {
      moveStatus: move.status,
      finalized,
      flushed1,
      movedByB,
      flushed2,
      primary,
      conflicts,
      flushed3,
      rawDraftPaths: rawDrafts.map((row) => (row as { documentPath: string }).documentPath),
      rawConflictPaths: rawConflicts.map((row) => (row as { documentPath: string }).documentPath),
    }
  }, DATABASE_NAME)

  expect(result.moveStatus).toBe('unsupported')
  // The pinned entry's release write lands its candidate at the
  // family's current path — finalize reports nothing (unlike a
  // move-indeterminate entry, whose blocked write reports failed).
  expect(result.finalized).toEqual([])
  expect(result.flushed1).toBe(true)
  expect(result.movedByB).toMatchObject({ status: 'moved' })
  expect(result.flushed2).toBe(true)
  expect(result.primary).toMatchObject({
    documentPath: 'final/doc',
    content: 'cross',
  })
  expect(result.conflicts).toHaveLength(3)
  expect(result.conflicts.every((c) => c.documentPath === 'final/doc')).toBe(true)
  expect(result.conflicts.some((c) => c.content === 'edit-1')).toBe(true)
  expect(result.conflicts.some((c) => c.content === 'after-rename')).toBe(true)
  expect(result.conflicts.find((c) => c.content === 'second-edit')).toMatchObject({
    documentPath: 'final/doc',
    origin: 'move-conflict',
  })
  expect(result.flushed3).toBe(true)
  expect(result.rawDraftPaths).toEqual(['final/doc'])
  expect(result.rawConflictPaths)
    .toEqual(['final/doc', 'final/doc', 'final/doc', 'final/doc'])
})

// E5/E6: the emptied-family retry against the REAL server. The
// resolver must query the document's current path by stable id (never
// a local cache), and a rename racing the recovery must converge the
// just-written family to the newest server path — or fail closed.
// Both tests run the full stack: real Hono + SQLite + filesystem
// vault, real IndexedDB, real HTTP from inside the page. (A leftover
// document from a previous run is harmless: the POST 409s and the
// rename's replacing-destination move clears the stale target.)
test('an emptied-family retry authenticates against a real server rename that cleared the draft rows', async ({
  page,
}) => {
  // Deterministic reruns: the persistent SQLite metadata database can
  // outlive the /tmp vault files (and a previous run leaves the doc
  // at notes/e5-final), so clear both generations before creating.
  await page.request.delete('/api/posts/notes/e5-doc').catch(() => {})
  await page.request.delete('/api/posts/notes/e5-final').catch(() => {})
  await page.request.post('/api/posts', {
    data: { path: 'notes/e5-doc', title: 'E5' },
  })
  const detail = await (await page.request.get('/api/posts/notes/e5-doc')).json()
  const documentId = (detail as { metadata?: { id: string } }).metadata?.id
  expect(typeof documentId).toBe('string')

  const result = await page.evaluate(async ([databaseName, docId]) => {
    const { createDraftStore } = await import(
      '/src/composables/vault/draft-recovery/draftStore.ts'
    )
    const { createUnsavedDraftPersistence } = await import(
      '/src/composables/vault/draft-recovery/useUnsavedDraftPersistence.ts'
    )
    const { getDocumentMetadataById } = await import('/src/lib/api.ts')

    const resolverCalls: string[] = []
    const store = createDraftStore()
    const persistence = createUnsavedDraftPersistence({
      store,
      now: () => 100,
      // The production resolver shape: the server's current path for
      // the stable identity, with a version token.
      resolveCurrentDocumentPath: async (_vaultId, documentId) => {
        resolverCalls.push(documentId)
        const metadata = await getDocumentMetadataById(documentId)
        return metadata
          ? { path: metadata.path, version: metadata.updatedAt }
          : null
      },
    })

    // Drive the entry to an EMPTIED move-indeterminate family in real
    // IndexedDB: an unreadable future-version row splits the family so
    // the rename's draft move is 'unsupported', then every row of the
    // identity disappears — the next probe reports 'none'.
    const openRaw = () => new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 2)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const runTx = (
      database: IDBDatabase,
      mutate: (store: IDBObjectStore) => void,
    ) => new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('draftConflicts', 'readwrite')
      mutate(transaction.objectStore('draftConflicts'))
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
    // The readable conflict row first: the store operation creates
    // the production database schema, which openRaw below then opens
    // at the same version to plant the unreadable row.
    await store.saveConflictDraft({
      version: 1 as const,
      conflictId: 'valid-row',
      vaultId: 'vault-e5',
      documentId: docId,
      documentPath: 'legacy/a',
      content: 'older local',
      baseContentHash: null,
      baseModifiedAt: null,
      createdAt: 10,
      updatedAt: 15,
      origin: 'delete-conflict' as const,
      crossContextUpdatedAt: null,
      recordedAt: 15,
    })
    const database = await openRaw()
    await runTx(database, (store) => store.put({
      version: 2,
      conflictId: 'bad-row',
      vaultId: 'vault-e5',
      documentId: docId,
      documentPath: 'archive/a',
      content: 'unreadable',
      baseContentHash: null,
      baseModifiedAt: null,
      createdAt: 10,
      updatedAt: 25,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 20,
      recordedAt: 25,
    }))
    database.close()
    const identity = {
      vaultId: 'vault-e5',
      documentId: docId,
      documentPath: 'notes/a',
    }
    persistence.schedule({
      vaultId: 'vault-e5',
      documentId: docId,
      documentPath: 'notes/a',
      content: 'stale-edit',
      authoritativeContent: '',
      baseContentHash: null,
      baseModifiedAt: null,
      revision: 1,
    })
    await persistence.flush('vault-e5', docId)
    const barrier = await persistence.prepareFileMutation([identity])
    const [move] = await barrier.commitMoves([{
      ...identity,
      fromPath: 'notes/a',
      toPath: 'archive/b',
    }])
    await barrier.finalizeAfterTabMigration()
    persistence.schedule({
      vaultId: 'vault-e5',
      documentId: docId,
      documentPath: 'archive/b',
      content: 'after-rename',
      authoritativeContent: '',
      baseContentHash: null,
      baseModifiedAt: null,
      revision: 2,
    })
    const flushed1 = await persistence.flush('vault-e5', docId)

    // The whole identity disappears, then ANOTHER WINDOW renames the
    // real server document (notes/e5-doc → notes/e5-final). Its draft
    // move sees no rows at all — exactly the race under test.
    const database2 = await openRaw()
    await runTx(database2, (store) => store
      .delete(['vault-e5', docId, 'bad-row']))
    database2.close()
    await store.deleteConflictDraft('vault-e5', docId, 'valid-row')
    const renamed = await fetch('/api/posts/notes/e5-doc', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetPath: 'notes/e5-final' }),
    })

    // A second IndexedDB context wins the first-mint race at another
    // path, and the local candidate transaction fails once. Recovery
    // must retain its conflict channel: the next flush moves the whole
    // family to the real server path and retries the local bytes as a
    // candidate, never as a primary overwrite.
    const remoteStore = createDraftStore()
    const originalSaveDraft = store.saveDraft.bind(store)
    const originalSaveCandidate = store.saveConflictCandidate.bind(store)
    let racedPrimary = false
    let failedCandidate = false
    store.saveDraft = async (value) => {
      if (!racedPrimary) {
        racedPrimary = true
        await remoteStore.saveDraft({
          ...value,
          documentPath: 'notes/e5-race',
          content: 'remote-primary',
          updatedAt: 1_000,
        })
      }
      return originalSaveDraft(value)
    }
    store.saveConflictCandidate = async (value) => {
      if (!failedCandidate) {
        failedCandidate = true
        return { status: 'failed' as const }
      }
      return originalSaveCandidate(value)
    }

    const flushed2 = await persistence.flush('vault-e5', docId)
    const flushed3 = await persistence.flush('vault-e5', docId)
    const primary = await store.getDraft('vault-e5', docId)
    const conflicts = await store.listConflictDrafts('vault-e5')

    const rawDatabase = await openRaw()
    const rawTransaction = rawDatabase.transaction(
      ['drafts', 'draftConflicts'],
      'readonly',
    )
    const rawDrafts = await new Promise<unknown[]>((resolve, reject) => {
      const request = rawTransaction.objectStore('drafts').getAll()
      request.onsuccess = () => resolve(request.result as unknown[])
      request.onerror = () => reject(request.error)
    })
    const rawConflicts = await new Promise<unknown[]>((resolve, reject) => {
      const request = rawTransaction.objectStore('draftConflicts')
        .index('vaultId').getAll('vault-e5')
      request.onsuccess = () => resolve(request.result as unknown[])
      request.onerror = () => reject(request.error)
    })
    rawDatabase.close()
    await persistence.dispose()

    return {
      moveStatus: move.status,
      flushed1,
      renameStatus: renamed.status,
      flushed2,
      flushed3,
      primary,
      conflicts,
      resolverCallCount: resolverCalls.length,
      resolverIdentities: [...new Set(resolverCalls)],
      rawDraftPaths: rawDrafts.map((row) => (row as { documentPath: string }).documentPath),
      rawConflictPaths: rawConflicts.map((row) => (row as { documentPath: string }).documentPath),
    }
  }, [DATABASE_NAME, documentId] as [string, string])

  expect(result.moveStatus).toBe('unsupported')
  expect(result.flushed1).toBe(false)
  expect(result.renameStatus).toBe(200)
  expect(result.flushed2).toBe(false)
  expect(result.flushed3).toBe(true)
  expect(result.primary).toMatchObject({
    documentPath: 'notes/e5-final',
    content: 'remote-primary',
  })
  expect(result.conflicts).toEqual([
    expect.objectContaining({
      documentPath: 'notes/e5-final',
      content: 'after-rename',
    }),
  ])
  // The resolver ran at least twice: the pre-write resolve AND the
  // post-write server revalidation.
  expect(result.resolverCallCount).toBeGreaterThanOrEqual(2)
  expect(result.resolverIdentities).toEqual([documentId])
  expect(result.rawDraftPaths).toEqual(['notes/e5-final'])
  expect(result.rawConflictPaths).toEqual(['notes/e5-final'])
})

test('an emptied-family retry converges when another window renames between the resolve and the revalidation', async ({
  page,
}) => {
  await page.request.delete('/api/posts/notes/e6-doc').catch(() => {})
  await page.request.delete('/api/posts/notes/e6-final').catch(() => {})
  await page.request.post('/api/posts', {
    data: { path: 'notes/e6-doc', title: 'E6' },
  })
  const detail = await (await page.request.get('/api/posts/notes/e6-doc')).json()
  const documentId = (detail as { metadata?: { id: string } }).metadata?.id
  expect(typeof documentId).toBe('string')

  const result = await page.evaluate(async ([databaseName, docId]) => {
    const { createDraftStore } = await import(
      '/src/composables/vault/draft-recovery/draftStore.ts'
    )
    const { createUnsavedDraftPersistence } = await import(
      '/src/composables/vault/draft-recovery/useUnsavedDraftPersistence.ts'
    )
    const { getDocumentMetadataById } = await import('/src/lib/api.ts')

    let resolverCallCount = 0
    const store = createDraftStore()
    const persistence = createUnsavedDraftPersistence({
      store,
      now: () => 100,
      resolveCurrentDocumentPath: async (_vaultId, documentId) => {
        resolverCallCount += 1
        if (resolverCallCount === 2) {
          // The revalidation query ITSELF races another window's real
          // server rename: the primary was just minted at
          // notes/e6-doc, the server moves to notes/e6-final before this
          // query answers. A rejected rename must fail the resolver
          // loudly — silently skipping it would converge at the old
          // path and mask the harness problem.
          const renamed = await fetch('/api/posts/notes/e6-doc', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ targetPath: 'notes/e6-final' }),
          })
          if (!renamed.ok) {
            throw new Error(`racing rename failed: ${renamed.status}`)
          }
        }
        const metadata = await getDocumentMetadataById(documentId)
        return metadata
          ? { path: metadata.path, version: metadata.updatedAt }
          : null
      },
    })

    const openRaw = () => new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 2)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const runTx = (
      database: IDBDatabase,
      mutate: (store: IDBObjectStore) => void,
    ) => new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('draftConflicts', 'readwrite')
      mutate(transaction.objectStore('draftConflicts'))
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
    // The readable conflict row first: the store operation creates
    // the production database schema, which openRaw below then opens
    // at the same version to plant the unreadable row.
    await store.saveConflictDraft({
      version: 1 as const,
      conflictId: 'valid-row',
      vaultId: 'vault-e6',
      documentId: docId,
      documentPath: 'legacy/a',
      content: 'older local',
      baseContentHash: null,
      baseModifiedAt: null,
      createdAt: 10,
      updatedAt: 15,
      origin: 'delete-conflict' as const,
      crossContextUpdatedAt: null,
      recordedAt: 15,
    })
    const database = await openRaw()
    await runTx(database, (store) => store.put({
      version: 2,
      conflictId: 'bad-row',
      vaultId: 'vault-e6',
      documentId: docId,
      documentPath: 'archive/a',
      content: 'unreadable',
      baseContentHash: null,
      baseModifiedAt: null,
      createdAt: 10,
      updatedAt: 25,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 20,
      recordedAt: 25,
    }))
    database.close()
    const identity = {
      vaultId: 'vault-e6',
      documentId: docId,
      documentPath: 'notes/a',
    }
    persistence.schedule({
      vaultId: 'vault-e6',
      documentId: docId,
      documentPath: 'notes/a',
      content: 'stale-edit',
      authoritativeContent: '',
      baseContentHash: null,
      baseModifiedAt: null,
      revision: 1,
    })
    await persistence.flush('vault-e6', docId)
    const barrier = await persistence.prepareFileMutation([identity])
    const [move] = await barrier.commitMoves([{
      ...identity,
      fromPath: 'notes/a',
      toPath: 'archive/b',
    }])
    await barrier.finalizeAfterTabMigration()
    persistence.schedule({
      vaultId: 'vault-e6',
      documentId: docId,
      documentPath: 'archive/b',
      content: 'after-rename',
      authoritativeContent: '',
      baseContentHash: null,
      baseModifiedAt: null,
      revision: 2,
    })
    await persistence.flush('vault-e6', docId)
    const database2 = await openRaw()
    await runTx(database2, (store) => store
      .delete(['vault-e6', docId, 'bad-row']))
    database2.close()
    await store.deleteConflictDraft('vault-e6', docId, 'valid-row')

    // The flush's resolver mints at notes/e6-doc, then its OWN second
    // query (the revalidation) performs the real rename and sees
    // notes/e6-final: the expected-path CAS must move the just-written
    // primary to notes/e6-final and the final revalidation must
    // authenticate it there.
    const flushed = await persistence.flush('vault-e6', docId)
    const primary = await store.getDraft('vault-e6', docId)

    const rawDatabase = await openRaw()
    const rawTransaction = rawDatabase.transaction(['drafts'], 'readonly')
    const rawDrafts = await new Promise<unknown[]>((resolve, reject) => {
      const request = rawTransaction.objectStore('drafts').getAll()
      request.onsuccess = () => resolve(request.result as unknown[])
      request.onerror = () => reject(request.error)
    })
    rawDatabase.close()
    await persistence.dispose()

    return {
      moveStatus: move.status,
      flushed,
      resolverCallCount,
      primary,
      rawDraftPaths: rawDrafts.map((row) => (row as { documentPath: string }).documentPath),
    }
  }, [DATABASE_NAME, documentId] as [string, string])

  expect(result.moveStatus).toBe('unsupported')
  expect(result.flushed).toBe(true)
  // resolve (notes/e6-doc) + racing revalidation (notes/e6-final) +
  // final revalidation.
  expect(result.resolverCallCount).toBe(3)
  // No primary remains at notes/e6-doc; the family converged to the
  // server's newest path and the latest bytes are recoverable there.
  expect(result.primary).toMatchObject({
    documentPath: 'notes/e6-final',
    content: 'after-rename',
  })
  expect(result.rawDraftPaths).toEqual(['notes/e6-final'])
  // The real server file follows the same identity.
  const serverFinal = await page.request.get('/api/posts/notes/e6-final')
  expect(serverFinal.ok()).toBe(true)
})

/* ---------- Edit-09 Final Closure end-to-end scenarios ----------
 * These run the REAL application UI on the draft-store origin: real
 * server, real vault directory on disk, real IndexedDB. They close the
 * UI-level gaps the composable/store suites cannot reach: editor buffer
 * adoption after a hard restart, divergent prompt + diff, workspace
 * coexistence, and the blocked-upgrade startup UX.
 */

async function openTreeDocument(
  page: import('@playwright/test').Page,
  title: string,
  path: string,
) {
  // Click the filename button itself, matched by its EXACT aria-label
  // ("Title, path"): an ancestor `.tree-row.folder` contains every child
  // row's markup, so any row-level filter + .first() resolves to the
  // FOLDER row and the click opens whichever document its center lands
  // on. The button's aria-label is unique per document.
  const button = page.locator(`button[aria-label="${title}, ${path}"]`)
  if (await button.count() === 0) {
    await page.locator('.tree-row.folder').filter({ hasText: 'inbox' }).first()
      .locator('.chevron').click()
  }
  await button.waitFor({ state: 'visible', timeout: 10_000 })
  await button.click()
}

async function focusMonacoEditor(page: import('@playwright/test').Page) {
  // Scoped to the document editor surface: read-only recovery/history
  // viewers can host Monaco instances too, but only the document pane
  // (`.editor-pane`) accepts typed edits.
  const editor = page.locator('.editor-pane .monaco-editor')
  await editor.waitFor({ state: 'visible', timeout: 10_000 })
  // Same pointer-surface focus pattern as the view-mode suite: focusing
  // the ARIA mirror textbox alone does not activate Monaco's keybindings.
  await editor.locator('.view-lines').click({ position: { x: 40, y: 12 } })
  await expect(editor).toHaveClass(/focused/)
  return editor
}

// Drives the genuine edit → draft persistence chain: Monaco keystrokes →
// per-document debounce → a real IndexedDB draft row under the document's
// STABLE identity (not its path). The server autosave (an independent
// 800ms debounce) is held at the network layer to model the only
// situation in which a browser draft can outlive the editing session:
// a crash or offline window before autosave completes. Without the hold
// the two debounces finish within ~1s of each other and markClean()
// removes the draft again, leaving nothing to recover.
async function typeAndAwaitDraft(
  page: import('@playwright/test').Page,
  path: string,
  title: string,
  line: string,
) {
  await page.route('**/api/posts/**', (route) =>
    route.request().method() === 'PUT' ? route.abort() : route.continue())
  await page.request.post('/api/posts', { data: { path, title } })
  await page.goto('/vault')
  await openTreeDocument(page, title, path)
  const editor = await focusMonacoEditor(page)
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type(line)
  await expect(editor.locator('.view-lines')).toContainText(line)
  // Poll the store with a raw IndexedDB read (no shared-module import):
  // the row only exists while the server save stays held.
  await expect.poll(() => page.evaluate((target) => new Promise<boolean>((resolve) => {
    const request = indexedDB.open(target.databaseName)
    const fail = () => resolve(false)
    request.onsuccess = () => {
      const db = request.result
      try {
        const all = db.transaction('drafts', 'readonly').objectStore('drafts').getAll()
        all.onsuccess = () => {
          resolve((all.result as Array<{ content?: string }>).some(
            (row) => row.content?.includes(target.line) ?? false,
          ))
          db.close()
        }
        all.onerror = () => { db.close(); fail() }
      } catch {
        db.close()
        fail()
      }
    }
    request.onerror = fail
    request.onblocked = fail
  }), { databaseName: DATABASE_NAME, line }), { timeout: 10_000 }).toBe(true)
}

test('E2E-1: a hard restart adopts a baseline-matching autosaved draft without saving the server file', async ({
  page,
}) => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const path = `inbox/e2e-adopt-${suffix}`
  const line = `Unsaved closure line ${suffix}`
  await typeAndAwaitDraft(page, path, `Adopt Closure ${suffix}`, line)

  // A fresh app boot (the product equivalent of crash → reopen): startup
  // discovery must classify the draft as baseline-match and adopt it into
  // the dirty editor buffer — WITHOUT calling the server Save API and
  // WITHOUT raising the prompt (baseline-match never reaches the prompt).
  await page.goto('/vault')
  await expect(page.locator('.editor-pane .monaco-editor .view-lines'))
    .toContainText(line, { timeout: 15_000 })
  await expect(page.locator('.draft-recovery-backdrop')).toHaveCount(0)
  const disk = await fs.readFile(`${VAULT_DIR}/${path}.md`, 'utf8')
  expect(disk).not.toContain(line)
})

test('E2E-2: an external disk change makes the draft divergent and offers a diff instead of auto-adoption', async ({
  page,
}) => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const path = `inbox/e2e-divergent-${suffix}`
  const draftLine = `Draft line ${suffix}`
  const externalLine = `External edit line ${suffix}`
  await typeAndAwaitDraft(page, path, `Divergent Closure ${suffix}`, draftLine)

  // The authoritative Markdown file changes OUTSIDE Nuvyn after the
  // baseline was captured (another editor, git pull, …).
  await fs.appendFile(`${VAULT_DIR}/${path}.md`, `\n${externalLine}\n`)

  // Fresh boot: divergent records are never auto-adopted — the prompt
  // surfaces them for an explicit decision, with a diff of both sides.
  await page.goto('/vault')
  const dialog = page.locator('.draft-recovery-dialog')
  await expect(dialog).toBeVisible({ timeout: 15_000 })
  await expect(dialog).toContainText(path)
  await expect(dialog).toContainText('The draft and disk version may both have changed.')
  await dialog.getByRole('button', { name: 'View Diff' }).click()

  const pane = page.locator('.draft-recovery-pane')
  await expect(pane).toBeVisible()
  await expect(pane).toContainText(draftLine)
  await expect(pane).toContainText(externalLine)
})

test('E2E-5: two concurrent contexts route a stale write to the candidate channel without overwriting the primary', async ({
  page,
}) => {
  // Two independent persistence channels (two live IndexedDB contexts)
  // edit the SAME identity from the SAME baseline. Context A's clock
  // leads, so its write is the certified primary; context B's lagging
  // write comes back stale at the store and the production state machine
  // must promote it to a conflict candidate — never re-mint a fresher
  // timestamp and bury A's record — and every later B edit must stay on
  // the candidate channel.
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const result = await page.evaluate(async (suffix) => {
    const { createDraftStore } = await import(
      '/src/composables/vault/draft-recovery/draftStore.ts'
    )
    const { createUnsavedDraftPersistence } = await import(
      '/src/composables/vault/draft-recovery/useUnsavedDraftPersistence.ts'
    )
    const vaultId = 'vault'
    const documentId = `e5-${suffix}`
    const path = `inbox/e2e-concurrent-${suffix}`
    const snapshot = (content: string, revision: number) => ({
      vaultId,
      documentId,
      documentPath: path,
      content,
      authoritativeContent: 'shared disk baseline',
      baseContentHash: 'baseline-hash',
      baseModifiedAt: 10,
      revision,
    })

    const contextA = createUnsavedDraftPersistence({ now: () => 1000 })
    contextA.schedule(snapshot(`body A ${suffix}`, 1))
    const aPersisted = await contextA.flush(vaultId, documentId)

    const contextB = createUnsavedDraftPersistence({ now: () => 900 })
    contextB.schedule(snapshot(`body B ${suffix}`, 1))
    const bPersisted = await contextB.flush(vaultId, documentId)

    const observer = createDraftStore()
    const afterFirstWrites = await observer.inspectVaultRecovery(vaultId)

    // A further edit in context B must stay on the candidate channel.
    contextB.schedule(snapshot(`body B2 ${suffix}`, 2))
    const b2Persisted = await contextB.flush(vaultId, documentId)
    const afterSecondEdit = await observer.inspectVaultRecovery(vaultId)

    return {
      aPersisted,
      bPersisted,
      b2Persisted,
      firstPrimaryContent: afterFirstWrites.inventory.primary[0]?.content ?? null,
      firstPrimaryUpdatedAt: afterFirstWrites.inventory.primary[0]?.updatedAt ?? null,
      firstConflicts: afterFirstWrites.inventory.conflicts.map((record) => ({
        content: record.content,
        crossContextUpdatedAt: record.crossContextUpdatedAt,
      })),
      primaryContent: afterSecondEdit.inventory.primary[0]?.content ?? null,
      primaryUpdatedAt: afterSecondEdit.inventory.primary[0]?.updatedAt ?? null,
      conflictContents: afterSecondEdit.inventory.conflicts.map((record) => record.content),
    }
  }, suffix)

  expect(result.aPersisted).toBe(true)
  // B's stale write survives, but NOT as the primary record.
  expect(result.bPersisted).toBe(false)
  expect(result.firstPrimaryContent).toContain(`body A ${suffix}`)
  expect(result.firstConflicts).toHaveLength(1)
  expect(result.firstConflicts[0]?.content).toContain(`body B ${suffix}`)
  // The candidate records the exact primary it diverged from.
  expect(result.firstConflicts[0]?.crossContextUpdatedAt).toBe(result.firstPrimaryUpdatedAt)
  // B's next edit stays on the candidate channel; the certified primary
  // is untouched — same body AND same updatedAt, never re-minted.
  expect(result.b2Persisted).toBe(true)
  expect(result.primaryContent).toContain(`body A ${suffix}`)
  expect(result.primaryUpdatedAt).toBe(result.firstPrimaryUpdatedAt)
  expect(result.conflictContents.some((content) => content.includes(`body B2 ${suffix}`))).toBe(true)
})

test('E2E-7: a record another context replaces after safe-redundant classification survives cleanup', async ({
  page,
}) => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const result = await page.evaluate(async (suffix) => {
    const api = await import('/src/lib/api.ts')
    const { createDraftStore } = await import(
      '/src/composables/vault/draft-recovery/draftStore.ts'
    )
    const { createUnsavedDraftRecovery } = await import(
      '/src/composables/vault/draft-recovery/useUnsavedDraftRecovery.ts'
    )
    const { createDraftRecoveryManagement } = await import(
      '/src/composables/vault/draft-recovery/useDraftRecoveryManagement.ts'
    )

    const path = `inbox/e2e-r2-${suffix}`
    await api.createPost({ path, title: 'R2 Closure' })
    const post = await api.getPost(path)
    const documentId = post.metadata.id
    const store = createDraftStore()
    // R1 is byte-identical to disk under the SAME stable identity, so
    // classification certifies it safe-redundant for cleanup.
    const r1 = {
      version: 1 as const,
      vaultId: 'vault',
      documentId,
      documentPath: path,
      content: post.raw,
      baseContentHash: null,
      baseModifiedAt: null,
      createdAt: 10,
      updatedAt: 10,
    }
    await store.saveDraft(r1)
    const recovery = createUnsavedDraftRecovery({ store })
    const management = createDraftRecoveryManagement({
      store,
      recovery,
      getPersistenceProtection: () => ({ identityIds: new Set() }),
      now: () => Date.now() + 31 * 24 * 60 * 60 * 1000,
    })
    await recovery.discover('vault')
    await management.refresh('vault')
    const certifiedStatus = recovery.items.value[0]?.status ?? null

    // Another context replaces the family record under the same identity
    // (newer updatedAt, new body) AFTER the verdict was certified.
    const otherContext = createDraftStore()
    await otherContext.saveDraft({
      ...r1,
      content: `${post.raw}\nnewer unsaved body ${suffix}`,
      updatedAt: 20,
    })

    const report = await management.cleanupNow()
    const survivor = await store.getDraft('vault', documentId)
    return {
      certifiedStatus,
      status: report.status,
      deleted: report.deleted.length,
      survivor: survivor?.content ?? null,
    }
  }, suffix)

  expect(result.certifiedStatus).toBe('ready')
  expect(result.status).toBe('completed')
  // The certified verdict belonged to R1: the cleanup's fresh Store scan
  // inspected R2, which no verdict covers — it must survive until a new
  // classification certifies it.
  expect(result.deleted).toBe(0)
  expect(result.survivor).toContain(`newer unsaved body ${suffix}`)
})

test('E2E-8: external delete and path reuse remain identity-mismatched', async ({
  page,
}) => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const path = `inbox/e2e-reuse-${suffix}`
  const draftLine = `Unsaved line ${suffix}`
  // Document A: type a draft and hold the server Save API so the draft
  // stays in IndexedDB (normal autosave would markClean it in ~1s).
  await typeAndAwaitDraft(page, path, `Reuse Closure A ${suffix}`, draftLine)
  const file = `${VAULT_DIR}/${path}.md`
  const aDraftBody = `# Reuse Closure A ${suffix}\n\n${draftLine}`

  // External delete of A (no API call — the file vanishes behind the
  // app's back), then a NEW document B takes over the same path. The
  // create route drops the stale metadata row first and mints a fresh
  // randomUUID identity, so B's documentId differs from the identity
  // the draft was recorded under.
  await fs.unlink(file)
  await page.waitForTimeout(1200) // let any pending (aborted) autosave fire
  await page.unroute('**/api/posts/**')
  await page.request.post('/api/posts', { data: { path, title: `Reuse Closure B ${suffix}` } })
  // Make B's disk body BYTE-IDENTICAL to A's draft body: a naive
  // byte-equality cleanup would call this redundant — the differing
  // stable identity must keep it identity-mismatched instead.
  await fs.writeFile(file, aDraftBody, 'utf8')

  await page.goto('/vault')

  // No auto-adoption: the draft never flows into B. The prompt shows
  // the identity-mismatch verdict for A's orphaned draft.
  const dialog = page.locator('.draft-recovery-dialog')
  await expect(dialog).toBeVisible({ timeout: 15_000 })
  await expect(dialog.locator('.draft-recovery-path')).toHaveText(path)
  await expect(dialog).toContainText('The original path now belongs to another document.')
  // (A persisted tab for the path may legitimately open B's CURRENT disk
  // bytes here — that is the normal load of the reused path, not an
  // adoption of A's draft. "No auto-adoption" is proven below by the
  // prompt above plus the byte-exact, unwritten disk file.)

  // The draft row survives startup cleanup even though its body equals
  // B's disk bytes — identity-mismatch is never safe-redundant.
  const stored = await page.evaluate((target) => new Promise<{
    draftId: string | null
    diskId: string | null
    draftSurvives: boolean
  }>((resolve) => {
    const fail = () => resolve({ draftId: null, diskId: null, draftSurvives: false })
    const request = indexedDB.open(target.databaseName)
    request.onsuccess = async () => {
      const db = request.result
      try {
        const all = db.transaction('drafts', 'readonly').objectStore('drafts').getAll()
        all.onsuccess = async () => {
          const row = (all.result as Array<{ documentId?: string; content?: string }>)
            .find((candidate) => candidate.content?.includes(target.line) ?? false)
          const diskId = await fetch(`/api/posts/${target.path}`)
            .then((response) => response.json())
            .then((post: { metadata?: { id?: string } }) => post.metadata?.id ?? null)
            .catch(() => null)
          resolve({
            draftId: row?.documentId ?? null,
            diskId,
            draftSurvives: row !== undefined,
          })
          db.close()
        }
        all.onerror = () => { db.close(); fail() }
      } catch { db.close(); fail() }
    }
    request.onerror = fail
    request.onblocked = fail
  }), { databaseName: DATABASE_NAME, line: draftLine, path })

  expect(stored.draftSurvives).toBe(true)
  expect(stored.draftId).not.toBeNull()
  // B owns the path under a DIFFERENT stable identity.
  expect(stored.diskId).not.toBeNull()
  expect(stored.diskId).not.toBe(stored.draftId)
  // B's formal markdown is byte-exact: nothing adopted, nothing cleaned.
  expect(await fs.readFile(file, 'utf8')).toBe(aDraftBody)
})

test('E2E-9: document and recovery viewers coexist without cross-saving', async ({
  page,
}) => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const path = `inbox/e2e-coexist-${suffix}`
  const draftLine = `Draft line ${suffix}`
  const externalLine = `External edit line ${suffix}`
  const documentEdit = `Document edit ${suffix}`
  await typeAndAwaitDraft(page, path, `Coexist Closure ${suffix}`, draftLine)
  const file = `${VAULT_DIR}/${path}.md`
  await fs.appendFile(file, `\n${externalLine}\n`)

  // Open the divergent recovery viewer (diff) …
  await page.goto('/vault')
  const dialog = page.locator('.draft-recovery-dialog')
  await expect(dialog).toBeVisible({ timeout: 15_000 })
  await dialog.getByRole('button', { name: 'View Diff' }).click()
  await expect(page.locator('.draft-recovery-pane')).toBeVisible()
  // Re-enable the server Save API: the negative disk assertion below must
  // prove the Ctrl+S shortcut was isolated, not merely that the network
  // hold from the setup phase is still swallowing saves.
  await page.unroute('**/api/posts/**')

  // … then the formal document ALONGSIDE it: two workspace tab kinds
  // coexist in one stable tab strip.
  await openTreeDocument(page, `Coexist Closure ${suffix}`, path)
  await expect(page.locator('.editor-pane .monaco-editor')).toBeVisible()
  const tabs = page.locator('.tabs .tab')
  await expect(tabs).toHaveCount(2)
  await expect(tabs.filter({ hasText: 'Recovered:' })).toHaveCount(1)

  // Make the document buffer dirty, then press Ctrl+S while the READ-ONLY
  // recovery viewer has focus: the document Save pipeline must not fire.
  await focusMonacoEditor(page)
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type(documentEdit)
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(documentEdit)
  // Activate the recovery tab (document tab is active after openTreeDocument):
  // the pane is v-show-hidden until its workspace tab is selected.
  await tabs.filter({ hasText: 'Recovered:' }).click()
  await expect(page.locator('.draft-recovery-pane .history-viewer-heading')).toBeVisible()
  await page.locator('.draft-recovery-pane .history-viewer-heading').click()
  await page.keyboard.press('Control+s')
  // A wrongful Ctrl+S saves immediately; the legitimate autosave debounce
  // is 800ms from the last keystroke. 400ms sits safely between the two:
  // long enough for a leaked save to have landed, before autosave fires.
  await page.waitForTimeout(400)
  const disk = await fs.readFile(file, 'utf8')
  expect(disk).not.toContain(documentEdit)
  expect(disk).toContain(externalLine)

  // Closing the recovery viewer leaves the document tab fully intact.
  await tabs.filter({ hasText: 'Recovered:' }).locator('.tab-close').click()
  await expect(tabs).toHaveCount(1)
  await expect(page.locator('.editor-pane .monaco-editor')).toBeVisible()
  await expect(page.locator('.editor-pane .monaco-editor .view-lines')).toContainText(documentEdit)
})

test('E2E-10: a blocked upgrade preserves seeded records and recovers into adoption after the blocker closes', async ({
  page,
  context,
}) => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const path = `inbox/e2e-blocked-${suffix}`
  const seededLine = `Unsaved line from the old version ${suffix}`
  await page.request.post('/api/posts', {
    data: { path, title: `Blocked Closure ${suffix}` },
  })

  // Leave the SPA immediately so the beforeEach '/' boot can never open
  // the database under the upcoming hold: IndexedDB delivers 'blocked'
  // only to the FIRST upgrade attempt, and this page must be that first
  // attempt (exactly the production shape of opening a new Nuvyn tab
  // while an old one still holds the old-version connection).
  await page.goto('/src/main.ts')
  // Another Nuvyn page holds an OLD-VERSION connection: it mints the
  // database at v1 WITH a drafts store holding one valid old-version
  // draft for the real document above (the unsaved bytes a tab on the
  // previous schema would still hold open), and keeps the connection
  // open, so the app's v2 upgrade blocks. '/src/main.ts' serves the
  // module source as text on the same origin: the blocker has working
  // IndexedDB but never boots the SPA.
  const blocker = await context.newPage()
  await blocker.goto('/src/main.ts')
  await blocker.evaluate(async (target) => {
    const { hashDraftBaseline } = await import(
      '/src/composables/vault/draft-recovery/draftHash.ts'
    )
    const identity = await (await fetch('/api/vault/identity')).json() as { vaultId: string }
    const post = await (await fetch(`/api/posts/${target.path}`)).json() as {
      raw: string
      mtime: number
      metadata: { id: string }
    }
    // A baseline-match draft: its baseline hash certifies against the
    // disk bytes, so after the upgrade it must flow into adoption.
    const oldDraft = {
      version: 1,
      vaultId: identity.vaultId,
      documentId: post.metadata.id,
      documentPath: target.path,
      content: `${post.raw}\n${target.seededLine}`,
      baseContentHash: await hashDraftBaseline(post.raw),
      baseModifiedAt: post.mtime,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(target.databaseName)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error('blocker delete blocked'))
    })
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(target.databaseName, 1)
      request.onupgradeneeded = () => {
        request.result
          .createObjectStore('drafts', { keyPath: ['vaultId', 'documentId'] })
          .put(oldDraft)
      }
      request.onsuccess = () => {
        ;(window as unknown as { heldV1: IDBDatabase }).heldV1 = request.result
        resolve()
      }
      request.onerror = () => reject(request.error)
    })
  }, { databaseName: DATABASE_NAME, path, seededLine })

  // Boot the app under the blocked upgrade — the first upgrade attempt.
  await page.goto('/vault')

  // Frozen 13a43ab contract for startup under a blocked upgrade: the
  // workspace stays entirely normal. The first open rejects with
  // 'upgrade-blocked' (verified in draftStore's openDatabase + the
  // Center/management unit tests), while the startup refresh awaits a
  // fresh connection that queues silently behind the blocker until it
  // closes — so startup shows NO toast and switches NO panel. Recovery
  // stays invisible; the user keeps editing. (The once-per-session
  // startup warning for this case is the deferred sessionStorage
  // proposal recorded in the Final Closure residual list.)
  await expect(page.locator('.tree-row').first()).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.toast-host .toast')).toHaveCount(0)
  await expect(page.locator('.recovery-center')).toHaveCount(0)
  await expect(page.locator('.draft-recovery-backdrop')).toHaveCount(0)
  await expect(page.locator('.activity-bar .ab-btn[aria-pressed="true"]'))
    .toHaveAttribute('aria-label', /Explorer/)

  // Closing the old page releases the v1 connection: the app's silently
  // queued v2 open now runs the upgrade. Hold the Save API before any
  // adoption can autosave, so the negative disk assertion below proves
  // adoption flows through the editor, never a direct disk write.
  await blocker.close()
  await page.route('**/api/posts/**', (route) =>
    route.request().method() === 'PUT' ? route.abort() : route.continue())

  // The seeded old-version record survives BOTH the blocked upgrade and
  // the upgrade that then completes (raw IndexedDB proof, read through
  // a connection that queues behind the pending versionchange).
  await expect.poll(() => page.evaluate((target) => new Promise<{
    version: number
    seeded: boolean
  }>((resolve) => {
    const request = indexedDB.open(target.databaseName)
    const timer = setTimeout(
      () => resolve({ version: -1, seeded: false }),
      2500,
    )
    request.onsuccess = () => {
      clearTimeout(timer)
      const db = request.result
      const version = db.version
      try {
        const all = db.transaction('drafts', 'readonly').objectStore('drafts').getAll()
        all.onsuccess = () => {
          resolve({
            version,
            seeded: (all.result as Array<{ content?: string }>).some(
              (row) => row.content?.includes(target.seededLine) ?? false,
            ),
          })
          db.close()
        }
        all.onerror = () => { resolve({ version, seeded: false }); db.close() }
      } catch {
        resolve({ version, seeded: false })
        db.close()
      }
    }
    request.onerror = () => { clearTimeout(timer); resolve({ version: -1, seeded: false }) }
    request.onblocked = () => { clearTimeout(timer); resolve({ version: -1, seeded: false }) }
  }), { databaseName: DATABASE_NAME, seededLine }), { timeout: 15_000 })
    .toEqual({ version: 2, seeded: true })

  // The user's retry (reload) then recovers the surviving record all the
  // way into adoption: the draft opens in the editor, the disk is never
  // written directly, and startup stays warning-free.
  await page.reload()
  await expect(page.locator('.editor-pane .monaco-editor .view-lines'))
    .toContainText(seededLine, { timeout: 15_000 })
  await expect(page.locator('.draft-recovery-backdrop')).toHaveCount(0)
  await expect(page.locator('.toast-host .toast')).toHaveCount(0)
  const disk = await fs.readFile(`${VAULT_DIR}/${path}.md`, 'utf8')
  expect(disk).not.toContain(seededLine)
})

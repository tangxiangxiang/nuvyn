import { expect, test } from './fixtures/auth'

const DATABASE_NAME = 'nuvyn-draft-recovery'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(async (databaseName) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(databaseName)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error('Draft database deletion blocked'))
    })
  }, DATABASE_NAME)
})

test('moves a persisted draft to the actual server path without changing its bytes or timestamps', async ({
  page,
}) => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const result = await page.evaluate(async (suffix) => {
    const { createDraftStore } = await import(
      '/src/composables/vault/draft-recovery/draftStore.ts'
    )
    const { createUnsavedDraftPersistence } = await import(
      '/src/composables/vault/draft-recovery/useUnsavedDraftPersistence.ts'
    )
    const { useDocumentLifecycle } = await import(
      '/src/composables/vault/useDocumentLifecycle.ts'
    )
    const { createPathMutationLock } = await import(
      '/src/composables/vault/pathMutationLock.ts'
    )
    const { createVaultFileChanges } = await import(
      '/src/composables/vault/context/fileChanges.ts'
    )
    const api = await import('/src/lib/api.ts')
    const sourcePath = `inbox/draft-e2e-${suffix}`
    const targetSeedPath = `inbox/draft-e2e-target-${suffix}`
    const requestedPath = `archive/draft-e2e-${suffix}`
    await api.createPost({ path: sourcePath, title: 'Draft source' })
    await api.createPost({ path: targetSeedPath, title: 'Existing target' })
    await api.patchPost(targetSeedPath, { targetPath: requestedPath })
    const source = await api.getPost(sourcePath)
    const documentId = source.metadata.id
    if (!documentId) throw new Error('missing stable document identity')
    const store = createDraftStore()
    const original = {
      version: 1 as const,
      vaultId: 'vault',
      documentId,
      documentPath: sourcePath,
      content: 'unsaved browser buffer',
      baseContentHash: 'baseline',
      baseModifiedAt: 10.5,
      createdAt: 10,
      updatedAt: 20,
    }
    await store.saveDraft(original)
    const persistence = createUnsavedDraftPersistence({
      store,
      targetWindow: undefined,
    })
    const tabs = [{ path: sourcePath, documentId }]
    const settled: unknown[] = []
    const lifecycle = useDocumentLifecycle({
      fileChanges: createVaultFileChanges(),
      mutationLock: createPathMutationLock(),
      prepareDocumentMutation: async () => ({
        commit() {},
        rollback() {},
      }),
      getOpenDocumentPaths: () => tabs.map(({ path }) => path),
      applyReferenceWrites: async () => {},
      renameOpenDocuments(mappings) {
        for (const mapping of mappings) {
          const tab = tabs.find(({ path }) => path === mapping.from)
          if (tab) tab.path = mapping.to
        }
      },
      removeOpenDocuments() {},
      refresh: async () => {},
      async resolveDocumentIdentity(path) {
        const post = await api.getPost(path)
        return post.metadata.id
          ? { vaultId: 'vault', documentId: post.metadata.id, documentPath: post.path }
          : null
      },
      prepareDraftFileMutation: (identities) => persistence.prepareFileMutation(identities),
      onDraftTransactionSettled(results) {
        settled.push(...results)
      },
    })
    const renamed = await lifecycle.renameFile(sourcePath, {
      targetPath: requestedPath,
    })
    const stored = await store.getDraft('vault', documentId)
    await persistence.dispose()
    return { outcomes: settled, stored, renamedPath: renamed.path, tabPath: tabs[0]?.path }
  }, suffix)

  expect(result.outcomes).toEqual([{
    documentId: result.stored?.documentId,
    oldPath: expect.stringContaining('inbox/draft-e2e-'),
    newPath: result.renamedPath,
    status: 'moved',
  }])
  expect(result.renamedPath).toMatch(/-2$/)
  expect(result.tabPath).toBe(result.renamedPath)
  expect(result.stored).toEqual({
    version: 1,
    vaultId: 'vault',
    documentId: result.stored?.documentId,
    documentPath: result.renamedPath,
    content: 'unsaved browser buffer',
    baseContentHash: 'baseline',
    baseModifiedAt: 10.5,
    createdAt: 10,
    updatedAt: 20,
  })
})

test('keeps a newer cross-context IndexedDB record after confirmed delete', async ({
  page,
}) => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const result = await page.evaluate(async (suffix) => {
    const { createDraftStore } = await import(
      '/src/composables/vault/draft-recovery/draftStore.ts'
    )
    const { createUnsavedDraftPersistence } = await import(
      '/src/composables/vault/draft-recovery/useUnsavedDraftPersistence.ts'
    )
    const { useDocumentLifecycle } = await import(
      '/src/composables/vault/useDocumentLifecycle.ts'
    )
    const { createPathMutationLock } = await import(
      '/src/composables/vault/pathMutationLock.ts'
    )
    const { createVaultFileChanges } = await import(
      '/src/composables/vault/context/fileChanges.ts'
    )
    const api = await import('/src/lib/api.ts')
    const path = `inbox/draft-delete-e2e-${suffix}`
    await api.createPost({ path, title: 'Delete draft source' })
    const post = await api.getPost(path)
    const documentId = post.metadata.id
    if (!documentId) throw new Error('missing stable document identity')
    const first = createDraftStore()
    const second = createDraftStore()
    const makeDraft = (content: string, updatedAt: number) => ({
      version: 1 as const,
      vaultId: 'vault',
      documentId,
      documentPath: path,
      content,
      baseContentHash: null,
      baseModifiedAt: 10,
      createdAt: 1,
      updatedAt,
    })
    await first.saveDraft(makeDraft('confirmed', 10))
    const persistence = createUnsavedDraftPersistence({
      store: first,
      targetWindow: undefined,
    })
    await persistence.adoptRecoveredDraft(
      makeDraft('confirmed', 10),
      {
        vaultId: 'vault',
        documentId,
        documentPath: path,
        content: 'confirmed',
        authoritativeContent: 'disk',
        baseContentHash: null,
        baseModifiedAt: 10,
        revision: 1,
      },
    )
    const identity = {
      vaultId: 'vault',
      documentId,
      documentPath: path,
    }
    const confirmation = persistence.captureDeleteConfirmation(identity, 1)
    await second.saveDraft(makeDraft('newer context', 11))
    const outcomes: unknown[] = []
    const lifecycle = useDocumentLifecycle({
      fileChanges: createVaultFileChanges(),
      mutationLock: createPathMutationLock(),
      prepareDocumentMutation: async () => ({ commit() {}, rollback() {} }),
      getOpenDocumentPaths: () => [path],
      applyReferenceWrites: async () => {},
      renameOpenDocuments() {},
      removeOpenDocuments() {},
      refresh: async () => {},
      resolveDocumentIdentity: async (candidatePath) => {
        const current = await api.getPost(candidatePath)
        return current.metadata.id
          ? { vaultId: 'vault', documentId: current.metadata.id, documentPath: current.path }
          : null
      },
      prepareDraftFileMutation: (identities) => persistence.prepareFileMutation(identities),
      onDraftTransactionSettled(results) {
        outcomes.push(...results)
      },
    })
    await lifecycle.deleteFile(path, {
      draftPolicy: 'discard-confirmed',
      draftConfirmations: [confirmation],
    })
    const stored = await first.getDraft('vault', documentId)
    await persistence.dispose()
    return { outcomes, stored }
  }, suffix)

  expect(result.outcomes[0]?.status).toBe('stale')
  expect(result.stored?.content).toBe('newer context')
})

test('moves conflict record paths along with the primary draft on rename', async ({
  page,
}) => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const result = await page.evaluate(async (suffix) => {
    const { createDraftStore } = await import(
      '/src/composables/vault/draft-recovery/draftStore.ts'
    )
    const { createUnsavedDraftPersistence } = await import(
      '/src/composables/vault/draft-recovery/useUnsavedDraftPersistence.ts'
    )
    const { useDocumentLifecycle } = await import(
      '/src/composables/vault/useDocumentLifecycle.ts'
    )
    const { createPathMutationLock } = await import(
      '/src/composables/vault/pathMutationLock.ts'
    )
    const { createVaultFileChanges } = await import(
      '/src/composables/vault/context/fileChanges.ts'
    )
    const api = await import('/src/lib/api.ts')
    const sourcePath = `inbox/draft-conflict-rename-${suffix}`
    const requestedPath = `archive/draft-conflict-rename-${suffix}`
    await api.createPost({ path: sourcePath, title: 'Conflict rename source' })
    const source = await api.getPost(sourcePath)
    const documentId = source.metadata.id
    if (!documentId) throw new Error('missing stable document identity')
    const store = createDraftStore()
    await store.saveDraft({
      version: 1,
      vaultId: 'vault',
      documentId,
      documentPath: sourcePath,
      content: 'primary buffer',
      baseContentHash: 'baseline',
      baseModifiedAt: 10.5,
      createdAt: 10,
      updatedAt: 20,
    })
    await store.saveConflictDraft({
      version: 1,
      conflictId: `conflict-${suffix}`,
      vaultId: 'vault',
      documentId,
      documentPath: sourcePath,
      content: 'local orphan',
      baseContentHash: 'baseline',
      baseModifiedAt: 10.5,
      createdAt: 10,
      updatedAt: 21,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 20,
      recordedAt: 21,
    })
    const persistence = createUnsavedDraftPersistence({ store, targetWindow: undefined })
    const tabs = [{ path: sourcePath, documentId }]
    const lifecycle = useDocumentLifecycle({
      fileChanges: createVaultFileChanges(),
      mutationLock: createPathMutationLock(),
      prepareDocumentMutation: async () => ({ commit() {}, rollback() {} }),
      getOpenDocumentPaths: () => tabs.map(({ path }) => path),
      applyReferenceWrites: async () => {},
      renameOpenDocuments(mappings) {
        for (const mapping of mappings) {
          const tab = tabs.find(({ path }) => path === mapping.from)
          if (tab) tab.path = mapping.to
        }
      },
      removeOpenDocuments() {},
      refresh: async () => {},
      async resolveDocumentIdentity(path) {
        const post = await api.getPost(path)
        return post.metadata.id
          ? { vaultId: 'vault', documentId: post.metadata.id, documentPath: post.path }
          : null
      },
      prepareDraftFileMutation: (identities) => persistence.prepareFileMutation(identities),
    })
    const renamed = await lifecycle.renameFile(sourcePath, { targetPath: requestedPath })
    const primary = await store.getDraft('vault', documentId)
    const conflicts = await store.listConflictDrafts('vault')
    await persistence.dispose()
    return {
      renamedPath: renamed.path,
      primaryPath: primary?.documentPath,
      conflicts: conflicts.map((conflict) => ({
        path: conflict.documentPath,
        id: conflict.conflictId,
        content: conflict.content,
      })),
    }
  }, suffix)

  // The conflict candidate follows the rename instead of being stranded
  // on the pre-rename path (which would misclassify it as missing-source).
  expect(result.primaryPath).toBe(result.renamedPath)
  expect(result.conflicts).toEqual([{
    path: result.renamedPath,
    id: `conflict-${suffix}`,
    content: 'local orphan',
  }])
})

test('removes the frozen conflict records when a conflict-only document is deleted', async ({
  page,
}) => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const result = await page.evaluate(async (suffix) => {
    const { createDraftStore } = await import(
      '/src/composables/vault/draft-recovery/draftStore.ts'
    )
    const { createUnsavedDraftPersistence } = await import(
      '/src/composables/vault/draft-recovery/useUnsavedDraftPersistence.ts'
    )
    const { useDocumentLifecycle } = await import(
      '/src/composables/vault/useDocumentLifecycle.ts'
    )
    const { createPathMutationLock } = await import(
      '/src/composables/vault/pathMutationLock.ts'
    )
    const { createVaultFileChanges } = await import(
      '/src/composables/vault/context/fileChanges.ts'
    )
    const api = await import('/src/lib/api.ts')
    const path = `inbox/draft-conflict-delete-${suffix}`
    await api.createPost({ path, title: 'Conflict-only delete' })
    const post = await api.getPost(path)
    const documentId = post.metadata.id
    if (!documentId) throw new Error('missing stable document identity')
    const store = createDraftStore()
    // No primary draft — only a conflict candidate exists for this
    // identity, mirroring a document whose cross-context record already
    // left and whose only trace is the local orphan.
    const conflictId = `conflict-${suffix}`
    await store.saveConflictDraft({
      version: 1,
      conflictId,
      vaultId: 'vault',
      documentId,
      documentPath: path,
      content: 'local orphan',
      baseContentHash: 'baseline',
      baseModifiedAt: 10.5,
      createdAt: 10,
      updatedAt: 21,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 20,
      recordedAt: 21,
    })
    const persistence = createUnsavedDraftPersistence({ store, targetWindow: undefined })
    const identity = { vaultId: 'vault', documentId, documentPath: path }
    // Freeze the conflict id exactly as the UI does from its discovered
    // recovery items before confirming the delete.
    const confirmation = persistence.captureDeleteConfirmation(identity, 0, null, [conflictId])
    const outcomes: unknown[] = []
    const lifecycle = useDocumentLifecycle({
      fileChanges: createVaultFileChanges(),
      mutationLock: createPathMutationLock(),
      prepareDocumentMutation: async () => ({ commit() {}, rollback() {} }),
      getOpenDocumentPaths: () => [],
      applyReferenceWrites: async () => {},
      renameOpenDocuments() {},
      removeOpenDocuments() {},
      refresh: async () => {},
      resolveDocumentIdentity: async (candidatePath) => {
        const current = await api.getPost(candidatePath)
        return current.metadata.id
          ? { vaultId: 'vault', documentId: current.metadata.id, documentPath: current.path }
          : null
      },
      prepareDraftFileMutation: (identities) => persistence.prepareFileMutation(identities),
      onDraftTransactionSettled(results) {
        outcomes.push(...results)
      },
    })
    await lifecycle.deleteFile(path, {
      draftPolicy: 'discard-confirmed',
      draftConfirmations: [confirmation],
    })
    const conflicts = await store.listConflictDrafts('vault')
    await persistence.dispose()
    return { outcomes, conflicts }
  }, suffix)

  expect(result.outcomes[0]?.status).toBe('missing')
  expect(result.conflicts).toEqual([])
})

test('persists a mid-CAS edit as a conflict candidate and keeps both across dispose', async ({
  page,
}) => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const result = await page.evaluate(async (suffix) => {
    const { createDraftStore } = await import(
      '/src/composables/vault/draft-recovery/draftStore.ts'
    )
    const { createUnsavedDraftPersistence } = await import(
      '/src/composables/vault/draft-recovery/useUnsavedDraftPersistence.ts'
    )
    const { useDocumentLifecycle } = await import(
      '/src/composables/vault/useDocumentLifecycle.ts'
    )
    const { createPathMutationLock } = await import(
      '/src/composables/vault/pathMutationLock.ts'
    )
    const { createVaultFileChanges } = await import(
      '/src/composables/vault/context/fileChanges.ts'
    )
    const api = await import('/src/lib/api.ts')
    const path = `inbox/draft-handoff-${suffix}`
    await api.createPost({ path, title: 'Handoff source' })
    const post = await api.getPost(path)
    const documentId = post.metadata.id
    if (!documentId) throw new Error('missing stable document identity')
    const store = createDraftStore()
    const second = createDraftStore()
    const makeDraft = (content: string, updatedAt: number) => ({
      version: 1 as const,
      vaultId: 'vault',
      documentId,
      documentPath: path,
      content,
      baseContentHash: null,
      baseModifiedAt: 10,
      createdAt: 1,
      updatedAt,
    })
    await store.saveDraft(makeDraft('confirmed', 10))
    // Gate the conditional delete so a local edit can land mid-CAS, the
    // way a user keeps typing while the delete round-trips IndexedDB.
    let releaseDelete!: () => void
    const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve })
    let deleteStarted = false
    const originalDelete = store.deleteDraftIfUnchanged.bind(store)
    store.deleteDraftIfUnchanged = async (expected) => {
      deleteStarted = true
      await deleteGate
      return originalDelete(expected)
    }
    const persistence = createUnsavedDraftPersistence({ store, targetWindow: undefined })
    await persistence.adoptRecoveredDraft(makeDraft('confirmed', 10), {
      vaultId: 'vault',
      documentId,
      documentPath: path,
      content: 'confirmed',
      authoritativeContent: 'disk',
      baseContentHash: null,
      baseModifiedAt: 10,
      revision: 1,
    })
    const identity = { vaultId: 'vault', documentId, documentPath: path }
    const confirmation = persistence.captureDeleteConfirmation(identity, 1)
    // A cross-context record wins the CAS while our delete is gated.
    await second.saveDraft(makeDraft('newer context', 11))
    const outcomes: unknown[] = []
    const lifecycle = useDocumentLifecycle({
      fileChanges: createVaultFileChanges(),
      mutationLock: createPathMutationLock(),
      prepareDocumentMutation: async () => ({ commit() {}, rollback() {} }),
      getOpenDocumentPaths: () => [path],
      applyReferenceWrites: async () => {},
      renameOpenDocuments() {},
      removeOpenDocuments() {},
      refresh: async () => {},
      resolveDocumentIdentity: async (candidatePath) => {
        const current = await api.getPost(candidatePath)
        return current.metadata.id
          ? { vaultId: 'vault', documentId: current.metadata.id, documentPath: current.path }
          : null
      },
      prepareDraftFileMutation: (identities) => persistence.prepareFileMutation(identities),
      onDraftTransactionSettled(results) {
        outcomes.push(...results)
      },
    })
    const deleting = lifecycle.deleteFile(path, {
      draftPolicy: 'discard-confirmed',
      draftConfirmations: [confirmation],
    })
    while (!deleteStarted) await new Promise((resolve) => { setTimeout(resolve, 0) })
    // Land a local edit while the CAS is in flight.
    persistence.schedule({
      vaultId: 'vault',
      documentId,
      documentPath: path,
      content: 'local edit',
      authoritativeContent: 'disk',
      baseContentHash: null,
      baseModifiedAt: 10,
      revision: 2,
      loaded: true,
    })
    releaseDelete()
    await deleting
    // pagehide/dispose must not drop either candidate.
    await persistence.dispose()
    const primary = await store.getDraft('vault', documentId)
    const conflicts = await store.listConflictDrafts('vault')
    return {
      outcomes,
      primaryContent: primary?.content,
      conflictContents: conflicts.map((conflict) => conflict.content),
    }
  }, suffix)

  expect(result.outcomes[0]?.status).toBe('conflict')
  // The cross-context record stays primary; the mid-CAS local edit is
  // preserved as a conflict candidate, and both survive dispose.
  expect(result.primaryContent).toBe('newer context')
  expect(result.conflictContents).toEqual(['local edit'])
})

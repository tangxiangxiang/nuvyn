import {
  computed,
  readonly,
  ref,
  type ComputedRef,
  type DeepReadonly,
  type Ref,
} from 'vue'
import { getPost, type PostDetail } from '../../../lib/api'
import {
  decideDraftRecovery,
  type DraftRecoveryDecision,
  type RecoveryDiskSnapshot,
} from './draftRecoveryDecision'
import { createDraftStore, type DraftStore } from './draftStore'
import {
  UNSAVED_DRAFT_VERSION,
  type DraftConflictRecord,
  type UnsavedDraft,
} from './draftTypes'
import { isManagedDiaryPath } from '../../../../shared/diaryProtocol'

export type DraftRecoveryItemStatus =
  | 'unresolved'
  | 'loading'
  | 'ready'
  | 'error'
  | 'dismissed'

export interface DraftRecoveryItem {
  recoveryId: string
  draft: UnsavedDraft
  source: 'primary' | 'conflict'
  conflict: DraftConflictRecord | null
  decision: DraftRecoveryDecision | null
  status: DraftRecoveryItemStatus
  error: string | null
}

export interface UnsavedDraftRecovery {
  items: DeepReadonly<Ref<DraftRecoveryItem[]>>
  pendingItem: ComputedRef<DeepReadonly<DraftRecoveryItem> | null>
  activeRecoveryId: DeepReadonly<Ref<string | null>>
  classifyingRecoveryIds: DeepReadonly<Ref<Set<string>>>
  classifyingIdentityIds: DeepReadonly<Ref<Set<string>>>
  discoveringVaultId: DeepReadonly<Ref<string | null>>
  waitForClassification(vaultId: string): Promise<void>
  discover(vaultId: string): Promise<void>
  retry(recoveryId: string): Promise<void>
  refreshIdentity(vaultId: string, documentId: string): Promise<void>
  removeRecoveryIds(recoveryIds: readonly string[]): void
  removeIdentity(vaultId: string, documentId: string): void
  dismissForSession(recoveryId: string): void
  selectRecovery(recoveryId: string | null): void
  /** Clear in-memory recovery items and fence all outstanding classification
   *  work while keeping this coordinator reusable after a later unlock. */
  clearSensitiveState(): void
  dispose(): void
}

interface RecoveryOptions {
  store?: DraftStore
  loadPost?: (path: string) => Promise<PostDetail>
  concurrency?: number
}

interface OwnedItem extends DraftRecoveryItem {
  discoverGeneration: number
  classifyGeneration: number
}

export interface OpenDraftDocumentState {
  documentId?: string | null
  raw: string
  originalRaw: string
  savingRevision: number | null
  saveStatus: string
  externalRaw?: string | null
}

export function hasUnsafeOpenDraftDocument(
  documents: readonly OpenDraftDocumentState[],
  documentId: string,
): boolean {
  const document = documents.find((candidate) => candidate.documentId === documentId)
  return Boolean(document && (
    document.raw !== document.originalRaw
    || document.savingRevision !== null
    || document.externalRaw != null
    || !['idle', 'saved'].includes(document.saveStatus)
  ))
}

function recoveryId(draft: UnsavedDraft): string {
  return JSON.stringify([draft.vaultId, draft.documentId])
}

function conflictRecoveryId(record: DraftConflictRecord): string {
  return JSON.stringify([
    record.vaultId,
    record.documentId,
    'conflict',
    record.conflictId,
  ])
}

function conflictDraft(record: DraftConflictRecord): UnsavedDraft {
  return {
    version: UNSAVED_DRAFT_VERSION,
    vaultId: record.vaultId,
    documentId: record.documentId,
    documentPath: record.documentPath,
    content: record.content,
    baseContentHash: record.baseContentHash,
    baseModifiedAt: record.baseModifiedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function recoveryIdentityId(vaultId: string, documentId: string): string {
  return JSON.stringify([vaultId, documentId])
}

function errorStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null
  const status = (error as { status?: unknown }).status
  return typeof status === 'number' ? status : null
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'unreadable'
}

export function createUnsavedDraftRecovery(
  options: RecoveryOptions = {},
): UnsavedDraftRecovery {
  const store = options.store ?? createDraftStore()
  const loadPost = options.loadPost ?? getPost
  const concurrency = Math.max(1, Math.min(8, Math.floor(options.concurrency ?? 4)))
  const mutableItems = ref<OwnedItem[]>([])
  const activeRecoveryId = ref<string | null>(null)
  const classifyingRecoveryIds = ref(new Set<string>())
  const classifyingIdentityIds = ref(new Set<string>())
  const discoveringVaultId = ref<string | null>(null)
  const classificationCounts = new Map<string, number>()
  const recoveryClassificationCounts = new Map<string, number>()
  const identityClassificationCounts = new Map<string, number>()
  const classificationWaiters = new Map<string, Set<() => void>>()
  const identityRefreshGenerations = new Map<string, number>()
  let identityRefreshEpoch = 0
  let discoverGeneration = 0
  let disposed = false
  const dismissedRecoveryIds = new Set<string>()

  function beginClassification(
    vaultId: string,
    ids: readonly string[] = [],
    identityIds: readonly string[] = [],
  ): () => void {
    classificationCounts.set(vaultId, (classificationCounts.get(vaultId) ?? 0) + 1)
    for (const id of ids) {
      recoveryClassificationCounts.set(id, (recoveryClassificationCounts.get(id) ?? 0) + 1)
    }
    for (const id of identityIds) {
      identityClassificationCounts.set(id, (identityClassificationCounts.get(id) ?? 0) + 1)
    }
    classifyingRecoveryIds.value = new Set(recoveryClassificationCounts.keys())
    classifyingIdentityIds.value = new Set(identityClassificationCounts.keys())
    let ended = false
    return () => {
      if (ended) return
      ended = true
      const remaining = (classificationCounts.get(vaultId) ?? 1) - 1
      if (remaining <= 0) {
        classificationCounts.delete(vaultId)
        for (const resolve of classificationWaiters.get(vaultId) ?? []) resolve()
        classificationWaiters.delete(vaultId)
      } else {
        classificationCounts.set(vaultId, remaining)
      }
      for (const id of ids) {
        const count = (recoveryClassificationCounts.get(id) ?? 1) - 1
        if (count <= 0) recoveryClassificationCounts.delete(id)
        else recoveryClassificationCounts.set(id, count)
      }
      for (const id of identityIds) {
        const count = (identityClassificationCounts.get(id) ?? 1) - 1
        if (count <= 0) identityClassificationCounts.delete(id)
        else identityClassificationCounts.set(id, count)
      }
      classifyingRecoveryIds.value = new Set(recoveryClassificationCounts.keys())
      classifyingIdentityIds.value = new Set(identityClassificationCounts.keys())
    }
  }

  function waitForClassification(vaultId: string): Promise<void> {
    if (disposed || !classificationCounts.has(vaultId)) return Promise.resolve()
    return new Promise((resolve) => {
      const waiters = classificationWaiters.get(vaultId) ?? new Set()
      waiters.add(resolve)
      classificationWaiters.set(vaultId, waiters)
    })
  }

  const pendingItem = computed(() =>
    mutableItems.value.find((item) => (
      (item.status === 'error'
        || (item.status === 'ready' && (
          item.source === 'conflict' || item.decision?.kind !== 'baseline-match'
        )))
      && !dismissedRecoveryIds.has(item.recoveryId)
    )) ?? null,
  )

  function currentItem(
    id: string,
    itemDiscoverGeneration: number,
    generation: number,
  ): OwnedItem | null {
    if (disposed) return null
    const item = mutableItems.value.find((candidate) => candidate.recoveryId === id)
    return item?.discoverGeneration === itemDiscoverGeneration
      && item.classifyGeneration === generation
      ? item
      : null
  }

  async function readDisk(draft: UnsavedDraft): Promise<RecoveryDiskSnapshot> {
    if (isManagedDiaryPath(draft.documentPath.replace(/\.md$/, ''))) {
      return {
        status: 'unreadable',
        documentPath: draft.documentPath,
        error: 'diary-draft-recovery-unsupported',
      }
    }
    try {
      const post = await loadPost(draft.documentPath)
      return {
        status: 'ready',
        documentPath: post.path,
        documentId: post.metadata?.id ?? null,
        raw: post.raw,
        mtime: post.mtime,
      }
    } catch (error) {
      if (errorStatus(error) === 404) {
        return { status: 'missing', documentPath: draft.documentPath }
      }
      return {
        status: 'unreadable',
        documentPath: draft.documentPath,
        error: errorMessage(error),
      }
    }
  }

  async function classify(item: OwnedItem): Promise<void> {
    const endClassification = beginClassification(
      item.draft.vaultId,
      [item.recoveryId],
      [recoveryIdentityId(item.draft.vaultId, item.draft.documentId)],
    )
    const itemDiscoverGeneration = item.discoverGeneration
    const generation = ++item.classifyGeneration
    item.status = 'loading'
    item.decision = null
    item.error = null
    try {
      const disk = await readDisk(item.draft)
      if (!currentItem(item.recoveryId, itemDiscoverGeneration, generation)) return
      const decision = await decideDraftRecovery(item.draft, disk)
      const current = currentItem(item.recoveryId, itemDiscoverGeneration, generation)
      if (!current) return
      current.decision = decision
      current.status = 'ready'
      current.error = null
    } catch (error) {
      const current = currentItem(item.recoveryId, itemDiscoverGeneration, generation)
      if (!current) return
      current.decision = null
      current.status = 'error'
      current.error = errorMessage(error)
    } finally {
      endClassification()
    }
  }

  async function discover(vaultId: string): Promise<void> {
    const endDiscovery = beginClassification(vaultId)
    const generation = ++discoverGeneration
    discoveringVaultId.value = vaultId
    identityRefreshEpoch += 1
    identityRefreshGenerations.clear()
    activeRecoveryId.value = null
    try {
      if (disposed || vaultId.trim().length === 0) {
        mutableItems.value = []
        return
      }
      const [drafts, conflicts] = await Promise.all([
        store.listDrafts(vaultId),
        store.listConflictDrafts(vaultId),
      ])
      if (disposed || generation !== discoverGeneration) return
      const discovered: OwnedItem[] = drafts.map((draft) => ({
        recoveryId: recoveryId(draft),
        draft,
        source: 'primary' as const,
        conflict: null,
        decision: null,
        status: 'unresolved' as const,
        error: null,
        discoverGeneration: generation,
        classifyGeneration: 0,
      })).filter((item) => !isManagedDiaryPath(item.draft.documentPath.replace(/\.md$/, '')))
      discovered.push(...conflicts
        .filter((conflict) => !isManagedDiaryPath(conflict.documentPath.replace(/\.md$/, '')))
        .map((conflict): OwnedItem => ({
        recoveryId: conflictRecoveryId(conflict),
        draft: conflictDraft(conflict),
        source: 'conflict',
        conflict,
        decision: null,
        status: 'unresolved',
        error: null,
        discoverGeneration: generation,
        classifyGeneration: 0,
        })))
      mutableItems.value = discovered

      let cursor = 0
      const workers = Array.from(
        { length: Math.min(concurrency, mutableItems.value.length) },
        async () => {
          while (!disposed && generation === discoverGeneration) {
            const index = cursor++
            const item = mutableItems.value[index]
            if (!item) return
            await classify(item)
          }
        },
      )
      await Promise.all(workers)
    } finally {
      if (generation === discoverGeneration) discoveringVaultId.value = null
      endDiscovery()
    }
  }

  async function retry(id: string): Promise<void> {
    if (disposed) return
    const item = mutableItems.value.find((candidate) => candidate.recoveryId === id)
    if (!item) return
    const endRetry = beginClassification(
      item.draft.vaultId,
      [id],
      [recoveryIdentityId(item.draft.vaultId, item.draft.documentId)],
    )
    try {
      const itemDiscoverGeneration = item.discoverGeneration
      const refreshGeneration = ++item.classifyGeneration
      item.status = 'loading'
      item.decision = null
      item.error = null
      const latest = item.source === 'conflict'
        ? (await store.listConflictDrafts(item.draft.vaultId))
            .find((candidate) => candidate.conflictId === item.conflict?.conflictId)
        : await store.getDraft(item.draft.vaultId, item.draft.documentId)
      const current = currentItem(id, itemDiscoverGeneration, refreshGeneration)
      if (!current) return
      if (!latest) {
        current.decision = null
        current.status = 'error'
        current.error = 'draft-unavailable'
        return
      }
      if (item.source === 'conflict') {
        current.conflict = latest as DraftConflictRecord
        current.draft = conflictDraft(latest as DraftConflictRecord)
      } else {
        current.draft = latest as UnsavedDraft
      }
      await classify(item)
    } finally {
      endRetry()
    }
  }

  async function refreshIdentity(vaultId: string, documentId: string): Promise<void> {
    if (disposed) return
    const id = recoveryIdentityId(vaultId, documentId)
    const epoch = identityRefreshEpoch
    const generation = (identityRefreshGenerations.get(id) ?? 0) + 1
    identityRefreshGenerations.set(id, generation)
    const existingIds = mutableItems.value.filter((item) => (
      item.draft.vaultId === vaultId && item.draft.documentId === documentId
    )).map((item) => item.recoveryId)
    const endRefresh = beginClassification(vaultId, existingIds, [id])
    for (const item of mutableItems.value) {
      if (existingIds.includes(item.recoveryId)) {
        item.status = 'loading'
        item.decision = null
        item.error = null
      }
    }
    try {
      const [latest, conflicts] = await Promise.all([
        store.getDraft(vaultId, documentId),
        store.listConflictDrafts(vaultId),
      ])
      if (disposed
        || identityRefreshEpoch !== epoch
        || identityRefreshGenerations.get(id) !== generation) return
      const relevantConflicts = conflicts.filter((candidate) => (
        candidate.documentId === documentId
        && !isManagedDiaryPath(candidate.documentPath.replace(/\.md$/, ''))
      ))
      const wanted = new Map<string, {
        draft: UnsavedDraft
        source: 'primary' | 'conflict'
        conflict: DraftConflictRecord | null
      }>()
      if (latest) {
        wanted.set(id, { draft: latest, source: 'primary', conflict: null })
      }
      for (const conflict of relevantConflicts) {
        wanted.set(conflictRecoveryId(conflict), {
          draft: conflictDraft(conflict),
          source: 'conflict',
          conflict,
        })
      }
      const existingForIdentity = mutableItems.value.filter((candidate) => (
        candidate.draft.vaultId === vaultId
        && candidate.draft.documentId === documentId
      ))
      const wantedIds = new Set(wanted.keys())
      mutableItems.value = mutableItems.value.filter((candidate) => (
        candidate.draft.vaultId !== vaultId
        || candidate.draft.documentId !== documentId
        || wantedIds.has(candidate.recoveryId)
      ))
      const toClassify: OwnedItem[] = []
      for (const [recoveryId, candidate] of wanted) {
        const existing = mutableItems.value.find((item) => item.recoveryId === recoveryId)
        if (existing) {
          existing.draft = candidate.draft
          existing.source = candidate.source
          existing.conflict = candidate.conflict
          toClassify.push(existing)
        } else {
          const item: OwnedItem = {
            recoveryId,
            ...candidate,
            decision: null,
            status: 'unresolved',
            error: null,
            discoverGeneration,
            classifyGeneration: 0,
          }
          mutableItems.value = [...mutableItems.value, item]
          toClassify.push(item)
        }
      }
      const removedIds = new Set(existingForIdentity
        .filter((candidate) => !wantedIds.has(candidate.recoveryId))
        .map((candidate) => candidate.recoveryId))
      if (activeRecoveryId.value && removedIds.has(activeRecoveryId.value)) {
        activeRecoveryId.value = null
      }
      await Promise.all(toClassify.map(classify))
    } finally {
      endRefresh()
    }
  }

  function dismissForSession(id: string): void {
    if (disposed) return
    const item = mutableItems.value.find((candidate) => candidate.recoveryId === id)
    if (!item) return
    item.status = 'dismissed'
    dismissedRecoveryIds.add(id)
    if (activeRecoveryId.value === id) activeRecoveryId.value = null
  }

  function removeIdentity(vaultId: string, documentId: string): void {
    if (disposed) return
    const id = recoveryIdentityId(vaultId, documentId)
    identityRefreshGenerations.set(
      id,
      (identityRefreshGenerations.get(id) ?? 0) + 1,
    )
    const removed = mutableItems.value.filter((item) => (
      item.draft.vaultId === vaultId && item.draft.documentId === documentId
    ))
    if (removed.length === 0) return
    const removedIds = new Set(removed.map((item) => item.recoveryId))
    mutableItems.value = mutableItems.value.filter((item) => !removedIds.has(item.recoveryId))
    if (activeRecoveryId.value && removedIds.has(activeRecoveryId.value)) {
      activeRecoveryId.value = null
    }
  }

  function removeRecoveryIds(recoveryIds: readonly string[]): void {
    if (disposed || recoveryIds.length === 0) return
    const removedIds = new Set(recoveryIds)
    mutableItems.value = mutableItems.value.filter((item) => !removedIds.has(item.recoveryId))
    if (activeRecoveryId.value && removedIds.has(activeRecoveryId.value)) {
      activeRecoveryId.value = null
    }
  }

  function selectRecovery(id: string | null): void {
    if (disposed) return
    activeRecoveryId.value = id !== null
      && mutableItems.value.some((item) => item.recoveryId === id)
      ? id
      : null
  }

  function clearSensitiveState(): void {
    const managedIds = new Set(mutableItems.value
      .filter((item) => isManagedDiaryPath(item.draft.documentPath.replace(/\.md$/, '')))
      .map((item) => item.recoveryId))
    // Fence and remove only managed-Diary viewers. Ordinary Note recovery
    // remains available across a Diary lock/logout, preserving its existing
    // lifecycle semantics; any in-flight managed classifier can no longer
    // publish because its item is removed and its generation advances.
    for (const item of mutableItems.value) {
      if (managedIds.has(item.recoveryId)) item.classifyGeneration += 1
    }
    mutableItems.value = mutableItems.value.filter((item) => !managedIds.has(item.recoveryId))
    if (activeRecoveryId.value && managedIds.has(activeRecoveryId.value)) {
      activeRecoveryId.value = null
    }
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    discoverGeneration += 1
    identityRefreshEpoch += 1
    identityRefreshGenerations.clear()
    discoveringVaultId.value = null
    for (const waiters of classificationWaiters.values()) {
      for (const resolve of waiters) resolve()
    }
    classificationWaiters.clear()
    classificationCounts.clear()
    recoveryClassificationCounts.clear()
    identityClassificationCounts.clear()
    classifyingRecoveryIds.value = new Set()
    classifyingIdentityIds.value = new Set()
    for (const item of mutableItems.value) item.classifyGeneration += 1
    activeRecoveryId.value = null
  }

  return {
    items: readonly(mutableItems),
    pendingItem,
    activeRecoveryId: readonly(activeRecoveryId),
    classifyingRecoveryIds: readonly(classifyingRecoveryIds),
    classifyingIdentityIds: readonly(classifyingIdentityIds),
    discoveringVaultId: readonly(discoveringVaultId),
    waitForClassification,
    discover,
    retry,
    refreshIdentity,
    removeRecoveryIds,
    removeIdentity,
    dismissForSession,
    selectRecovery,
    clearSensitiveState,
    dispose,
  }
}

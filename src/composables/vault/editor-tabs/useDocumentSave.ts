import type { Ref } from 'vue'
import type { Tab } from '../../../components/vault/tabs'
import {
  SavePostConflictError,
  savePost,
  type PostSummary,
  type SavePostResult,
} from '../../../lib/api'
import { useI18n } from '../../useI18n'
import type { VaultFileChanges } from '../context/fileChanges'
import type {
  DraftOwner,
  UnsavedDraftPersistence,
} from '../draft-recovery/useUnsavedDraftPersistence'
import type { UnsavedDraft } from '../draft-recovery/draftTypes'
import { classifyDiaryPath } from '../../../../shared/diaryProtocol'
import { captureDiarySessionGeneration, isDiarySessionGenerationCurrent } from '../../diary/useDiaryAccessSession'

export interface DocumentMutationBarrier {
  readonly paths: readonly string[]
  commit(resumePaths?: readonly string[]): void
  rollback(): void
}

export type AuthTransitionKind = 'logout' | 'expired'

export type AuthSaveIssueReason =
  | 'dirty'
  | 'saving'
  | 'external'
  | 'offline'
  | 'error'
  | 'unavailable'

export interface AuthTransitionSnapshot {
  unsafe: ReadonlyArray<{ path: string; reason: AuthSaveIssueReason }>
}

export interface AuthSaveAllResult {
  attempted: readonly string[]
  unsafe: ReadonlyArray<{ path: string; reason: AuthSaveIssueReason }>
}

export interface AuthTransitionHandle {
  readonly kind: AuthTransitionKind
  release(resumeAutosave?: boolean): void
}

export interface ApplyRecoveredDraftInput {
  draft: UnsavedDraft
  expectedDiskRaw: string
  expectedDiskMtime: number
}

export type ApplyRecoveredDraftResult =
  | { status: 'applied'; path: string }
  | { status: 'stale' }
  | { status: 'dirty' }
  | { status: 'external' }
  | { status: 'missing' }

export function useDocumentSave(options: {
  tabs: Ref<Tab[]>
  activePath: Ref<string | null>
  applyPostSummary: (post: PostSummary) => void
  fileChanges: VaultFileChanges
  toastError: (message: string) => void
  draftPersistence?: UnsavedDraftPersistence
  draftVaultId?: () => string | null
}) {
  const { t } = useI18n()
  const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const savePromises = new Map<string, Promise<void>>()
  const commitBarriers = new Map<string, { revision: number; raw: string }>()
  const lifecycleLocks = new Set<string>()
  let lifecycleGlobalLock = false
  let authTransitionKind: AuthTransitionKind | null = null
  let authTransitionPromise: Promise<AuthTransitionHandle> | null = null
  let disposed = false
  const draftOwners = new WeakMap<Tab, DraftOwner>()

  function draftIdentity(tab: Tab): { vaultId: string; documentId: string } | null {
    const vaultId = options.draftVaultId?.() ?? null
    const documentId = tab.documentId ?? null
    return vaultId && documentId ? { vaultId, documentId } : null
  }

  function scheduleDraft(tab: Tab): void {
    if (classifyDiaryPath(tab.path) === 'managed') return
    const identity = draftIdentity(tab)
    if (!identity || tab.loading || tab.loadError) return
    const owner = options.draftPersistence?.schedule({
      ...identity,
      documentPath: tab.path,
      content: tab.raw,
      authoritativeContent: tab.originalRaw,
      baseContentHash: null,
      baseModifiedAt: tab.serverMtime,
      revision: tab.revision,
    })
    if (owner) draftOwners.set(tab, owner)
  }

  function clearReturnedToBaseline(tab: Tab): void {
    const identity = draftIdentity(tab)
    if (!identity) return
    draftOwners.delete(tab)
    void options.draftPersistence
      ?.returnedToBaseline(identity.vaultId, identity.documentId)
      .catch(() => {})
  }

  async function discardDocumentDrafts(paths: readonly string[]): Promise<void> {
    await Promise.all(paths.map(async (path) => {
      if (classifyDiaryPath(path) === 'managed') return
      const tab = options.tabs.value.find((candidate) => candidate.path === path)
      if (!tab) return
      const owner = draftOwners.get(tab)
      if (!owner) return
      draftOwners.delete(tab)
      try {
        await options.draftPersistence?.discard(owner)
      } catch {
        // Draft persistence is best-effort and never changes close behavior.
      }
    }))
  }

  async function discardDocumentDraft(tab: Tab | undefined): Promise<void> {
    if (!tab) return
    const owner = draftOwners.get(tab)
    if (!owner) return
    draftOwners.delete(tab)
    try {
      await options.draftPersistence?.discard(owner)
    } catch {
      // Draft persistence is best-effort and never changes close behavior.
    }
  }

  function hasUnresolvedExternal(tab: Tab): boolean {
    return tab.saveStatus === 'external' || tab.externalRaw != null
  }

  function scheduleSave(path: string, delay = 800) {
    if (disposed || authTransitionKind !== null || lifecycleGlobalLock
      || commitBarriers.has(path) || lifecycleLocks.has(path)) return
    const tab = options.tabs.value.find((candidate) => candidate.path === path)
    if (!tab || hasUnresolvedExternal(tab)) return
    const current = saveTimers.get(path)
    if (current) clearTimeout(current)
    saveTimers.set(path, setTimeout(() => {
      saveTimers.delete(path)
      void doSave(path)
    }, delay))
  }

  function cancelScheduledSave(path: string): boolean {
    const timer = saveTimers.get(path)
    if (!timer) return false
    clearTimeout(timer)
    saveTimers.delete(path)
    return true
  }

  async function saveLatest(path: string, allowAuthTransition = false): Promise<void> {
    if (disposed) return
    const tab = options.tabs.value.find((candidate) => candidate.path === path)
    if (!tab || hasUnresolvedExternal(tab)) return
    if ((authTransitionKind !== null && !allowAuthTransition)
      || (lifecycleGlobalLock && !allowAuthTransition)
      || lifecycleLocks.has(path)) {
      tab.saveStatus = tab.revision === tab.savedRevision ? 'idle' : 'dirty'
      return
    }
    const barrier = commitBarriers.get(path)
    if (barrier ? tab.savedRevision >= barrier.revision : tab.revision === tab.savedRevision) {
      tab.saveStatus = tab.revision === tab.savedRevision ? 'idle' : 'dirty'
      return
    }
    const sentRevision = barrier?.revision ?? tab.revision
    const sentVersion = barrier?.raw ?? tab.raw
    const sentBaseRaw = tab.originalRaw
    const sessionGeneration = captureDiarySessionGeneration()
    tab.savingRevision = sentRevision
    tab.saveStatus = 'saving'
    tab.error = null
    let data: SavePostResult
    try {
      data = await savePost(path, sentVersion, sentBaseRaw)
    } catch (error) {
      if (disposed) return
      if (classifyDiaryPath(path) === 'managed' && !isDiarySessionGenerationCurrent(sessionGeneration)) {
        // The authoritative Diary session was torn down while this request
        // was in flight. Never publish its stale conflict/error payload.
        tab.externalRaw = null
        tab.externalKind = null
        tab.error = null
        tab.savingRevision = null
        return
      }
      if (error instanceof SavePostConflictError) {
        tab.externalRaw = error.current.raw
        tab.externalKind = 'modified'
        tab.serverMtime = error.current.mtime
        tab.saveStatus = 'external'
        tab.error = null
        tab.savingRevision = null
        return
      }
      tab.saveStatus = typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'error'
      tab.error = (error as Error).message
      options.toastError(t('editor.save_failed', { error: tab.error }))
      tab.savingRevision = null
      return
    }

    if (disposed) return
    if (classifyDiaryPath(path) === 'managed' && !isDiarySessionGenerationCurrent(sessionGeneration)) {
      tab.externalRaw = null
      tab.externalKind = null
      tab.error = null
      tab.savingRevision = null
      return
    }

    try {
      const externalAppearedDuringSave = hasUnresolvedExternal(tab)
      if (tab.raw === sentVersion) {
        tab.raw = data.raw
        tab.originalRaw = data.raw
      } else {
        tab.originalRaw = sentVersion
      }
      tab.savedRevision = sentRevision
      tab.saveStatus = externalAppearedDuringSave
        ? 'external'
        : tab.revision === sentRevision ? 'saved' : 'dirty'
      if (!externalAppearedDuringSave) {
        tab.serverMtime = data.post.mtime
        tab.externalKind = null
      }
      try {
        options.applyPostSummary(data.post)
      } catch (error) {
        console.warn(`[useDocumentSave] Saved ${path}, but the Workspace summary update failed`, error)
      }
      options.fileChanges.publish({
        path,
        kind: 'write',
        source: 'editor-save',
        newMtime: data.post.mtime,
      })
      if (!externalAppearedDuringSave
        && tab.revision === sentRevision
        && tab.raw === tab.originalRaw) {
        const owner = draftOwners.get(tab)
        if (owner) {
          draftOwners.delete(tab)
          void options.draftPersistence?.markClean(owner, sentRevision).catch(() => {})
        }
      } else if (!externalAppearedDuringSave && tab.revision !== tab.savedRevision) {
        // The acknowledged bytes are now the authoritative baseline while a
        // newer editor revision remains dirty. Refresh the draft snapshot so
        // recovery compares against that new baseline, not the pre-save one.
        scheduleDraft(tab)
      }
    } finally {
      tab.savingRevision = null
    }
  }

  async function doSave(path: string, allowAuthTransition = false): Promise<void> {
    if (disposed
      || (authTransitionKind !== null && !allowAuthTransition)
      || (lifecycleGlobalLock && !allowAuthTransition)
      || lifecycleLocks.has(path)) return
    const tab = options.tabs.value.find((candidate) => candidate.path === path)
    if (!tab || hasUnresolvedExternal(tab)) return
    const active = savePromises.get(path)
    if (active) return active
    const promise = (async () => {
      do {
        await saveLatest(path, allowAuthTransition)
        const tab = options.tabs.value.find((candidate) => candidate.path === path)
        const barrier = commitBarriers.get(path)
        if (barrier && (!tab || tab.savedRevision >= barrier.revision)) break
        if (disposed
            || (authTransitionKind !== null && !allowAuthTransition)
            || (lifecycleGlobalLock && !allowAuthTransition)
            || lifecycleLocks.has(path)
            || !tab || hasUnresolvedExternal(tab)
            || ['error', 'offline'].includes(tab.saveStatus)
            || tab.revision === tab.savedRevision) break
      } while (true)
    })().finally(() => savePromises.delete(path))
    savePromises.set(path, promise)
    return promise
  }

  function onEditorChange(path: string, value: string) {
    // Existing file/history transactions intentionally allow the editor to
    // keep recording a dirty revision while their global barrier is held;
    // the barrier resumes that autosave after rollback/commit. Auth
    // transitions are the stricter quiescent case: user edits must not
    // create a new protected mutation while logout/expiry is committing.
    if (disposed || authTransitionKind !== null) return
    const tab = options.tabs.value.find((candidate) => candidate.path === path)
    if (!tab) return
    const external = hasUnresolvedExternal(tab)
    tab.raw = value
    tab.revision += 1
    if (external) {
      tab.saveStatus = 'external'
      scheduleDraft(tab)
      return
    }
    if (tab.raw === tab.originalRaw) {
      tab.savedRevision = tab.revision
      clearReturnedToBaseline(tab)
    } else {
      scheduleDraft(tab)
    }
    tab.saveStatus = tab.revision === tab.savedRevision ? 'idle' : 'dirty'
    scheduleSave(path)
  }

  async function applyRecoveredDraft(
    input: ApplyRecoveredDraftInput,
  ): Promise<ApplyRecoveredDraftResult> {
    if (disposed || classifyDiaryPath(input.draft.documentPath) === 'managed') return { status: 'missing' }
    const tab = options.tabs.value.find(
      (candidate) => candidate.documentId === input.draft.documentId,
    )
    if (!tab || tab.loading || tab.loadError) return { status: 'missing' }
    if (hasUnresolvedExternal(tab)
      || ['error', 'offline'].includes(tab.saveStatus)) {
      return { status: 'external' }
    }
    if (
      tab.raw !== tab.originalRaw
      || tab.revision !== tab.savedRevision
      || tab.savingRevision !== null
    ) {
      return { status: 'dirty' }
    }
    if (
      tab.originalRaw !== input.expectedDiskRaw
      || tab.serverMtime !== input.expectedDiskMtime
    ) {
      return { status: 'stale' }
    }

    const identity = draftIdentity(tab)
    if (!identity
      || identity.vaultId !== input.draft.vaultId
      || tab.path !== input.draft.documentPath) {
      return { status: 'missing' }
    }
    const expectedTabState = {
      raw: tab.raw,
      originalRaw: tab.originalRaw,
      revision: tab.revision,
      savedRevision: tab.savedRevision,
      savingRevision: tab.savingRevision,
      saveStatus: tab.saveStatus,
      serverMtime: tab.serverMtime,
    }
    const nextRevision = tab.revision + 1
    const owner = await options.draftPersistence?.adoptRecoveredDraft(
      input.draft,
      {
        ...identity,
        documentPath: tab.path,
        content: input.draft.content,
        authoritativeContent: tab.originalRaw,
        baseContentHash: input.draft.baseContentHash,
        baseModifiedAt: input.draft.baseModifiedAt,
        revision: nextRevision,
      },
    )
    if (!owner) return { status: 'stale' }
    if (disposed
      || !options.tabs.value.includes(tab)
      || Object.entries(expectedTabState).some(
        ([field, value]) => tab[field as keyof Tab] !== value,
      )) {
      options.draftPersistence?.invalidateOwner(owner)
      return { status: 'stale' }
    }

    // Recovery intentionally bypasses onEditorChange(): it creates a dirty
    // editor revision and adopts the existing browser draft without rewriting
    // it or scheduling a server save.
    tab.raw = input.draft.content
    tab.revision = nextRevision
    tab.saveStatus = 'dirty'
    tab.error = null
    draftOwners.set(tab, owner)
    return { status: 'applied', path: tab.path }
  }

  function handleBeforeUnload(event: BeforeUnloadEvent) {
    const hasUnsaved = options.tabs.value.some((tab) =>
      tab.raw !== tab.originalRaw
      || tab.revision !== tab.savedRevision
      || tab.savingRevision !== null
      || hasUnresolvedExternal(tab)
      || ['error', 'offline'].includes(tab.saveStatus),
    )
    if (!hasUnsaved) return
    event.preventDefault()
    event.returnValue = ''
  }

  async function doSaveNow() {
    const path = options.activePath.value
    if (!path) return
    cancelScheduledSave(path)
    await doSave(path)
  }

  function authTransitionSnapshot(): AuthTransitionSnapshot {
    const unsafe: Array<{ path: string; reason: AuthSaveIssueReason }> = []
    for (const tab of options.tabs.value) {
      if (tab.loading || tab.loadError) {
        unsafe.push({ path: tab.path, reason: 'unavailable' })
        continue
      }
      if (hasUnresolvedExternal(tab)) {
        unsafe.push({ path: tab.path, reason: 'external' })
        continue
      }
      if (tab.saveStatus === 'offline') {
        unsafe.push({ path: tab.path, reason: 'offline' })
        continue
      }
      if (tab.saveStatus === 'error') {
        unsafe.push({ path: tab.path, reason: 'error' })
        continue
      }
      if (tab.savingRevision !== null || tab.saveStatus === 'saving') {
        unsafe.push({ path: tab.path, reason: 'saving' })
        continue
      }
      if (tab.raw !== tab.originalRaw || tab.revision !== tab.savedRevision) {
        unsafe.push({ path: tab.path, reason: 'dirty' })
      }
    }
    return { unsafe }
  }

  async function prepareAuthTransition(kind: AuthTransitionKind): Promise<AuthTransitionHandle> {
    if (authTransitionPromise) return authTransitionPromise
    const pending = (async (): Promise<AuthTransitionHandle> => {
      if (disposed) {
        return { kind, release() {} }
      }
      authTransitionKind = kind
      lifecycleGlobalLock = true
      for (const path of saveTimers.keys()) cancelScheduledSave(path)
      const activePromises = [...savePromises.values()]
      if (activePromises.length > 0) await Promise.allSettled(activePromises)
      for (const path of saveTimers.keys()) cancelScheduledSave(path)

      let released = false
      let resumed = false
      const resumeScheduledAutosave = () => {
        if (resumed || disposed) return
        resumed = true
        for (const tab of options.tabs.value) {
          if (tab.revision !== tab.savedRevision) scheduleSave(tab.path)
        }
      }
      const handle: AuthTransitionHandle = {
        kind,
        release(resumeAutosave = true) {
          if (released) {
            // A transition may have to release its mutation barrier before
            // asking the owner about an unsafe result. A later cancellation
            // must still be able to resume ordinary autosave without
            // reacquiring that barrier.
            if (resumeAutosave) {
              if (authTransitionKind === kind) authTransitionKind = null
              resumeScheduledAutosave()
            }
            return
          }
          released = true
          lifecycleGlobalLock = false
          if (authTransitionPromise === pending) authTransitionPromise = null
          if (resumeAutosave) {
            if (authTransitionKind === kind) authTransitionKind = null
            resumeScheduledAutosave()
          }
        },
      }
      return handle
    })()
    authTransitionPromise = pending
    if (disposed) authTransitionPromise = null
    return pending
  }

  async function saveAllForActiveLogout(
    isCurrent: () => boolean = () => true,
  ): Promise<AuthSaveAllResult> {
    const attempted: string[] = []
    const paths = options.tabs.value.map((tab) => tab.path)
    for (const path of paths) {
      if (!isCurrent()) break
      cancelScheduledSave(path)
      const tab = options.tabs.value.find((candidate) => candidate.path === path)
      if (!tab || tab.loading || tab.loadError || hasUnresolvedExternal(tab)) continue
      if (tab.revision === tab.savedRevision && tab.savingRevision === null) continue
      attempted.push(path)
      await doSave(path, true)
    }
    return { attempted, unsafe: authTransitionSnapshot().unsafe }
  }

  async function prepareDocumentMutation(
    paths: readonly string[],
    lockAll = false,
  ): Promise<DocumentMutationBarrier> {
    const uniquePaths = [...new Set(paths.filter((path) => path.trim().length > 0))]
    if (disposed) return { paths: uniquePaths, commit() {}, rollback() {} }

    if (lockAll) lifecycleGlobalLock = true
    else for (const path of uniquePaths) lifecycleLocks.add(path)
    for (const path of uniquePaths) cancelScheduledSave(path)
    const activePromises = uniquePaths
      .map((path) => savePromises.get(path))
      .filter((promise): promise is Promise<void> => Boolean(promise))
    if (activePromises.length > 0) await Promise.allSettled(activePromises)
    for (const path of uniquePaths) cancelScheduledSave(path)

    let settled = false
    function settle(resumePaths: readonly string[]): void {
      if (settled) return
      settled = true
      if (lockAll) lifecycleGlobalLock = false
      else for (const path of uniquePaths) lifecycleLocks.delete(path)
      if (disposed) return
      for (const path of [...new Set(resumePaths)]) {
        const tab = options.tabs.value.find((candidate) => candidate.path === path)
        if (tab && tab.revision !== tab.savedRevision) scheduleSave(path)
      }
    }

    return {
      paths: uniquePaths,
      commit(resumePaths = []) { settle(resumePaths) },
      rollback() {
        settle(lockAll ? options.tabs.value.map((tab) => tab.path) : uniquePaths)
      },
    }
  }

  async function prepareHistoryCommit(historyPaths: readonly string[]): Promise<(
    options?: { flushPending?: boolean }
  ) => Promise<void>> {
    const appPaths = historyPaths.map((path) => path.endsWith('.md') ? path.slice(0, -3) : path)
    const barrierPaths: string[] = []
    for (const path of appPaths) {
      const tab = options.tabs.value.find((candidate) => candidate.path === path)
      if (!tab) continue
      commitBarriers.set(path, { revision: tab.revision, raw: tab.raw })
      barrierPaths.push(path)
    }

    let released = false
    const release = async (releaseOptions: { flushPending?: boolean } = {}): Promise<void> => {
      if (released) return
      released = true
      for (const path of barrierPaths) commitBarriers.delete(path)
      if (releaseOptions.flushPending === false) return
      await Promise.all(barrierPaths.map(async (path) => {
        const tab = options.tabs.value.find((candidate) => candidate.path === path)
        if (tab && tab.revision !== tab.savedRevision) await doSave(path)
      }))
    }

    for (const path of appPaths) {
      cancelScheduledSave(path)
    }

    try {
      for (const path of barrierPaths) {
        const tab = options.tabs.value.find((candidate) => candidate.path === path)
        const barrier = commitBarriers.get(path)
        if (!tab || !barrier) continue
        if (tab.savedRevision < barrier.revision) await doSave(path)
        if (tab.savedRevision < barrier.revision || ['error', 'offline', 'external'].includes(tab.saveStatus)) {
          throw new Error(tab.error || t('editor.save_failed', { error: path }))
        }
      }
      return release
    } catch (error) {
      await release({ flushPending: false })
      throw error
    }
  }

  function prepareHistoryRestore(path: string): Promise<DocumentMutationBarrier> {
    return prepareDocumentMutation([path])
  }

  function prepareDocumentClose(paths: readonly string[]): Promise<DocumentMutationBarrier> {
    return prepareDocumentMutation(paths)
  }

  function disposeDocumentSave() {
    disposed = true
    for (const timer of saveTimers.values()) clearTimeout(timer)
    saveTimers.clear()
    commitBarriers.clear()
    lifecycleLocks.clear()
    lifecycleGlobalLock = false
    authTransitionKind = null
    authTransitionPromise = null
  }

  /** Synchronously clear body/conflict holders for managed Diary tabs before
   * the workspace closes them. No persistence operation is started. */
  function clearSensitiveState(paths?: readonly string[]): void {
    const allowed = paths ? new Set(paths) : null
    for (const tab of options.tabs.value) {
      if (classifyDiaryPath(tab.path) !== 'managed' || (allowed && !allowed.has(tab.path))) continue
      cancelScheduledSave(tab.path)
      tab.raw = ''
      tab.originalRaw = ''
      tab.externalRaw = null
      tab.externalKind = null
      tab.error = null
      tab.savingRevision = null
      tab.revision = tab.savedRevision
      const identity = draftIdentity(tab)
      if (identity) options.draftPersistence?.invalidate(identity.vaultId, identity.documentId)
    }
  }

  return {
    scheduleSave,
    doSave,
    onEditorChange,
    applyRecoveredDraft,
    handleBeforeUnload,
    doSaveNow,
    getAuthTransitionSnapshot: authTransitionSnapshot,
    prepareAuthTransition,
    saveAllForActiveLogout,
    prepareDocumentMutation,
    prepareHistoryCommit,
    prepareHistoryRestore,
    prepareDocumentClose,
    discardDocumentDraft,
    discardDocumentDrafts,
    clearSensitiveState,
    disposeDocumentSave,
  }
}

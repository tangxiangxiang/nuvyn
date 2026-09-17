// Public editor-tabs coordinator. Mutable state and behavior live in focused
// composables under editor-tabs/; this module preserves the VaultView API and
// wires lifecycle, persistence restore, command-palette creation, and cleanup.

import { onBeforeUnmount, onMounted } from 'vue'
import { createPost, type PostSummary } from '../../lib/api'
import { classifyDiaryPath } from '../../../shared/diaryProtocol'
import { useToast } from '../useToast'
import { useConfirm } from '../useConfirm'
import type { SidePanel } from '../../components/vault/ActivityBar.vue'
import { isSlugSegment, toLocalSlug } from '../../lib/slug'
import { TAB_HARD_LIMIT } from './editor-tabs/tabState'
import { useEditorShortcuts } from './editor-tabs/useEditorShortcuts'
import { useRouteSync } from './editor-tabs/useRouteSync'
import { useExternalFileChanges } from './editor-tabs/useExternalFileChanges'
import { useDiskFileChanges } from './editor-tabs/useDiskFileChanges'
import { useTabWorkspace } from './editor-tabs/useTabWorkspace'
import { useDocumentSave } from './editor-tabs/useDocumentSave'
import type { VaultFileChanges } from './context/fileChanges'
import {
  __setVaultIdForTesting,
  readPersistedTabs,
  useTabPersistence,
} from './editor-tabs/useTabPersistence'
import { useI18n } from '../useI18n'
import { createPathMutationLock, toMutationPaths } from './pathMutationLock'
import { createDraftStore, type DraftStore } from './draft-recovery/draftStore'
import {
  createUnsavedDraftPersistence,
  type UnsavedDraftPersistence,
} from './draft-recovery/useUnsavedDraftPersistence'
import { createServerDocumentPathResolver } from './draft-recovery/serverDocumentResolver'
export {
  __setVaultIdForTesting,
  resetTabPersistenceForTesting,
} from './editor-tabs/useTabPersistence'

export function useEditorTabs(opts: {
  /** Authoritative identity resolved before VaultView mounts. */
  vaultId: string
  selectPanel: (panel: SidePanel) => void
  /* Wired into the Cmd/Ctrl+E shortcut to toggle between edit and read
     mode. Accepted as a callback (not looked up globally) for the same
     reason selectPanel is — keeps the layout dependency explicit. */
  toggleViewMode: () => void
  fileChanges: VaultFileChanges
  mutationLock?: ReturnType<typeof createPathMutationLock>
  createDocument?: (input: { path: string; title?: string }) => Promise<PostSummary>
  workspaceShortcuts?: boolean
  prepareWorkspaceRename?: (from: string, to: string) => () => void
  draftStore?: DraftStore
  draftPersistence?: UnsavedDraftPersistence
  /** Gate managed Diary body access before a tab/route can load raw text. */
  authorizeDocumentPath?: (path: string) => Promise<boolean>
  /** Synchronous capability check used to defer persisted Diary tabs. */
  isDiaryAccessReady?: () => boolean
  onDiaryAccessCancelled?: (path: string) => void
}) {
  const toast = useToast()
  const { confirm } = useConfirm()
  const { t } = useI18n()
  const fileChanges = opts.fileChanges

  const {
    tree,
    treeLoading,
    treeError,
    posts,
    tabs,
    activePath,
    activeTab,
    isDirty,
    activeSize,
    refresh,
    applyPostSummary,
    openPost: openWorkspacePost,
    restoreOneTab: restoreWorkspaceTab,
    closeTab: closeTabState,
    confirmCloseMany: confirmCloseManyState,
    closeManyConfirmed,
    selectTab,
    reorderTabs: reorderOpenDocuments,
    navigateTo,
    renameOpenDocuments,
    removeOpenDocuments,
    setPersist,
  } = useTabWorkspace({
    confirm,
    toastError: toast.error,
    toastInfo: toast.info,
  })

  // Build persistence on top of the workspace's tab set, then bind
  // the resulting synchronous persister into the workspace's close
  // hooks so every close / rename / restore-failure path persists
  // before the user can refresh.
  const {
    vaultId,
    persist: persistOpenTabs,
    dispose: disposeTabPersistence,
  } = useTabPersistence(tabs, activePath, opts.vaultId)
  setPersist(persistOpenTabs)

  const draftPersistence = opts.draftPersistence ?? createUnsavedDraftPersistence({
    store: opts.draftStore ?? createDraftStore(),
    // Defense in depth: if a caller ever omits the production
    // persistence (VaultView always supplies it), the fallback must
    // still carry the authoritative by-stable-identity server
    // resolver — an emptied-family retry without it fails closed
    // forever instead of recovering.
    resolveCurrentDocumentPath: createServerDocumentPathResolver(),
  })

  const {
    scheduleSave,
    doSave,
    onEditorChange,
    applyRecoveredDraft,
    handleBeforeUnload,
    doSaveNow,
    prepareHistoryCommit,
    prepareHistoryRestore,
    prepareDocumentMutation,
    prepareDocumentClose,
    getAuthTransitionSnapshot,
    prepareAuthTransition,
    saveAllForActiveLogout,
    discardDocumentDraft,
    discardDocumentDrafts,
    clearSensitiveState,
    disposeDocumentSave,
  } = useDocumentSave({
    tabs,
    activePath,
    applyPostSummary,
    fileChanges,
    toastError: toast.error,
    draftPersistence,
    draftVaultId: () => vaultId.value,
  })

  async function closeTab(path: string): Promise<boolean> {
    const release = opts.mutationLock?.acquire(toMutationPaths([path])) ?? null
    if (opts.mutationLock && !release) return false
    try {
      const closingTab = tabs.value.find((tab) => tab.path === path)
      const barrier = await prepareDocumentClose([path])
      const closed = await closeTabState(path)
      if (closed) {
        await discardDocumentDraft(closingTab)
        barrier.commit()
      }
      else barrier.rollback()
      return closed
    } finally {
      release?.()
    }
  }

  async function confirmCloseMany(paths: string[]): Promise<boolean> {
    const release = opts.mutationLock?.acquire(toMutationPaths(paths)) ?? null
    if (opts.mutationLock && !release) return false
    try {
      const barrier = await prepareDocumentClose(paths)
      const confirmed = await confirmCloseManyState(paths)
      if (confirmed) barrier.commit()
      else barrier.rollback()
      return confirmed
    } finally {
      release?.()
    }
  }

  async function closeMany(paths: string[]): Promise<boolean> {
    if (!(await confirmCloseMany(paths))) return false
    await discardDocumentDrafts(paths)
    closeManyConfirmed(paths)
    return true
  }

  function closeManyConfirmedWithDrafts(paths: string[]): void {
    void discardDocumentDrafts(paths)
    closeManyConfirmed(paths)
  }

  async function runTabExternalRenameTransaction(
    from: string,
    to: string,
    isCurrent: () => boolean,
    apply: () => Promise<boolean>,
  ): Promise<boolean> {
    const paths = [from, to]
    const release = opts.mutationLock?.acquire(toMutationPaths(paths)) ?? null
    if (opts.mutationLock && !release) return false
    let barrier: Awaited<ReturnType<typeof prepareDocumentClose>> | null = null
    try {
      barrier = await prepareDocumentClose(paths)
      const confirmed = await confirmCloseManyState([from])
      if (!confirmed || !isCurrent()) {
        barrier.rollback()
        return false
      }
      const applied = await apply()
      if (!applied) {
        barrier.rollback()
        return false
      }
      barrier.commit()
      return applied
    } catch {
      barrier?.rollback()
      return false
    } finally {
      release?.()
    }
  }

  const {
    handleOnline,
    pollExternalChanges,
    resolveExternal,
    startExternalPolling,
    stopExternalPolling,
    invalidateDiskRead,
    invalidateDiskObservation,
  } = useDiskFileChanges({ tabs, doSave, scheduleSave, applyPostSummary, fileChanges })

  const { onKeydown } = useEditorShortcuts({
    tabs,
    activePath,
    doSaveNow,
    closeTab,
    selectTab,
    selectFilesPanel: () => opts.selectPanel('files'),
    toggleViewMode: opts.toggleViewMode,
    workspaceShortcuts: opts.workspaceShortcuts,
  })

  const deferredDiaryTabs: string[] = []

  function needsDiaryAccess(path: string): boolean {
    return classifyDiaryPath(path) === 'managed'
      && Boolean(opts.isDiaryAccessReady)
      && !opts.isDiaryAccessReady!()
  }

  async function openAuthorizedPost(
    path: string,
    openOptions: { refresh?: boolean } = {},
  ): Promise<void> {
    if (needsDiaryAccess(path)) {
      const granted = opts.authorizeDocumentPath ? await opts.authorizeDocumentPath(path) : false
      if (!granted) {
        opts.onDiaryAccessCancelled?.(path)
        return
      }
    }
    await openWorkspacePost(path, openOptions)
  }

  async function restoreAuthorizedTab(path: string): Promise<boolean> {
    if (needsDiaryAccess(path)) {
      if (!deferredDiaryTabs.includes(path)) deferredDiaryTabs.push(path)
      return true
    }
    return restoreWorkspaceTab(path)
  }

  async function resumeDeferredDiaryTabs(): Promise<void> {
    // Do not manufacture a path merely to probe the access gate. The
    // capability readiness callback is the direct owner of this decision;
    // a representative Diary date could be misleading if path rules ever
    // change independently of the access state.
    if (opts.isDiaryAccessReady && !opts.isDiaryAccessReady()) return
    const paths = [...new Set(deferredDiaryTabs.splice(0))]
    for (const path of paths) {
      const restored = await restoreWorkspaceTab(path)
      // A deferred tab can be the document that owns the current route. In
      // that case restoring the tab must also restore route-led activation;
      // otherwise the tab appears in the strip but remains unselected while
      // the router still points at it. Do not activate a deferred tab if the
      // user has navigated elsewhere while access was being granted.
      if (restored && routePath.value === path) activePath.value = path
    }
  }

  function clearManagedDiaryWorkspace(): void {
    const paths = tabs.value
      .filter((tab) => classifyDiaryPath(tab.path) === 'managed')
      .map((tab) => tab.path)
    if (!paths.length) return
    clearSensitiveState(paths)
    closeManyConfirmed(paths)
  }

  async function onCommandPaletteNew(title: string) {
    const trimmed = (title ?? '').trim()
    if (!trimmed) return
    const parent = activePath.value ? activePath.value.replace(/\/[^/]+$/, '') : ''
    const filename = toLocalSlug(trimmed)
    if (!filename || !isSlugSegment(filename)) {
      toast.error(t('common.name_invalid'))
      return
    }
    const newPath = parent ? `${parent}/${filename}` : filename
    try {
      let created: PostSummary
      if (opts.createDocument) {
        created = await opts.createDocument({ path: newPath, title: trimmed })
      } else {
        created = await createPost({ path: newPath, title: trimmed })
        fileChanges.publish({ path: created.path, kind: 'write', source: 'editor-lifecycle' })
        try {
          await refresh()
        } catch (error) {
          console.warn(`[useEditorTabs] Created ${created.path}, but Vault refresh failed`, error)
        }
      }
      await openAuthorizedPost(created.path, { refresh: false })
      toast.success(t('common.created', { path: created.path }))
    } catch (e) {
      toast.error(t('common.create_failed', { error: (e as Error).message }))
    }
  }

  const { applyLifecycleReferenceWrites, subscribeToFileChanges } = useExternalFileChanges({
    fileChanges,
    tabs,
    activePath,
    closeTab,
    runTabRenameTransaction: runTabExternalRenameTransaction,
    renameOpenDocument: (from, to) => renameOpenDocuments([{ from, to }]),
    // External deletion is not an explicit user discard. Edit-09.5 decides
    // orphan/migration behavior; this stage must preserve its draft.
    removeOpenDocument: (path) => closeManyConfirmed([path]),
    openPost: openAuthorizedPost,
    navigateTo: (path) => { navigateTo(path) },
    confirm,
    toastInfo: toast.info,
    invalidateDiskRead,
    invalidateDiskObservation,
    prepareWorkspaceRename: opts.prepareWorkspaceRename,
  })

  const { routePath } = useRouteSync({ activePath, openPost: openAuthorizedPost })
  let disposed = false
  let stopFileChangeSubscription: (() => void) | null = null

  // Initial load: capture the route-led intent before any asynchronous
  // restore work, refresh the tree + posts, then restore any tabs persisted
  // from the previous session. A document route is the initialization
  // authority; persisted active state only owns navigation from the bare
  // /vault home.
  // Order matters:
  //   0. Capture routePath before restore can issue a router.replace().
  //   1. refresh() — needed for getPost calls inside restoreOneTab.
  //   2. Restore persisted tabs. Each path is probed via getPost so
  //      a deleted/renamed file silently drops out (and is reported
  //      in one aggregate toast). Restore is capped at TAB_HARD_LIMIT
  //      to match the runtime cap, so we never end up with more tabs
  //      than the UI accepts.
  //   3. If a route intent was captured, open it additively (or reactivate
  //      the restored tab) without first navigating to the persisted active.
  //      Otherwise restore the persisted active from /vault.
  // The routePath watcher (no `immediate: true`) handles subsequent
  // URL changes; we don't want it to also fire on mount or we'd
  // double-open.
  onMounted(async () => {
    const initialRoutePath = routePath.value
    window.addEventListener('beforeunload', handleBeforeUnload)
    window.addEventListener('online', handleOnline)
    await refresh()
    if (disposed) return
    // VaultView is mounted only after the protected identity gate has
    // resolved a non-null authoritative id. Read that already-resolved
    // value directly; tab persistence has no network or late identity
    // resolution step of its own.
    const saved = readPersistedTabs(vaultId.value)
    if (saved && saved.paths.length > 0) {
      const missing: string[] = []
      const toRestore = saved.paths.slice(0, TAB_HARD_LIMIT)
      for (const p of toRestore) {
        const ok = await restoreAuthorizedTab(p)
        if (disposed) return
        if (!ok) missing.push(p)
      }
      if (!initialRoutePath && tabs.value.length > 0) {
        // Prefer the saved active if it survived restore; otherwise
        // fall back to the first restored tab (left-to-right reading
        // order matches the persisted order).
        const target = saved.active && tabs.value.some((t) => t.path === saved.active)
          ? saved.active
          : tabs.value[0].path
        activePath.value = target
        navigateTo(target)
      }
      if (missing.length > 0) {
        const sample = missing.slice(0, 3).map((p) => `· ${p}`).join('\n')
        const more = missing.length > 3 ? t('editor.missing_more', { count: missing.length - 3 }) : ''
        toast.info(t('editor.missing_tabs', { count: missing.length, paths: sample, more }))
      }
    }

    if (initialRoutePath) {
      await openAuthorizedPost(initialRoutePath)
      if (disposed) return
    }
    // Subscribe to the file-change bus so AI tool writes/deletes/
    // renames get reflected in any open tab. The bus ref is stable
    // for the lifetime of this Vault instance (so a watcher set up
    // before any publish can still track it correctly).
    stopFileChangeSubscription = subscribeToFileChanges()
  })

  onBeforeUnmount(() => {
    disposed = true
    stopFileChangeSubscription?.()
    stopFileChangeSubscription = null
    window.removeEventListener('beforeunload', handleBeforeUnload)
    window.removeEventListener('online', handleOnline)
    stopExternalPolling()
    disposeDocumentSave()
    void draftPersistence.dispose()
    disposeTabPersistence()
  })

  startExternalPolling()

  return {
    tree,
    treeLoading,
    treeError,
    vaultId,
    posts,
    tabs,
    activePath,
    activeTab,
    isDirty,
    activeSize,
    refresh,
    applyPostSummary,
    openPost: openAuthorizedPost,
    closeTab,
    closeMany,
    confirmCloseMany,
    closeManyConfirmed: closeManyConfirmedWithDrafts,
    clearManagedDiaryWorkspace,
    resumeDeferredDiaryTabs,
    reorderOpenDocuments,
    renameOpenDocuments,
    removeOpenDocuments,
    applyLifecycleReferenceWrites,
    selectTab,
    onEditorChange,
    applyRecoveredDraft,
    doSaveNow,
    prepareHistoryCommit,
    prepareHistoryRestore,
    prepareDocumentMutation,
    getAuthTransitionSnapshot,
    prepareAuthTransition,
    saveAllForActiveLogout,
    resolveExternal,
    pollExternalChanges,
    onKeydown,
    onCommandPaletteNew,
  }
}

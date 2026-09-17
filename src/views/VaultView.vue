<script setup lang="ts">
import { ref, inject, shallowRef, watch, computed, defineAsyncComponent, onBeforeUnmount, onMounted, nextTick } from 'vue'
import { useStorage } from '@vueuse/core'
import { useRoute } from 'vue-router'
import { useShortcutDisplay } from '../composables/useShortcutDisplay'
import { useVaultLayout } from '../composables/vault/useVaultLayout'
import { useSplitterDrag } from '../composables/vault/useSplitterDrag'
import { useToast } from '../composables/useToast'
import { NUVYN_BROWSER_STORAGE_KEYS } from '../technicalNamespace'
import { isNuvynShortcutBlocked } from '../lib/keyboard'
import { useConfirm } from '../composables/useConfirm'
import { useI18n } from '../composables/useI18n'
import { useAuth, type WorkspaceAuthTransitionAdapter } from '../composables/useAuth'
import { useEditorTabs } from '../composables/vault/useEditorTabs'
import { createDraftStore } from '../composables/vault/draft-recovery/draftStore'
import { createUnsavedDraftPersistence } from '../composables/vault/draft-recovery/useUnsavedDraftPersistence'
import { createServerDocumentPathResolver } from '../composables/vault/draft-recovery/serverDocumentResolver'
import {
  createUnsavedDraftRecovery,
  hasUnsafeOpenDraftDocument,
} from '../composables/vault/draft-recovery/useUnsavedDraftRecovery'
import { useDraftRecoveryTabs } from '../composables/vault/draft-recovery/useDraftRecoveryTabs'
import { createDraftRecoveryManagement } from '../composables/vault/draft-recovery/useDraftRecoveryManagement'
import { createDraftRecoveryOperationProtection } from '../composables/vault/draft-recovery/useDraftRecoveryOperationProtection'
import { recoveryRecordId } from '../composables/vault/draft-recovery/draftCleanup'
import { deriveDocumentSavePresentation } from '../composables/vault/editor-tabs/savePresentation'
import { useHistory } from '../composables/vault/useHistory'
import { useHistoryCommit } from '../composables/vault/useHistoryCommit'
import { useHistoryWithdraw } from '../composables/vault/useHistoryWithdraw'
import { resolveFileHistoryTarget, useFileHistory } from '../composables/vault/useFileHistory'
import { createPathMutationLock } from '../composables/vault/pathMutationLock'
import {
  useHistoryRestore,
  type HistoryRestoreRequest,
  type HistoryRestoreSource,
} from '../composables/vault/useHistoryRestore'
import {
  getLoadedEditorDocument,
  useHistoryComparisons,
  type HistoryComparison,
  type HistoryRevisionSelection,
} from '../composables/vault/useHistoryComparisons'
import { useWorkingTreeDiffs } from '../composables/vault/useWorkingTreeDiffs'
import type { StatusEntry } from '../lib/history-api'
import { useScopeFilter } from '../composables/vault/useScopeFilter'
import { clearLinkIndex, getLinkIndex, refreshLinkIndex, useLinkIndexSubscription } from '../composables/vault/useLinkIndex'
import { createDiaryDate, getPost, type DocumentMetadata, type PostSummary } from '../lib/api'
import { formatHistoryDate } from '../lib/history-date'
import { isSlugSegment } from '../lib/slug'
import { resolveWikiTarget } from '../../shared/linkResolve'
import { VaultViewModeKey } from '../composables/vault/viewMode'
import {
  captureAiLiveContext,
  liveEditorForPath,
  type AiLiveContextCapture,
} from '../composables/vault/aiLiveContext'
import { invalidateDocumentSearchState } from '../lib/searchResults'
import { documentSearchSource } from '../lib/documentSearchSource'
import { createVaultContext } from '../composables/vault/context/createVaultContext'
import { provideVaultContext } from '../composables/vault/context/useVaultContext'
import { createVaultFileChanges } from '../composables/vault/context/fileChanges'
import { useDocumentLifecycle } from '../composables/vault/useDocumentLifecycle'
import type { DocumentLifecycle } from '../composables/vault/useDocumentLifecycle'
import { applyMetadataToPostSummary } from './metadataPostSummary'
import { useDiaryDateCommand, type DiaryDateCommandResult } from '../composables/diary/useDiaryDateCommand'
import { useDiaryMoodCommand } from '../composables/diary/useDiaryMoodCommand'
import { useDiaryMoodIconPreferences } from '../composables/diary/useDiaryMoodIconPreferences'
import { useDiaryWorkspacePresentation } from '../composables/diary/useDiaryWorkspacePresentation'
import {
  captureDiarySessionGeneration,
  isDiarySessionGenerationCurrent,
  subscribeDiaryTeardown,
  useDiaryAccessSession,
} from '../composables/diary/useDiaryAccessSession'
import { DiaryAccessContextKey } from '../composables/diary/diaryAccessContext'
import { AppShellContextKey } from '../composables/appShellContext'
import { localCivilToday } from '../components/diary/diaryCalendarAdapter'
import { classifyDiaryPath, diaryLogicalPathForDate, type DiaryDate } from '../../shared/diaryProtocol'
import { scopeRootsFor } from '../../shared/scopeProtocol'
import type { DiaryMoodId as MoodId } from '../../shared/diaryMood'
import { handleDiaryHomeKeydown } from './diaryHomeKeyboard'
import { createDiaryShortcutChord, isDiaryShortcutBlocked, isDiaryTextEntryContext } from './diaryShortcutChord'
import FileTree from '../components/vault/FileTree.vue'
import DiaryWorkspace from '../components/diary/DiaryWorkspace.vue'
import DiaryCalendarSurface from '../components/diary/DiaryCalendarSurface.vue'
import TagPanel from '../components/vault/TagPanel.vue'
import TagManagementPanel from '../components/vault/TagManagementPanel.vue'
import ReadingPane from '../components/vault/ReadingPane.vue'
import PdfExportSurface from '../components/vault/PdfExportSurface.vue'
import RightRail from '../components/vault/RightRail.vue'
import EmptyState from '../components/vault/EmptyState.vue'
import ActivityBar from '../components/vault/ActivityBar.vue'
import SettingsModal from '../components/vault/SettingsModal.vue'
import type { MetadataContext } from '../components/vault/metadataDraftStore'
import HistoryPanel from '../components/vault/HistoryPanel.vue'
import HistoryComparisonPane from '../components/vault/HistoryComparisonPane.vue'
import WorkingTreeDiffPane from '../components/vault/WorkingTreeDiffPane.vue'
import DraftRecoveryPrompt from '../components/vault/DraftRecoveryPrompt.vue'
import DraftRecoveryPane from '../components/vault/DraftRecoveryPane.vue'
import DraftRecoveryCenter from '../components/vault/DraftRecoveryCenter.vue'
import EditorTabs, {
  type WorkspaceTabReorderRequest,
} from '../components/vault/EditorTabs.vue'
import {
  closeManyWorkspaceTabState,
  closeWorkspaceTabState,
} from '../components/vault/workspaceClose'
import type { WorkspaceTab } from '../components/vault/tabs'
import {
  applyWorkspaceTabOrder,
  migrateWorkspaceTabIds,
  reconcileWorkspaceTabOrder,
} from '../components/vault/workspaceTabOrder'
import {
  focusedWorkspaceTabId,
  restoreRenamedWorkspaceTabFocus,
} from '../components/vault/workspaceTabFocus'
import {
  copyTextToClipboard,
  revealWorkspacePath,
} from '../components/vault/workspaceTabActions'
import { disposeManagedDiaryModels } from '../components/vault/monacoModels'
import StatusBar from '../components/vault/StatusBar.vue'
import { requireVaultId } from '../lib/vault-identity'
import {
  downloadPdfDocument,
  preparePdfArticleHtml,
  resolvePdfDocumentLabel,
} from '../lib/pdfExport'
import { waitForPdfImages } from '../lib/pdf-images'
import { pdfEnhancementsReady } from '../lib/pdf-readiness'
import {
  listManagedTags,
  type ManagedTag,
  type TagOperationApplyResult,
  type TagOperationRequest,
} from '../lib/tag-management-api'
import {
  getUndoAvailability,
  recoverCommittedUndo as recoverCommittedUndoStatus,
  type UndoApplyResult,
  type UndoAvailability,
} from '../lib/tag-undo-api'
import {
  reconcileCommittedUndoTagSelection,
  reconcileCommittedTagSelectionFromOperation,
  reconcileUndoTagSelection,
  reconcileTagSelection,
  type TagSelectionSnapshot,
} from '../lib/tag-selection-reconciliation'

// Monaco is the heaviest client dependency. Load it only when edit mode
// actually mounts an editor, keeping navigation/read-only startup lean.
const EditorPane = defineAsyncComponent(() => import('../components/vault/EditorPane.vue'))

const settingsOpen = ref(false)
const appShell = inject(AppShellContextKey, null)
const route = useRoute()
// The layout composable owns the grid tracks. VaultView only supplies the
// current presentation visibility, so Calendar Home can remove the activity
// and side-panel columns without a Diary-specific CSS offset.
const sidebarLayoutVisible = ref(true)
const statusBarLayoutVisible = ref(true)
const editorFocusWidthKey = NUVYN_BROWSER_STORAGE_KEYS.editorFocusWidth
const fileTreeFilterKey = NUVYN_BROWSER_STORAGE_KEYS.fileTreeFilter
const diaryFilterSeedKey = NUVYN_BROWSER_STORAGE_KEYS.diaryFilterSeed
const diaryFilterOwnershipKey = NUVYN_BROWSER_STORAGE_KEYS.diaryFilterOwnership
const editorFocusWidth = useStorage(editorFocusWidthKey, true)
const emit = defineEmits<{
  logout: []
}>()

/* Platform-aware shortcut display for the empty-state hint chips.
   Computed once at module load (see useShortcutDisplay), so this
   just hands back the same `{ isMac, format }` for the whole
   session. */
const shortcuts = useShortcutDisplay()

/* Both edit-mode and read-mode render the same "no file open"
   empty card when `tabs.length === 0`. The action list lives here
   so the label / shortcut keys only need to be edited once and the
   template can `v-for` over them. The `.content-empty` wrapper
   around the card still owns the absolute-fill centering in either
   mode, so this list only describes the card body. */
/* View mode is provided globally by App.vue (see VaultViewModeKey).
   Default to 'edit' so this view still renders sensibly if it's ever
   mounted outside the App provider (e.g. in a unit test harness). */
const viewModeApi = inject(VaultViewModeKey, null)
const isReadMode = computed(() => viewModeApi?.mode.value === 'read')

/* ---------- Layout ---------- */
const {
  activePanel,
  sidePanelOpen,
  leftSidebarVisible,
  sidePanelWidth,
  rightRailWidth,
  vaultStyle,
  selectPanel,
  rightRailTab,
  rightRailCollapsed,
} = useVaultLayout({
  sidebarVisible: sidebarLayoutVisible,
  statusBarVisible: statusBarLayoutVisible,
})

/* Splitter drag lives in its own composable — it mutates the same
   width/ratio refs useVaultLayout returns, so the grid updates
   synchronously as the user drags. */
const { startDrag } = useSplitterDrag({
  sidePanelWidth,
  rightRailWidth,
})

/* The unified rail remains available in edit and read modes. */
const rightRailVisible = computed(() => !rightRailCollapsed.value)
// Side-panel filters are temporary view state. Keep the Files value here so
// switching to Tags or History can unmount FileTree without losing it.
const filesFilter = useStorage(fileTreeFilterKey, '')
const tagsFilter = ref('')
/* The splitter is a grid child only when the rail is visible. In the
   collapsed state the chevron affordance is rendered as an absolutely-
   positioned button pinned to the vault's right edge (see template
   below) — putting it in the grid would either force an extra column
   (creating a 1px gray strip where the rail used to be) or, with the
   default grid-auto-flow: row, wrap the splitter to row 2 (status
   bar), which is what produced the gray area the user reported. */
const toast = useToast()
const { confirm, confirmCancellable } = useConfirm()
const { locale, t } = useI18n()
const auth = useAuth()
const diaryAccess = useDiaryAccessSession()
const diaryAccessContext = inject(DiaryAccessContextKey, null)
const { activeScope, selectScope } = useScopeFilter()

const searchablePosts = computed(() => {
  const roots = scopeRootsFor(activeScope.value)
  return posts.value.filter((post) => roots.some((root) => (
    post.path === root || post.path.startsWith(`${root}/`)
  )))
})

async function authorizeDiaryDocumentPath(path: string): Promise<boolean> {
  if (classifyDiaryPath(path) !== 'managed') return true
  const granted = diaryAccessContext
    ? await diaryAccessContext.requestAccess()
    : diaryAccess.isUnlocked.value || (await diaryAccess.ensureStatus()) === 'UNLOCKED'
  if (granted) selectScope('diary')
  return granted
}

const emptyActions = computed(() => [
  { label: t('vault.command_palette'), keys: shortcuts.format('mod+P') },
  { label: t('vault.toggle_sidebar'), keys: shortcuts.format('mod+B') },
])

// Lives in VaultView (not the composable) so the string `ref="vaultRef"`
// template binding resolves cleanly. startDrag takes the host as a parameter.
const vaultRef = shallowRef<HTMLElement | null>(null)
const editorTabsRef = ref<InstanceType<typeof EditorTabs> | null>(null)
const fileTreeRef = ref<InstanceType<typeof FileTree> | null>(null)
const diaryCalendarSurfaceRef = ref<{
  focusDate: (date: DiaryDate) => boolean
  closeMoodPicker: (restoreFocus?: boolean) => void
  clearSelection: () => void
} | null>(null)
const comparisonPaneRef = ref<InstanceType<typeof HistoryComparisonPane> | null>(null)
const workingTreeDiffPaneRef = ref<InstanceType<typeof WorkingTreeDiffPane> | null>(null)
const recoveryPaneRef = ref<InstanceType<typeof DraftRecoveryPane> | null>(null)
const workspaceTabOrder = ref<string[]>([])
function switchToReadMode() { viewModeApi?.set('read') }

/* ---------- Tabs / save / route sync ---------- */
const fileChanges = createVaultFileChanges()
const historyMutationLock = createPathMutationLock()
const draftStore = createDraftStore()
// Background quarantine healing settles outside any user-visible
// transaction: a queued family move can complete (or record a
// candidate) long after the rename UI finished, leaving Recovery
// items and open tabs on the stale path. Refresh the identity when a
// settlement lands. `draftRecovery` is created later in this setup
// but the callback only fires from timers/flushes after setup
// completes, so the closure is TDZ-safe.
// Background quarantine healing settles outside any user-visible
// transaction: a queued family move can complete (or record a
// candidate) long after the rename UI finished, leaving Recovery
// items and open tabs on the stale path. Refresh the identity AND
// every open Recovery tab so they follow the family — mirroring
// onDraftTransactionSettled's identity + open-tabs sync, but for
// the background-heal path. The closure is TDZ-safe: the callback
// only fires from timers/flushes after setup completes.
async function refreshRecoveryAfterFamilySettle(settlement: {
  vaultId: string
  documentId: string
}): Promise<void> {
  await draftRecovery.refreshIdentity(settlement.vaultId, settlement.documentId)
  // Refresh every open tab for this identity, not just the first.
  // After a move or re-classification a primary plus multiple
  // conflict tabs may all show a stale path/body/classification.
  for (const tab of recoveryTabs.tabs.value.filter(
    (candidate) => candidate.documentId === settlement.documentId,
  )) {
    const view = tab.view
    const refreshed = draftRecovery.items.value.find((candidate) => (
      candidate.recoveryId === tab.recoveryId
    ))
    if (refreshed?.status === 'ready') {
      recoveryTabs.open(refreshed, view)
    } else if (!refreshed) {
      recoveryTabs.close(tab.tabId)
    }
  }
}
const draftPersistence = createUnsavedDraftPersistence({
  store: draftStore,
  // Authoritative by-stable-identity server lookup for an emptied
  // draft family: the retry must re-validate the document's CURRENT
  // path against the server (never a cached tree / Tab / posts path)
  // before minting a primary, and authenticate the mint afterwards.
  resolveCurrentDocumentPath: createServerDocumentPathResolver(),
  onIssue: (issue) => {
    if (issue.kind === 'draft-too-large') {
      toast.info(t('draft_recovery.too_large'), 6000)
    } else if (issue.kind === 'storage-write-failed') {
      toast.info(t('draft_recovery.storage_write_failed'), 6000)
    }
  },
  onDraftFamilyMoveSettled: (settlement) => {
    if (settlement.status === 'moved-write-failed') {
      // The family is whole at the new path but the latest edit's
      // primary write was rejected — the newest content is still only
      // in memory. The tab stays open and the write keeps retrying;
      // warn so the user knows a crash or refresh right now could
      // lose the latest edit (the refresh below alone would only
      // silently follow the family).
      toast.info(t('draft_recovery.family_settle_persist_warning'), 6000)
    }
    void refreshRecoveryAfterFamilySettle(settlement)
  },
})
const authoritativeVaultId = requireVaultId()
let lifecycleCreateFile: DocumentLifecycle['createFile'] | null = null
const {
  tree, treeLoading, treeError, vaultId, posts, tabs, activePath, activeTab, activeSize,
  refresh, applyPostSummary, openPost: openEditorPost, closeTab: closeEditorTab,
  confirmCloseMany: confirmCloseEditorTabs,
  closeManyConfirmed: closeManyEditorTabsConfirmed,
  selectTab: selectEditorTab, onEditorChange, applyRecoveredDraft, doSaveNow, resolveExternal,
  prepareHistoryRestore, onKeydown: onEditorKeydown,
  prepareHistoryCommit,
  prepareDocumentMutation, renameOpenDocuments, removeOpenDocuments,
  reorderOpenDocuments,
  applyLifecycleReferenceWrites,
  getAuthTransitionSnapshot,
  prepareAuthTransition,
  saveAllForActiveLogout,
  clearManagedDiaryWorkspace,
  resumeDeferredDiaryTabs,
} = useEditorTabs({
  vaultId: authoritativeVaultId,
  selectPanel,
  toggleViewMode: () => viewModeApi?.toggle(),
  fileChanges,
  mutationLock: historyMutationLock,
  workspaceShortcuts: false,
  prepareWorkspaceRename,
  createDocument: (input) => {
    if (!lifecycleCreateFile) throw new Error('document lifecycle is not ready')
    return lifecycleCreateFile(input)
  },
  draftStore,
  draftPersistence,
  authorizeDocumentPath: authorizeDiaryDocumentPath,
  isDiaryAccessReady: () => diaryAccess.isUnlocked.value,
})

watch(searchablePosts, (next) => {
  documentSearchSource.replace(next)
})

watch(() => diaryAccess.state.value, (next) => {
  if (next === 'UNLOCKED') {
    void resumeDeferredDiaryTabs()
    return
  }
  clearManagedDiaryWorkspace()
  recoveryTabs.deactivate()
  historyComparisons.deactivate()
  workingTreeDiffs.deactivate()
  selectScope('note')
})

function restoreRenamedTabFocus(
  focusedId: string | null,
  mappings: ReadonlyArray<{ from: string; to: string }>,
  expectedFocus?: Element | null,
): void {
  void restoreRenamedWorkspaceTabFocus(
    focusedId,
    mappings,
    (id) => editorTabsRef.value?.focusTab(id),
    expectedFocus,
  )
}

function prepareWorkspaceRename(from: string, to: string): () => void {
  const focusedId = focusedWorkspaceTabId()
  const focusedElement = document.activeElement
  return () => {
    workspaceTabOrder.value = reconcileWorkspaceTabOrder(
      migrateWorkspaceTabIds(workspaceTabOrder.value, [{ from, to }]),
      naturalWorkspaceTabIds.value,
    )
    if (document.activeElement === focusedElement) {
      restoreRenamedTabFocus(focusedId, [{ from, to }], focusedElement)
    }
  }
}

function renameWorkspaceDocuments(
  mappings: ReadonlyArray<{ from: string; to: string }>,
): void {
  const focusedId = focusedWorkspaceTabId()
  const focusedElement = document.activeElement
  workspaceTabOrder.value = migrateWorkspaceTabIds(workspaceTabOrder.value, mappings)
  renameOpenDocuments(mappings)
  restoreRenamedTabFocus(focusedId, mappings, focusedElement)
}

const documentLifecycle = useDocumentLifecycle({
  fileChanges,
  mutationLock: historyMutationLock,
  prepareDocumentMutation,
  getOpenDocumentPaths: () => tabs.value.map((tab) => tab.path),
  applyReferenceWrites: applyLifecycleReferenceWrites,
  renameOpenDocuments: renameWorkspaceDocuments,
  removeOpenDocuments,
  refresh,
  async resolveDocumentIdentity(path) {
    const currentVaultId = vaultId.value
    if (!currentVaultId) return null
    const loaded = tabs.value.find((tab) => (
      tab.path === path
      && !tab.loading
      && !tab.loadError
      && Boolean(tab.documentId)
    ))
    if (loaded?.documentId) {
      return {
        vaultId: currentVaultId,
        documentId: loaded.documentId,
        documentPath: path,
      }
    }
    try {
      const post = await getPost(path)
      const documentId = post.metadata?.id
      return documentId
        ? { vaultId: currentVaultId, documentId, documentPath: post.path }
        : null
    } catch {
      return null
    }
  },
  prepareDraftFileMutation: (identities) => (
    draftPersistence.prepareFileMutation(identities)
  ),
  captureDraftDeleteConfirmation(path) {
    const currentVaultId = vaultId.value
    const tab = tabs.value.find((candidate) => (
      candidate.path === path
      && !candidate.loading
      && !candidate.loadError
      && Boolean(candidate.documentId)
    ))
    const recovery = draftRecovery.items.value.find((item) => (
      item.draft.vaultId === currentVaultId
      && item.draft.documentPath === path
    ))
    const documentId = tab?.documentId ?? recovery?.draft.documentId
    if (!currentVaultId || !documentId) return null
    // Freeze every conflict candidate currently discovered for this
    // identity so a confirmed discard removes them from the conflict
    // store too (otherwise they resurface on the next refresh).
    const expectedConflictIds = draftRecovery.items.value
      .filter((item) => (
        item.source === 'conflict'
        && item.conflict !== null
        && item.draft.vaultId === currentVaultId
        && item.draft.documentId === documentId
      ))
      .map((item) => item.conflict?.conflictId)
      .filter((id): id is string => typeof id === 'string')
    return draftPersistence.captureDeleteConfirmation({
      vaultId: currentVaultId,
      documentId,
      documentPath: path,
    }, tab?.revision ?? 0, recovery?.draft, expectedConflictIds)
  },
  async findDraftsByPaths(paths) {
    const currentVaultId = vaultId.value
    if (!currentVaultId) return []
    const wanted = new Set(paths)
    const [drafts, conflicts] = await Promise.all([
      draftStore.listDrafts(currentVaultId),
      draftStore.listConflictDrafts(currentVaultId),
    ])
    const identities = [
      ...draftPersistence.findTrackedIdentitiesByPaths(paths),
      ...drafts
        .filter((draft) => wanted.has(draft.documentPath))
        .map((draft) => ({
          vaultId: draft.vaultId,
          documentId: draft.documentId,
          documentPath: draft.documentPath,
        })),
      // A document may have only conflict candidates (no primary record);
      // scanning the conflict store lets rename/delete resolve its
      // identity instead of silently ignoring it.
      ...conflicts
        .filter((conflict) => wanted.has(conflict.documentPath))
        .map((conflict) => ({
          vaultId: conflict.vaultId,
          documentId: conflict.documentId,
          documentPath: conflict.documentPath,
        })),
    ]
    return [...new Map(identities.map((identity) => (
      [`${identity.vaultId}\0${identity.documentId}`, identity]
    ))).values()]
  },
  warnDraftTransaction(results) {
    toast.info(t('draft_recovery.file_transaction_warning', {
      count: results.length,
    }))
  },
  async onDraftTransactionSettled(results) {
    const currentVaultId = vaultId.value
    if (!currentVaultId) return
    for (const transaction of results) {
      if (transaction.status === 'deleted'
        || (transaction.status === 'missing' && transaction.newPath === undefined)) {
        // The confirmed discard already removed the frozen conflict
        // records from the store; drop every recovery item AND close
        // every open tab for this identity. A document owns one primary
        // item plus possibly several conflict items, each with its own
        // tab — closing only the first item's tab would leave stale
        // conflict tabs open.
        draftRecovery.removeIdentity(currentVaultId, transaction.documentId)
        for (const tab of recoveryTabs.tabs.value.filter(
          (candidate) => candidate.documentId === transaction.documentId,
        )) recoveryTabs.close(tab.tabId)
        continue
      }
      await draftRecovery.refreshIdentity(currentVaultId, transaction.documentId)
      // Refresh every open tab for this identity, not just the first.
      // After a move or re-classification a primary plus multiple
      // conflict tabs may all show a stale path/body/classification.
      for (const tab of recoveryTabs.tabs.value.filter(
        (candidate) => candidate.documentId === transaction.documentId,
      )) {
        const view = tab.view
        const refreshed = draftRecovery.items.value.find((candidate) => (
          candidate.recoveryId === tab.recoveryId
        ))
        if (refreshed?.status === 'ready') {
          recoveryTabs.open(refreshed, view)
        } else if (!refreshed) {
          recoveryTabs.close(tab.tabId)
        }
      }
    }
  },
})
lifecycleCreateFile = documentLifecycle.createFile
// AI live workspace context (Edit-10.2): the context is created before the
// history / diff / recovery viewers exist, so the capture delegate starts
// fail-closed (none) and is rebound to the real workspace state right after
// `activeWorkspaceTabId` is defined below. The context holds a stable arrow
// closure over this binding, and children only mount once setup completes,
// so capture() always sees the rebound delegate — while any early call
// still answers `none` safely.
let captureWorkspaceAiContext: () => AiLiveContextCapture = () => ({ status: 'none' })
const vaultContext = createVaultContext({
  vaultId,
  fileChanges,
  tabs,
  activePath,
  activeTab,
  openPost,
  captureAiContext: () => captureWorkspaceAiContext(),
  lifecycle: documentLifecycle,
})
provideVaultContext(vaultContext)
onBeforeUnmount(() => { vaultContext.dispose() })
const historyComparisons = useHistoryComparisons({
  getCurrentDocument(path) {
    return getLoadedEditorDocument(tabs.value, path)
  },
  async loadCurrentDocument(path) {
    try {
      return (await getPost(path)).raw
    } catch (error: any) {
      // A deleted working-tree file is an expected empty side for the
      // secondary revision → working-tree comparison. Other failures must
      // remain visible in the comparison error state.
      if (error?.status === 404) return { raw: '', dirty: false, exists: false }
      throw error
    }
  },
})
const activeHistoryComparison = historyComparisons.activeComparison
const workingTreeDiffs = useWorkingTreeDiffs()
const activeWorkingTreeDiff = workingTreeDiffs.activeDiff
const draftRecovery = createUnsavedDraftRecovery({ store: draftStore })
const recoveryTabs = useDraftRecoveryTabs()
const activeDraftRecovery = recoveryTabs.activeTab
const metadataContext = computed<MetadataContext>(() => {
  if (activeDraftRecovery.value) return 'recovery'
  if (activeHistoryComparison.value) return 'history'
  if (activeWorkingTreeDiff.value) return 'diff'
  return 'document'
})
const metadataReadonly = computed(() => metadataContext.value !== 'document')
const metadataPath = computed(() => (
  activeDraftRecovery.value?.documentPath
  ?? activeHistoryComparison.value?.documentPath
  ?? activeWorkingTreeDiff.value?.documentPath
  ?? activePath.value
))
const metadataSummaryContent = computed<string | null>(() => {
  if (metadataReadonly.value) return null
  const tab = activeTab.value
  return tab && tab.path === activePath.value ? tab.raw : null
})
const recoveryBusy = ref(false)
const recoveryOperationProtection = createDraftRecoveryOperationProtection()
const recoveryManagement = createDraftRecoveryManagement({
  store: draftStore,
  recovery: draftRecovery,
  getPersistenceProtection: (id) => draftPersistence.getDraftCleanupProtection(id),
  openRecoveryIds: computed(() => {
    const ids = new Set(recoveryTabs.tabs.value.map((tab) => tab.recoveryId))
    for (const id of recoveryOperationProtection.protectedIds.value) ids.add(id)
    if (recoveryBusy.value) {
      const active = draftRecovery.activeRecoveryId.value
        ?? draftRecovery.pendingItem.value?.recoveryId
      if (active) ids.add(active)
    }
    return [...ids]
  }),
  onRecordsRemoved(ids) {
    const removed = new Set(ids)
    for (const tab of recoveryTabs.tabs.value) {
      if (removed.has(tab.recoveryId)) recoveryTabs.close(tab.tabId)
    }
  },
})

let cancelActiveLogoutPrompt: (() => void) | null = null
async function confirmActiveLogout(
  message: string,
  detail: string,
  options: Parameters<typeof confirmCancellable>[2],
): Promise<boolean> {
  const pending = confirmCancellable(message, detail, options)
  cancelActiveLogoutPrompt = pending.cancel
  try {
    return await pending.promise
  } finally {
    if (cancelActiveLogoutPrompt === pending.cancel) cancelActiveLogoutPrompt = null
  }
}

/**
 * The workspace is the only owner that knows how editor saves and browser
 * recovery persistence fit together. Auth owns the session transition, but
 * it never reaches into these objects directly; this narrow adapter is the
 * handoff that keeps the two lifecycles ordered.
 */
const workspaceAuthTransition: WorkspaceAuthTransitionAdapter = {
  async prepareActiveLogout(isCurrent) {
    const preflight = getAuthTransitionSnapshot()
    if (preflight.unsafe.length > 0 || draftPersistence.hasPendingWrites()) {
      const confirmed = await confirmActiveLogout(
        t('auth.logout_pending'),
        t('auth.logout_pending'),
        {
          confirmLabel: t('auth.logout_anyway'),
          cancelLabel: t('common.cancel'),
          destructive: true,
        },
      )
      if (!confirmed || !isCurrent()) return { status: 'cancelled' }
    }

    const transition = await prepareAuthTransition('logout')
    try {
      if (!isCurrent()) {
        // A session-expiry event may have taken ownership while the
        // active-save phase was waiting. Do not resume autosave in that
        // case; expiry must flush drafts without starting another server
        // mutation.
        transition.release(false)
        return { status: 'cancelled' }
      }
      const saves = await saveAllForActiveLogout(isCurrent)
      if (!isCurrent()) {
        transition.release(false)
        return { status: 'cancelled' }
      }
      let flushed = false
      try {
        flushed = await draftPersistence.flushAll()
      } catch {
        flushed = false
      }
      const unsafe = saves.unsafe.length > 0 || !flushed
      // Never keep the editor barrier while asking the user what to do.
      // The App shell remains inert for the active transition, so releasing
      // here cannot create a new mutation before the decision is complete.
      transition.release(false)
      const ready = () => ({ status: 'ready' as const, resume: () => transition.release(true) })
      if (!unsafe) return ready()

      const confirmed = await confirmActiveLogout(
        !flushed ? t('auth.logout_flush_failed') : t('auth.logout_unsafe'),
        !flushed ? t('auth.logout_flush_failed') : t('auth.logout_unsafe'),
        {
          confirmLabel: t('auth.logout_anyway'),
          cancelLabel: t('common.cancel'),
          destructive: true,
        },
      )
      if (!confirmed || !isCurrent()) {
        // The barrier was deliberately released before this prompt. A
        // cancellation must nevertheless re-arm ordinary autosave for any
        // remaining dirty tabs.
        transition.release(isCurrent())
        return { status: 'cancelled' }
      }
      return ready()
    } catch (error) {
      transition.release(isCurrent())
      throw error
    }
  },

  async prepareSessionExpiry(isCurrent) {
    let transition = await prepareAuthTransition('expired')
    while (isCurrent()) {
      let flushed = false
      try {
        flushed = await draftPersistence.flushAll()
      } catch {
        flushed = false
      }
      transition.release(false)
      if (flushed || !isCurrent()) return { status: 'ready' }

      // Expiry cannot be cancelled back into an authenticated workspace. A
      // negative answer means retry the browser-only flush, not resume edits.
      const continueToLogin = await confirm(
        t('auth.expiry_flush_failed'),
        t('auth.expiry_flush_failed'),
        {
          confirmLabel: t('auth.continue_to_login'),
          cancelLabel: t('auth.retry_draft_flush'),
          destructive: true,
        },
      )
      if (continueToLogin || !isCurrent()) return { status: 'ready' }
      transition = await prepareAuthTransition('expired')
    }
    return { status: 'ready' }
  },
  cancelActiveLogout() {
    cancelActiveLogoutPrompt?.()
  },
}
const unregisterWorkspaceAuthTransition = auth.registerWorkspaceTransition(workspaceAuthTransition)
onBeforeUnmount(unregisterWorkspaceAuthTransition)

function recoveryItem(recoveryId: string) {
  return draftRecovery.items.value.find((item) => item.recoveryId === recoveryId) ?? null
}

async function openRecoveryView(
  recoveryId: string,
  view: 'content' | 'diff',
): Promise<void> {
  await withManagedRecoveryOperation(recoveryId, async () => {
    await draftRecovery.retry(recoveryId)
    const item = recoveryItem(recoveryId)
    if (!item || item.status !== 'ready') return
    historyComparisons.deactivate()
    workingTreeDiffs.deactivate()
    recoveryTabs.open(item, view)
    draftRecovery.dismissForSession(recoveryId)
  })
}

async function discardRecoveryDraft(recoveryId: string): Promise<void> {
  if (recoveryBusy.value) return
  recoveryBusy.value = true
  try {
    await withManagedRecoveryOperation(recoveryId, async () => {
      await draftRecovery.retry(recoveryId)
      const item = recoveryItem(recoveryId)
      if (!item || item.status !== 'ready') return
      if (hasUnsafeOpenDraftDocument(tabs.value, item.draft.documentId)) {
        toast.error(t('draft_recovery.delete_failed'))
        return
      }
      const deleted = item.source === 'conflict' && item.conflict
        ? await draftPersistence.discardConflict(
            item.conflict.vaultId,
            item.conflict.documentId,
            item.conflict.conflictId,
          )
        : await draftPersistence.discardIdentityIfUnchanged(item.draft)
      if (!deleted) {
        toast.error(t('draft_recovery.delete_failed'))
        return
      }
      const openTabIds = recoveryTabs.tabs.value
        .filter((tab) => tab.recoveryId === recoveryId)
        .map((tab) => tab.tabId)
      if (item.source === 'conflict') {
        await draftRecovery.refreshIdentity(item.draft.vaultId, item.draft.documentId)
      } else {
        draftRecovery.dismissForSession(recoveryId)
      }
      for (const tabId of openTabIds) await closeWorkspaceTab(tabId)
    })
  } finally {
    recoveryBusy.value = false
  }
}

async function restoreRecoveryDraft(recoveryId: string): Promise<void> {
  if (recoveryBusy.value) return
  recoveryBusy.value = true
  try {
    await withManagedRecoveryOperation(recoveryId, async () => {
    await draftRecovery.retry(recoveryId)
    const item = recoveryItem(recoveryId)
    const decision = item?.decision
    if (!item || item.status !== 'ready' || !decision) return
    if (item.source === 'conflict') {
      recoveryTabs.open(
        item,
        decision.disk.status === 'ready' ? 'diff' : 'content',
      )
      draftRecovery.dismissForSession(recoveryId)
      return
    }
    if (decision.kind !== 'baseline-match' || decision.disk.status !== 'ready') {
      recoveryTabs.open(
        item,
        decision.disk.status === 'ready' ? 'diff' : 'content',
      )
      draftRecovery.dismissForSession(recoveryId)
      return
    }

    recoveryTabs.deactivate()
    historyComparisons.deactivate()
    workingTreeDiffs.deactivate()
    // Open WITHOUT a workspace refresh: Recovery has already certified
    // this record through its stable identity and the current-document
    // interface, and the reclassification right below re-verifies it
    // after the open. A tree/posts refresh failure (a routine network
    // hiccup) must not reject the adoption — without `{ refresh: false }`
    // the refresh runs outside openPost's load try/catch and would
    // throw, aborting the whole startup Recovery loop.
    await openEditorPost(item.draft.documentPath, { refresh: false })
    // Opening the document crosses a network boundary. Refresh both the
    // stored draft and disk classification again before adopting any bytes.
    await draftRecovery.retry(recoveryId)
    const refreshed = recoveryItem(recoveryId)
    const refreshedDecision = refreshed?.decision
    if (!refreshed || refreshed.status !== 'ready'
      || !refreshedDecision
      || refreshedDecision.kind !== 'baseline-match'
      || refreshedDecision.disk.status !== 'ready') {
      if (refreshed?.status === 'ready' && refreshed.decision) {
        recoveryTabs.open(
          refreshed,
          refreshed.decision.disk.status === 'ready' ? 'diff' : 'content',
        )
        draftRecovery.dismissForSession(recoveryId)
      }
      return
    }
    const result = await applyRecoveredDraft({
      draft: refreshed.draft,
      expectedDiskRaw: refreshedDecision.disk.raw,
      expectedDiskMtime: refreshedDecision.disk.mtime,
    })
    if (result.status === 'applied') {
      draftRecovery.dismissForSession(recoveryId)
      toast.info(t('draft_recovery.auto_restored'), 4000)
      await nextTick()
      editorTabsRef.value?.focusTab(result.path)
      return
    }
    // Adoption may fail because the stored draft changed across its own
    // asynchronous checks. Refresh once more and show the latest classified
    // recovery bytes rather than the snapshot captured before adoption.
    await draftRecovery.retry(recoveryId)
    const latest = recoveryItem(recoveryId)
    if (latest?.status === 'ready' && latest.decision) {
      recoveryTabs.open(latest, 'content')
      draftRecovery.dismissForSession(recoveryId)
    }
    })
  } finally {
    recoveryBusy.value = false
  }
}

function updateRecoveryView(view: 'content' | 'diff'): void {
  if (activeDraftRecovery.value) activeDraftRecovery.value.view = view
}

// An ordinary recovery-storage read failure warns at most once per
// vault until the next successful read: the startup watcher can re-fire
// (vault switches, reconnect retries), and stacking identical notices
// would only train users to ignore them. The Center stays reachable
// from the recovery prompt's manage entry and renders its own error
// state with a retry button, so the toast is a hint, not the only
// entry point. A manual retry re-arms the notice for its own failure.
const warnedRecoveryReadVaults = new Set<string>()
function warnRecoveryReadFailure(vaultId: string): void {
  if (warnedRecoveryReadVaults.has(vaultId)) return
  warnedRecoveryReadVaults.add(vaultId)
  toast.info(t('draft_recovery.storage_read_failed'), 7000)
}

watch(vaultId, (id) => {
  if (!id) return
  void (async () => {
    await draftRecovery.discover(id)
    // A primary draft whose baseline still matches the authoritative disk
    // version is safe to adopt into the dirty editor buffer. Adoption never
    // calls the server save pipeline; ambiguous/conflict records remain for
    // the prompt and the temporary "Unsaved Content" list.
    for (const item of [...draftRecovery.items.value]) {
      if (item.source === 'primary'
        && item.status === 'ready'
        && item.decision?.kind === 'baseline-match'
        && item.decision.disk.status === 'ready'
        && item.draft.content !== item.decision.disk.raw) {
        try {
          await restoreRecoveryDraft(item.recoveryId)
        } catch {
          // One failed adoption must not abort startup Recovery for the
          // remaining items — and must not silently hide this one:
          // baseline-match items are excluded from the Prompt (it trusts
          // this adoption path), so an exception here would leave the
          // stored bytes with no visible entry point at all. The record
          // is NOT dismissed; surface it through the temporary Unsaved
          // Content panel instead. (Items whose failure reclassified
          // them to error resurface through the Prompt on their own.)
          const failed = recoveryItem(item.recoveryId)
          if (failed?.status === 'ready' && failed.decision) {
            recoveryTabs.open(failed, 'content')
          }
        }
      }
    }
    if (await recoveryManagement.refresh(id)) {
      warnedRecoveryReadVaults.delete(id)
      if (recoveryManagement.unsupportedCount.value > 0) {
        activePanel.value = 'recovery'
        toast.info(t('draft_recovery.unsupported_notice'), 7000)
      }
      const report = await recoveryManagement.cleanupNow()
      if (report.status !== 'completed') {
        toast.info(t('draft_recovery.center.cleanup_failed'), 5000)
      } else if (report.deleted.length > 0) {
        toast.info(t('draft_recovery.center.cleaned', { count: report.deleted.length }))
      }
    } else {
      // A storage read failure must NOT hijack the workspace: the
      // management records are just the default empty array, so opening
      // the Center would show "0 unsaved items" next to "could not read
      // recovery storage". Keep the user's current panel (Files, Tags,
      // History); the Center opens only from the prompt's manage entry,
      // real unsupported records, or a failed auto-adoption, and renders
      // its own error state with a retry button.
      warnRecoveryReadFailure(id)
    }
  })()
}, { immediate: true })
onBeforeUnmount(() => {
  recoveryManagement.dispose()
  draftRecovery.dispose()
})

async function refreshRecoveryCenter(): Promise<void> {
  const currentVaultId = vaultId.value
  if (!currentVaultId) return
  // A manual retry re-arms the startup notice: the user asked for this
  // read, so if it fails again they should hear about it once more.
  warnedRecoveryReadVaults.delete(currentVaultId)
  const ids = recoveryManagement.records.value.map(recoveryRecordId)
  await withManagedRecoveryOperations(ids, async () => {
    await draftRecovery.discover(currentVaultId)
    if (!await recoveryManagement.refresh(currentVaultId)) {
      warnRecoveryReadFailure(currentVaultId)
    }
  })
}

async function retryManagedRecovery(recoveryId: string): Promise<void> {
  await withManagedRecoveryOperation(recoveryId, () => draftRecovery.retry(recoveryId))
}

async function withManagedRecoveryOperation<T>(
  recoveryId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withManagedRecoveryOperations([recoveryId], operation)
}

async function withManagedRecoveryOperations<T>(
  recoveryIds: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  return recoveryOperationProtection.run(recoveryIds, operation)
}

async function deleteManagedRecovery(recoveryId: string): Promise<void> {
  const record = recoveryManagement.records.value.find(
    (candidate) => recoveryRecordId(candidate) === recoveryId,
  )
  if (!record) return
  const ok = await confirm(
    t('draft_recovery.center.delete'),
    `${record.record.documentPath}\n${record.source} · ${record.bytes} B`,
  )
  if (ok) showRecoveryDeleteReport(await recoveryManagement.deleteRecord(record))
}

function showRecoveryDeleteReport(
  report: { status: string } | import('../composables/vault/draft-recovery/useDraftRecoveryManagement').BulkRecoveryDeleteReport,
): void {
  const counts = 'status' in report
    ? { deleted: report.status === 'deleted' || report.status === 'missing' ? 1 : 0,
        stale: report.status === 'stale' ? 1 : 0,
        protected: report.status === 'protected' ? 1 : 0,
        failed: report.status === 'failed' || report.status === 'unsupported' ? 1 : 0 }
    : { deleted: report.deleted.length + report.missing.length,
        stale: report.stale.length,
        protected: report.protected.length,
        failed: report.failed.length + report.unsupported.length }
  toast.info(t('draft_recovery.center.delete_summary', counts), 5000)
}

async function deleteSelectedRecovery(): Promise<void> {
  const selected = recoveryManagement.records.value.filter((record) => (
    recoveryManagement.selectedIds.value.has(recoveryRecordId(record))
    && !recoveryManagement.protectedIds.value.has(recoveryRecordId(record))
  ))
  const ok = await confirm(
    t('draft_recovery.center.delete_selected'),
    t('draft_recovery.center.delete_confirm_summary', {
      count: selected.length,
      bytes: selected.reduce((sum, record) => sum + record.bytes, 0),
    }),
  )
  if (ok) showRecoveryDeleteReport(await recoveryManagement.deleteSelected())
}

const history = useHistory(vaultContext)
const sidebarFileHistory = useFileHistory(locale)
const rightRailFileHistory = useFileHistory(locale)

function openFileHistory(path: string): void {
  void sidebarFileHistory.open(resolveFileHistoryTarget(path, posts.value))
  selectPanel('history')
}

function showAllHistory(): void {
  sidebarFileHistory.clear()
}

function selectActivityPanel(panel: Parameters<typeof selectPanel>[0]): void {
  if (panel === 'history') sidebarFileHistory.clear()
  selectPanel(panel)
}

watch(vaultId, () => {
  sidebarFileHistory.clear()
  rightRailFileHistory.clear()
})

const historyCommit = useHistoryCommit({
  history,
  saveSelected: prepareHistoryCommit,
  acquireMutation: historyMutationLock.acquire,
  canMutate: historyMutationLock.canAcquire,
  async refreshComparisons(committedPaths) {
    await Promise.all(committedPaths.flatMap((path) => {
      const normalized = path.endsWith('.md') ? path.slice(0, -3) : path
      return [
        historyComparisons.refreshDocumentComparison(normalized),
        workingTreeDiffs.refreshDocumentDiff(normalized),
      ]
    }))
  },
})

async function confirmHistoryWithdraw(): Promise<boolean> {
  return confirm(t('history.withdraw_title'), t('history.withdraw_detail'), {
    confirmLabel: t('history.withdraw_confirm'),
    cancelLabel: t('history.withdraw_cancel'),
    destructive: true,
  })
}

const historyWithdraw = useHistoryWithdraw({
  history,
  confirm: confirmHistoryWithdraw,
  acquireMutation: historyMutationLock.acquireAll,
  canMutate: historyMutationLock.canAcquireAll,
  refreshIndexRepairStatus: historyCommit.refreshIndexRepairStatus,
  registerIndexRepair: historyCommit.registerIndexRepair,
  settleIndexRepairPaths: historyCommit.settleIndexRepairPaths,
  async refreshComparisons(paths) {
    await Promise.all(paths.flatMap((filePath) => {
      const normalized = filePath.endsWith('.md') ? filePath.slice(0, -3) : filePath
      return [
        historyComparisons.refreshDocumentComparison(normalized),
        workingTreeDiffs.refreshDocumentDiff(normalized),
      ]
    }))
  },
  closeDroppedRevision(sha) {
    historyComparisons.closeComparisons(
      historyComparisons.comparisons.value
        .filter((comparison) => comparison.revisionId === sha)
        .map((comparison) => comparison.tabId),
    )
  },
})

function restoreSource(source: HistoryComparison): HistoryRestoreSource | null {
  if (!source || source.status !== 'ready') return null
  const selectedExists = source.mode === 'commit-change'
    ? source.afterExists
    : source.beforeExists
  if (!selectedExists) return null
  return {
    documentPath: source.documentPath,
    documentTitle: source.documentTitle,
    revisionId: source.revisionId,
    revisionTime: source.revisionTime,
    historicalRaw: source.mode === 'commit-change' ? source.afterRaw : source.beforeRaw,
  }
}

function restoreDate(timestamp: number): string {
  return formatHistoryDate(timestamp, locale.value)
}

async function confirmHistoryRestore(request: HistoryRestoreRequest): Promise<boolean> {
  const detail = [
    t('history.restore_detail', {
      title: request.documentTitle,
      date: restoreDate(request.revisionTime),
    }),
    request.currentDirty ? t('history.restore_unsaved') : '',
    t('history.restore_no_commit'),
  ].filter(Boolean).join('\n\n')
  return confirm(t('history.restore_title'), detail, {
    confirmLabel: t('history.restore_confirm'),
    cancelLabel: t('history.restore_cancel'),
    destructive: true,
  })
}

const historyRestore = useHistoryRestore({
  tabs,
  fileChanges,
  confirm: confirmHistoryRestore,
  prepareEditorRestore: prepareHistoryRestore,
  refreshVault: refresh,
  refreshComparison: historyComparisons.refreshDocumentComparison,
  acquireMutation: historyMutationLock.acquire,
  onConflict(request) {
    toast.info(t('history.document_mutation_in_progress'))
    void nextTick(() => {
      if (activeHistoryComparison.value?.documentPath === request.documentPath) {
        comparisonPaneRef.value?.focusViewer()
      }
    })
  },
  onSuccess(request, result) {
    if (result.metadataMode === 'unavailable') {
      toast.info(t('history.restore_metadata_unavailable', { title: request.documentTitle }), 6000)
    } else if (result.refreshFailed) {
      toast.info(t('history.restore_partial', { title: request.documentTitle }), 5000)
    } else {
      toast.success(t('history.restore_success', { title: request.documentTitle }))
    }
  },
  onError(_request, error) {
    const message = error instanceof Error && error.message
      ? error.message
      : t('history.comparison_load_failed')
    toast.error(t('history.restore_failed', { error: message }))
  },
})

function restoreHistoricalVersion(source: HistoryComparison): void {
  const captured = restoreSource(source)
  if (captured) void historyRestore.restore(captured)
}

function basename(path: string): string {
  const name = path.split('/').pop() ?? path
  return name.endsWith('.md') ? name.slice(0, -3) : name
}

function documentTitleForPath(path: string): string {
  const normalized = path.endsWith('.md') ? path.slice(0, -3) : path
  return posts.value.find((post) => post.path === normalized)?.title || basename(normalized)
}

const naturalWorkspaceTabs = computed<WorkspaceTab[]>(() => [
  ...tabs.value.map((tab) => ({
    id: tab.path,
    label: basename(tab.path),
    title: tab.title || tab.path,
    save: deriveDocumentSavePresentation(tab),
    kind: 'document' as const,
    documentPath: tab.path,
  })),
  ...historyComparisons.comparisons.value.map((comparison) => ({
    id: comparison.tabId,
    label: `${comparison.documentTitle} (${t('history.diff_tab_suffix')})`,
    title: comparison.documentTitle,
    save: deriveDocumentSavePresentation(null),
    kind: 'diff' as const,
    documentPath: comparison.documentPath,
  })),
  ...workingTreeDiffs.diffs.value.map((diff) => ({
    id: diff.tabId,
    label: `${diff.documentTitle} (${t('history.changes_diff_tab_suffix')})`,
    title: diff.documentTitle,
    save: deriveDocumentSavePresentation(null),
    kind: 'diff' as const,
    documentPath: diff.documentPath,
  })),
  ...recoveryTabs.tabs.value.map((recovery) => ({
    id: recovery.tabId,
    label: t('draft_recovery.recovered_title', { title: recovery.documentTitle }),
    title: t('draft_recovery.recovered_title', { title: recovery.documentTitle }),
    save: deriveDocumentSavePresentation(null),
    kind: 'recovery' as const,
    documentPath: recovery.documentPath,
  })),
])
const naturalWorkspaceTabIds = computed(() => naturalWorkspaceTabs.value.map((tab) => tab.id))
watch(
  naturalWorkspaceTabIds,
  (availableIds) => {
    workspaceTabOrder.value = reconcileWorkspaceTabOrder(workspaceTabOrder.value, availableIds)
  },
  { immediate: true },
)
const workspaceTabs = computed<WorkspaceTab[]>(() => {
  const natural = naturalWorkspaceTabs.value
  const byId = new Map(natural.map((tab) => [tab.id, tab]))
  return reconcileWorkspaceTabOrder(workspaceTabOrder.value, natural.map((tab) => tab.id))
    .map((id) => byId.get(id))
    .filter((tab): tab is WorkspaceTab => Boolean(tab))
})
const activeSavePresentation = computed(() => (
  activeHistoryComparison.value || activeWorkingTreeDiff.value || activeDraftRecovery.value
    ? deriveDocumentSavePresentation(null)
    : deriveDocumentSavePresentation(activeTab.value)
))
const activeWorkspaceTabId = computed(() => (
  activeDraftRecovery.value?.tabId
  ?? activeHistoryComparison.value?.tabId
  ?? activeWorkingTreeDiff.value?.tabId
  ?? activePath.value
))
// Bind the AI capture delegate now that every workspace authority exists.
// This one call is the AI context's sole send-time authority — the active
// workspace tab id, never the route alone. The sealed resolver does the
// classification; VaultView never re-implements that logic.
captureWorkspaceAiContext = () => captureAiLiveContext({
  vaultId: vaultId.value,
  activeWorkspaceTabId: activeWorkspaceTabId.value,
  documentTabs: tabs.value,
  historyComparisons: historyComparisons.comparisons.value,
  recoveryTabs: recoveryTabs.tabs.value,
}, {
  liveDocument: (path) => liveEditorForPath(tabs.value, path),
})

async function reorderWorkspaceTabs(request: WorkspaceTabReorderRequest): Promise<void> {
  const availableIds = workspaceTabs.value.map((tab) => tab.id)
  if (!availableIds.includes(request.movedId)) return
  const nextOrder = applyWorkspaceTabOrder(
    workspaceTabOrder.value,
    request.orderedIds,
    availableIds,
  )
  if (!nextOrder) return
  workspaceTabOrder.value = nextOrder

  const byId = new Map(workspaceTabs.value.map((tab) => [tab.id, tab]))
  const documentPaths = nextOrder
    .map((id) => byId.get(id))
    .filter((tab): tab is WorkspaceTab => tab?.kind === 'document')
    .map((tab) => tab.documentPath ?? tab.id)
  reorderOpenDocuments(documentPaths)

  if (request.input === 'keyboard' || !activeWorkspaceTabId.value) {
    await nextTick()
    if (
      request.input === 'keyboard'
      && workspaceTabs.value.some((tab) => tab.id === request.movedId)
    ) {
      editorTabsRef.value?.focusTab(request.movedId)
    } else if (!activeWorkspaceTabId.value) {
      vaultRef.value?.focus()
    }
  }
}

async function openPost(path: string, options: { refresh?: boolean } = {}): Promise<void> {
  recoveryTabs.deactivate()
  historyComparisons.deactivate()
  workingTreeDiffs.deactivate()
  await openEditorPost(path, options)
}

const { ensureDiaryDate, openDiaryDate } = useDiaryDateCommand({
  getPost,
  createDiaryDate,
  openPost,
  refresh,
  fileChanges,
  mutationLock: historyMutationLock,
  getToday: localCivilToday,
  onFuture: () => toast.info(t('diary.future_missing')),
  onBusy: () => toast.info(t('diary.open_busy')),
  onError: (error) => toast.error(t('diary.open_failed', {
    error: error.message || t('common.unknown_error'),
  })),
  onRefreshError: () => toast.info(t('diary.refresh_failed')),
})

async function selectWorkspaceTab(id: string, focusViewer = true): Promise<void> {
  if (recoveryTabs.tabs.value.some((recovery) => recovery.tabId === id)) {
    historyComparisons.deactivate()
    workingTreeDiffs.deactivate()
    recoveryTabs.select(id)
    if (focusViewer) {
      await nextTick()
      recoveryPaneRef.value?.focusViewer()
    }
  } else if (historyComparisons.comparisons.value.some((comparison) => comparison.tabId === id)) {
    recoveryTabs.deactivate()
    workingTreeDiffs.deactivate()
    historyComparisons.selectComparison(id)
    if (focusViewer) {
      await nextTick()
      comparisonPaneRef.value?.focusViewer()
    }
  } else if (workingTreeDiffs.diffs.value.some((diff) => diff.tabId === id)) {
    recoveryTabs.deactivate()
    historyComparisons.deactivate()
    workingTreeDiffs.selectDiff(id)
    if (focusViewer) {
      await nextTick()
      workingTreeDiffPaneRef.value?.focusViewer()
    }
  } else {
    recoveryTabs.deactivate()
    historyComparisons.deactivate()
    workingTreeDiffs.deactivate()
    selectEditorTab(id)
    if (focusViewer) {
      await nextTick()
      editorTabsRef.value?.focusTab(id)
    }
  }
}

async function closeWorkspaceTab(id: string): Promise<void> {
  const result = await closeWorkspaceTabState(id, {
    workspaceTabs: workspaceTabs.value,
    activeId: activeWorkspaceTabId.value,
    comparisons: historyComparisons.comparisons.value,
    workingTreeDiffs: workingTreeDiffs.diffs.value,
    closeEditorTab,
    closeComparison: historyComparisons.closeComparison,
    closeWorkingTreeDiff: workingTreeDiffs.closeDiff,
    closeRecovery: recoveryTabs.close,
    refreshDocumentComparison: historyComparisons.refreshDocumentComparison,
  })
  if (!result.closed) return
  if (!result.activeWillClose) {
    await nextTick()
    const activeId = activeWorkspaceTabId.value
    if (activeId) editorTabsRef.value?.focusTab(activeId)
    else vaultRef.value?.focus()
    return
  }
  if (!result.fallbackId) {
    await nextTick()
    vaultRef.value?.focus()
    return
  }

  await selectWorkspaceTab(result.fallbackId, false)
  await nextTick()
  editorTabsRef.value?.focusTab(result.fallbackId)
}

async function closeManyWorkspaceTabs(ids: string[]): Promise<void> {
  const result = await closeManyWorkspaceTabState(ids, {
    workspaceTabs: workspaceTabs.value,
    activeId: activeWorkspaceTabId.value,
    comparisons: () => historyComparisons.comparisons.value,
    workingTreeDiffs: () => workingTreeDiffs.diffs.value,
    confirmEditorTabs: confirmCloseEditorTabs,
    closeEditorTabsConfirmed: closeManyEditorTabsConfirmed,
    closeComparisons: historyComparisons.closeComparisons,
    closeWorkingTreeDiffs: workingTreeDiffs.closeDiffs,
    closeRecoveries: recoveryTabs.closeMany,
    refreshDocumentComparison: historyComparisons.refreshDocumentComparison,
  })
  if (!result.closed) return
  if (!result.activeWillClose) {
    await nextTick()
    const activeId = activeWorkspaceTabId.value
    if (activeId) editorTabsRef.value?.focusTab(activeId)
    else vaultRef.value?.focus()
    return
  }
  if (!result.fallbackId) {
    await nextTick()
    vaultRef.value?.focus()
    return
  }
  await selectWorkspaceTab(result.fallbackId, false)
  await nextTick()
  editorTabsRef.value?.focusTab(result.fallbackId)
}

async function copyWorkspaceTabPath(path: string): Promise<void> {
  const copied = await copyTextToClipboard(path)
  if (copied) toast.success(t('workspace_tab.path_copied', { path }))
  else toast.error(t('workspace_tab.copy_path_failed'))
}

async function revealWorkspaceTabInTree(path: string): Promise<void> {
  activePanel.value = 'files'
  filesFilter.value = ''
  selectScope('note')
  await nextTick()
  await revealWorkspacePath(path, {
    revealPath: async (targetPath) => fileTreeRef.value?.revealPath(targetPath),
    refresh,
    afterRefresh: nextTick,
    onNotFound: (targetPath) => toast.info(t('workspace_tab.reveal_failed', { path: targetPath })),
    onError: (targetPath) => toast.error(t('workspace_tab.reveal_failed', { path: targetPath })),
  })
}

function onVaultKeydown(event: KeyboardEvent): void {
  if (isNuvynShortcutBlocked(event)) return
  if (diaryCloseChord.onKeydown(event)) return

  if (isDiaryPresentationPrimary.value) {
    // Diary Home may keep document tabs mounted for lifecycle continuity, but
    // hidden tabs only own shortcuts when a corresponding workspace target
    // exists. With no target, leave browser-native W/Tab behavior alone.
    handleDiaryHomeKeydown(event, {
      activeWorkspaceTabId: activeWorkspaceTabId.value,
      workspaceTabCount: workspaceTabs.value.length,
    }, onEditorKeydown)
    return
  }

  const meta = event.metaKey || event.ctrlKey
  const readOnlyTab = activeDraftRecovery.value
    ?? activeHistoryComparison.value
    ?? activeWorkingTreeDiff.value
  const activeId = activeWorkspaceTabId.value
  if (meta && event.key.toLowerCase() === 'w' && activeId) {
    event.preventDefault()
    void closeWorkspaceTab(activeId)
    return
  }
  if (meta && event.key === 'Tab' && workspaceTabs.value.length > 0) {
    event.preventDefault()
    const current = workspaceTabs.value.findIndex((tab) => tab.id === activeId)
    const direction = event.shiftKey ? -1 : 1
    const next = current < 0
      ? (direction > 0 ? 0 : workspaceTabs.value.length - 1)
      : (current + direction + workspaceTabs.value.length) % workspaceTabs.value.length
    const nextTab = workspaceTabs.value[next]
    if (nextTab) void selectWorkspaceTab(nextTab.id)
    return
  }
  if (!readOnlyTab) {
    onEditorKeydown(event)
    return
  }
  if (meta && event.key.toLowerCase() === 's') {
    event.preventDefault()
    return
  }
  if (meta && event.key.toLowerCase() === 'e') {
    event.preventDefault()
    return
  }
  // A history comparison keeps Monaco mounted only to preserve its model,
  // undo stack, and view state. Never forward comparison key events to that
  // hidden editable document; unhandled keys belong to the read-only viewer.
}

async function openHistoryComparison(selection: HistoryRevisionSelection): Promise<void> {
  recoveryTabs.deactivate()
  workingTreeDiffs.deactivate()
  const request = historyComparisons.openComparison(selection)
  await nextTick()
  comparisonPaneRef.value?.focusViewer()
  await request
}

async function compareHistoryWithWorkingTree(tabId: string): Promise<void> {
  const request = historyComparisons.compareWithWorkingTree(tabId)
  await nextTick()
  comparisonPaneRef.value?.focusViewer()
  await request
}

async function viewHistoryCommitChanges(tabId: string): Promise<void> {
  const request = historyComparisons.viewCommitChanges(tabId)
  await nextTick()
  comparisonPaneRef.value?.focusViewer()
  await request
}

async function openWorkingTreeDiff(entry: StatusEntry): Promise<void> {
  recoveryTabs.deactivate()
  historyComparisons.deactivate()
  const request = workingTreeDiffs.openDiff(entry, documentTitleForPath(entry.path))
  await nextTick()
  workingTreeDiffPaneRef.value?.focusViewer()
  await request
}

async function viewCurrentRecoveryDocument(recoveryId: string): Promise<void> {
  const requestedView = activeDraftRecovery.value?.view ?? 'content'
  const requestedTabId = activeDraftRecovery.value?.tabId ?? null
  await draftRecovery.retry(recoveryId)
  const item = recoveryItem(recoveryId)
  if (!item || item.status !== 'ready' || !item.decision) return
  const disk = item.decision.disk
  if (disk.status !== 'ready' || disk.documentId !== item.draft.documentId) {
    recoveryTabs.open(item, activeDraftRecovery.value?.view ?? 'content')
    return
  }
  recoveryTabs.deactivate()
  historyComparisons.deactivate()
  await openEditorPost(disk.documentPath)
  // Opening by path crosses a network boundary during which that path may be
  // reused by another stable document identity. Reclassify after the open and
  // only focus the Document tab if identity ownership still matches.
  await draftRecovery.retry(recoveryId)
  const refreshed = recoveryItem(recoveryId)
  const refreshedDisk = refreshed?.decision?.disk
  if (!refreshed
    || refreshed.status !== 'ready'
    || !refreshed.decision
    || refreshedDisk?.status !== 'ready'
    || refreshedDisk.documentId !== refreshed.draft.documentId) {
    if (refreshed?.status === 'ready' && refreshed.decision) {
      const recoveryTab = recoveryTabs.open(refreshed, requestedView)
      await nextTick()
      if (recoveryTab) editorTabsRef.value?.focusTab(recoveryTab.tabId)
    } else if (requestedTabId) {
      recoveryTabs.select(requestedTabId)
      await nextTick()
      editorTabsRef.value?.focusTab(requestedTabId)
    }
    return
  }
  const opened = tabs.value.find(
    (tab) => tab.path === refreshedDisk.documentPath,
  )
  if (!opened
    || opened.loading
    || opened.loadError
    || opened.documentId !== refreshed.draft.documentId) {
    const recoveryTab = recoveryTabs.open(refreshed, requestedView)
    await nextTick()
    if (recoveryTab) editorTabsRef.value?.focusTab(recoveryTab.tabId)
    return
  }
  await nextTick()
  editorTabsRef.value?.focusTab(refreshedDisk.documentPath)
}

const editorLinkTargets = computed(() => posts.value.map((post) => ({ path: post.path, title: post.title })))

async function onMetadataSaved(metadata: DocumentMetadata) {
  const post = posts.value.find((item) => item.path === metadata.path)
  if (post) {
    const updated: PostSummary = applyMetadataToPostSummary(post, metadata)
    // Apply the successful server result synchronously so open tabs, the
    // file tree, and Posts do not wait for the background refresh.
    applyPostSummary(updated)
  } else {
    const tab = tabs.value.find((item) => item.path === metadata.path)
    if (tab) tab.title = metadata.title
  }
  try {
    await Promise.all([refresh(), refreshLinkIndex(fileChanges)])
  } catch (cause) {
    // Metadata is already saved and the local patch is authoritative for
    // this session. A refresh hiccup must not turn that success into a
    // save failure or roll the title back.
    console.warn('metadata global refresh failed', cause)
    toast.info(t('metadata.sync_failed'))
  }
}

async function createMissingWikiNote(ref: string) {
  const clean = ref.replace(/\.md$/i, '').trim()
  const segments = clean.split('/')
  if (!segments.length || segments.some((segment) => !isSlugSegment(segment))) {
    toast.error(t('vault.wiki_path_invalid'))
    return
  }
  const path = clean.startsWith('inbox/') ? clean : `inbox/${clean}`
  const title = segments.at(-1)!.split('-').join(' ')
  try {
    const created = await documentLifecycle.createFile({ path, title })
    await openPost(created.path, { refresh: false })
    toast.success(t('common.created', { path: created.path }))
  } catch (error: any) {
    if (error?.status === 409) await openPost(path)
    else toast.error(t('common.create_failed', { error: error?.message ?? t('common.unknown_error') }))
  }
}

async function copyActiveContent() {
  const sessionGeneration = captureDiarySessionGeneration()
  const activeViewerPath = activeDraftRecovery.value?.documentPath
    ?? activeHistoryComparison.value?.documentPath
    ?? activeWorkingTreeDiff.value?.documentPath
    ?? activeTab.value?.path
    ?? null
  const managedViewer = activeViewerPath !== null
    && classifyDiaryPath(activeViewerPath.replace(/\.md$/, '')) === 'managed'
  if (managedViewer && !diaryAccess.isUnlocked.value) return
  const raw = activeDraftRecovery.value?.draftRaw
    ?? activeHistoryComparison.value?.afterRaw
    ?? activeTab.value?.raw
  if (raw === undefined) return
  if (managedViewer && (!diaryAccess.isUnlocked.value || !isDiarySessionGenerationCurrent(sessionGeneration))) return
  try {
    await navigator.clipboard.writeText(raw)
    if (managedViewer && (!diaryAccess.isUnlocked.value || !isDiarySessionGenerationCurrent(sessionGeneration))) return
    toast.success(t('vault.content_copied'))
  } catch { toast.error(t('vault.copy_failed')) }
}

async function showExternalDiff() {
  const tab = activeTab.value
  if (!tab) return
  await confirm(`${t('vault.local_version')}：\n\n${tab.raw.slice(0, 1600)}\n\n────────\n${t('vault.disk_version')}：\n\n${(tab.externalRaw ?? `(${t('vault.file_deleted')})`).slice(0, 1600)}`)
}

/* ---------- Diary presentation ---------- */
const isDiaryScope = computed(() => activeScope.value === 'diary')
const documentPaths = computed(() => tabs.value.map((tab) => tab.path))
const diaryWorkspacePresentation = useDiaryWorkspacePresentation({
  isDiaryScope,
  activeHistoryComparison,
  activeWorkingTreeDiff,
  activeDraftRecovery,
  documentPaths,
  activePath,
})
const {
  presentationMode,
  diaryPresentationEligible,
  isDocument: isDiaryDocumentMode,
  selectedDiaryDate,
  backingPath,
  isHome: isDiaryCalendarMode,
} = diaryWorkspacePresentation
// Keep the Naive UI Calendar subtree mounted for the whole Diary scope. D6.1
// moves visibility to the Diary presentation owner while preserving this
// scope-only mount rule.
const isDiaryCalendarMounted = computed(() => isDiaryScope.value)
const hasOpenDiaryDocument = computed(() => workspaceTabs.value.some((tab) => (
  tab.kind === 'document' && classifyDiaryPath(tab.documentPath) === 'managed'
)))
const isDiaryCalendarVisible = computed(() => (
  isDiaryCalendarMode.value && !hasOpenDiaryDocument.value
))
const isDiaryPresentationPrimary = computed(() => isDiaryCalendarVisible.value)

const diaryCloseChord = createDiaryShortcutChord({
  isDiaryDocument: () => isDiaryScope.value
    && isDiaryDocumentMode.value
    && classifyDiaryPath(activePath.value ?? '') === 'managed',
  isTextEntryContext: isDiaryTextEntryContext,
  isBlocked: isDiaryShortcutBlocked,
  closeDiaryDocument: () => {
    const activeId = activeWorkspaceTabId.value
    if (activeId) return closeWorkspaceTab(activeId)
  },
})

watch([isDiaryScope, isDiaryDocumentMode, activeWorkspaceTabId], () => {
  diaryCloseChord.reset()
}, { flush: 'sync' })

onMounted(() => {
  window.addEventListener('blur', diaryCloseChord.reset)
  document.addEventListener('visibilitychange', diaryCloseChord.reset)
})

onBeforeUnmount(() => {
  window.removeEventListener('blur', diaryCloseChord.reset)
  document.removeEventListener('visibilitychange', diaryCloseChord.reset)
  diaryCloseChord.dispose()
})

const routeSidebarVisible = computed(() => route.meta.sidebar !== false)
const workspaceSidebarVisible = computed(() => routeSidebarVisible.value && !isDiaryCalendarVisible.value)
const workspaceLeftSidebarVisible = computed(() => workspaceSidebarVisible.value && leftSidebarVisible.value)

watch(workspaceSidebarVisible, (visible) => {
  sidebarLayoutVisible.value = visible
}, { immediate: true })

// The empty workspace has no document status to report. Keep the layout's
// optional footer row in sync with the same workspace-tab source that drives
// the editor tabs, so hiding the footer also returns its 24px to the editor.
watch(
  [workspaceSidebarVisible, () => workspaceTabs.value.length],
  ([sidebarVisible, workspaceTabCount]) => {
    statusBarLayoutVisible.value = sidebarVisible && workspaceTabCount > 0
  },
  { immediate: true },
)

// NavBar lives above RouterView, while SettingsModal remains owned by this
// view because its embedded sections use the live Vault context. Bridge the
// global menu action through the App shell tick instead of moving or
// duplicating the modal implementation.
watch(() => appShell?.settingsRequestTick.value, (tick, previous) => {
  if (tick !== undefined && tick !== previous) settingsOpen.value = true
})
type DiaryFilterOwnership = 'none' | 'calendar' | 'user'

// Persist both the Calendar seed and who owns the current query. A plain
// empty seed cannot distinguish a fresh empty query from one the user
// deliberately cleared, so the ownership state must survive refresh too.
const diaryFilterSeed = useStorage(diaryFilterSeedKey, '')
const diaryFilterOwnership = useStorage<DiaryFilterOwnership>(
  diaryFilterOwnershipKey,
  'none',
)

// Migrate the pre-ownership state when it still has an intact Calendar seed.
// A previous user edit already cleared `diaryFilterSeed`, so only an equal,
// non-empty pair can safely be classified as a Calendar-owned query.
if (
  diaryFilterOwnership.value === 'none'
  && diaryFilterSeed.value
  && filesFilter.value === diaryFilterSeed.value
) {
  diaryFilterOwnership.value = 'calendar'
}

const diaryExactPathFilter = computed(() => {
  if (!isDiaryDocumentMode.value || !backingPath.value) return null

  // The date is seeded into the shared FileTree query when entering a Diary
  // document, but it must stop being an exact-path constraint as soon as the
  // user edits that query. The seed check preserves that provenance boundary
  // even when the user later types the same date again.
  const diaryDate = backingPath.value.split('/').at(-1)
  return diaryFilterOwnership.value === 'calendar'
    && diaryFilterSeed.value === diaryDate
    && filesFilter.value === diaryDate
    ? backingPath.value
    : null
})
const pendingMoodFirstPresentationDate = ref<DiaryDate | null>(null)
const pendingMoodFirstPresentationIntent = ref<number | null>(null)

function clearPendingMoodFirstPresentation(): void {
  pendingMoodFirstPresentationDate.value = null
  pendingMoodFirstPresentationIntent.value = null
}

function hasPendingMoodFirstPresentation(date: DiaryDate): boolean {
  const intent = pendingMoodFirstPresentationIntent.value
  return pendingMoodFirstPresentationDate.value === date
    && intent !== null
    && diaryWorkspacePresentation.isDateIntentCurrent(intent)
}

function rememberPendingMoodFirstPresentation(date: DiaryDate, intent: number | null): void {
  if (intent === null) return
  if (!diaryWorkspacePresentation.isDateIntentCurrent(intent)) {
    if (pendingMoodFirstPresentationIntent.value === intent) {
      clearPendingMoodFirstPresentation()
    }
    return
  }
  pendingMoodFirstPresentationDate.value = date
  pendingMoodFirstPresentationIntent.value = intent
}

// Keep the ordinary FileTree search input useful in the Diary context. Seed
// it only when entering/leaving the Diary scope; it is user-owned afterwards
// and must not change when a file or another Diary tab is clicked.
watch(isDiaryScope, (inDiaryScope) => {
  if (!inDiaryScope) {
    // A fresh browser process cannot restore the process-local Diary
    // capability from persisted scope state. App.vue therefore normalizes a
    // persisted Diary scope to note while it resolves access. Only that
    // unresolved bootstrap is exempt from the normal scope-exit cleanup;
    // once status has been reconciled, LOCKED also represents a real
    // lock/expiry/logout boundary and must clear Calendar-owned state.
    if (!diaryAccess.statusResolved.value) return
    clearPendingMoodFirstPresentation()
    // A Calendar-seeded date is presentation context and should not hide the
    // ordinary scope's tree. Once the user edits the query, it is their
    // ordinary FileTree state and must survive the scope transition.
    if (
      diaryFilterOwnership.value === 'calendar'
      && filesFilter.value === diaryFilterSeed.value
    ) {
      filesFilter.value = ''
    }
    diaryFilterSeed.value = ''
    if (diaryFilterOwnership.value === 'calendar') {
      diaryFilterOwnership.value = 'none'
    }
    return
  }
  // User-owned state includes an intentionally empty query. It must not be
  // re-seeded from the active Diary document during refresh or re-entry.
  if (diaryFilterOwnership.value === 'user') return
  if (!filesFilter.value && classifyDiaryPath(activePath.value) === 'managed') {
    const date = activePath.value!.split('/').at(-1) ?? ''
    diaryFilterSeed.value = date
    diaryFilterOwnership.value = 'calendar'
    filesFilter.value = date
  }
}, { immediate: true })

// FileTree's model update is the explicit user-edit boundary. System-owned
// Calendar navigation writes `filesFilter` directly and records a seed; a
// user edit clears that provenance even if the value happens to be typed back
// to the same date later.
function onFilesFilterEdited(value: string): void {
  diaryFilterSeed.value = ''
  diaryFilterOwnership.value = 'user'
  filesFilter.value = value
}

// A pending Mood-first repair is scoped to the current Diary presentation.
// Special surfaces and scope exit reset that presentation, so a later
// existing-Diary Mood edit must not inherit the old navigation intent.
watch(diaryPresentationEligible, (eligible) => {
  if (!eligible) clearPendingMoodFirstPresentation()
}, { flush: 'sync' })
watch(() => activePath.value, (path, previousPath) => {
  if (path !== previousPath && pendingMoodFirstPresentationDate.value !== null) {
    clearPendingMoodFirstPresentation()
  }
}, { flush: 'sync' })

watch(selectedDiaryDate, (date) => {
  if (!isDiaryScope.value || !date) return
  // Follow Calendar date navigation only while the query still contains the
  // last system-seeded date. Once the user edits it, the FileTree query is
  // fully user-owned and must remain untouched.
  if (diaryFilterOwnership.value === 'user') return
  if (
    !filesFilter.value
    || (
      diaryFilterOwnership.value === 'calendar'
      && filesFilter.value === diaryFilterSeed.value
    )
  ) {
    diaryFilterSeed.value = date
    diaryFilterOwnership.value = 'calendar'
    filesFilter.value = date
  }
})

// Calendar stays mounted across the Diary/native-document handoff. Its
// Teleport picker is presentation-local, however, so any transition away
// from Calendar Home must close that context without trying to restore focus
// to a trigger that is about to be hidden.
watch(isDiaryCalendarVisible, (visible, wasVisible) => {
  if (appShell) appShell.diaryCalendarVisible.value = visible
  if (visible && wasVisible === false) {
    diaryCalendarSurfaceRef.value?.clearSelection()
  }
  if (!visible) {
    clearPendingMoodFirstPresentation()
    if (wasVisible) diaryCalendarSurfaceRef.value?.closeMoodPicker(false)
  }
}, { flush: 'sync', immediate: true })

const diaryMoodBusy = ref(false)
const diaryMoodPreferences = useDiaryMoodIconPreferences()
const diaryMoodCommand = useDiaryMoodCommand({
  mutationLock: historyMutationLock,
  onBusy: () => toast.info(t('mood.busy')),
  onConflict: () => toast.info(t('mood.conflict')),
  onError: (error) => toast.error(t('mood.failed', {
    error: error.message || t('common.unknown_error'),
  })),
})

watch(isDiaryCalendarVisible, (visible) => {
  if (visible) void diaryMoodPreferences.load().catch(() => undefined)
}, { immediate: true })

async function refreshAfterMoodRejection(): Promise<void> {
  try {
    await refresh()
  } catch {
    toast.info(t('metadata.sync_failed'))
  }
}

/**
 * Calendar mood selection is a presentation intent only. VaultView performs
 * the existing missing-date command when necessary, then delegates the
 * authoritative CAS mutation to the shared Diary mood command. The Calendar
 * never owns API, route, or document lifecycle state.
 */
async function updateDiaryCalendarMood(date: DiaryDate, mood: MoodId | null): Promise<void> {
  if (diaryMoodBusy.value) return

  // A retry is only allowed to inherit the presentation handoff for the
  // exact date and still-current presentation epoch that created it. Any
  // other Mood action, or an invalidated epoch, starts a fresh context.
  if (
    pendingMoodFirstPresentationDate.value !== null
    && !hasPendingMoodFirstPresentation(date)
  ) {
    clearPendingMoodFirstPresentation()
  }

  const path = diaryLogicalPathForDate(date)
  let post = posts.value.find((candidate) => candidate.path === path)
  if (mood === null && !post) return
  const pendingRepair = hasPendingMoodFirstPresentation(date)
  const shouldPresentAfterMutation = !post || pendingRepair
  const presentationIntent = shouldPresentAfterMutation
    ? diaryWorkspacePresentation.beginDateIntent()
    : null
  let dateReadyForPresentation = pendingRepair

  diaryMoodBusy.value = true
  try {
    if (!post) {
      const dateResult = await ensureDiaryDate(date)
      if (dateResult.status !== 'existing' && dateResult.status !== 'created') return
      dateReadyForPresentation = true
      post = posts.value.find((candidate) => candidate.path === path)
      if (!post) {
        try {
          await refresh()
        } catch {
          toast.info(t('metadata.sync_failed'))
        }
        post = posts.value.find((candidate) => candidate.path === path)
      }
    }

    let expectedUpdatedAt = post?.metadataUpdatedAt
    if (
      typeof expectedUpdatedAt !== 'number'
      || !Number.isSafeInteger(expectedUpdatedAt)
      || expectedUpdatedAt < 0
    ) {
      try {
        await refresh()
      } catch {
        toast.info(t('metadata.sync_failed'))
      }
      post = posts.value.find((candidate) => candidate.path === path)
      expectedUpdatedAt = post?.metadataUpdatedAt
    }

    if (
      typeof expectedUpdatedAt !== 'number'
      || !Number.isSafeInteger(expectedUpdatedAt)
      || expectedUpdatedAt < 0
    ) {
      if (shouldPresentAfterMutation && dateReadyForPresentation) {
        // Creation is authoritative even when the fresh metadata version is
        // temporarily unavailable. Keep the date repairable in Calendar and
        // defer native presentation until a later Mood CAS succeeds.
        rememberPendingMoodFirstPresentation(date, presentationIntent)
      }
      toast.error(t('mood.failed', { error: t('mood.metadata_unavailable') }))
      return
    }

    const result = await diaryMoodCommand.setMood(date, mood, expectedUpdatedAt)
    if (result.status === 'updated') {
      await onMetadataSaved(result.metadata)
      diaryCalendarSurfaceRef.value?.closeMoodPicker(!shouldPresentAfterMutation)
      toast.success(t('mood.saved'))
      if (
        shouldPresentAfterMutation
        && dateReadyForPresentation
        && presentationIntent !== null
        && diaryWorkspacePresentation.isDateIntentCurrent(presentationIntent)
      ) {
        // A missing-date Mood-first flow only owns the FileTree seed after
        // the canonical Diary create and authoritative Mood CAS both commit.
        // Existing-date edits, clears, conflicts, and cancellations never
        // overwrite the user's ordinary FileTree query. The second command
        // call is now safe: Mood CAS has already committed, so it can use the
        // existing native date-opening lifecycle without exposing a document
        // during a failed Mood mutation.
        // The repair handoff is one-shot: consume it before attempting the
        // native open so a failed handoff cannot make a later ordinary Mood
        // edit navigate unexpectedly.
        clearPendingMoodFirstPresentation()
        diaryFilterSeed.value = date
        diaryFilterOwnership.value = 'calendar'
        filesFilter.value = date
        const openResult = await openDiaryDate(date)
        if (openResult.status === 'opened' || openResult.status === 'created') {
          await presentDiaryDateResult(openResult, presentationIntent)
        }
      }
    } else {
      if (shouldPresentAfterMutation && dateReadyForPresentation) {
        // Creation is authoritative even when Mood CAS fails. Keep the
        // created file as an existing '?' repair target, but defer native
        // Diary presentation until a later Mood CAS succeeds.
        rememberPendingMoodFirstPresentation(date, presentationIntent)
      }
      if (result.status === 'not-found') toast.info(t('mood.not_found'))
      if (result.status === 'conflict' || result.status === 'not-found' || result.status === 'error') {
        await refreshAfterMoodRejection()
      }
    }
  } finally {
    diaryMoodBusy.value = false
  }
}

async function onDiaryDateSelected(date: DiaryDate): Promise<void> {
  diaryCalendarSurfaceRef.value?.closeMoodPicker(false)
  // Explicit date navigation abandons any deferred Mood-first handoff for a
  // previous repair context, including when it targets the same date.
  clearPendingMoodFirstPresentation()
  const intent = diaryWorkspacePresentation.beginDateIntent()
  const result: DiaryDateCommandResult = await openDiaryDate(date)
  // A Calendar date click becomes a committed FileTree seed only after the
  // canonical date command opens or creates the Diary. Rejected dates (most
  // importantly missing future dates) must leave the user's ordinary query
  // untouched. FileTree clicks never reach this handler and therefore cannot
  // rewrite the query.
  if (result.status === 'opened' || result.status === 'created') {
    diaryFilterSeed.value = date
    diaryFilterOwnership.value = 'calendar'
    filesFilter.value = date
  }
  await presentDiaryDateResult(result, intent)
}

async function presentDiaryDateResult(
  result: DiaryDateCommandResult,
  intent: number,
): Promise<void> {
  if (
    !diaryWorkspacePresentation.isDateIntentCurrent(intent)
    || !isDiaryScope.value
    || !diaryPresentationEligible.value
  ) return
  diaryWorkspacePresentation.recordDateCommandResult(result)
  if (result.status !== 'opened' && result.status !== 'created') return
  if (activePath.value !== result.path) {
    diaryWorkspacePresentation.reset()
    return
  }
  diaryWorkspacePresentation.requestDocument(result.date, result.path)
  viewModeApi?.set('read')
  await nextTick()
  if (diaryWorkspacePresentation.isDateIntentCurrent(intent)) {
    vaultRef.value?.focus()
  }
}

/* ---------- Tag filter ---------- */
const selectedTag = ref<string | null>(null)
const tagManagementPanelRef = ref<{ canLeave: boolean } | null>(null)
const tagManagementCanLeave = computed(() => tagManagementPanelRef.value?.canLeave ?? true)
// Phase 2 management dialogs use this local monotonic epoch to distinguish
// an actual user selection change from an asynchronous Apply completion.
// The manager remains owned by VaultView while Settings provides its page host.
const tagSelectionEpoch = ref(0)
function selectTag(tag: string): void {
  selectedTag.value = selectedTag.value === tag ? null : tag
  tagSelectionEpoch.value += 1
}

/**
 * VaultView owns the one post-commit synchronization cycle. The panel only
 * captures the Apply-start snapshot and hands the committed result here; the
 * shell refreshes both authoritative projections together, then performs the
 * stable-ID selection reconciliation against the fresh management list.
 */
async function synchronizeCommittedTagOperation(
  result: TagOperationApplyResult,
  snapshot: TagSelectionSnapshot,
): Promise<{ managedTags: ManagedTag[]; selectedTag: string | null; undoAvailability: UndoAvailability }> {
  const [, freshTags, undoAvailability] = await Promise.all([
    refresh(),
    listManagedTags(),
    getUndoAvailability(),
  ])
  const reconciled = reconcileTagSelection({
    snapshot,
    currentSelectedTag: selectedTag.value,
    currentSelectionEpoch: tagSelectionEpoch.value,
    operation: result.operation,
    result,
    managedTags: freshTags,
  })
  selectedTag.value = reconciled
  return { managedTags: freshTags, selectedTag: reconciled, undoAvailability }
}

/**
 * VaultView owns the exceptional recovery cycle after a committed Apply
 * response fails the reviewed-Preview contract. The submitted operation and
 * selection snapshot are trusted; the contradictory Apply result is not.
 */
async function recoverCommittedTagOperation(
  operation: TagOperationRequest,
  snapshot: TagSelectionSnapshot,
): Promise<{ managedTags: ManagedTag[]; selectedTag: string | null; undoAvailability: UndoAvailability }> {
  const [, freshTags, undoAvailability] = await Promise.all([
    refresh(),
    listManagedTags(),
    getUndoAvailability(),
  ])
  const reconciled = reconcileCommittedTagSelectionFromOperation({
    snapshot,
    currentSelectedTag: selectedTag.value,
    currentSelectionEpoch: tagSelectionEpoch.value,
    operation,
    managedTags: freshTags,
  })
  selectedTag.value = reconciled
  return { managedTags: freshTags, selectedTag: reconciled, undoAvailability }
}

interface UndoSynchronizationResult {
  managedTags: ManagedTag[]
  selectedTag: string | null
  undoAvailability: UndoAvailability
}

interface CommittedUndoRecoveryResult extends UndoSynchronizationResult {
  outcome: 'consumed' | 'superseded' | 'terminal-unavailable'
}

/** VaultView owns the authoritative post/managed-tag/Undo read cycle after a
 * trusted Undo Apply. The dialog never mutates production selection or tag
 * projections optimistically. */
async function synchronizeCommittedUndo(
  result: UndoApplyResult,
  snapshot: TagSelectionSnapshot,
): Promise<UndoSynchronizationResult> {
  const [, freshTags, undoAvailability] = await Promise.all([
    refresh(),
    listManagedTags(),
    getUndoAvailability(),
  ])
  const reconciled = reconcileUndoTagSelection({
    snapshot,
    currentSelectedTag: selectedTag.value,
    currentSelectionEpoch: tagSelectionEpoch.value,
    result,
    managedTags: freshTags,
  })
  selectedTag.value = reconciled
  return { managedTags: freshTags, selectedTag: reconciled, undoAvailability }
}

/** Read-only recovery for an Apply response that may have committed. The
 * submitted record ID is the only recovery anchor; no Undo Apply is issued
 * from this seam. */
async function recoverCommittedUndo(
  recordId: string,
  snapshot: TagSelectionSnapshot,
): Promise<CommittedUndoRecoveryResult> {
  const recovered = await recoverCommittedUndoStatus(recordId)
  const [, freshTags, undoAvailability] = await Promise.all([
    refresh(),
    listManagedTags(),
    getUndoAvailability(),
  ])

  if (recovered.state === 'consumed' && recovered.reasonCode === 'UNDO_ALREADY_APPLIED') {
    const reconciled = reconcileCommittedUndoTagSelection({
      snapshot,
      currentSelectedTag: selectedTag.value,
      currentSelectionEpoch: tagSelectionEpoch.value,
      availability: recovered,
      managedTags: freshTags,
    })
    selectedTag.value = reconciled
    return {
      managedTags: freshTags,
      selectedTag: reconciled,
      undoAvailability,
      outcome: 'consumed',
    }
  }

  if (recovered.state === 'superseded') {
    return {
      managedTags: freshTags,
      selectedTag: selectedTag.value,
      undoAvailability,
      outcome: 'superseded',
    }
  }

  if (recovered.state === 'terminal-unavailable') {
    return {
      managedTags: freshTags,
      selectedTag: selectedTag.value,
      undoAvailability,
      outcome: 'terminal-unavailable',
    }
  }

  // A read that cannot prove consumed/superseded status must not be treated
  // as evidence that the mutation committed. The dialog keeps the operation
  // in read-only synchronization-pending recovery.
  throw new Error('Committed Undo could not be proven by authoritative recovery')
}

/* ---------- Bi-directional links ---------- */
// Mount the file-change-bus subscription so the link index stays
// fresh as the user (or AI) edits. The initial fetch is triggered
// by useLinkIndexSubscription's onMounted.
useLinkIndexSubscription(fileChanges)

// Wiki-link resolver: reads the *current* link index from this Vault
// instance. useMarkdownRender passes this closure through the
// render-scoped markdown-it env, so panes always see the latest index
// without sharing resolver state or having to re-mount.
const linkIndex = getLinkIndex(fileChanges)
const wikiResolver = (ref: string, _anchor?: string, context?: { sourcePath?: string }) => {
  const allPaths = Array.from(linkIndex.value.paths)
  const sourcePath = context?.sourcePath?.replace(/\.md$/iu, '') ?? activePath.value ?? ''
  return {
    target: resolveWikiTarget(ref, sourcePath, allPaths),
    alias: ref,
  }
}

interface PdfExportRequest {
  id: number
  path: string
  raw: string
  title: string
  sessionGeneration: number
}

interface PdfRenderWaiter {
  id: number
  resolve: (article: HTMLElement) => void
  reject: (error: Error) => void
}

const pdfExportRequest = shallowRef<PdfExportRequest | null>(null)
const pdfExportBusy = ref(false)
let pdfExportSequence = 0
let pdfRenderWaiter: PdfRenderWaiter | null = null

// A PDF export may target a document other than the active tab. Resolve
// wiki-links relative to that target instead of borrowing activePath.
const pdfWikiResolver = (ref: string, _anchor?: string, context?: { sourcePath?: string }) => {
  const allPaths = Array.from(linkIndex.value.paths)
  const sourcePath = context?.sourcePath?.replace(/\.md$/iu, '')
    ?? pdfExportRequest.value?.path
    ?? activePath.value
    ?? ''
  return {
    target: resolveWikiTarget(ref, sourcePath, allPaths),
    alias: ref,
  }
}

function waitForPdfArticle(request: PdfExportRequest): Promise<HTMLElement> {
  return new Promise((resolve, reject) => {
    const managed = classifyDiaryPath(request.path.replace(/\.md$/, '')) === 'managed'
    if (managed && (!diaryAccess.isUnlocked.value
      || !isDiarySessionGenerationCurrent(request.sessionGeneration))) {
      reject(new Error('DIARY_SESSION_INVALIDATED'))
      return
    }
    const timeout = window.setTimeout(() => {
      if (pdfRenderWaiter?.id !== request.id) return
      pdfRenderWaiter = null
      reject(new Error('PDF_RENDER_TIMEOUT'))
    }, 5000)
    pdfRenderWaiter = {
      id: request.id,
      resolve: (article) => {
        window.clearTimeout(timeout)
        if (pdfRenderWaiter?.id === request.id) pdfRenderWaiter = null
        resolve(article)
      },
      reject: (error) => {
        window.clearTimeout(timeout)
        if (pdfRenderWaiter?.id === request.id) pdfRenderWaiter = null
        reject(error)
      },
    }
    pdfExportRequest.value = request
  })
}

function pdfWidgetsReady(article: HTMLElement): boolean {
  return pdfEnhancementsReady(article)
}

async function waitForPdfWidgets(article: HTMLElement): Promise<void> {
  if (pdfWidgetsReady(article)) return
  await new Promise<void>((resolve, reject) => {
    const observer = new MutationObserver(check)
    const timeout = window.setTimeout(() => {
      observer.disconnect()
      reject(new Error('PDF_WIDGET_TIMEOUT'))
    }, 5000)
    function check() {
      if (!pdfWidgetsReady(article)) return
      window.clearTimeout(timeout)
      observer.disconnect()
      resolve()
    }
    observer.observe(article, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        'data-math-state',
        'data-mermaid-state',
        'data-markmap-state',
        'data-mermaid-ready',
        'data-markmap-ready',
        'data-mermaid-error',
        'data-markmap-error',
      ],
    })
    check()
  })
}

function onPdfExportRendered(article: HTMLElement | null): void {
  if (!article || !pdfRenderWaiter) return
  pdfRenderWaiter.resolve(article)
}

async function exportPdfDocument(path: string): Promise<void> {
  if (pdfExportBusy.value) {
    toast.info(t('file_tree.exporting_pdf'))
    return
  }

  pdfExportBusy.value = true
  const id = ++pdfExportSequence
  const sessionGeneration = captureDiarySessionGeneration()
  const managed = classifyDiaryPath(path.replace(/\.md$/, '')) === 'managed'
  try {
    if (managed && !diaryAccess.isUnlocked.value) {
      throw new Error('DIARY_SESSION_INVALIDATED')
    }
    const liveTab = tabs.value.find((tab) => tab.path === path)
    const summary = posts.value.find((post) => post.path === path)
    let raw = ''
    let title = liveTab?.title || summary?.title || ''

    // Prefer the live workspace buffer so a right-click export does not
    // silently discard unsaved edits in an already-open document.
    if (liveTab && !liveTab.loading && !liveTab.loadError) {
      raw = liveTab.raw
    } else {
      const post = await getPost(path)
      if (managed && !isDiarySessionGenerationCurrent(sessionGeneration)) throw new Error('DIARY_SESSION_INVALIDATED')
      raw = post.raw
      title = post.metadata?.title?.trim() || title
    }

    if (managed && !isDiarySessionGenerationCurrent(sessionGeneration)) throw new Error('DIARY_SESSION_INVALIDATED')
    const request: PdfExportRequest = { id, path, raw, title, sessionGeneration }
    const article = await waitForPdfArticle(request)
    if (managed && !isDiarySessionGenerationCurrent(sessionGeneration)) throw new Error('DIARY_SESSION_INVALIDATED')
    await waitForPdfWidgets(article)
    if (managed && !isDiarySessionGenerationCurrent(sessionGeneration)) throw new Error('DIARY_SESSION_INVALIDATED')
    await waitForPdfImages(article)
    if (managed && !isDiarySessionGenerationCurrent(sessionGeneration)) throw new Error('DIARY_SESSION_INVALIDATED')
    const label = resolvePdfDocumentLabel({ raw, documentTitle: title, documentPath: path })
    await downloadPdfDocument({
      title: label,
      articleHtml: preparePdfArticleHtml(article),
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'DIARY_SESSION_INVALIDATED') return
    toast.error(t(
      error instanceof Error && (error.message === 'PDF_RENDER_TIMEOUT' || error.message === 'PDF_WIDGET_TIMEOUT')
        ? 'file_tree.export_not_ready'
        : 'file_tree.export_failed',
    ))
  } finally {
    if (pdfRenderWaiter?.id === id) pdfRenderWaiter = null
    pdfExportRequest.value = null
    pdfExportBusy.value = false
  }
}

// DiaryAccessSession is the sole teardown authority. Every subordinate
// surface subscribes to its synchronous generation fence so a lock/logout
// clears decrypted holders before late network/render work can publish again.
const stopDiaryTeardown = subscribeDiaryTeardown(() => {
  clearManagedDiaryWorkspace()
  draftPersistence.clearSensitiveState()
  draftRecovery.clearSensitiveState()
  recoveryTabs.clearSensitiveState()
  historyComparisons.clearSensitiveState()
  workingTreeDiffs.clearSensitiveState()
  clearLinkIndex(fileChanges)
  invalidateDocumentSearchState()
  documentSearchSource.invalidate()
  disposeManagedDiaryModels()
  vaultContext.toc.tocHeadings.value = []
  vaultContext.toc.tocActiveId.value = ''
  vaultContext.toc.tocScrollTo.value = null
  vaultContext.toc.linksEmpty.value = true
  pdfExportSequence += 1
  if (pdfRenderWaiter) {
    pdfRenderWaiter.reject(new Error('DIARY_SESSION_INVALIDATED'))
    pdfRenderWaiter = null
  }
  pdfExportRequest.value = null
  pdfExportBusy.value = false
})
onBeforeUnmount(() => {
  stopDiaryTeardown()
  // Keep ordinary document metadata available to the retained App-level
  // search host while moving between Vault, Ledger, and Board. Auth logout
  // clears the source centrally; a still-authenticated route change does not
  // create a new session boundary.
  if (appShell) appShell.diaryCalendarVisible.value = false
})

/* After the Monaco addAction emits toggle-view-mode and isReadMode
   flips to true, the EditorPane is unmounted — taking the focused
   Monaco instance with it. The browser typically falls back to
   <body>, which is outside .vault's @keydown target. We explicitly
   move focus onto the vault container (which already has tabindex="0")
   so the next Cmd/Ctrl+E lands on the @keydown handler and can toggle
   back to edit mode. */
watch(isReadMode, async (reading) => {
  if (reading) {
    await nextTick()
    vaultRef.value?.focus()
  }
})

/* The mode toggle only swaps the editor/preview split for a single
   reading surface — the side panel, activity bar, tabs, and status
   bar (which now also carries the document path) all stay put so
   the user can still navigate while reading. So the vault's grid
   layout is the same in both modes. */
</script>

<template>
  <div
    ref="vaultRef"
    class="vault"
    :class="{ 'is-read': isReadMode, 'right-rail-open': rightRailVisible, 'side-panel-open': sidePanelOpen, 'diary-calendar-mode': isDiaryCalendarVisible, 'diary-native-document-mode': isDiaryDocumentMode }"
    tabindex="0"
    :style="vaultStyle"
    @keydown="onVaultKeydown"
  >
    <ActivityBar
      v-if="workspaceLeftSidebarVisible"
      :active-panel="activePanel"
      @select-panel="selectActivityPanel"
    />

    <SettingsModal
      :open="settingsOpen"
      :active-section-can-leave="tagManagementCanLeave"
      @close="settingsOpen = false"
    >
      <template #tags>
        <TagManagementPanel
          ref="tagManagementPanelRef"
          :selected-tag="selectedTag"
          :selection-epoch="tagSelectionEpoch"
          :sync-after-commit="synchronizeCommittedTagOperation"
          :recover-committed-operation="recoverCommittedTagOperation"
          :sync-after-undo="synchronizeCommittedUndo"
          :recover-committed-undo="recoverCommittedUndo"
        />
      </template>
    </SettingsModal>

    <DraftRecoveryPrompt
      :item="draftRecovery.pendingItem.value"
      :busy="recoveryBusy"
      @restore="restoreRecoveryDraft"
      @diff="(id) => openRecoveryView(id, 'diff')"
      @content="(id) => openRecoveryView(id, 'content')"
      @disk="discardRecoveryDraft"
      @discard="discardRecoveryDraft"
      @later="draftRecovery.dismissForSession"
      @retry="retryManagedRecovery"
      @manage="selectPanel('recovery')"
    />

    <FileTree
      v-if="workspaceLeftSidebarVisible && activePanel === 'files'"
      ref="fileTreeRef"
      :filter="filesFilter"
      :tree="tree"
      :posts="posts"
      :current-path="activePath"
      :exact-path-filter="diaryExactPathFilter"
      @update:filter="onFilesFilterEdited"
      @select="openPost"
      @refresh="refresh"
      @export-pdf="exportPdfDocument"
      @open-history="openFileHistory"
    />
    <TagPanel
      v-else-if="workspaceLeftSidebarVisible && activePanel === 'tags'"
      v-model:filter="tagsFilter"
      :posts="posts"
      :selected-tag="selectedTag"
      :path="activePath"
      @select="selectTag"
      @open="openPost"
    />
    <HistoryPanel
      v-else-if="workspaceLeftSidebarVisible && activePanel === 'history'"
      :history="history"
      :commit="historyCommit"
      :withdraw="historyWithdraw"
      :file-history="sidebarFileHistory"
      :posts="posts"
      :active-diff-path="activeWorkingTreeDiff?.documentPath ? `${activeWorkingTreeDiff.documentPath}.md` : null"
      @show-all-history="showAllHistory"
      @open-revision="openHistoryComparison"
      @open-diff="openWorkingTreeDiff"
    />
    <DraftRecoveryCenter
      v-else-if="workspaceLeftSidebarVisible && activePanel === 'recovery'"
      :records="recoveryManagement.records.value"
      :items="draftRecovery.items.value"
      :capacity="recoveryManagement.capacity.value"
      :unsupported-count="recoveryManagement.unsupportedCount.value"
      :selected-ids="recoveryManagement.selectedIds.value"
      :protected-ids="recoveryManagement.protectedIds.value"
      :loading="recoveryManagement.loading.value"
      :error="recoveryManagement.error.value"
      @refresh="refreshRecoveryCenter"
      @delete-selected="deleteSelectedRecovery"
      @toggle="recoveryManagement.toggleSelected"
      @open="(id) => openRecoveryView(id, 'content')"
      @retry="retryManagedRecovery"
      @delete="deleteManagedRecovery"
    />

    <div
      v-if="workspaceLeftSidebarVisible && sidePanelOpen"
      class="splitter"
      role="separator"
      aria-orientation="vertical"
      :title="t('vault.resize_sidebar')"
      @pointerdown="startDrag(vaultRef!, 'tree', $event)"
    />

    <section
      class="editor-area"
      :class="{ 'is-read': isReadMode, 'is-empty': workspaceTabs.length === 0, 'is-diary-home': isDiaryCalendarVisible }"
    >
      <EditorTabs
        v-if="workspaceTabs.length > 0"
        v-show="!isDiaryPresentationPrimary"
        ref="editorTabsRef"
        :tabs="workspaceTabs"
        :active-path="activeWorkspaceTabId"
        :context-actions-visible="false"
        @select="selectWorkspaceTab"
        @close="closeWorkspaceTab"
        @close-many="closeManyWorkspaceTabs"
        @copy-path="copyWorkspaceTabPath"
        @reveal-in-tree="revealWorkspaceTabInTree"
        @reorder="reorderWorkspaceTabs"
      />

      <!-- Calendar Home is the only Diary-owned surface. The subtree stays
           mounted for the whole Diary scope while native Vault documents use
           the ordinary editor/reader surfaces below. -->
      <DiaryWorkspace
        v-if="isDiaryCalendarMounted"
        :eligible="diaryPresentationEligible"
        :mode="presentationMode"
        :visible="isDiaryCalendarVisible"
        class="content diary-calendar-content"
      >
        <template #home>
          <DiaryCalendarSurface
            ref="diaryCalendarSurfaceRef"
            :tree="tree"
            :posts="posts"
            :loading="treeLoading"
            :error="treeError"
            :mood-busy="diaryMoodBusy"
            @date-selected="onDiaryDateSelected"
            @mood-change="updateDiaryCalendarMood"
          />
        </template>
      </DiaryWorkspace>

      <!-- Edit mode: single Monaco editor surface. -->
      <div
        v-if="!isReadMode"
        v-show="!isDiaryPresentationPrimary && !activeHistoryComparison && !activeWorkingTreeDiff && !activeDraftRecovery"
        class="content"
      >
        <div
          v-if="activeTab"
          class="editor-pane"
          :data-path="activeTab.path"
        >
          <div v-if="activeTab.loading" class="empty" role="status">{{ t('vault.loading_document', { path: activeTab.path }) }}</div>
          <div v-else-if="activeTab.loadError" class="empty error" role="alert">{{ activeTab.loadError }}</div>
          <EditorPane
            v-else
            :key="activeTab.path"
            :model-value="activeTab.raw"
            :path="activeTab.path"
            :focus-width="editorFocusWidth"
            :link-targets="editorLinkTargets"
            @update:model-value="(val: string) => onEditorChange(activeTab!.path, val)"
            @open-link="openPost"
            @create-link="createMissingWikiNote"
            @toggle-view-mode="viewModeApi?.toggle()"
          />
        </div>
        <div v-if="!tabs.length" class="content-empty">
          <EmptyState :title="t('vault.no_file_open')">
            <span v-for="a in emptyActions" :key="a.label" class="hint-row">
              <span class="hint-label">{{ a.label }}</span>
              <kbd class="hint-kbd">{{ a.keys }}</kbd>
            </span>
          </EmptyState>
        </div>
      </div>

      <!-- Read mode: single reading surface in the same slot. The side
           panel, tabs, and status bar above/below stay untouched so
           navigation still works while reading. -->
      <div
        v-if="isReadMode && !isDiaryPresentationPrimary && !activeHistoryComparison && !activeWorkingTreeDiff && !activeDraftRecovery"
        v-show="!isDiaryPresentationPrimary"
        class="content reading-content"
      >
        <!-- Only the active tab is mounted. Mounting one ReadingPane
             per tab (v-for + v-show) would have every instance write
             to the same Vault-scoped tocHeadings / tocActiveId, and
             whichever rendered last would "win" — so switching tabs
             could surface the wrong document's TOC. Mounting a single
             keyed-by-path ReadingPane keeps the mapping 1:1 between
             the visible ReadingPane and the shared TOC state. -->
        <div
          v-if="activeTab"
          :key="activeTab.path"
          class="reading-slot"
        >
          <ReadingPane
            :raw="activeTab.raw"
            :resolver="wikiResolver"
            :source-path="activeTab.path"
          />
        </div>
        <div v-if="!tabs.length" class="content-empty">
          <EmptyState :title="t('vault.no_file_open')">
            <span v-for="a in emptyActions" :key="a.label" class="hint-row">
              <span class="hint-label">{{ a.label }}</span>
              <kbd class="hint-kbd">{{ a.keys }}</kbd>
            </span>
          </EmptyState>
        </div>
      </div>

      <div v-if="activeHistoryComparison" class="content">
        <HistoryComparisonPane
          ref="comparisonPaneRef"
          :comparison="activeHistoryComparison"
          :restoring="historyRestore.restoring.value && historyRestore.restoringPath.value === activeHistoryComparison.documentPath"
          :mutation-locked="historyMutationLock.has(`${activeHistoryComparison.documentPath}.md`)"
          @restore="restoreHistoricalVersion"
          @compare-with-working-tree="compareHistoryWithWorkingTree"
          @view-commit-changes="viewHistoryCommitChanges"
          @retry="historyComparisons.refreshComparison"
        />
      </div>

      <div v-if="activeWorkingTreeDiff" class="content">
        <WorkingTreeDiffPane
          ref="workingTreeDiffPaneRef"
          :diff="activeWorkingTreeDiff"
          @retry="workingTreeDiffs.refreshDiff"
        />
      </div>

      <div v-if="activeDraftRecovery" class="content">
        <DraftRecoveryPane
          ref="recoveryPaneRef"
          :recovery="activeDraftRecovery"
          @update-view="updateRecoveryView"
          @view-current="viewCurrentRecoveryDocument"
          @discard="discardRecoveryDraft"
          @close="closeWorkspaceTab"
        />
      </div>
    </section>

    <div
      v-if="workspaceSidebarVisible && rightRailVisible"
      class="splitter splitter-toc"
      role="separator"
      aria-orientation="vertical"
      :title="t('vault.resize_right_rail')"
      @pointerdown="startDrag(vaultRef!, 'rightRail', $event)"
    />
    <RightRail
      v-if="workspaceSidebarVisible"
      v-show="rightRailVisible"
      class="right-rail-slot"
      :path="metadataPath"
      :posts="posts"
      :active-tab="rightRailTab"
      :is-read-mode="isReadMode"
      :file-history="rightRailFileHistory"
      :metadata-context="metadataContext"
      :metadata-readonly="metadataReadonly"
      :summary-source="metadataSummaryContent"
      @update:active-tab="rightRailTab = $event"
      @link-navigate="openPost"
      @metadata-saved="onMetadataSaved"
      @switch-to-read="switchToReadMode"
      @open-history-revision="openHistoryComparison"
    />

    <StatusBar
      v-if="statusBarLayoutVisible"
      class="status-bar-row"
      :path="activeDraftRecovery?.documentPath ?? activeHistoryComparison?.documentPath ?? activeWorkingTreeDiff?.documentPath ?? activePath"
      :save="activeSavePresentation"
      :error="activeHistoryComparison || activeWorkingTreeDiff || activeDraftRecovery ? null : (activeTab?.error ?? null)"
      :size="activeDraftRecovery ? activeDraftRecovery.draftRaw.length : (activeHistoryComparison ? activeHistoryComparison.afterRaw.length : activeSize)"
      :focus-width="editorFocusWidth"
      :external-kind="activeHistoryComparison || activeWorkingTreeDiff || activeDraftRecovery ? null : (activeTab?.externalKind ?? null)"
      @toggle-focus-width="editorFocusWidth = !editorFocusWidth"
      @retry-save="doSaveNow"
      @copy-content="copyActiveContent"
      @external-diff="showExternalDiff"
      @external-disk="activePath && resolveExternal(activePath, 'disk')"
      @external-local="activePath && resolveExternal(activePath, 'local')"
    />

    <PdfExportSurface
      v-if="pdfExportRequest"
      :key="pdfExportRequest.id"
      :raw="pdfExportRequest.raw"
      :resolver="pdfWikiResolver"
      :source-path="pdfExportRequest.path"
      @rendered="onPdfExportRendered"
    />
  </div>
</template>

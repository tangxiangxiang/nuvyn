import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { applyMetadataToPostSummary } from '../metadataPostSummary'
import { handleDiaryHomeKeydown } from '../diaryHomeKeyboard'

function keyboardEvent(
  key: string,
  options: { ctrlKey?: boolean; metaKey?: boolean } = {},
): KeyboardEvent {
  let prevented = false
  return {
    key,
    ctrlKey: options.ctrlKey ?? false,
    metaKey: options.metaKey ?? false,
    get defaultPrevented() {
      return prevented
    },
    preventDefault() {
      prevented = true
    },
  } as unknown as KeyboardEvent
}

describe('VaultView editor tab wiring', () => {
  it('settles PDF images before preparing the export snapshot', () => {
    const source = readFileSync(fileURLToPath(new URL('../VaultView.vue', import.meta.url)), 'utf8')
    const exportHandler = source.match(/async function exportPdfDocument[\s\S]*?\n}/)?.[0]

    expect(source).toContain("import { waitForPdfImages } from '../lib/pdf-images'")
    expect(exportHandler).toBeDefined()
    expect(exportHandler).toContain('await waitForPdfWidgets(article)')
    expect(exportHandler).toContain('await waitForPdfImages(article)')
    expect(exportHandler).toContain('articleHtml: preparePdfArticleHtml(article)')
    expect(exportHandler!.indexOf('await waitForPdfWidgets(article)')).toBeLessThan(
      exportHandler!.indexOf('await waitForPdfImages(article)'),
    )
    expect(exportHandler!.indexOf('await waitForPdfImages(article)')).toBeLessThan(
      exportHandler!.indexOf('preparePdfArticleHtml(article)'),
    )
  })

  it('routes File Tree through the canonical PDF export pipeline only', () => {
    const source = readFileSync(fileURLToPath(new URL('../VaultView.vue', import.meta.url)), 'utf8')
    const exportHandler = source.match(/async function exportPdfDocument[\s\S]*?\n}/)?.[0]
    const readingPane = source.match(/<ReadingPane[\s\S]*?\/>/)?.[0]

    expect(source.match(/async function exportPdfDocument/g)).toHaveLength(1)
    expect(exportHandler).toBeDefined()
    expect(readingPane).toBeDefined()
    expect(source).toContain('@export-pdf="exportPdfDocument"')
    expect(readingPane).not.toMatch(/pdf|export/i)
    expect(source).not.toContain('exportPdfFromTree')
    expect(source).not.toContain('exportPdfFromReader')
    expect(source).not.toContain('downloadPdfFromReader')
    expect(source).not.toContain('prepareReadModePdf')
  })

  it('owns the embedded panel seam and one canonical post-commit sync cycle', () => {
    const source = readFileSync(fileURLToPath(new URL('../VaultView.vue', import.meta.url)), 'utf8')
    const sync = source.match(/async function synchronizeCommittedTagOperation[\s\S]*?\n}/)?.[0]
    const recovery = source.match(/async function recoverCommittedTagOperation[\s\S]*?\n}/)?.[0]

    expect(source).toContain("import TagManagementPanel from '../components/vault/TagManagementPanel.vue'")
    expect(source).toContain('const tagManagementPanelRef = ref<{ canLeave: boolean } | null>(null)')
    expect(source).toContain('const tagManagementCanLeave = computed(() => tagManagementPanelRef.value?.canLeave ?? true)')
    expect(source).toContain('const tagSelectionEpoch = ref(0)')
    expect(source).toContain('<TagManagementPanel')
    expect(source).toContain('<template #tags>')
    expect(source).toContain(':active-section-can-leave="tagManagementCanLeave"')
    expect(source).toContain(':sync-after-commit="synchronizeCommittedTagOperation"')
    expect(source).toContain(':recover-committed-operation="recoverCommittedTagOperation"')
    expect(source).toContain(':sync-after-undo="synchronizeCommittedUndo"')
    expect(source).toContain(':recover-committed-undo="recoverCommittedUndo"')
    expect(source).not.toContain('TagManagementDialog')
    expect(source).not.toContain('tagManagementOpen')
    expect(source).not.toContain('tagManagementHandoffPending')
    expect(source).not.toContain('@manage-tags=')
    expect(source).not.toContain('@close-complete=')
    expect(sync).toBeDefined()
    expect(sync).toContain('const [, freshTags, undoAvailability] = await Promise.all([')
    expect(sync).toContain('refresh(),')
    expect(sync).toContain('listManagedTags(),')
    expect(sync).toContain('getUndoAvailability(),')
    expect(sync).toContain('undoAvailability')
    expect(sync).toContain('reconcileTagSelection({')
    expect(sync).toContain('selectedTag.value = reconciled')
    expect(sync).not.toContain('refreshLinkIndex')
    expect(sync).not.toContain('applyPostSummary')
    expect(recovery).toBeDefined()
    if (!recovery) throw new Error('VaultView committed recovery seam is missing')
    expect(recovery).toContain('const [, freshTags, undoAvailability] = await Promise.all([')
    expect(recovery).toContain('refresh(),')
    expect(recovery).toContain('listManagedTags(),')
    expect(recovery).toContain('getUndoAvailability(),')
    expect(recovery.match(/\brefresh\(\)/g)).toHaveLength(1)
    expect(recovery.match(/\blistManagedTags\(\)/g)).toHaveLength(1)
    expect(recovery).toContain('reconcileCommittedTagSelectionFromOperation({')
    expect(recovery).toContain('selectedTag.value = reconciled')
    expect(recovery.indexOf('listManagedTags()')).toBeLessThan(recovery.indexOf('reconcileCommittedTagSelectionFromOperation({'))
    expect(recovery).not.toContain('tagSelectionEpoch.value += 1')
    expect(recovery).not.toContain('result.')

    const undoSync = source.match(/async function synchronizeCommittedUndo[\s\S]*?\n}/)?.[0]
    const undoRecovery = source.match(/async function recoverCommittedUndo[\s\S]*?\n}/)?.[0]
    expect(undoSync).toBeDefined()
    expect(undoSync).toContain('const [, freshTags, undoAvailability] = await Promise.all([')
    expect(undoSync).toContain('refresh(),')
    expect(undoSync).toContain('listManagedTags(),')
    expect(undoSync).toContain('getUndoAvailability(),')
    expect(undoSync).toContain('reconcileUndoTagSelection({')
    expect(undoSync).toContain('selectedTag.value = reconciled')
    expect(undoRecovery).toBeDefined()
    expect(undoRecovery).toContain('recoverCommittedUndoStatus(recordId)')
    expect(undoRecovery).toContain('const [, freshTags, undoAvailability] = await Promise.all([')
    expect(undoRecovery).toContain('reconcileCommittedUndoTagSelection({')
    expect(undoRecovery).not.toContain('applyUndo')
  })

  it('derives one save presentation per document and shares the active result with StatusBar', () => {
    const source = readFileSync(fileURLToPath(new URL('../VaultView.vue', import.meta.url)), 'utf8')

    expect(source).toContain('save: deriveDocumentSavePresentation(tab)')
    expect(source).toContain('save: deriveDocumentSavePresentation(null)')
    expect(source).toContain('const activeSavePresentation = computed(() => (')
    expect(source).toContain(':save="activeSavePresentation"')
    expect(source).not.toContain("dirty: tab.saveStatus === 'dirty'")
    expect(source).not.toContain(':save-status=')
  })

  it('re-keys EditorPane and binds events to the rendered tab path', () => {
    const source = readFileSync(fileURLToPath(new URL('../VaultView.vue', import.meta.url)), 'utf8')
    const editorPane = source.match(/<EditorPane[\s\S]*?\/>/)?.[0]

    expect(editorPane).toBeDefined()
    expect(editorPane).toContain(':key="activeTab.path"')
    expect(editorPane).toContain('onEditorChange(activeTab!.path, val)')
    expect(editorPane).not.toContain('activePath!')
  })

  it('hands body search reveals to the active Edit Mode Monaco pane', () => {
    const source = readFileSync(fileURLToPath(new URL('../VaultView.vue', import.meta.url)), 'utf8')
    const editorPane = source.match(/<EditorPane[\s\S]*?\/>/)?.[0]

    expect(source).toContain("import { watchSearchRevealHandoff } from '../composables/vault/useSearchRevealHandoff'")
    expect(source).toContain('const editorPaneRef = ref<{ revealText(text: string): boolean } | null>(null)')
    expect(source).toContain('watchSearchRevealHandoff({')
    expect(source).toContain('isOrdinaryPresentation: isOrdinaryDocumentPresentation')
    expect(editorPane).toContain('ref="editorPaneRef"')
    expect(source).not.toContain('ReadingPane ref=')
  })

  it('keeps the editor and tabs mounted while the History sidebar is active', () => {
    const source = readFileSync(fileURLToPath(new URL('../VaultView.vue', import.meta.url)), 'utf8')

    expect(source).toContain('v-else-if="workspaceLeftSidebarVisible && activePanel === \'history\'"')
    expect(source).toContain('@open-revision="openHistoryComparison"')
    expect(source).not.toContain('import DiffView')
    expect(source).not.toContain("activePanel !== 'history' && tabs.length > 0")
    expect(source).not.toContain("activePanel === 'history'\" class=\"content content-diff\"")
  })

  it('owns a fixed file-history target independently from active editor tabs', () => {
    const source = readFileSync(fileURLToPath(new URL('../VaultView.vue', import.meta.url)), 'utf8')
    const openHandler = source.match(/function openFileHistory[\s\S]*?\n}/)?.[0]

    expect(source).toContain('const sidebarFileHistory = useFileHistory(locale)')
    expect(source).toContain('const rightRailFileHistory = useFileHistory(locale)')
    expect(source).toContain('resolveFileHistoryTarget(path, posts.value)')
    expect(openHandler).toContain('sidebarFileHistory.open(resolveFileHistoryTarget(path, posts.value))')
    expect(openHandler).toContain("selectPanel('history')")
    expect(source).toContain('@open-history="openFileHistory"')
    expect(source).toContain(':file-history="sidebarFileHistory"')
    expect(source).toContain(':file-history="rightRailFileHistory"')
    expect(source).toContain('@show-all-history="showAllHistory"')
    expect(source).toMatch(/function showAllHistory\(\): void \{[\s\S]*?sidebarFileHistory\.clear\(\)/)
    expect(source).toMatch(/watch\(vaultId,[\s\S]*?sidebarFileHistory\.clear\(\)[\s\S]*?rightRailFileHistory\.clear\(\)/)
    expect(source).not.toMatch(/watch\(activePath[\s\S]{0,200}fileHistory/)
  })

  it('keeps Activity Bar History as the explicit global-history entry point', () => {
    const source = readFileSync(fileURLToPath(new URL('../VaultView.vue', import.meta.url)), 'utf8')
    const handler = source.match(/function selectActivityPanel[\s\S]*?\n}/)?.[0]

    expect(handler).toContain("if (panel === 'history') sidebarFileHistory.clear()")
    expect(handler).toContain('selectPanel(panel)')
    expect(source).toContain('@select-panel="selectActivityPanel"')
  })

  it('syncs metadata saves globally', () => {
    const source = readFileSync(fileURLToPath(new URL('../VaultView.vue', import.meta.url)), 'utf8')
    const savedHandler = source.match(/async function onMetadataSaved[\s\S]*?\n}/)?.[0]

    expect(savedHandler).toBeDefined()
    expect(savedHandler).toContain('applyPostSummary(updated)')
    expect(savedHandler).toContain('applyMetadataToPostSummary(post, metadata)')
    expect(savedHandler).toContain('await Promise.all([refresh(), refreshLinkIndex(fileChanges)])')
    expect(savedHandler).toContain('metadata.sync_failed')
  })

  it('updates metadata fields without changing the Markdown mtime', () => {
    const post = {
      path: 'note',
      title: 'Old title',
      created: '2026-08-01',
      updated: '2026-08-01',
      tags: ['old'],
      summary: 'Old summary',
      size: 10,
      mtime: 100,
    }
    const updated = applyMetadataToPostSummary(post, {
      id: 'id-note',
      path: 'note',
      title: 'New title',
      summary: 'New summary',
      tags: ['new'],
      mood: null,
      createdAt: 1,
      updatedAt: 999,
    })

    expect(updated).toMatchObject({
      title: 'New title',
      summary: 'New summary',
      tags: ['new'],
      updated: '1970-01-01',
      mtime: 100,
    })
  })

  it('owns Create Version coordination at Vault scope across sidebar remounts', () => {
    const source = readFileSync(fileURLToPath(new URL('../VaultView.vue', import.meta.url)), 'utf8')

    expect(source).toContain('const historyCommit = useHistoryCommit({')
    expect(source).toContain(':commit="historyCommit"')
    expect(source).toContain('refreshComparisons(committedPaths)')
    expect(source).toContain('const historyMutationLock = createPathMutationLock()')
    expect(source.match(/acquireMutation: historyMutationLock\.acquire\b/g)).toHaveLength(2)
    expect(source).toContain('canMutate: historyMutationLock.canAcquire')
    expect(source).toContain("toast.info(t('history.document_mutation_in_progress'))")
    expect(source).toContain('comparisonPaneRef.value?.focusViewer()')
    expect(source.match(/:mutation-locked="historyMutationLock\.has/g)).toHaveLength(1)
    expect(source).not.toContain(':save-before-commit=')
  })

  it('coordinates latest-version withdrawal at Vault scope and closes dropped viewers', () => {
    const source = readFileSync(fileURLToPath(new URL('../VaultView.vue', import.meta.url)), 'utf8')

    expect(source).toContain('const historyWithdraw = useHistoryWithdraw({')
    expect(source).toContain('acquireMutation: historyMutationLock.acquireAll')
    expect(source).toContain('refreshIndexRepairStatus: historyCommit.refreshIndexRepairStatus')
    expect(source).toContain('registerIndexRepair: historyCommit.registerIndexRepair')
    expect(source).toContain('settleIndexRepairPaths: historyCommit.settleIndexRepairPaths')
    expect(source).toContain('.filter((comparison) => comparison.revisionId === sha)')
    expect(source).toContain(':withdraw="historyWithdraw"')
  })

  it('opens a single diff tab directly from a HistoryRevisionSelection', () => {
    const source = readFileSync(fileURLToPath(new URL('../VaultView.vue', import.meta.url)), 'utf8')

    // The comparison pane replaces both the snapshot viewer and the
    // old "Open Diff" intermediate button — clicking any history entry
    // goes straight to the diff tab.
    expect(source).toContain('<HistoryComparisonPane')
    expect(source).toContain(':comparison="activeHistoryComparison"')
    expect(source).not.toContain('<HistorySnapshotPane')
    expect(source).not.toContain('useHistorySnapshots')
    expect(source).not.toContain('activeHistorySnapshot')
    expect(source).not.toContain('snapshotPaneRef')
    expect(source).not.toContain('history-snapshot-')
    expect(source).toContain('const historyComparisons = useHistoryComparisons({')
    expect(source).toContain('getCurrentDocument(path)')
    expect(source).toContain('return getLoadedEditorDocument(tabs.value, path)')
    expect(source).toContain('return (await getPost(path)).raw')

    // The Timeline → diff handoff hands the selection straight to
    // useHistoryComparisons.openComparison, not via a snapshot pane.
    const openComparison = source.match(/async function openHistoryComparison[\s\S]*?\n}/)?.[0]
    expect(openComparison).toBeDefined()
    expect(openComparison).toContain('historyComparisons.openComparison(selection)')
    expect(openComparison).toContain('comparisonPaneRef.value?.focusViewer()')

    // Close-diff belongs to the workspace tab now; the comparison pane
    // no longer renders its own close button.
    expect(source).not.toContain(':history-read-only=')
    expect(source).toContain("import RightRail from '../components/vault/RightRail.vue'")
    expect(source).toContain('class="right-rail-slot"')
    expect(source).toContain('@switch-to-read="switchToReadMode"')
    expect(source).toContain('@open-diff="openWorkingTreeDiff"')
    expect(source).not.toContain('@view-historical=')
  })

  it('keeps Monaco mounted and isolates shortcuts for read-only history tabs', () => {
    const source = readFileSync(fileURLToPath(new URL('../VaultView.vue', import.meta.url)), 'utf8')
    const shortcutHandler = source.match(/function onVaultKeydown[\s\S]*?\n}/)?.[0]

    expect(source).toContain('v-show="!isDiaryPresentationPrimary && !activeHistoryComparison && !activeWorkingTreeDiff && !activeDraftRecovery"')
    expect(source).toContain('<HistoryComparisonPane')
    expect(source).toContain(':comparison="activeHistoryComparison"')
    expect(source).toContain('const historyComparisons = useHistoryComparisons({')
    expect(source).toContain("meta && event.key.toLowerCase() === 's'")
    expect(source).toContain('void closeWorkspaceTab(activeId)')
    expect(shortcutHandler).toBeDefined()
    expect(shortcutHandler?.match(/onEditorKeydown\(event\)/g)).toHaveLength(1)
    expect(shortcutHandler).toContain('if (!readOnlyTab)')
    expect(source).not.toContain('snapshots.value.push(activeTab')
  })

  it('routes Diary G+B through the existing active workspace close path', () => {
    const source = readFileSync(fileURLToPath(new URL('../VaultView.vue', import.meta.url)), 'utf8')
    const diaryShortcut = source.match(/const diaryBackChord = createDiaryShortcutChord\([\s\S]*?\n\}\)/)?.[0]

    expect(diaryShortcut).toBeDefined()
    expect(diaryShortcut).toContain('goBack: () => {')
    expect(diaryShortcut).toContain('return closeWorkspaceTab(activeId)')
    expect(source).toContain('@close="closeWorkspaceTab"')
    expect(source).not.toContain('window.history.back()')
  })

  it('revalidates recovery identity after View Current opens the document', () => {
    const source = readFileSync(fileURLToPath(new URL('../VaultView.vue', import.meta.url)), 'utf8')
    const handler = source.match(
      /async function viewCurrentRecoveryDocument[\s\S]*?\n}/,
    )?.[0]

    expect(handler).toBeDefined()
    expect(handler?.match(/await draftRecovery\.retry\(recoveryId\)/g)).toHaveLength(2)
    expect(handler).toContain('await openEditorPost(disk.documentPath)')
    expect(handler).toContain('refreshedDisk.documentId !== refreshed.draft.documentId')
    expect(handler).toContain('opened.documentId !== refreshed.draft.documentId')
    expect(handler).toContain('opened.loading')
    expect(handler).toContain('opened.loadError')
    expect(handler).toContain('recoveryTabs.open(refreshed, requestedView)')
    expect(handler).toContain('focusTab(refreshedDisk.documentPath)')
  })

  it('refreshes a failed recovery adoption before opening recovery content', () => {
    const source = readFileSync(fileURLToPath(new URL('../VaultView.vue', import.meta.url)), 'utf8')
    const handler = source.match(
      /async function restoreRecoveryDraft[\s\S]*?\n}/,
    )?.[0]

    expect(handler).toBeDefined()
    expect(handler?.match(/await draftRecovery\.retry\(recoveryId\)/g)).toHaveLength(3)
    // Adoption opens WITHOUT a workspace refresh: the tree/posts refresh
    // runs outside openPost's load try/catch, so a routine refresh
    // failure would otherwise reject the adoption (and abort the startup
    // loop). Recovery already certified the record through its stable
    // identity, and the retry right below re-verifies it after the open.
    expect(handler).toContain(
      'await openEditorPost(item.draft.documentPath, { refresh: false })',
    )
    expect(handler).toContain("if (latest?.status === 'ready' && latest.decision)")
    expect(handler).toContain("recoveryTabs.open(latest, 'content')")
    expect(handler).not.toContain("recoveryTabs.open(item, 'content')")
    expect(handler).not.toContain("recoveryTabs.open(refreshed, 'content')")
  })

  it('isolates a failed startup adoption without aborting the recovery loop', () => {
    const source = readFileSync(fileURLToPath(new URL('../VaultView.vue', import.meta.url)), 'utf8')
    const loop = source.match(
      /for \(const item of \[\.\.\.draftRecovery\.items\.value\]\)[\s\S]*?\n    \}/,
    )?.[0]

    expect(loop).toBeDefined()
    // Each startup adoption is wrapped individually: one failure must
    // keep the record and surface it through the Unsaved Content panel
    // instead of aborting Recovery for the remaining items —
    // baseline-match items never reach the Prompt, so a silent exception
    // would leave the stored bytes with no entry point at all.
    expect(loop).toContain('try {')
    expect(loop).toContain('await restoreRecoveryDraft(item.recoveryId)')
    expect(loop).toContain('} catch {')
    expect(loop).toContain('const failed = recoveryItem(item.recoveryId)')
    expect(loop).toContain("recoveryTabs.open(failed, 'content')")
    // The failed record must NOT be dismissed — it stays discoverable.
    expect(loop).not.toContain('dismissForSession')
  })

  it('keeps recovery storage read failures out of the workspace panel', () => {
    const source = readFileSync(fileURLToPath(new URL('../VaultView.vue', import.meta.url)), 'utf8')
    const startup = source.match(
      /watch\(vaultId, \(id\) => \{[\s\S]*?\n\}, \{ immediate: true \}\)/,
    )?.[0]

    expect(startup).toBeDefined()
    // The ONLY panel switch inside startup recovery is the branch for
    // real unsupported records: a storage read failure must leave the
    // user's current panel (Files, Tags, History) alone instead of
    // auto-opening the Center on top of its default empty inventory.
    expect(startup?.match(/activePanel\.value = 'recovery'/g)).toHaveLength(1)
    expect(startup).toContain('warnRecoveryReadFailure(id)')
    // A successful read re-arms the notice for the next failure window.
    expect(startup).toContain('warnedRecoveryReadVaults.delete(id)')
    // The raw toast lives in the once-per-vault helper, not the watch.
    expect(startup).not.toContain("toast.info(t('draft_recovery.storage_read_failed')")
  })

  it('warns at most once per vault and re-arms on manual Center retry', () => {
    const source = readFileSync(fileURLToPath(new URL('../VaultView.vue', import.meta.url)), 'utf8')

    // The startup watcher can re-fire (vault switches, reconnects); the
    // identical notice warns once per vault until the next successful
    // read clears the vault from the warned set.
    expect(source).toContain('const warnedRecoveryReadVaults = new Set<string>()')
    expect(source).toContain('if (warnedRecoveryReadVaults.has(vaultId)) return')
    expect(source).toContain('warnedRecoveryReadVaults.add(vaultId)')

    // A manual Center retry is user-initiated, so it re-arms the notice
    // and reports its own failure through the same deduplicated path.
    const manualRetry = source.match(/async function refreshRecoveryCenter[\s\S]*?\n}/)?.[0]
    expect(manualRetry).toBeDefined()
    expect(manualRetry).toContain('warnedRecoveryReadVaults.delete(currentVaultId)')
    expect(manualRetry).toContain('warnRecoveryReadFailure(currentVaultId)')
  })

  it('coordinates document restore outside the read-only viewers', () => {
    const source = readFileSync(fileURLToPath(new URL('../VaultView.vue', import.meta.url)), 'utf8')

    expect(source).toContain('const historyRestore = useHistoryRestore({')
    expect(source).toContain('prepareEditorRestore: prepareHistoryRestore')
    expect(source).toContain('refreshComparison: historyComparisons.refreshDocumentComparison')
    expect(source).toContain('@restore="restoreHistoricalVersion"')
    expect(source).toContain("t('history.restore_unsaved')")
    expect(source).toContain("t('history.restore_no_commit')")
    expect(source).toContain('destructive: true')
  })

  it('routes command-palette and missing-wiki creation through the lifecycle service', () => {
    const source = readFileSync(fileURLToPath(new URL('../VaultView.vue', import.meta.url)), 'utf8')

    expect(source).toContain('createDocument: (input) => {')
    expect(source).toContain('return lifecycleCreateFile(input)')
    expect(source).toContain('const created = await documentLifecycle.createFile({ path, title })')
    expect(source).toContain('await openPost(created.path, { refresh: false })')
    expect(source).not.toContain("await createPost({ path, title })")
  })

  it('focuses the diff viewer before its network requests settle', () => {
    const source = readFileSync(fileURLToPath(new URL('../VaultView.vue', import.meta.url)), 'utf8')
    const openComparison = source.match(/async function openHistoryComparison[\s\S]*?\n}/)?.[0]

    expect(openComparison).toBeDefined()
    expect(openComparison).toContain('const request =')
    expect(openComparison!.indexOf('focusViewer()')).toBeLessThan(openComparison!.indexOf('await request'))
  })

  it('hands focus to the active tab after closing a non-active workspace tab', () => {
    const source = readFileSync(fileURLToPath(new URL('../VaultView.vue', import.meta.url)), 'utf8')
    const closeOne = source.match(/async function closeWorkspaceTab[\s\S]*?\n}/)?.[0]
    const closeMany = source.match(/async function closeManyWorkspaceTabs[\s\S]*?\n}/)?.[0]

    for (const handler of [closeOne, closeMany]) {
      expect(handler).toBeDefined()
      expect(handler).toContain('if (!result.activeWillClose)')
      expect(handler).toContain('const activeId = activeWorkspaceTabId.value')
      expect(handler).toContain('editorTabsRef.value?.focusTab(activeId)')
      expect(handler).toContain('vaultRef.value?.focus()')
    }
  })

  it('maps all tab kinds through one stable workspace order and persists only documents', () => {
    const source = readFileSync(fileURLToPath(new URL('../VaultView.vue', import.meta.url)), 'utf8')
    const reorder = source.match(/async function reorderWorkspaceTabs[\s\S]*?\n}/)?.[0]

    expect(source).toContain('const naturalWorkspaceTabs = computed<WorkspaceTab[]>')
    expect(source).toContain('const workspaceTabOrder = ref<string[]>([])')
    expect(source).toContain('reconcileWorkspaceTabOrder(workspaceTabOrder.value, availableIds)')
    expect(source).toContain('const workspaceTabs = computed<WorkspaceTab[]>')
    expect(reorder).toContain('applyWorkspaceTabOrder(')
    expect(reorder).toContain("tab?.kind === 'document'")
    expect(reorder).toContain('reorderOpenDocuments(documentPaths)')
    expect(reorder).toContain("request.input === 'keyboard'")
    expect(source).toContain('@reorder="reorderWorkspaceTabs"')
  })

  it('migrates renamed document IDs in place and owns Workspace close/cycle shortcuts', () => {
    const source = readFileSync(fileURLToPath(new URL('../VaultView.vue', import.meta.url)), 'utf8')
    const shortcut = source.match(/function onVaultKeydown[\s\S]*?\n}/)?.[0]

    expect(source).toContain('workspaceTabOrder.value = migrateWorkspaceTabIds(')
    expect(source).toContain('renameOpenDocuments: renameWorkspaceDocuments')
    expect(source).toContain('prepareWorkspaceRename,')
    expect(source).toContain('restoreRenamedWorkspaceTabFocus(')
    expect(source).toContain('workspaceShortcuts: false')
    expect(shortcut).toContain("event.key.toLowerCase() === 'w' && activeId")
    expect(shortcut).toContain("event.key === 'Tab' && workspaceTabs.value.length > 0")
    expect(shortcut).toContain('const direction = event.shiftKey ? -1 : 1')
    expect(shortcut).toContain('void selectWorkspaceTab(nextTab.id)')
  })

  it('gates hidden document shortcuts while Diary Home is primary', () => {
    const source = readFileSync(fileURLToPath(new URL('../VaultView.vue', import.meta.url)), 'utf8')
    const shortcut = source.match(/function onVaultKeydown[\s\S]*?\n}/)?.[0]

    expect(shortcut).toBeDefined()
    expect(shortcut).toContain('if (isDiaryPresentationPrimary.value)')
    expect(shortcut).toContain('handleDiaryHomeKeydown(event, {')
    expect(shortcut).toContain('activeWorkspaceTabId: activeWorkspaceTabId.value')
    expect(shortcut).toContain('workspaceTabCount: workspaceTabs.value.length')
    expect(source).toContain('hidden tabs only own shortcuts when a corresponding workspace target')
  })

  it('claims Diary Home W/Tab only when a hidden workspace target exists', () => {
    const onEditorKeydown = vi.fn()
    const state = { activeWorkspaceTabId: 'diary/2026-08-24', workspaceTabCount: 2 }

    const closeEvent = keyboardEvent('w', { ctrlKey: true })
    handleDiaryHomeKeydown(closeEvent, state, onEditorKeydown)
    expect(closeEvent.defaultPrevented).toBe(true)

    const cycleEvent = keyboardEvent('Tab', { ctrlKey: true })
    handleDiaryHomeKeydown(cycleEvent, state, onEditorKeydown)
    expect(cycleEvent.defaultPrevented).toBe(true)
    expect(state).toEqual({ activeWorkspaceTabId: 'diary/2026-08-24', workspaceTabCount: 2 })
    expect(onEditorKeydown).not.toHaveBeenCalled()
  })

  it('does not claim browser W/Tab when Diary Home has no workspace target', () => {
    const onEditorKeydown = vi.fn()
    const state = { activeWorkspaceTabId: null, workspaceTabCount: 0 }

    const closeEvent = keyboardEvent('w', { ctrlKey: true })
    handleDiaryHomeKeydown(closeEvent, state, onEditorKeydown)
    expect(closeEvent.defaultPrevented).toBe(false)

    const cycleEvent = keyboardEvent('Tab', { ctrlKey: true })
    handleDiaryHomeKeydown(cycleEvent, state, onEditorKeydown)
    expect(cycleEvent.defaultPrevented).toBe(false)
    expect(state).toEqual({ activeWorkspaceTabId: null, workspaceTabCount: 0 })
    expect(onEditorKeydown).not.toHaveBeenCalled()
  })

  it('keeps Diary Home S/E suppression and B forwarding unchanged', () => {
    const onEditorKeydown = vi.fn()
    const state = { activeWorkspaceTabId: null, workspaceTabCount: 0 }

    for (const key of ['s', 'e']) {
      const event = keyboardEvent(key, { metaKey: true })
      handleDiaryHomeKeydown(event, state, onEditorKeydown)
      expect(event.defaultPrevented).toBe(true)
    }

    const filesEvent = keyboardEvent('b', { metaKey: true })
    handleDiaryHomeKeydown(filesEvent, state, onEditorKeydown)
    expect(filesEvent.defaultPrevented).toBe(false)
    expect(onEditorKeydown).toHaveBeenCalledOnce()
  })

  it('warns when a family move settles without persisting the latest edit', () => {
    const source = readFileSync(fileURLToPath(new URL('../VaultView.vue', import.meta.url)), 'utf8')
    const handler = source.match(
      /onDraftFamilyMoveSettled: \(settlement\) => \{[\s\S]*?\n  \},/,
    )?.[0]

    expect(handler).toBeDefined()
    expect(handler).toContain("settlement.status === 'moved-write-failed'")
    expect(handler).toContain("toast.info(t('draft_recovery.family_settle_persist_warning'), 6000)")
    // The refresh still runs — the warning is additive, the tab
    // and pending state stay intact for the retry.
    expect(handler).toContain('void refreshRecoveryAfterFamilySettle(settlement)')
  })
})

describe('VaultView AI live context capture wiring', () => {
  it('late-binds one synchronous capture delegate over the real workspace state', () => {
    const source = readFileSync(fileURLToPath(new URL('../VaultView.vue', import.meta.url)), 'utf8')

    // The sealed resolver is the only classifier; VaultView must not
    // duplicate its logic, so exactly one call site exists.
    expect(source).toContain("from '../composables/vault/aiLiveContext'")
    expect(source.match(/captureAiLiveContext\(/g) ?? []).toHaveLength(1)

    // Late-bound delegate: fail-closed none before the viewers exist,
    // declared BEFORE the context is created and provided.
    expect(source).toContain(
      "let captureWorkspaceAiContext: () => AiLiveContextCapture = () => ({ status: 'none' })",
    )
    expect(source.indexOf('let captureWorkspaceAiContext')).toBeLessThan(
      source.indexOf('const vaultContext = createVaultContext('),
    )
    expect(source).toContain('captureAiContext: () => captureWorkspaceAiContext()')

    // The rebind happens only after every workspace authority exists,
    // in particular after activeWorkspaceTabId itself.
    expect(source.indexOf('const activeWorkspaceTabId = computed(() => (')).toBeLessThan(
      source.indexOf('captureWorkspaceAiContext = () => captureAiLiveContext('),
    )

    // One capture over the real state — active workspace tab id as the
    // sole authority, never the route alone.
    expect(source).toContain('captureWorkspaceAiContext = () => captureAiLiveContext({')
    expect(source).toContain('vaultId: vaultId.value,')
    expect(source).toContain('activeWorkspaceTabId: activeWorkspaceTabId.value,')
    expect(source).toContain('documentTabs: tabs.value,')
    // The snapshot workspace is gone — the AI context no longer carries
    // a historySnapshots field; the comparison viewer covers the same
    // role via its before/after context.
    expect(source).not.toContain('historySnapshots:')
    expect(source).toContain('historyComparisons: historyComparisons.comparisons.value,')
    expect(source).toContain('recoveryTabs: recoveryTabs.tabs.value,')
    // Diff after-sides are re-read from the live editor buffer at the
    // capture instant.
    expect(source).toContain('liveDocument: (path) => liveEditorForPath(tabs.value, path)')
  })
})

describe('VaultView D3.2 Diary surface wiring', () => {
  it('shows Calendar-first only for the diary scope without replacing FileTree', () => {
    const source = readFileSync(fileURLToPath(new URL('../VaultView.vue', import.meta.url)), 'utf8')
    const branch = source.match(
      /v-if="isDiaryCalendarMounted"[\s\S]*?<DiaryCalendarSurface[\s\S]*?\/>/,
    )?.[0]

    expect(source).toContain("import DiaryCalendarSurface from '../components/diary/DiaryCalendarSurface.vue'")
    expect(source).toContain("const isDiaryScope = computed(() => activeScope.value === 'diary')")
    expect(source).toContain('const isDiaryCalendarMounted = computed(() => isDiaryScope.value)')
    expect(source).toContain('const diaryWorkspacePresentation = useDiaryWorkspacePresentation({')
    expect(source).toContain('const isDiaryPresentationPrimary = computed(() => isDiaryCalendarVisible.value)')
    expect(source).toContain('isDocument: isDiaryDocumentMode')
    expect(source).toContain(':eligible="diaryPresentationEligible"')
    expect(source).toContain(':visible="isDiaryCalendarVisible"')
    expect(branch).toBeDefined()
    expect(source).toContain('<DiaryWorkspace')
    expect(branch).toContain(':mode="presentationMode"')
    expect(branch).toContain('<template #home>')
    expect(branch).toContain(':tree="tree"')
    expect(branch).toContain(':loading="treeLoading"')
    expect(branch).toContain(':error="treeError"')
    expect(source).toContain('<FileTree')
    expect(source).toContain(':tree="tree"')
    expect(source).toContain("v-if=\"workspaceLeftSidebarVisible && activePanel === 'files'\"")
  })

  it('routes D3.2 date intent to the D4 lifecycle owner', () => {
    const source = readFileSync(fileURLToPath(new URL('../VaultView.vue', import.meta.url)), 'utf8')
    const branch = source.match(
      /v-if="isDiaryCalendarMounted"[\s\S]*?<DiaryCalendarSurface[\s\S]*?\/>/,
    )?.[0] ?? ''

    expect(branch).toContain('@date-selected="onDiaryDateSelected"')
    expect(source).toContain('const { ensureDiaryDate, openDiaryDate } = useDiaryDateCommand({')
    expect(source).toContain('diaryWorkspacePresentation.recordDateCommandResult(result)')
    expect(source).toContain('diaryWorkspacePresentation.requestDocument(result.date, result.path)')
    expect(source).toContain("viewModeApi?.set('read')")
    expect(source).toContain("result.status !== 'opened' && result.status !== 'created'")
    expect(source).toContain('const intent = diaryWorkspacePresentation.beginDateIntent()')
    expect(source).toContain('diaryWorkspacePresentation.isDateIntentCurrent(intent)')
    expect(source).toContain('!isDiaryScope.value')
    expect(source).toContain('!diaryPresentationEligible.value')
    expect(source).toContain("createDiaryDate,")
    expect(source).not.toContain("createPost({ path: 'diary")
    expect(source).not.toContain("documentLifecycle.createFile({ path: 'diary")
  })

  it('hands successful Diary dates to the native Vault document surfaces and keeps D6.4 deferred', () => {
    const source = readFileSync(fileURLToPath(new URL('../VaultView.vue', import.meta.url)), 'utf8')

    expect(source).not.toContain('DiaryReaderDialog')
    expect(source).not.toContain('<template #reader>')
    expect(source).not.toContain('requestReader(')
    expect(source).toContain('diaryWorkspacePresentation.requestDocument(result.date, result.path)')
    expect(source).toContain("viewModeApi?.set('read')")
    expect(source).toContain(':exact-path-filter="diaryExactPathFilter"')
    expect(source).not.toContain('@clear-exact-path-filter="closeDiaryPresentation"')
    const presentationCall = source.match(
      /const diaryWorkspacePresentation = useDiaryWorkspacePresentation\([\s\S]*?\n\}\)/,
    )?.[0]
    expect(presentationCall).toBeDefined()
    expect(presentationCall).toContain('activePath,')
    expect(source).toContain('if (activePath.value !== result.path)')
    expect(source).toContain('diaryFilterSeed.value = date')
    expect(source).toContain('filesFilter.value = date')
    expect(source).toContain('const isDiaryCalendarMounted = computed(() => isDiaryScope.value)')
    expect(source).toContain('v-if="isReadMode && !isDiaryPresentationPrimary && !activeHistoryComparison')
    expect(source).toContain('<ReadingPane')
    expect(source).toContain('<EditorPane')
    expect(source).not.toContain('watch(activePath')
    expect(source).not.toContain('router.back()')
    expect(source).not.toContain('closeTab()')
  })

  it('persists FileTree query ownership so a user-cleared query is not re-seeded', () => {
    const source = readFileSync(fileURLToPath(new URL('../VaultView.vue', import.meta.url)), 'utf8')

    expect(source).toContain("type DiaryFilterOwnership = 'none' | 'calendar' | 'user'")
    expect(source).toContain('BROWSER_STORAGE_KEYS.diaryFilterOwnership')
    expect(source).toContain("diaryFilterOwnership.value = 'user'")
    expect(source).toContain("diaryFilterOwnership.value === 'user'")
    expect(source).toContain("diaryFilterOwnership.value === 'calendar'")
    expect(source).toContain('@update:filter="onFilesFilterEdited"')
  })

  it('distinguishes fresh access bootstrap from a reconciled lock boundary', () => {
    const source = readFileSync(fileURLToPath(new URL('../VaultView.vue', import.meta.url)), 'utf8')

    expect(source).toContain('if (!diaryAccess.statusResolved.value) return')
    expect(source).not.toContain("diaryAccess.state.value !== 'UNLOCKED'")
    expect(source).toContain('diaryFilterOwnership.value === \'calendar\'')
    expect(source).toContain('diaryFilterOwnership.value = \'none\'')
  })

  it('keeps the Calendar mounted while presentation state controls visibility', () => {
    const source = readFileSync(fileURLToPath(new URL('../VaultView.vue', import.meta.url)), 'utf8')
    const editorSurface = source.match(
      /<div\s+v-if="!isReadMode"[\s\S]*?class="content"/,
    )?.[0]

    expect(source).toContain('v-if="isDiaryCalendarMounted"')
    expect(source).toContain('const isDiaryCalendarMounted = computed(() => isDiaryScope.value)')
    expect(source).toContain('isHome: isDiaryCalendarMode')
    expect(source).toContain("'is-diary-home': isDiaryCalendarVisible")
    expect(editorSurface).toBeDefined()
    expect(editorSurface).toContain('v-show="!isDiaryPresentationPrimary && !activeHistoryComparison && !activeWorkingTreeDiff && !activeDraftRecovery"')
    expect(source).toContain('v-show="!isDiaryPresentationPrimary"')
    expect(source).not.toContain('v-else-if="!isReadMode"')
    expect(source).not.toContain('diary-reader-mode')
  })

  it('promotes Diary Home to a presentation-only primary surface', () => {
    const source = readFileSync(fileURLToPath(new URL('../VaultView.vue', import.meta.url)), 'utf8')
    const styles = readFileSync(fileURLToPath(new URL('../../style.css', import.meta.url)), 'utf8')

    expect(source).toContain("'diary-calendar-mode': isDiaryCalendarVisible")
    expect(source).toContain('v-if="isDiaryCalendarMounted"')
    expect(source).toContain('v-show="!isDiaryPresentationPrimary"')
    expect(source).toContain('const routeSidebarVisible = computed(() => route.meta.sidebar !== false)')
    expect(source).toContain('const workspaceSidebarVisible = computed(() => routeSidebarVisible.value && !isDiaryCalendarVisible.value)')
    expect(source).toContain('const workspaceLeftSidebarVisible = computed(() => workspaceSidebarVisible.value && leftSidebarVisible.value)')
    expect(source).toContain('useVaultLayout({')
    expect(source).toContain('statusBarVisible: statusBarLayoutVisible')
    expect(source).toContain('v-if="workspaceSidebarVisible"')
    expect(styles).not.toContain('.vault.diary-calendar-mode > :is(.file-tree, .tag-panel, .history-panel, .recovery-center)')
    expect(styles).not.toContain('.vault.diary-calendar-mode > .right-rail-slot')
    expect(styles).not.toContain('.vault.diary-calendar-mode > .status-bar-row')
    expect(styles).not.toContain('.vault.diary-reader-mode')
  })

  it('mirrors the existing side-panel state for mobile native Diary documents', () => {
    const source = readFileSync(fileURLToPath(new URL('../VaultView.vue', import.meta.url)), 'utf8')
    const styles = readFileSync(fileURLToPath(new URL('../../style.css', import.meta.url)), 'utf8')

    // The root class binding is the characterization seam for both runtime
    // states: the existing layout owner supplies true while a panel is open
    // and false when activePanel is null. CSS then selects the matching
    // mobile grid without introducing another panel store.
    expect(source).toContain("'side-panel-open': sidePanelOpen")
    expect(styles).toContain('.vault.diary-native-document-mode.side-panel-open')
    expect(styles).toContain('.vault.diary-native-document-mode:not(.side-panel-open)')
    expect(styles).not.toMatch(/\.vault\.diary-native-document-mode\s*\{\s*\n\s*grid-template-columns: 40px minmax\(136px, 42vw\)/)
  })
})

describe('D7.3 Native Diary mood context removal', () => {
  it('keeps Native Diary free of the removed Mood context action', () => {
    const source = readFileSync(fileURLToPath(new URL('../VaultView.vue', import.meta.url)), 'utf8')
    const tabs = readFileSync(fileURLToPath(new URL('../../components/vault/EditorTabs.vue', import.meta.url)), 'utf8')

    expect(source).toContain("import { useDiaryMoodCommand } from '../composables/diary/useDiaryMoodCommand'")
    expect(source).not.toContain('<DiaryMoodContextAction')
    expect(source).not.toContain('resolveNativeDiaryMoodContext')
    expect(source).not.toContain('activeNativeDiaryContext')
    expect(source).not.toContain('nativeMoodExcludedBySurface')
    expect(source).not.toContain('diaryMoodMutationDisabled')
    expect(source).not.toContain('updateNativeDiaryMood')
    expect(source).not.toContain('clearNativeDiaryMood')
    expect(source).not.toContain('diaryMoodContextRef')
    expect(source).toContain(':context-actions-visible="false"')

    expect(tabs).not.toContain('DiaryMood')
    expect(tabs).not.toContain('classifyDiaryPath')
    expect(tabs).toContain('<slot name="context-actions" />')
  })
})

describe('D7.3 Calendar mood integration wiring', () => {
  it('uses the bulk PostSummary projection and keeps Calendar mutation ownership in VaultView', () => {
    const source = readFileSync(fileURLToPath(new URL('../VaultView.vue', import.meta.url)), 'utf8')
      .replace(/\r\n/g, '\n')
    const calendarBranch = source.match(
      /<DiaryCalendarSurface[\s\S]*?\/>/,
    )?.[0]

    expect(calendarBranch).toBeDefined()
    expect(calendarBranch).toContain(':tree="tree"')
    expect(calendarBranch).toContain(':posts="posts"')
    expect(calendarBranch).toContain(':mood-busy="diaryMoodBusy"')
    expect(calendarBranch).toContain('@mood-change="updateDiaryCalendarMood"')
    expect(source).toContain('import { classifyDiaryPath, diaryLogicalPathForDate, type DiaryDate } from')
    expect(source).toContain('async function updateDiaryCalendarMood(date: DiaryDate, mood: MoodId | null)')
    expect(source).toContain('const path = diaryLogicalPathForDate(date)')
    expect(source).toContain('const dateResult = await ensureDiaryDate(date)')
    expect(source).toContain('const openResult = await openDiaryDate(date)')
    expect(source).toContain('pendingMoodFirstPresentationDate')
    expect(source).toContain('dateReadyForPresentation')
    expect(source).toContain('diaryMoodCommand.setMood(date, mood, expectedUpdatedAt)')
    expect(source).toContain('diaryCalendarSurfaceRef.value?.closeMoodPicker(!shouldPresentAfterMutation)')
    expect(source).toContain('await presentDiaryDateResult(openResult, presentationIntent)')
    expect(source).toContain('watch(isDiaryCalendarVisible, (visible, wasVisible) => {')
    expect(source).toContain('diaryCalendarSurfaceRef.value?.closeMoodPicker(false)')
    expect(source).toContain('async function onDiaryDateSelected(date: DiaryDate): Promise<void> {\n  diaryCalendarSurfaceRef.value?.closeMoodPicker(false)')
    expect(source).not.toContain('updateDocumentMetadata(')
  })

  it('keeps Calendar components free of API, router, and document lifecycle ownership', () => {
    const calendar = readFileSync(
      fileURLToPath(new URL('../../components/diary/DiaryCalendar.vue', import.meta.url)),
      'utf8',
    )
    const surface = readFileSync(
      fileURLToPath(new URL('../../components/diary/DiaryCalendarSurface.vue', import.meta.url)),
      'utf8',
    )

    for (const source of [calendar, surface]) {
      expect(source).not.toMatch(/authFetch|fetch\(|useRouter|router\.|openPost|updateDocumentMetadata|\/api\//)
    }
    expect(calendar).toContain("'mood-change'")
    expect(calendar).toContain('<DiaryMoodPicker')
    expect(calendar).toContain('emit(\'mood-change\', activeMoodDate.value, mood)')
    expect(calendar).toContain('diary-calendar-day-content')
  })
})

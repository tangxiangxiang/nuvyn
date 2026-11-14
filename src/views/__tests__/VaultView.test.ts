import { readFileSync as readSourceFile } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { applyMetadataToPostSummary } from '../metadataPostSummary'

// Source wiring assertions should have identical meaning in LF/CRLF checkouts.
function readFileSync(path: string, encoding: 'utf8'): string {
  return readSourceFile(path, encoding).replace(/\r\n/g, '\n')
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
    expect(source).toContain('@export-document="documentExport.request"')
    expect(source).toContain('exportPdf: exportPdfDocument')
    expect(exportHandler).toContain('await captureExportSource(path)')
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

  it('keeps browsing selection normalized and reconciles it from the posts TagIndex', () => {
    const source = readFileSync(fileURLToPath(new URL('../VaultView.vue', import.meta.url)), 'utf8')
    const selectionHandler = source.match(/function selectTag\(tag: string\): void \{[\s\S]*?\n\}/)?.[0]
    const browsingWatcher = source.match(/watch\(tagBrowsingIndex, \(index\) => \{[\s\S]*?\n\}\)/)?.[0]

    expect(source).toContain("import {\n  buildTagIndex,\n  resolveTagBrowseSelection,\n  toggleTagBrowseSelection,\n} from '../lib/tags'")
    expect(source).toContain('const tagBrowsingIndex = computed(() => buildTagIndex(posts.value))')
    expect(selectionHandler).toContain('toggleTagBrowseSelection(selectedTag.value, tag)')
    expect(selectionHandler).toContain('tagSelectionEpoch.value += 1')
    expect(browsingWatcher).toContain('resolveTagBrowseSelection(index, selectedTag.value)')
    expect(browsingWatcher).toContain('if (reconciled !== selectedTag.value) selectedTag.value = reconciled')
    expect(browsingWatcher).not.toContain('tagSelectionEpoch')
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
    expect(editorPane).toContain('onEditorChange(path, val)')
    expect(editorPane).toContain('(val: string, path: string)')
    expect(editorPane).not.toContain('activePath!')
  })

  it('hands body search reveals to the active Edit Mode Monaco pane', () => {
    const source = readFileSync(fileURLToPath(new URL('../VaultView.vue', import.meta.url)), 'utf8')
    const editorPane = source.match(/<EditorPane[\s\S]*?\/>/)?.[0]

    expect(source).toContain("import { watchSearchRevealHandoff } from '../composables/vault/useSearchRevealHandoff'")
    expect(source).toContain('const editorPaneRef = ref<{')
    expect(source).toContain('revealText(text: string): boolean')
    expect(source).toContain('revealAnchor(anchor: string, isCurrent?: () => boolean): boolean | Promise<boolean>')
    expect(source).toContain('watchSearchRevealHandoff({')
    expect(source).toContain('watchLinkNavigationHandoff({')
    expect(source).toContain('isOrdinaryPresentation: isOrdinaryDocumentPresentation')
    expect(editorPane).toContain('ref="editorPaneRef"')
    expect(source).not.toContain('ReadingPane ref=')
  })

  it('keeps the editor and tabs mounted while the History sidebar is active', () => {
    const source = readFileSync(fileURLToPath(new URL('../VaultView.vue', import.meta.url)), 'utf8')

    expect(source).toContain('const historyPanelVisible = computed(() => workspaceLeftSidebarVisible.value && activePanel.value === ')
    expect(source).toContain('v-else-if="historyPanelVisible"')
    expect(source).toContain('@open-revision="openHistoryComparison"')
    expect(source).not.toContain('import DiffView')
    expect(source).not.toContain("activePanel !== 'history' && tabs.length > 0")
    expect(source).not.toContain("activePanel === 'history'\" class=\"content content-diff\"")
  })

  it('keeps sidebar and right-rail file history independent from active editor tabs', () => {
    const source = readFileSync(fileURLToPath(new URL('../VaultView.vue', import.meta.url)), 'utf8')

    expect(source).toContain('const sidebarFileHistory = useFileHistory(locale)')
    expect(source).toContain('const rightRailFileHistory = useFileHistory(locale)')
    expect(source).not.toContain('function openFileHistory')
    expect(source).not.toContain('@open-history="openFileHistory"')
    expect(source).not.toContain('resolveFileHistoryTarget')
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

    expect(source).toContain('v-show="!activeHistoryComparison && !activeWorkingTreeDiff && !activeDraftRecovery"')
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
    expect(startup?.match(/openRecoveryManagement\(\)/g)).toHaveLength(1)
    expect(startup).not.toContain("activePanel.value = 'recovery'")
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

  it('restores focus without targeting a hidden workspace tab strip', () => {
    const source = readFileSync(fileURLToPath(new URL('../VaultView.vue', import.meta.url)), 'utf8')
    const closeOne = source.match(/async function closeWorkspaceTab[\s\S]*?\n}/)?.[0]
    const closeMany = source.match(/async function closeManyWorkspaceTabs[\s\S]*?\n}/)?.[0]
    const focusAfterChange = source.match(/function focusAfterWorkspaceTabChange[\s\S]*?\n}/)?.[0]

    for (const handler of [closeOne, closeMany]) {
      expect(handler).toBeDefined()
      expect(handler).toContain('if (!result.activeWillClose)')
      expect(handler).toContain('focusAfterWorkspaceTabChange()')
    }
    expect(focusAfterChange).toContain('activeId && workspaceTabStripVisible.value')
    expect(focusAfterChange).toContain('editorTabsRef.value?.focusTab(activeId)')
    expect(focusAfterChange).not.toContain('openWorkspaceDocumentsRef')
    expect(source).not.toContain('OpenWorkspaceDocuments')
    expect(focusAfterChange).toContain('vaultRef.value?.focus()')
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

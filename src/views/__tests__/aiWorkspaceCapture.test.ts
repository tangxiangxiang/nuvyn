// @vitest-environment jsdom

// Edit-10.2 workspace integration. These tests drive the REAL workspace
// composables (useHistoryComparisons / useDraftRecoveryTabs) plus a
// plain Tab ref exactly as VaultView owns them, then capture through
// the same call VaultView's late-bound delegate makes:
//
//   captureAiLiveContext({
//     vaultId: vaultId.value,
//     activeWorkspaceTabId: activeWorkspaceTabId.value,
//     documentTabs: tabs.value,
//     historyComparisons: historyComparisons.comparisons.value,
//     recoveryTabs: recoveryTabs.tabs.value,
//   }, { liveDocument: (path) => liveEditorForPath(tabs.value, path) })
//
// The VaultView.test.ts source-inspection suite pins that VaultView's
// wiring matches this shape string-for-string, so behavior proven here
// holds for the shipped view.
import { computed, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../components/vault/tabs'
import {
  captureAiLiveContext,
  liveEditorForPath,
  type AiDiffContext,
  type AiDocumentContext,
  type AiLiveContextCapture,
  type AiRecoveryContext,
} from '../../composables/vault/aiLiveContext'
import {
  getLoadedEditorDocument,
  useHistoryComparisons,
} from '../../composables/vault/useHistoryComparisons'
import * as historyApi from '../../lib/history-api'
import { useDraftRecoveryTabs } from '../../composables/vault/draft-recovery/useDraftRecoveryTabs'
import type { DraftRecoveryItem } from '../../composables/vault/draft-recovery/useUnsavedDraftRecovery'
import type { DraftRecoveryDecisionKind } from '../../composables/vault/draft-recovery/draftRecoveryDecision'
import { UNSAVED_DRAFT_VERSION } from '../../composables/vault/draft-recovery/draftTypes'

vi.mock('../../lib/history-api', async () => {
  const actual = await vi.importActual<typeof historyApi>('../../lib/history-api')
  return { ...actual, getFileAt: vi.fn() }
})

beforeEach(() => {
  vi.mocked(historyApi.getFileAt).mockReset()
})

function docTab(path: string, raw: string, overrides: Partial<Tab> = {}): Tab {
  return {
    path,
    documentId: `doc:${path}`,
    title: path,
    raw,
    originalRaw: raw,
    revision: 0,
    savedRevision: 0,
    savingRevision: null,
    saveStatus: 'idle',
    error: null,
    loadError: null,
    loading: false,
    externalRaw: null,
    externalKind: null,
    serverMtime: 0,
    ...overrides,
  }
}

function recoveryItem(overrides: {
  documentPath?: string
  draftRaw?: string
  diskRaw?: string | null
  diskDocumentId?: string | null
  diskStatus?: 'ready' | 'missing' | 'unreadable'
  kind?: DraftRecoveryDecisionKind
  source?: 'primary' | 'conflict'
} = {}): DraftRecoveryItem {
  const documentPath = overrides.documentPath ?? 'notes/a.md'
  const diskStatus = overrides.diskStatus ?? 'ready'
  const draft = {
    version: UNSAVED_DRAFT_VERSION,
    vaultId: 'vault-a',
    documentId: 'doc-draft-a',
    documentPath,
    content: overrides.draftRaw ?? 'draft body',
    baseContentHash: null,
    baseModifiedAt: null,
    createdAt: 1,
    updatedAt: 2,
  }
  const disk = diskStatus === 'ready'
    ? {
        status: 'ready' as const,
        documentPath,
        documentId: overrides.diskDocumentId ?? 'doc-draft-a',
        raw: overrides.diskRaw ?? 'disk body',
        mtime: 5,
      }
    : { status: diskStatus, documentPath }
  return {
    recoveryId: 'recovery-a',
    draft,
    source: overrides.source ?? 'primary',
    conflict: null,
    decision: { kind: overrides.kind ?? 'divergent', draft, disk },
    status: 'ready',
    error: null,
  }
}

function createWorkspace() {
  const vaultId = ref('vault-a')
  const tabs = ref<Tab[]>([])
  const activePath = ref<string | null>(null)
  const historyComparisons = useHistoryComparisons({
    getCurrentDocument: (path) => getLoadedEditorDocument(tabs.value, path),
    loadCurrentDocument: async () => {
      throw new Error('capture tests must not fetch from the server')
    },
  })
  const recoveryTabs = useDraftRecoveryTabs()
  // Mirrors VaultView's activeWorkspaceTabId exactly (pinned by the
  // source-inspection suite): recovery → diff → document.
  const activeWorkspaceTabId = computed(() => (
    recoveryTabs.activeTab.value?.tabId
    ?? historyComparisons.activeComparison.value?.tabId
    ?? activePath.value
  ))
  const capture = (): AiLiveContextCapture => captureAiLiveContext({
    vaultId: vaultId.value,
    activeWorkspaceTabId: activeWorkspaceTabId.value,
    documentTabs: tabs.value,
    historyComparisons: historyComparisons.comparisons.value,
    recoveryTabs: recoveryTabs.tabs.value,
  }, {
    liveDocument: (path) => liveEditorForPath(tabs.value, path),
  })
  return {
    tabs,
    activePath,
    historyComparisons,
    recoveryTabs,
    activeWorkspaceTabId,
    capture,
  }
}

function readyDocument(capture: AiLiveContextCapture): AiDocumentContext {
  if (capture.status !== 'ready' || capture.context.kind !== 'document') {
    throw new Error(`expected ready document, got ${JSON.stringify(capture)}`)
  }
  return capture.context
}

function readyDiff(capture: AiLiveContextCapture): AiDiffContext {
  if (capture.status !== 'ready' || capture.context.kind !== 'diff') {
    throw new Error(`expected ready diff, got ${JSON.stringify(capture)}`)
  }
  return capture.context
}

function readyRecovery(capture: AiLiveContextCapture): AiRecoveryContext {
  if (capture.status !== 'ready' || capture.context.kind !== 'recovery') {
    throw new Error(`expected ready recovery, got ${JSON.stringify(capture)}`)
  }
  return capture.context
}

describe('VaultView workspace AI capture over real state', () => {
  it('captures the dirty active Document from the same live tab', () => {
    const ws = createWorkspace()
    ws.tabs.value = [docTab('notes/a.md', 'a v2', {
      revision: 3,
      savedRevision: 2,
      saveStatus: 'dirty',
    })]
    ws.activePath.value = 'notes/a.md'

    const context = readyDocument(ws.capture())

    // identity.documentId, identity.path and raw all come from the one
    // active tab snapshot — never mixed across tabs.
    expect(context.identity).toEqual({ documentId: 'doc:notes/a.md', path: 'notes/a.md' })
    expect(context.raw).toBe('a v2')
    expect(context.dirty).toBe(true)
    expect(context.revision).toBe(3)
    expect(context.savedRevision).toBe(2)
    expect(context.saveStatus).toBe('dirty')
    expect(context.workspaceTabId).toBe('notes/a.md')
    expect(context.vaultId).toBe('vault-a')
  })

  it('captures none when the workspace has no active tab', () => {
    const ws = createWorkspace()
    expect(ws.capture()).toEqual({ status: 'none' })
  })

  it('captures unavailable (never stale content) while the active document loads', () => {
    const ws = createWorkspace()
    ws.tabs.value = [docTab('notes/a.md', '', { documentId: null, loading: true })]
    ws.activePath.value = 'notes/a.md'
    expect(ws.capture()).toEqual({ status: 'unavailable', reason: 'loading' })
  })

  it('Diff re-reads the freshest live after-side at capture time', async () => {
    const ws = createWorkspace()
    ws.tabs.value = [docTab('notes/a.md', 'v1 saved')]
    ws.activePath.value = 'notes/a.md'
    vi.mocked(historyApi.getFileAt).mockResolvedValue({
      path: 'notes/a.md',
      ref: 'rev-3',
      content: 'historical body',
    })
    await ws.historyComparisons.openComparison({
      documentPath: 'notes/a.md',
      documentTitle: 'a',
      revisionId: 'rev-3',
      parentRevisionId: null,
      revisionTime: 222,
      summary: 'before',
    })
    await ws.historyComparisons.compareWithWorkingTree('diff:notes/a.md')

    // The user keeps typing AFTER the diff opened; the comparison's
    // snapshot of the current side is now expired.
    ws.tabs.value[0].raw = 'v2 typed after diff opened'
    ws.tabs.value[0].revision = 1
    ws.tabs.value[0].saveStatus = 'dirty'

    const context = readyDiff(ws.capture())

    expect(context.before).toEqual({ raw: 'historical body', source: 'history' })
    expect(context.after.source).toBe('live-editor')
    expect(context.after.raw).toBe('v2 typed after diff opened')
    expect(context.after.raw).not.toBe('v1 saved')
    expect(context.after.dirty).toBe(true)
    expect(context.identity).toEqual({
      path: 'notes/a.md',
      revisionId: 'rev-3',
      revisionTime: 222,
      currentDocumentId: 'doc:notes/a.md',
    })
  })

  it('Recovery content view sends the draft only, never the disk body', () => {
    const ws = createWorkspace()
    ws.tabs.value = [docTab('notes/a.md', 'document behind recovery', {
      revision: 2,
      savedRevision: 1,
      saveStatus: 'dirty',
    })]
    ws.activePath.value = 'notes/a.md'
    ws.recoveryTabs.open(recoveryItem({ draftRaw: 'unsaved draft body' }), 'content')

    const context = readyRecovery(ws.capture())

    expect(context.readOnly).toBe(true)
    expect(context.view).toBe('content')
    expect(context.draft).toEqual({ raw: 'unsaved draft body' })
    expect(context.disk).toBeUndefined()
    expect(context.identity).toEqual({
      recoveryId: 'recovery-a',
      documentId: 'doc-draft-a',
      path: 'notes/a.md',
      source: 'primary',
    })
    const serialized = JSON.stringify(context)
    expect(serialized).not.toContain('disk body')
    expect(serialized).not.toContain('document behind recovery')
  })

  it('Recovery diff view sends both the draft and the disk side', () => {
    const ws = createWorkspace()
    ws.recoveryTabs.open(recoveryItem({
      draftRaw: 'draft side',
      diskRaw: 'disk side',
      diskDocumentId: 'doc-other',
      kind: 'identity-mismatch',
    }), 'diff')

    const context = readyRecovery(ws.capture())

    expect(context.view).toBe('diff')
    expect(context.draft).toEqual({ raw: 'draft side' })
    expect(context.disk).toEqual({ documentId: 'doc-other', raw: 'disk side' })
    expect(context.identity.documentId).toBe('doc-draft-a')
    expect(context.decisionKind).toBe('identity-mismatch')
  })

  it('Recovery wins over an active diff and document, and releases cleanly', async () => {
    const ws = createWorkspace()
    ws.tabs.value = [docTab('notes/a.md', 'live a')]
    ws.activePath.value = 'notes/a.md'
    vi.mocked(historyApi.getFileAt).mockResolvedValue({
      path: 'notes/a.md',
      ref: 'rev-1',
      content: 'old body',
    })
    await ws.historyComparisons.openComparison({
      documentPath: 'notes/a.md',
      documentTitle: 'a',
      revisionId: 'rev-1',
      parentRevisionId: null,
      revisionTime: 1,
      summary: 's',
    })
    ws.recoveryTabs.open(recoveryItem({ draftRaw: 'draft wins' }), 'content')

    expect(readyRecovery(ws.capture()).draft).toEqual({ raw: 'draft wins' })

    ws.recoveryTabs.deactivate()
    expect(readyDiff(ws.capture()).title).toBe('a')
  })

  it('tab switching A → B carries no residue', () => {
    const ws = createWorkspace()
    ws.tabs.value = [
      docTab('notes/a.md', 'body A', { revision: 2, savedRevision: 1, saveStatus: 'dirty' }),
      docTab('notes/b.md', 'body B'),
    ]
    ws.activePath.value = 'notes/a.md'
    expect(readyDocument(ws.capture()).raw).toBe('body A')

    ws.activePath.value = 'notes/b.md'
    expect(readyDocument(ws.capture()).raw).toBe('body B')
  })

  it('rename keeps documentId while path and raw follow the same tab', () => {
    const ws = createWorkspace()
    const tab = docTab('notes/old.md', 'renamed body', {
      revision: 4,
      savedRevision: 3,
      saveStatus: 'dirty',
    })
    ws.tabs.value = [tab]
    ws.activePath.value = 'notes/old.md'
    expect(readyDocument(ws.capture()).identity).toEqual({
      documentId: 'doc:notes/old.md',
      path: 'notes/old.md',
    })

    // The rename transaction lands on the SAME tab object: the path
    // changes, the stable identity and buffer do not.
    tab.path = 'notes/new.md'
    tab.title = 'notes/new.md'
    ws.activePath.value = 'notes/new.md'

    const context = readyDocument(ws.capture())
    expect(context.identity).toEqual({ documentId: 'doc:notes/old.md', path: 'notes/new.md' })
    expect(context.workspaceTabId).toBe('notes/new.md')
    expect(context.raw).toBe('renamed body')
  })
})

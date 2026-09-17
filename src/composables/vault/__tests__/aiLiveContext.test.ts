import { describe, expect, it } from 'vitest'
import {
  captureAiLiveContext,
  liveEditorForPath,
  type AiDiffContext,
  type AiDiffSource,
  type AiDocumentContext,
  type AiDocumentSource,
  type AiLiveContextCapture,
  type AiLiveContextInput,
  type AiRecoveryContext,
  type AiRecoverySource,
} from '../aiLiveContext'

function documentTab(overrides: Partial<AiDocumentSource> = {}): AiDocumentSource {
  return {
    path: 'inbox/ideas',
    documentId: 'doc:inbox/ideas',
    title: 'Ideas',
    raw: '# Ideas\n\nlive body',
    revision: 5,
    savedRevision: 4,
    saveStatus: 'dirty',
    loading: false,
    loadError: null,
    externalKind: null,
    externalRaw: null,
    ...overrides,
  }
}

function historyComparison(overrides: Partial<AiDiffSource> = {}): AiDiffSource {
  return {
    tabId: 'diff:inbox/redis',
    documentPath: 'inbox/redis',
    documentTitle: 'Redis Notes',
    mode: 'revision-to-worktree',
    revisionId: 'rev-9',
    revisionTime: 1752566260000,
    beforeRaw: '# Redis\n\nold side',
    afterRaw: '# Redis\n\nsnapshot side',
    currentDirty: false,
    status: 'ready',
    ...overrides,
  }
}

function recoveryTab(overrides: Partial<AiRecoverySource> = {}): AiRecoverySource {
  return {
    tabId: 'recovery:vault:doc-a',
    recoveryId: 'rec-1',
    source: 'primary',
    documentId: 'doc-a',
    documentPath: 'inbox/ideas',
    documentTitle: 'Ideas',
    decisionKind: 'divergent',
    diskStatus: 'ready',
    diskDocumentId: 'doc-a',
    view: 'content',
    draftRaw: '# Ideas\n\ndraft body',
    diskRaw: '# Ideas\n\ndisk body',
    status: 'ready',
    ...overrides,
  }
}

function input(overrides: Partial<AiLiveContextInput> = {}): AiLiveContextInput {
  return {
    vaultId: 'vault',
    activeWorkspaceTabId: null,
    documentTabs: [],
    historyComparisons: [],
    recoveryTabs: [],
    ...overrides,
  }
}

function readyContext(capture: AiLiveContextCapture) {
  expect(capture.status).toBe('ready')
  if (capture.status !== 'ready') throw new Error('capture is not ready')
  return capture.context
}

function readyDocument(capture: AiLiveContextCapture): AiDocumentContext {
  const context = readyContext(capture)
  expect(context.kind).toBe('document')
  if (context.kind !== 'document') throw new Error(`expected document context, got ${context.kind}`)
  return context
}

function readyDiff(capture: AiLiveContextCapture): AiDiffContext {
  const context = readyContext(capture)
  expect(context.kind).toBe('diff')
  if (context.kind !== 'diff') throw new Error(`expected diff context, got ${context.kind}`)
  return context
}

function readyRecovery(capture: AiLiveContextCapture): AiRecoveryContext {
  const context = readyContext(capture)
  expect(context.kind).toBe('recovery')
  if (context.kind !== 'recovery') throw new Error(`expected recovery context, got ${context.kind}`)
  return context
}

const NOW = 1753084800000

describe('captureAiLiveContext', () => {
  describe('document context', () => {
    it('sends the dirty active Document from the same live tab', () => {
      const capture = captureAiLiveContext(input({
        activeWorkspaceTabId: 'inbox/ideas',
        documentTabs: [documentTab({
          revision: 3, savedRevision: 2, saveStatus: 'dirty',
        })],
      }), { now: () => NOW })

      const context = readyDocument(capture)

      expect(context.identity).toEqual({ documentId: 'doc:inbox/ideas', path: 'inbox/ideas' })
      expect(context.raw).toBe('# Ideas\n\nlive body')
      expect(context.dirty).toBe(true)
      expect(context.revision).toBe(3)
      expect(context.savedRevision).toBe(2)
      expect(context.saveStatus).toBe('dirty')
      expect(context.workspaceTabId).toBe('inbox/ideas')
      expect(context.capturedAt).toBe(NOW)
      expect(context.vaultId).toBe('vault')
    })

    it('captures none when no tab is active', () => {
      expect(captureAiLiveContext(input())).toEqual({ status: 'none' })
    })

    it('captures none when the vault id is missing', () => {
      expect(captureAiLiveContext(input({
        vaultId: null,
        activeWorkspaceTabId: 'inbox/ideas',
        documentTabs: [documentTab()],
      }))).toEqual({ status: 'none' })
    })

    it('reports loading while a document is still loading', () => {
      const capture = captureAiLiveContext(input({
        activeWorkspaceTabId: 'inbox/ideas',
        documentTabs: [documentTab({ loading: true })],
      }))
      expect(capture).toEqual({ status: 'unavailable', reason: 'loading' })
    })

    it('reports load-error when a document failed to load', () => {
      const capture = captureAiLiveContext(input({
        activeWorkspaceTabId: 'inbox/ideas',
        documentTabs: [documentTab({ loadError: 'HTTP 500' })],
      }))
      expect(capture).toEqual({ status: 'unavailable', reason: 'load-error' })
    })

    it('reports missing-identity when the document lacks a stable documentId', () => {
      const capture = captureAiLiveContext(input({
        activeWorkspaceTabId: 'inbox/ideas',
        documentTabs: [documentTab({ documentId: null })],
      }))
      expect(capture).toEqual({ status: 'unavailable', reason: 'missing-identity' })
    })

    it('carries the external change conflict when present', () => {
      const capture = captureAiLiveContext(input({
        activeWorkspaceTabId: 'inbox/ideas',
        documentTabs: [documentTab({
          saveStatus: 'external',
          externalKind: 'deleted',
          externalRaw: null,
        })],
      }))

      const context = readyDocument(capture)
      expect(context.external).toEqual({ kind: 'deleted', raw: null })
    })
  })

  describe('diff context', () => {
    it('sends the ready diff with its historical and live after-sides', () => {
      const capture = captureAiLiveContext(input({
        activeWorkspaceTabId: 'diff:inbox/redis',
        historyComparisons: [historyComparison()],
      }), { now: () => NOW })

      const context = readyDiff(capture)
      expect(context.readOnly).toBe(true)
      expect(context.identity).toEqual({
        path: 'inbox/redis',
        revisionId: 'rev-9',
        revisionTime: 1752566260000,
        currentDocumentId: null,
      })
      expect(context.title).toBe('Redis Notes')
      expect(context.before).toEqual({ raw: '# Redis\n\nold side', source: 'history' })
      expect(context.after).toEqual({
        raw: '# Redis\n\nsnapshot side',
        source: 'comparison-snapshot',
        dirty: false,
      })
      expect(context.workspaceTabId).toBe('diff:inbox/redis')
      expect(context.capturedAt).toBe(NOW)
      expect(context.vaultId).toBe('vault')
    })

    it('re-reads the after side from the live editor at capture time', () => {
      const capture = captureAiLiveContext(input({
        activeWorkspaceTabId: 'diff:inbox/redis',
        historyComparisons: [historyComparison({ afterRaw: '# Redis\n\nsnapshot side', currentDirty: false })],
      }), {
        now: () => NOW,
        liveDocument: () => ({ raw: '# Redis\n\ntyped after the diff opened', dirty: true, documentId: 'doc-r' }),
      })

      const context = readyDiff(capture)
      expect(context.before).toEqual({ raw: '# Redis\n\nold side', source: 'history' })
      expect(context.after).toEqual({
        raw: '# Redis\n\ntyped after the diff opened',
        source: 'live-editor',
        dirty: true,
      })
      expect(context.identity.currentDocumentId).toBe('doc-r')
    })

    it('prefers the live editor over a stale comparison snapshot', () => {
      const capture = captureAiLiveContext(input({
        activeWorkspaceTabId: 'diff:inbox/redis',
        historyComparisons: [historyComparison({ afterRaw: 'stale snapshot', currentDirty: false })],
      }), {
        liveDocument: () => ({ raw: 'fresh buffer', dirty: true, documentId: 'doc-r' }),
      })

      const context = readyDiff(capture)
      expect(context.after).toEqual({ raw: 'fresh buffer', source: 'live-editor', dirty: true })
    })

    it('reports loading before the diff is ready', () => {
      const capture = captureAiLiveContext(input({
        activeWorkspaceTabId: 'diff:inbox/redis',
        historyComparisons: [historyComparison({ status: 'loading' })],
      }))
      expect(capture).toEqual({ status: 'unavailable', reason: 'loading' })
    })

    it('reports load-error when the diff is in error state', () => {
      const capture = captureAiLiveContext(input({
        activeWorkspaceTabId: 'diff:inbox/redis',
        historyComparisons: [historyComparison({ status: 'error' })],
      }))
      expect(capture).toEqual({ status: 'unavailable', reason: 'load-error' })
    })

    it('reports missing-identity when the live after-side has no documentId', () => {
      const capture = captureAiLiveContext(input({
        activeWorkspaceTabId: 'diff:inbox/redis',
        documentTabs: [documentTab({ path: 'inbox/redis', documentId: 'doc-r' })],
        historyComparisons: [historyComparison()],
      }), {
        liveDocument: () => ({ raw: 'live', dirty: false, documentId: null }),
      })

      expect(capture).toEqual({ status: 'unavailable', reason: 'missing-identity' })
    })

    it('certifies the live after-side by the documentId that owns the open tab', () => {
      const capture = captureAiLiveContext(input({
        activeWorkspaceTabId: 'diff:inbox/redis',
        documentTabs: [documentTab({ path: 'inbox/redis', documentId: 'doc-r' })],
        historyComparisons: [historyComparison()],
      }), {
        liveDocument: () => ({ raw: 'live', dirty: false, documentId: 'doc-r' }),
      })

      readyDiff(capture)
    })
  })

  describe('capture semantics', () => {
    it('copies by value so later mutation of the source does not leak in', () => {
      const tab = documentTab({ raw: 'body at send time' })
      const capture = captureAiLiveContext(input({
        activeWorkspaceTabId: 'inbox/ideas',
        documentTabs: [tab],
      }))

      // The user keeps typing / the tab object mutates after Send.
      tab.raw = 'body typed after send'
      tab.title = 'Retitled'

      const context = readyDocument(capture)
      expect(context.raw).toBe('body at send time')
      expect(context.title).toBe('Ideas')
    })

    it('stamps capturedAt from the injected clock', () => {
      const capture = captureAiLiveContext(input({
        activeWorkspaceTabId: 'inbox/ideas',
        documentTabs: [documentTab()],
      }), { now: () => 1234567890 })

      const context = readyContext(capture)
      expect(context.capturedAt).toBe(1234567890)
    })

    it('reports stale-workspace when the active id matches nothing', () => {
      const capture = captureAiLiveContext(input({
        activeWorkspaceTabId: 'inbox/closed-meanwhile',
        documentTabs: [documentTab()],
      }))

      expect(capture).toEqual({ status: 'unavailable', reason: 'stale-workspace' })
    })
  })

  describe('recovery context', () => {
    it('sends the ready recovery in content view without the disk body', () => {
      const capture = captureAiLiveContext(input({
        activeWorkspaceTabId: 'recovery:vault:doc-a',
        recoveryTabs: [recoveryTab({ view: 'content', draftRaw: 'draft body', diskRaw: 'disk body' })],
      }))

      const context = readyRecovery(capture)
      expect(context.readOnly).toBe(true)
      expect(context.view).toBe('content')
      expect(context.draft).toEqual({ raw: 'draft body' })
      expect(context.disk).toBeUndefined()
    })

    it('sends the ready recovery in diff view with the disk body when readable', () => {
      const capture = captureAiLiveContext(input({
        activeWorkspaceTabId: 'recovery:vault:doc-a',
        recoveryTabs: [recoveryTab({ view: 'diff', draftRaw: 'draft side', diskRaw: 'disk side', diskDocumentId: 'doc-disk' })],
      }))

      const context = readyRecovery(capture)
      expect(context.view).toBe('diff')
      expect(context.draft).toEqual({ raw: 'draft side' })
      expect(context.disk).toEqual({ documentId: 'doc-disk', raw: 'disk side' })
    })

    it('reports load-error when the recovery viewer is not ready', () => {
      const capture = captureAiLiveContext(input({
        activeWorkspaceTabId: 'recovery:vault:doc-a',
        recoveryTabs: [recoveryTab({ status: 'error' })],
      }))
      expect(capture).toEqual({ status: 'unavailable', reason: 'load-error' })
    })
  })

  describe('priority order', () => {
    it('recovery wins over the diff when both tabs are active', () => {
      const capture = captureAiLiveContext(input({
        activeWorkspaceTabId: 'recovery:vault:doc-a',
        historyComparisons: [historyComparison({ tabId: 'recovery:vault:doc-a' })],
        recoveryTabs: [recoveryTab()],
      }))

      const context = readyRecovery(capture)
      expect(context.draft).toEqual({ raw: '# Ideas\n\ndraft body' })
    })

    it('diff wins over the route document', () => {
      const capture = captureAiLiveContext(input({
        activeWorkspaceTabId: 'diff:inbox/redis',
        documentTabs: [documentTab({ path: 'inbox/redis', documentId: 'doc-r' })],
        historyComparisons: [historyComparison()],
      }), {
        liveDocument: () => ({ raw: 'live', dirty: false, documentId: 'doc-r' }),
      })

      const context = readyDiff(capture)
      expect(context.title).toBe('Redis Notes')
      expect(context.identity.path).toBe('inbox/redis')
    })
  })
})

describe('liveEditorForPath', () => {
  it('returns the live buffer with revision-based dirtiness and identity', () => {
    const tabs = [
      documentTab({ path: 'inbox/a', documentId: 'doc-a', revision: 3, savedRevision: 3 }),
      documentTab({ path: 'inbox/b', documentId: 'doc-b', raw: 'B', revision: 4, savedRevision: 2 }),
    ]

    expect(liveEditorForPath(tabs, 'inbox/b')).toEqual({
      raw: 'B',
      dirty: true,
      documentId: 'doc-b',
    })
    expect(liveEditorForPath(tabs, 'inbox/a')?.dirty).toBe(false)
  })

  it('returns null when no tab is open for the path', () => {
    expect(liveEditorForPath([documentTab()], 'inbox/elsewhere')).toBeNull()
  })

  it('returns null for a loading tab', () => {
    expect(liveEditorForPath([documentTab({ loading: true })], 'inbox/ideas')).toBeNull()
  })

  it('returns null for a tab that failed to load', () => {
    expect(liveEditorForPath([documentTab({ loadError: 'HTTP 500' })], 'inbox/ideas')).toBeNull()
  })
})

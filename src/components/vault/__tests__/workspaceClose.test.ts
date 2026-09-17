import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceTab } from '../tabs'
import { deriveDocumentSavePresentation } from '../../../composables/vault/editor-tabs/savePresentation'
import {
  closeManyWorkspaceTabState,
  closeWorkspaceTabState,
} from '../workspaceClose'

const tabs: WorkspaceTab[] = [
  { id: 'a.md', label: 'A', title: 'A', save: deriveDocumentSavePresentation(null), kind: 'document' },
  { id: 'diff:a.md', label: 'A Diff', title: 'A Diff', save: deriveDocumentSavePresentation(null), kind: 'diff' },
  { id: 'b.md', label: 'B', title: 'B', save: deriveDocumentSavePresentation(null), kind: 'document' },
]

describe('Workspace close coordination', () => {
  it('classifies mixed tabs by kind and confirms all documents once before any mutation', async () => {
    const calls: string[] = []
    const mixed: WorkspaceTab[] = [
      { ...tabs[0]!, id: 'document-a', kind: 'document', documentPath: 'a.md' },
      { ...tabs[1]!, id: 'opaque-diff', kind: 'diff', documentPath: 'b.md' },
    ]
    const result = await closeManyWorkspaceTabState(mixed.map((tab) => tab.id), {
      workspaceTabs: mixed,
      activeId: 'opaque-diff',
      comparisons: () => [],
      confirmEditorTabs: async (ids) => { calls.push(`confirm:${ids.join(',')}`); return true },
      closeEditorTabsConfirmed: (ids) => calls.push(`documents:${ids.join(',')}`),
      closeComparisons: (ids) => calls.push(`diff:${ids.join(',')}`),
      refreshDocumentComparison: vi.fn().mockResolvedValue(true),
    })

    expect(calls).toEqual([
      'confirm:document-a',
      'documents:document-a',
      'diff:opaque-diff',
    ])
    expect(result.closed).toBe(true)
    expect(result.fallbackId).toBeNull()
  })

  it('closes Recovery views explicitly without routing them to editor close', async () => {
    const recovery: WorkspaceTab = {
      id: 'recovery:vault:document-a',
      label: 'Recovered A',
      title: 'Recovered A',
      save: deriveDocumentSavePresentation(null),
      kind: 'recovery',
      documentPath: 'a.md',
    }
    const closeEditorTab = vi.fn()
    const closeRecovery = vi.fn()

    const result = await closeWorkspaceTabState(recovery.id, {
      workspaceTabs: [tabs[0]!, recovery],
      activeId: recovery.id,
      comparisons: [],
      closeEditorTab,
      closeComparison: vi.fn(),
      closeRecovery,
      refreshDocumentComparison: vi.fn(),
    })

    expect(result.closed).toBe(true)
    expect(closeRecovery).toHaveBeenCalledWith(recovery.id)
    expect(closeEditorTab).not.toHaveBeenCalled()
  })

  it('batch closes Recovery views without dirty document confirmation', async () => {
    const recovery: WorkspaceTab = {
      id: 'recovery:vault:document-a',
      label: 'Recovered A',
      title: 'Recovered A',
      save: deriveDocumentSavePresentation(null),
      kind: 'recovery',
    }
    const confirmEditorTabs = vi.fn().mockResolvedValue(true)
    const closeRecoveries = vi.fn()

    await closeManyWorkspaceTabState([recovery.id], {
      workspaceTabs: [recovery],
      activeId: recovery.id,
      comparisons: () => [],
      confirmEditorTabs,
      closeEditorTabsConfirmed: vi.fn(),
      closeComparisons: vi.fn(),
      closeRecoveries,
      refreshDocumentComparison: vi.fn(),
    })

    expect(confirmEditorTabs).toHaveBeenCalledWith([])
    expect(closeRecoveries).toHaveBeenCalledWith([recovery.id])
  })

  it('refreshes a retained active Diff only after its dirty Current tab closes', async () => {
    const calls: string[] = []
    const result = await closeWorkspaceTabState('a.md', {
      workspaceTabs: tabs,
      activeId: 'diff:a.md',
      comparisons: [{ tabId: 'diff:a.md', documentPath: 'a.md' }],
      closeEditorTab: async () => { calls.push('close-current'); return true },
      closeComparison: vi.fn(),
      refreshDocumentComparison: async () => { calls.push('refresh-diff'); return true },
    })

    expect(calls).toEqual(['close-current', 'refresh-diff'])
    expect(result).toEqual({ closed: true, activeWillClose: false, fallbackId: null })
  })

  it('does not mutate any Workspace state when batch confirmation is cancelled', async () => {
    const closeEditorTabsConfirmed = vi.fn()
    const closeComparisons = vi.fn()
    const refreshDocumentComparison = vi.fn()

    const result = await closeManyWorkspaceTabState(['a.md', 'diff:a.md'], {
      workspaceTabs: tabs,
      activeId: 'diff:a.md',
      comparisons: () => [{ tabId: 'diff:a.md', documentPath: 'a.md' }],
      confirmEditorTabs: async () => false,
      closeEditorTabsConfirmed,
      closeComparisons,
      refreshDocumentComparison,
    })

    expect(result.closed).toBe(false)
    expect(closeEditorTabsConfirmed).not.toHaveBeenCalled()
    expect(closeComparisons).not.toHaveBeenCalled()
    expect(refreshDocumentComparison).not.toHaveBeenCalled()
  })

  it('refreshes only Diffs retained after Close Others removes Current tabs', async () => {
    let remaining = [
      { tabId: 'diff:a.md', documentPath: 'a.md' },
      { tabId: 'diff:b.md', documentPath: 'b.md' },
    ]
    const refreshDocumentComparison = vi.fn().mockResolvedValue(true)

    await closeManyWorkspaceTabState(['a.md', 'b.md', 'diff:b.md'], {
      workspaceTabs: [
        ...tabs,
        { id: 'diff:b.md', label: 'B Diff', title: 'B Diff', save: deriveDocumentSavePresentation(null), kind: 'diff' },
      ],
      activeId: 'diff:a.md',
      comparisons: () => remaining,
      confirmEditorTabs: async () => true,
      closeEditorTabsConfirmed: vi.fn(),
      closeComparisons: (ids) => {
        remaining = remaining.filter((comparison) => !ids.includes(comparison.tabId))
      },
      refreshDocumentComparison,
    })

    expect(refreshDocumentComparison).toHaveBeenCalledOnce()
    expect(refreshDocumentComparison).toHaveBeenCalledWith('a.md')
  })
})
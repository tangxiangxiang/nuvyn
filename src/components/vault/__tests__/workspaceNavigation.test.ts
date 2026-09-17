import { describe, expect, it } from 'vitest'
import type { WorkspaceTab } from '../tabs'
import { deriveDocumentSavePresentation } from '../../../composables/vault/editor-tabs/savePresentation'
import {
  fallbackAfterClosingWorkspaceTab,
  fallbackAfterClosingWorkspaceTabs,
} from '../workspaceNavigation'

function tab(id: string, kind: WorkspaceTab['kind'], documentPath?: string): WorkspaceTab {
  return { id, kind, label: id, title: id, save: deriveDocumentSavePresentation(null), documentPath }
}

describe('workspace History navigation', () => {
  // The History workspace is gone — Diff is the only read-only revision
  // tab. Closing a Diff falls back to its matching Current document.
  const tabs = [
    tab('inbox/a', 'document'),
    tab('inbox/b', 'document'),
    tab('diff:inbox/a', 'diff', 'inbox/a'),
    tab('diff:inbox/b', 'diff', 'inbox/b'),
  ]

  it('closes Diff to its matching Current document', () => {
    expect(fallbackAfterClosingWorkspaceTab(tabs, 'diff:inbox/a')).toBe('inbox/a')
  })

  it('falls back to the nearest remaining tab when no matching document is open', () => {
    const withoutDocument = tabs.filter((item) => item.kind !== 'document')
    expect(fallbackAfterClosingWorkspaceTab(withoutDocument, 'diff:inbox/a')).toBe('diff:inbox/b')
  })

  it('uses a nearest remaining tab without leaving a blank workspace', () => {
    const onlySpecial = [tab('diff:gone', 'diff'), tab('inbox/next', 'document')]
    expect(fallbackAfterClosingWorkspaceTab(onlySpecial, 'diff:gone')).toBe('inbox/next')
  })

  it('activates the matching Diff when a Current document closes', () => {
    expect(fallbackAfterClosingWorkspaceTab(tabs, 'inbox/b')).toBe('diff:inbox/b')
  })

  it('activates a retained Diff after Close Others removes the current document', () => {
    const oneDocument = [
      tab('inbox/a', 'document'),
      tab('diff:inbox/a', 'diff', 'inbox/a'),
    ]
    expect(fallbackAfterClosingWorkspaceTabs(oneDocument, ['inbox/a'], 'inbox/a'))
      .toBe('diff:inbox/a')
  })

  it('activates the only retained special tab after Close Others', () => {
    expect(fallbackAfterClosingWorkspaceTabs(
      tabs,
      tabs.filter((item) => item.id !== 'diff:inbox/b').map((item) => item.id),
      'diff:inbox/a',
    )).toBe('diff:inbox/b')
  })

  it('returns null only when a batch leaves no workspace tabs', () => {
    expect(fallbackAfterClosingWorkspaceTabs(tabs, tabs.map((item) => item.id), 'inbox/a'))
      .toBeNull()
  })
})
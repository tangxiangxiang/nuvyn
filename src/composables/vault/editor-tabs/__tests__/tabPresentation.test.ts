// Pure presentation tests — no Vue mounting required. The presentation
// module is the single source of truth for tab title, filename, path,
// status text, and aria-label.

import { describe, expect, it } from 'vitest'
import type { WorkspaceTab } from '../../../../components/vault/tabs'
import type { DocumentSavePresentation } from '../savePresentation'
import {
  deriveDisplayTitle,
  deriveFilenameLabel,
  deriveTabUiPresentation,
} from '../tabPresentation'

// Minimal translator stub. Tests that need exact aria-label output
// compose expectations off this map.
const NO_T = (key: string) => key
const STUB_STRINGS: Record<string, string> = {
  'status.saved': 'Saved',
  'workspace_tab.aria_separator': ', ',
  'workspace_tab.aria_file': 'file {name}',
  'workspace_tab.aria_title': 'title {name}',
}
function stubT(key: string, params: Record<string, string | number> = {}): string {
  const template = STUB_STRINGS[key]
  if (!template) return key
  return template.replace(/\{([a-zA-Z0-9_-]+)\}/g, (match, name: string) => (
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  ))
}

function save(overrides: Partial<DocumentSavePresentation> = {}): DocumentSavePresentation {
  return {
    status: 'idle',
    dirty: false,
    inFlight: false,
    hasNewerChanges: false,
    retryable: false,
    attention: false,
    ...overrides,
  }
}

function tab(overrides: Partial<WorkspaceTab> = {}): WorkspaceTab {
  const id = overrides.id ?? 'inbox/test-document-1.md'
  return {
    id,
    label: id.split('/').pop() ?? id,
    title: 'Test Document 1',
    save: save(),
    kind: 'document',
    ...overrides,
  }
}

describe('deriveDisplayTitle — title priority', () => {
  it('uses the metadata title when it is set and meaningful', () => {
    expect(deriveDisplayTitle('测试文档', 'inbox/test-document-1.md'))
      .toBe('测试文档')
  })

  it('falls back to the basename when the title is empty', () => {
    expect(deriveDisplayTitle('', 'inbox/test-document-1.md'))
      .toBe('test-document-1')
  })

  it('falls back to the basename when the title is whitespace only', () => {
    expect(deriveDisplayTitle('   ', 'inbox/test-document-1.md'))
      .toBe('test-document-1')
  })

  it('falls back to the basename when the title equals the full path', () => {
    expect(deriveDisplayTitle('inbox/test-document-1.md', 'inbox/test-document-1.md'))
      .toBe('test-document-1')
  })

  it('falls back to the basename when the title equals the basename', () => {
    expect(deriveDisplayTitle('test-document-1', 'inbox/test-document-1.md'))
      .toBe('test-document-1')
  })

  it('falls back to the basename when the title equals basename.md', () => {
    expect(deriveDisplayTitle('test-document-1.md', 'inbox/test-document-1.md'))
      .toBe('test-document-1')
  })

  it('preserves mixed-language titles verbatim', () => {
    expect(deriveDisplayTitle('Redis Notes', 'inbox/redis.md'))
      .toBe('Redis Notes')
    expect(deriveDisplayTitle('文档 C', 'inbox/c.md'))
      .toBe('文档 C')
  })
})

describe('deriveFilenameLabel — tooltip secondary line', () => {
  it('returns the basename when displayTitle came from the title', () => {
    expect(deriveFilenameLabel('测试文档', 'inbox/test-document-1.md'))
      .toBe('test-document-1')
  })

  it('returns null when displayTitle already equals the basename', () => {
    expect(deriveFilenameLabel('test-document-1', 'inbox/test-document-1.md'))
      .toBeNull()
  })

  it('returns null when displayTitle equals the basename with .md', () => {
    expect(deriveFilenameLabel('test-document-1.md', 'inbox/test-document-1.md'))
      .toBeNull()
  })

  it('returns null for empty paths', () => {
    expect(deriveFilenameLabel('Test', '')).toBeNull()
  })
})

describe('deriveTabUiPresentation — strip prefers title', () => {
  it('shows the metadata title in the strip and the filename in the tooltip', () => {
    const t = tab({
      id: 'inbox/test-document-1',
      title: '测试文档',
    })
    const p = deriveTabUiPresentation(t, NO_T)
    expect(p.displayTitle).toBe('测试文档')
    expect(p.filenameLabel).toBe('test-document-1')
    expect(p.fullPath).toBe('inbox/test-document-1')
  })

  it('falls back to the basename when the title equals the path', () => {
    const t = tab({
      id: 'inbox/test-document-1',
      title: 'inbox/test-document-1',
    })
    const p = deriveTabUiPresentation(t, NO_T)
    expect(p.displayTitle).toBe('test-document-1')
    // No redundant filename line — the strip already shows the basename.
    expect(p.filenameLabel).toBeNull()
  })

  it('falls back to the basename when the title is empty', () => {
    const t = tab({
      id: 'inbox/test-document-1',
      title: '',
    })
    const p = deriveTabUiPresentation(t, NO_T)
    expect(p.displayTitle).toBe('test-document-1')
    expect(p.filenameLabel).toBeNull()
  })

  it('falls back to the basename when the title equals the basename', () => {
    const t = tab({
      id: 'inbox/test-document-1',
      title: 'test-document-1',
    })
    const p = deriveTabUiPresentation(t, NO_T)
    expect(p.displayTitle).toBe('test-document-1')
    expect(p.filenameLabel).toBeNull()
  })

  it('mixed-language titles — each tab shows its own title in the strip', () => {
    const tabs: WorkspaceTab[] = [
      tab({ id: 'inbox/a.md', title: '中文标题' }),
      tab({ id: 'inbox/b.md', title: 'English Title' }),
      tab({ id: 'inbox/c.md', title: '' }),
    ]
    const presentations = tabs.map((t) => deriveTabUiPresentation(t, NO_T))
    // Strip languages come from each document's metadata title,
    // falling back to the filename when the title is missing.
    expect(presentations.map((p) => p.displayTitle)).toEqual([
      '中文标题',
      'English Title',
      'c',
    ])
    // Only the first two tabs have a meaningful metadata title, so
    // their filename labels carry the file identity. The third tab
    // already shows the basename in the strip, so its filename
    // label is suppressed.
    expect(presentations[0]!.filenameLabel).toBe('a')
    expect(presentations[1]!.filenameLabel).toBe('b')
    expect(presentations[2]!.filenameLabel).toBeNull()
  })

  it('diff keeps its existing label semantics', () => {
    const d = tab({
      id: 'diff:redis',
      kind: 'diff',
      label: 'Redis (差异)',
      title: 'Redis',
    })
    expect(deriveTabUiPresentation(d, NO_T).displayTitle).toBe('Redis (差异)')
    expect(deriveTabUiPresentation(d, NO_T).filenameLabel).toBeNull()
    expect(deriveTabUiPresentation(d, NO_T).fullPath).toBeNull()
  })

  it('two docs with same title but different paths both keep the title', () => {
    const a = tab({ id: 'a/notes.md', title: 'Notes' })
    const b = tab({ id: 'b/notes.md', title: 'Notes' })
    expect(deriveTabUiPresentation(a, NO_T).displayTitle).toBe('Notes')
    expect(deriveTabUiPresentation(b, NO_T).displayTitle).toBe('Notes')
    // Tooltip filename lines keep them distinguishable.
    expect(deriveTabUiPresentation(a, NO_T).filenameLabel).toBe('notes')
    expect(deriveTabUiPresentation(b, NO_T).filenameLabel).toBe('notes')
    // ...and the full path keeps them unambiguous in any context.
    expect(deriveTabUiPresentation(a, NO_T).fullPath).toBe('a/notes.md')
    expect(deriveTabUiPresentation(b, NO_T).fullPath).toBe('b/notes.md')
  })
})

describe('deriveTabUiPresentation — status text', () => {
  it.each([
    ['idle', 'status.saved'],
    ['saved', 'status.saved'],
    ['dirty', 'status.unsaved'],
    ['saving', 'status.saving'],
    ['saving-dirty', 'status.saving_dirty'],
    ['error', 'status.error'],
    ['offline', 'status.offline'],
    ['external', 'status.external'],
  ] as const)('maps %s → %s', (status, key) => {
    const t = tab({ save: save({ status }) })
    const p = deriveTabUiPresentation(t, NO_T)
    expect(p.statusText).toBe(key)
  })

  it('does not emit the raw enum names in user-facing strings', () => {
    for (const status of ['idle', 'saved', 'dirty', 'saving', 'saving-dirty', 'error', 'offline', 'external'] as const) {
      const t = tab({ save: save({ status }) })
      const p = deriveTabUiPresentation(t, NO_T)
      expect(p.statusText).not.toBe(status)
    }
  })

  it('does not surface the literal word Idle/空闲', () => {
    const idle = tab({ save: save({ status: 'idle' }) })
    const saved = tab({ save: save({ status: 'saved' }) })
    expect(deriveTabUiPresentation(idle, NO_T).statusText).not.toBe('idle')
    expect(deriveTabUiPresentation(idle, NO_T).statusText).not.toBe('Idle')
    expect(deriveTabUiPresentation(idle, NO_T).statusText).not.toBe('空闲')
    expect(deriveTabUiPresentation(saved, NO_T).statusText).not.toBe('idle')
    expect(deriveTabUiPresentation(saved, NO_T).statusText).not.toBe('Idle')
    expect(deriveTabUiPresentation(saved, NO_T).statusText).not.toBe('空闲')
  })

  it('omits the status text for diff tabs', () => {
    const d = tab({ kind: 'diff', save: save() })
    expect(deriveTabUiPresentation(d, NO_T).statusText).toBeNull()
    expect(deriveTabUiPresentation(d, NO_T).statusKind).toBe('none')
    expect(deriveTabUiPresentation(d, NO_T).fullPath).toBeNull()
  })
})

describe('deriveTabUiPresentation — presentation priority', () => {
  it('shows saving / saving-dirty even when runtime saveStatus is dirty', () => {
    const p = deriveTabUiPresentation(
      tab({
        save: save({
          status: 'saving-dirty',
          dirty: true,
          inFlight: true,
          hasNewerChanges: true,
        }),
      }),
      NO_T,
    )
    expect(p.statusKind).toBe('saving')
    expect(p.statusText).toBe('status.saving_dirty')
  })

  it('prefers error over dirty', () => {
    const p = deriveTabUiPresentation(
      tab({ save: save({ status: 'error', dirty: true, retryable: true, attention: true }) }),
      NO_T,
    )
    expect(p.statusKind).toBe('error')
    expect(p.statusText).toBe('status.error')
  })

  it('prefers offline over dirty', () => {
    const p = deriveTabUiPresentation(
      tab({ save: save({ status: 'offline', dirty: true, retryable: true, attention: true }) }),
      NO_T,
    )
    expect(p.statusKind).toBe('offline')
    expect(p.statusText).toBe('status.offline')
  })

  it('prefers external over dirty', () => {
    const p = deriveTabUiPresentation(
      tab({ save: save({ status: 'external', dirty: true, attention: true }) }),
      NO_T,
    )
    expect(p.statusKind).toBe('external')
    expect(p.statusText).toBe('status.external')
  })
})

describe('deriveTabUiPresentation — aria-label', () => {
  it('uses "<title>, file <filename>, <status>" when title differs from filename', () => {
    const p = deriveTabUiPresentation(
      tab({ id: 'a.md', title: '测试文档' }),
      stubT,
    )
    expect(p.ariaLabel).toBe('title 测试文档, file a, Saved')
  })

  it('falls back to displayTitle only when filename would duplicate', () => {
    const p = deriveTabUiPresentation(
      tab({ id: 'a.md', title: '' }),
      stubT,
    )
    expect(p.ariaLabel).toBe('a, Saved')
  })

  it('falls back to displayTitle when title equals the basename', () => {
    const p = deriveTabUiPresentation(
      tab({ id: 'a.md', title: 'a' }),
      stubT,
    )
    expect(p.ariaLabel).toBe('a, Saved')
  })

  it('diff aria-label keeps the legacy layout (no filename, no status)', () => {
    const h = deriveTabUiPresentation(
      tab({ kind: 'diff', label: 'Redis (差异)', title: 'Redis' }),
      NO_T,
    )
    expect(h.ariaLabel).toBe('Redis (差异)')
  })

  it('identifies Recovery tabs as local-only without exposing content or a path', () => {
    const recovery = deriveTabUiPresentation(
      tab({
        id: 'recovery:vault:document-a',
        kind: 'recovery',
        label: 'Recovered: A',
        title: 'Recovered: A',
        documentPath: 'notes/a',
      }),
      NO_T,
    )
    expect(recovery.fullPath).toBeNull()
    expect(recovery.statusText).toBe('draft_recovery.local_only')
    expect(recovery.ariaLabel).toContain('draft_recovery.local_only')
    expect(recovery.ariaLabel).not.toContain('notes/a')
  })
})

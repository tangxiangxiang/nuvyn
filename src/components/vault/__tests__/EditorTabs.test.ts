// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import EditorTabs from '../EditorTabs.vue'
import type { WorkspaceTab } from '../tabs'
import { useI18n } from '../../../composables/useI18n'
import { deriveDocumentSavePresentation } from '../../../composables/vault/editor-tabs/savePresentation'
import type { DocumentSavePresentation } from '../../../composables/vault/editor-tabs/savePresentation'

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

function makeTab(path: string, overrides: Partial<WorkspaceTab> = {}): WorkspaceTab {
  return {
    id: path,
    label: path.endsWith('.md') ? path.slice(0, -3) : path,
    title: path,
    save: deriveDocumentSavePresentation(null),
    kind: 'document',
    ...overrides,
  }
}

const TABS: WorkspaceTab[] = [
  makeTab('a.md'),
  makeTab('b.md'),
  makeTab('c.md'),
  makeTab('d.md'),
]

describe('EditorTabs (existing behavior)', () => {
  beforeEach(() => {
    useI18n().setLocale('zh')
    document.querySelectorAll('.tab-context-menu').forEach((el) => el.remove())
  })

  it('emits select on click and close on × / middle-click', async () => {
    const w = mount(EditorTabs, {
      props: { tabs: TABS, activePath: 'a.md' },
      attachTo: document.body,
    })
    const tab = w.findAll('.tab').find((t) => t.find('.tab-title').text() === 'b')!
    await tab.trigger('click')
    expect(w.emitted('select')).toEqual([['b.md']])
    await tab.find('.tab-close').trigger('click')
    expect(w.emitted('close')).toEqual([['b.md']])
    await tab.trigger('auxclick', { button: 1 })
    expect(w.emitted('close')?.[1]).toEqual(['b.md'])
    w.unmount()
  })

  it('renders a read-only diff presentation tab without a dirty marker', () => {
    const historyTab = makeTab('diff:inbox/redis', {
      label: 'Redis Notes (Diff)',
      title: 'Redis Notes',
      kind: 'diff',
    })
    const w = mount(EditorTabs, {
      props: { tabs: [historyTab], activePath: historyTab.id },
    })

    expect(w.get('.tab').classes()).toContain('diff')
    expect(w.get('.tab-title').text()).toBe('Redis Notes (Diff)')
    expect(w.find('.tab-dirty-indicator').exists()).toBe(false)
    expect(w.find('.tab-status-indicator').exists()).toBe(false)
  })

  it('renders a dedicated comparison presentation tab', () => {
    const diffTab = makeTab('diff:inbox/redis', {
      label: 'Redis Notes (Diff)',
      title: 'Redis Notes',
      kind: 'diff',
    })
    const wrapper = mount(EditorTabs, {
      props: { tabs: [diffTab], activePath: diffTab.id },
    })

    expect(wrapper.get('.tab').classes()).toContain('diff')
    expect(wrapper.get('.tab-title').text()).toBe('Redis Notes (Diff)')
    expect(wrapper.find('.tab-dirty-indicator').exists()).toBe(false)
    expect(wrapper.find('.tab-status-indicator').exists()).toBe(false)
  })

  it('keeps dirty and in-flight semantics visible while saving', () => {
    useI18n().setLocale('en')
    const saving = makeTab('saving.md', {
      save: save({ status: 'saving', dirty: true, inFlight: true }),
    })
    const savingDirty = makeTab('newer.md', {
      save: save({
        status: 'saving-dirty',
        dirty: true,
        inFlight: true,
        hasNewerChanges: true,
      }),
    })
    const wrapper = mount(EditorTabs, {
      props: { tabs: [saving, savingDirty], activePath: saving.id },
    })
    const rendered = wrapper.findAll('.tab')

    expect(rendered[0]!.attributes('data-save-status')).toBe('saving')
    expect(rendered[0]!.find('.tab-dirty-indicator').exists()).toBe(true)
    expect(rendered[0]!.find('.tab-status-indicator[data-kind="saving"]').exists()).toBe(true)
    expect(rendered[0]!.attributes('aria-label')).toContain('Saving…')
    expect(rendered[1]!.attributes('data-save-status')).toBe('saving-dirty')
    expect(rendered[1]!.find('.tab-dirty-indicator[data-newer-changes="true"]').exists()).toBe(true)
    expect(rendered[1]!.find('.tab-status-indicator[data-kind="saving"]').exists()).toBe(true)
    expect(rendered[1]!.attributes('aria-label')).toContain('newer changes pending')
  })

  it('preserves dirty markers for error, offline, and external documents', () => {
    const tabs = (['error', 'offline', 'external'] as const).map((status) => makeTab(`${status}.md`, {
      save: save({ status, dirty: true, retryable: status !== 'external', attention: true }),
    }))
    const wrapper = mount(EditorTabs, { props: { tabs, activePath: tabs[0]!.id } })

    for (let i = 0; i < tabs.length; i++) {
      const rendered = wrapper.findAll('.tab')[i]!
      // The dirty buffer marker MUST stay visible next to the status
      // indicator — this is the regression that motivated the split
      // (the old single `.tab-dot` let the status color overwrite the
      // dirty fill, making `external + dirty` indistinguishable from
      // `external + clean`).
      expect(rendered.find('.tab-dirty-indicator').exists()).toBe(true)
      expect(rendered.find(`.tab-status-indicator[data-kind="${tabs[i]!.save.status}"]`).exists()).toBe(true)
      expect(rendered.classes()).toContain('save-attention')
    }
  })

  it('keeps per-document presentation independent and excludes read-only tabs', () => {
    useI18n().setLocale('en')
    const tabs = [
      makeTab('a.md', { save: save({ status: 'saving', dirty: true, inFlight: true }) }),
      makeTab('b.md', { save: save({ status: 'dirty', dirty: true }) }),
      makeTab('c.md', { save: save({ status: 'error', dirty: true, retryable: true, attention: true }) }),
      makeTab('diff:a', { kind: 'diff', save: save() }),
      makeTab('recovery:a', { kind: 'recovery', save: save() }),
    ]
    const wrapper = mount(EditorTabs, { props: { tabs, activePath: 'a.md' } })
    const rendered = wrapper.findAll('.tab')

    expect(rendered.slice(0, 3).map((item) => item.attributes('data-save-status')))
      .toEqual(['saving', 'dirty', 'error'])
    expect(rendered[3]!.attributes('data-save-status')).toBeUndefined()
    expect(rendered[4]!.attributes('data-save-status')).toBeUndefined()
    expect(rendered[3]!.attributes('aria-label')).not.toContain('Idle')
    expect(rendered[4]!.attributes('aria-label')).not.toContain('Idle')
    expect(rendered[3]!.find('.tab-dirty-indicator').exists()).toBe(false)
    expect(rendered[4]!.find('.tab-dirty-indicator').exists()).toBe(false)
  })

  it('uses roving tabindex and can restore focus to a workspace tab', () => {
    const wrapper = mount(EditorTabs, {
      props: { tabs: TABS, activePath: 'b.md' },
      attachTo: document.body,
    })
    const tabElements = wrapper.findAll<HTMLElement>('[role="tab"]')
    expect(tabElements.map((tab) => tab.attributes('tabindex'))).toEqual(['-1', '0', '-1', '-1'])

    wrapper.vm.focusTab('b.md')
    expect(document.activeElement).toBe(tabElements[1]!.element)
    wrapper.unmount()
  })
})

describe('EditorTabs context action slot', () => {
  beforeEach(() => {
    useI18n().setLocale('zh')
  })

  it('keeps an optional context action outside the tablist', () => {
    const wrapper = mount(EditorTabs, {
      props: { tabs: [makeTab('a.md')], activePath: 'a.md' },
      slots: {
        'context-actions': '<button data-testid="context-action">Context</button>',
      },
    })

    expect(wrapper.find('[data-testid="context-action"]').exists()).toBe(true)
    expect(wrapper.find('.editor-tabs-context-actions').exists()).toBe(true)
    expect(wrapper.get('[role="tablist"]').find('[data-testid="context-action"]').exists()).toBe(false)
  })

  it('does not leave an empty context-action rail when the caller has no action', () => {
    const wrapper = mount(EditorTabs, {
      props: {
        tabs: [makeTab('a.md')],
        activePath: 'a.md',
        contextActionsVisible: false,
      },
      slots: {
        'context-actions': '<button data-testid="context-action">Context</button>',
      },
    })

    expect(wrapper.find('.editor-tabs-context-actions').exists()).toBe(false)
  })
})

describe('EditorTabs ARIA', () => {
  beforeEach(() => {
    useI18n().setLocale('zh')
    document.querySelectorAll('.tab-context-menu').forEach((el) => el.remove())
  })

  it('uses user-readable aria-label for each status', async () => {
    useI18n().setLocale('zh')
    const tabs: WorkspaceTab[] = [
      makeTab('a.md', { save: save({ status: 'idle' }) }),
      makeTab('b.md', { save: save({ status: 'saved' }) }),
      makeTab('c.md', { save: save({ status: 'dirty', dirty: true }) }),
      makeTab('d.md', { save: save({ status: 'saving', dirty: true, inFlight: true }) }),
      makeTab('e.md', { save: save({ status: 'saving-dirty', dirty: true, inFlight: true, hasNewerChanges: true }) }),
      makeTab('f.md', { save: save({ status: 'error', dirty: true, retryable: true, attention: true }) }),
      makeTab('g.md', { save: save({ status: 'offline', dirty: true, retryable: true, attention: true }) }),
      makeTab('h.md', { save: save({ status: 'external', dirty: true, attention: true }) }),
    ]
    const w = mount(EditorTabs, { props: { tabs, activePath: 'a.md' } })
    const rendered = w.findAll('.tab')
    // New format (round-3): "<displayTitle>，<statusText>" — no
    // documentTitle (these fixtures use title=path so the documentTitle
    // line is suppressed).
    expect(rendered[0]!.attributes('aria-label')).toBe('a，已保存')
    expect(rendered[1]!.attributes('aria-label')).toBe('b，已保存')
    expect(rendered[2]!.attributes('aria-label')).toBe('c，未保存')
    expect(rendered[3]!.attributes('aria-label')).toBe('d，保存中…')
    expect(rendered[4]!.attributes('aria-label')).toBe('e，保存中…仍有较新修改')
    expect(rendered[5]!.attributes('aria-label')).toBe('f，保存失败')
    expect(rendered[6]!.attributes('aria-label')).toBe('g，离线，等待保存')
    expect(rendered[7]!.attributes('aria-label')).toBe('h，检测到外部文件变化')
    w.unmount()
  })

  it('does not render a hover or focus information popup', async () => {
    const w = mount(EditorTabs, {
      props: { tabs: TABS, activePath: 'a.md' },
      attachTo: document.body,
    })
    const tab = w.findAll('.tab').find((t) => t.find('.tab-title').text() === 'b')!
    expect(tab.attributes('aria-describedby')).toBeUndefined()
    await tab.trigger('mouseenter')
    await tab.trigger('focusin')
    expect(document.querySelector('.tab-tooltip')).toBeNull()
    expect(tab.attributes('aria-describedby')).toBeUndefined()
    w.unmount()
  })

  it('diff tabs do not include save status in their aria-label', () => {
    const tabs = [
      makeTab('diff:a', {
        kind: 'diff',
        label: 'Redis (Diff)',
        title: 'Redis (Diff)',
        save: save(),
      }),
    ]
    const w = mount(EditorTabs, {
      props: { tabs, activePath: tabs[0]!.id },
    })
    const rendered = w.findAll('.tab')
    expect(rendered[0]!.attributes('aria-label')).toBe('Redis (Diff)')
    // Save-status words must NOT appear in the diff aria-label.
    expect(rendered[0]!.attributes('aria-label')).not.toContain('已保存')
  })

})

describe('EditorTabs — round-2 regression tests', () => {
  beforeEach(() => {
    useI18n().setLocale('zh')
    document.querySelectorAll('.tab-context-menu').forEach((el) => el.remove())
  })

  // --- P1: dirty + error/offline/external indicators both visible.
  it('shows the dirty marker AND the status indicator together for error/offline/external', () => {
    const tabs = (['error', 'offline', 'external'] as const).map((status) =>
      makeTab(`${status}-combined.md`, {
        save: save({ status, dirty: true, retryable: status !== 'external', attention: true }),
      }),
    )
    const w = mount(EditorTabs, { props: { tabs, activePath: tabs[0]!.id } })
    for (const t of tabs) {
      const row = w.findAll('.tab').find((r) => r.attributes('data-tab-id') === t.id)!
      expect(row.find('.tab-dirty-indicator').exists()).toBe(true)
      expect(row.find(`.tab-status-indicator[data-kind="${t.save.status}"]`).exists()).toBe(true)
      // The two are siblings — independent DOM elements, not nested.
      const dirty = row.find('.tab-dirty-indicator').element
      const status = row.find(`.tab-status-indicator[data-kind="${t.save.status}"]`).element
      expect(dirty).not.toBe(status)
    }
    w.unmount()
  })

  // Close buttons use aria-label for accessibility and intentionally have
  // no native title popup.
  it('does not set a native title attribute on the close button', () => {
    const w = mount(EditorTabs, {
      props: { tabs: TABS, activePath: 'a.md' },
    })
    const closeButtons = w.findAll('.tab-close')
    for (const btn of closeButtons) {
      expect(btn.attributes('title')).toBeUndefined()
      expect(btn.attributes('aria-label')).toBeTruthy()
    }
    w.unmount()
  })

  it('does not set a native title attribute on the tab row itself', () => {
    const w = mount(EditorTabs, {
      props: { tabs: TABS, activePath: 'a.md' },
    })
    for (const row of w.findAll('.tab')) {
      expect(row.attributes('title')).toBeUndefined()
    }
    w.unmount()
  })

  // --- diff tabs keep the original title semantics; the change to
  // VaultView must not strip the document title from their aria-label.
  it('diff tabs continue to surface their document title', () => {
    useI18n().setLocale('zh')
    const tabs = [
      makeTab('diff:redis', { kind: 'diff', label: 'Redis (差异)', title: 'Redis' }),
    ]
    const w = mount(EditorTabs, { props: { tabs, activePath: tabs[0]!.id } })
    const rendered = w.findAll('.tab')
    expect(rendered[0]!.attributes('aria-label')).toBe('Redis (差异)')
    expect(rendered[0]!.find('.tab-dirty-indicator').exists()).toBe(false)
    expect(rendered[0]!.find('.tab-status-indicator').exists()).toBe(false)
  })
})

describe('EditorTabs — round-4 regression (title is primary; basename fallback)', () => {
  beforeEach(() => {
    useI18n().setLocale('zh')
    document.querySelectorAll('.tab-context-menu').forEach((el) => el.remove())
  })

  // Each tab carries its own metadata title verbatim. Strip languages
  // come from the metadata, with fallback to basename only when the
  // title is missing.
  it('strip honors each document’s own title verbatim', () => {
    useI18n().setLocale('zh')
    const tabs = [
      makeTab('inbox/a.md', { label: 'a', title: '中文标题' }),
      makeTab('inbox/b.md', { label: 'b', title: 'English Title' }),
      makeTab('inbox/c.md', { label: 'c', title: '' }),
    ]
    const w = mount(EditorTabs, {
      props: { tabs, activePath: tabs[0]!.id },
      attachTo: document.body,
    })
    const stripTitles = w.findAll('.tab-title').map((el) => el.text())
    // Strip: tab a and b use their metadata titles; c falls back to
    // the basename.
    expect(stripTitles).toEqual(['中文标题', 'English Title', 'c'])
    w.unmount()
  })

  // English locale sanity check — separator is comma + space.
  it('English aria-label uses the title + file connectors when title is meaningful', () => {
    useI18n().setLocale('en')
    const tab = makeTab('inbox/test-document-1', {
      label: 'test-document-1',
      title: 'Test Document',
    })
    const w = mount(EditorTabs, { props: { tabs: [tab], activePath: tab.id } })
    const aria = w.find('.tab').attributes('aria-label')!
    expect(aria).toBe('title Test Document, file test-document-1, Saved')
    w.unmount()
  })

  // The original round-3 must-have: tabs with mixed-language titles
  // do NOT collapse to basenames when the metadata title is present.
  it('mixed-language tabs each show their own metadata title', () => {
    const tabs = [
      makeTab('inbox/a.md', { title: '中文标题' }),
      makeTab('inbox/b.md', { title: 'English Title' }),
      makeTab('inbox/c.md', { title: '' }),
    ]
    const w = mount(EditorTabs, {
      props: { tabs, activePath: tabs[0]!.id },
    })
    const titles = w.findAll('.tab-title').map((el) => el.text())
    expect(titles).toEqual(['中文标题', 'English Title', 'c'])
    w.unmount()
  })

  // Two documents with the same title but different paths both keep
  // the title in the strip and rely on the path line for identity.
  it('same-title different-path tabs both keep the title; paths disambiguate', () => {
    const tabs = [
      makeTab('a/notes.md', { title: 'Notes' }),
      makeTab('b/notes.md', { title: 'Notes' }),
    ]
    const w = mount(EditorTabs, {
      props: { tabs, activePath: tabs[0]!.id },
    })
    expect(w.findAll('.tab-title').map((el) => el.text())).toEqual(['Notes', 'Notes'])
    w.unmount()
  })
})

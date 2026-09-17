// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import HistoryComparisonPane from '../HistoryComparisonPane.vue'
import type { HistoryComparison } from '../../../composables/vault/useHistoryComparisons'
import { useI18n } from '../../../composables/useI18n'

function comparison(overrides: Partial<HistoryComparison> = {}): HistoryComparison {
  return {
    tabId: 'diff:inbox/redis',
    documentPath: 'inbox/redis',
    documentTitle: 'Redis Notes',
    mode: 'commit-change',
    revisionId: 'revision-a',
    parentRevisionId: 'parent-a',
    beforeRef: 'parent-a',
    afterRef: 'revision-a',
    revisionTime: new Date(2026, 6, 15, 10, 31).getTime(),
    summary: 'Update cache section',
    beforeRaw: 'old',
    afterRaw: 'new',
    beforeExists: true,
    afterExists: true,
    currentDirty: false,
    diff: {
      ops: [
        { op: 'remove', oldLine: 1, newLine: null, text: 'old' },
        { op: 'add', oldLine: null, newLine: 1, text: 'new' },
      ],
      stats: { added: 1, removed: 1, equal: 0 },
    },
    status: 'ready',
    error: null,
    ...overrides,
  }
}

function mountPane(value: HistoryComparison) {
  return mount(HistoryComparisonPane, {
    props: { comparison: value },
    attachTo: document.body,
    global: {
      stubs: {
        HistoryUnifiedDiff: {
          props: ['diff', 'comparisonKey'],
          template: '<div class="unified-diff-stub">{{ comparisonKey }} / +{{ diff.stats.added }} −{{ diff.stats.removed }}</div>',
        },
        HistoryUnchangedContent: {
          props: ['raw', 'comparisonKey'],
          template: '<div class="unchanged-content-stub">{{ comparisonKey }} / {{ raw }}</div>',
        },
      },
    },
  })
}

function teleportedMenu(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.history-pane-menu')
}

describe('HistoryComparisonPane', () => {
  it('renders a compact diff header with direction, stats, and ⋯ menu trigger', async () => {
    const wrapper = mountPane(comparison())

    expect(wrapper.get('h2').text()).toBe('Redis Notes')
    expect(wrapper.get('.history-diff-stats').text()).toContain('+1')
    expect(wrapper.get('.history-diff-stats').text()).toContain('−1')
    expect(wrapper.get('.unified-diff-stub').text()).toBe('inbox/redis\0revision-a / +1 −1')
    expect(wrapper.text()).toContain('parent-')
    expect(wrapper.text()).toContain('revision')
    expect(wrapper.text()).not.toContain('Working tree')

    // No prominent Restore button until the menu is opened.
    expect(wrapper.find('.history-restore-button').exists()).toBe(false)
    expect(wrapper.find('.history-pane-menu-trigger').exists()).toBe(true)

    // The toolbar of multi-button actions that used to live on the
    // comparison pane (View Historical / View Current / Close Diff) is
    // gone — closing now belongs to the workspace tab, viewing the
    // current version belongs to the document tab.
    expect(wrapper.find('[role="toolbar"]').exists()).toBe(false)
  })

  it('labels root and worktree directions accessibly', async () => {
    const wrapper = mountPane(comparison({ parentRevisionId: null, beforeRef: null }))
    const chips = wrapper.findAll('.history-revision-chip')
    expect(chips[0]?.text()).toBe('∅')
    expect(chips[0]?.attributes('aria-label')).toBe('Empty')
    expect(chips[1]?.text()).toBe('revisio')

    await wrapper.setProps({
      comparison: comparison({
        mode: 'revision-to-worktree',
        beforeRef: 'revision-a',
        afterRef: 'WORKTREE',
      }),
    })
    expect(wrapper.findAll('.history-revision-chip').map((chip) => chip.text())).toEqual(['revisio', 'Working tree'])
  })

  it('exposes a focus target on the diff heading', () => {
    const wrapper = mount(HistoryComparisonPane, {
      props: { comparison: comparison() },
      attachTo: document.body,
      global: { stubs: { HistoryUnifiedDiff: true } },
    })
    wrapper.vm.focusViewer()
    expect(document.activeElement).toBe(wrapper.get('h2').element)
    wrapper.unmount()
  })

  it('opens a ⋯ menu with Restore that is disabled until the comparison is ready', async () => {
    const wrapper = mountPane(comparison({ status: 'loading', diff: null }))
    expect(teleportedMenu()).toBeNull()
    expect(wrapper.find('.history-pane-menu-trigger').exists()).toBe(false)

    await wrapper.setProps({ comparison: comparison() })
    await wrapper.get('.history-pane-menu-trigger').trigger('click')
    const menu = teleportedMenu()!
    expect(menu).not.toBeNull()
    expect(wrapper.get('.history-diff-header-meta').element.contains(menu)).toBe(true)
    const menuItems = [...menu.querySelectorAll('button')]
    expect(menuItems[0]?.textContent).toContain('Compare with Working Tree')
    expect(menuItems[1]?.textContent).toContain('Restore')
    menuItems[1]?.click()
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('restore')?.[0]?.[0]).toMatchObject({ revisionId: 'revision-a' })
  })

  it('emits mode actions and uses the selected revision as the restore target', async () => {
    const wrapper = mountPane(comparison())
    await wrapper.get('.history-pane-menu-trigger').trigger('click')
    await wrapper.get('.history-pane-menu button').trigger('click')
    expect(wrapper.emitted('compareWithWorkingTree')).toEqual([['diff:inbox/redis']])

    await wrapper.setProps({ comparison: comparison({ mode: 'revision-to-worktree', beforeRef: 'revision-a', afterRef: 'WORKTREE' }) })
    await wrapper.get('.history-pane-menu-trigger').trigger('click')
    expect(wrapper.text()).toContain('Working tree')
    await wrapper.get('.history-pane-menu button').trigger('click')
    expect(wrapper.emitted('viewCommitChanges')).toEqual([['diff:inbox/redis']])
  })

  it('hides Restore for a deletion revision and exposes the safe explanation', async () => {
    const wrapper = mountPane(comparison({ afterExists: false, afterRaw: '' }))
    await wrapper.get('.history-pane-menu-trigger').trigger('click')
    const menu = teleportedMenu()!
    expect(menu.textContent).toContain('This version deletes the file')
    expect((menu.querySelector('button.history-pane-menu-disabled') as HTMLButtonElement | null)?.disabled).toBe(true)
  })

  it('disables Restore while Create Version owns the document mutation lock', async () => {
    const wrapper = mountPane(comparison({ status: 'ready', diff: comparison().diff }))
    await wrapper.setProps({ mutationLocked: true })
    await wrapper.get('.history-pane-menu-trigger').trigger('click')
    const menuItem = teleportedMenu()!.querySelectorAll('button')[1]!
    expect(menuItem.hasAttribute('disabled')).toBe(true)
  })

  it('disables Restore and announces the busy state while restoring', async () => {
    const wrapper = mountPane(comparison())
    await wrapper.setProps({ restoring: true })

    expect(wrapper.get('section').attributes('aria-busy')).toBe('true')
    await wrapper.get('.history-pane-menu-trigger').trigger('click')
    const menuItem = teleportedMenu()!.querySelectorAll('button')[1]!
    expect(menuItem.hasAttribute('disabled')).toBe(true)
  })

  it('renders loading, error, retry, and identical content states inline', async () => {
    const wrapper = mountPane(comparison({ status: 'loading', diff: null }))
    expect(wrapper.get('[role="status"]').text()).toContain('Comparing versions')

    await wrapper.setProps({ comparison: comparison({ status: 'error', diff: null, error: null }) })
    expect(wrapper.get('[role="alert"]').text()).toContain('Failed to load the version comparison')
    await wrapper.get('[role="alert"] button').trigger('click')
    expect(wrapper.emitted('retry')).toEqual([['diff:inbox/redis']])

    await wrapper.setProps({
      comparison: comparison({
        status: 'ready',
        currentDirty: false,
        beforeRaw: '# Same document\n\nContent',
        afterRaw: '# Same document\n\nContent',
        diff: { ops: [], stats: { added: 0, removed: 0, equal: 0 } },
      }),
    })
    expect(wrapper.text()).toContain('Identical')
    expect(wrapper.get('.history-unchanged-notice-icon').text()).toBe('✓')
    expect(wrapper.find('.unchanged-content-stub').text()).toContain('# Same document')
  })

  it('shows an empty state when identical versions are both empty', async () => {
    const wrapper = mountPane(comparison({
      beforeRaw: '',
      afterRaw: '',
      diff: { ops: [], stats: { added: 0, removed: 0, equal: 0 } },
    }))

    expect(wrapper.text()).toContain('Both the historical and current versions are empty')
    expect(wrapper.find('.history-unchanged-notice').exists()).toBe(false)
    expect(wrapper.find('.unchanged-content-stub').exists()).toBe(false)
  })

  it('formats the revision date with the application locale', () => {
    const { setLocale } = useI18n()
    setLocale('zh')
    try {
      const wrapper = mountPane(comparison())
      expect(wrapper.text()).toContain('2026年7月15日')
    } finally {
      setLocale('en')
    }
  })
})

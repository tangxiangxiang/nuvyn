// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import WorkingTreeDiffPane from '../WorkingTreeDiffPane.vue'
import type { WorkingTreeDiff } from '../../../composables/vault/useWorkingTreeDiffs'

const value: WorkingTreeDiff = {
  tabId: 'changes-diff:inbox/agents.md',
  documentPath: 'inbox/agents',
  documentTitle: 'AGENTS',
  statusKind: 'modified',
  diff: {
    ops: [{ op: 'add', oldLine: null, newLine: 1, text: 'new' }],
    stats: { added: 1, removed: 0, equal: 0 },
  },
  status: 'ready',
  error: null,
}

describe('WorkingTreeDiffPane', () => {
  it('renders HEAD to working tree without historical actions', () => {
    const wrapper = mount(WorkingTreeDiffPane, {
      props: { diff: value },
      global: {
        stubs: {
          HistoryUnifiedDiff: {
            template: '<div class="diff-stub" />',
          },
        },
      },
    })
    expect(wrapper.text()).toContain('HEAD')
    expect(wrapper.text()).toContain('Working tree')
    expect(wrapper.find('.history-pane-menu-trigger').exists()).toBe(false)
    expect(wrapper.find('.diff-stub').exists()).toBe(true)
  })

  it('shows an inline error and retry action', async () => {
    const wrapper = mount(WorkingTreeDiffPane, {
      props: { diff: { ...value, status: 'error', diff: null, error: 'failed' } },
    })
    await wrapper.get('[role="alert"] button').trigger('click')
    expect(wrapper.emitted('retry')).toEqual([['changes-diff:inbox/agents.md']])
  })
})

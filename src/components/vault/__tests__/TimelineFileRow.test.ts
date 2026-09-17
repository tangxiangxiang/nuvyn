// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import TimelineFileRow from '../TimelineFileRow.vue'
import type { HistoryFileItem } from '../../../composables/vault/useHistoryTimeline'

const file: HistoryFileItem = {
  path: 'inbox/getting-started.md',
  documentPath: 'inbox/getting-started',
  title: 'Getting Started',
  parentPath: 'inbox',
}

function mountRow(props: Partial<{ selected: boolean; showParent: boolean }> = {}) {
  return mount(TimelineFileRow, {
    props: {
      file,
      ...props,
    },
  })
}

describe('TimelineFileRow', () => {
  it('preserves the treeitem button contract and renders the file icon', () => {
    const wrapper = mountRow()
    const row = wrapper.get('.history-file-row')

    expect(row.element.tagName).toBe('BUTTON')
    expect(row.attributes()).toMatchObject({
      type: 'button',
      role: 'treeitem',
      'aria-level': '3',
      'aria-selected': 'false',
      title: 'inbox/getting-started.md',
    })
    expect(wrapper.find('.history-file-icon svg').exists()).toBe(true)
    expect(wrapper.get('.history-file-title').text()).toBe('Getting Started')
    expect(wrapper.find('.history-file-path').exists()).toBe(false)
  })

  it('renders the parent path only when requested and reflects selection', async () => {
    const wrapper = mountRow({ selected: true, showParent: true })

    expect(wrapper.get('.history-file-row').classes()).toContain('active')
    expect(wrapper.get('.history-file-row').attributes('aria-selected')).toBe('true')
    expect(wrapper.get('.history-file-path').text()).toBe('inbox/')

    await wrapper.get('.history-file-row').trigger('click')
    await wrapper.get('.history-file-row').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('select')).toHaveLength(2)
  })
})

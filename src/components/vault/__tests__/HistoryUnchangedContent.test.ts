// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import HistoryUnchangedContent from '../HistoryUnchangedContent.vue'

describe('HistoryUnchangedContent', () => {
  it('renders the source once with matching gutters and preserves blank lines', () => {
    const wrapper = mount(HistoryUnchangedContent, {
      props: {
        raw: '# Same document\n\nContent',
        comparisonKey: 'diff:notes\\0revision-a',
      },
    })

    expect(wrapper.findAll('.history-unchanged-line')).toHaveLength(3)
    expect(wrapper.findAll('.history-unchanged-gutter.history-unchanged-old').map((node) => node.attributes('data-line'))).toEqual(['1', '2', '3'])
    expect(wrapper.findAll('.history-unchanged-gutter.history-unchanged-new').map((node) => node.attributes('data-line'))).toEqual(['1', '2', '3'])
    expect(wrapper.findAll('.history-unchanged-marker').map((node) => node.attributes('data-marker'))).toEqual(['', '', ''])
    expect(wrapper.findAll('.history-unchanged-line-content').map((node) => node.text())).toEqual([
      '# Same document',
      '',
      'Content',
    ])
    expect(wrapper.findAll('.history-unchanged-line-content')).toHaveLength(3)
    expect(wrapper.findAll('code')).toHaveLength(0)
    expect(wrapper.findAll('[role="row"]')).toHaveLength(0)
    expect(wrapper.get('.history-unchanged-content').attributes()).toMatchObject({
      role: 'region',
      'aria-label': 'Unchanged Markdown source document',
      tabindex: '0',
    })
  })

  it('reuses the unified diff row and content classes without code-pill semantics', () => {
    const wrapper = mount(HistoryUnchangedContent, {
      props: { raw: 'same', comparisonKey: 'a' },
    })

    expect(wrapper.get('.history-unchanged-line').classes()).toEqual(expect.arrayContaining([
      'unified-diff-line',
      'is-equal',
    ]))
    expect(wrapper.get('.history-unchanged-line-content').classes()).toEqual(expect.arrayContaining([
      'unified-diff-content',
    ]))
    expect(wrapper.findAll('.history-unchanged-gutter[aria-hidden="true"]')).toHaveLength(2)
  })
})

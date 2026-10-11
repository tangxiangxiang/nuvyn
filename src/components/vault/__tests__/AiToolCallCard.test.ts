// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AiToolCallCard from '../AiToolCallCard.vue'
import type { ToolCallRecord } from '../../../lib/ai-api'
import { useI18n } from '../../../composables/useI18n'

function call(patch: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: 'tool-1',
    name: 'read_file',
    input: { path: 'archive/example' },
    result: { content: 'x'.repeat(240), is_error: false },
    ...patch,
  }
}

describe('AiToolCallCard', () => {
  beforeEach(() => useI18n().setLocale('en'))
  afterEach(() => useI18n().setLocale('zh'))

  it.each([
    ['zh', '展开', '收起', '240 字符', '成功', '3 项', '失败'],
    ['en', 'Expand', 'Collapse', '240 chars', 'ok', '3 items', 'error'],
  ] as const)('localizes all presentation text in %s', async (locale, expand, collapse, chars, success, items, failure) => {
    useI18n().setLocale(locale)
    const wrapper = mount(AiToolCallCard, { props: { call: call() } })
    expect(wrapper.get('.ai-tool-toggle').text()).toBe(expand)
    expect(wrapper.get('.ai-tool-summary').text()).toContain(chars)
    expect(wrapper.get('.ai-tool-pill').attributes('aria-label')).toBe(success)
    await wrapper.get('.ai-tool-toggle').trigger('click')
    expect(wrapper.get('.ai-tool-toggle').text()).toBe(collapse)
    await wrapper.setProps({ call: call({ name: 'list_files', result: { content: 'a\nb\nc', is_error: false } }) })
    expect(wrapper.get('.ai-tool-summary').text()).toContain(items)
    await wrapper.setProps({ call: call({ result: { content: '', is_error: true } }) })
    expect(wrapper.get('.ai-tool-summary').text()).toContain(failure)
    expect(wrapper.get('.ai-tool-pill').attributes('aria-label')).toBe(failure)
    wrapper.unmount()
  })

  it('distinguishes an empty completed result from an optimistic pending result', async () => {
    const wrapper = mount(AiToolCallCard, { props: { call: call({ result: { content: '', is_error: false, pending: true } }) } })
    expect(wrapper.get('.ai-tool-pill').classes()).toContain('ai-tool-pill-pending')
    expect(wrapper.get('.ai-tool-summary').text()).toContain('Reading document…')
    await wrapper.setProps({ call: call({ result: { content: '', is_error: false } }) })
    expect(wrapper.get('.ai-tool-pill').classes()).toContain('ai-tool-pill-ok')
    expect(wrapper.get('.ai-tool-summary').text()).toContain('0 chars')
    wrapper.unmount()
  })
  it('summarizes and expands long read results locally', async () => {
    const wrapper = mount(AiToolCallCard, { props: { call: call() } })

    expect(wrapper.get('.ai-tool-summary').text()).toBe('archive/example · 240 chars')
    expect(wrapper.findAll('.ai-tool-result')).toHaveLength(0)
    expect(wrapper.get('.ai-tool-card').classes()).not.toContain('ai-tool-expanded')

    await wrapper.get('.ai-tool-toggle').trigger('click')
    expect(wrapper.findAll('.ai-tool-result')).toHaveLength(1)
    expect(wrapper.get('code').text()).toHaveLength(240)
    expect(wrapper.get('.ai-tool-toggle').attributes('aria-expanded')).toBe('true')

    await wrapper.get('.ai-tool-toggle').trigger('click')
    expect(wrapper.findAll('.ai-tool-result')).toHaveLength(0)
  })

  it('shows list counts and error state without leaking presentation logic to AiPanel', () => {
    const list = mount(AiToolCallCard, {
      props: { call: call({ name: 'list_files', input: { scope: 'inbox' }, result: { content: 'a\nb\nc', is_error: false } }) },
    })
    expect(list.get('.ai-tool-summary').text()).toBe('inbox · 3 items')

    const error = mount(AiToolCallCard, {
      props: { call: call({ name: 'delete_file', result: { content: 'not found', is_error: true } }) },
    })
    expect(error.get('.ai-tool-card').classes()).toContain('ai-tool-error')
    expect(error.get('.ai-tool-pill').attributes('aria-label')).toBe('error')
    expect(error.get('.ai-tool-pill').classes()).toContain('ai-tool-pill-error')
    expect(error.find('.ai-tool-toggle').exists()).toBe(false)
  })

  it('never collapses a failed read result', () => {
    const wrapper = mount(AiToolCallCard, {
      props: { call: call({ result: { content: 'Access denied', is_error: true } }) },
    })
    expect(wrapper.get('.ai-tool-result').text()).toContain('Access denied')
    expect(wrapper.find('.ai-tool-toggle').exists()).toBe(false)
  })
})

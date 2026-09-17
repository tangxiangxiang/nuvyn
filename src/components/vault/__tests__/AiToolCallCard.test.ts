// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AiToolCallCard from '../AiToolCallCard.vue'
import type { ToolCallRecord } from '../../../lib/ai-api'

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
})

// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import AiToolActivity from '../AiToolActivity.vue'
import type { ToolCallRecord } from '../../../lib/ai-api'
import { useI18n } from '../../../composables/useI18n'

function call(id: string, name: string, content = 'ok', isError = false): ToolCallRecord {
  return { id, name, input: { path: `inbox/${id}` }, result: { content, is_error: isError } }
}

describe('AiToolActivity', () => {
  beforeEach(() => useI18n().setLocale('en'))
  afterEach(() => useI18n().setLocale('zh'))

  it('groups successful reads and directory lookups under a closed summary', () => {
    const wrapper = mount(AiToolActivity, { props: { calls: [
      call('one', 'read_file'), call('two', 'list_files'), call('three', 'list_files'),
    ] } })
    expect(wrapper.get('summary').text()).toBe('Documents viewed: 1 · Directory lookups completed: 2')
    expect(wrapper.get('details').attributes('open')).toBeUndefined()
    expect(wrapper.findAll('details .ai-tool-card')).toHaveLength(3)
    expect(wrapper.findAll('.ai-tool-activity > .ai-tool-card')).toHaveLength(0)
  })

  it('keeps mutations, unknown tools, pending calls and failed read results visible', () => {
    const wrapper = mount(AiToolActivity, { props: { calls: [
      call('read', 'read_file'), call('write', 'patch_file'), call('unknown', 'future_tool'),
      { ...call('pending', 'list_files', ''), result: { content: '', is_error: false, pending: true } }, call('failed', 'read_file', 'Access denied', true),
    ] } })
    expect(wrapper.findAll('.ai-tool-activity > .ai-tool-card')).toHaveLength(4)
    expect(wrapper.get('.ai-tool-activity > .ai-tool-error .ai-tool-result').text()).toContain('Access denied')
    expect(wrapper.findAll('details .ai-tool-card')).toHaveLength(1)
  })

  it('counts unique documents and moves only successful completed reads into the group', async () => {
    const pending = { ...call('one', 'read_file', ''), result: { content: '', is_error: false, pending: true } }
    const wrapper = mount(AiToolActivity, { props: { calls: [pending] } })
    expect(wrapper.find('details').exists()).toBe(false)
    const completed = call('one', 'read_file')
    await wrapper.setProps({ calls: [completed, { ...completed, id: 'again', input: { path: 'inbox/one.md' } }] })
    expect(wrapper.get('summary').text()).toBe('Documents viewed: 1')
    expect(wrapper.findAll('.ai-tool-activity > .ai-tool-card')).toHaveLength(0)
  })

  it('groups empty historical successes while keeping every mutation and empty failure visible', () => {
    const wrapper = mount(AiToolActivity, { props: { calls: [
      call('empty-read', 'read_file', ''), call('empty-list', 'list_files', ''),
      ...['create_file', 'write_file', 'patch_file', 'delete_file', 'rename_file'].map(name => call(name, name, '')),
      call('failure', 'read_file', '', true),
    ] } })
    expect(wrapper.findAll('details .ai-tool-card')).toHaveLength(2)
    expect(wrapper.findAll('.ai-tool-activity > .ai-tool-card')).toHaveLength(6)
    expect(wrapper.findAll('.ai-tool-pill-pending')).toHaveLength(0)
    expect(wrapper.findAll('.ai-tool-pill-error')).toHaveLength(1)
    wrapper.unmount()
  })
})

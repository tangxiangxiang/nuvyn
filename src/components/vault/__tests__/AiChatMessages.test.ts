// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AiChatMessages from '../AiChatMessages.vue'
import { useI18n } from '../../../composables/useI18n'

describe('AiChatMessages', () => {
  beforeEach(() => useI18n().setLocale('en'))
  afterEach(() => useI18n().setLocale('zh'))
  it('renders the contextual empty state and emits a selected quick prompt', async () => {
    const wrapper = mount(AiChatMessages, {
      props: {
        messages: [],
        currentPath: 'archive/example.md',
        quickPrompts: [{ label: 'Summarize', text: 'Summarize this note' }],
      },
    })

    expect(wrapper.text()).toContain('Ask about current note')
    expect(wrapper.text()).toContain('archive/example.md')
    await wrapper.get('.ai-quick-prompt').trigger('click')
    expect(wrapper.emitted('prompt')).toEqual([['Summarize this note']])
  })

  it('renders user and assistant messages with tool calls', () => {
    const wrapper = mount(AiChatMessages, {
      props: {
        currentPath: null,
        quickPrompts: [],
        messages: [
          { id: 1, sessionId: 1, role: 'user', content: 'hello', createdAt: 1 },
          {
            id: 2,
            sessionId: 1,
            role: 'assistant',
            content: 'done',
            createdAt: 2,
            blocks: {
              v: 1,
              text: 'done',
              toolCalls: [{
                id: 'tool-1',
                name: 'read_file',
                input: { path: 'archive/example.md' },
                result: { content: 'body', is_error: false },
              }],
            },
          },
        ],
      },
    })

    expect(wrapper.findAll('.ai-message')).toHaveLength(2)
    expect(wrapper.get('.ai-message.user').text()).toContain('hello')
    expect(wrapper.get('.ai-message.assistant').text()).toContain('done')
    expect(wrapper.get('.ai-tool-card').text()).toContain('read_file')
  })

  it('renders assistant Markdown while keeping user content as text', () => {
    const wrapper = mount(AiChatMessages, {
      props: {
        currentPath: null,
        quickPrompts: [],
        messages: [
          { id: 1, sessionId: 1, role: 'user', content: '**question**', createdAt: 1 },
          { id: 2, sessionId: 1, role: 'assistant', content: '## Core\n\n**bold**\n\n- item', createdAt: 2 },
        ],
      },
    })

    expect(wrapper.get('.ai-message.user .ai-text').text()).toBe('**question**')
    expect(wrapper.get('.ai-markdown h2').text()).toBe('Core')
    expect(wrapper.get('.ai-markdown strong').text()).toBe('bold')
    expect(wrapper.get('.ai-markdown li').text()).toBe('item')
  })

  it('keeps streaming assistant content as text and renders completed/error content as Markdown', () => {
    const wrapper = mount(AiChatMessages, {
      props: {
        currentPath: null,
        quickPrompts: [],
        messages: [
          { id: 0, sessionId: 1, role: 'assistant', content: '**streaming**', createdAt: 1 },
          { id: -1, sessionId: 1, role: 'assistant', content: '**error**', createdAt: 2 },
          { id: 3, sessionId: 1, role: 'assistant', content: '**done**', createdAt: 3 },
        ],
      },
    })
    expect(wrapper.findAll('.ai-markdown')).toHaveLength(2)
    expect(wrapper.get('.ai-message.assistant .ai-streaming-text').text()).toBe('**streaming**')
    expect(wrapper.find('.ai-message.assistant:nth-child(2) strong').text()).toBe('error')
  })
})

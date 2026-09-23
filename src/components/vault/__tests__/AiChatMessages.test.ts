// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Message } from '../../../lib/ai-api'
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

    expect(wrapper.text()).toContain('I can answer questions about the current note.')
    expect(wrapper.text()).not.toContain('archive/example.md')
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
    expect(wrapper.findAll('.ai-message.assistant')[1].get('strong').text()).toBe('error')
  })
})

function mountMessages(
  messages: Message[] = [],
  currentPath: string | null = 'archive/nuvyn-deployment-guide',
) {
  return mount(AiChatMessages, {
    props: {
      messages,
      currentPath,
      quickPrompts: [
        { label: '总结', text: '总结当前笔记' },
        { label: '找相关', text: '找相关笔记' },
        { label: '提出整理建议', text: '整理当前笔记' },
      ],
    },
  })
}

describe('AiChatMessages empty presentation', () => {
  beforeEach(() => useI18n().setLocale('zh'))
  afterEach(() => useI18n().setLocale('zh'))

  it('shows lightweight suggestions and a quiet hint without duplicating the header context', () => {
    const wrapper = mountMessages()
    const emptyChat = wrapper.get('.ai-empty-chat')
    const children = Array.from(emptyChat.element.children)

    expect(wrapper.get('.ai-suggestion-heading').text()).toBe('可以试试')
    expect(wrapper.find('.ai-quick-prompts').exists()).toBe(true)
    expect(wrapper.findAll('.ai-quick-prompt')).toHaveLength(3)
    expect(wrapper.get('.ai-empty-hint').text()).toBe('我可以基于当前笔记回答问题。')
    expect(wrapper.find('.ai-context-block').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('archive/nuvyn-deployment-guide')
    expect(children.map((child) => child.className)).toEqual([
      'ai-suggestion-heading',
      'ai-quick-prompts',
      'ai-empty-hint',
    ])
  })

  it('uses workspace copy when no note is selected', () => {
    const wrapper = mountMessages([], null)

    expect(wrapper.find('.ai-quick-prompts').exists()).toBe(true)
    expect(wrapper.get('.ai-empty-hint').text()).toBe('我可以基于当前工作区回答问题。')
  })

  it('hides the empty presentation once messages exist', () => {
    const message: Message = {
      id: 1,
      sessionId: 1,
      role: 'user',
      content: 'hello',
      createdAt: 1,
    }
    const wrapper = mountMessages([message])

    expect(wrapper.find('.ai-empty-chat').exists()).toBe(false)
    expect(wrapper.find('.ai-quick-prompts').exists()).toBe(false)
    expect(wrapper.find('.ai-empty-hint').exists()).toBe(false)
    expect(wrapper.find('.ai-context-block').exists()).toBe(false)
    expect(wrapper.get('.ai-message').text()).toBe('hello')
    expect(wrapper.classes()).toContain('has-messages')
  })

  it('emits the selected quick prompt without sending it', async () => {
    const wrapper = mountMessages()

    await wrapper.get('.ai-quick-prompt').trigger('click')

    expect(wrapper.emitted('prompt')).toEqual([['总结当前笔记']])
  })
})

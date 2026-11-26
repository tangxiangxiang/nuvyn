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

    expect(wrapper.text()).toContain('I can help using the current note and knowledge base.')
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
    expect(wrapper.find('.ai-avatar').exists()).toBe(false)
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

  it('renders streaming assistant content as Markdown and renders completed/error content consistently', async () => {
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
    expect(wrapper.findAll('.ai-markdown')).toHaveLength(3)
    expect(wrapper.find('.ai-streaming-text').exists()).toBe(false)
    if (typeof requestAnimationFrame === 'undefined') {
      expect(wrapper.get('.ai-message.assistant .ai-markdown strong').text()).toBe('streaming')
    } else {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      expect(wrapper.get('.ai-message.assistant .ai-markdown strong').text()).toBe('streaming')
    }
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

  it('shows the centered welcome, workspace prompts, and hint without exposing the note path', () => {
    const wrapper = mountMessages()
    const emptyChat = wrapper.get('.ai-empty-chat')
    const children = Array.from(emptyChat.element.children)

    expect(wrapper.get('.ai-empty-chat h2').text()).toBe('有什么可以帮你？')
    expect(wrapper.find('.ai-welcome-icon').exists()).toBe(true)
    expect(wrapper.find('.ai-suggestion-heading').exists()).toBe(false)
    expect(wrapper.find('.ai-quick-prompts').exists()).toBe(true)
    expect(wrapper.findAll('.ai-quick-prompt')).toHaveLength(3)
    expect(wrapper.get('.ai-empty-hint').text()).toBe('可以结合当前笔记和知识库提供帮助。')
    expect(wrapper.find('.ai-context-block').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('archive/nuvyn-deployment-guide')
    expect(children[0]?.classList.contains('ai-welcome-icon')).toBe(true)
    expect(children[1]?.tagName).toBe('H2')
    expect(children[2]?.className).toBe('ai-empty-hint')
    expect(children[3]?.className).toBe('ai-quick-prompts')
  })

  it('uses workspace copy when no note is selected', () => {
    const wrapper = mountMessages([], null)

    expect(wrapper.find('.ai-quick-prompts').exists()).toBe(true)
    expect(wrapper.get('.ai-empty-hint').text()).toBe('可以帮助你查找知识和整理笔记。')
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
    expect(wrapper.get('[role=log]').classes()).toContain('has-messages')
  })

  it('emits the selected quick prompt without sending it', async () => {
    const wrapper = mountMessages()

    expect(wrapper.get('.ai-quick-prompt').attributes('title')).toBe('总结当前笔记')
    await wrapper.get('.ai-quick-prompt').trigger('click')

    expect(wrapper.emitted('prompt')).toEqual([['总结当前笔记']])
  })

  it('shows the shared return-to-latest control when the reader scrolls up', async () => {
    const wrapper = mountMessages([{
      id: 1,
      sessionId: 1,
      role: 'assistant',
      content: 'A long answer',
      createdAt: 1,
    }])
    const viewport = wrapper.get('.ai-messages').element
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 400 },
    })
    viewport.scrollTop = 0
    await wrapper.get('.ai-messages').trigger('scroll')
    expect(wrapper.get('.ai-scroll-latest').attributes('aria-label')).toBe('回到最新消息')

    await wrapper.get('.ai-scroll-latest').trigger('click')
    expect(viewport.scrollTop).toBe(400)
    expect(wrapper.find('.ai-scroll-latest').exists()).toBe(false)
  })
})

describe('AI Finance messages', () => {
  it('waits for history before showing the welcome and removes it when streaming begins', async () => {
    const wrapper = mount(AiChatMessages, {
      props: { finance: true, currentPath: null, quickPrompts: [], messages: [], showWelcome: false },
    })
    expect(wrapper.find('.ai-empty-chat').exists()).toBe(false)
    await wrapper.setProps({ showWelcome: true })
    expect(wrapper.find('.ai-empty-chat h2').exists()).toBe(true)
    expect(wrapper.find('.ai-suggestion-heading').exists()).toBe(false)
    await wrapper.setProps({ messages: [{ id: 0, sessionId: 1, role: 'user', content: 'Analyze cash flow', createdAt: 1 }] })
    expect(wrapper.find('.ai-empty-chat').exists()).toBe(false)
    expect(wrapper.find('[data-testid="finance-activity"]').exists()).toBe(false)
  })
})

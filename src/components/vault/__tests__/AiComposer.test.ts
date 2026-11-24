// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AiComposer from '../AiComposer.vue'
import { useI18n } from '../../../composables/useI18n'

function mountComposer(props: Partial<InstanceType<typeof AiComposer>['$props']> = {}) {
  return mount(AiComposer, {
    props: {
      modelValue: '',
      busy: false,
      configured: true,
      ...props,
    } as any,
  })
}

describe('AiComposer', () => {
  beforeEach(() => useI18n().setLocale('en'))
  afterEach(() => useI18n().setLocale('zh'))
  it('owns input updates and Enter/Shift+Enter behavior', async () => {
    const wrapper = mountComposer({ modelValue: 'hello' })
    const input = wrapper.get('textarea')
    expect(input.attributes('placeholder')).toBe('Ask about this document, or describe what you want to do…')

    await input.setValue('updated')
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['updated'])

    await input.trigger('keydown', { key: 'Enter', shiftKey: true })
    expect(wrapper.emitted('send')).toBeUndefined()
    await input.trigger('keydown', { key: 'Enter', shiftKey: false })
    expect(wrapper.emitted('send')).toHaveLength(1)
  })

  it('uses a provider-neutral Chinese input placeholder', () => {
    useI18n().setLocale('zh')
    const wrapper = mountComposer()
    expect(wrapper.get('textarea').attributes('placeholder')).toBe('问问这篇文档，或描述你想做的事…')
  })

  it('switches the primary action from send to stop while busy', async () => {
    const idle = mountComposer({ modelValue: 'hello' })
    await idle.get('.ai-send').trigger('click')
    expect(idle.emitted('send')).toHaveLength(1)

    const busy = mountComposer({ modelValue: '', busy: true })
    expect(busy.get('.ai-send').attributes('aria-label')).toBe('Stop')
    expect(busy.get('.ai-send').attributes('disabled')).toBeUndefined()
    await busy.get('.ai-send').trigger('click')
    expect(busy.emitted('stop')).toHaveLength(1)
  })

  it('shows the current model and disables send without configuration', () => {
    const wrapper = mountComposer({
      modelValue: 'hello',
      configured: false,
      modelName: 'claude-sonnet-4-6',
    })
    expect(wrapper.get('.ai-mode-badge').text()).toContain('claude-sonnet-4-6')
    expect(wrapper.get('.ai-send').attributes('disabled')).toBeDefined()
  })

  it('shows the model selector on the left and the send action on the right', () => {
    const wrapper = mountComposer()
    expect(wrapper.find('.ai-toolbar-left > .ai-mode-badge').exists()).toBe(true)
    expect(wrapper.find('.ai-toolbar-left button').attributes('aria-haspopup')).toBe('listbox')
    expect(wrapper.find('.ai-toolbar-right .ai-send').exists()).toBe(true)
    expect(wrapper.find('.ai-tool-button, .ai-context-chip, .ai-context-picker').exists()).toBe(false)
  })

  it('groups configured models and emits a selection without changing the draft', async () => {
    const models = [
      { profileId: 'anthropic-profile', name: 'Claude profile', provider: 'anthropic' as const, model: 'claude-sonnet' },
      { profileId: 'openai-profile', name: 'MiniMax profile', provider: 'openai' as const, model: 'MiniMax-M3.1-Flash' },
    ]
    const wrapper = mountComposer({
      modelValue: 'keep this draft',
      modelName: 'claude-sonnet',
      modelOptions: models,
      selectedModelProfileId: 'anthropic-profile',
    })
    await wrapper.get('[data-testid="ai-model-selector"]').trigger('click')
    expect(wrapper.findAll('.ai-model-menu-heading').map(item => item.text())).toEqual(['Anthropic', 'OpenAI compatible'])
    expect(wrapper.get('[role="option"][aria-selected="true"]').text()).toContain('claude-sonnet')

    await wrapper.get('[data-testid="ai-model-option-openai-profile"]').trigger('click')
    expect(wrapper.emitted('select-model')).toEqual([['openai-profile']])
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    expect(wrapper.find('.ai-model-menu').exists()).toBe(false)
    expect(wrapper.find('textarea').element.value).toBe('keep this draft')
  })

  it('keeps model switching disabled for an active agent run', async () => {
    const wrapper = mountComposer({
      busy: true,
      modelOptions: [{ profileId: 'profile', name: 'Profile', provider: 'anthropic', model: 'model-x' }],
    })
    const selector = wrapper.get('[data-testid="ai-model-selector"]')
    expect(selector.attributes('disabled')).toBeDefined()
    await selector.trigger('click')
    expect(wrapper.find('.ai-model-menu').exists()).toBe(false)
  })

  it('disables send when the current Note has no sendable live context', () => {
    const wrapper = mountComposer({ modelValue: 'hello', canSend: false })
    expect(wrapper.get('.ai-send').attributes('disabled')).toBeDefined()
  })

  it.each([
    { modelValue: '   ' },
    { modelValue: 'hello', configured: false },
    { modelValue: 'hello', canSend: false },
    { modelValue: 'hello', busy: true },
  ])('does not send blocked messages through Enter or form submission: %j', async props => {
    const wrapper = mountComposer(props)
    await wrapper.get('textarea').trigger('keydown', { key: 'Enter' })
    await wrapper.get('form').trigger('submit')
    expect(wrapper.emitted('send')).toBeUndefined()
    expect(wrapper.emitted('stop')).toBeUndefined()
  })

  it('selects a slash template with the keyboard without sending', async () => {
    const wrapper = mountComposer({ modelValue: '/', prompts: [
      { label: 'Summarize', text: 'Summarize this note' },
      { label: 'Related', text: 'Find related notes' },
    ] })
    const input = wrapper.get('textarea')
    await input.trigger('focus')
    expect(wrapper.findAll('[role="option"]')).toHaveLength(2)
    await input.trigger('keydown', { key: 'ArrowDown' })
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['Find related notes'])
    expect(wrapper.emitted('send')).toBeUndefined()
  })

  it('filters templates, supports click and Escape, and leaves paths alone', async () => {
    const wrapper = mountComposer({ modelValue: '/sum', prompts: [
      { label: 'Summarize', text: 'Summarize this note' },
      { label: 'Related', text: 'Find related notes' },
    ] })
    const input = wrapper.get('textarea')
    await input.trigger('focus')
    expect(wrapper.findAll('[role="option"]')).toHaveLength(1)
    await wrapper.get('[role="option"]').trigger('click')
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['Summarize this note'])
    await wrapper.setProps({ modelValue: '/' })
    await input.trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false)
    await wrapper.setProps({ modelValue: '/inbox/test.md' })
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false)
  })

  it('does not send an unmatched slash query on Enter', async () => {
    const wrapper = mountComposer({ modelValue: '/missing', prompts: [{ label: 'Summarize', text: 'Summary' }] })
    await wrapper.get('textarea').trigger('focus')
    await wrapper.get('textarea').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')).toBeUndefined()
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('handles Ledger commands through Enter and menu click without changing the ordinary prompt behavior', async () => {
    const wrapper = mountComposer({ modelValue: ' /compact ', commands: [
      { command: 'compact', label: 'Compact conversation' },
      { command: 'clear', label: 'Clear conversation' },
    ] })
    const input = wrapper.get('textarea')
    await input.trigger('focus')
    expect(wrapper.get('[role="option"]').text()).toContain('/compact')
    await input.trigger('keydown', { key: 'Enter', isComposing: true })
    await input.trigger('keydown', { key: 'Enter', shiftKey: true })
    expect(wrapper.emitted('send')).toBeUndefined()
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')).toHaveLength(1)

    await wrapper.setProps({ modelValue: '/' })
    const clear = wrapper.findAll('[role="option"]')[1]
    await clear.trigger('click')
    expect(wrapper.emitted('command')).toEqual([['clear']])
    await wrapper.setProps({ busy: true, modelValue: '/clear' })
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.get('[role="option"]').attributes('disabled')).toBeDefined()
    expect(wrapper.emitted('send')).toHaveLength(1)
  })

  it('does not send when Enter confirms an IME composition', async () => {
    const wrapper = mountComposer({ modelValue: '你好' })
    await wrapper.get('textarea').trigger('keydown', { key: 'Enter', isComposing: true })
    await wrapper.get('textarea').trigger('keydown', { key: 'Enter', keyCode: 229 })
    expect(wrapper.emitted('send')).toBeUndefined()
  })
})

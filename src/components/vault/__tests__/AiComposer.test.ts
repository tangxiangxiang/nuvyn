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
    expect(input.attributes('placeholder')).toBe('Type a message… · Enter to send · Shift+Enter for newline')

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
    expect(wrapper.get('textarea').attributes('placeholder')).toBe('输入消息… · Enter 发送 · Shift+Enter 换行')
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

  it('shows the composer mode and disables send without configuration', () => {
    const wrapper = mountComposer({
      modelValue: 'hello',
      configured: false,
    })
    expect(wrapper.get('.ai-mode-badge').text()).toContain('Auto')
    expect(wrapper.get('.ai-send').attributes('disabled')).toBeDefined()
  })

  it('keeps the decorative add control on the left side of the toolbar', () => {
    const wrapper = mountComposer()
    expect(wrapper.find('.ai-toolbar-left > .ai-tool-button').exists()).toBe(true)
    expect(wrapper.find('.ai-toolbar-right > .ai-tool-button').exists()).toBe(false)
  })

  it('emits context actions from the add and remove controls', async () => {
    const wrapper = mountComposer({
      contextPaths: ['notes/reference'],
      canAddContext: true,
    })
    await wrapper.get('.ai-tool-button').trigger('click')
    expect(wrapper.emitted('toggle-context-picker')).toHaveLength(1)

    await wrapper.get('.ai-context-chip-remove').trigger('click')
    expect(wrapper.emitted('remove-context')).toEqual([['notes/reference']])
  })
})

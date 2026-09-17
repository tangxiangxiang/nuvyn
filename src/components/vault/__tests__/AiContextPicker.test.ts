// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AiContextPicker from '../AiContextPicker.vue'
import { useI18n } from '../../../composables/useI18n'

describe('AiContextPicker', () => {
  beforeEach(() => useI18n().setLocale('en'))
  afterEach(() => useI18n().setLocale('zh'))

  it('filters document paths and emits a selected path', async () => {
    const wrapper = mount(AiContextPicker, {
      props: { paths: ['archive/one', 'inbox/two', 'inbox/three'] },
    })

    await wrapper.get('input[type="search"]').setValue('inbox')
    expect(wrapper.findAll('.ai-context-option')).toHaveLength(2)
    await wrapper.findAll('.ai-context-option')[0].trigger('click')
    expect(wrapper.emitted('select')).toEqual([['inbox/two']])
  })

  it('emits close from the close button and Escape', async () => {
    const wrapper = mount(AiContextPicker, { props: { paths: [] } })
    await wrapper.get('.ai-context-picker-close').trigger('click')
    await wrapper.trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('close')).toHaveLength(2)
  })
})

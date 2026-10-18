// @vitest-environment jsdom
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { NButton, NRadioGroup } from 'naive-ui'
import DocumentExportDialog from '../DocumentExportDialog.vue'
import { useI18n } from '../../../composables/useI18n'

enableAutoUnmount(afterEach)
afterEach(() => {
  document.body.innerHTML = ''
  useI18n().setLocale('zh')
})

describe('DocumentExportDialog', () => {
  it.each(['zh', 'en'] as const)('offers only Markdown and PDF with attachment limits in %s', async (locale) => {
    useI18n().setLocale(locale)
    const wrapper = mount(DocumentExportDialog, { props: { show: true, busy: false }, attachTo: document.body })
    await flushPromises()
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.querySelector('[role="radiogroup"]')).not.toBeNull()
    expect(dialog.querySelectorAll('input[type="radio"]')).toHaveLength(2)
    expect(dialog.textContent).toContain(locale === 'zh' ? '图片、附件和其他引用文件不会被打包。' : 'Images, attachments and other referenced files are not bundled.')
    expect(dialog.textContent).not.toContain('HTML')
    const submit = wrapper.findAllComponents(NButton).find((button) => button.props('type') === 'primary')!
    await submit.trigger('click')
    expect(wrapper.emitted('export')).toEqual([['markdown']])
  })

  it('selects PDF, resets on reopening and disables submission while busy', async () => {
    const wrapper = mount(DocumentExportDialog, { props: { show: true, busy: false }, attachTo: document.body })
    await flushPromises()
    wrapper.getComponent(NRadioGroup).vm.$emit('update:value', 'pdf')
    await wrapper.vm.$nextTick()
    const submit = wrapper.findAllComponents(NButton).find((button) => button.props('type') === 'primary')!
    await submit.trigger('click')
    expect(wrapper.emitted('export')).toEqual([['pdf']])
    await wrapper.setProps({ show: false })
    await wrapper.setProps({ show: true, busy: true })
    expect(wrapper.getComponent(NRadioGroup).props('value')).toBe('markdown')
    expect(wrapper.getComponent(NRadioGroup).props('disabled')).toBe(true)
    expect(submit.props('disabled')).toBe(true)
    await submit.trigger('click')
    expect(wrapper.emitted('export')).toHaveLength(1)
  })
})

// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import DiaryBulletEditor from '../DiaryBulletEditor.vue'

describe('DiaryBulletEditor', () => {
  it('splits at the caret on Enter and preserves entry order', async () => {
    const wrapper = mount(DiaryBulletEditor, { props: { entries: ['前后'] } })
    const textarea = wrapper.get('textarea')
    ;(textarea.element as HTMLTextAreaElement).setSelectionRange(1, 1)

    await textarea.trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('update:entries')?.at(-1)?.[0]).toEqual(['前', '后'])
  })

  it('keeps Shift+Enter inside an entry and accepts multiline pasted text', async () => {
    const wrapper = mount(DiaryBulletEditor, { props: { entries: ['第一行'] } })
    const textarea = wrapper.get('textarea')
    const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true })
    textarea.element.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(wrapper.emitted('update:entries')).toBeUndefined()

    ;(textarea.element as HTMLTextAreaElement).value = '粘贴第一行\n粘贴第二行'
    await textarea.trigger('input')
    expect(wrapper.emitted('update:entries')?.at(-1)?.[0]).toEqual(['粘贴第一行\n粘贴第二行'])
  })

  it('does not split an IME composition Enter and removes only an empty row on Backspace', async () => {
    const wrapper = mount(DiaryBulletEditor, { props: { entries: ['保留', ''] } })
    await wrapper.get('textarea').trigger('compositionstart')
    await wrapper.get('textarea').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('update:entries')).toBeUndefined()
    await wrapper.get('textarea').trigger('compositionend')

    const empty = wrapper.findAll('textarea')[1]!
    await empty.trigger('keydown', { key: 'Backspace' })
    expect(wrapper.emitted('update:entries')?.at(-1)?.[0]).toEqual(['保留'])
  })

  it('does not delete a non-empty row with Backspace', async () => {
    const wrapper = mount(DiaryBulletEditor, { props: { entries: ['保留'] } })
    const event = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })
    wrapper.get('textarea').element.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(wrapper.emitted('update:entries')).toBeUndefined()
  })

  it('adds an empty row and exposes an independent delete action', async () => {
    const wrapper = mount(DiaryBulletEditor, { props: { entries: ['保留', '删除我'] } })
    await wrapper.get('[data-testid="diary-add-entry"]').trigger('click')
    const addedEntries = ['保留', '删除我', '']
    expect(wrapper.emitted('update:entries')?.[0]?.[0]).toEqual(addedEntries)
    await wrapper.setProps({ entries: addedEntries })
    await wrapper.get('[aria-label="删除第 2 条日记"]').trigger('click')
    expect(wrapper.emitted('update:entries')?.at(-1)?.[0]).toEqual(['保留', ''])
  })
})

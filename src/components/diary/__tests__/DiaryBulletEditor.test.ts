// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import DiaryBulletEditor from '../DiaryBulletEditor.vue'

function keydown(target: HTMLTextAreaElement, init: KeyboardEventInit) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

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

    ;(textarea.element as HTMLTextAreaElement).value = '第一行\n第二行'
    await textarea.trigger('input')
    expect(wrapper.emitted('update:entries')?.at(-1)?.[0]).toEqual(['第一行\n第二行'])

    ;(textarea.element as HTMLTextAreaElement).value = '粘贴第一行\n粘贴第二行'
    await textarea.trigger('input')
    expect(wrapper.emitted('update:entries')?.at(-1)?.[0]).toEqual(['粘贴第一行\n粘贴第二行'])
  })

  it('does not split Enter or remove an entry while composition is active', async () => {
    const wrapper = mount(DiaryBulletEditor, { props: { entries: ['保留', ''] } })
    const empty = wrapper.findAll('textarea')[1]!.element as HTMLTextAreaElement
    empty.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    const enter = keydown(empty, { key: 'Enter' })
    const backspace = keydown(empty, { key: 'Backspace' })
    expect(wrapper.emitted('update:entries')).toBeUndefined()
    expect(enter.defaultPrevented).toBe(false)
    expect(backspace.defaultPrevented).toBe(false)
    empty.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))

    keydown(empty, { key: 'Backspace' })
    expect(wrapper.emitted('update:entries')?.at(-1)?.[0]).toEqual(['保留'])
  })

  it('does not run entry shortcuts for composing or legacy 229 keyboard events', () => {
    const wrapper = mount(DiaryBulletEditor, { props: { entries: ['保留', ''] } })
    const empty = wrapper.findAll('textarea')[1]!.element as HTMLTextAreaElement

    const composing = keydown(empty, { key: 'Backspace', isComposing: true })
    const legacyIme = keydown(empty, { key: 'Backspace', keyCode: 229, which: 229 })

    expect(composing.defaultPrevented).toBe(false)
    expect(legacyIme.defaultPrevented).toBe(false)
    expect(wrapper.emitted('update:entries')).toBeUndefined()
  })

  it('clears stale composition state when focus moves to another entry', () => {
    const wrapper = mount(DiaryBulletEditor, { props: { entries: ['输入中', ''] } })
    const [first, second] = wrapper.findAll('textarea').map(input => input.element as HTMLTextAreaElement)
    first.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    second.focus()

    const backspace = keydown(second, { key: 'Backspace' })

    expect(backspace.defaultPrevented).toBe(true)
    expect(wrapper.emitted('update:entries')?.at(-1)?.[0]).toEqual(['输入中'])
  })

  it('does not delete a non-empty row with Backspace', async () => {
    const wrapper = mount(DiaryBulletEditor, { props: { entries: ['保留'] } })
    const event = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })
    wrapper.get('textarea').element.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(wrapper.emitted('update:entries')).toBeUndefined()
  })

  it('deletes a middle empty entry without changing the order of its neighbors', () => {
    const wrapper = mount(DiaryBulletEditor, { props: { entries: ['第一条', '', '第三条'] } })
    const middle = wrapper.findAll('textarea')[1]!.element as HTMLTextAreaElement
    middle.focus()

    keydown(middle, { key: 'Backspace' })

    expect(wrapper.emitted('update:entries')?.at(-1)?.[0]).toEqual(['第一条', '第三条'])
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

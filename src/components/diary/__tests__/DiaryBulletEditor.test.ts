// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, nextTick, ref } from 'vue'
import DiaryBulletEditor from '../DiaryBulletEditor.vue'
import DiaryActionMenu from '../DiaryActionMenu.vue'

function keydown(target: HTMLTextAreaElement, init: KeyboardEventInit) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

function mountControlled(entries: string[]) {
  const content = ref({ entries, entryIds: entries.map(() => crypto.randomUUID()) })
  const wrapper = mount(defineComponent({
    components: { DiaryBulletEditor },
    setup: () => ({ content }),
    template: '<DiaryBulletEditor v-bind="content" @update:content="content = $event" />',
  }), { attachTo: document.body })
  return { wrapper, content }
}

describe('DiaryBulletEditor', () => {
  it('numbers entries rather than lines and supports the hundredth entry', async () => {
    const wrapper = mount(DiaryBulletEditor, { props: { entries: ['第一行\n第二行'] } })
    const numbers = () => wrapper.findAll('.diary-bullet-number').map(node => node.text())
    expect(numbers()).toEqual(['01'])
    await wrapper.setProps({ entries: Array.from({ length: 100 }, (_, index) => `条目 ${index + 1}`) })
    expect(numbers()).toHaveLength(100)
    expect(numbers().slice(0, 3)).toEqual(['01', '02', '03'])
    expect(numbers().at(-1)).toBe('100')
  })

  it.each([0, 1, 2])('focuses the surviving textarea after deleting row %i', async index => {
    const { wrapper, content } = mountControlled(['第一条', '第二条', '第三条'])
    try {
      const targetIndex = Math.max(0, index - 1)
      const survivingTextarea = wrapper.findAll('textarea')[index === 0 ? 1 : targetIndex]!.element
      const expectedIds = content.value.entryIds.filter((_, i) => i !== index)
      const menu = wrapper.findAllComponents(DiaryActionMenu)[index]!
      menu.get('button').element.focus()
      menu.vm.$emit('select', 'remove')
      await nextTick()

      expect(content.value.entryIds).toEqual(expectedIds)
      expect(wrapper.findAll('.diary-bullet-number').map(node => node.text())).toEqual(['01', '02'])
      expect(wrapper.findAll('textarea')[targetIndex]!.element).toBe(survivingTextarea)
      expect(document.activeElement).toBe(survivingTextarea)
    } finally { wrapper.unmount() }
  })

  it('focuses added and split entries and preserves the empty textarea when typing begins', async () => {
    const { wrapper, content } = mountControlled([])
    try {
      const empty = wrapper.get('textarea').element
      wrapper.getComponent(DiaryBulletEditor).vm.addEntry()
      await nextTick()
      expect(document.activeElement).toBe(empty)
      const firstId = content.value.entryIds[0]
      await wrapper.get('textarea').setValue('前后')
      expect(document.activeElement).toBe(empty)
      empty.setSelectionRange(1, 1)
      keydown(empty, { key: 'Enter' })
      await nextTick()
      await nextTick()

      const second = wrapper.findAll('textarea')[1]!.element
      expect(document.activeElement).toBe(second)
      expect(second.selectionStart).toBe(0)
      expect(content.value.entries).toEqual(['前', '后'])
      expect(wrapper.findAll('.diary-bullet-number').map(node => node.text())).toEqual(['01', '02'])
      expect(content.value.entryIds[0]).toBe(firstId)
    } finally { wrapper.unmount() }
  })

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

  it('keeps the action menu in the row without a standalone add button', () => {
    const wrapper = mount(DiaryBulletEditor, { props: { entries: ['一条日记'] } })
    const row = wrapper.get('.diary-bullet-row')
    expect(row.find('textarea').exists()).toBe(true)
    expect(row.getComponent(DiaryActionMenu).props('options')).toContainEqual({ key: 'remove', label: '删除此条' })
    expect(wrapper.find('.diary-bullet-add').exists()).toBe(false)
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
    wrapper.vm.addEntry()
    const addedEntries = ['保留', '删除我', '']
    expect(wrapper.emitted('update:entries')?.[0]?.[0]).toEqual(addedEntries)
    await wrapper.setProps({ entries: addedEntries })
    wrapper.findAllComponents(DiaryActionMenu)[1]!.vm.$emit('select', 'remove')
    await nextTick()
    expect(wrapper.emitted('update:entries')?.at(-1)?.[0]).toEqual(['保留', ''])
  })

  it('keeps stable entry identities when splitting and deleting rows', async () => {
    const firstId = '08a5c822-0d61-4e6c-a62c-1931a4da0771'
    const secondId = '08a5c822-0d61-4e6c-a62c-1931a4da0772'
    const wrapper = mount(DiaryBulletEditor, { props: { entries: ['早餐后学习'], entryIds: [firstId] } })
    const textarea = wrapper.get('textarea')
    ;(textarea.element as HTMLTextAreaElement).setSelectionRange(2, 2)
    await textarea.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('update:content')?.at(-1)?.[0]).toEqual({ entries: ['早餐', '后学习'], entryIds: [firstId, expect.any(String)] })

    const split = wrapper.emitted('update:content')?.at(-1)?.[0] as { entries: string[]; entryIds: string[] }
    await wrapper.setProps(split)
    wrapper.findAllComponents(DiaryActionMenu)[0]!.vm.$emit('select', 'remove')
    await nextTick()
    expect(wrapper.emitted('update:content')?.at(-1)?.[0]).toEqual({ entries: ['后学习'], entryIds: [split.entryIds[1]] })
    expect(split.entryIds[1]).not.toBe(secondId)
  })
})

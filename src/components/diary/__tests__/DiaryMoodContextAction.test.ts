// @vitest-environment jsdom
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useI18n } from '../../../composables/useI18n'
import DiaryMoodContextAction from '../DiaryMoodContextAction.vue'

enableAutoUnmount(afterEach)

describe('DiaryMoodContextAction', () => {
  beforeEach(() => {
    useI18n().setLocale('en')
  })

  afterEach(() => {
    useI18n().setLocale('zh')
    document.body.querySelectorAll('[data-testid="diary-mood-picker"]').forEach((element) => element.remove())
  })

  it('owns one trigger/picker presentation and returns focus after Escape', async () => {
    const wrapper = mount(DiaryMoodContextAction, {
      props: { currentMood: 'happy' },
      attachTo: document.body,
    })
    const trigger = wrapper.get('[data-testid="diary-mood-trigger"]')

    expect(trigger.element.tagName).toBe('BUTTON')
    expect(trigger.element.classList).toContain('n-button')
    expect(trigger.attributes('type')).toBe('button')
    expect(document.body.querySelectorAll('[data-testid="diary-mood-picker"]')).toHaveLength(0)
    await trigger.trigger('click')
    await flushPromises()
    expect(document.body.querySelectorAll('[data-testid="diary-mood-picker"]')).toHaveLength(1)
    const happy = document.body.querySelector<HTMLElement>('[data-mood-id="happy"]')
    expect(happy).not.toBeNull()
    expect(document.activeElement).toBe(happy)

    happy?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(document.body.querySelectorAll('[data-testid="diary-mood-picker"]')).toHaveLength(0)
    expect(document.activeElement).toBe(trigger.element)
  })

  it('forwards canonical selection and clear without owning persistence', async () => {
    const wrapper = mount(DiaryMoodContextAction, { props: { currentMood: 'happy' } })
    await wrapper.get('[data-testid="diary-mood-trigger"]').trigger('click')
    await flushPromises()
    document.body.querySelector<HTMLElement>('[data-mood-id="sad"]')?.click()
    document.body.querySelector<HTMLElement>('[data-testid="diary-mood-clear"]')?.click()

    expect(wrapper.emitted('select')).toEqual([['sad']])
    expect(wrapper.emitted('clear')).toHaveLength(1)
    expect(document.body.querySelector('[data-testid="diary-mood-picker"]')).not.toBeNull()
  })

  it('closes on an outside pointer and does not expose mutation when the CAS token is absent', async () => {
    const wrapper = mount(DiaryMoodContextAction, {
      props: { currentMood: null, disabled: true },
      attachTo: document.body,
    })
    const trigger = wrapper.get('[data-testid="diary-mood-trigger"]')
    expect(trigger.attributes('disabled')).toBeDefined()
    expect(trigger.attributes('aria-label')).toContain('Not set')

    await wrapper.setProps({ disabled: false })
    await trigger.trigger('click')
    await flushPromises()
    expect(document.body.querySelector('[data-testid="diary-mood-picker"]')).not.toBeNull()

    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await flushPromises()
    expect(document.body.querySelector('[data-testid="diary-mood-picker"]')).toBeNull()
  })

  it('treats the teleported picker as inside and preserves outside-target focus', async () => {
    const wrapper = mount(DiaryMoodContextAction, { props: { currentMood: null }, attachTo: document.body })
    const trigger = wrapper.get('[data-testid="diary-mood-trigger"]')
    const outside = document.createElement('button')
    outside.type = 'button'
    outside.dataset.testid = 'outside-target'
    document.body.append(outside)

    await trigger.trigger('click')
    await flushPromises()
    const picker = document.body.querySelector<HTMLElement>('[data-testid="diary-mood-picker"]')
    const radio = document.body.querySelector<HTMLElement>('[data-mood-id="sad"]')
    expect(picker).not.toBeNull()
    expect(radio).not.toBeNull()

    radio?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await flushPromises()
    expect(document.body.querySelector('[data-testid="diary-mood-picker"]')).not.toBeNull()

    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await flushPromises()
    expect(document.body.querySelector('[data-testid="diary-mood-picker"]')).toBeNull()
    outside.focus()
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })
})

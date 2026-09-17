// @vitest-environment jsdom
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MOOD_CATALOG } from '../../../../shared/diaryMood'
import { useI18n } from '../../../composables/useI18n'
import DiaryMoodPicker from '../DiaryMoodPicker.vue'

enableAutoUnmount(afterEach)

describe('DiaryMoodPicker', () => {
  beforeEach(() => {
    useI18n().setLocale('zh')
  })

  afterEach(() => {
    useI18n().setLocale('zh')
  })

  it('renders the single shared 24-item registry in row-major 4×6 order', () => {
    const wrapper = mount(DiaryMoodPicker)
    const radios = wrapper.findAll('[role="radio"]')

    expect(wrapper.get('[role="radiogroup"]')).toBeTruthy()
    expect(radios).toHaveLength(24)
    expect(radios.map((radio) => radio.attributes('data-mood-id')))
      .toEqual(MOOD_CATALOG.map((mood) => mood.id))
    expect(radios.every((radio) => radio.attributes('aria-checked') === 'false')).toBe(true)
    expect(radios[0]!.get('img').attributes('src')).toBe('/emoji/亲亲.svg')
    expect(radios[10]!.attributes('data-row')).toBe('3')
    expect(radios[10]!.attributes('data-column')).toBe('3')
    expect(wrapper.get('[data-testid="diary-mood-picker-close"]').element.tagName).toBe('BUTTON')
    expect(wrapper.get('[data-testid="diary-mood-picker-close"]').element.classList).toContain('n-button')
    expect(wrapper.get('[data-testid="diary-mood-clear"]').element.classList).toContain('n-button')
    expect(wrapper.get('[data-testid="diary-mood-clear"]').attributes('disabled')).toBeDefined()
  })

  it('focuses the selected canonical mood, and starts at R1C1 for null or unknown', async () => {
    const selected = mount(DiaryMoodPicker, {
      props: { currentMood: 'happy' },
      attachTo: document.body,
    })
    await flushPromises()
    expect(document.activeElement).toBe(selected.get('[data-mood-id="happy"]').element)

    const empty = mount(DiaryMoodPicker, {
      props: { currentMood: null },
      attachTo: document.body,
    })
    await flushPromises()
    expect(document.activeElement).toBe(empty.get('[data-mood-id="kiss"]').element)

    const unknown = mount(DiaryMoodPicker, {
      props: { currentMood: 'future-mood-v3' },
      attachTo: document.body,
    })
    await flushPromises()
    expect(document.activeElement).toBe(unknown.get('[data-mood-id="kiss"]').element)
    expect(unknown.get('[data-testid="diary-mood-unknown"]').text()).toContain('未知心情')
    expect(unknown.findAll('[aria-checked="true"]')).toHaveLength(0)
    expect(unknown.get('[data-testid="diary-mood-clear"]').attributes('disabled')).toBeUndefined()
  })

  it('clamps keyboard focus within fixed four-column geometry without emitting on arrows', async () => {
    const wrapper = mount(DiaryMoodPicker, {
      props: { currentMood: null },
      attachTo: document.body,
    })

    async function expectArrow(fromId: string, key: string, toId: string): Promise<void> {
      const source = wrapper.get(`[data-mood-id="${fromId}"]`)
      const sourceElement = source.element as HTMLElement
      sourceElement.focus()
      await source.trigger('keydown', { key })
      expect(document.activeElement).toBe(wrapper.get(`[data-mood-id="${toId}"]`).element)
    }

    await expectArrow('kiss', 'ArrowLeft', 'kiss')
    await expectArrow('kiss', 'ArrowUp', 'kiss')
    await expectArrow('surprised-small', 'ArrowRight', 'surprised-small')
    await expectArrow('surprised-small', 'ArrowUp', 'surprised-small')
    await expectArrow('laughing-tears', 'ArrowLeft', 'laughing-tears')
    await expectArrow('laughing-tears', 'ArrowDown', 'laughing-tears')
    await expectArrow('devilish', 'ArrowRight', 'devilish')
    await expectArrow('devilish', 'ArrowDown', 'devilish')

    await expectArrow('shy', 'ArrowRight', 'happy')
    await expectArrow('shy', 'ArrowLeft', 'afraid')
    await expectArrow('shy', 'ArrowDown', 'angry')
    await expectArrow('shy', 'ArrowUp', 'like')

    expect(wrapper.emitted('select')).toBeUndefined()
  })

  it('selects with Enter/Space, closes with Escape, and emits clear separately', async () => {
    const wrapper = mount(DiaryMoodPicker, { props: { currentMood: 'happy' } })
    const happy = wrapper.get('[data-mood-id="happy"]')

    await happy.trigger('keydown', { key: 'Enter' })
    await happy.trigger('keydown', { key: ' ' })
    expect(wrapper.emitted('select')).toEqual([['happy'], ['happy']])

    await happy.trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('close')).toHaveLength(1)

    await wrapper.get('[data-testid="diary-mood-clear"]').trigger('click')
    expect(wrapper.emitted('clear')).toHaveLength(1)
  })

  it('keeps Escape available while busy and prevents mutation controls', async () => {
    const wrapper = mount(DiaryMoodPicker, {
      props: { currentMood: 'happy', busy: true },
    })

    expect(wrapper.findAll('[role="radio"]').every((radio) => (
      radio.attributes('aria-disabled') === 'true'
    ))).toBe(true)
    await wrapper.get('[data-mood-id="sad"]').trigger('click')
    expect(wrapper.emitted('select')).toBeUndefined()
    expect(wrapper.get('[data-testid="diary-mood-clear"]').attributes('disabled')).toBeDefined()

    await wrapper.get('[data-mood-id="happy"]').trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})

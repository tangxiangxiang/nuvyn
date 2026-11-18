// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import DiaryAlarmClockIcon from '../DiaryAlarmClockIcon.vue'

describe('DiaryAlarmClockIcon', () => {
  it('falls back from the animated asset to the static asset after a load failure', async () => {
    const wrapper = mount(DiaryAlarmClockIcon, {
      props: { src: '/emoji/alarm-clock-animated.png' },
      attrs: { class: 'deadline-icon', 'data-testid': 'deadline-icon', alt: '' },
    })
    const image = wrapper.get('img')

    expect(image.attributes('src')).toBe('/emoji/alarm-clock-animated.png')
    await image.trigger('error')
    expect(image.attributes('src')).toBe('/emoji/alarm-clock.svg')
    await image.trigger('error')
    expect(image.attributes('src')).toBe('/emoji/alarm-clock.svg')
    expect(image.classes()).toContain('deadline-icon')
    expect(image.attributes('data-testid')).toBe('deadline-icon')
    wrapper.unmount()
  })

  it('does not retry the animated asset when a static image fails', async () => {
    const wrapper = mount(DiaryAlarmClockIcon, { props: { src: '/emoji/alarm-clock.svg' } })
    const image = wrapper.get('img')

    await image.trigger('error')
    expect(image.attributes('src')).toBe('/emoji/alarm-clock.svg')
    wrapper.unmount()
  })
})

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import DiaryAnimatedEmoji from '../DiaryAnimatedEmoji.vue'

const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia')

function setReducedMotion(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  })
}

afterEach(() => {
  if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia)
  else Reflect.deleteProperty(window, 'matchMedia')
  vi.restoreAllMocks()
})

describe('DiaryAnimatedEmoji', () => {
  it('uses animation only when requested and motion is allowed', async () => {
    const wrapper = mount(DiaryAnimatedEmoji, {
      props: { animatedSrc: '/emoji/bomb-animated.png', staticSrc: '/emoji/bomb.svg', animate: true },
    })
    expect(wrapper.get('img').attributes('src')).toBe('/emoji/bomb-animated.png')
    await wrapper.setProps({ animate: false })
    expect(wrapper.get('img').attributes('src')).toBe('/emoji/bomb.svg')
    wrapper.unmount()
  })

  it('uses the static asset when reduced motion is preferred', () => {
    setReducedMotion(true)
    const wrapper = mount(DiaryAnimatedEmoji, {
      props: { animatedSrc: '/emoji/alarm-clock-animated.png', staticSrc: '/emoji/alarm-clock.svg', animate: true },
    })
    expect(wrapper.get('img').attributes('src')).toBe('/emoji/alarm-clock.svg')
    wrapper.unmount()
  })

  it('falls back after animation failure without retrying and resets for a new animation', async () => {
    const wrapper = mount(DiaryAnimatedEmoji, {
      props: { animatedSrc: '/emoji/bomb-animated.png', staticSrc: '/emoji/bomb.svg', animate: true },
      attrs: { class: 'deadline-icon', 'data-testid': 'deadline-icon', alt: '' },
    })
    const image = wrapper.get('img')

    await image.trigger('error')
    expect(image.attributes('src')).toBe('/emoji/bomb.svg')
    await image.trigger('error')
    expect(image.attributes('src')).toBe('/emoji/bomb.svg')
    expect(image.classes()).toContain('deadline-icon')
    expect(image.attributes('data-testid')).toBe('deadline-icon')

    await wrapper.setProps({ animatedSrc: '/emoji/alarm-clock-animated.png', staticSrc: '/emoji/alarm-clock.svg' })
    expect(wrapper.get('img').attributes('src')).toBe('/emoji/alarm-clock-animated.png')
    wrapper.unmount()
  })
})

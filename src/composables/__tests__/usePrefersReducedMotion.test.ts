// @vitest-environment jsdom
import { defineComponent, h, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePrefersReducedMotion } from '../usePrefersReducedMotion'

describe('usePrefersReducedMotion', () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(window, 'matchMedia')

  afterEach(() => {
    if (originalDescriptor) Object.defineProperty(window, 'matchMedia', originalDescriptor)
    else Reflect.deleteProperty(window, 'matchMedia')
  })

  it('starts with the system preference and follows preference changes', async () => {
    let listener: ((event: MediaQueryListEvent) => void) | undefined
    const addEventListener = vi.fn((_type: string, callback: (event: MediaQueryListEvent) => void) => { listener = callback })
    const removeEventListener = vi.fn()
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: true, addEventListener, removeEventListener })),
    })

    const Host = defineComponent({
      setup() {
        const reduced = usePrefersReducedMotion()
        return () => h('span', reduced.value ? 'reduce' : 'motion')
      },
    })
    const wrapper = mount(Host)

    expect(wrapper.text()).toBe('reduce')
    listener?.({ matches: false } as MediaQueryListEvent)
    await nextTick()
    expect(wrapper.text()).toBe('motion')
    wrapper.unmount()
    expect(removeEventListener).toHaveBeenCalledOnce()
  })
})

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import {
  focusConnectedElement,
  useWorkspaceTabFocus,
} from '../useWorkspaceTabFocus'

enableAutoUnmount(afterEach)

function setup(attach = true) {
  let focus!: ReturnType<typeof useWorkspaceTabFocus>
  const Component = defineComponent({
    setup() {
      const container = ref<HTMLElement | null>(null)
      focus = useWorkspaceTabFocus({ container })
      return () => h('div', { ref: container }, [
        h('button', { role: 'tab', 'data-tab-id': 'a' }, 'A'),
        h('button', { role: 'tab', 'data-tab-id': 'b' }, 'B'),
      ])
    },
  })
  const wrapper = mount(Component, attach ? { attachTo: document.body } : {})
  return { focus, wrapper }
}

describe('useWorkspaceTabFocus', () => {
  it('finds workspace tabs by ID inside the supplied container', () => {
    const { focus, wrapper } = setup()

    expect(focus.findTabElement('b')).toBe(wrapper.get('[data-tab-id="b"]').element)
    expect(focus.findTabElement('missing')).toBeNull()
  })

  it('focuses a connected workspace tab and reports success', () => {
    const { focus, wrapper } = setup()

    expect(focus.focusTab('b')).toBe(true)
    expect(document.activeElement).toBe(wrapper.get('[data-tab-id="b"]').element)
  })

  it('does not focus unknown or disconnected elements', () => {
    const { focus } = setup(false)
    const disconnected = document.createElement('button')

    expect(focus.focusTab('missing')).toBe(false)
    expect(focus.focusTab('a')).toBe(false)
    expect(focusConnectedElement(disconnected)).toBe(false)
  })
})

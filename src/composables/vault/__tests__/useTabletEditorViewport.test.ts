// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tabletEditorHeight, useTabletEditorViewport } from '../useTabletEditorViewport'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('tablet editor viewport', () => {
  it('measures the actual visible bottom, restores full height and does not resize pinch zoom', () => {
    expect(tabletEditorHeight(49, 1024, { height: 600, offsetTop: 0, scale: 1 })).toBe(551)
    expect(tabletEditorHeight(49, 1024, { height: 1024, offsetTop: 0, scale: 1 })).toBe(975)
    expect(tabletEditorHeight(49, 1024, { height: 500, offsetTop: 80, scale: 1 })).toBe(531)
    expect(tabletEditorHeight(49, 1024)).toBeNull()
    expect(tabletEditorHeight(49, 1024, { height: 500, offsetTop: 0, scale: 2 })).toBeNull()
  })

  it('registers only while enabled and cleans listeners, CSS state and scheduled frames', async () => {
    const viewport = Object.assign(new EventTarget(), { height: 600, offsetTop: 0, scale: 1 })
    vi.stubGlobal('visualViewport', viewport)
    const add = vi.spyOn(viewport, 'addEventListener')
    const remove = vi.spyOn(viewport, 'removeEventListener')
    let frame: FrameRequestCallback | undefined
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frame = callback; return 1 })
    const cancel = vi.fn()
    vi.stubGlobal('cancelAnimationFrame', cancel)
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(1024)
    const enabled = ref(false)
    const root = ref<HTMLElement | null>(null)
    const wrapper = mount(defineComponent({ setup() { useTabletEditorViewport(root, enabled); return () => h('div', { ref: root }) } }))
    expect(add).not.toHaveBeenCalled()
    enabled.value = true
    await nextTick()
    frame!(0)
    expect(root.value!.style.getPropertyValue('--note-tablet-visible-height')).toBe('600px')
    viewport.height = 900
    viewport.dispatchEvent(new Event('resize'))
    frame!(0)
    expect(root.value!.style.getPropertyValue('--note-tablet-visible-height')).toBe('900px')
    enabled.value = false
    await nextTick()
    expect(root.value!.style.getPropertyValue('--note-tablet-visible-height')).toBe('')
    expect(remove).toHaveBeenCalledTimes(2)
    enabled.value = true
    await nextTick()
    wrapper.unmount()
    expect(remove).toHaveBeenCalledTimes(4)
    expect(cancel).toHaveBeenCalled()
  })
})

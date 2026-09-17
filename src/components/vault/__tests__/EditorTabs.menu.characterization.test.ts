// @vitest-environment jsdom
import {
  enableAutoUnmount,
  flushPromises,
  mount,
} from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deriveDocumentSavePresentation } from '../../../composables/vault/editor-tabs/savePresentation'
import { useI18n } from '../../../composables/useI18n'
import EditorTabs from '../EditorTabs.vue'
import type { WorkspaceTab } from '../tabs'

function makeTab(
  id: string,
  overrides: Partial<WorkspaceTab> = {},
): WorkspaceTab {
  return {
    id,
    label: id,
    title: id,
    save: deriveDocumentSavePresentation(null),
    kind: 'document',
    documentPath: id,
    ...overrides,
  }
}

const TABS = [
  makeTab('a'),
  makeTab('b'),
  makeTab('c'),
  makeTab('diff:c', {
    kind: 'diff',
    documentPath: 'c',
  }),
]
const originalInnerWidth = window.innerWidth
const originalInnerHeight = window.innerHeight

enableAutoUnmount(afterEach)

function menu(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.tab-context-menu')
}

function menuItems(): HTMLButtonElement[] {
  return [...(menu()?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
}

async function openWithPointer(
  wrapper: ReturnType<typeof mount>,
  id = 'b',
): Promise<void> {
  await wrapper.get(`[data-tab-id="${id}"]`).trigger('contextmenu', {
    clientX: 100,
    clientY: 50,
  })
  await flushPromises()
}

describe('EditorTabs menu behavior characterization', () => {
  beforeEach(() => {
    useI18n().setLocale('zh')
    document.querySelectorAll('.tab-context-menu')
      .forEach((element) => element.remove())
  })

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: originalInnerWidth,
    })
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: originalInnerHeight,
    })
    vi.restoreAllMocks()
  })

  it('opens from pointer or keyboard without selecting the target tab', async () => {
    const wrapper = mount(EditorTabs, {
      props: { tabs: TABS, activePath: 'a' },
      attachTo: document.body,
    })

    await openWithPointer(wrapper)
    expect(menu()).not.toBeNull()
    expect(wrapper.emitted('select')).toBeUndefined()
    expect(wrapper.get('[data-tab-id="a"]').attributes('aria-selected')).toBe('true')

    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
    }))
    const source = wrapper.get<HTMLElement>('[data-tab-id="diff:c"]')
    source.element.focus()
    await source.trigger('keydown', { key: 'ContextMenu' })
    await flushPromises()

    expect(menu()).not.toBeNull()
    expect(document.activeElement).toBe(menuItems()[0])
    expect(wrapper.emitted('select')).toBeUndefined()
  })

  it('supports roving navigation, skips disabled items, and activates with keyboard', async () => {
    const wrapper = mount(EditorTabs, {
      props: { tabs: TABS, activePath: 'a' },
      attachTo: document.body,
    })
    const source = wrapper.get<HTMLElement>('[data-tab-id="a"]')
    source.element.focus()
    await source.trigger('keydown', { key: 'F10', shiftKey: true })
    await flushPromises()

    const items = menuItems()
    expect(document.activeElement).toBe(items[0])
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
    }))
    expect(document.activeElement).toBe(items[1])
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
    }))
    expect(items[2]?.disabled).toBe(true)
    expect(document.activeElement).toBe(items[3])
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'End',
      bubbles: true,
    }))
    expect(document.activeElement).toBe(items[6])
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Home',
      bubbles: true,
    }))
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: ' ',
      bubbles: true,
    }))
    await flushPromises()

    expect(wrapper.emitted('close')).toEqual([['a']])
    expect(document.activeElement).toBe(source.element)
  })

  it.each(['Escape', 'Tab'])(
    'closes on %s and restores focus to the source tab',
    async (key) => {
      const wrapper = mount(EditorTabs, {
        props: { tabs: TABS, activePath: 'a' },
        attachTo: document.body,
      })
      const source = wrapper.get<HTMLElement>('[data-tab-id="b"]')
      source.element.focus()
      await source.trigger('keydown', { key: 'ContextMenu' })
      await flushPromises()

      document.dispatchEvent(new KeyboardEvent('keydown', {
        key,
        bubbles: true,
      }))
      await flushPromises()

      expect(menu()).toBeNull()
      expect(document.activeElement).toBe(source.element)
    },
  )

  it('keeps internal scrolling open but closes for external scroll and resize', async () => {
    const wrapper = mount(EditorTabs, {
      props: { tabs: TABS, activePath: 'a' },
      attachTo: document.body,
    })

    await openWithPointer(wrapper)
    const firstMenu = menu()!
    firstMenu.dispatchEvent(new Event('scroll'))
    expect(menu()).toBe(firstMenu)

    window.dispatchEvent(new Event('scroll'))
    await flushPromises()
    expect(menu()).toBeNull()

    await openWithPointer(wrapper)
    window.dispatchEvent(new Event('resize'))
    await flushPromises()
    expect(menu()).toBeNull()
  })

  it('invalidates the menu when the tab signature changes', async () => {
    const wrapper = mount(EditorTabs, {
      props: { tabs: TABS, activePath: 'a' },
      attachTo: document.body,
    })
    await openWithPointer(wrapper)

    await wrapper.setProps({
      tabs: [TABS[1]!, TABS[0]!, TABS[2]!, TABS[3]!],
    })

    expect(menu()).toBeNull()
    expect(wrapper.emitted('close-many')).toBeUndefined()
  })

  it('snapshots close-many targets before focus preparation', async () => {
    const wrapper = mount(EditorTabs, {
      props: { tabs: TABS, activePath: 'a' },
      attachTo: document.body,
    })
    await openWithPointer(wrapper)
    const closeRight = menuItems().find((item) => item.textContent === '关闭右侧')!

    closeRight.click()
    void wrapper.setProps({ tabs: [TABS[0]!, TABS[1]!, TABS[3]!] })
    await flushPromises()

    expect(wrapper.emitted('close-many')).toEqual([[['c', 'diff:c']]])
  })

  it('clamps using the rendered menu size and an 8px viewport margin', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 500 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 400 })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains('tab-context-menu')) {
          return {
            left: 0,
            right: 202,
            top: 0,
            bottom: 302,
            width: 202,
            height: 302,
            x: 0,
            y: 0,
            toJSON: () => '',
          }
        }
        return {
          left: 0,
          right: 100,
          top: 0,
          bottom: 36,
          width: 100,
          height: 36,
          x: 0,
          y: 0,
          toJSON: () => '',
        }
      })
    const wrapper = mount(EditorTabs, {
      props: { tabs: TABS, activePath: 'a' },
      attachTo: document.body,
    })

    await wrapper.get('[data-tab-id="b"]').trigger('contextmenu', {
      clientX: 490,
      clientY: 390,
    })
    await flushPromises()

    expect(menu()?.style.left).toBe('290px')
    expect(menu()?.style.top).toBe('90px')
  })

  it('does not register queued global listeners after unmount', async () => {
    const documentAdd = vi.spyOn(document, 'addEventListener')
    const windowAdd = vi.spyOn(window, 'addEventListener')
    const wrapper = mount(EditorTabs, {
      props: { tabs: TABS, activePath: 'a' },
      attachTo: document.body,
    })
    documentAdd.mockClear()
    windowAdd.mockClear()

    wrapper.get<HTMLElement>('[data-tab-id="b"]').element.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        clientX: 100,
        clientY: 50,
      }),
    )
    wrapper.unmount()
    await flushPromises()

    expect(documentAdd.mock.calls.some(
      ([type]) => type === 'pointerdown' || type === 'keydown',
    )).toBe(false)
    expect(windowAdd.mock.calls.some(
      ([type]) => type === 'resize' || type === 'scroll',
    )).toBe(false)
  })
})

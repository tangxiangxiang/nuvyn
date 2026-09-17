// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  defineComponent,
  h,
  nextTick,
  ref,
  type Ref,
} from 'vue'
import { deriveDocumentSavePresentation } from '../../editor-tabs/savePresentation'
import type { WorkspaceTab } from '../../../../components/vault/tabs'
import {
  useWorkspaceTabMenu,
  type WorkspaceTabMenuAction,
  type WorkspaceTabMenuIntent,
} from '../useWorkspaceTabMenu'

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

interface MenuHarness {
  tabs: Ref<readonly WorkspaceTab[]>
  activeId: Ref<string | null>
  intents: WorkspaceTabMenuIntent[]
  visible: Readonly<Ref<boolean>>
  targetId: Readonly<Ref<string | null>>
  activeItem: Readonly<Ref<number>>
  open: (
    id: string,
    x: number,
    y: number,
    source: HTMLElement,
  ) => void
  close: (restoreFocus?: boolean) => void
  activate: (action: WorkspaceTabMenuAction) => Promise<void>
  setMenuElement: (element: unknown) => void
  setItemElement: (element: unknown, index: number) => void
}

const mountedWrappers = new Set<{ unmount: () => void }>()
const fixtureElements = new Set<HTMLElement>()

function setup(): { api: MenuHarness, unmount: () => void } {
  let api!: MenuHarness
  const Comp = defineComponent({
    setup() {
      const tabs = ref<readonly WorkspaceTab[]>([
        makeTab('a'),
        makeTab('b'),
        makeTab('c'),
      ])
      const activeId = ref<string | null>('a')
      const intents: WorkspaceTabMenuIntent[] = []
      const menu = useWorkspaceTabMenu({
        tabs,
        activeId,
        onIntent: (intent) => intents.push(intent),
      })
      api = {
        tabs,
        activeId,
        intents,
        visible: menu.visible,
        targetId: menu.targetId,
        activeItem: menu.activeItem,
        open: menu.open,
        close: menu.close,
        activate: menu.activate,
        setMenuElement: menu.setMenuElement,
        setItemElement: menu.setItemElement,
      }
      return () => h('div')
    },
  })
  const wrapper = mount(Comp)
  mountedWrappers.add(wrapper)
  return {
    api,
    unmount: () => {
      if (!mountedWrappers.delete(wrapper)) return
      wrapper.unmount()
    },
  }
}

function fixture(tag = 'div'): HTMLElement {
  const element = document.createElement(tag)
  document.body.appendChild(element)
  fixtureElements.add(element)
  return element
}

function connectMenu(api: MenuHarness): {
  menu: HTMLElement
  items: HTMLButtonElement[]
} {
  const menu = fixture()
  const items = Array.from({ length: 7 }, (_, index) => {
    const item = fixture('button') as HTMLButtonElement
    menu.appendChild(item)
    api.setItemElement(item, index)
    return item
  })
  api.setMenuElement(menu)
  return { menu, items }
}

afterEach(() => {
  for (const wrapper of mountedWrappers) wrapper.unmount()
  mountedWrappers.clear()
  for (const element of fixtureElements) element.remove()
  fixtureElements.clear()
  vi.restoreAllMocks()
})

describe('useWorkspaceTabMenu', () => {
  it('keeps only the newest queued open and installs one listener set', async () => {
    const documentAdd = vi.spyOn(document, 'addEventListener')
    const windowAdd = vi.spyOn(window, 'addEventListener')
    const { api } = setup()
    connectMenu(api)
    const firstSource = fixture('button')
    const secondSource = fixture('button')
    documentAdd.mockClear()
    windowAdd.mockClear()

    api.open('a', 10, 20, firstSource)
    api.open('b', 30, 40, secondSource)
    await nextTick()

    expect(api.targetId.value).toBe('b')
    expect(documentAdd.mock.calls.filter(
      ([type]) => type === 'pointerdown',
    )).toHaveLength(1)
    expect(documentAdd.mock.calls.filter(
      ([type]) => type === 'keydown',
    )).toHaveLength(1)
    expect(windowAdd.mock.calls.filter(
      ([type]) => type === 'resize',
    )).toHaveLength(1)
    expect(windowAdd.mock.calls.filter(
      ([type]) => type === 'scroll',
    )).toHaveLength(1)
  })

  it('uses roving focus, skips disabled items, and activates the focused item', async () => {
    const { api } = setup()
    const { items } = connectMenu(api)
    const source = fixture('button')
    source.focus()
    api.open('a', 10, 20, source)
    await nextTick()

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
    expect(document.activeElement).toBe(items[3])
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Home',
      bubbles: true,
    }))
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
    }))
    await flushPromises()

    expect(api.intents).toEqual([{ type: 'close', id: 'a' }])
    expect(document.activeElement).toBe(source)
  })

  it('snapshots action targets before its asynchronous focus preparation', async () => {
    const { api } = setup()
    connectMenu(api)
    const source = fixture('button')
    api.open('b', 10, 20, source)
    await nextTick()

    const activation = api.activate('close-right')
    api.tabs.value = [makeTab('a'), makeTab('b')]
    await activation

    expect(api.intents).toEqual([{
      type: 'close-many',
      ids: ['c'],
    }])
  })

  it('closes when the active id or tab signature changes', async () => {
    const { api } = setup()
    connectMenu(api)
    const source = fixture('button')
    api.open('b', 10, 20, source)
    await nextTick()

    api.activeId.value = 'b'
    await nextTick()
    expect(api.visible.value).toBe(false)

    api.open('b', 10, 20, source)
    await nextTick()
    api.tabs.value = [makeTab('b'), makeTab('a'), makeTab('c')]
    await nextTick()
    expect(api.visible.value).toBe(false)
  })

  it('fails closed when the tab signature changes before the watcher flushes', async () => {
    const { api } = setup()
    connectMenu(api)
    api.open('b', 10, 20, fixture('button'))
    await nextTick()

    api.tabs.value = [makeTab('b'), makeTab('a'), makeTab('c')]
    await api.activate('close-right')

    expect(api.intents).toEqual([])
    expect(api.visible.value).toBe(false)
  })

  it('ignores menu-internal scroll and closes for external scroll', async () => {
    const { api } = setup()
    const { menu } = connectMenu(api)
    api.open('a', 10, 20, fixture('button'))
    await nextTick()

    menu.dispatchEvent(new Event('scroll'))
    await nextTick()
    expect(api.visible.value).toBe(true)

    window.dispatchEvent(new Event('scroll'))
    await nextTick()
    expect(api.visible.value).toBe(false)
  })

  it('removes listeners and invalidates queued work on unmount', async () => {
    const documentAdd = vi.spyOn(document, 'addEventListener')
    const windowAdd = vi.spyOn(window, 'addEventListener')
    const { api, unmount } = setup()
    connectMenu(api)
    documentAdd.mockClear()
    windowAdd.mockClear()

    api.open('a', 10, 20, fixture('button'))
    unmount()
    await nextTick()

    expect(api.visible.value).toBe(false)
    expect(documentAdd.mock.calls.some(
      ([type]) => type === 'pointerdown' || type === 'keydown',
    )).toBe(false)
    expect(windowAdd.mock.calls.some(
      ([type]) => type === 'resize' || type === 'scroll',
    )).toBe(false)
  })

  it('does not emit a queued intent after unmount', async () => {
    const { api, unmount } = setup()
    connectMenu(api)
    api.open('b', 10, 20, fixture('button'))
    await nextTick()

    const activation = api.activate('close')
    unmount()
    await activation

    expect(api.intents).toEqual([])
  })
})

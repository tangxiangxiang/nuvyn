// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  defineComponent,
  h,
  nextTick,
  ref,
  type Ref,
} from 'vue'
import {
  WORKSPACE_TAB_MIME,
  useWorkspaceTabReorder,
  type WorkspaceTabReorderRequest,
} from '../useWorkspaceTabReorder'

class TestDataTransfer {
  effectAllowed = 'uninitialized'
  dropEffect = 'none'
  readonly types: string[] = []
  private readonly data = new Map<string, string>()

  setData(type: string, value: string): void {
    if (!this.types.includes(type)) this.types.push(type)
    this.data.set(type, value)
  }

  getData(type: string): string {
    return this.data.get(type) ?? ''
  }
}

interface Harness {
  tabIds: Ref<readonly string[]>
  container: Ref<HTMLElement | null>
  requests: WorkspaceTabReorderRequest[]
  api: ReturnType<typeof useWorkspaceTabReorder>
}

const wrappers = new Set<{ unmount: () => void }>()

function setup(): { harness: Harness, unmount: () => void } {
  let harness!: Harness
  const Comp = defineComponent({
    setup() {
      const tabIds = ref<readonly string[]>(['a', 'history:a', 'diff:b', 'c'])
      const container = ref<HTMLElement | null>(null)
      const requests: WorkspaceTabReorderRequest[] = []
      const api = useWorkspaceTabReorder({
        tabIds,
        container,
        displayTitle: (id) => `title:${id}`,
        announce: (title, position, count) => `${title}|${position}|${count}`,
        onReorder: (request) => requests.push(request),
      })
      harness = { tabIds, container, requests, api }
      return () => h('div')
    },
  })
  const wrapper = mount(Comp)
  wrappers.add(wrapper)
  return {
    harness,
    unmount: () => {
      if (!wrappers.delete(wrapper)) return
      wrapper.unmount()
    },
  }
}

function dragEvent(
  type: string,
  transfer: TestDataTransfer,
  currentTarget?: HTMLElement,
  clientX = 0,
): DragEvent {
  const event = new Event(type, { cancelable: true }) as DragEvent
  Object.defineProperties(event, {
    dataTransfer: { value: transfer },
    clientX: { value: clientX },
    currentTarget: { value: currentTarget ?? null },
  })
  return event
}

function rect(left: number, width = 100): DOMRect {
  return {
    left,
    right: left + width,
    top: 0,
    bottom: 36,
    width,
    height: 36,
    x: left,
    y: 0,
    toJSON: () => '',
  }
}

afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount()
  wrappers.clear()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('useWorkspaceTabReorder', () => {
  it('validates the internal source, MIME payload, and drag-start signature', () => {
    const { harness } = setup()
    const transfer = new TestDataTransfer()
    expect(harness.api.start(dragEvent('dragstart', transfer), 'history:a')).toBe(true)
    expect(transfer.types).toEqual([WORKSPACE_TAB_MIME])
    expect(transfer.getData(WORKSPACE_TAB_MIME)).toBe('history:a')

    harness.tabIds.value = ['a', 'history:a', 'c']
    const target = document.createElement('div')
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(rect(0))
    harness.api.over(dragEvent('dragover', transfer, target, 10), 'a')

    expect(harness.api.draggedId.value).toBeNull()
    expect(harness.api.dropTargetId.value).toBeNull()
    expect(harness.requests).toEqual([])
  })

  it('emits a complete pointer request only after a valid drop', () => {
    const { harness } = setup()
    const transfer = new TestDataTransfer()
    const target = document.createElement('div')
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(rect(100))

    harness.api.start(dragEvent('dragstart', transfer), 'history:a')
    const over = dragEvent('dragover', transfer, target, 180)
    harness.api.over(over, 'diff:b')
    expect(over.defaultPrevented).toBe(true)
    expect(harness.api.dropTargetId.value).toBe('diff:b')
    expect(harness.api.dropPosition.value).toBe('after')
    harness.api.drop(dragEvent('drop', transfer), 'diff:b')

    expect(harness.requests).toEqual([{
      orderedIds: ['a', 'diff:b', 'history:a', 'c'],
      movedId: 'history:a',
      input: 'pointer',
    }])
    expect(harness.api.draggedId.value).toBeNull()
  })

  it('ignores external and mismatched payloads', () => {
    const { harness } = setup()
    const external = new TestDataTransfer()
    external.setData('text/plain', 'history:a')
    const target = document.createElement('div')
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(rect(0))

    harness.api.over(dragEvent('dragover', external, target, 10), 'a')
    harness.api.drop(dragEvent('drop', external), 'a')

    expect(harness.requests).toEqual([])
  })

  it('blocks an ancestor drag after close-button pointerdown and still clears the block', () => {
    const { harness } = setup()
    const pointer = new Event('pointerdown') as PointerEvent
    harness.api.blockCloseButtonDrag('a', pointer)
    const transfer = new TestDataTransfer()
    const start = dragEvent('dragstart', transfer)

    expect(harness.api.start(start, 'a')).toBe(false)
    expect(start.defaultPrevented).toBe(true)
    expect(transfer.types).toEqual([])

    const retry = new TestDataTransfer()
    expect(harness.api.start(dragEvent('dragstart', retry), 'a')).toBe(true)
  })

  it('emits keyboard requests and announces with the supplied presentation title', async () => {
    const { harness } = setup()

    harness.api.moveByKeyboard('diff:b', -1)
    await nextTick()

    expect(harness.requests).toEqual([{
      orderedIds: ['a', 'diff:b', 'history:a', 'c'],
      movedId: 'diff:b',
      input: 'keyboard',
    }])
    expect(harness.api.liveAnnouncement.value).toBe('title:diff:b|2|4')
    harness.api.moveByKeyboard('a', -1)
    expect(harness.requests).toHaveLength(1)
  })

  it('snapshots the announcement title before emitting reorder', async () => {
    let title = 'Original title'
    let api!: ReturnType<typeof useWorkspaceTabReorder>
    const Comp = defineComponent({
      setup() {
        const tabIds = ref<readonly string[]>(['a', 'b'])
        api = useWorkspaceTabReorder({
          tabIds,
          container: ref<HTMLElement | null>(null),
          displayTitle: () => title,
          announce: (value) => value,
          onReorder: () => {
            title = 'Changed title'
          },
        })
        return () => h('div')
      },
    })
    const wrapper = mount(Comp)
    wrappers.add(wrapper)

    api.moveByKeyboard('a', 1)
    await nextTick()

    expect(api.liveAnnouncement.value).toBe('Original title')
  })

  it('does not add listeners or emit reorder after unmount', () => {
    const addListener = vi.spyOn(window, 'addEventListener')
    const { harness, unmount } = setup()
    unmount()

    harness.api.blockCloseButtonDrag('a', new Event('pointerdown') as PointerEvent)
    harness.api.moveByKeyboard('a', 1)

    expect(addListener).not.toHaveBeenCalled()
    expect(harness.requests).toEqual([])
  })

  it('keeps a single auto-scroll RAF and clears it on cancel', () => {
    const callbacks = new Map<number, FrameRequestCallback>()
    let nextFrame = 1
    const request = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const id = nextFrame++
      callbacks.set(id, callback)
      return id
    })
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      callbacks.delete(id)
    })
    const { harness } = setup()
    const strip = document.createElement('div')
    strip.scrollLeft = 40
    vi.spyOn(strip, 'getBoundingClientRect').mockReturnValue(rect(0, 300))
    harness.container.value = strip
    const target = document.createElement('div')
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(rect(200))
    const transfer = new TestDataTransfer()

    harness.api.start(dragEvent('dragstart', transfer), 'history:a')
    harness.api.over(dragEvent('dragover', transfer, target, 295), 'diff:b')
    harness.api.over(dragEvent('dragover', transfer, target, 295), 'diff:b')
    expect(request).toHaveBeenCalledOnce()

    harness.api.cancel()
    expect(cancel).toHaveBeenCalledOnce()
    expect(callbacks).toHaveLength(0)
  })

  it('invalidates announcements and clears RAF and timers on unmount', async () => {
    vi.useFakeTimers()
    const request = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(9)
    const cancel = vi.spyOn(window, 'cancelAnimationFrame')
    const { harness, unmount } = setup()
    const strip = document.createElement('div')
    vi.spyOn(strip, 'getBoundingClientRect').mockReturnValue(rect(0, 300))
    harness.container.value = strip
    const target = document.createElement('div')
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(rect(200))
    const transfer = new TestDataTransfer()

    harness.api.start(dragEvent('dragstart', transfer), 'history:a')
    harness.api.over(dragEvent('dragover', transfer, target, 295), 'diff:b')
    harness.api.moveByKeyboard('history:a', 1)
    harness.api.cancel(true)
    unmount()
    await nextTick()
    vi.runAllTimers()

    expect(request).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledWith(9)
    expect(harness.api.liveAnnouncement.value).toBe('')
    expect(harness.api.draggedId.value).toBeNull()
  })
})

// @vitest-environment jsdom
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import EditorTabs from '../EditorTabs.vue'
import type { WorkspaceTab } from '../tabs'
import { deriveDocumentSavePresentation } from '../../../composables/vault/editor-tabs/savePresentation'
import { useI18n } from '../../../composables/useI18n'

enableAutoUnmount(afterEach)

function tab(id: string, kind: WorkspaceTab['kind'] = 'document'): WorkspaceTab {
  return {
    id,
    label: id,
    title: id,
    save: deriveDocumentSavePresentation(null),
    kind,
  }
}

const tabs = [tab('a'), tab('recovery:a', 'recovery'), tab('diff:b', 'diff'), tab('c')]

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

describe('EditorTabs reorder characterization', () => {
  beforeEach(() => {
    useI18n().setLocale('zh')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fails closed when the tab signature changes before drop', async () => {
    const wrapper = mount(EditorTabs, { props: { tabs, activePath: 'a' } })
    const transfer = new TestDataTransfer() as unknown as DataTransfer
    await wrapper.findAll('.tab')[1]!.trigger('dragstart', { dataTransfer: transfer })

    await wrapper.setProps({ tabs: [tabs[0]!, tabs[1]!, tabs[3]!] })
    await wrapper.findAll('.tab')[0]!.trigger('drop', { dataTransfer: transfer })

    expect(wrapper.emitted('reorder')).toBeUndefined()
    expect(wrapper.findAll('.dragging, .drop-before, .drop-after')).toHaveLength(0)
  })

  it('blocks an ancestor drag whose pointer started on the close button', async () => {
    const wrapper = mount(EditorTabs, { props: { tabs, activePath: 'a' } })
    const close = wrapper.get('.tab-close')
    await close.trigger('pointerdown')
    const event = new Event('dragstart', { bubbles: true, cancelable: true })
    const transfer = new TestDataTransfer()
    Object.defineProperty(event, 'dataTransfer', { value: transfer })

    wrapper.get('.tab').element.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(transfer.types).toEqual([])
    expect(wrapper.find('.dragging').exists()).toBe(false)
    await close.trigger('click')
    expect(wrapper.emitted('close')).toEqual([['a']])
  })

  it('emits a complete keyboard request without selecting the focused tab', async () => {
    const wrapper = mount(EditorTabs, { props: { tabs, activePath: 'a' } })
    const recovery = wrapper.get('[data-tab-id="recovery:a"]')

    await recovery.trigger('keydown', {
      key: 'ArrowRight',
      altKey: true,
      shiftKey: true,
    })

    expect(wrapper.emitted('reorder')).toEqual([[{
      orderedIds: ['a', 'diff:b', 'recovery:a', 'c'],
      movedId: 'recovery:a',
      input: 'keyboard',
    }]])
    expect(wrapper.emitted('select')).toBeUndefined()
    expect(wrapper.props('activePath')).toBe('a')
    expect(wrapper.get('[aria-live="polite"]').text()).toContain('第 3 个')
  })

  it('suppresses the synthetic click after a successful drop', async () => {
    const wrapper = mount(EditorTabs, { props: { tabs, activePath: 'a' } })
    const transfer = new TestDataTransfer() as unknown as DataTransfer
    const source = wrapper.findAll('.tab')[1]!
    const target = wrapper.findAll('.tab')[2]!
    vi.spyOn(target.element, 'getBoundingClientRect').mockReturnValue(rect(100))

    await source.trigger('dragstart', { dataTransfer: transfer })
    await target.trigger('dragover', { dataTransfer: transfer, clientX: 180 })
    await target.trigger('drop', { dataTransfer: transfer, clientX: 180 })
    await source.trigger('click')

    expect(wrapper.emitted('reorder')).toHaveLength(1)
    expect(wrapper.emitted('select')).toBeUndefined()
  })

  it('cancels the sole auto-scroll frame when unmounted', async () => {
    let callback: FrameRequestCallback | null = null
    const request = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((next) => {
      callback = next
      return 41
    })
    const cancel = vi.spyOn(window, 'cancelAnimationFrame')
    const wrapper = mount(EditorTabs, { props: { tabs, activePath: 'a' } })
    const strip = wrapper.get('.tabs').element as HTMLElement
    vi.spyOn(strip, 'getBoundingClientRect').mockReturnValue(rect(0, 300))
    const target = wrapper.findAll('.tab')[2]!
    vi.spyOn(target.element, 'getBoundingClientRect').mockReturnValue(rect(200))
    const transfer = new TestDataTransfer() as unknown as DataTransfer

    await wrapper.findAll('.tab')[1]!.trigger('dragstart', { dataTransfer: transfer })
    await target.trigger('dragover', { dataTransfer: transfer, clientX: 295 })

    expect(request).toHaveBeenCalledOnce()
    expect(callback).not.toBeNull()
    wrapper.unmount()
    expect(cancel).toHaveBeenCalledWith(41)
  })
})

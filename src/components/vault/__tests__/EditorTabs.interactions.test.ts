// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { NConfigProvider, NDialogProvider, NMessageProvider, NNotificationProvider } from 'naive-ui'
import EditorTabs from '../EditorTabs.vue'
import ConfirmHost from '../../ConfirmHost.vue'
import type { WorkspaceTab } from '../tabs'
import { useConfirm } from '../../../composables/useConfirm'
import { useI18n } from '../../../composables/useI18n'

enableAutoUnmount(afterEach)

beforeEach(() => {
  useI18n().setLocale('zh')
})

afterEach(() => {
  document.querySelectorAll('.tab-context-menu').forEach((element) => element.remove())
  useI18n().setLocale('zh')
})

function makeTab(id: string, overrides: Partial<WorkspaceTab> = {}): WorkspaceTab {
  return {
    id,
    label: id,
    title: id,
    kind: 'document',
    documentPath: id,
    save: {
      status: 'idle',
      dirty: false,
      inFlight: false,
      retryable: false,
      attention: false,
      hasNewerChanges: false,
    },
    ...overrides,
  }
}

function menuButtons(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('.tab-context-menu [role="menuitem"]')]
}

async function openPointerMenu(wrapper: ReturnType<typeof mount>, id: string): Promise<void> {
  await wrapper.get(`[data-tab-id="${id}"]`).trigger('contextmenu', {
    clientX: 100,
    clientY: 50,
  })
  await flushPromises()
}

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

describe('EditorTabs interaction wiring', () => {
  it('renders the menu contract and maps menu intents to component emits', async () => {
    const tabs = [
      makeTab('a'),
      makeTab('diff:b', {
        kind: 'diff',
        label: 'Diff B',
        documentPath: 'notes/b',
      }),
      makeTab('c'),
    ]
    const wrapper = mount(EditorTabs, {
      props: { tabs, activePath: 'a' },
      attachTo: document.body,
    })

    await openPointerMenu(wrapper, 'diff:b')
    expect(menuButtons().map((button) => button.textContent)).toEqual([
      '关闭',
      '关闭其它',
      '关闭左侧',
      '关闭右侧',
      '关闭所有',
      '复制路径',
      '在文件树中显示',
    ])
    expect(document.querySelector('.tab-context-menu')?.getAttribute('role')).toBe('menu')
    expect(document.querySelector('[role="separator"]')).not.toBeNull()

    menuButtons().find((button) => button.textContent === '关闭右侧')!.click()
    await flushPromises()
    expect(wrapper.emitted('close-many')).toEqual([[['c']]])

    await openPointerMenu(wrapper, 'diff:b')
    menuButtons().find((button) => button.textContent === '复制路径')!.click()
    await flushPromises()
    expect(wrapper.emitted('copy-path')).toEqual([['notes/b']])
    expect(wrapper.emitted('select')).toBeUndefined()

    await openPointerMenu(wrapper, 'diff:b')
    menuButtons().find((button) => button.textContent === '在文件树中显示')!.click()
    await flushPromises()
    expect(wrapper.emitted('reveal-in-tree')).toEqual([['notes/b']])
  })

  it('restores the source tab before dirty confirmation captures focus', async () => {
    const Harness = defineComponent({
      components: { EditorTabs, ConfirmHost },
      setup() {
        const { confirm } = useConfirm()
        return {
          tabs: [makeTab('dirty', {
            save: {
              status: 'dirty',
              dirty: true,
              inFlight: false,
              retryable: false,
              attention: false,
              hasNewerChanges: false,
            },
          })],
          onClose: () => confirm('Discard changes?'),
        }
      },
      template: `
        <EditorTabs :tabs="tabs" active-path="dirty" @close="onClose" />
        <ConfirmHost />
      `,
    })
    const wrapper = mount(NConfigProvider, {
      attachTo: document.body,
      global: { stubs: { transition: false } },
      props: { preflightStyleDisabled: true },
      slots: {
        default: () => h(NDialogProvider, null, {
          default: () => h(NMessageProvider, null, {
            default: () => h(NNotificationProvider, null, {
              default: () => h(Harness),
            }),
          }),
        }),
      },
    })
    const source = wrapper.get<HTMLElement>('[data-tab-id="dirty"]')
    source.element.focus()
    await source.trigger('keydown', { key: 'F10', shiftKey: true })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushPromises()

    expect(document.querySelector('.tab-context-menu')).toBeNull()
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
    expect(dialog).not.toBeNull()
    const cancel = dialog!.querySelector<HTMLButtonElement>('button')!
    cancel.focus()
    cancel.click()
    await flushPromises()
    await vi.waitFor(() => expect(document.activeElement).toBe(source.element), { timeout: 1200 })
  })

  it('coordinates drag start by closing the context menu without selecting', async () => {
    const wrapper = mount(EditorTabs, {
      props: { tabs: [makeTab('a'), makeTab('b')], activePath: 'a' },
      attachTo: document.body,
    })
    const source = wrapper.get('[data-tab-id="b"]')
    await openPointerMenu(wrapper, 'b')
    expect(document.querySelector('.tab-context-menu')).not.toBeNull()

    const dataTransfer = new TestDataTransfer() as unknown as DataTransfer
    await source.trigger('dragstart', { dataTransfer })

    expect(document.querySelector('.tab-context-menu')).toBeNull()
    expect(source.classes()).toContain('dragging')
    expect(wrapper.emitted('select')).toBeUndefined()
  })
})

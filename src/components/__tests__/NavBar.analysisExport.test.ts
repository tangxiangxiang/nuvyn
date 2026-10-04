// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import NavBar from '../NavBar.vue'
import { AppShellContextKey } from '../../composables/appShellContext'
import { useScopeFilter } from '../../composables/vault/useScopeFilter'
import { useI18n } from '../../composables/useI18n'
import { __resetVaultLayoutState } from '../../composables/vault/useVaultLayout'

describe.each(['diary', 'ledger'] as const)('NavBar hidden %s analysis gesture', (scope) => {
  let wrapper: VueWrapper | undefined
  let finePointer = true
  let mobileWidth = false
  const elements: HTMLElement[] = []

  beforeEach(() => {
    finePointer = true
    mobileWidth = false
    // Ledger routes legitimately retain the last Vault scope. Navigation's
    // module owner, not this retained selection alone, determines activation.
    useScopeFilter().activeScope.value = 'diary'
    useI18n().setLocale('en')
    __resetVaultLayoutState()
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: query === '(hover: hover) and (pointer: fine)' ? finePointer : mobileWidth,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })))
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    elements.splice(0).forEach((element) => element.remove())
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    useI18n().setLocale('zh')
  })

  async function setup(command = vi.fn(async () => {}), unlocked = true) {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/vault', name: 'vault', component: { template: '<div />' } },
        { path: '/ledger', name: 'ledger', component: { template: '<div />' } },
        { path: '/ledger/accounts', name: 'ledger-accounts', component: { template: '<div />' } },
        { path: '/board', name: 'board', component: { template: '<div />' } },
      ],
    })
    await router.push(scope === 'diary' ? '/vault' : '/ledger')
    const otherCommand = vi.fn(async () => {})
    const diaryBackCommand = vi.fn()
    const calendarVisible = ref(scope === 'diary')
    const commandRef = ref<(() => Promise<void>) | null>(command)
    wrapper = mount(NavBar, {
      attachTo: document.body,
      props: { workspaceKind: scope === 'diary' ? 'vault' : 'ledger', diaryUnlocked: unlocked },
      global: {
        plugins: [router],
        provide: {
          [AppShellContextKey as symbol]: {
            settingsRequestTick: ref(0),
            diaryCalendarVisible: calendarVisible,
            diaryBackCommand: ref(diaryBackCommand),
            diaryAnalysisExportCommand: scope === 'diary' ? commandRef : ref(otherCommand),
            ledgerAnalysisExportCommand: scope === 'ledger' ? commandRef : ref(otherCommand),
          },
        },
      },
    })
    const chip = wrapper.findAll('.scope-chip').find((item) => item.text().includes(scope))!
    const otherChip = wrapper.findAll('.scope-chip').find((item) => item.text().includes(scope === 'diary' ? 'ledger' : 'diary'))!
    return { command, otherCommand, chip, otherChip, diaryBackCommand, router, calendarVisible, commandRef }
  }

  function key(options: KeyboardEventInit = {}, target: EventTarget = window): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key: 'e', bubbles: true, cancelable: true, composed: true, ...options })
    target.dispatchEvent(event)
    return event
  }

  it.each([{ key: 'e' }, { key: 'E' }, { key: 'E', shiftKey: true }])('invokes only the active command after hover: %j', async (options) => {
    const { command, otherCommand, chip, diaryBackCommand, router } = await setup()
    const attributes = chip.attributes()
    const content = chip.html()
    const route = router.currentRoute.value.path
    key(options)
    expect(command).not.toHaveBeenCalled()
    await chip.trigger('mouseenter')
    expect(command).not.toHaveBeenCalled()
    key(options)
    await flushPromises()
    expect(command).toHaveBeenCalledOnce()
    expect(otherCommand).not.toHaveBeenCalled()
    expect(diaryBackCommand).not.toHaveBeenCalled()
    expect(router.currentRoute.value.path).toBe(route)
    expect(chip.attributes()).toEqual(attributes)
    expect(chip.html()).toBe(content)
    expect(wrapper!.text()).not.toMatch(/export|download/i)
  })

  it('never invokes another module, even when its command and unlocked session are available', async () => {
    const { command, otherCommand, otherChip } = await setup()
    await otherChip.trigger('mouseenter')
    key()
    expect(command).not.toHaveBeenCalled()
    expect(otherCommand).not.toHaveBeenCalled()
  })

  it.each(['note', 'board'] as const)('does not export from %s, even after the export chip was hovered', async (workspace) => {
    const { command, chip, calendarVisible, router } = await setup()
    await chip.trigger('mouseenter')
    calendarVisible.value = false
    useScopeFilter().activeScope.value = 'note'
    await router.push(workspace === 'board' ? '/board' : '/vault')
    await wrapper!.setProps({ workspaceKind: workspace === 'board' ? 'board' : 'vault' })
    key()
    expect(command).not.toHaveBeenCalled()
  })

  it('stops responding immediately on mouseleave', async () => {
    const { command, chip } = await setup()
    await chip.trigger('mouseenter')
    await chip.trigger('mouseleave')
    key()
    expect(command).not.toHaveBeenCalled()
  })

  it('leaves the existing click/Diary Back behavior intact', async () => {
    const { command, chip, diaryBackCommand, router } = await setup()
    const route = router.currentRoute.value.path
    await chip.trigger('mouseenter')
    await chip.trigger('click')
    expect(diaryBackCommand).toHaveBeenCalledTimes(scope === 'diary' ? 1 : 0)
    expect(router.currentRoute.value.path).toBe(route)
    expect(command).not.toHaveBeenCalled()
  })

  it('requires Diary unlock only for Diary, including a lock during hover', async () => {
    const { command, chip } = await setup(vi.fn(async () => {}), false)
    await chip.trigger('mouseenter')
    key()
    await flushPromises()
    expect(command).toHaveBeenCalledTimes(scope === 'diary' ? 0 : 1)
    await wrapper!.setProps({ diaryUnlocked: true })
    await wrapper!.setProps({ diaryUnlocked: false })
    key()
    await flushPromises()
    expect(command).toHaveBeenCalledTimes(scope === 'diary' ? 0 : 2)
  })

  it('uses pointer capability rather than viewport width', async () => {
    mobileWidth = true
    const { command, chip } = await setup()
    await chip.trigger('mouseenter')
    key()
    expect(command).toHaveBeenCalledOnce()
    await flushPromises()
    finePointer = false
    key()
    expect(command).toHaveBeenCalledOnce()
  })

  it.each([false, undefined])('does not register without hover/fine-pointer capability: %s', async (matches) => {
    vi.stubGlobal('matchMedia', matches === undefined ? undefined : vi.fn(() => ({
      matches, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    })))
    const { command, chip } = await setup()
    const add = vi.spyOn(window, 'addEventListener')
    await chip.trigger('mouseenter')
    await chip.trigger('touchstart')
    key()
    expect(add.mock.calls.filter(([name]) => name === 'keydown')).toHaveLength(0)
    expect(command).not.toHaveBeenCalled()
  })

  it.each([
    { ctrlKey: true }, { metaKey: true }, { altKey: true },
    { repeat: true }, { isComposing: true }, { key: 'x' },
  ])('yields to conflicting key state: %j', async (options) => {
    const { command, chip } = await setup()
    await chip.trigger('mouseenter')
    expect(key(options).defaultPrevented).toBe(false)
    expect(command).not.toHaveBeenCalled()
  })

  it('does not handle an already prevented event', async () => {
    const { command, chip } = await setup()
    await chip.trigger('mouseenter')
    const event = new KeyboardEvent('keydown', { key: 'e', cancelable: true })
    event.preventDefault()
    window.dispatchEvent(event)
    expect(command).not.toHaveBeenCalled()
  })

  it.each([
    '<input>', '<textarea></textarea>', '<select></select>',
    '<div contenteditable=""><span>text</span></div>',
    '<div contenteditable="true"><span>text</span></div>',
    '<div contenteditable="plaintext-only"><span>text</span></div>',
    '<div role="textbox"><span>text</span></div>',
    '<div class="monaco-editor"><span>text</span></div>',
    '<div class="excalidraw"><span>canvas</span></div>',
    '<div role="dialog"><button>action</button></div>',
  ])('yields to existing text/editor/overlay guards: %s', async (html) => {
    const { command, chip } = await setup()
    await chip.trigger('mouseenter')
    const element = document.createElement('div')
    element.innerHTML = html
    document.body.append(element)
    elements.push(element)
    key({}, element.querySelector('span, button') ?? element.firstElementChild!)
    expect(command).not.toHaveBeenCalled()
  })

  it('honors editable composed paths through Shadow DOM and the focused input', async () => {
    const { command, chip } = await setup()
    await chip.trigger('mouseenter')
    const host = document.createElement('div')
    const root = host.attachShadow({ mode: 'open' })
    const input = document.createElement('div')
    Object.defineProperty(input, 'isContentEditable', { value: true })
    root.append(input)
    document.body.append(host)
    elements.push(host)
    key({}, input)
    expect(command).not.toHaveBeenCalled()
    const focused = document.createElement('input')
    document.body.append(focused)
    elements.push(focused)
    focused.focus()
    key()
    expect(command).not.toHaveBeenCalled()
  })

  it('allows one export at a time, and allows distinct presses after completion', async () => {
    let resolve: () => void = () => {}
    const command = vi.fn(() => new Promise<void>((done) => { resolve = done }))
    const { chip } = await setup(command)
    await chip.trigger('mouseenter')
    key()
    await chip.trigger('mouseleave')
    await chip.trigger('mouseenter')
    key()
    expect(command).toHaveBeenCalledOnce()
    resolve()
    await flushPromises()
    key({ repeat: true })
    expect(command).toHaveBeenCalledOnce()
    key()
    expect(command).toHaveBeenCalledTimes(2)
    resolve()
    await flushPromises()
  })

  it('logs only a generic failure and releases the running guard', async () => {
    const error = Object.assign(new Error('sensitive body'), { raw: 'private plaintext' })
    const command = vi.fn(async () => { throw error })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { chip } = await setup(command)
    await chip.trigger('mouseenter')
    key()
    await flushPromises()
    expect(log).toHaveBeenCalledExactlyOnceWith(`${scope === 'diary' ? 'Diary' : 'Ledger'} analysis export failed`)
    key()
    await flushPromises()
    expect(command).toHaveBeenCalledTimes(2)
  })

  it('registers once per hover and removes its listener on unmount', async () => {
    const { chip } = await setup()
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    await chip.trigger('mouseenter')
    await chip.trigger('mouseenter')
    const calls = add.mock.calls.filter(([name]) => name === 'keydown')
    expect(calls).toHaveLength(1)
    wrapper!.unmount()
    wrapper = undefined
    expect(remove).toHaveBeenCalledWith('keydown', calls[0]![1])
  })

  it.each(['blur', 'hidden', 'unmount'])('removes the hover listener on %s', async (action) => {
    const { command, chip } = await setup()
    await chip.trigger('mouseenter')
    if (action === 'unmount') {
      wrapper!.unmount()
      wrapper = undefined
    } else if (action === 'hidden') {
      vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
      document.dispatchEvent(new Event('visibilitychange'))
    } else window.dispatchEvent(new Event('blur'))
    key()
    expect(command).not.toHaveBeenCalled()
  })

  it('does nothing without a command or while logout is busy', async () => {
    const { command, chip, commandRef } = await setup()
    await chip.trigger('mouseenter')
    commandRef.value = null
    key()
    commandRef.value = command
    await wrapper!.setProps({ logoutBusy: true })
    key()
    expect(command).not.toHaveBeenCalled()
  })
})

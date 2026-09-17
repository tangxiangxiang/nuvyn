// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { h, nextTick, ref, type Component } from 'vue'
import {
  NConfigProvider,
  NDialogProvider,
  NMessageProvider,
  NNotificationProvider,
} from 'naive-ui'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PromptHost from '../PromptHost.vue'
import ToastHost from '../ToastHost.vue'
import { useI18n } from '../../composables/useI18n'
import { usePrompt } from '../../composables/usePrompt'
import { useToast } from '../../composables/useToast'
import { createNuvynNaiveThemeOverrides } from '../../ui/naiveTheme'

const wrappers: VueWrapper[] = []
let consoleWarnSpy: ReturnType<typeof vi.spyOn> | undefined
let consoleErrorSpy: ReturnType<typeof vi.spyOn> | undefined
let usingFakeTimers = false

function installBrowserApiShims(): void {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as typeof window.matchMedia
  }
  globalThis.matchMedia = window.matchMedia
  if (!window.ResizeObserver) {
    window.ResizeObserver = class ResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  }
  globalThis.ResizeObserver = window.ResizeObserver
  if (!window.requestAnimationFrame) {
    window.requestAnimationFrame = (callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0)
    window.cancelAnimationFrame = (handle: number) => window.clearTimeout(handle)
  }
  globalThis.requestAnimationFrame = window.requestAnimationFrame
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame
  for (const [name, value] of Object.entries({
    '--nuvyn-bg': '#ffffff',
    '--nuvyn-surface-1': '#f9fafb',
    '--nuvyn-border': '#e5e7eb',
    '--nuvyn-divider': '#e5e7eb',
    '--nuvyn-text-1': '#111827',
    '--nuvyn-text-2': '#4b5563',
    '--nuvyn-text-3': '#6b7280',
    '--nuvyn-accent-hover': '#4f46e5',
    '--nuvyn-accent-pressed': '#4338ca',
    '--nuvyn-radius-md': '8px',
    '--nuvyn-font-size-md': '1rem',
    '--sans': 'system-ui',
    '--mono': 'ui-monospace',
  })) document.documentElement.style.setProperty(name, value)
}

function mountWithProviders(host: Component): VueWrapper {
  const wrapper = mount(NConfigProvider, {
    attachTo: document.body,
    global: {
      stubs: { transition: false },
    },
    props: {
      themeOverrides: createNuvynNaiveThemeOverrides('light'),
      preflightStyleDisabled: true,
    },
    slots: {
      default: () => h(NDialogProvider, null, {
        default: () => h(NMessageProvider, null, {
          default: () => h(NNotificationProvider, null, {
            default: () => h(host),
          }),
        }),
      }),
    },
  })
  wrappers.push(wrapper)
  return wrapper
}

async function settleVue(): Promise<void> {
  await nextTick()
  await flushPromises()
  await nextTick()
  if (usingFakeTimers) {
    await vi.advanceTimersByTimeAsync(0)
  } else {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
  }
  await nextTick()
}

function promptDialog(title: string): HTMLElement {
  const dialog = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]'))
    .find((candidate) => getComputedStyle(candidate).display !== 'none' && candidate.textContent?.includes(title))
  if (!dialog) throw new Error(`Missing prompt: ${title}`)
  return dialog
}

async function waitForPrompt(title: string): Promise<HTMLElement> {
  await vi.waitFor(() => expect(() => promptDialog(title)).not.toThrow(), { timeout: 1200 })
  return promptDialog(title)
}

async function waitForNoVisiblePrompt(): Promise<void> {
  await vi.waitFor(() => {
    const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]'))
      .filter((dialog) => getComputedStyle(dialog).display !== 'none')
    expect(dialogs).toHaveLength(0)
  }, { timeout: 1200 })
}

function promptInput(title: string): HTMLInputElement {
  const dialog = promptDialog(title)
  const input = dialog.querySelector<HTMLInputElement>('input')
  if (!input) throw new Error(`Missing prompt input: ${title}`)
  return input
}

function buttonFor(dialog: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
    .find((candidate) => candidate.textContent?.trim() === label)
  if (!button) throw new Error(`Missing button: ${label}`)
  return button
}

function clearToasts(): void {
  const { toasts, dismiss } = useToast()
  for (const toast of toasts.value) dismiss(toast.id)
}

async function waitForNoText(text: string): Promise<void> {
  await vi.waitFor(() => expect(hasVisibleText(text)).toBe(false), { timeout: 1200 })
}

function hasVisibleText(text: string): boolean {
  return Array.from(document.body.querySelectorAll<HTMLElement>('*')).some((element) => {
    if (element.textContent?.trim() !== text) return false
    let current: HTMLElement | null = element
    while (current && current !== document.body) {
      const style = getComputedStyle(current)
      if (current.className.toString().includes('transition-leave') || style.display === 'none' || style.visibility === 'hidden') return false
      current = current.parentElement
    }
    return true
  })
}

beforeEach(() => {
  installBrowserApiShims()
  useI18n().setLocale('zh')
  consoleWarnSpy = vi.spyOn(console, 'warn')
  consoleErrorSpy = vi.spyOn(console, 'error')
})

afterEach(() => {
  clearToasts()
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
  expect(consoleWarnSpy?.mock.calls ?? []).toEqual([])
  expect(consoleErrorSpy?.mock.calls ?? []).toEqual([])
  consoleWarnSpy?.mockRestore()
  consoleErrorSpy?.mockRestore()
  consoleWarnSpy = undefined
  consoleErrorSpy = undefined
  useI18n().setLocale('zh')
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('style')
  vi.useRealTimers()
  usingFakeTimers = false
  vi.unstubAllGlobals()
})

describe('ToastHost Naive bridge', () => {
  it('maps info, success, and error without adding warning to the Nuvyn API', async () => {
    mountWithProviders(ToastHost)
    const toast = useToast()
    expect(toast).not.toHaveProperty('warning')
    toast.info('Info feedback', 0)
    toast.success('Success feedback', 0)
    toast.error('Error feedback', 0)
    await settleVue()

    expect(hasVisibleText('Info feedback')).toBe(true)
    expect(hasVisibleText('Success feedback')).toBe(true)
    expect(hasVisibleText('Error feedback')).toBe(true)
  })

  it('keeps Nuvyn TTL authority for defaults, custom TTL, and ttl zero', async () => {
    vi.useFakeTimers()
    usingFakeTimers = true
    mountWithProviders(ToastHost)
    const toast = useToast()
    toast.info('default info')
    toast.success('default success')
    toast.error('default error')
    toast.info('custom ttl', 100)
    toast.success('manual ttl', 0)
    await settleVue()

    expect(hasVisibleText('default info')).toBe(true)
    expect(hasVisibleText('default success')).toBe(true)
    expect(hasVisibleText('default error')).toBe(true)
    expect(hasVisibleText('custom ttl')).toBe(true)
    expect(hasVisibleText('manual ttl')).toBe(true)

    vi.advanceTimersByTime(100)
    await settleVue()
    expect(hasVisibleText('custom ttl')).toBe(false)
    vi.advanceTimersByTime(2300)
    await settleVue()
    expect(hasVisibleText('default info')).toBe(false)
    expect(hasVisibleText('default success')).toBe(false)
    expect(hasVisibleText('default error')).toBe(true)
    vi.advanceTimersByTime(1701)
    await settleVue()
    expect(hasVisibleText('default error')).toBe(false)
    expect(hasVisibleText('manual ttl')).toBe(true)
  })

  it('supports dismiss, multiple messages, one-to-one removal, and host cleanup', async () => {
    mountWithProviders(ToastHost)
    const toast = useToast()
    const first = toast.info('First message', 0)
    const second = toast.success('Second message', 0)
    await settleVue()
    expect((document.body.textContent?.match(/message/g) ?? []).length).toBe(2)

    toast.dismiss(first)
    await settleVue()
    expect(hasVisibleText('First message')).toBe(false)
    expect(hasVisibleText('Second message')).toBe(true)

    toast.dismiss(second)
    await settleVue()
    await waitForNoText('Second message')

    for (const wrapper of wrappers.splice(0)) wrapper.unmount()

    const hostToggle = ref(true)
    const Harness = {
      setup() {
        return () => hostToggle.value ? h(ToastHost) : null
      },
    }
    mountWithProviders(Harness)
    toast.info('Teardown message', 0)
    await settleVue()
    expect(hasVisibleText('Teardown message')).toBe(true)
    hostToggle.value = false
    await settleVue()
    await waitForNoText('Teardown message')
  })
})

describe('PromptHost Naive bridge', () => {
  it('preserves initial value, placeholder, trim-on-submit, and cancel', async () => {
    mountWithProviders(PromptHost)
    const request = usePrompt().prompt({
      title: 'Rename document',
      placeholder: 'filename',
      initial: 'Draft title',
    })
    await settleVue()

    const input = promptInput('Rename document')
    expect(input.value).toBe('Draft title')
    expect(input.placeholder).toBe('filename')
    input.value = '  Final title  '
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }))
    await expect(request).resolves.toBe('Final title')
  })

  it('returns null for empty submit and Escape, then restores trigger focus', async () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()
    mountWithProviders(PromptHost)
    const empty = usePrompt().prompt({ title: 'Empty prompt' })
    await settleVue()
    promptInput('Empty prompt').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }))
    await expect(empty).resolves.toBeNull()
    await waitForNoVisiblePrompt()
    await vi.waitFor(
      () => expect(document.activeElement).toBe(trigger),
      { timeout: 1200 },
    )

    const escaped = usePrompt().prompt({ title: 'Escape prompt' })
    await waitForPrompt('Escape prompt')
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true }))
    await expect(escaped).resolves.toBeNull()
    await waitForNoVisiblePrompt()
    await vi.waitFor(
      () => expect(document.activeElement).toBe(trigger),
      { timeout: 1200 },
    )
  })

  it('cancels through the Naive backdrop path', async () => {
    mountWithProviders(PromptHost)
    const pending = usePrompt().prompt({ title: 'Backdrop prompt' })
    await settleVue()
    const mask = document.querySelector<HTMLElement>('.n-modal-mask')
    expect(mask).not.toBeNull()
    mask?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    mask?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    await expect(pending).resolves.toBeNull()
    await waitForNoVisiblePrompt()
  })

  it('keeps queued prompts FIFO with isolated input state', async () => {
    mountWithProviders(PromptHost)
    const first = usePrompt().prompt({ title: 'First prompt', initial: 'one' })
    const second = usePrompt().prompt({ title: 'Second prompt', initial: 'two' })
    await settleVue()
    expect(promptInput('First prompt').value).toBe('one')
    expect(document.body.textContent).not.toContain('Second prompt')

    const firstInput = promptInput('First prompt')
    firstInput.value = ' first result '
    firstInput.dispatchEvent(new Event('input', { bubbles: true }))
    buttonFor(promptDialog('First prompt'), '确定').click()
    await expect(first).resolves.toBe('first result')
    const secondDialog = await waitForPrompt('Second prompt')
    expect(promptInput('Second prompt').value).toBe('two')
    buttonFor(secondDialog, '取消').click()
    await expect(second).resolves.toBeNull()
  })

  it('supports sync and async transforms, busy state, and double-submit prevention', async () => {
    mountWithProviders(PromptHost)
    const calls: string[] = []
    let resolveTransform!: (value: string) => void
    const pendingTransform = new Promise<string>((resolve) => { resolveTransform = resolve })
    const sync = usePrompt().prompt({
      title: 'Sync transform',
      initial: 'Hello world',
      actionLabel: 'Translate',
      actionTitle: 'Translate title',
      transform: (value) => value.toUpperCase(),
    })
    await settleVue()
    buttonFor(promptDialog('Sync transform'), 'Translate').click()
    await settleVue()
    expect(promptInput('Sync transform').value).toBe('HELLO WORLD')
    buttonFor(promptDialog('Sync transform'), '取消').click()
    await expect(sync).resolves.toBeNull()

    const asyncRequest = usePrompt().prompt({
      title: 'Async transform',
      initial: 'draft',
      actionLabel: 'Transform',
      transform: async (value) => {
        calls.push(value)
        return pendingTransform
      },
    })
    const dialog = await waitForPrompt('Async transform')
    const action = buttonFor(dialog, 'Transform')
    action.click()
    action.click()
    await settleVue()
    expect(calls).toEqual(['draft'])
    expect(action.disabled).toBe(true)
    resolveTransform('updated')
    await settleVue()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    await nextTick()
    expect(promptInput('Async transform').value).toBe('updated')
    expect(action.disabled).toBe(false)
    buttonFor(promptDialog('Async transform'), '取消').click()
    await expect(asyncRequest).resolves.toBeNull()
  })

  it('keeps a rejected transform open, editable, and free of unhandled console errors', async () => {
    mountWithProviders(PromptHost)
    const request = usePrompt().prompt({
      title: 'Rejecting transform',
      initial: 'retry me',
      actionLabel: 'Retry',
      transform: async () => { throw new Error('expected transform failure') },
    })
    await settleVue()
    const dialog = promptDialog('Rejecting transform')
    const action = buttonFor(dialog, 'Retry')
    action.click()
    await settleVue()
    expect(promptDialog('Rejecting transform')).toBeTruthy()
    expect(action.disabled).toBe(false)
    const input = promptInput('Rejecting transform')
    expect(input.value).toBe('retry me')
    input.value = 'edited'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    buttonFor(promptDialog('Rejecting transform'), '取消').click()
    await expect(request).resolves.toBeNull()
  })

  it('ignores a stale transform resolution after cancellation and does not mutate the next prompt', async () => {
    mountWithProviders(PromptHost)
    let resolveStale!: (value: string) => void
    const staleTransform = new Promise<string>((resolve) => { resolveStale = resolve })
    const stale = usePrompt().prompt({
      title: 'Stale transform',
      initial: 'old',
      actionLabel: 'Transform',
      transform: () => staleTransform,
    })
    await settleVue()
    buttonFor(promptDialog('Stale transform'), 'Transform').click()
    const next = usePrompt().prompt({ title: 'Next prompt', initial: 'next' })
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true }))
    await expect(stale).resolves.toBeNull()
    await waitForPrompt('Next prompt')
    expect(promptInput('Next prompt').value).toBe('next')
    resolveStale('stale result')
    await settleVue()
    expect(promptInput('Next prompt').value).toBe('next')
    buttonFor(promptDialog('Next prompt'), '取消').click()
    await expect(next).resolves.toBeNull()
  })

  it('resolves active and queued prompts on Host teardown', async () => {
    const showHost = ref(true)
    const Harness = {
      setup() {
        return () => showHost.value ? h(PromptHost) : null
      },
    }
    mountWithProviders(Harness)
    const first = usePrompt().prompt({ title: 'Prompt teardown first' })
    const second = usePrompt().prompt({ title: 'Prompt teardown second' })
    await settleVue()
    expect(promptDialog('Prompt teardown first')).toBeTruthy()
    showHost.value = false
    await expect(first).resolves.toBeNull()
    await expect(second).resolves.toBeNull()
    await settleVue()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})

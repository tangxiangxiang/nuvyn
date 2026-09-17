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
import ConfirmHost from '../ConfirmHost.vue'
import { useConfirm } from '../../composables/useConfirm'
import { useI18n } from '../../composables/useI18n'
import { createNuvynNaiveThemeOverrides } from '../../ui/naiveTheme'

const wrappers: VueWrapper[] = []
let consoleWarnSpy: ReturnType<typeof vi.spyOn> | undefined
let consoleErrorSpy: ReturnType<typeof vi.spyOn> | undefined

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
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

function dialogFor(message: string): HTMLElement {
  const dialog = Array.from(document.querySelectorAll<HTMLElement>('[role="alertdialog"], [role="dialog"]'))
    .find((candidate) => getComputedStyle(candidate).display !== 'none' && candidate.textContent?.includes(message))
  if (!dialog) throw new Error(`Missing dialog: ${message}`)
  return dialog
}

async function waitForDialog(message: string): Promise<HTMLElement> {
  await vi.waitFor(() => expect(() => dialogFor(message)).not.toThrow(), { timeout: 1200 })
  return dialogFor(message)
}

async function waitForNoVisibleDialog(): Promise<void> {
  await vi.waitFor(() => {
    const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="alertdialog"], [role="dialog"]'))
      .filter((dialog) => getComputedStyle(dialog).display !== 'none')
    expect(dialogs).toHaveLength(0)
  }, { timeout: 1200 })
}

function buttonFor(dialog: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
    .find((candidate) => candidate.textContent?.trim() === label)
  if (!button) throw new Error(`Missing dialog button: ${label}`)
  return button
}

beforeEach(() => {
  installBrowserApiShims()
  useI18n().setLocale('zh')
  consoleWarnSpy = vi.spyOn(console, 'warn')
  consoleErrorSpy = vi.spyOn(console, 'error')
})

afterEach(() => {
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
  vi.unstubAllGlobals()
})

describe('ConfirmHost Naive bridge', () => {
  it('preserves message, detail, labels, and destructive semantics', async () => {
    mountWithProviders(ConfirmHost)
    const request = useConfirm().confirm('Restore historical version?', 'Stable details', {
      cancelLabel: 'Cancel',
      confirmLabel: 'Restore Version',
      destructive: true,
    })
    await settleVue()

    const dialog = dialogFor('Restore historical version?')
    // Naive's NDialog primitive owns role="dialog"; aria-modal and the
    // message label provide the equivalent accessible modal semantics.
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(dialog.getAttribute('aria-label')).toBe('Restore historical version?')
    expect(dialog.textContent).toContain('Stable details')
    const destructive = buttonFor(dialog, 'Restore Version')
    expect(destructive.className).toContain('n-button--error-type')
    buttonFor(dialog, 'Cancel').click()

    await expect(request).resolves.toBe(false)
  })

  it('focuses the safe Cancel action and restores the trigger after Escape', async () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()
    mountWithProviders(ConfirmHost)
    const request = useConfirm().confirm('Delete this note?')
    await settleVue()

    const dialog = dialogFor('Delete this note?')
    const cancel = buttonFor(dialog, '取消')
    expect(document.activeElement).toBe(cancel)
    expect(buttonFor(dialog, '确定')).not.toBe(document.activeElement)

    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true }))
    await expect(request).resolves.toBe(false)
    await settleVue()
    await waitForNoVisibleDialog()
    expect(document.activeElement).toBe(trigger)
  })

  it('supports external cancellation of a visible dialog and removes it', async () => {
    mountWithProviders(ConfirmHost)
    const pending = useConfirm().confirmCancellable('Cancel me')
    await settleVue()
    expect(dialogFor('Cancel me')).toBeTruthy()

    pending.cancel()
    await expect(pending.promise).resolves.toBe(false)
    await settleVue()
    await waitForNoVisibleDialog()
  })

  it('cancels through the Naive backdrop path', async () => {
    mountWithProviders(ConfirmHost)
    const pending = useConfirm().confirm('Backdrop cancel')
    await settleVue()
    const mask = document.querySelector<HTMLElement>('.n-modal-mask')
    expect(mask).not.toBeNull()
    mask?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    mask?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    await expect(pending).resolves.toBe(false)
    await settleVue()
    await waitForNoVisibleDialog()
  })

  it('cancels queued requests, keeps FIFO order, and never shows a cancelled request', async () => {
    mountWithProviders(ConfirmHost)
    const first = useConfirm().confirm('First request')
    const second = useConfirm().confirmCancellable('Second request')
    const third = useConfirm().confirm('Third request')
    await settleVue()
    expect(dialogFor('First request')).toBeTruthy()
    expect(document.body.textContent).not.toContain('Second request')

    second.cancel()
    await expect(second.promise).resolves.toBe(false)
    buttonFor(dialogFor('First request'), '确定').click()
    await expect(first).resolves.toBe(true)
    await settleVue()
    const thirdDialog = await waitForDialog('Third request')
    expect(thirdDialog).toBeTruthy()
    buttonFor(thirdDialog, '取消').click()
    await expect(third).resolves.toBe(false)
  })

  it('settles exactly once when callbacks race with external cancellation', async () => {
    mountWithProviders(ConfirmHost)
    const pending = useConfirm().confirmCancellable('Race request')
    await settleVue()
    const dialog = dialogFor('Race request')
    const positive = buttonFor(dialog, '确定')

    positive.click()
    pending.cancel()
    await expect(pending.promise).resolves.toBe(true)
    await settleVue()
    await waitForNoVisibleDialog()
    await settleVue()

    const stale = useConfirm().confirmCancellable('Stale request')
    const staleDialog = await waitForDialog('Stale request')
    const stalePositive = buttonFor(staleDialog, '确定')
    stale.cancel()
    stalePositive.click()
    await expect(stale.promise).resolves.toBe(false)
    await settleVue()
    await waitForNoVisibleDialog()
  })

  it('resolves active and queued requests on Host teardown without an orphan dialog', async () => {
    const showHost = ref(true)
    const Harness = {
      setup() {
        return () => showHost.value ? h(ConfirmHost) : null
      },
    }
    mountWithProviders(Harness)
    const first = useConfirm().confirm('Teardown first')
    const second = useConfirm().confirm('Teardown second')
    await settleVue()
    expect(dialogFor('Teardown first')).toBeTruthy()
    showHost.value = false
    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(false)
    await settleVue()
    await waitForNoVisibleDialog()
  })
})

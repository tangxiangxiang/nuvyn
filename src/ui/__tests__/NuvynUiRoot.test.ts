// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineComponent, h, nextTick } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import {
  createMemoryHistory,
  createRouter,
} from 'vue-router'
import {
  darkTheme,
  dateEnUS,
  dateZhCN,
  enUS,
  NConfigProvider,
  NDialogProvider,
  NMessageProvider,
  NNotificationProvider,
  zhCN,
} from 'naive-ui'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import NuvynUiRoot from '../NuvynUiRoot.vue'
import { useI18n } from '../../composables/useI18n'
import { useTheme } from '../../composables/useTheme'
import { nuvynNaivePrimaryColors } from '../naiveTheme'

vi.mock('../../App.vue', async () => {
  const { defineComponent, h, onMounted, ref } = await import('vue')
  const { NInput, useDialog, useMessage, useNotification } = await import('naive-ui')

  return {
    default: defineComponent({
      name: 'ProviderAppProbe',
      setup() {
        const mountCount = ref(0)
        const dialog = useDialog()
        const message = useMessage()
        const notification = useNotification()
        onMounted(() => { mountCount.value += 1 })
        return () => h('section', { 'data-testid': 'app-probe' }, [
          h('output', { 'data-testid': 'app-mount-count' }, String(mountCount.value)),
          h('output', { 'data-testid': 'dialog-provider-ready' }, String(Boolean(dialog))),
          h('output', { 'data-testid': 'message-provider-ready' }, String(Boolean(message))),
          h('output', { 'data-testid': 'notification-provider-ready' }, String(Boolean(notification))),
          h(NInput, { 'data-testid': 'root-input', value: '' }),
        ])
      },
    }),
  }
})

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
}

function mountRoot(): VueWrapper {
  const wrapper = mount(NuvynUiRoot, { attachTo: document.body })
  wrappers.push(wrapper)
  return wrapper
}

function primaryColor(wrapper: VueWrapper): unknown {
  const provider = wrapper.findComponent(NConfigProvider)
  const overrides = provider.props('themeOverrides') as { common?: { primaryColor?: string } } | undefined
  return overrides?.common?.primaryColor
}

beforeEach(() => {
  installBrowserApiShims()
  useTheme().set('light')
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
  useTheme().set('light')
  useI18n().setLocale('zh')
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('NuvynUiRoot', () => {
  it('renders App beneath the complete provider hierarchy with injected APIs', async () => {
    const wrapper = mountRoot()
    await nextTick()

    expect(wrapper.findComponent(NConfigProvider).exists()).toBe(true)
    expect(wrapper.findComponent(NDialogProvider).exists()).toBe(true)
    expect(wrapper.findComponent(NMessageProvider).exists()).toBe(true)
    expect(wrapper.findComponent(NNotificationProvider).exists()).toBe(true)
    expect(wrapper.get('[data-testid="app-probe"]').element).toBeTruthy()
    expect(wrapper.get('[data-testid="dialog-provider-ready"]').text()).toBe('true')
    expect(wrapper.get('[data-testid="message-provider-ready"]').text()).toBe('true')
    expect(wrapper.get('[data-testid="notification-provider-ready"]').text()).toBe('true')
    expect(wrapper.find('[data-testid="root-input"] input').element).toBeTruthy()
  })

  it('bridges Nuvyn theme state to Naive without remounting App', async () => {
    const wrapper = mountRoot()
    const provider = wrapper.findComponent(NConfigProvider)
    await nextTick()

    expect(provider.props('theme')).toBe(null)
    expect(primaryColor(wrapper)).toBe(nuvynNaivePrimaryColors.light)
    expect(wrapper.get('[data-testid="app-mount-count"]').text()).toBe('1')

    useTheme().set('dark')
    await nextTick()
    expect(provider.props('theme')).toBe(darkTheme)
    expect(primaryColor(wrapper)).toBe(nuvynNaivePrimaryColors.dark)
    expect(wrapper.get('[data-testid="app-mount-count"]').text()).toBe('1')

    useTheme().set('light')
    await nextTick()
    expect(provider.props('theme')).toBe(null)
    expect(primaryColor(wrapper)).toBe(nuvynNaivePrimaryColors.light)
    expect(wrapper.get('[data-testid="app-mount-count"]').text()).toBe('1')
  })

  it('bridges Nuvyn locale to Naive locale and dateLocale without remounting App', async () => {
    const wrapper = mountRoot()
    const provider = wrapper.findComponent(NConfigProvider)
    await nextTick()

    expect(provider.props('locale')).toBe(zhCN)
    expect(provider.props('dateLocale')).toBe(dateZhCN)
    expect(wrapper.get('[data-testid="app-mount-count"]').text()).toBe('1')

    useI18n().setLocale('en')
    await nextTick()
    expect(provider.props('locale')).toBe(enUS)
    expect(provider.props('dateLocale')).toBe(dateEnUS)
    expect(wrapper.get('[data-testid="app-mount-count"]').text()).toBe('1')

    useI18n().setLocale('zh')
    await nextTick()
    expect(provider.props('locale')).toBe(zhCN)
    expect(provider.props('dateLocale')).toBe(dateZhCN)
    expect(wrapper.get('[data-testid="app-mount-count"]').text()).toBe('1')
  })

  it('remains installable at the router application boot boundary', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', component: defineComponent({ render: () => h('div') }) }],
    })
    const host = document.createElement('div')
    document.body.append(host)
    const app = (await import('vue')).createApp(NuvynUiRoot)
    app.use(router)
    app.mount(host)
    await router.isReady()
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/')
    app.unmount()

    const mainSource = readFileSync(resolve(process.cwd(), 'src/main.ts'), 'utf8')
    expect(mainSource).toContain("import NuvynUiRoot from './ui/NuvynUiRoot.vue'")
    expect(mainSource).toMatch(/createApp\(NuvynUiRoot\)\.use\(router\)\.mount\('#app'\)/)
  })
})

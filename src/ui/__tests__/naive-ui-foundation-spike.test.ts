// @vitest-environment jsdom
import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick, h } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { build } from 'vite'
import { NConfigProvider, NDatePicker, NIcon, NInput, dateEnUS, dateZhCN, zhCN, type GlobalThemeOverrides } from 'naive-ui'
import { Search } from '@vicons/tabler'
import NaiveUiFoundationSpike from './fixtures/NaiveUiFoundationSpike.vue'

type FixtureProps = {
  themeMode: 'light' | 'dark'
  locale: 'zh' | 'en'
  initialDate?: string
}

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
      observe(): void { /* jsdom has no layout engine */ }
      unobserve(): void { /* jsdom has no layout engine */ }
      disconnect(): void { /* jsdom has no layout engine */ }
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

function installNuvynTokens(): void {
  const tokens: Record<string, string> = {
    '--nuvyn-accent': '#4f46e5',
    '--nuvyn-accent-hover': '#4338ca',
    '--nuvyn-accent-pressed': '#3730a3',
    '--nuvyn-bg': '#ffffff',
    '--nuvyn-surface-1': '#f8fafc',
    '--nuvyn-text-1': '#111827',
    '--nuvyn-text-2': '#374151',
    '--nuvyn-text-3': '#6b7280',
    '--nuvyn-border': '#d1d5db',
  }
  for (const [name, value] of Object.entries(tokens)) document.documentElement.style.setProperty(name, value)
}

function mountFixture(overrides: Partial<FixtureProps> = {}): VueWrapper {
  const wrapper = mount(NaiveUiFoundationSpike, {
    attachTo: document.body,
    global: {
      stubs: {
        transition: false,
        'transition-group': false,
      },
    },
    props: {
      themeMode: 'light',
      locale: 'zh',
      ...overrides,
    },
  })
  wrappers.push(wrapper)
  return wrapper
}

function renderedInlineStyleText(): string {
  return Array.from(document.querySelectorAll('[style]')).map((element) => element.getAttribute('style') ?? '').join('\n')
}

function generatedStyleText(): string {
  return Array.from(document.head.querySelectorAll('style')).map((style) => style.textContent ?? '').join('\n')
}

async function filesInDirectory(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await filesInDirectory(path))
    else files.push(path)
  }
  return files
}

beforeEach(() => {
  installBrowserApiShims()
  installNuvynTokens()
  // Keep the real console behavior while recording calls. A compatibility
  // spike must expose provider or runtime warnings instead of swallowing them.
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
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('style')
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Naive UI foundation compatibility spike', () => {
  it('mounts the provider tree and required primitive controls', () => {
    const wrapper = mountFixture()

    expect(wrapper.get('[data-testid="naive-provider-fixture"]').element).toBeTruthy()
    for (const testId of ['input', 'select', 'checkbox', 'switch', 'date-picker', 'locale-surface']) {
      expect(wrapper.get(`[data-testid="${testId}"]`).element).toBeTruthy()
    }
    return nextTick().then(() => {
      expect(wrapper.get('[data-testid="child-mount-count"]').text()).toBe('1')

      const exportNames = ['Search', 'Settings', 'Plus', 'Calendar', 'Trash', 'Folder', 'File', 'ChevronDown', 'Check', 'AlertTriangle']
      for (const name of exportNames) {
        expect(wrapper.get(`[data-testid="icon-export-probe"] [data-icon="${name}"] svg`).element).toBeTruthy()
      }
    })
  })

  it('keeps text and icon accessible naming separate from decorative glyphs', () => {
    const wrapper = mountFixture()
    const textButton = wrapper.get('[data-testid="text-icon-button"]')
    const iconOnlyButton = wrapper.get('[data-testid="icon-only-button"]')

    expect(textButton.element.tagName).toBe('BUTTON')
    expect(textButton.text()).toContain('Search')
    expect(textButton.attributes('aria-label')).toBeUndefined()
    expect(textButton.find('[role="img"]').attributes('aria-hidden')).toBe('true')
    expect(iconOnlyButton.element.tagName).toBe('BUTTON')
    expect(iconOnlyButton.attributes('aria-label')).toBe('Search notes')
    expect(iconOnlyButton.find('[role="img"]').attributes('aria-hidden')).toBe('true')
    expect(wrapper.get('[data-testid="standalone-icon"]').attributes('aria-hidden')).toBe('true')
  })

  it('preserves Tabler currentColor and lets consumers control icon density', () => {
    const wrapper = mountFixture()
    const standalone = wrapper.get('[data-testid="standalone-icon"]')
    const textIcon = wrapper.get('[data-testid="text-icon-button"]')

    expect(standalone.find('svg g').attributes('stroke')).toBe('currentColor')
    expect(textIcon.find('svg g').attributes('stroke')).toBe('currentColor')
    expect(standalone.attributes('style')).toContain('color: var(--nuvyn-accent)')
    expect(wrapper.get('[data-testid="compact-icon"]').attributes('style')).toContain('font-size: 14px')
    expect(wrapper.get('[data-testid="default-icon"]').attributes('style')).toContain('font-size: 20px')
  })

  it('records the Naive color-parser boundary for direct CSS-var primary colors', () => {
    const directThemeOverrides: GlobalThemeOverrides = {
      common: {
        bodyColor: 'var(--nuvyn-bg)',
        cardColor: 'var(--nuvyn-surface-1)',
        borderColor: 'var(--nuvyn-border)',
        primaryColor: 'var(--nuvyn-accent)',
        primaryColorHover: 'var(--nuvyn-accent-hover)',
        primaryColorPressed: 'var(--nuvyn-accent-pressed)',
      },
    }
    let runtimeError: unknown
    let wrapper: VueWrapper | undefined
    try {
      wrapper = mount(NConfigProvider, {
        attachTo: document.body,
        props: {
          themeOverrides: directThemeOverrides,
          preflightStyleDisabled: true,
        },
        slots: {
          default: () => h(NInput, { value: '' }),
        },
      })
      wrapper.html()
    } catch (error) {
      runtimeError = error
    } finally {
      wrapper?.unmount()
    }

    expect(runtimeError).toBeInstanceOf(Error)
    expect((runtimeError as Error).message).toContain('[seemly/rgba]: Invalid color value var(--nuvyn-accent)')
    expect((runtimeError as Error).stack).toContain('changeColor')
  })

  it('keeps explicit derived and raw CSS variables in mounted Naive runtime styles', async () => {
    const wrapper = mountFixture()
    await nextTick()

    const runtimeStyle = `${renderedInlineStyleText()}\n${generatedStyleText()}`
    expect(runtimeStyle).toContain('var(--nuvyn-accent-hover)')
    expect(runtimeStyle).toContain('var(--nuvyn-accent-pressed)')
    expect(wrapper.get('[data-testid="surface-color-probe"]').attributes('style')).toContain('var(--nuvyn-surface-1)')
    expect(runtimeStyle).toContain('var(--nuvyn-border)')

    const primaryButton = wrapper.get('[data-testid="compact-button"]').element as HTMLButtonElement
    await wrapper.get('[data-testid="compact-button"]').trigger('mouseenter')
    await wrapper.get('[data-testid="compact-button"]').trigger('mousedown')
    primaryButton.focus()
    expect(document.activeElement).toBe(primaryButton)
    expect(primaryButton.disabled).toBe(false)
  })

  it('maps Nuvyn compact/default density to distinct Naive sizes across control states', () => {
    const wrapper = mountFixture()
    const compact = wrapper.get('[data-testid="compact-button"]')
    const defaultButton = wrapper.get('[data-testid="default-button"]')

    expect(compact.classes()).toContain('n-button--small-type')
    expect(defaultButton.classes()).toContain('n-button--medium-type')
    expect(defaultButton.classes()).not.toContain('n-button--large-type')

    for (const testId of ['compact-button', 'default-button']) {
      const element = wrapper.get(`[data-testid="${testId}"]`).element as HTMLButtonElement
      expect(element.tagName).toBe('BUTTON')
      expect(element.disabled).toBe(false)
      element.focus()
      expect(document.activeElement).toBe(element)
    }

    for (const testId of ['compact-disabled-button', 'default-disabled-button']) {
      const element = wrapper.get(`[data-testid="${testId}"]`).element as HTMLButtonElement
      expect(element.disabled).toBe(true)
    }

    for (const testId of ['compact-loading-button', 'default-loading-button']) {
      expect(wrapper.get(`[data-testid="${testId}"]`).classes()).toContain('n-button--loading')
    }
  })

  it('switches light and dark themes without remounting the provider child', async () => {
    const wrapper = mountFixture()
    await nextTick()

    expect(wrapper.get('[data-testid="theme-mode"]').text()).toBe('light')
    expect(wrapper.get('[data-testid="child-mount-count"]').text()).toBe('1')
    await wrapper.setProps({ themeMode: 'dark' })
    await nextTick()
    expect(wrapper.get('[data-testid="theme-mode"]').text()).toBe('dark')
    expect(wrapper.get('[data-testid="child-mount-count"]').text()).toBe('1')
    await wrapper.setProps({ themeMode: 'light' })
    await nextTick()
    expect(wrapper.get('[data-testid="theme-mode"]').text()).toBe('light')
    expect(wrapper.get('[data-testid="child-mount-count"]').text()).toBe('1')

    const renderedTheme = renderedInlineStyleText()
    expect(renderedTheme).toContain('var(--nuvyn-border)')
    expect(renderedTheme).toContain('var(--nuvyn-text-2)')
    expect(renderedTheme).toContain('var(--nuvyn-accent-hover)')
    expect(renderedTheme).toContain('var(--nuvyn-accent-pressed)')
    expect(generatedStyleText()).toContain('.n-button')
  })

  it('switches locale and date locale without remounting the child', async () => {
    const wrapper = mountFixture()
    await nextTick()

    expect(wrapper.get('[data-testid="locale-surface"]').text()).toContain('无数据')
    await wrapper.setProps({ locale: 'en' })
    await nextTick()
    expect(wrapper.get('[data-testid="locale-surface"]').text()).toContain('No Data')
    expect(wrapper.get('[data-testid="child-mount-count"]').text()).toBe('1')
    await wrapper.setProps({ locale: 'zh' })
    await nextTick()
    expect(wrapper.get('[data-testid="locale-surface"]').text()).toContain('无数据')
    expect(wrapper.get('[data-testid="child-mount-count"]').text()).toBe('1')

    const datePanelWeekdays = () => wrapper.findAll('[data-testid="date-locale-panel"] .n-date-panel-weekdays__day').map((day) => day.text())
    const zhWeekdays = datePanelWeekdays()
    await wrapper.setProps({ locale: 'en' })
    await nextTick()
    const enWeekdays = datePanelWeekdays()
    expect(zhWeekdays).toHaveLength(7)
    expect(enWeekdays).toHaveLength(7)
    expect(enWeekdays).not.toEqual(zhWeekdays)
    await wrapper.setProps({ locale: 'zh' })
    await nextTick()
    expect(datePanelWeekdays()).toEqual(zhWeekdays)
  })

  it('proves dateLocale is consumed independently by a real NDatePicker panel', async () => {
    const wrapper = mount(NConfigProvider, {
      attachTo: document.body,
      props: {
        locale: zhCN,
        dateLocale: dateZhCN,
      },
      slots: {
        default: () => h(NDatePicker, {
          panel: true,
          type: 'date',
          defaultCalendarStartTime: Date.UTC(2026, 8, 7, 12),
        }),
      },
    })
    wrappers.push(wrapper)

    const weekdays = () => wrapper.findAll('.n-date-panel-weekdays__day').map((day) => day.text())
    const zhWeekdays = weekdays()
    expect(zhWeekdays).toHaveLength(7)

    await wrapper.setProps({ dateLocale: dateEnUS })
    await nextTick()
    const enWeekdays = weekdays()
    expect(enWeekdays).toHaveLength(7)
    expect(enWeekdays).not.toEqual(zhWeekdays)

    await wrapper.setProps({ dateLocale: dateZhCN })
    await nextTick()
    expect(weekdays()).toEqual(zhWeekdays)
  })

  it('uses provider hooks to create, render, destroy, and tear down overlays', async () => {
    vi.useFakeTimers()
    const wrapper = mountFixture()

    await wrapper.get('[data-testid="show-message"]').trigger('click')
    await nextTick()
    expect(document.body.textContent).toContain('Spike message')
    await wrapper.get('[data-testid="show-dialog"]').trigger('click')
    await nextTick()
    expect(document.body.textContent).toContain('Spike dialog')
    await wrapper.get('[data-testid="show-notification"]').trigger('click')
    await nextTick()
    expect(document.body.textContent).toContain('Spike notification')

    await wrapper.get('[data-testid="destroy-overlays"]').trigger('click')
    await flushPromises()
    await nextTick()
    await vi.advanceTimersByTimeAsync(500)
    expect(document.body.textContent).not.toContain('Spike message')
    expect(document.body.textContent).not.toContain('Spike dialog')
    expect(document.body.textContent).not.toContain('Spike notification')
  })

  it('keeps the Ledger date boundary as a formatted calendar string', async () => {
    const wrapper = mountFixture({ initialDate: '2026-09-07' })
    const input = wrapper.get('[data-testid="date-picker"]').find('input')

    expect(input.element.value).toBe('2026-09-07')
    expect(wrapper.get('[data-testid="formatted-date"]').text()).toBe('2026-09-07')
    await input.setValue('2026-01-01')
    await nextTick()
    expect(wrapper.get('[data-testid="formatted-date"]').text()).toBe('2026-01-01')
  })

  it('keeps formatted dates stable across representative runtime timezones', { timeout: 30_000 }, () => {
    const script = String.raw`
import { JSDOM } from 'jsdom'
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost' })
const win = dom.window
for (const [name, value] of Object.entries({ window: win, document: win.document, navigator: win.navigator, HTMLElement: win.HTMLElement, SVGElement: win.SVGElement, Element: win.Element, Node: win.Node, MutationObserver: win.MutationObserver, Image: win.Image, CSSStyleSheet: win.CSSStyleSheet, getComputedStyle: win.getComputedStyle.bind(win) })) Object.defineProperty(globalThis, name, { configurable: true, value })
class ResizeObserver { observe() {} unobserve() {} disconnect() {} }
Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: ResizeObserver })
win.ResizeObserver = ResizeObserver
win.matchMedia = () => ({ matches: false, media: '', onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false } })
globalThis.matchMedia = win.matchMedia
win.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0)
win.cancelAnimationFrame = (handle) => clearTimeout(handle)
globalThis.requestAnimationFrame = win.requestAnimationFrame
globalThis.cancelAnimationFrame = win.cancelAnimationFrame
const { h } = await import('vue')
const { mount } = await import('@vue/test-utils')
const { NConfigProvider, NDatePicker, zhCN, dateZhCN } = await import('naive-ui')
const values = JSON.parse(process.env.NUVYN_SPIKE_DATES)
for (const value of values) {
  const wrapper = mount(NConfigProvider, { attachTo: document.body, props: { locale: zhCN, dateLocale: dateZhCN }, slots: { default: () => h(NDatePicker, { type: 'date', formattedValue: value, valueFormat: 'yyyy-MM-dd' }) } })
  process.stdout.write(wrapper.find('input').element.value + '\n')
  wrapper.unmount()
}
`
    const dates = ['2026-09-07', '2026-01-01', '2026-12-31']
    const zones = ['America/Los_Angeles', 'Asia/Shanghai']
    for (const zone of zones) {
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: process.cwd(),
        env: { ...process.env, TZ: zone, NUVYN_SPIKE_DATES: JSON.stringify(dates) },
        encoding: 'utf8',
      })
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout.trim().split('\n')).toEqual(dates)
      expect(result.stderr).not.toMatch(/Unhandled|ReferenceError|TypeError/)
    }
  })

  it('tree-shakes a small Tabler entry without bundling the whole catalog', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'nuvyn-tabler-spike-'))
    try {
      await build({
        root: process.cwd(),
        configFile: false,
        logLevel: 'silent',
        build: {
          outDir: outputDir,
          emptyOutDir: true,
          sourcemap: false,
          minify: false,
          rollupOptions: {
            input: resolve(process.cwd(), 'src/ui/__tests__/fixtures/NaiveUiTreeShakingEntry.ts'),
            output: {
              entryFileNames: 'entry.js',
              chunkFileNames: 'chunk-[name].js',
              assetFileNames: 'asset-[name][extname]',
            },
          },
        },
      })

      const outputFiles = await filesInDirectory(outputDir)
      const javascriptFiles = outputFiles.filter((file) => file.endsWith('.js'))
      const output = (await Promise.all(javascriptFiles.map((file) => readFile(file, 'utf8')))).join('\n')

      expect(javascriptFiles.some((file) => file.endsWith('/entry.js') || file.endsWith('entry.js'))).toBe(true)
      expect(output).toContain('Search')
      expect(output).toContain('Settings')
      expect(output).toContain('Calendar')
      // Vite's isolated sample includes the Vue runtime plus the three selected
      // glyph modules. The bound keeps this focused bundle small without
      // pretending that the runtime itself can be tree-shaken away.
      expect(output.length).toBeLessThan(100_000)
      expect(output).not.toContain('AlertTriangle')
      expect(output).not.toContain('ZodiacAquarius')
    } finally {
      await rm(outputDir, { recursive: true, force: true })
    }
  })

  it('server-renders a Tabler glyph through NIcon', async () => {
    const html = await renderToString(h(NIcon, { size: 16, 'aria-hidden': 'true' }, { default: () => h(Search) }))

    expect(html).toContain('<svg')
    expect(html).toContain('stroke="currentColor"')
    expect(html).toContain('aria-hidden="true"')
  })

  it('keeps Naive controls keyboard focusable for the browser focus strategy investigation', () => {
    const wrapper = mountFixture()
    const button = wrapper.get('[data-testid="icon-only-button"]')
    const input = wrapper.get('[data-testid="input"]').find('input')

    const buttonElement = button.element as HTMLElement
    const inputElement = input.element as HTMLInputElement
    buttonElement.focus()
    expect(document.activeElement).toBe(buttonElement)
    expect(button.attributes('tabindex')).not.toBe('-1')
    inputElement.focus()
    expect(document.activeElement).toBe(inputElement)
  })
})

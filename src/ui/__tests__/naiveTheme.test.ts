// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { nextTick, h } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { NConfigProvider, NInput } from 'naive-ui'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createNuvynNaiveThemeOverrides,
  nuvynNaivePrimaryColors,
} from '../naiveTheme'

const tokensCss = readFileSync(resolve(process.cwd(), 'src/ui/tokens.css'), 'utf8')
const styleCss = readFileSync(resolve(process.cwd(), 'src/style.css'), 'utf8')

function cssBlock(selector: string): string {
  const selectorStart = tokensCss.indexOf(`${selector} {`)
  if (selectorStart < 0) throw new Error(`Missing CSS selector: ${selector}`)
  const openBrace = tokensCss.indexOf('{', selectorStart)
  let depth = 0
  for (let index = openBrace; index < tokensCss.length; index += 1) {
    if (tokensCss[index] === '{') depth += 1
    if (tokensCss[index] === '}') {
      depth -= 1
      if (depth === 0) return tokensCss.slice(openBrace + 1, index)
    }
  }
  throw new Error(`Unclosed CSS block: ${selector}`)
}

function cssValue(block: string, token: string): string {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = block.match(new RegExp(`${escaped}\\s*:\\s*([^;]+);`))
  if (!match) throw new Error(`Missing token ${token}`)
  return match[1].trim()
}

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

describe('Nuvyn semantic tokens', () => {
  it('defines the Phase 1 semantic families', () => {
    const required = [
      '--nuvyn-bg', '--nuvyn-surface-1', '--nuvyn-surface-2',
      '--nuvyn-text-1', '--nuvyn-text-2', '--nuvyn-text-3',
      '--nuvyn-border', '--nuvyn-divider',
      '--nuvyn-accent', '--nuvyn-accent-hover', '--nuvyn-accent-pressed',
      '--nuvyn-positive', '--nuvyn-negative', '--nuvyn-warning', '--nuvyn-info',
      '--nuvyn-radius-sm', '--nuvyn-radius-md', '--nuvyn-radius-lg',
      '--nuvyn-space-1', '--nuvyn-space-2', '--nuvyn-space-3',
      '--nuvyn-space-4', '--nuvyn-space-5', '--nuvyn-space-6',
      '--nuvyn-font-size-xs', '--nuvyn-font-size-sm',
      '--nuvyn-font-size-md', '--nuvyn-font-size-lg',
    ]

    for (const token of required) {
      expect(tokensCss).toMatch(new RegExp(`${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`))
    }
  })

  it('preserves the validated light and dark base palette', () => {
    const light = cssBlock(':root')
    const darkFallback = cssBlock(':root:not([data-theme])')
    const explicitLight = cssBlock(":root[data-theme='light']")
    const explicitDark = cssBlock(":root[data-theme='dark']")

    expect(cssValue(light, '--nuvyn-bg')).toBe('#ffffff')
    expect(cssValue(light, '--nuvyn-surface-1')).toBe('#f9fafb')
    expect(cssValue(light, '--nuvyn-text-1')).toBe('#111827')
    expect(cssValue(light, '--nuvyn-text-2')).toBe('#4b5563')
    expect(cssValue(light, '--nuvyn-text-3')).toBe('#6b7280')
    expect(cssValue(light, '--nuvyn-border')).toBe('#e5e7eb')
    expect(cssValue(light, '--nuvyn-accent')).toBe('#6366f1')
    expect(cssValue(light, '--nuvyn-accent-hover')).toBe('#4f46e5')

    expect(cssValue(darkFallback, '--nuvyn-bg')).toBe('#1e1e1e')
    expect(cssValue(darkFallback, '--nuvyn-surface-1')).toBe('#252526')
    expect(cssValue(darkFallback, '--nuvyn-text-1')).toBe('#f9fafb')
    expect(cssValue(darkFallback, '--nuvyn-text-2')).toBe('#d1d5db')
    expect(cssValue(darkFallback, '--nuvyn-text-3')).toBe('#9ca3af')
    expect(cssValue(darkFallback, '--nuvyn-border')).toBe('#374151')
    expect(cssValue(darkFallback, '--nuvyn-accent')).toBe('#818cf8')
    expect(cssValue(darkFallback, '--nuvyn-accent-hover')).toBe('#a5b4fc')

    expect(cssValue(explicitLight, '--nuvyn-bg')).toBe(cssValue(light, '--nuvyn-bg'))
    expect(cssValue(explicitDark, '--nuvyn-bg')).toBe(cssValue(darkFallback, '--nuvyn-bg'))
    expect(cssValue(explicitLight, '--nuvyn-accent')).toBe(cssValue(light, '--nuvyn-accent'))
    expect(cssValue(explicitDark, '--nuvyn-accent')).toBe(cssValue(darkFallback, '--nuvyn-accent'))
  })

  it('keeps legacy aliases in tokens.css and removes competing global definitions', () => {
    const light = cssBlock(':root')
    const aliases: Record<string, string> = {
      '--bg': 'var(--nuvyn-bg)',
      '--bg-soft': 'var(--nuvyn-surface-1)',
      '--text-h': 'var(--nuvyn-text-1)',
      '--text': 'var(--nuvyn-text-2)',
      '--text-muted': 'var(--nuvyn-text-3)',
      '--border': 'var(--nuvyn-border)',
      '--accent': 'var(--nuvyn-accent)',
      '--accent-hover': 'var(--nuvyn-accent-hover)',
      '--code-bg': 'var(--nuvyn-code-bg)',
      '--navbar-vault-bg': 'var(--nuvyn-navbar-vault-bg)',
      '--navbar-vault-border': 'var(--nuvyn-navbar-vault-border)',
    }
    for (const [alias, value] of Object.entries(aliases)) expect(cssValue(light, alias)).toBe(value)

    const globalStylePrefix = styleCss.slice(0, styleCss.indexOf('/* Vault: 3-pane layout */'))
    expect(globalStylePrefix).not.toMatch(/^\s*--(?:bg|bg-soft|text|text-h|text-muted|border|code-bg|accent|accent-hover|navbar-vault-bg|navbar-vault-border)\s*:/m)
    expect(styleCss).not.toMatch(/:root\[data-theme='(?:light|dark)'\]\s*\{\s*--(?:bg|text|border|accent)/)
    expect(styleCss).not.toMatch(/^\s*--nuvyn-/m)
  })

  it('keeps OS fallback and explicit theme precedence structural', () => {
    expect(tokensCss).toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme\]\)/)
    expect(tokensCss.indexOf(":root[data-theme='light']"))
      .toBeGreaterThan(tokensCss.indexOf('@media (prefers-color-scheme: dark)'))
    expect(tokensCss.indexOf(":root[data-theme='dark']"))
      .toBeGreaterThan(tokensCss.indexOf(":root[data-theme='light']"))
  })

  it('does not pull workspace-local token systems into the global authority', () => {
    expect(tokensCss).not.toMatch(/^\s*--(?:vs|ledger)-/m)
    expect(styleCss).toContain('--vs-bg-1')
  })
})

describe('Naive UI theme mapping', () => {
  it('keeps safe fields CSS-backed and mirrors only parser-required primaryColor', () => {
    const light = createNuvynNaiveThemeOverrides('light').common ?? {}
    const dark = createNuvynNaiveThemeOverrides('dark').common ?? {}

    expect(light.bodyColor).toBe('var(--nuvyn-bg)')
    expect(light.cardColor).toBe('var(--nuvyn-surface-1)')
    expect(light.modalColor).toBe('var(--nuvyn-surface-1)')
    expect(light.borderColor).toBe('var(--nuvyn-border)')
    expect(light.dividerColor).toBe('var(--nuvyn-divider)')
    expect(light.primaryColorHover).toBe('var(--nuvyn-accent-hover)')
    expect(light.primaryColorPressed).toBe('var(--nuvyn-accent-pressed)')
    expect(light.primaryColor).toBe(nuvynNaivePrimaryColors.light)
    expect(dark.primaryColor).toBe(nuvynNaivePrimaryColors.dark)

    const concreteFields = Object.entries(light)
      .filter(([, value]) => typeof value === 'string' && !value.startsWith('var('))
      .map(([name]) => name)
    expect(concreteFields).toEqual(['primaryColor'])
  })

  it('keeps the concrete mirror synchronized with CSS accent tokens', () => {
    const light = cssBlock(":root[data-theme='light']")
    const dark = cssBlock(":root[data-theme='dark']")
    expect(nuvynNaivePrimaryColors.light).toBe(cssValue(light, '--nuvyn-accent'))
    expect(nuvynNaivePrimaryColors.dark).toBe(cssValue(dark, '--nuvyn-accent'))
  })

  it('mounts a real NInput without the seemly CSS-var parser error', async () => {
    installBrowserApiShims()
    const wrapper: VueWrapper = mount(NConfigProvider, {
      attachTo: document.body,
      props: {
        themeOverrides: createNuvynNaiveThemeOverrides('light'),
        preflightStyleDisabled: true,
      },
      slots: {
        default: () => h(NInput, { value: '' }),
      },
    })

    await nextTick()
    expect(wrapper.find('input').exists()).toBe(true)
    wrapper.unmount()
  })
})

afterEach(() => {
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('data-theme')
  vi.unstubAllGlobals()
})

beforeEach(() => {
  document.body.innerHTML = ''
})

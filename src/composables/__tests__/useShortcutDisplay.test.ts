// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useShortcutDisplay } from '../useShortcutDisplay'

/* `useShortcutDisplay` resolves `isMac` once at module load from
   `navigator.platform` / `navigator.userAgent`. That's intentional
   (matches `useTheme`'s module-level `theme` ref pattern), but it
   means each platform-mocked test has to reset the module cache and
   re-import — `vi.mock` of `navigator` BEFORE the dynamic import is
   what flips the result. */
async function loadWithPlatform(platform: string, ua: string) {
  vi.resetModules()
  Object.defineProperty(globalThis.navigator, 'platform', { value: platform, configurable: true })
  Object.defineProperty(globalThis.navigator, 'userAgent', { value: ua, configurable: true })
  const mod = await import('../useShortcutDisplay')
  return mod.useShortcutDisplay()
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('useShortcutDisplay — Mac', () => {
  let shortcuts: ReturnType<typeof useShortcutDisplay>
  beforeEach(async () => {
    shortcuts = await loadWithPlatform('MacIntel', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')
  })

  it('detects Mac via platform', () => {
    expect(shortcuts.isMac.value).toBe(true)
  })

  it('formats the primary modifier as ⌘', () => {
    expect(shortcuts.format('mod+P')).toBe('⌘P')
    expect(shortcuts.format('cmd+O')).toBe('⌘O')
  })

  it('formats chord modifiers as Mac glyphs (⌃ ⌥ ⇧)', () => {
    expect(shortcuts.format('shift+mod+Z')).toBe('⇧⌘Z')
    expect(shortcuts.format('alt+tab')).toBe('⌥⇥')
  })

  it('formats non-modifier keys with Mac glyphs (↵ ⎋ ⇥)', () => {
    expect(shortcuts.format('enter')).toBe('↵')
    expect(shortcuts.format('esc')).toBe('⎋')
    expect(shortcuts.format('tab')).toBe('⇥')
  })

  it('preserves unknown keys verbatim', () => {
    expect(shortcuts.format('mod+F5')).toBe('⌘F5')
  })

  it('returns empty string for empty input', () => {
    expect(shortcuts.format('')).toBe('')
  })
})

describe('useShortcutDisplay — non-Mac', () => {
  let shortcuts: ReturnType<typeof useShortcutDisplay>
  beforeEach(async () => {
    shortcuts = await loadWithPlatform('Win32', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
  })

  it('detects non-Mac via platform', () => {
    expect(shortcuts.isMac.value).toBe(false)
  })

  it('formats the primary modifier as Ctrl', () => {
    expect(shortcuts.format('mod+P')).toBe('Ctrl+P')
    expect(shortcuts.format('cmd+O')).toBe('Ctrl+O')
  })

  it('spells out modifiers with +', () => {
    expect(shortcuts.format('shift+mod+Z')).toBe('Shift+Ctrl+Z')
    expect(shortcuts.format('alt+tab')).toBe('Alt+Tab')
  })

  it('spells out non-modifier keys (Enter Esc Tab)', () => {
    expect(shortcuts.format('enter')).toBe('Enter')
    expect(shortcuts.format('esc')).toBe('Esc')
    expect(shortcuts.format('tab')).toBe('Tab')
  })

  it('uppercases single-letter chord segments on non-Mac', () => {
    expect(shortcuts.format('mod+p')).toBe('Ctrl+P')
  })

  it('preserves multi-char literal keys', () => {
    expect(shortcuts.format('mod+F5')).toBe('Ctrl+F5')
    expect(shortcuts.format('mod+PageUp')).toBe('Ctrl+PageUp')
  })
})

describe('useShortcutDisplay — SSR / no navigator', () => {
  it('defaults to non-Mac when navigator is undefined', async () => {
    vi.resetModules()
    /* Wipe navigator so detectMac returns false. We restore it in
       afterEach via vi.restoreAllMocks but that doesn't restore
       globals we removed, so we save + restore explicitly. */
    const origNavigator = globalThis.navigator
    delete (globalThis as { navigator?: unknown }).navigator
    try {
      const mod = await import('../useShortcutDisplay')
      const shortcuts = mod.useShortcutDisplay()
      expect(shortcuts.isMac.value).toBe(false)
      expect(shortcuts.format('mod+P')).toBe('Ctrl+P')
    } finally {
      Object.defineProperty(globalThis, 'navigator', { value: origNavigator, configurable: true, writable: false })
    }
  })
})
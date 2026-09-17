// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { Tab } from '../../../components/vault/tabs'
import { useEditorShortcuts } from './useEditorShortcuts'

function makeHarness(overrides: Partial<Parameters<typeof useEditorShortcuts>[0]> = {}) {
  // The shortcut handler only reads t.path; a minimal stub is enough.
  const tabs = ref<Tab[]>([{ path: '/a.md', title: 'a' } as Tab])
  const activePath = ref<string | null>('/a.md')
  const doSaveNow = vi.fn(async () => {})
  const closeTab = vi.fn(async () => {})
  const selectTab = vi.fn()
  const selectFilesPanel = vi.fn()
  const toggleViewMode = vi.fn()
  const api = useEditorShortcuts({
    tabs,
    activePath,
    doSaveNow,
    closeTab,
    selectTab,
    selectFilesPanel,
    toggleViewMode,
    ...overrides,
  })
  // The composable's public contract is the returned `onKeydown` handler,
  // which VaultView binds via `@keydown`. Drive it directly (same seam the
  // production caller uses) rather than dispatching on window — the
  // composable does not register a global listener.
  function fireKey(key: string, init: Partial<KeyboardEvent> = {}) {
    const ev = new KeyboardEvent('keydown', { key, cancelable: true, ...init })
    api.onKeydown(ev)
    return ev
  }
  return { ...{ tabs, activePath, doSaveNow, closeTab, selectTab, selectFilesPanel, toggleViewMode }, ...api, fireKey }
}

describe('useEditorShortcuts — Cmd/Ctrl+E toggles view mode', () => {
  beforeEach(() => vi.clearAllMocks())

  it('Cmd+E (meta) calls toggleViewMode and preventDefault()', () => {
    const h = makeHarness()
    const ev = h.fireKey('e', { metaKey: true })
    expect(h.toggleViewMode).toHaveBeenCalledOnce()
    expect(ev.defaultPrevented).toBe(true)
  })

  it('Ctrl+E (no meta) calls toggleViewMode', () => {
    const h = makeHarness()
    h.fireKey('e', { ctrlKey: true })
    expect(h.toggleViewMode).toHaveBeenCalledOnce()
  })

  it('Cmd+Shift+E does NOT call toggleViewMode (reserved)', () => {
    const h = makeHarness()
    h.fireKey('e', { metaKey: true, shiftKey: true })
    expect(h.toggleViewMode).not.toHaveBeenCalled()
  })

  it('Cmd+Alt+E does NOT call toggleViewMode', () => {
    const h = makeHarness()
    h.fireKey('e', { metaKey: true, altKey: true })
    expect(h.toggleViewMode).not.toHaveBeenCalled()
  })

  it('plain "e" (no modifier) does NOT call toggleViewMode', () => {
    const h = makeHarness()
    h.fireKey('e')
    expect(h.toggleViewMode).not.toHaveBeenCalled()
  })

  it('missing toggleViewMode callback does not throw and logs a dev warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = makeHarness({ toggleViewMode: undefined })
    expect(() => h.fireKey('e', { metaKey: true })).not.toThrow()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('Cmd+E inside a .monaco-editor container does NOT call toggleViewMode', () => {
    const h = makeHarness()
    const monacoDiv = document.createElement('div')
    monacoDiv.className = 'monaco-editor'
    document.body.appendChild(monacoDiv)
    const inner = document.createElement('span')
    monacoDiv.appendChild(inner)

    const ev = new KeyboardEvent('keydown', { key: 'e', metaKey: true, bubbles: true })
    Object.defineProperty(ev, 'target', { value: inner })
    h.onKeydown(ev)

    expect(h.toggleViewMode).not.toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(false)
    document.body.removeChild(monacoDiv)
  })

  it('Cmd+\\ no longer triggers anything (legacy preview shortcut removed)', () => {
    const h = makeHarness()
    h.fireKey('\\', { metaKey: true })
    expect(h.toggleViewMode).not.toHaveBeenCalled()
    expect(h.doSaveNow).not.toHaveBeenCalled()
  })
})

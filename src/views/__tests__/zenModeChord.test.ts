// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createZenModeChord } from '../zenModeChord'

function harness(overrides: Partial<Parameters<typeof createZenModeChord>[0]> = {}) {
  let active = false
  const toggle = vi.fn(() => { active = !active })
  const exit = vi.fn(() => { active = false })
  const chord = createZenModeChord({
    canToggle: () => true,
    isActive: () => active,
    isBlocked: () => false,
    toggle,
    exit,
    ...overrides,
  })
  function press(key: string, init: Partial<KeyboardEvent> = {}) {
    const event = new KeyboardEvent('keydown', { key, cancelable: true, ...init })
    return { event, handled: chord.onKeydown(event) }
  }
  return { chord, toggle, exit, press }
}

describe('createZenModeChord', () => {
  afterEach(() => vi.useRealTimers())

  it('toggles only on Ctrl/Cmd+K followed by an unmodified Z', () => {
    const h = harness()
    expect(h.press('k', { ctrlKey: true }).event.defaultPrevented).toBe(true)
    expect(h.toggle).not.toHaveBeenCalled()
    expect(h.press('z').handled).toBe(true)
    expect(h.toggle).toHaveBeenCalledOnce()

    h.press('k', { metaKey: true })
    h.press('z')
    expect(h.toggle).toHaveBeenCalledTimes(2)
  })

  it('does not prevent or consume a non-Z second key', () => {
    const h = harness()
    h.press('k', { ctrlKey: true })
    const second = h.press('x')
    expect(second.handled).toBe(false)
    expect(second.event.defaultPrevented).toBe(false)
    expect(h.toggle).not.toHaveBeenCalled()
  })

  it('does not consume other chords as alternate Zen shortcuts', () => {
    const h = harness()
    h.press('k', { ctrlKey: true })
    const second = h.press('e')
    expect(second.handled).toBe(false)
    expect(second.event.defaultPrevented).toBe(false)
    expect(h.toggle).not.toHaveBeenCalled()
  })

  it('does not start in blocked or composing text-entry contexts', () => {
    const blocked = harness({ isBlocked: () => true })
    expect(blocked.press('k', { ctrlKey: true }).event.defaultPrevented).toBe(false)
    expect(blocked.press('z').handled).toBe(false)

    const composing = harness()
    expect(composing.press('k', { ctrlKey: true, isComposing: true }).handled).toBe(false)
    expect(composing.press('z').handled).toBe(false)
    expect(composing.toggle).not.toHaveBeenCalled()
  })

  it('ignores repeats and resets an incomplete chord on timeout', () => {
    vi.useFakeTimers()
    const h = harness()
    h.press('k', { ctrlKey: true })
    expect(h.press('z', { repeat: true }).handled).toBe(false)
    vi.advanceTimersByTime(1000)
    expect(h.press('z').handled).toBe(false)
    expect(h.toggle).not.toHaveBeenCalled()
  })

  it('exits with Escape only when active and unblocked', () => {
    let active = true
    const exit = vi.fn(() => { active = false })
    const h = harness({ isActive: () => active, exit })
    expect(h.press('Escape').handled).toBe(true)
    expect(exit).toHaveBeenCalledOnce()

    const blocked = harness({ isActive: () => true, isBlocked: () => true })
    expect(blocked.press('Escape').handled).toBe(false)
    expect(blocked.exit).not.toHaveBeenCalled()
  })
})

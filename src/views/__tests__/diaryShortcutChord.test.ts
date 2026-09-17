// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDiaryShortcutChord, isDiaryShortcutBlocked, isDiaryTextEntryContext } from '../diaryShortcutChord'

function keyboardEvent(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
}

describe('createDiaryShortcutChord', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('closes a Diary document after D then C and prevents only the completed chord', async () => {
    const close = vi.fn()
    const chord = createDiaryShortcutChord({
      isDiaryDocument: () => true,
      isTextEntryContext: () => false,
      isBlocked: () => false,
      closeDiaryDocument: close,
    })

    const d = keyboardEvent('D')
    const c = keyboardEvent('c')
    expect(chord.onKeydown(d)).toBe(false)
    expect(d.defaultPrevented).toBe(false)
    expect(chord.onKeydown(c)).toBe(true)
    expect(c.defaultPrevented).toBe(true)
    expect(close).toHaveBeenCalledOnce()
    await Promise.resolve()
  })

  it('does not arm in text-entry, blocked, other-workspace, or modifier contexts', () => {
    const close = vi.fn()
    let inDiary = true
    const chord = createDiaryShortcutChord({
      isDiaryDocument: () => inDiary,
      isTextEntryContext: (event) => event.key === 'd',
      isBlocked: () => false,
      closeDiaryDocument: close,
    })
    chord.onKeydown(keyboardEvent('d'))
    chord.onKeydown(keyboardEvent('c'))
    expect(close).not.toHaveBeenCalled()

    chord.onKeydown(keyboardEvent('d', { metaKey: true }))
    chord.onKeydown(keyboardEvent('c'))
    expect(close).not.toHaveBeenCalled()

    inDiary = false
    chord.onKeydown(keyboardEvent('d'))
    chord.onKeydown(keyboardEvent('c'))
    expect(close).not.toHaveBeenCalled()
  })

  it('cancels on a wrong key and after the timeout', () => {
    const close = vi.fn()
    const chord = createDiaryShortcutChord({
      isDiaryDocument: () => true,
      isTextEntryContext: () => false,
      isBlocked: () => false,
      closeDiaryDocument: close,
    })
    chord.onKeydown(keyboardEvent('d'))
    chord.onKeydown(keyboardEvent('x'))
    chord.onKeydown(keyboardEvent('c'))
    expect(close).not.toHaveBeenCalled()

    chord.onKeydown(keyboardEvent('d'))
    vi.advanceTimersByTime(1001)
    chord.onKeydown(keyboardEvent('c'))
    expect(close).not.toHaveBeenCalled()
  })
})

describe('Diary shortcut context guards', () => {
  it('recognizes text-entry and blocking dialog targets', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    expect(isDiaryTextEntryContext(keyboardEvent('d'))).toBe(true)
    input.remove()

    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.appendChild(dialog)
    const event = keyboardEvent('d')
    Object.defineProperty(event, 'target', { value: dialog })
    expect(isDiaryShortcutBlocked(event)).toBe(true)
    dialog.remove()
  })
})

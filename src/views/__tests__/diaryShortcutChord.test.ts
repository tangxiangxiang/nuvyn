// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDiaryShortcutChord, isDiaryShortcutBlocked, isDiaryTextEntryContext } from '../diaryShortcutChord'

function keyboardEvent(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
}

describe('createDiaryShortcutChord', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('goes back from a Diary document after G then B and prevents only the completed chord', async () => {
    const goBack = vi.fn()
    const chord = createDiaryShortcutChord({
      isDiaryDocument: () => true,
      isTextEntryContext: () => false,
      isBlocked: () => false,
      goBack,
    })

    const g = keyboardEvent('G')
    const b = keyboardEvent('b')
    expect(chord.onKeydown(g)).toBe(false)
    expect(g.defaultPrevented).toBe(false)
    expect(chord.onKeydown(b)).toBe(true)
    expect(b.defaultPrevented).toBe(true)
    expect(goBack).toHaveBeenCalledOnce()
    await Promise.resolve()
  })

  it('does not treat the replaced D then C chord as back', () => {
    const goBack = vi.fn()
    const chord = createDiaryShortcutChord({
      isDiaryDocument: () => true,
      isTextEntryContext: () => false,
      isBlocked: () => false,
      goBack,
    })

    chord.onKeydown(keyboardEvent('d'))
    chord.onKeydown(keyboardEvent('c'))

    expect(goBack).not.toHaveBeenCalled()
  })

  it('does not arm in text-entry, blocked, other-workspace, or modifier contexts', () => {
    const goBack = vi.fn()
    let inDiary = true
    const chord = createDiaryShortcutChord({
      isDiaryDocument: () => inDiary,
      isTextEntryContext: (event) => event.key === 'g',
      isBlocked: () => false,
      goBack,
    })
    chord.onKeydown(keyboardEvent('g'))
    chord.onKeydown(keyboardEvent('b'))
    expect(goBack).not.toHaveBeenCalled()

    chord.onKeydown(keyboardEvent('g', { metaKey: true }))
    chord.onKeydown(keyboardEvent('b'))
    expect(goBack).not.toHaveBeenCalled()

    inDiary = false
    chord.onKeydown(keyboardEvent('g'))
    chord.onKeydown(keyboardEvent('b'))
    expect(goBack).not.toHaveBeenCalled()
  })

  it('cancels on a wrong key and after the timeout', () => {
    const goBack = vi.fn()
    const chord = createDiaryShortcutChord({
      isDiaryDocument: () => true,
      isTextEntryContext: () => false,
      isBlocked: () => false,
      goBack,
    })
    chord.onKeydown(keyboardEvent('g'))
    chord.onKeydown(keyboardEvent('x'))
    chord.onKeydown(keyboardEvent('b'))
    expect(goBack).not.toHaveBeenCalled()

    chord.onKeydown(keyboardEvent('g'))
    vi.advanceTimersByTime(1001)
    chord.onKeydown(keyboardEvent('b'))
    expect(goBack).not.toHaveBeenCalled()
  })

  it('does not go back while a text-entry element has focus', () => {
    const goBack = vi.fn()
    const chord = createDiaryShortcutChord({
      isDiaryDocument: () => true,
      isTextEntryContext: isDiaryTextEntryContext,
      isBlocked: () => false,
      goBack,
    })
    const elements = [
      document.createElement('input'),
      document.createElement('textarea'),
      document.createElement('div'),
      document.createElement('div'),
    ]
    elements[2]!.setAttribute('contenteditable', 'true')
    elements[3]!.className = 'monaco-editor'

    for (const element of elements) {
      element.tabIndex = 0
      document.body.appendChild(element)
      element.focus()
      chord.onKeydown(keyboardEvent('g'))
      chord.onKeydown(keyboardEvent('b'))
      element.remove()
    }

    expect(goBack).not.toHaveBeenCalled()
  })
})

describe('Diary shortcut context guards', () => {
  it('recognizes text-entry and blocking dialog targets', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    expect(isDiaryTextEntryContext(keyboardEvent('g'))).toBe(true)
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

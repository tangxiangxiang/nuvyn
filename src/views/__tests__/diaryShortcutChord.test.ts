// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { isDiaryShortcutBlocked, isDiaryTextEntryContext } from '../diaryShortcutChord'

function keyboardEvent(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
}

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

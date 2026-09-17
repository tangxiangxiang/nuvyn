// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { isNuvynShortcutBlocked } from '../keyboard'

describe('Nuvyn shortcut boundary', () => {
  it.each(['input', 'textarea'])('blocks shortcuts from %s elements', (tagName) => {
    const element = document.createElement(tagName)
    document.body.appendChild(element)
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true })
    element.dispatchEvent(event)
    expect(isNuvynShortcutBlocked(event)).toBe(true)
    element.remove()
  })

  it('blocks shortcuts from contenteditable and the explicit Excalidraw root', () => {
    const editor = document.createElement('div')
    editor.contentEditable = 'true'
    const root = document.createElement('div')
    root.dataset.boardExcalidrawRoot = ''
    root.appendChild(editor)
    document.body.appendChild(root)

    const contentEvent = new KeyboardEvent('keydown', { bubbles: true, cancelable: true })
    editor.dispatchEvent(contentEvent)
    const rootEvent = new KeyboardEvent('keydown', { bubbles: true, cancelable: true })
    root.dispatchEvent(rootEvent)

    expect(isNuvynShortcutBlocked(contentEvent)).toBe(true)
    expect(isNuvynShortcutBlocked(rootEvent)).toBe(true)
    root.remove()
  })

  it('allows shortcuts from ordinary Board chrome', () => {
    const button = document.createElement('button')
    document.body.appendChild(button)
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true })
    button.dispatchEvent(event)
    expect(isNuvynShortcutBlocked(event)).toBe(false)
    button.remove()
  })
})

function isElementLike(value: unknown): value is Element {
  return value !== null
    && typeof value === 'object'
    && typeof (value as { matches?: unknown }).matches === 'function'
}

function isEditableElement(element: Element): boolean {
  const tagName = element.tagName.toLowerCase()
  if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') return true
  const contentEditable = element.getAttribute('contenteditable')
  return contentEditable !== null && contentEditable.toLowerCase() !== 'false'
}

/**
 * Nuvyn-level shortcuts must yield to browser text entry and the embedded
 * Excalidraw editor. composedPath keeps this working through React portals
 * and shadow DOM boundaries where event.target/closest alone is unreliable.
 */
export function isNuvynShortcutBlocked(event: Event): boolean {
  const path = event.composedPath()
  if (path.some((entry) => {
    if (!isElementLike(entry)) return false
    return isEditableElement(entry) || entry.matches('[data-board-excalidraw-root], .excalidraw')
  })) return true

  // Some DOM implementations clear composedPath() once dispatch has
  // completed. Walk the target's ancestor chain as a portable fallback.
  let current = isElementLike(event.target) ? event.target : null
  while (current) {
    if (isEditableElement(current) || current.matches('[data-board-excalidraw-root], .excalidraw')) return true
    current = current.parentElement
  }
  return false
}

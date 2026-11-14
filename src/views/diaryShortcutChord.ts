function isTextEntryElement(element: Element | null): boolean {
  if (!element) return false
  return element.matches(
    'input, textarea, select, [contenteditable="true"], [role="textbox"], .monaco-editor',
  ) || Boolean(element.closest(
    'input, textarea, select, [contenteditable="true"], [role="textbox"], .monaco-editor',
  ))
}

export function isDiaryTextEntryContext(event: KeyboardEvent): boolean {
  const target = event.target instanceof Element ? event.target : null
  const active = typeof document !== 'undefined' && document.activeElement instanceof Element
    ? document.activeElement
    : null
  return isTextEntryElement(target) || isTextEntryElement(active)
}

export function isDiaryShortcutBlocked(event: KeyboardEvent): boolean {
  const target = event.target instanceof Element ? event.target : null
  const active = typeof document !== 'undefined' && document.activeElement instanceof Element
    ? document.activeElement
    : null
  return Boolean(target?.closest(
    '[role="dialog"], [aria-modal="true"], .n-modal, .n-dialog, .n-popover',
  ) || active?.closest(
    '[role="dialog"], [aria-modal="true"], .n-modal, .n-dialog, .n-popover',
  ))
}

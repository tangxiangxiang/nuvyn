export interface DiaryShortcutChordOptions {
  isDiaryDocument: () => boolean
  isTextEntryContext: (event: KeyboardEvent) => boolean
  isBlocked: (event: KeyboardEvent) => boolean
  closeDiaryDocument: () => Promise<void> | void
  timeoutMs?: number
}

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

export function createDiaryShortcutChord(options: DiaryShortcutChordOptions) {
  const timeoutMs = options.timeoutMs ?? 1000
  let pending = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let closing = false

  function reset(): void {
    pending = false
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function arm(): void {
    reset()
    pending = true
    timer = setTimeout(reset, timeoutMs)
  }

  function onKeydown(event: KeyboardEvent): boolean {
    if (!options.isDiaryDocument() || options.isTextEntryContext(event) || options.isBlocked(event)) {
      reset()
      return false
    }

    if (event.metaKey || event.ctrlKey || event.altKey) {
      reset()
      return false
    }

    const key = event.key.toLowerCase()
    if (!pending) {
      if (key === 'd') arm()
      return false
    }

    reset()
    if (key !== 'c' || closing) return false

    event.preventDefault()
    closing = true
    void Promise.resolve(options.closeDiaryDocument()).finally(() => {
      closing = false
    })
    return true
  }

  function dispose(): void {
    reset()
  }

  return { onKeydown, reset, dispose }
}

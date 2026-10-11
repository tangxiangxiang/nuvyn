export interface ZenModeChordOptions {
  canToggle: () => boolean
  isActive: () => boolean
  isBlocked: (event: KeyboardEvent) => boolean
  toggle: () => void
  exit: () => void
  timeoutMs?: number
}

export function createZenModeChord(options: ZenModeChordOptions) {
  const timeoutMs = options.timeoutMs ?? 1000
  let pending = false
  let timer: ReturnType<typeof setTimeout> | null = null

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
    if (
      !options.canToggle()
      || event.defaultPrevented
      || event.isComposing
      || event.key === 'Process'
      || event.keyCode === 229
      || options.isBlocked(event)
    ) {
      reset()
      return false
    }

    if (event.repeat) return false

    const key = event.key.toLowerCase()
    const hasModifier = event.ctrlKey || event.metaKey

    if (pending) {
      reset()
      if (hasModifier || event.altKey || event.shiftKey) return false
      if (key !== 'z') return false
      event.preventDefault()
      options.toggle()
      return true
    }

    if (hasModifier && !event.altKey && !event.shiftKey && key === 'k') {
      event.preventDefault()
      arm()
      return true
    }

    if (options.isActive() && key === 'escape' && !hasModifier && !event.altKey && !event.shiftKey) {
      event.preventDefault()
      options.exit()
      return true
    }

    return false
  }

  function dispose(): void {
    reset()
  }

  return { onKeydown, reset, dispose }
}

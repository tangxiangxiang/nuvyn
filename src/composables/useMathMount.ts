import katex from 'katex'
import { onBeforeUnmount, watch, type Ref } from 'vue'

const SELECTOR = '.math-mount:not([data-math-mounted])'
const BASE_OPTIONS = {
  throwOnError: false,
  trust: false,
} as const

export type MathState = 'pending' | 'ready' | 'error'

function setMathState(element: HTMLElement, state: MathState): void {
  element.dataset.mathState = state
}

function decodeMathContent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    // A malformed hand-written placeholder should remain visible rather
    // than making the rest of the article fail to mount.
    return value
  }
}

/** Upgrade all unmounted math placeholders below one rendered article.
 * KaTeX renders synchronously into the existing host; no Vue app is created
 * per formula. The count is useful for focused lifecycle tests. */
export function mountMath(root: HTMLElement): number {
  const placeholders = Array.from(root.querySelectorAll<HTMLElement>(SELECTOR))
  for (const placeholder of placeholders) {
    // Mark before rendering: KaTeX adds children to the host, which can
    // synchronously/async trigger the article MutationObserver again.
    placeholder.dataset.mathMounted = 'true'
    setMathState(placeholder, 'pending')
    const tex = decodeMathContent(placeholder.dataset.content ?? '')
    const displayMode = placeholder.classList.contains('math-block')
    try {
      katex.render(tex, placeholder, { ...BASE_OPTIONS, displayMode })
      if (placeholder.querySelector('.katex-error')) {
        placeholder.classList.add('math-error')
        setMathState(placeholder, 'error')
      } else {
        setMathState(placeholder, 'ready')
      }
    } catch {
      // Preserve the source as text, never as HTML. This keeps a malformed
      // formula local to its placeholder and leaves the article readable.
      placeholder.classList.add('math-error')
      placeholder.textContent = tex
      setMathState(placeholder, 'error')
    }
  }
  return placeholders.length
}

export function useMathMount(articleEl: Ref<HTMLElement | null>): void {
  let observer: MutationObserver | null = null
  let disposed = false
  let scanQueued = false
  let generation = 0

  function scan(): void {
    if (disposed || !articleEl.value) return
    mountMath(articleEl.value)
  }

  function scheduleScan(): void {
    if (disposed || scanQueued) return
    scanQueued = true
    const scheduledGeneration = generation
    queueMicrotask(() => {
      scanQueued = false
      if (disposed || scheduledGeneration !== generation) return
      scan()
    })
  }

  function detachObserver(): void {
    generation += 1
    observer?.disconnect()
    observer = null
    scanQueued = false
  }

  function attachObserver(element: HTMLElement): void {
    detachObserver()
    scan()
    observer = new MutationObserver(scheduleScan)
    observer.observe(element, { childList: true, subtree: true })
  }

  watch(articleEl, (element, _previous, onCleanup) => {
    if (element) attachObserver(element)
    else detachObserver()
    onCleanup(detachObserver)
  }, { immediate: true, flush: 'post' })

  onBeforeUnmount(() => {
    disposed = true
    detachObserver()
  })
}

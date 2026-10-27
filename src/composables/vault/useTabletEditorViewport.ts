import { onBeforeUnmount, watch, type Ref } from 'vue'

export function tabletEditorHeight(top: number, layoutHeight: number, viewport?: { height: number; offsetTop: number; scale: number }): number | null {
  if (!viewport || viewport.scale !== 1) return null
  return Math.max(0, Math.min(layoutHeight, viewport.offsetTop + viewport.height) - top)
}

/** Let Monaco's existing ResizeObserver follow the visible Note container. */
export function useTabletEditorViewport(root: Ref<HTMLElement | null>, enabled: Readonly<Ref<boolean>>): void {
  let cleanup = () => {}
  watch([enabled, root], ([active, element]) => {
    cleanup()
    cleanup = () => {}
    if (!active || !element || !window.visualViewport) return
    const viewport = window.visualViewport
    let frame = 0
    const update = () => {
      frame = 0
      const height = tabletEditorHeight(element.getBoundingClientRect().top, document.documentElement.clientHeight, viewport)
      if (height === null) element.style.removeProperty('--note-tablet-visible-height')
      else element.style.setProperty('--note-tablet-visible-height', `${height}px`)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    viewport.addEventListener('resize', schedule)
    viewport.addEventListener('scroll', schedule)
    window.addEventListener('resize', schedule)
    schedule()
    cleanup = () => {
      cancelAnimationFrame(frame)
      viewport.removeEventListener('resize', schedule)
      viewport.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      element.style.removeProperty('--note-tablet-visible-height')
    }
  }, { immediate: true, flush: 'post' })
  onBeforeUnmount(() => cleanup())
}

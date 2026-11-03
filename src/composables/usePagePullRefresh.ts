import { useMediaQuery } from '@vueuse/core'
import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'

const PULL_THRESHOLD = 76
const PULL_SLOP = 14
const MAX_OFFSET = 54
const BLOCKED_TARGETS = [
  'button', 'a', 'input', 'textarea', 'select', '[contenteditable]',
  '[draggable="true"]', '[role="button"]', '[role="dialog"]',
  '.n-modal', '.n-popover', '.n-dropdown', '.n-data-table',
  '.n-scrollbar', '.n-virtual-list', '.excalidraw',
].join(',')

export function pagePullDirection(deltaX: number, deltaY: number): boolean {
  return Number.isFinite(deltaX) && Number.isFinite(deltaY)
    && deltaY >= PULL_SLOP
    && Math.abs(deltaX) <= Math.max(PULL_SLOP, deltaY * 0.8)
}

/**
 * Pull-to-refresh for naturally scrolling Workspace pages.
 * Never takes an edge/system gesture, native input, horizontal scroller,
 * modal or canvas. On a stale/offscreen route the gesture cannot run.
 */
export function usePagePullRefresh(enabled: Readonly<Ref<boolean>>, refresh: () => Promise<unknown>) {
  const root = ref<HTMLElement | null>(null)
  const compact = useMediaQuery('(max-width: 1199px)')
  const distance = ref(0)
  const refreshing = ref(false)
  const indicatorTop = ref(36)
  const available = computed(() => compact.value && enabled.value)
  const offset = computed(() => `${Math.min(MAX_OFFSET, distance.value * 0.62)}px`)
  const armed = computed(() => distance.value >= PULL_THRESHOLD)
  let fingerId: number | null = null
  let initialX = 0
  let initialY = 0

  function resetGesture(): void {
    fingerId = null
    if (!refreshing.value) distance.value = 0
  }

  function fingerFrom(list: TouchList): Touch | null {
    if (fingerId === null) return null
    for (let index = 0; index < list.length; index++) {
      const finger = list.item(index)
      if (finger?.identifier === fingerId) return finger
    }
    return null
  }

  function onStart(event: TouchEvent): void {
    if (!available.value || refreshing.value || event.touches.length !== 1 || !root.value) return
    const touch = event.touches.item(0)
    if (!touch || touch.clientX < 24 || touch.clientX > window.innerWidth - 24) return
    if ((document.scrollingElement?.scrollTop ?? 0) > 1 || window.scrollY > 1) return
    const path = event.composedPath()
    for (const node of path) {
      if (!(node instanceof HTMLElement)) continue
      if (node === root.value) break
      if (node.matches(BLOCKED_TARGETS)) return
      // A nested scroller owns its own touch gestures even at scrollTop=0.
      const style = window.getComputedStyle(node)
      if (node.scrollHeight > node.clientHeight + 1
        && /^(auto|scroll)$/.test(style.overflowY)) return
      if (node.scrollWidth > node.clientWidth + 1
        && /^(auto|scroll)$/.test(style.overflowX)) return
    }
    fingerId = touch.identifier
    initialX = touch.clientX
    initialY = touch.clientY
    indicatorTop.value = document.querySelector('.navbar')?.getBoundingClientRect().bottom ?? 36
    distance.value = 0
  }

  function onMove(event: TouchEvent): void {
    const finger = fingerFrom(event.touches)
    if (!finger) return
    if (!available.value || event.touches.length !== 1) { resetGesture(); return }
    const dx = finger.clientX - initialX
    const dy = finger.clientY - initialY
    if (dy < 0 || Math.abs(dx) > Math.max(PULL_SLOP, dy * 0.8)) {
      resetGesture()
      return
    }
    distance.value = dy
    if (pagePullDirection(dx, dy) && event.cancelable) event.preventDefault()
  }

  async function triggerRefresh(): Promise<void> {
    if (!available.value || refreshing.value) return
    refreshing.value = true
    distance.value = PULL_THRESHOLD
    try { await refresh() } finally {
      refreshing.value = false
      distance.value = 0
    }
  }

  function onEnd(event: TouchEvent): void {
    if (!fingerFrom(event.changedTouches)) return
    const shouldRefresh = armed.value && available.value
    resetGesture()
    if (shouldRefresh) void triggerRefresh().catch(() => {})
  }

  watch(available, (active) => { if (!active) resetGesture() })
  onMounted(() => {
    const element = root.value
    if (!element) return
    element.addEventListener('touchstart', onStart, { passive: true })
    element.addEventListener('touchmove', onMove, { passive: false })
    element.addEventListener('touchend', onEnd, { passive: true })
    element.addEventListener('touchcancel', resetGesture, { passive: true })
    document.addEventListener('visibilitychange', resetGesture)
  })
  onBeforeUnmount(() => {
    const element = root.value
    element?.removeEventListener('touchstart', onStart)
    element?.removeEventListener('touchmove', onMove)
    element?.removeEventListener('touchend', onEnd)
    element?.removeEventListener('touchcancel', resetGesture)
    document.removeEventListener('visibilitychange', resetGesture)
    resetGesture()
  })
  return { root, available, distance, refreshing, armed, offset, indicatorTop }
}

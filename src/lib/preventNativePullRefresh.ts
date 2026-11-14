export function preventNativePullRefresh(): () => void {
  let start: Touch | null = null

  function onStart(event: TouchEvent): void {
    start = event.touches.length === 1 && window.scrollY <= 1 ? event.touches.item(0) : null
  }

  function onMove(event: TouchEvent): void {
    if (!start || event.defaultPrevented || !event.cancelable || event.touches.length !== 1) return
    const touch = event.touches.item(0)
    if (!touch || touch.identifier !== start.identifier || window.scrollY > 1) return
    const x = Math.abs(touch.clientX - start.clientX)
    const y = touch.clientY - start.clientY
    if (y <= x) return

    for (const node of event.composedPath()) {
      if (node === document.body) break
      // A nested panel may still need to scroll back to its own top.
      if (node instanceof HTMLElement && node.scrollTop > 1
        && /^(auto|scroll)$/.test(getComputedStyle(node).overflowY)) return
    }
    event.preventDefault()
  }

  // Some iOS Safari versions still refresh with overscroll-behavior set.
  document.addEventListener('touchstart', onStart, { passive: true })
  document.addEventListener('touchmove', onMove, { passive: false })
  return () => {
    document.removeEventListener('touchstart', onStart)
    document.removeEventListener('touchmove', onMove)
  }
}

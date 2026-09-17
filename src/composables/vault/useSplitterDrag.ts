// Pointer-drag handler for the two vault splitters (left tree, unified
// right rail). Lives in its own composable
// rather than inside useVaultLayout so the layout composable stays
// focused on persisted reactive state — drag is a pure DOM concern.
//
// The widths / ratio being mutated are owned by useVaultLayout, so we
// accept a `targets` bag of refs rather than re-creating our own state.
// This keeps the single-source-of-truth invariant: any code that
// mutates sidePanelWidth etc. goes through the same module-level ref
// instance that useVaultLayout's grid + persistence watch read from.

import type { Ref } from 'vue'

export type SplitterWhich = 'tree' | 'rightRail'

/* Refs the drag handler is allowed to mutate. Pass the same Ref
   instances useVaultLayout returned — that's what makes the grid
   track width update synchronously as the user drags. */
export interface SplitterTargets {
  sidePanelWidth: Ref<number>
  rightRailWidth: Ref<number>
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}

export function useSplitterDrag(targets: SplitterTargets) {
  function startDrag(host: HTMLElement, which: SplitterWhich, e: PointerEvent) {
    e.preventDefault()
    const rect = host.getBoundingClientRect()
    const startX = e.clientX
    const startTree = targets.sidePanelWidth.value
    const startRightRail = targets.rightRailWidth.value

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      if (which === 'tree') {
        /* Left-anchored column (`.vault` grid template starts with
           `48px {side}px …`). The splitter is the column's RIGHT
           edge, so dragging right (positive dx) moves that edge
           outward → panel grows. */
        const max = Math.min(600, rect.width - 480)
        targets.sidePanelWidth.value = clamp(startTree + dx, 150, max)
      } else if (which === 'rightRail') {
        /* Right-anchored column (grid template ends with `… 1fr 1px
           {rightRail}px`). The splitter is the column's LEFT edge, and
           the right edge is the vault's right border — fixed.
           Dragging right (positive dx) moves the left edge right →
           column shrinks. So we SUBTRACT dx. */
        const compactMax = rect.width < 1100 ? rect.width * 0.38 : rect.width - 480
        const max = Math.min(560, Math.max(280, compactMax))
        targets.rightRailWidth.value = clamp(startRightRail - dx, 280, max)
      }
    }
    const onUp = () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  }

  return { startDrag }
}

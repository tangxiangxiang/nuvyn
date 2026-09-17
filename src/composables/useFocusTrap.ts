// Focus management for modal-style overlays (CommandPalette,
// ConfirmHost, PromptHost). All three of those mount via <Teleport
// to="body"> and need the same three things:
//   1. capture which element had focus before the modal opened
//   2. keep Tab / Shift+Tab cycling inside the modal so a keyboard
//      user doesn't accidentally drop into the underlying vault
//   3. when the modal closes, put focus back on the trigger
//
// The composable is intentionally imperative — consumers call
// activate() / deactivate() at the moment their modal opens and
// closes, and pass a getter returning the modal's root element to
// onTab() so the focus-cycle calculation can find the first / last
// focusable child.
//
// We don't use a watcher on an "is open" ref because the timing is
// fiddly: the consumer toggles a ref, the DOM updates next tick, and
// the container element is only then available. Splitting the
// activate / deactivate calls from the watcher lets the consumer
// call activate() *before* the DOM update (to capture the trigger)
// and the focus-the-first-step runs in the next-tick.

import { nextTick } from 'vue'

/** Return all focusable descendants of `root`, in DOM order. Hidden
 *  and disabled elements are excluded. The selectors cover the
 *  usual suspects — buttons, links, form controls, and any element
 *  with a positive tabindex. We don't try to compute the "tabbing
 *  order" for tabindex > 0 (the modal here has none); a simple
 *  document order is enough for our use. */
function getFocusable(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), '
      + 'textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"]), '
      + '[contenteditable="true"]',
    ),
  ).filter((el) => {
    // offsetParent is null for display:none, position:fixed ancestors
    // also briefly null. We only want to skip genuinely hidden.
    if (el.getAttribute('aria-hidden') === 'true') return false
    if (el.offsetParent === null && el !== document.activeElement) {
      // The currently-focused element may be a fixed-position item
      // whose offsetParent is null; don't filter it out so we can
      // wrap focus to it.
      return el === document.activeElement
    }
    return true
  })
}

export function useFocusTrap() {
  /** The element that had focus just before activate() ran. Stored
   *  on the closure so a fresh modal can find its own trigger
   *  without colliding with another modal's state. */
  let lastFocused: HTMLElement | null = null

  /** Call when the modal opens. Captures the current activeElement
   *  (typically the trigger button) so deactivate() can restore it. */
  function activate() {
    lastFocused = (document.activeElement as HTMLElement | null) ?? null
  }

  /** Call when the modal closes. The next tick waits for the modal
   *  to unmount so the restore target isn't briefly overlapped by
   *  the still-rendered dialog. */
  async function deactivate() {
    await nextTick()
    // nextTick may run after the user has manually moved focus
    // somewhere else; only restore if focus is still on the body or
    // on something inside the (now-unmounted) modal subtree.
    const el = lastFocused
    lastFocused = null
    if (el && document.contains(el)) el.focus()
  }

  /** Tab / Shift+Tab handler. The consumer wires this to a keydown
   *  listener while the modal is open. `rootGetter` returns the
   *  modal's container element; we can't capture it in a closure
   *  because the element may not exist when the listener is bound
   *  and may be re-created on every open. */
  function onTab(rootGetter: () => HTMLElement | null, e: KeyboardEvent) {
    if (e.key !== 'Tab') return
    const root = rootGetter()
    if (!root) return
    const focusables = getFocusable(root)
    if (focusables.length === 0) {
      // No focusable children — keep focus on the container itself
      // so the user isn't bounced back to the trigger.
      e.preventDefault()
      root.focus()
      return
    }
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    const active = document.activeElement as HTMLElement | null
    if (e.shiftKey && (active === first || !root.contains(active))) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && (active === last || !root.contains(active))) {
      e.preventDefault()
      first.focus()
    }
  }

  return { activate, deactivate, onTab }
}

// Post-mount enhancement for `.mermaid-mount` placeholders emitted by
// the ```mermaid``` fence in src/lib/markdown.ts. v-html gives us a
// string → DOM injection with no opportunity to splice Vue components
// in, so the model is:
//
//   1. markdown-it emits a div with the source in `data-content`
//   2. v-html injects that div into the article body
//   3. this composable watches the article + html refs, finds
//      un-mounted `.mermaid-mount` divs, and mounts a Mermaid Vue
//      app at each placeholder's position
//   4. when html changes (new doc / re-render), the old placeholders
//      are removed by Vue and we unmount the orphaned apps
//
// Mirror of useMarkmapMount. We use a separate composable (rather
// than merging the two) so each keeps a simple, single-purpose
// selector and the mount lifecycle for one type of widget doesn't
// run when the other type isn't present. They could be unified
// behind a generic `useDynamicMount(articleEl, { selector, ... })`
// helper, but the indirection has not yet paid for itself.

import { createApp, onBeforeUnmount, unref, watch, type App, type MaybeRef, type Ref } from 'vue'
import Mermaid from '../components/Mermaid.vue'
import type { Theme } from './useTheme'

interface MountedDiagram {
  /** The fresh wrapper div that replaced the placeholder. The Vue
   *  app is mounted into this div. We keep the ref so we can find
   *  it again on the next scan (it's now the article's
   *  `.mermaid-widget` child, not a `.mermaid-mount` placeholder). */
  host: HTMLDivElement
  app: App
}

const SELECTOR = '.mermaid-mount:not([data-mermaid-mounted])'

function decodeMountContent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    // Keep a malformed hand-written placeholder renderable instead of
    // turning a bad data attribute into an uncaught mount error.
    return value
  }
}

export function useMermaidMount(
  articleEl: Ref<HTMLElement | null>,
  renderTheme?: MaybeRef<Theme | undefined>,
) {
  const widgets = new Map<HTMLDivElement, MountedDiagram>()

  function mountAll() {
    const root = articleEl.value
    if (!root) return
    /* Snapshot so DOM mutations during the loop don't trip the
       live HTMLCollection. */
    const placeholders = Array.from(root.querySelectorAll<HTMLDivElement>(SELECTOR))
    for (const ph of placeholders) {
      const code = decodeMountContent(ph.dataset.content ?? '')
      const host = document.createElement('div')
      host.className = 'mermaid-widget-host'
      ph.replaceWith(host)
      const app = createApp(Mermaid, { code, renderTheme: unref(renderTheme) })
      app.mount(host)
      widgets.set(host, { host, app })
    }
  }

  function unmountOrphans() {
    const root = articleEl.value
    for (const [host, w] of widgets) {
      /* A widget is orphaned when its host div is no longer in the
         article. This happens on every re-render — v-html wipes
         the article body and re-injects, so the old hosts
         disappear along with the placeholders they replaced. */
      if (!root || !root.contains(host)) {
        w.app.unmount()
        widgets.delete(host)
      }
    }
  }

  /* A MutationObserver fires on every childList change inside the
     article, which is exactly when v-html swaps in fresh
     placeholders (or the user types and the preview re-renders).
     Each tick: drop orphaned hosts from the previous render, then
     mount whatever placeholders are now present. We watch the
     article ref separately so a brand-new element (component
     remount, route change) gets observed and the old observer is
     disconnected.

     Editor-side throttle: in the reading pane, the article ref is
     bound to a live markdown preview that re-renders on every
     keystroke. The MutationObserver fires per keystroke, and
     `mountAll` does a `createApp` + `mount` per placeholder
     per tick — fast in absolute terms, but a 10-char/second
     typing burst creates ~10 Vue apps per second that each
     need to do their own async mermaid render. We coalesce
     bursts with a trailing debounce: each mutation resets the
     timer; the actual mountAll only runs once the user pauses
     for THROTTLE_MS. The initial attach (no prior mutations)
     still runs immediately so the first paint after v-html
     doesn't flash empty widgets. Reading-mode callers
     (ReadingPane) hit the immediate path too, since
     their v-html settles in a single mutation burst. */
  let observer: MutationObserver | null = null
  let mountThrottleTimer: ReturnType<typeof setTimeout> | null = null
  const THROTTLE_MS = 60

  function scheduleMount() {
    if (mountThrottleTimer !== null) {
      clearTimeout(mountThrottleTimer)
    }
    mountThrottleTimer = setTimeout(() => {
      mountThrottleTimer = null
      unmountOrphans()
      mountAll()
    }, THROTTLE_MS)
  }

  function cancelScheduledMount() {
    if (mountThrottleTimer !== null) {
      clearTimeout(mountThrottleTimer)
      mountThrottleTimer = null
    }
  }

  function attachObserver(el: HTMLElement) {
    observer?.disconnect()
    /* Run an initial scan: the placeholders that arrived via the
       most recent v-html are already in the DOM by the time we
       get here, so without the immediate scan the user would see
       a one-frame flash of empty widgets. The initial path stays
       synchronous on purpose — by definition there's no pending
       keystroke that could supersede this batch. */
    unmountOrphans()
    mountAll()
    observer = new MutationObserver(() => { scheduleMount() })
    observer.observe(el, { childList: true, subtree: true })
  }

  function detachObserver() {
    observer?.disconnect()
    observer = null
    cancelScheduledMount()
    // The article ref can temporarily become null while the component stays
    // mounted (for example during a v-if/document switch). Unmount widgets
    // immediately instead of keeping Vue apps alive on a detached tree until
    // the next article is attached or the owner component is destroyed.
    unmountOrphans()
  }

  /* `watch(articleEl, ...)` doesn't fire on innerHTML re-renders —
     the same element keeps the same ref. The MutationObserver is
     the only reliable trigger; the watch is here just to
     (re)attach the observer when the article element identity
     changes (route change, v-if toggle, etc.). */
  watch(articleEl, (el, _prev, onCleanup) => {
    if (el) attachObserver(el)
    else detachObserver()
    onCleanup(detachObserver)
  }, { immediate: true, flush: 'post' })

  onBeforeUnmount(() => {
    /* Stop any pending throttled mount — otherwise a
       destroy()-then-tick sequence could call mountAll on a
       detached tree. */
    cancelScheduledMount()
    for (const w of widgets.values()) w.app.unmount()
    widgets.clear()
  })
}

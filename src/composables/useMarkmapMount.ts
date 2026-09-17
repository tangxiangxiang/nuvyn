// Post-mount enhancement for `.markmap-mount` placeholders emitted by
// the ```markmap``` fence in src/lib/markdown.ts. v-html gives us a
// string → DOM injection with no opportunity to splice Vue components
// in, so the model is:
//
//   1. markdown-it emits a div with the source in `data-content`
//   2. v-html injects that div into the article body
//   3. this composable watches the article + html refs, finds
//      un-mounted `.markmap-mount` divs, and mounts a MarkMap Vue
//      app at each placeholder's position
//   4. when html changes (new doc / re-render), the old placeholders
//      are removed by Vue and we unmount the orphaned apps
//
// We use Vue's `createApp` (a separate app per widget) rather than
// `h()` + manual `render()` because MarkMap is a full SFC with
// `onMounted` / `onBeforeUnmount` hooks that assume a real app
// context. createApp gives us a teardown handle via `unmount()` for
// free.
//
// The composable is intentionally small and side-effect free at
// module scope — everything is bound to a `useMarkmapMount(articleEl)`
// call so multiple article roots on the same page (e.g. split view)
// can each have their own enhancer.

import { createApp, onBeforeUnmount, unref, watch, type App, type MaybeRef, type Ref } from 'vue'
import MarkMap from '../components/MarkMap.vue'
import type { Theme } from './useTheme'

interface MountedWidget {
  /** The fresh wrapper div that replaced the placeholder. The Vue
   *  app is mounted into this div. We keep the ref so we can find
   *  it again on the next scan (it's now the article's `.markmap-widget`
   *  child, not a `.markmap-mount` placeholder). */
  host: HTMLDivElement
  app: App
}

/* The mount selector. The `:not([data-markmap-mounted])` guard is
   defensive: our mount flow *replaces* the placeholder with a
   `markmap-widget-host` div, so a re-scan on the same DOM tree
   never matches an already-mounted placeholder. The attribute
   guard stays in case a future refactor keeps the placeholder
   in place. */
const SELECTOR = '.markmap-mount:not([data-markmap-mounted])'

function decodeMountContent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    // Keep a malformed hand-written placeholder renderable instead of
    // turning a bad data attribute into an uncaught mount error.
    return value
  }
}

export function useMarkmapMount(
  articleEl: Ref<HTMLElement | null>,
  renderTheme?: MaybeRef<Theme | undefined>,
) {
  /* Tracked widgets keyed by their host div. The key lets us
     `app.unmount()` a widget when its host div leaves the DOM
     (e.g. on a re-render), and also lets us skip re-mounting
     on a no-op watcher tick. */
  const widgets = new Map<HTMLDivElement, MountedWidget>()

  function mountAll() {
    const root = articleEl.value
    if (!root) return
    /* Snapshot so DOM mutations during the loop don't trip the
       live HTMLCollection. */
    const placeholders = Array.from(root.querySelectorAll<HTMLDivElement>(SELECTOR))
    for (const ph of placeholders) {
      const content = decodeMountContent(ph.dataset.content ?? '')
      const host = document.createElement('div')
      host.className = 'markmap-widget-host'
      ph.replaceWith(host)
      const app = createApp(MarkMap, { content, renderTheme: unref(renderTheme) })
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
     article, which is exactly when v-html swaps in fresh placeholders
     (or the user types and the preview re-renders). Each tick: drop
     orphaned hosts from the previous render, then mount whatever
     placeholders are now present. We watch the article ref separately
     so a brand-new element (component remount, route change) gets
     observed and the old observer is disconnected. */
  let observer: MutationObserver | null = null

  function attachObserver(el: HTMLElement) {
    observer?.disconnect()
    /* Run an initial scan: the placeholders that arrived via the
       most recent v-html are already in the DOM by the time we get
       here, so without the immediate scan the user would see a
       one-frame flash of empty widgets. */
    unmountOrphans()
    mountAll()
    observer = new MutationObserver(() => { unmountOrphans(); mountAll() })
    observer.observe(el, { childList: true, subtree: true })
  }

  function detachObserver() {
    observer?.disconnect()
    observer = null
    // `articleEl` may be null during a document switch while this composable
    // itself remains mounted. Tear down orphaned widget apps at that point so
    // they cannot keep observing or rendering a detached tree.
    unmountOrphans()
  }

  /* `watch(articleEl, ...)` doesn't fire on innerHTML re-renders —
     the same element keeps the same ref. The MutationObserver is
     the only reliable trigger; the watch is here just to (re)attach
     the observer when the article element identity changes (route
     change, v-if toggle, etc.). */
  watch(articleEl, (el, _prev, onCleanup) => {
    if (el) attachObserver(el)
    else detachObserver()
    onCleanup(detachObserver)
  }, { immediate: true, flush: 'post' })

  onBeforeUnmount(() => {
    for (const w of widgets.values()) w.app.unmount()
    widgets.clear()
  })
}

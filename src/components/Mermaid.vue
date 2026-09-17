<script setup lang="ts">
// Interactive mermaid diagram. Mounted by useMermaidMount into the
// position of a `.mermaid-mount` placeholder emitted by the
// ```mermaid``` fence rule in src/lib/markdown.ts.
//
// Mirrors the reference VitePress component but takes its theme
// from the Nuvyn `useTheme` composable (or a local render override)
// instead of polling the `dark` class on <html> — Nuvyn themes via
// `data-theme` and we already have a reactive `theme` ref for it.
// mermaid itself is
// async (it lazy-loads per-diagram-type layout engines); the shared
// runtime serializes its process-global configuration while each
// widget keeps only its own DOM/lifecycle state.
//
// We deliberately do NOT use mermaid's `run()` global API — it
// looks for `.mermaid` selectors in the document and re-renders
// everything. We want per-instance control so a theme switch only
// re-renders the widget the user is looking at.
//
// Theme integration: we use mermaid's built-in `default` and
// `dark` themes (the only stable surface for color tokens).
// Earlier we passed a custom `themeVariables` map to rebind
// specific keys to Nuvyn tokens, but unknown keys in
// `themeVariables` interact badly with mermaid's internal
// layout and can produce `<g transform="translate(NaN,NaN) …">`
// in the output. The safer path is: ship mermaid's two built-in
// themes and override their actual color values via CSS in
// style.css (e.g. targeting the generated svg's `fill` /
// `stroke` rules).

import { computed, ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { NButton } from 'naive-ui'
import { useTheme, type Theme } from '../composables/useTheme'
import { runMermaidExclusive } from '../lib/mermaidRuntime'

const props = defineProps<{
  /** Source mermaid syntax the renderer should parse. */
  code: string
  /** Optional local override used by isolated render surfaces such as PDF. */
  renderTheme?: Theme
}>()

const { theme } = useTheme()
const effectiveTheme = computed(() => props.renderTheme ?? theme.value)
const wrapperRef = ref<HTMLDivElement | null>(null)
const containerRef = ref<HTMLDivElement | null>(null)
const renderError = ref<string | null>(null)
type MermaidState = 'pending' | 'ready' | 'error'
/* Consumers must wait for an explicit settled state. The wrapper and even an
   empty SVG can exist while mermaid is still running its async layout. */
const widgetState = ref<MermaidState>('pending')
/* Fullscreen toggle state. The browser owns the actual fullscreen
   bit on `document.fullscreenElement`; we just mirror it into a
   ref so the toolbar icon can flip between enter / exit and so
   the watch below doesn't have to touch the DOM. */
const isFullscreen = ref(false)
/* Pan/zoom lock. Defaults to locked — the markmap convention: the
   diagram is read-only by default; the user has to click the
   toolbar lock to drag/scroll-zoom it. The lock is purely about
   mouse interaction; the explicit toolbar zoom buttons (zoomIn /
   zoomOut) bypass `zoomEnabled` and still work even when locked,
   matching the markmap tooltip's "解锁后可拖动" wording — only
   drag is gated, not explicit button presses. */
const isLocked = ref(true)

/* svg-pan-zoom: lazy-loaded only when the first diagram actually
   renders, so the library stays out of the main bundle. The runtime
   cache is shared by the Mermaid widgets; only the active
   svg-pan-zoom instance remains component-local.

   We track the active instance because re-renders happen on
   theme toggle, code edit, and ResizeObserver ticks. svg-pan-zoom
   attaches mousedown / wheel / touch listeners directly to the
   svg element; without an explicit destroy(), detaching the svg
   (via innerHTML = '') leaves those listeners alive on a
   detached node. The built-in control-icons cluster is disabled
   below so we don't have to worry about leftover icon DOM.

   The toolbar buttons (zoom in / out / reset / lock / fullscreen)
   need a thin slice of the public API — the methods we list here
   are the only ones called from outside. `reset()` fits + centers
   in one call, which is what we want after a fullscreen toggle
   too. The lock path uses `enablePan`/`disablePan` +
   `enableZoom`/`disableZoom` rather than `setOptions` because
   svg-pan-zoom's `setOptions` doesn't reliably re-bind the
   pointer event listeners across the 3.6.x line — the option
   flag flips but the listeners stay live. The explicit enable/
   disable methods are what svg-pan-zoom documents for live
   toggling, so we go through them. All marked optional because
   older svg-pan-zoom builds may not expose them; on those
   versions the lock is a UI hint only (icon flips but drag
   remains enabled), and the lock button's tooltip makes the
   state honest. */
interface SvgPanZoomInstance {
  destroy: () => void
  zoomIn: () => void
  zoomOut: () => void
  reset: () => void
  /* `resize()` re-measures the svg element's bounding rect and
     pushes the new dimensions into svg-pan-zoom's internal
     cache. svg-pan-zoom's other methods (reset, fit, …) read
     from that cache, not from the live DOM, so we have to call
     resize() before reset() whenever the svg's display size
     changes — currently that's just the fullscreen toggle. */
  resize: () => void
  enablePan?: () => void
  disablePan?: () => void
  enableZoom?: () => void
  disableZoom?: () => void
  setOptions?: (options: Record<string, unknown>) => void
}
type SvgPanZoomFn = (svg: SVGSVGElement, opts?: Record<string, unknown>) => SvgPanZoomInstance
let panZoomModule: { default: SvgPanZoomFn } | null = null
let panZoomInstance: SvgPanZoomInstance | null = null

/* Render-generation counter. Incremented at the top of every
   render() pass. Captured by each pending getSvgPanZoom()
   callback so that a late resolution — which started against
   an svgEl that has since been wiped by a newer render — is
   discarded instead of binding a pan/zoom instance to a
   detached element. */
let renderGeneration = 0
let disposed = false

async function getSvgPanZoom(): Promise<SvgPanZoomFn> {
  if (!panZoomModule) {
    panZoomModule = (await import('svg-pan-zoom')) as unknown as { default: SvgPanZoomFn }
  }
  return panZoomModule.default
}

/* Mermaid's layout occasionally emits
   `transform="translate(NaN,NaN) …"` in its output. The browser
   then logs
     <g> attribute transform: Expected number, "translate(NaN,NaN) scale(N…"
   when parsing the svg. This is NOT a JS throw — mermaid.render
   returns the string and the warning surfaces from the svg
   parser, so a try/catch around render() does nothing. The
   fix is a defense in depth:

     1. Don't call render() on a 0-sized container — the layout
        engine needs real dimensions to compute positions. We
        check both `getBoundingClientRect()` (which catches
        transform-scaled ancestors) and `clientWidth` (which is
        cheap).
     2. Defer the first render one rAF so layout has settled.
     3. Detect NaN in the returned svg string and refuse to
        inject the broken svg; show a friendly error instead.

   A ResizeObserver re-runs render() once the container gets a
   real size (tab switch, split toggle, window resize). */
let resizeObserver: ResizeObserver | null = null
let rafId = 0

function hasNonZeroSize(): boolean {
  const el = containerRef.value
  if (!el) return false
  /* jsdom doesn't implement layout; both getters return 0 in
     tests. The real-browser case is 0 (hidden) or >0 (visible)
     — never NaN — so `> 0` is a clean gate. */
  const rect = el.getBoundingClientRect()
  return rect.width > 0 && el.clientWidth > 0
}

function scheduleRender() {
  /* Coalesce: a theme toggle + a code edit landing in the same
     tick should produce one render, not two.

     Two rAFs in a row, not one. The first rAF lets the current
     frame's JS settle (e.g. the theme ref's downstream effects
     have finished mutating the DOM); the second rAF lets the
     browser commit the resulting paint. mermaid's layout engine
     reads the document at render time — if we run on the same
     frame the theme was toggled, the layout sees a half-painted
     state and produces `<g transform="translate(NaN,NaN) …">`.
     A double rAF puts the render in a fresh frame AFTER the
     paint, which is what the size gate alone can't do. */
  if (rafId) return
  rafId = requestAnimationFrame(() => {
    rafId = requestAnimationFrame(() => {
      rafId = 0
      void render()
    })
  })
}

async function render() {
  if (disposed || !containerRef.value) return
  widgetState.value = 'pending'
  renderError.value = null
  if (!hasNonZeroSize()) return
  /* Bump the generation at the top of every render so any
     pending getSvgPanZoom() callback from a previous render can
     detect it has been superseded and bail out. See the
     `renderGeneration` declaration above for the full rationale. */
  const myGen = ++renderGeneration
  /* `document.fonts.ready` resolves once all currently-loading
     fonts have loaded. Mermaid measures text via the canvas
     during layout; if a font with non-Latin glyphs (e.g. the
     system Chinese font used by the demo) hasn't loaded yet,
     the measurement returns 0 width and downstream positions
     can come out as NaN. We race with a 500ms timeout because
     some environments (jsdom, browsers that hang on a missing
     font) never resolve this promise — we'd rather render with
     a stale font metric than block forever. */
  if (typeof document !== 'undefined' && (document as Document).fonts && typeof (document as Document).fonts.ready?.then === 'function') {
    await Promise.race([
      (document as Document).fonts.ready.catch(() => undefined),
      new Promise<void>((r) => setTimeout(r, 500)),
    ])
  }
  if (disposed || myGen !== renderGeneration || !containerRef.value) return
  try {
    const rendered = await runMermaidExclusive(async (mermaid, runtime) => {
      if (disposed || myGen !== renderGeneration || !containerRef.value) return null
      const targetTheme = effectiveTheme.value === 'dark' ? 'dark' : 'default'
      runtime.initialize(targetTheme)
      const allProbeThemes = ['base', 'dark', 'neutral'] as const
      const probeThemes = allProbeThemes.filter((candidate) => candidate !== targetTheme)
      let svg = ''
      let bindFns: ((el: HTMLElement) => void) | undefined
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          if (disposed || myGen !== renderGeneration || !containerRef.value) return null
          const themeForAttempt = attempt === 0
            ? targetTheme
            : probeThemes[(attempt - 1) % probeThemes.length]
          if (attempt > 0) runtime.initialize(themeForAttempt)
          const result = await mermaid.render(runtime.nextId(attempt), props.code)
          if (disposed || myGen !== renderGeneration || !containerRef.value) return null
          const attemptSvg = typeof result === 'string' ? result : result.svg
          if (/translate\(NaN/.test(attemptSvg)) continue
          svg = attemptSvg
          if (typeof result === 'object' && result.bindFunctions) bindFns = result.bindFunctions
          break
        }
        return { svg, bindFns }
      } finally {
        // Probe themes are implementation details; leave the shared Mermaid
        // configuration on the document's actual theme for the next widget.
        runtime.initialize(targetTheme)
      }
    })
    if (disposed || myGen !== renderGeneration || !containerRef.value) return
    const svg = rendered?.svg ?? ''
    const bindFns = rendered?.bindFns
    if (!svg || /translate\(NaN/.test(svg)) {
      renderError.value = '图表布局异常：容器未正确布局或图表含无效字符，请稍后重试'
      widgetState.value = 'error'
      /* Leave the container empty so the broken svg never
         reaches the parser. */
      containerRef.value.innerHTML = ''
      return
    }
    /* Tear down any prior svg-pan-zoom instance before we wipe
       the container. The instance holds listeners on the old
       svg element and DOM control icons inside the container;
       replacing innerHTML detaches the svg but doesn't release
       the listeners, so an explicit destroy() is required. */
    panZoomInstance?.destroy()
    panZoomInstance = null
    containerRef.value.innerHTML = svg
    /* Force the inserted svg to fill the fixed-height widget AND
       center its content. mermaid emits the svg with several pieces
       of inline metadata that all fight our CSS sizing:

         1. Intrinsic `width="W" height="H"` attributes from the
            layout engine.
         2. An inline `style="…"` block — typically including
            `max-width: <Wpx>`, which pins the SVG to its intrinsic
            width regardless of our CSS `width: 100%` rule. Inline
            style has CSS specificity (1,0,0,0); our scoped selector
            `.mermaid-svg :deep(svg)` compiles to (0,2,1). The inline
            style wins, so the SVG stays at intrinsic width even
            though the CSS rule *looks* correct in DevTools' Styles
            panel.
         3. A `preserveAspectRatio` that depends on diagram type and
            `useMaxWidth` — some diagram types emit
            `xMinYMid meet` (left-align), not `xMidYMid meet`.

       Fix: strip the attributes, clear the inline width/height/
       max-width that pin the SVG, then write our own inline
       width/height (inline beats anything else) and force
       `preserveAspectRatio="xMidYMid meet"`. Keep a copy of the
       original viewBox too: svg-pan-zoom consumes the live `viewBox`
       attribute when it builds its viewport transform, while the PDF
       exporter needs that coordinate system after it removes the live
       transform. MarkMap's svg doesn't
       need this because markmap's own `autoFit` runs on the same
       pass that creates the SVG; mermaid hands us a finished string
       that we have to retrofit. */
    const insertedSvg = containerRef.value.querySelector('svg')
    if (insertedSvg) {
      const originalViewBox = insertedSvg.getAttribute('viewBox')
      if (originalViewBox) insertedSvg.setAttribute('data-mermaid-viewbox', originalViewBox)
      insertedSvg.removeAttribute('width')
      insertedSvg.removeAttribute('height')
      insertedSvg.style.width = '100%'
      insertedSvg.style.height = '100%'
      /* mermaid sets `max-width: <intrinsic px>` inline — that's
         the specific culprit pinning the SVG to its intrinsic
         width when the column is wider than the layout. Clear it
         so our 100% can take over. */
      insertedSvg.style.maxWidth = 'none'
      insertedSvg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
    }
    /* bindFunctions wires up click handlers / tooltips for
       interactive diagrams (e.g. classDiagram clickable nodes).
       We use the bindFns from the successful attempt — the
       loop variable always reflects the last iteration. */
    if (bindFns && containerRef.value) bindFns(containerRef.value)
    /* Mermaid's svg has no native pan/zoom — drag/zoom is what
       other sites add via svg-pan-zoom. We dynamic-import the
       module so it stays out of the main bundle until a diagram
       actually renders, and we tag the svg via `dataset` so a
       stray double-render (HMR, ResizeObserver) can't bind a
       second instance to the same element. Failure to load the
       module is swallowed: a render that's visible but not
       draggable is still better than throwing here. */
    const svgEl = containerRef.value.querySelector('svg')
    if (svgEl && !svgEl.dataset.panZoomBound) {
      svgEl.dataset.panZoomBound = '1'
      void getSvgPanZoom().then((svgPanZoom) => {
        /* Two failure modes we have to filter out here:
           1. The component unmounted while the dynamic import
              was in flight — `containerRef.value` was nulled by
              Vue.
           2. A newer render() started after this querySelector
              captured `svgEl`. The container was wiped and a new
              svg inserted. `svgEl` is now detached. The
              generation guard catches this: only the most recent
              render's `.then` may bind. The previous render's
              `panZoomInstance?.destroy()` at the top of the
              newer render already ran (or no-op'd, if this very
              `.then` is the one that produced the instance —
              which is the common case on first render).
           Without this guard, the late callback would overwrite
           `panZoomInstance` with an instance bound to a detached
           svg, and the earlier one (if any) would leak. */
        if (!containerRef.value) return
        if (disposed || myGen !== renderGeneration) return
        panZoomInstance = svgPanZoom(svgEl as SVGSVGElement, {
          zoomEnabled: true,
          /* We render our own toolbar (zoom-in / zoom-out / reset /
             lock / fullscreen) below the widget; svg-pan-zoom's
             built-in +/-/reset cluster would double up with it and
             the library's hardcoded `fill: black` would also fight
             the Nuvyn theme tokens. Keep it off. */
          controlIconsEnabled: false,
          /* `fit: true, center: true` — mirror of MarkMap's
             `autoFit: true`. The widget now has a fixed 480px
             height (matching markmap's footprint), the svg fills
             100% × 100%, and svg-pan-zoom scales the inner content
             to fit that box. `center` puts the diagram in the
             middle when the diagram's aspect doesn't match the
             container's (letterbox). `reset()` re-runs this same
             fit+center. */
          fit: true,
          center: true,
          minZoom: 0.5,
          maxZoom: 10,
        })
        /* Apply the current lock state to the freshly-bound
           svg-pan-zoom instance. svg-pan-zoom defaults
           pan/zoom-enabled to true; the lock defaults to locked,
           so without this apply the widget would render already
           draggable on first paint, contradicting the toolbar's
           locked icon. We use the explicit enable / disable
           methods (not setOptions) because setOptions doesn't
           reliably re-bind the pointer listeners on svg-pan-zoom
           3.6.x — the option flag updates internally but the
           listeners stay live. The explicit methods are what
           svg-pan-zoom documents for live toggling. */
        if (isLocked.value) {
          panZoomInstance.disablePan?.()
          panZoomInstance.disableZoom?.()
        } else {
          panZoomInstance.enablePan?.()
          panZoomInstance.enableZoom?.()
        }
      }).catch(() => { /* diagram still renders, just no drag/zoom */ })
    }
    widgetState.value = 'ready'
  } catch (e) {
    renderError.value = e instanceof Error ? e.message : String(e)
    widgetState.value = 'error'
    containerRef.value?.replaceChildren()
  }
}

/* ---- Toolbar actions ----
   Mirror of MarkMap.vue's toolbar: the buttons are dumb delegates
   to the svg-pan-zoom instance. Each method is a one-liner that
   guards against the (brief) window between component mount and
   the async dynamic-import resolving, where `panZoomInstance` is
   still null. The buttons just no-op in that window — by the time
   the widget is visible to the user, the instance is up. */
function zoomIn() {
  panZoomInstance?.zoomIn()
}
function zoomOut() {
  panZoomInstance?.zoomOut()
}
function resetView() {
  /* svg-pan-zoom's `reset()` is "fit + center" — same as the
     initial render state. We use it for the explicit reset button
     AND after a fullscreen toggle, since the wrapper's box size
     changes and the cached viewport stops matching. */
  panZoomInstance?.reset()
}

function toggleLock() {
  isLocked.value = !isLocked.value
}

function toggleFullscreen() {
  if (!wrapperRef.value) return
  if (document.fullscreenElement) {
    void document.exitFullscreen().catch(() => { /* user denied; harmless */ })
  } else {
    void wrapperRef.value.requestFullscreen().catch(() => { /* user denied; harmless */ })
  }
}
function onFullscreenChange() {
  /* Mirror the browser's fullscreen state into our ref. We compare
     against `wrapperRef.value` rather than checking the boolean
     directly because the user might have fullscreened another
     element (a video player, etc.) and we want our icon to reflect
     "this widget is *not* the fullscreen element". */
  isFullscreen.value = document.fullscreenElement === wrapperRef.value
}

onMounted(() => {
  scheduleRender()
  /* ResizeObserver re-renders on visibility changes (tab switch,
     split open, accordion expand). It only fires scheduleRender
     when the container has a real size — a 0×0 tick during a
     collapse doesn't re-trigger a doomed render. Feature-detect:
     ResizeObserver may be missing in old test environments. */
  if (containerRef.value && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      if (hasNonZeroSize()) scheduleRender()
    })
    resizeObserver.observe(containerRef.value)
  }
  /* Watch the document-level fullscreenchange event so the toolbar
     icon stays in sync if the user presses Esc or right-clicks
     "Exit fullscreen" from the browser chrome. */
  document.addEventListener('fullscreenchange', onFullscreenChange)
  /* If fullscreen was entered before mount finished, sync up the
     initial icon state. */
  onFullscreenChange()
})

onBeforeUnmount(() => {
  disposed = true
  renderGeneration += 1
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0 }
  resizeObserver?.disconnect()
  resizeObserver = null
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  /* Destroy the pan/zoom instance first — it holds listeners on
     the svg and control-icon DOM nodes inside the container.
     Clearing innerHTML below detaches those nodes but doesn't
     release the listeners, so destroy() has to run before. */
  panZoomInstance?.destroy()
  panZoomInstance = null
  /* Clear the rendered svg so the DOMPurify-scrubbed nodes don't
     outlive the component (especially during HMR). */
  if (containerRef.value) containerRef.value.innerHTML = ''
  /* If WE are the fullscreen element at unmount time, exit so the
     browser doesn't keep the body locked for the next mount. */
  if (document.fullscreenElement === wrapperRef.value) {
    void document.exitFullscreen().catch(() => { /* user denied; harmless */ })
  }
})

/* Theme flip → re-render so the diagram re-tints. We go through
   scheduleRender so the render is gated on a non-zero size —
   a theme toggle while the widget is hidden (in a background
   tab) won't paint a broken svg. The ResizeObserver will
   re-trigger once the tab becomes visible. */
watch(effectiveTheme, () => scheduleRender())

/* props.code change (e.g. the markdown source was edited) → re-
   render. */
watch(() => props.code, () => scheduleRender())

/* Fullscreen toggle → resize the svg inline + flip preserveAspectRatio
   + re-fit svg-pan-zoom.

   Why inline style instead of CSS:
   The svg is inserted into `.mermaid-svg` via innerHTML by
   mermaid.render(), so it does NOT carry Vue's [data-v-xxx]
   scope attribute. A scoped selector targeting it has to go
   through `:deep()`, and in practice `.mermaid-widget:fullscreen
   .mermaid-svg :deep(svg) { width: 100% }` doesn't always apply
   on Chromium — possibly because mermaid 11 sets an inline
   `width="…"` presentation attribute that survives the scoped
   selector, or because the `:deep()` chain drops the data-v at
   exactly the wrong specificity boundary. Either way the svg
   stays at its intrinsic dimensions while its container goes
   fullscreen — visibly "small horizontally" even though the
   svg's outer container is the viewport. Inline `style.width =
   '100%'` has specificity (1,0,0,0) — it beats every CSS selector
   AND every presentation attribute — so this is the only knob
   that's guaranteed to take effect. The CSS still sets
   `.mermaid-svg` itself to 100% × 100%, which is reliable; this
   script handles the inner svg specifically.

   preserveAspectRatio flip:
   mermaid emits the svg with `preserveAspectRatio="xMidYMid meet"`
   by default — "scale uniformly to FIT inside the box, leaving
   letterbox space on whichever axis doesn't fit". Once the svg
   IS filling the viewport, a diagram whose intrinsic aspect
   differs (e.g. 4:3 inside a 16:9 viewport) would still look
   narrow — `meet` keeps the diagram at its natural aspect and
   letterboxes the rest. We flip to `xMidYMid slice` ("scale
   uniformly to FILL, cropping the longer axis") in fullscreen
   so the diagram visually fills the viewport; the user can pan
   via svg-pan-zoom to reach any cropped edges, or zoom out to
   see the whole thing. On exit we restore mermaid's default.

   Exit-side width/height attribute cleanup:
   On exiting fullscreen we have to clear BOTH the inline style
   AND mermaid's `width="…"` / `height="…"` presentation
   attributes on the svg. If we only cleared the style
   (`svg.style.width = ''`), the attribute would reassert
   itself and the svg would jump back to its intrinsic
   dimensions — wide diagrams (a long gantt) would then
   overflow the article and trigger a horizontal scrollbar
   that wasn't there before the fullscreen session. Removing
   the attribute is what tells the browser to fall back to
   CSS sizing. We do the same on the `max-width` /
   `min-height` styles we set on entry.

   svg-pan-zoom caches the svg's bounding rect at bind time; on
   the fullscreen transition the cache goes stale. resize() reads
   the current rect and pushes it into the cache; reset() (fit +
   center) then operates against the new size. Without resize()
   the diagram would stay at the pre-fullscreen scale because
   reset() reads from the cache. Order matters: resize() FIRST,
   then reset().

   ResizeObserver doesn't reliably fire across the fullscreen
   transition in every browser (only this widget re-layouts, not
   the article), so a dedicated watcher is needed. */
watch(isFullscreen, (fs) => {
  const svg = containerRef.value?.querySelector('svg')
  if (svg) {
    if (fs) {
      svg.style.width = '100%'
      svg.style.height = '100%'
      svg.style.maxWidth = 'none'
      svg.style.minHeight = '0'
      svg.setAttribute('preserveAspectRatio', 'xMidYMid slice')
    } else {
      /* Clear inline styles first. */
      svg.style.width = ''
      svg.style.height = ''
      svg.style.maxWidth = ''
      svg.style.minHeight = ''
      /* Then remove the presentation attributes mermaid set on
         render — otherwise the attribute reasserts and the svg
         snaps back to its intrinsic dimensions. */
      svg.removeAttribute('width')
      svg.removeAttribute('height')
      svg.removeAttribute('preserveAspectRatio')
    }
  }
  panZoomInstance?.resize()
  panZoomInstance?.reset()
})

/* Lock toggle → flip svg-pan-zoom's pan/zoom listeners in place.
   Mirrors MarkMap.vue's `watch(isLocked, ...)` path: the change
   takes effect immediately because the explicit enable / disable
   methods directly add or remove the pointer listeners, not just
   an option flag. Remount-fallback (the markmap path) would be
   too expensive here — re-mounting re-runs mermaid.render, which
   is a full d3 layout pass, vs. markmap's local redraw. */
watch(isLocked, () => {
  if (!panZoomInstance) return
  if (isLocked.value) {
    panZoomInstance.disablePan?.()
    panZoomInstance.disableZoom?.()
  } else {
    panZoomInstance.enablePan?.()
    panZoomInstance.enableZoom?.()
  }
})
</script>

<template>
  <div
    ref="wrapperRef"
    class="mermaid-widget"
    :data-mermaid-state="widgetState"
    :data-mermaid-ready="widgetState === 'ready' ? 'true' : 'false'"
    :data-mermaid-error="widgetState === 'error' ? (renderError ?? 'unknown') : undefined"
    :aria-busy="widgetState === 'pending' ? 'true' : 'false'"
  >
    <div ref="containerRef" class="mermaid-svg" />
    <div v-if="renderError" class="mermaid-error">
      图表渲染失败:{{ renderError }}
    </div>
    <!-- Toolbar: reveals on hover, mirrors MarkMap.vue's
         `.markmap-toolbar-area` pattern. The five buttons
         delegate to svg-pan-zoom via the panZoomInstance held
         in script setup. Inline SVG icons use `currentColor`
         so they pick up the article's `--text` and follow the
         theme. -->
    <div class="mermaid-toolbar-area">
      <div class="mermaid-toolbar">
        <!-- Lock button: matches MarkMap.vue's `markmap-lock-btn`
             (first slot in the toolbar, same icons, same
             tooltip/aria wording). `data-locked` is exposed on
             the element so a future style override (e.g. a
             tinted background when unlocked) can target the
             state via attribute selector; currently the button
             inherits from `.mermaid-toolbar button` and only the
             icon changes. -->
        <NButton
          attr-type="button"
          text
          :bordered="false"
          @click="toggleLock"
          :title="isLocked ? '解锁后可拖动' : '锁定后不可拖动'"
          :aria-label="isLocked ? '解锁后可拖动' : '锁定后不可拖动'"
          class="mermaid-lock-btn"
          :data-locked="isLocked ? 'true' : 'false'"
        >
          <svg v-if="isLocked" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 9.9-1" />
          </svg>
        </NButton>
        <NButton
          attr-type="button"
          text
          :bordered="false"
          @click="zoomOut"
          title="缩小"
          aria-label="缩小"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
            <line x1="8" y1="11" x2="14" y2="11" />
          </svg>
        </NButton>
        <NButton
          attr-type="button"
          text
          :bordered="false"
          @click="zoomIn"
          title="放大"
          aria-label="放大"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
            <line x1="11" y1="8" x2="11" y2="14" />
            <line x1="8" y1="11" x2="14" y2="11" />
          </svg>
        </NButton>
        <NButton
          attr-type="button"
          text
          :bordered="false"
          @click="resetView"
          title="重置视图"
          aria-label="重置视图"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
            <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
            <path d="M16 16h5v5" />
          </svg>
        </NButton>
        <NButton
          attr-type="button"
          text
          :bordered="false"
          @click="toggleFullscreen"
          :title="isFullscreen ? '退出全屏' : '全屏'"
          :aria-label="isFullscreen ? '退出全屏' : '全屏'"
        >
          <svg v-if="isFullscreen" width="16" height="16" viewBox="0 0 1024 1024" fill="currentColor">
            <path d="M384 128h-85.33v170.67H128V384h256zM896 384v-85.33H725.33V128H640v256zM725.33 725.33H896V640H640v256h85.33zM298.67 896H384V640H128v85.33h170.67z" />
          </svg>
          <svg v-else width="16" height="16" viewBox="0 0 1024 1024" fill="currentColor">
            <path d="M128 384h85.33V213.33H384V128H128zM640 128v85.33h170.67V384H896V128zM810.67 810.67H640V896h256V640h-85.33zM213.33 640H128v256h256v-85.33H213.33z" />
          </svg>
        </NButton>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mermaid-widget {
  position: relative;
  width: 100%;
  /* Fixed-height container, mirroring MarkMap.vue's `.markmap-widget`.
     mermaid's render emits an svg with a viewBox; with the widget at
     a known size and the svg stretched to 100% × 100%, the svg's
     `preserveAspectRatio="xMidYMid meet"` (mermaid's default) fits the
     diagram inside the box, centered, with letterbox on the long axis
     if the diagram's aspect doesn't match. The alternative —
     `height: auto` on the svg — lets the article expand to whatever
     the diagram's intrinsic aspect wants, which is unpredictable
     across diagrams (a 6-node flowchart can blow the column out to
     1500px tall) and makes the article's overall rhythm erratic. */
  height: 480px;
  margin: 0;
  /* Like the markmap, no outer frame. `overflow: hidden` clips any
     letterbox / over-pan inside the widget box. */
  overflow: hidden;
}

.mermaid-svg {
  display: block;
  width: 100%;
  height: 100%;
}
.mermaid-svg :deep(svg) {
  /* Fill the fixed-height container. mermaid's viewBox + the svg's
     default `preserveAspectRatio="xMidYMid meet"` does the actual
     fitting — content scales to fit the box, centered, no crop.
     svg-pan-zoom (`fit: true, center: true`) applies a transform
     that mirrors this; the two layers agree on the scale. */
  display: block;
  width: 100%;
  height: 100%;
}

/* ---- Toolbar ----
   Mirror of MarkMap.vue's `.markmap-toolbar-area` /
   `.markmap-toolbar` pattern: the area is absolutely positioned
   at bottom-right, hidden by default, and reveals on
   `.mermaid-widget:hover` (or while a child has focus, so
   keyboard users can tab to a button and have it stay visible).
   We use the same `--vs-bg-1` / `--vs-border` / `--vs-text-1` /
   `--vs-hover-bg` tokens that markmap does, so the toolbar
   reads as part of the same UI family across widgets. */
.mermaid-toolbar-area {
  position: absolute;
  right: 10px;
  bottom: 10px;
  z-index: 2;
  opacity: 0;
  transition: opacity 0.18s ease;
}
.mermaid-widget:hover .mermaid-toolbar-area,
.mermaid-toolbar-area:focus-within { opacity: 1; }

.mermaid-toolbar {
  display: flex;
  gap: 4px;
  background: var(--vs-bg-1);
  border: 1px solid var(--vs-border);
  border-radius: 6px;
  padding: 2px;
}
.mermaid-toolbar button {
  border: none;
  background: transparent;
  color: var(--vs-text-1);
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  cursor: pointer;
  padding: 0;
}
.mermaid-toolbar button:hover {
  background: var(--vs-hover-bg);
}

/* ---- Fullscreen overrides ----
   The widget itself becomes the fullscreen element. The wrapper
   and `.mermaid-svg` get explicit 100% × 100% sizing here —
   reliable for those, because they DO carry Vue's [data-v-xxx]
   scope attribute and the scoped selector matches them.

   The svg element INSIDE `.mermaid-svg` is handled separately
   by JS — see the `watch(isFullscreen, ...)` handler. mermaid
   injects that svg via innerHTML, so it doesn't carry the scope
   attribute, and the scoped `:deep()` selector chain
   (`.mermaid-widget:fullscreen .mermaid-svg :deep(svg)`) doesn't
   take effect on Chromium in practice. JS sets inline
   `style.width = '100%'`, whose specificity (1,0,0,0) beats any
   selector or presentation attribute. The CSS rule below for
   the inner svg is kept as a fallback / intent-document.

   Padding goes away in fullscreen (no 12px gutters around the
   diagram) and `overflow-x: auto` becomes `overflow: hidden` so
   the diagram doesn't push a horizontal scrollbar when its
   intrinsic width is wider than the viewport. The background
   matches `--bg` so the letterbox area blends with the diagram's
   own background instead of peeking through to the article's
   `--bg-2`. */
.mermaid-widget:fullscreen {
  padding: 0;
  overflow: hidden;
  background: var(--bg);
}
.mermaid-widget:fullscreen .mermaid-svg {
  width: 100%;
  height: 100%;
  min-height: 0;
}
.mermaid-widget:fullscreen .mermaid-svg :deep(svg) {
  /* Fallback only — see the JS path in `watch(isFullscreen, ...)`
     for the rule that actually applies on Chromium. */
  width: 100%;
  height: 100%;
  max-width: none;
}

.mermaid-error {
  color: var(--vs-text-2);
  font-size: 0.9em;
  text-align: center;
  padding: 0.5em;
}
</style>

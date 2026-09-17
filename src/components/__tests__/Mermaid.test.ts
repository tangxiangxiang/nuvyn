// @vitest-environment jsdom
// Tests for the Mermaid.vue component.
//
// Three axes:
//
//   1. Source-level: the component uses mermaid's built-in
//      `default` / `dark` themes (NOT a custom themeVariables
//      object). Custom themeVariables interact badly with
//      mermaid's internal layout and can produce
//      `<g transform="translate(NaN,NaN) …">` in the output —
//      see the regression in test #3. The source check pins the
//      call shape: no themeVariables, just theme name.
//
//   2. Behavior: mounting the component (with a stubbed mermaid
//      module) calls `mermaid.initialize` with the active theme
//      and `mermaid.render` with the supplied code, then injects
//      the returned svg into the container. A theme switch calls
//      render a second time with the new theme.
//
//   3. NaN regression: if mermaid returns an svg containing
//      `translate(NaN`, Mermaid.vue refuses to inject it (the
//      browser would log a parser error AND the diagram would be
//      invisible). The ResizeObserver path retries once the host
//      gets a real size.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/* jsdom doesn't ship matchMedia; useTheme() reads it on first
   import. The defineProperty must run BEFORE the SUT/composable
   imports below, so we do it at the top of the file. */
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
}

import { createApp, h, defineComponent, ref } from 'vue'
import Mermaid from '../Mermaid.vue'
import { useTheme } from '../../composables/useTheme'
import { __testing__ as mermaidRuntimeTesting } from '../../lib/mermaidRuntime'

/* Counters that survive across the dynamic import() inside
   Mermaid.vue. We bump them from the mocked module factory. The
   vitest mock factory is evaluated at module-init time, before
   the `const …` line below would otherwise run — but we keep the
   arrays on globalThis so the factory (which hoists above the
   const) and the test code see the same instance. */
interface MermaidTestCounters {
  initializeCalls: Array<Record<string, unknown>>
  renderCalls: Array<{ id: string; code: string }>
  /* `null` = "use the default stub svg" (clean). A non-null
     string is the svg that the mocked `render` will return.
     If it's an array, the i-th render() call returns the i-th
     entry (or the last entry if the index exceeds the array
     length) — used to simulate mermaid's NaN-then-clean
     sequence for the retry test. */
  overrideSvg: string | string[] | null
  bindFunctionCalls: number
  deferRenders: boolean
  renderWaiters: Array<{ resolve: () => void; code: string }>
}
interface SvgPanZoomInstanceSpy {
  destroy: ReturnType<typeof vi.fn>
  zoomIn: ReturnType<typeof vi.fn>
  zoomOut: ReturnType<typeof vi.fn>
  reset: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  /* Lock path uses the explicit enable / disable methods
     (setOptions doesn't reliably re-bind pointer listeners in
     svg-pan-zoom 3.6.x). All optional so existing tests that
     don't touch the lock path keep passing — the watch
     fall-throughs to a no-op when the method is missing. */
  enablePan?: ReturnType<typeof vi.fn>
  disablePan?: ReturnType<typeof vi.fn>
  enableZoom?: ReturnType<typeof vi.fn>
  disableZoom?: ReturnType<typeof vi.fn>
}
interface SvgPanZoomTestCounters {
  /* One entry per call to svgPanZoom(svg, opts). Mermaid.vue's
     bind path runs once per fresh svg, so the count equals the
     number of successful renders. */
  constructCalls: Array<{ svg: SVGSVGElement; opts: Record<string, unknown> | undefined; instance: SvgPanZoomInstanceSpy }>
}
const g = globalThis as typeof globalThis & {
  __mermaidTest?: MermaidTestCounters
  __svgPanZoomTest?: SvgPanZoomTestCounters
}
g.__mermaidTest = {
  initializeCalls: [],
  renderCalls: [],
  overrideSvg: null,
  bindFunctionCalls: 0,
  deferRenders: false,
  renderWaiters: [],
}
g.__svgPanZoomTest = {
  constructCalls: [],
}

const cleanStubSvg = (id: string, code: string) =>
  `<svg data-mock-svg data-id="${id}"><text>${code}</text></svg>`

vi.mock('mermaid', () => ({
  default: {
    initialize(config: Record<string, unknown>) {
      const t = (globalThis as typeof globalThis & { __mermaidTest?: MermaidTestCounters }).__mermaidTest
      if (t) t.initializeCalls.push({ ...config })
    },
    async render(id: string, code: string) {
      const t = (globalThis as typeof globalThis & { __mermaidTest?: MermaidTestCounters }).__mermaidTest
      if (!t) return { svg: '', bindFunctions() { /* */ } }
      t.renderCalls.push({ id, code })
      if (t.deferRenders) {
        await new Promise<void>((resolve) => {
          t.renderWaiters.push({ resolve, code })
        })
      }
      const override = t.overrideSvg
      let svg: string
      if (Array.isArray(override)) {
        const i = Math.min(t.renderCalls.length - 1, override.length - 1)
        svg = override[i] ?? cleanStubSvg(id, code)
      } else {
        svg = override ?? cleanStubSvg(id, code)
      }
      return {
        svg,
        bindFunctions() {
          t.bindFunctionCalls += 1
        },
      }
    },
  },
}))

vi.mock('svg-pan-zoom', () => {
  /* The real svg-pan-zoom module's default export is a factory
     that takes an svg + options and returns an instance. We
     mimic that shape, then expose spies on every method so
     tests can assert on what Mermaid.vue called. */
  return {
    default: vi.fn((svg: SVGSVGElement, opts?: Record<string, unknown>) => {
      const t = (globalThis as typeof globalThis & { __svgPanZoomTest?: SvgPanZoomTestCounters }).__svgPanZoomTest
      const instance: SvgPanZoomInstanceSpy = {
        destroy: vi.fn(),
        zoomIn: vi.fn(),
        zoomOut: vi.fn(),
        reset: vi.fn(),
        resize: vi.fn(),
      }
      if (t) t.constructCalls.push({ svg, opts, instance })
      return instance
    }),
  }
})

/* Stub the layout-reading getters on the .mermaid-svg container
   so Mermaid.vue's `hasNonZeroSize()` gate passes — jsdom doesn't
   implement layout and returns 0 for both. Real browsers report
   a positive number for a visible element, which is what we
   approximate here. */
function stubLayout(el: HTMLElement, width: number): void {
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: width })
  el.getBoundingClientRect = () => ({
    x: 0, y: 0, top: 0, left: 0, right: width, bottom: 100,
    width, height: 100,
    toJSON() { return this },
  })
}

function mountStandalone(renderTheme?: 'light' | 'dark'): { host: HTMLDivElement; unmount: () => void } {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(defineComponent({
    setup() { return () => h(Mermaid, { code: 'graph TD\n  A --> B', renderTheme }) },
  }))
  app.mount(host)
  const container = host.querySelector<HTMLElement>('.mermaid-svg')
  if (container) stubLayout(container, 800)
  return { host, unmount: () => { app.unmount(); host.remove() } }
}

/* await nextTick() flushes Vue's scheduler but doesn't drain a
   microtask chain that includes a dynamic import() of a previously
   uncached module. The settle() helper gives the test a few
   macrotask turns to let the mermaid dynamic import resolve and
   the render() call land. The rAF that Mermaid.vue uses for the
   first render also needs a frame. */
async function settle(rounds = 5) {
  /* jsdom's `requestAnimationFrame` is polyfilled as
     `setTimeout(cb, 16)`. Mermaid.vue's scheduleRender queues
     a DOUBLE rAF (to let a pending theme-toggle paint settle
     before the layout-sensitive render). Total wait = 2 × 16ms
     = 32ms. 5 × 20ms = 100ms gives us comfortable headroom for
     the dynamic import + the mermaid mock to land too. */
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((r) => setTimeout(r, 20))
  }
}

beforeEach(() => {
  mermaidRuntimeTesting.reset()
  const t = g.__mermaidTest
  if (t) {
    t.initializeCalls.length = 0
    t.renderCalls.length = 0
    t.overrideSvg = null
    t.bindFunctionCalls = 0
    t.deferRenders = false
    t.renderWaiters.length = 0
  }
  const pt = g.__svgPanZoomTest
  if (pt) pt.constructCalls.length = 0
  /* Force a clean theme between tests — useTheme is a module
     singleton and previous tests may have flipped it to dark. */
  useTheme().set('light')
})

describe('Mermaid uses built-in themes (no custom themeVariables)', () => {
  it('does not pass themeVariables to mermaid.initialize', () => {
    /* Custom themeVariables can interact badly with mermaid's
       internal layout and produce `<g transform="translate(NaN,NaN) …">`
       in the output. We pin the call shape here: mermaid
       receives only the theme name and securityLevel, never a
       themeVariables object. Theme integration is done via CSS
       overrides on the generated svg (see style.css). */
    const src = readFileSync(
      resolve(__dirname, '..', 'Mermaid.vue'),
      'utf8',
    )
    expect(src).not.toMatch(/themeVariables\s*:/)
    expect(src).not.toMatch(/function\s+themeVars\b/)
    /* The two built-in theme names are still wired up. */
    expect(src).toContain("'dark'")
    expect(src).toContain("'default'")
  })
})

describe('Mermaid mount + render', () => {
  it('calls initialize + render on mount and writes the svg into the container', async () => {
    const { unmount, host } = mountStandalone()
    await settle()

    /* The mermaid module was imported, initialize was called once
       with theme: 'default' (test starts in light mode), and
       render was called once with the supplied code. */
    expect(g.__mermaidTest!.initializeCalls.length).toBe(1)
    expect(g.__mermaidTest!.initializeCalls[0]).toMatchObject({
      theme: 'default',
      startOnLoad: false,
      securityLevel: 'strict',
    })
    /* themeVariables must NOT be in the call — see source test. */
    expect(g.__mermaidTest!.initializeCalls[0]).not.toHaveProperty('themeVariables')
    expect(g.__mermaidTest!.renderCalls.length).toBe(1)
    expect(g.__mermaidTest!.renderCalls[0].code).toBe('graph TD\n  A --> B')

    /* The svg landed in the container. We assert on the
       data-mock-svg attribute the mock stamped on the svg. */
    const svg = host.querySelector('svg[data-mock-svg]')
    expect(svg).toBeTruthy()
    /* bindFunctions was wired so clickable diagrams get
       interactivity. */
    expect(g.__mermaidTest!.bindFunctionCalls).toBe(1)

    unmount()
  })

  it('re-renders on a theme switch (with the new theme name)', async () => {
    const { unmount } = mountStandalone()
    await settle()
    expect(g.__mermaidTest!.renderCalls.length).toBe(1)
    expect(g.__mermaidTest!.initializeCalls[0].theme).toBe('default')

    const { set } = useTheme()
    set('dark')
    await settle()

    /* A second render must have happened with the dark theme. */
    expect(g.__mermaidTest!.renderCalls.length).toBe(2)
    const lastInit = g.__mermaidTest!.initializeCalls.at(-1)
    expect(lastInit?.theme).toBe('dark')

    set('light')
    unmount()
  })

  it('keeps a forced light export theme isolated from global theme toggles', async () => {
    const { set } = useTheme()
    set('dark')
    const { unmount } = mountStandalone('light')
    await settle()

    expect(g.__mermaidTest!.initializeCalls[0]).toMatchObject({ theme: 'default' })
    expect(g.__mermaidTest!.renderCalls).toHaveLength(1)

    set('light')
    await settle()
    set('dark')
    await settle()

    /* The local override keeps effectiveTheme at light, so global
       App theme changes do not trigger a PDF widget re-render. */
    expect(g.__mermaidTest!.renderCalls).toHaveLength(1)
    expect(g.__mermaidTest!.initializeCalls.every((call) => call.theme === 'default')).toBe(true)

    set('light')
    unmount()
  })

  it('skips render when the container has zero width (tab hidden / collapsed pane)', async () => {
    /* Regression test for `<g transform="translate(NaN,NaN) …">`:
       when mermaid.render() is called on a 0×0 container (a
       hidden tab, a collapsed vault split), the layout engine
       produces NaN coordinates that the browser then rejects.
       Mermaid.vue gates render() on a non-zero width and
       re-tries via ResizeObserver once the container gets one. */
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp(defineComponent({
      setup() { return () => h(Mermaid, { code: 'graph TD\n  A --> B' }) },
    }))
    app.mount(host)

    /* No layout stub — this element is "hidden" from the
       perspective of Mermaid's render gate. */
    await settle()
    expect(g.__mermaidTest!.renderCalls.length).toBe(0)

    /* Now make the container visible (simulating a tab switch /
       split open). ResizeObserver doesn't fire synchronously in
       jsdom, so we exercise the same code path by flipping the
       theme, which goes through scheduleRender and checks size. */
    const container = host.querySelector<HTMLElement>('.mermaid-svg')!
    stubLayout(container, 800)

    useTheme().set('dark')
    await settle()
    expect(g.__mermaidTest!.renderCalls.length).toBe(1)
    expect(g.__mermaidTest!.initializeCalls.at(-1)?.theme).toBe('dark')

    useTheme().set('light')
    app.unmount()
    host.remove()
  })
})

describe('Mermaid NaN-detection fallback', () => {
  it('refuses to inject an svg containing translate(NaN and shows a friendly error', async () => {
    /* Defense-in-depth: if the size gate ever fails to catch a
       0×0 host (e.g. a parent with a CSS transform that
       collapses layout), mermaid's output can contain
       `<g transform="translate(NaN,NaN) …">`. The browser logs

         <g> attribute transform: Expected number, "translate(NaN,NaN) scale(N…"

       and the diagram is invisible. Mermaid.vue scans the
       returned string, refuses to inject it, and surfaces a
       friendly error in its place. Mermaid.vue also retries up
       to 3 times (with a fresh id each attempt, so the module-
       level cache is fresh) before giving up — the retry
       handles the rare case where mermaid's d3 simulation
       gets a bad initial RNG seed. */
    g.__mermaidTest!.overrideSvg =
      '<svg data-mock-svg><g class="node" transform="translate(NaN,NaN) scale(1)"><rect/></g></svg>'

    const { unmount, host } = mountStandalone()
    await settle()

    /* All 3 retry attempts landed; none produced a clean svg. */
    expect(g.__mermaidTest!.renderCalls.length).toBe(3)
    const container = host.querySelector<HTMLElement>('.mermaid-svg')!
    expect(container.querySelector('svg[data-mock-svg]')).toBeNull()
    expect(container.innerHTML).toBe('')
    /* The friendly error is shown. */
    const errorEl = host.querySelector<HTMLElement>('.mermaid-error')
    expect(errorEl).toBeTruthy()
    expect(errorEl!.textContent).toMatch(/布局异常/)

    /* bindFunctions was NOT called — there is no svg to bind to. */
    expect(g.__mermaidTest!.bindFunctionCalls).toBe(0)

    unmount()
  })

  it('uses the first clean svg when the retry succeeds after a NaN attempt', async () => {
    /* Retry path: first mermaid.render() returns NaN, second
       returns clean. Mermaid.vue's retry loop should break on
       the clean svg and inject it — no error shown, no
       further attempts. */
    g.__mermaidTest!.overrideSvg = [
      '<svg data-mock-svg data-broken><g transform="translate(NaN,NaN) scale(1)"></g></svg>',
      cleanStubSvg('retry', 'graph TD\n  A --> B'),
    ]

    const { unmount, host } = mountStandalone()
    await settle()

    /* Exactly 2 attempts — the loop broke on the clean one. */
    expect(g.__mermaidTest!.renderCalls.length).toBe(2)
    const svgEl = host.querySelector('svg[data-mock-svg]')
    expect(svgEl).toBeTruthy()
    expect(svgEl!.getAttribute('data-broken')).toBeNull()
    /* No error message — the retry succeeded. */
    const errorEl = host.querySelector<HTMLElement>('.mermaid-error')
    expect(errorEl).toBeFalsy()
    /* bindFunctions ran once for the successful svg. */
    expect(g.__mermaidTest!.bindFunctionCalls).toBe(1)

    unmount()
  })
})

describe('Mermaid render cancellation', () => {
  it('does not let an older async render overwrite newer Markdown content', async () => {
    const source = ref('graph TD\n  A --> B')
    g.__mermaidTest!.deferRenders = true
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp(defineComponent({
      setup() { return () => h(Mermaid, { code: source.value }) },
    }))
    app.mount(host)
    const container = host.querySelector<HTMLElement>('.mermaid-svg')!
    stubLayout(container, 800)

    const deadline = Date.now() + 2000
    while (g.__mermaidTest!.renderWaiters.length < 1 && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
    }
    expect(g.__mermaidTest!.renderWaiters).toHaveLength(1)

    source.value = 'graph TD\n  B --> C'
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    // The second component render is queued behind the first Mermaid pass,
    // but its generation is already newer. Resolving the old pass must
    // therefore discard its SVG before the queued pass starts.
    g.__mermaidTest!.renderWaiters[0].resolve()
    while (g.__mermaidTest!.renderWaiters.length < 2 && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
    }
    expect(g.__mermaidTest!.renderWaiters).toHaveLength(2)

    // Now allow the current request to paint the new source.
    g.__mermaidTest!.renderWaiters[1].resolve()
    await settle()

    expect(host.querySelector('svg[data-mock-svg]')?.textContent).toContain('B --> C')
    expect(host.querySelector('svg[data-mock-svg]')?.textContent).not.toContain('A --> B')

    app.unmount()
    host.remove()
  })
})

describe('Mermaid svg-pan-zoom integration', () => {
  /* Helper: install a controllable fullscreenElement getter +
     a spy for requestFullscreen on the widget wrapper, scoped to
     one test. Restores the original descriptor in `finally` so
     subsequent tests start with a clean Document. */
  async function withFullscreenMocks<T>(
    host: HTMLElement,
    fn: (ctx: {
      requestFullscreenSpy: ReturnType<typeof vi.fn>
      setFullscreenElement: (el: Element | null) => void
      fireFullscreenChange: () => void
    }) => Promise<T>,
  ): Promise<T> {
    const wrapper = host.querySelector<HTMLElement>('.mermaid-widget')!
    const origFsDescriptor = Object.getOwnPropertyDescriptor(document, 'fullscreenElement')
    const origRequestFullscreen = wrapper.requestFullscreen
    const requestFullscreenSpy = vi.fn().mockResolvedValue(undefined)
    let fsElement: Element | null = null
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => fsElement,
    })
    wrapper.requestFullscreen = requestFullscreenSpy
    try {
      return await fn({
        requestFullscreenSpy,
        setFullscreenElement: (el) => { fsElement = el },
        fireFullscreenChange: () => { document.dispatchEvent(new Event('fullscreenchange')) },
      })
    } finally {
      if (origFsDescriptor) {
        Object.defineProperty(document, 'fullscreenElement', origFsDescriptor)
      } else {
        delete (document as { fullscreenElement?: unknown }).fullscreenElement
      }
      wrapper.requestFullscreen = origRequestFullscreen
    }
  }

  it('binds svg-pan-zoom to the rendered svg on first render', async () => {
    const { unmount } = mountStandalone()
    await settle()

    expect(g.__svgPanZoomTest!.constructCalls.length).toBe(1)
    const { svg, opts } = g.__svgPanZoomTest!.constructCalls[0]
    expect(svg.tagName.toLowerCase()).toBe('svg')
    /* The dataset flag the component stamps on the svg prevents
       a stray double-render (HMR, ResizeObserver) from binding
       a second instance to the same element. */
    expect(svg.dataset.panZoomBound).toBe('1')
    /* The library's control-icons cluster is disabled — we ship
       our own toolbar instead. */
    expect(opts?.controlIconsEnabled).toBe(false)
    /* minZoom / maxZoom match the comment about zoom bounds. */
    expect(opts?.minZoom).toBe(0.5)
    expect(opts?.maxZoom).toBe(10)

    unmount()
  })

  it('keeps the original Mermaid viewBox available for static export', async () => {
    g.__mermaidTest!.overrideSvg = '<svg viewBox="0 0 320 180"><rect width="320" height="180" /></svg>'
    const { unmount, host } = mountStandalone()
    await settle()

    const svg = host.querySelector<SVGSVGElement>('.mermaid-svg > svg')
    expect(svg?.getAttribute('viewBox')).toBe('0 0 320 180')
    expect(svg?.getAttribute('data-mermaid-viewbox')).toBe('0 0 320 180')

    unmount()
  })

  it('routes toolbar button clicks to the panZoom instance methods', async () => {
    const { unmount, host } = mountStandalone()
    await settle()
    const instance = g.__svgPanZoomTest!.constructCalls[0].instance

    const toolbar = host.querySelector<HTMLElement>('.mermaid-toolbar')!
    const zoomIn = toolbar.querySelector<HTMLButtonElement>('button[aria-label="放大"]')!
    const zoomOut = toolbar.querySelector<HTMLButtonElement>('button[aria-label="缩小"]')!
    const reset = toolbar.querySelector<HTMLButtonElement>('button[aria-label="重置视图"]')!

    zoomIn.click()
    zoomOut.click()
    reset.click()

    /* Each button delegated to its matching method on the
       panZoom instance, exactly once. */
    expect(instance.zoomIn).toHaveBeenCalledTimes(1)
    expect(instance.zoomOut).toHaveBeenCalledTimes(1)
    expect(instance.reset).toHaveBeenCalledTimes(1)

    unmount()
  })

  it('destroys the prior svg-pan-zoom instance when re-rendering', async () => {
    const { unmount } = mountStandalone()
    await settle()
    expect(g.__svgPanZoomTest!.constructCalls.length).toBe(1)
    const old = g.__svgPanZoomTest!.constructCalls[0].instance
    expect(old.destroy).not.toHaveBeenCalled()

    /* Force a re-render via theme change. Mermaid.vue tears down
       the old pan/zoom instance (its listeners point at the
       soon-to-be-detached svg) before swapping innerHTML, then
       binds a fresh one to the new svg. */
    useTheme().set('dark')
    await settle()

    expect(g.__svgPanZoomTest!.constructCalls.length).toBe(2)
    expect(old.destroy).toHaveBeenCalledTimes(1)

    useTheme().set('light')
    unmount()
  })

  it('calls resize + reset on the panZoom instance when fullscreen state flips', async () => {
    const { unmount, host } = mountStandalone()
    await settle()
    const instance = g.__svgPanZoomTest!.constructCalls[0].instance

    await withFullscreenMocks(host, async ({ setFullscreenElement, fireFullscreenChange }) => {
      const wrapper = host.querySelector<HTMLElement>('.mermaid-widget')!
      const fsButton = host.querySelector<HTMLButtonElement>('button[aria-label="全屏"]')!
      fsButton.click()

      /* resize + reset haven't fired yet — they trigger off the
         fullscreenchange event after the browser commits. */
      expect(instance.resize).not.toHaveBeenCalled()

      /* Simulate the browser committing fullscreen + firing the
         event. onFullscreenChange reads document.fullscreenElement
         and updates isFullscreen, the watcher consumes that and
         calls resize + reset on the panZoom instance. */
      setFullscreenElement(wrapper)
      fireFullscreenChange()
      await settle()

      expect(instance.resize).toHaveBeenCalledTimes(1)
      expect(instance.reset).toHaveBeenCalledTimes(1)
    })

    unmount()
  })

  it('swaps the fullscreen button icon when entering and exiting fullscreen', async () => {
    const { unmount, host } = mountStandalone()
    await settle()

    const fsButton = host.querySelector<HTMLButtonElement>('button[aria-label="全屏"]')!
    expect(fsButton.getAttribute('aria-label')).toBe('全屏')
    expect(fsButton.getAttribute('title')).toBe('全屏')

    await withFullscreenMocks(host, async ({ setFullscreenElement, fireFullscreenChange }) => {
      const wrapper = host.querySelector<HTMLElement>('.mermaid-widget')!
      setFullscreenElement(wrapper)
      fireFullscreenChange()
      await settle()

      /* After the fullscreenchange event with us as the
         fullscreen element, the button flips to "exit". */
      expect(fsButton.getAttribute('aria-label')).toBe('退出全屏')
      expect(fsButton.getAttribute('title')).toBe('退出全屏')

      /* When we exit, the button flips back. */
      setFullscreenElement(null)
      fireFullscreenChange()
      await settle()

      expect(fsButton.getAttribute('aria-label')).toBe('全屏')
    })

    unmount()
  })

  it('source-level: guards the bind with a render-generation check', () => {
    /* Behavioral coverage of the render-generation guard is
       fragile in jsdom (the svg-pan-zoom dynamic import resolves
       as a microtask, making it hard to stage "two renders in
       before the .then fires"). Instead we pin the
       implementation: a regression that drops the guard would
       re-introduce a memory leak (orphan panZoom instance
       bound to a detached svg). The two markers below are
       what the bind path reads at runtime. */
    const src = readFileSync(
      resolve(__dirname, '..', 'Mermaid.vue'),
      'utf8',
    )
    expect(src).toMatch(/renderGeneration/)
    expect(src).toMatch(/myGen\s*!==\s*renderGeneration/)
  })
})

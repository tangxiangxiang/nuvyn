// @vitest-environment jsdom

import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, nextTick, onMounted } from 'vue'
import ReadingPane from '../ReadingPane.vue'
import type { Heading } from '../../../composables/vault/useMarkdownRender'
import { tocActiveId, tocHeadings, tocScrollTo } from '../../../composables/vault/useTocState'

/* ----- IntersectionObserver mock ---------------------------------------
   jsdom does not implement IntersectionObserver, so we install a thin
   stand-in. It records every observer's callback + options and the
   elements it observes, so individual tests can drive the callback
   directly when they need to assert on the observer path. For the
   bottom-edge fix the more interesting path is the .reading-pane
   scroll handler, which the test exercises by dispatching a real
   scroll event on the pane. */

interface RecordedObserver {
  callback: IntersectionObserverCallback
  options: IntersectionObserverInit | undefined
  observed: Set<Element>
}

const observerInstances: RecordedObserver[] = []

class MockIntersectionObserver implements IntersectionObserver {
  readonly root: Element | Document | null = null
  readonly rootMargin: string = ''
  readonly thresholds: ReadonlyArray<number> = []
  readonly scrollMargin: string = ''
  callback: IntersectionObserverCallback
  options: IntersectionObserverInit | undefined
  observed: Set<Element> = new Set()

  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = callback
    this.options = options
    this.rootMargin = options?.rootMargin ?? ''
    this.thresholds = options?.threshold !== undefined
      ? (Array.isArray(options.threshold) ? options.threshold : [options.threshold])
      : []
    observerInstances.push({ callback, options, observed: this.observed })
  }

  observe(el: Element) { this.observed.add(el) }
  unobserve(el: Element) { this.observed.delete(el) }
  disconnect() { this.observed.clear() }
  takeRecords(): IntersectionObserverEntry[] { return [] }
}

beforeEach(() => {
  observerInstances.length = 0
  // jsdom doesn't ship IntersectionObserver — install the mock.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).IntersectionObserver = MockIntersectionObserver
  tocHeadings.value = []
  tocActiveId.value = ''
  tocScrollTo.value = null
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  tocHeadings.value = []
  tocActiveId.value = ''
  tocScrollTo.value = null
})

/* ----- Fixture: mount ReadingPane with a stubbed RenderedMarkdown --------
   The stub emits a real <article> element with the requested heading
   children so getHeadingEls() can find them by id. The article is
   detached from the document — querySelector inside it still works,
   and the headings' bounding rects are stubbed per-test to simulate
   scroll position. */

interface Fixture {
  wrapper: ReturnType<typeof mount>
  pane: HTMLElement
  article: HTMLElement
  headingEls: HTMLElement[]
}

function setupFixture(headingData: Heading[]): Fixture {
  const article = document.createElement('article')
  const headingEls: HTMLElement[] = headingData.map((h) => {
    const el = document.createElement(`h${h.level}`) as HTMLElement
    el.id = h.id
    el.textContent = h.text
    article.appendChild(el)
    return el
  })

  const stub = defineComponent({
    emits: ['update:headings', 'rendered'],
    setup(_props, { emit }) {
      onMounted(() => {
        emit('update:headings', headingData)
        emit('rendered', article)
      })
      return () => null
    },
  })

  const wrapper = mount(ReadingPane, {
    props: { raw: 'some markdown content' },
    attachTo: document.body,
    global: { stubs: { RenderedMarkdown: stub } },
  })

  const pane = wrapper.find('.reading-pane').element as HTMLElement

  /* jsdom doesn't implement Element.scrollTo. scrollToHeading calls
     it, so polyfill it with a direct scrollTop update — enough for
     the click-and-freeze test. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(pane as any).scrollTo = (options: { top: number }) => {
    Object.defineProperty(pane, 'scrollTop', { value: options.top, configurable: true, writable: true })
  }

  return { wrapper, pane, article, headingEls }
}

/* jsdom exposes scrollTop as a writable property but clientHeight /
   scrollHeight are getter-only. Define them so we can simulate
   arbitrary scroll states without touching layout. */
function setScrollState(pane: HTMLElement, scrollTop: number, clientHeight: number, scrollHeight: number) {
  Object.defineProperty(pane, 'scrollTop', { value: scrollTop, configurable: true, writable: true })
  Object.defineProperty(pane, 'clientHeight', { value: clientHeight, configurable: true })
  Object.defineProperty(pane, 'scrollHeight', { value: scrollHeight, configurable: true })
}

function setRect(el: HTMLElement, top: number) {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    top, bottom: top + 30, left: 0, right: 100, width: 100, height: 30,
    x: 0, y: top, toJSON: () => ({}),
  } as DOMRect)
}

describe('ReadingPane scroll-spy', () => {
  it('activates the last heading whose top has crossed the trigger line', async () => {
    const { pane, headingEls } = setupFixture([
      { id: 'h-a', text: 'A', level: 2 },
      { id: 'h-b', text: 'B', level: 2 },
      { id: 'h-c', text: 'C', level: 2 },
    ])

    // pane top = 100 → trigger line at y = 116.
    setRect(pane, 100)
    setScrollState(pane, 0, 400, 1500)
    setRect(headingEls[0], 80)   // crossed (80 ≤ 116)
    setRect(headingEls[1], 300)  // not crossed
    setRect(headingEls[2], 600)  // not crossed

    pane.dispatchEvent(new Event('scroll'))
    await nextTick()

    expect(tocActiveId.value).toBe('h-a')
  })

  it('activates the last heading when scrolled to the bottom', async () => {
    const { pane, headingEls } = setupFixture([
      { id: 'h-a', text: 'A', level: 2 },
      { id: 'h-b', text: 'B', level: 2 },
    ])

    setRect(pane, 100)
    // scrollTop + clientHeight = 1500 + 400 = 1900 == scrollHeight → at bottom.
    setScrollState(pane, 1500, 400, 1900)
    setRect(headingEls[0], -1500) // crossed
    setRect(headingEls[1], 300)   // not crossed — physically can't reach trigger

    pane.dispatchEvent(new Event('scroll'))
    await nextTick()

    expect(tocActiveId.value).toBe('h-b')
  })

  it('activates the last heading at the bottom even when no heading has crossed the trigger line', async () => {
    // Reproduces the reported bug: short trailing section, page
    // reaches scrollHeight before the last heading can move up to the
    // trigger line. The old rule left the previous heading highlighted.
    const { pane, headingEls } = setupFixture([
      { id: 'h-a', text: 'A', level: 2 },
      { id: 'h-b', text: 'B', level: 2 },
      { id: 'h-c', text: 'C', level: 2 },
    ])

    setRect(pane, 100)
    setScrollState(pane, 800, 400, 1200) // 800 + 400 = 1200 → at bottom
    // None of the headings can cross the trigger (y=116): all sit below it.
    setRect(headingEls[0], 50)   // crossed (50 ≤ 116) — would have triggered before bottom
    setRect(headingEls[1], 300)
    setRect(headingEls[2], 600)

    pane.dispatchEvent(new Event('scroll'))
    await nextTick()

    expect(tocActiveId.value).toBe('h-c')
  })

  it('does not activate the last heading before reaching the bottom', async () => {
    const { pane, headingEls } = setupFixture([
      { id: 'h-a', text: 'A', level: 2 },
      { id: 'h-b', text: 'B', level: 2 },
    ])

    setRect(pane, 100)
    // 100 + 400 = 500, scrollHeight 2000 — well clear of the bottom.
    setScrollState(pane, 100, 400, 2000)
    setRect(headingEls[0], 50)   // crossed
    setRect(headingEls[1], 300)  // not crossed

    pane.dispatchEvent(new Event('scroll'))
    await nextTick()

    expect(tocActiveId.value).toBe('h-a')
  })

  it('does not override the active id during the freeze window after a TOC click', async () => {
    vi.useFakeTimers()
    const { pane, headingEls } = setupFixture([
      { id: 'h-a', text: 'A', level: 2 },
      { id: 'h-b', text: 'B', level: 2 },
      { id: 'h-c', text: 'C', level: 2 },
    ])
    await nextTick()

    // User clicks h-b in the TOC; ReadingPane pins active for 800ms.
    tocScrollTo.value?.('h-b')
    expect(tocActiveId.value).toBe('h-b')

    // Mid-freeze: pane reaches the bottom (last heading would normally
    // win). The scroll handler must NOT override the click target.
    setRect(pane, 100)
    setScrollState(pane, 800, 400, 1200) // at bottom
    setRect(headingEls[0], -800)
    setRect(headingEls[1], -100)
    setRect(headingEls[2], 50) // not crossed

    pane.dispatchEvent(new Event('scroll'))
    await nextTick()

    expect(tocActiveId.value).toBe('h-b')

    // After the freeze expires the next scroll tick resumes normal
    // behavior and snaps to the last heading.
    vi.advanceTimersByTime(1000)
    pane.dispatchEvent(new Event('scroll'))
    await nextTick()

    expect(tocActiveId.value).toBe('h-c')
  })

  it('keeps the active id empty when there are no headings', async () => {
    const { pane } = setupFixture([])

    // No observer attaches, no scroll-spy state to update. Verify
    // scrolling doesn't throw and tocActiveId stays empty.
    setRect(pane, 100)
    setScrollState(pane, 1000, 400, 1400)

    expect(() => {
      pane.dispatchEvent(new Event('scroll'))
    }).not.toThrow()

    await nextTick()
    expect(tocActiveId.value).toBe('')
  })

  it('does not expose PDF export UI', () => {
    const { wrapper } = setupFixture([])
    expect(wrapper.find('[data-testid="reading-export-pdf"]').exists()).toBe(false)
    expect(wrapper.text()).not.toMatch(/Export PDF|Download PDF|导出 PDF/)
  })
})

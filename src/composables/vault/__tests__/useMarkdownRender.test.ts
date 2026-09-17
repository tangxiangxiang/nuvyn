// @vitest-environment jsdom
// Tests for the heading-extraction half of useMarkdownRender. The
// rendered HTML is the only thing that exposes the slug rules from
// ../../lib/markdown.ts (markdown-it-anchor's custom slugify), so we
// exercise the extractor against a few realistic shapes — including
// CJK content, which is the default in the bundled sample posts.
//
// `extractHeadings` is exported from the production module under
// `__testing__` so the tests run the real implementation rather than
// a re-implementation that could drift. (An earlier test re-copied
// the regex and missed the bug where the anchor stripper ate the
// <span>-wrapped heading text.)
//
// The public-API smoke test at the bottom mounts the composable and
// just checks that `html` and `headings` end up populated — full
// markdown pipeline behavior (Shiki language preparation, task lists, etc.) is
// covered by the lib/markdown tests.

import { describe, it, expect } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { useMarkdownRender, __testing__ } from '../useMarkdownRender'

const { extractHeadings } = __testing__

describe('heading extraction', () => {
  it('skips h1, returns h2/h3/h4 in document order with clean text', () => {
    /* Real markdown-it-anchor output wraps the heading text in a
       <span> INSIDE the anchor. The tests use this shape (rather
       than the older `<a …>#</a>heading`) so they exercise the same
       HTML the production render() produces. */
    const html = `
      <h1 id="title" tabindex="-1"><a class="header-anchor" href="#title"><span>Document title</span></a></h1>
      <h2 id="sec-1" tabindex="-1"><a class="header-anchor" href="#sec-1"><span>First section</span></a></h2>
      <p>some prose</p>
      <h3 id="sec-1-1" tabindex="-1"><a class="header-anchor" href="#sec-1-1"><span>Subsection</span></a></h3>
      <h2 id="sec-2" tabindex="-1"><a class="header-anchor" href="#sec-2"><span>Second section</span></a></h2>
    `
    expect(extractHeadings(html)).toEqual([
      { id: 'sec-1', text: 'First section', level: 2 },
      { id: 'sec-1-1', text: 'Subsection', level: 3 },
      { id: 'sec-2', text: 'Second section', level: 2 },
    ])
  })

  it('preserves inline formatting markers as plain text', () => {
    /* Nested <code>/<em> inside a heading still collapse to a single
       string for the TOC. We don't need structured text here — the TOC
       is a navigation aid, not a styled rendering. */
    const html = `<h2 id="x" tabindex="-1"><a class="header-anchor" href="#x"><span>Using <code>useFoo()</code> and <em>other</em> helpers</span></a></h2>`
    expect(extractHeadings(html)).toEqual([
      { id: 'x', text: 'Using useFoo() and other helpers', level: 2 },
    ])
  })

  it('handles CJK heading text (the bundled sample posts are Chinese)', () => {
    const html = `
      <h1 id="yi-ji-biao-ti" tabindex="-1"><a class="header-anchor" href="#yi-ji-biao-ti"><span>一级标题</span></a></h1>
      <h2 id="er-ji-biao-ti" tabindex="-1"><a class="header-anchor" href="#er-ji-biao-ti"><span>二级标题</span></a></h2>
      <h3 id="san-ji-biao-ti" tabindex="-1"><a class="header-anchor" href="#san-ji-biao-ti"><span>三级标题</span></a></h3>
    `
    expect(extractHeadings(html)).toEqual([
      { id: 'er-ji-biao-ti', text: '二级标题', level: 2 },
      { id: 'san-ji-biao-ti', text: '三级标题', level: 3 },
    ])
  })

  it('returns an empty list for documents with only an h1', () => {
    const html = `<h1 id="only" tabindex="-1"><a class="header-anchor" href="#only"><span>Title only</span></a></h1><p>No subsections.</p>`
    expect(extractHeadings(html)).toEqual([])
  })
})

describe('useMarkdownRender (public API smoke)', () => {
  it('marks the current source ready only after its HTML is populated', async () => {
    let captured: ReturnType<typeof useMarkdownRender> | null = null
    const Comp = defineComponent({
      setup() {
        captured = useMarkdownRender(ref('# Title\n\n## Section\n\nbody'))
        return () => h('div')
      },
    })
    mount(Comp)
    expect(captured).not.toBeNull()
    expect(captured!.ready.value).toBe(false)
    /* The watchEffect awaits `render()`, which may prepare a Shiki
       grammar on a cold cache (fresh CI runner). That preparation can
       span many macrotask cycles, so a fixed tick count is flaky —
       wait for the actual condition (headings populated) instead,
       failing only if the render genuinely never completes. */
    const deadline = Date.now() + 5000
    while (captured!.headings.value.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(captured!.headings.value.length).toBeGreaterThan(0)
    expect(captured!.html.value).toContain('Section')
    expect(captured!.ready.value).toBe(true)
  })

  it('publishes custom heading IDs and clean labels from the final HTML', async () => {
    let captured: ReturnType<typeof useMarkdownRender> | null = null
    const Comp = defineComponent({
      setup() {
        captured = useMarkdownRender(ref('## Java Guide {#java-guide}\n\n## Usage'))
        return () => h('div')
      },
    })
    mount(Comp)

    const deadline = Date.now() + 5000
    while (captured!.headings.value.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(captured!.headings.value).toEqual([
      { id: 'java-guide', text: 'Java Guide', level: 2 },
      { id: 'usage', text: 'Usage', level: 2 },
    ])
  })
})

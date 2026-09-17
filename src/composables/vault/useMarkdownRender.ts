// Renders a markdown source string (with frontmatter) into HTML, sharing
// the same `parseDoc` -> `render` pipeline the preview pane uses. The
// frontmatter `title` is treated as the canonical H1 unless the body
// already begins with one — in that case we honor the body's heading
// instead of double-stacking. Extracted from the reading pane so
// ReadingPane and any future renderer stay in lockstep (no drift
// between title handling / render errors).
//
// Also extracts a flat list of headings (h1..h4) with their slug
// `id`, plain text, and level — this powers the right-side page-nav
// (à la VitePress) shown in the vault's read mode. We re-parse the
// rendered HTML rather than running a second pass over the markdown
// because the slug rules live in markdown-it's anchor plugin
// (see ../../lib/markdown.ts); doing it from the same HTML guarantees
// the TOC links point at ids that actually exist in the article.
//
// `resolver` (optional) is forwarded to the wiki-link plugin so
// [[…]] and [t](path.md) are rendered as `wiki-link` anchors with
// the right href and `data-missing` flag. When omitted, the default
// identity resolver in ../../lib/markdown.ts applies.

import { ref, watchEffect, type Ref } from 'vue'
import { parseDoc } from '../../lib/frontmatter'
import { render, type MarkdownRenderOptions } from '../../lib/markdown'
import type { Resolver as WikiResolver } from '../../lib/wikiLinks'
import { isManagedDiaryPath } from '../../../shared/diaryProtocol'
import { captureDiarySessionGeneration, isDiarySessionGenerationCurrent } from '../diary/useDiaryAccessSession'

export interface Heading {
  id: string
  text: string
  level: 1 | 2 | 3 | 4
}

export interface MarkdownRender {
  html: Ref<string>
  error: Ref<string | null>
  headings: Ref<Heading[]>
  /** True only after the current source has finished rendering. */
  ready: Ref<boolean>
}

/* Match opening + closing h1..h4 with an `id` attribute. Slugs come
   from markdown-it's custom slugify in ../../lib/markdown.ts which
   allows CJK characters; we only need to *read* them, not generate. */
const HEADING_RE = /<h([1-4])\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/g

/* Strip the permalink anchor markdown-it-anchor wraps around the
   heading text, plus any other inline tags, to get a clean display
   string. We don't pull out nested tags like <em> / <code> as their
   own nodes — flat text is fine for a TOC.

   Important: the anchor regex uses a capture group + `$1` replacement
   rather than dropping the match to empty. The current
   markdown-it-anchor output (with `permalink: headerLink()`) puts
   the heading text inside a <span> *inside* the anchor:

     <h2 id="…"><a class="header-anchor" href="#…"><span>二级标题</span></a></h2>

   If we strip the whole `<a>…</a>` (including the <span>), the heading
   text is consumed and the TOC link ends up empty. Capturing the
   anchor's inner content and re-emitting it (the <span> gets removed
   in the next pass) keeps the actual heading text. */
function stripTags(s: string): string {
  return s
    .replace(/<a\b[^>]*class="[^"]*header-anchor[^"]*"[^>]*>([\s\S]*?)<\/a>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim()
}

function extractHeadings(html: string): Heading[] {
  const out: Heading[] = []
  for (const m of html.matchAll(HEADING_RE)) {
    const level = Number(m[1]) as 1 | 2 | 3 | 4
    /* Skip the document title (h1): the page-nav is for *sections*,
       not for jumping back to the top. The rendered H1 is either the
       frontmatter `title` (auto-prepended) or the body's own `# …`. */
    if (level === 1) continue
    out.push({ id: m[2], text: stripTags(m[3]), level: level as 2 | 3 | 4 })
  }
  return out
}

/* Exported for tests — `extractHeadings` is a pure HTML-to-Heading[]
   transform that deserves direct coverage. Keeping it as a private
   helper would mean tests have to spin up the composable (and wait
   for the async markdown render), which both slows the suite and
   hides regressions like the `<span>`-wrapped anchor bug. */
export const __testing__ = { extractHeadings, stripTags }

export function useMarkdownRender(
  source: Ref<string> | (() => string),
  resolver?: WikiResolver,
  options: Omit<MarkdownRenderOptions, 'resolver' | 'signal'> = {},
): MarkdownRender {
  const html = ref<string>('')
  const error = ref<string | null>(null)
  const headings = ref<Heading[]>([])
  const ready = ref(false)

  watchEffect(async (onCleanup) => {
    const raw = typeof source === 'function' ? source() : source.value
    const managed = Boolean(options.sourcePath
      && isManagedDiaryPath(options.sourcePath.replace(/\.md$/, '')))
    const renderGeneration = managed ? captureDiarySessionGeneration() : null
    ready.value = false
    /* Cancel any in-flight render when source changes again. Without
       this, a slow render from the previous document can resolve
       AFTER the new one and clobber the html/headings, leaving the
       reader looking at stale content + a stale TOC. */
    let cancelled = false
    const controller = new AbortController()
    onCleanup(() => {
      cancelled = true
      controller.abort()
    })
    try {
      const { frontmatter, content } = parseDoc(raw)
      const title = typeof frontmatter.title === 'string' ? frontmatter.title.trim() : ''
      const startsWithH1 = /^#\s+\S/.test(content.trimStart())
      const body = !startsWithH1 && title
        ? `# ${title}\n\n${content.replace(/^\n+/, '')}`
        : content
      const rendered = await render(body, { ...options, resolver, signal: controller.signal })
      // A managed-Diary render may have awaited a resource request while the
      // authoritative session was locked/replaced. Do not publish that E1
      // HTML/TOC into the reader after the generation advanced; ordinary Note
      // renders retain their existing cancellation semantics.
      if (cancelled || (renderGeneration !== null && !isDiarySessionGenerationCurrent(renderGeneration))) return
      html.value = rendered
      headings.value = extractHeadings(rendered)
      error.value = null
      ready.value = true
    } catch (e) {
      if (cancelled) return
      error.value = (e as Error).message
      ready.value = true
    }
  })

  return { html, error, headings, ready }
}

<script setup lang="ts">
// Distraction-free reading surface used when the vault is in read mode.
// Same markdown pipeline as ReadingPane (so frontmatter title handling
// and render errors stay consistent), presented in a centered single
// column with reading-friendly typography.
//
// Page navigation (TOC) has been extracted to RightRail.vue — a separate
// vault grid column on the left. This component still owns the
// IntersectionObserver scroll-spy and publishes heading state via
// useTocState so RightRail can render the active-highlighted list.

import { ref, computed, watch, onBeforeUnmount } from 'vue'
import RenderedMarkdown from './RenderedMarkdown.vue'
import type { Heading } from '../../composables/vault/useMarkdownRender'
import { useVaultTocState } from '../../composables/vault/useTocState'
import type { Resolver as WikiResolver } from '../../lib/wikiLinks'
import type { MarkdownResourceResolver } from '../../lib/markdownResources'

const { tocHeadings, tocActiveId, tocScrollTo } = useVaultTocState()

const props = defineProps<{
  raw: string
  /** Resolver for [[wiki]] / [t](path.md) links. See ReadingPane. */
  resolver?: WikiResolver
  sourcePath?: string
  resourceResolver?: MarkdownResourceResolver
}>()
const headings = ref<Heading[]>([])

/* True when the active document is empty (no tabs opened, or the
   current tab is still loading). We render a soft placeholder instead
   of a blank centered pane. */
const isEmpty = computed(() => !props.raw || !props.raw.trim())

/* ----- Scroll-spy for RightRail ----------
   We observe the article's h2/h3/h4 elements with IntersectionObserver.
   The observer's root is the .reading-pane scroll container, and we
   shrink its effective rect with a negative bottom rootMargin so a
   heading only "intersects" when it crosses near the top of the
   visible area.

   The active section is the heading whose top is *closest to (but
   still above) the trigger line* — i.e. the last heading the reader
   has scrolled past. This is the VitePress behavior and matches what
   users expect: while reading a section, the section title is what's
   highlighted, not the next one.

   The active-id and heading list are published to useTocState so the
   RightRail (a sibling in the vault grid) renders them. */

const articleEl = ref<HTMLElement | null>(null)
const readingPaneEl = ref<HTMLElement | null>(null)

let observer: IntersectionObserver | null = null

/* After a TOC click, the user-initiated smooth scroll fires many
   IntersectionObserver ticks on the way down. Without a freeze the
   active state would flicker across whatever intermediate sections
   the scroll passes through. We pin the active id for one frame
   after a click; the observer resumes driving the highlight when
   the freeze lifts. */
let freezeActiveUntil = 0

function disconnectObserver() {
  if (observer) { observer.disconnect(); observer = null }
}

function getHeadingEls(): HTMLElement[] {
  if (!articleEl.value) return []
  const out: HTMLElement[] = []
  for (const h of headings.value) {
    const el = articleEl.value.querySelector<HTMLElement>(`#${cssEscape(h.id)}`)
    if (el) out.push(el)
  }
  return out
}

function pickActiveId(els: HTMLElement[]): string {
  if (els.length === 0) return ''
  const container = readingPaneEl.value
  if (!container) return els[0].id
  const triggerY = container.getBoundingClientRect().top + 16
  let active = els[0]
  for (const el of els) {
    if (el.getBoundingClientRect().top <= triggerY) active = el
    else break
  }
  return active.id
}

/* True when the reading pane has been scrolled all the way to the
   bottom, within a small epsilon for browser pixel rounding and
   fractional scroll values during smooth-scroll. Used by the scroll-
   spy to force-activate the last heading when no further heading
   can ever cross the trigger line (i.e. the document ends before
   the next heading starts). */
function isScrolledToBottom(container: HTMLElement): boolean {
  const epsilon = 2
  return container.scrollTop + container.clientHeight >= container.scrollHeight - epsilon
}

/* Single entry point for publishing `tocActiveId`. Both the
   IntersectionObserver callback and the `.reading-pane` scroll
   handler route through this so the freeze window and the
   bottom-edge rule apply consistently. */
function updateActiveHeading(els: HTMLElement[]) {
  if (Date.now() < freezeActiveUntil) return
  const pane = readingPaneEl.value
  if (!pane || els.length === 0) return
  if (isScrolledToBottom(pane)) {
    tocActiveId.value = els.at(-1)?.id ?? ''
    return
  }
  tocActiveId.value = pickActiveId(els)
}

/* The observer alone is not enough: at the very bottom of the page
   no further intersection change happens, so without a scroll
   listener the last heading would never become active. Calling the
   same updater on every scroll tick fills that gap. */
function onReadingPaneScroll() {
  updateActiveHeading(getHeadingEls())
}

/* Build the observer once the article is in the DOM and the headings
   have been resolved. Publishes the active heading id to the shared
   tocActiveId ref so RightRail can highlight it. */
function attachObserver() {
  disconnectObserver()
  if (!articleEl.value || !readingPaneEl.value || headings.value.length === 0) return
  const els = getHeadingEls()
  if (els.length === 0) return
  observer = new IntersectionObserver(
    () => { updateActiveHeading(els) },
    {
      root: readingPaneEl.value,
      rootMargin: '0px 0px -60% 0px',
      threshold: 0,
    },
  )
  for (const el of els) observer.observe(el)
  if (!tocActiveId.value) updateActiveHeading(els)
}

/* The slugify in ../../lib/markdown.ts allows CJK characters, which
   are valid in HTML id attributes but invalid as bare CSS selectors.
   Escape them so querySelector('#xxx') works. */
function cssEscape(id: string): string {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(id)
  return id.replace(/([!"#$%&'()*+,./:;<=>?@\[\\\]^`{|}~])/g, '\\$1')
}

/* Scroll-to handler published to RightRail via tocScrollTo. Smooth-scrolls
   the target heading into view inside the .reading-pane scroll container. */
function scrollToHeading(id: string) {
  if (!articleEl.value) return
  const target = articleEl.value.querySelector<HTMLElement>(`#${cssEscape(id)}`)
  if (!target) return
  freezeActiveUntil = Date.now() + 800
  tocActiveId.value = id
  const pane = readingPaneEl.value
  if (pane) {
    const paneRect = pane.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    const top = targetRect.top - paneRect.top + pane.scrollTop
    pane.scrollTo({ top, behavior: 'smooth' })
  } else {
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  if (history.replaceState) history.replaceState(null, '', `#${id}`)
}

/* Publish heading state to the shared module. RightRail reads these
   refs to render the navigation list. We publish immediately on each
   render and reset on unmount so a stale document's TOC doesn't linger
   when switching away from read mode. */
watch(headings, (h) => { tocHeadings.value = h }, { immediate: true })
tocScrollTo.value = scrollToHeading

onBeforeUnmount(() => {
  disconnectObserver()
  tocHeadings.value = []
  tocActiveId.value = ''
  tocScrollTo.value = null
})

watch([articleEl, readingPaneEl, headings], () => attachObserver(), { flush: 'post' })
watch(() => props.raw, () => {
  /* Reset published state so the RightRail doesn't keep rendering the
     previous document's heading list during the brief render window
     of the new one. useMarkdownRender's onWatcherCleanup also guards
     against an in-flight render clobbering the new result. */
  tocHeadings.value = []
  tocActiveId.value = ''
  freezeActiveUntil = 0
})
</script>

<template>
  <div ref="readingPaneEl" class="reading-pane" @scroll.passive="onReadingPaneScroll">
    <div v-if="isEmpty" class="reading-empty">
      未打开文件。在侧栏选一个或按 <kbd>⌘P</kbd> 新建。
    </div>
    <template v-else>
      <div class="reading-layout">
        <RenderedMarkdown
          :raw="raw"
          :resolver="resolver"
          :source-path="sourcePath"
          :resource-resolver="resourceResolver"
          tag="article"
          @update:headings="headings = $event"
          @rendered="articleEl = $event"
        />
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { renderAiMarkdown } from '../../lib/aiMarkdown'
import { useOptionalVaultContext } from '../../composables/vault/context/useVaultContext'
import { getLinkIndex } from '../../composables/vault/useLinkIndex'
import { resolveWikiTarget } from '../../../shared/linkResolve'

const props = defineProps<{
  content: string
  sourcePath?: string | null
  finance?: boolean
  streaming?: boolean
  noteLinkContext?: { paths: string[]; openLink: (path: string, anchor?: string) => Promise<void> } | null
}>()

const vaultContext = useOptionalVaultContext()
const linkIndex = getLinkIndex(vaultContext?.fileChanges)
const html = ref('')
let renderFrame: number | null = null

function cancelScheduledRender(): void {
  if (renderFrame === null) return
  cancelAnimationFrame(renderFrame)
  renderFrame = null
}

function renderCurrent(): void {
  html.value = renderAiMarkdown(props.content, {
    sourcePath: props.sourcePath ?? undefined,
    finance: props.finance,
    resolver: (ref, _anchor, context) => ({
      target: resolveWikiTarget(
        ref,
        context?.sourcePath ?? props.sourcePath ?? '',
        vaultContext ? [...linkIndex.value.paths] : props.noteLinkContext?.paths ?? [],
      ),
    }),
  })
}

function scheduleRender(): void {
  if (!props.streaming) {
    cancelScheduledRender()
    renderCurrent()
    return
  }
  if (renderFrame !== null) return
  if (typeof requestAnimationFrame === 'undefined') {
    renderCurrent()
    return
  }
  renderFrame = requestAnimationFrame(() => {
    renderFrame = null
    renderCurrent()
  })
}

watch(() => [props.content, props.sourcePath, props.finance, props.noteLinkContext?.paths, linkIndex.value.paths], scheduleRender, { immediate: true, deep: true })
watch(() => props.streaming, (streaming) => {
  if (!streaming) {
    cancelScheduledRender()
    renderCurrent()
  }
})
onBeforeUnmount(cancelScheduledRender)

function onLinkClick(event: MouseEvent) {
  if (event.button !== 0) return
  const openLink = vaultContext?.editor.openLink ?? props.noteLinkContext?.openLink
  if (!openLink) return
  const anchor = (event.target as HTMLElement | null)?.closest<HTMLAnchorElement>('a.wiki-link')
  if (!anchor?.dataset.target) return
  event.preventDefault()
  void openLink(anchor.dataset.target, anchor.dataset.anchor)
}
</script>

<template>
  <div class="ai-markdown article" :class="{ 'ai-finance-markdown': finance }" v-html="html" @click="onLinkClick" />
</template>

<style scoped>
.ai-markdown {
  min-width: 0;
  white-space: normal;
  overflow-wrap: anywhere;
}
.ai-markdown :deep(:first-child) { margin-top: 0; }
.ai-markdown :deep(:last-child) { margin-bottom: 0; }
.ai-markdown :deep(pre) { max-width: 100%; overflow-x: auto; }
.ai-markdown :deep(code) { overflow-wrap: anywhere; }
.ai-markdown :deep(a) { overflow-wrap: anywhere; }
.ai-markdown :deep(.ai-table-scroll) {
  max-width: 100%;
  overflow-x: auto;
  scrollbar-width: none;
  overscroll-behavior-x: contain;
}
.ai-markdown :deep(.ai-table-scroll::-webkit-scrollbar),
.ai-markdown :deep(pre::-webkit-scrollbar) { display: none; }
.ai-markdown :deep(.ai-table-scroll:focus-visible) { outline: 1px solid var(--vs-accent); }
.ai-markdown :deep(.ai-table-scroll table) { width: max-content; min-width: 100%; }
.ai-markdown :deep(.ai-table-scroll :is(th, td)) { max-width: 18rem; }

/* Shared Ledger-quality typography for every AI workspace. */
.ai-markdown :deep(:where(h1, h2, h3, h4, h5, h6)) { line-height: 1.3; letter-spacing: -0.005em; }
.ai-markdown :deep(h1) {
  font-size: 1.08rem;
  font-weight: 600;
  margin: 0.85em 0 0.4em;
}
.ai-markdown :deep(h2) {
  font-size: 1rem;
  font-weight: 600;
  margin: 0.85em 0 0.35em;
  color: var(--vs-text-1, var(--text));
}
.ai-markdown :deep(h3) {
  font-size: 0.92rem;
  font-weight: 600;
  margin: 0.75em 0 0.3em;
  color: var(--vs-text-2, var(--text-muted));
}
.ai-markdown :deep(h4),
.ai-markdown :deep(h5),
.ai-markdown :deep(h6) {
  font-size: 0.78rem;
  font-weight: 600;
  margin: 0.7em 0 0.25em;
  color: var(--vs-text-2, var(--text-muted));
}
.ai-markdown :deep(:where(p, ul, ol, blockquote, dl)) {
  margin: 0.45em 0;
  font-size: 0.875rem;
  line-height: 1.65;
}
.ai-markdown :deep(ul),
.ai-markdown :deep(ol) { padding-left: 1.2em; }
.ai-markdown :deep(li + li) { margin-top: 0.18em; }
.ai-markdown :deep(li > :where(p, ul, ol)) { margin: 0.15em 0; }

/* Inline code — same treatment as the metadata panel's tags/labels:
   mono font, subtle bg, tight padding, rounded. */
.ai-markdown :deep(:not(pre) > code) {
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 0.78em;
  padding: 1px 4px;
  border-radius: 2px;
  background: var(--vs-bg-2, var(--bg-soft));
  color: var(--vs-text-1, var(--text));
}

/* Code blocks — matches the metadata readonly block: hairline border,
   bg-soft fill, mono font, capped at the bubble's right edge with
   horizontal scroll for overflow. */
.ai-markdown :deep(pre) {
  max-width: 100%;
  overflow-x: auto;
  scrollbar-width: none;
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 0.76rem;
  line-height: 1.5;
  padding: 8px 10px;
  margin: 0.55em 0;
  background: var(--vs-bg-2, var(--bg-soft));
  border: 1px solid color-mix(in srgb, var(--vs-border, var(--border)) 60%, transparent);
  border-radius: 4px;
  color: var(--vs-text-1, var(--text));
}
.ai-markdown :deep(pre code) {
  background: transparent;
  padding: 0;
  border-radius: 0;
  font-size: inherit;
  white-space: pre;
  overflow-wrap: normal;
  word-break: normal;
}

/* Blockquote — left accent bar instead of full border, like the
   properties panel's hairline dividers. */
.ai-markdown :deep(blockquote) {
  margin: 0.55em 0;
  padding: 2px 0 2px 10px;
  border-left: 2px solid var(--vs-accent, var(--accent));
  color: var(--vs-text-2, var(--text-muted));
  font-style: normal;
}

/* Tables — collapsed hairline borders, mono numerics. The narrow
   column makes tables rare, but when they appear this keeps them
   legible. */
.ai-markdown :deep(table) {
  border-collapse: collapse;
  margin: 0.55em 0;
  font-size: 0.78rem;
  width: 100%;
}
.ai-markdown :deep(th),
.ai-markdown :deep(td) {
  border: 1px solid color-mix(in srgb, var(--vs-border, var(--border)) 50%, transparent);
  padding: 4px 7px;
  text-align: left;
  font-variant-numeric: tabular-nums;
}
.ai-markdown :deep(th) {
  background: var(--vs-bg-2, var(--bg-soft));
  font-weight: 600;
}

/* Horizontal rule — single hairline, like other panel dividers. */
.ai-markdown :deep(hr) {
  border: 0;
  border-top: 1px solid color-mix(in srgb, var(--vs-border, var(--border)) 60%, transparent);
  margin: 0.9em 0;
}

/* Links — accent color, no underline by default; underline on hover
   so they read as interactive. */
.ai-markdown :deep(a) {
  color: var(--vs-accent, var(--accent));
  text-decoration: none;
}
.ai-markdown :deep(a:hover) { text-decoration: underline; }
.ai-finance-markdown :deep(.ai-finance-number) { text-align: right; }
</style>

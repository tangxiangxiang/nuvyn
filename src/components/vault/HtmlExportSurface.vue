<script setup lang="ts">
import RenderedMarkdown from './RenderedMarkdown.vue'
import type { DocumentExportSnapshot } from '../../lib/documentExport'
import type { Resolver } from '../../lib/wikiLinks'
import { buildHtmlDocument } from '../../lib/htmlExport'

const props = defineProps<{ snapshot: DocumentExportSnapshot; signal: AbortSignal; resolver?: Resolver; lang: string }>()
const emit = defineEmits<{ complete: [html: string]; failed: [error: unknown] }>()
let started = false
async function onRendered(article: HTMLElement | null) {
  if (started || props.signal.aborted) return
  if (!article) { emit('failed', new Error('HTML_EXPORT_RENDER_FAILED')); return }
  started = true
  try {
    const html = await buildHtmlDocument({ ...props, article })
    if (!props.signal.aborted) emit('complete', html)
  } catch (error) { if (!props.signal.aborted) emit('failed', error) }
}
</script>

<template>
  <div class="html-export-surface" aria-hidden="true" data-theme="light">
    <RenderedMarkdown :raw="snapshot.raw" :source-path="snapshot.path" :resolver="resolver" tag="article" render-theme="light" defer-images @rendered="onRendered" />
  </div>
</template>

<style scoped>
.html-export-surface { position: fixed; top: 0; left: -100000px; width: 960px; opacity: 0; pointer-events: none; color: #202124; background: #fff; color-scheme: light; --vs-text-1: #202124; --vs-bg-1: #fff; --vs-bg-2: #f5f6f8; --text: #202124; --code-bg: #f5f6f8; }
.html-export-surface :deep(.article.reading) { width: 960px; max-width: none; }
</style>

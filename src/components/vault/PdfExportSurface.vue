<script setup lang="ts">
import RenderedMarkdown from './RenderedMarkdown.vue'
import type { Resolver as WikiResolver } from '../../lib/wikiLinks'
import type { MarkdownResourceResolver } from '../../lib/markdownResources'

defineProps<{
  raw: string
  resolver?: WikiResolver
  sourcePath?: string
  resourceResolver?: MarkdownResourceResolver
}>()

const emit = defineEmits<{
  rendered: [el: HTMLElement | null]
}>()
</script>

<template>
  <!-- Keep a real layout box so Mermaid / MarkMap can measure themselves,
       while moving the renderer completely out of the visible workspace. -->
  <div class="pdf-export-surface" aria-hidden="true">
    <RenderedMarkdown
      :raw="raw"
      :resolver="resolver"
      :source-path="sourcePath"
      :resource-resolver="resourceResolver"
      tag="article"
      render-theme="light"
      @rendered="(el) => emit('rendered', el)"
    />
  </div>
</template>

<style scoped>
.pdf-export-surface {
  position: fixed;
  top: 0;
  left: -100000px;
  width: 720px;
  min-height: 1px;
  overflow: visible;
  opacity: 0;
  pointer-events: none;
}

.pdf-export-surface :deep(.article.reading) {
  width: 720px;
  max-width: none;
}
</style>

<script setup lang="ts">
import { inject, nextTick, ref, toRef, watch } from 'vue'
import { routerKey } from 'vue-router'
import { useMarkdownRender, type Heading } from '../../composables/vault/useMarkdownRender'
import { useMarkmapMount } from '../../composables/useMarkmapMount'
import { useMermaidMount } from '../../composables/useMermaidMount'
import { useMathMount } from '../../composables/useMathMount'
import { useCodeGroupMount } from '../../composables/useCodeGroupMount'
import { useBoardEmbedMount } from '../../composables/useBoardEmbedMount'
import { useVaultContext } from '../../composables/vault/context/useVaultContext'
import type { Resolver as WikiResolver } from '../../lib/wikiLinks'
import type { Theme } from '../../composables/useTheme'
import type { MarkdownResourceResolver } from '../../lib/markdownResources'

const props = withDefaults(defineProps<{
  raw: string
  resolver?: WikiResolver
  sourcePath?: string
  resourceResolver?: MarkdownResourceResolver
  tag?: 'div' | 'article'
  renderTheme?: Theme
}>(), { tag: 'div' })
const emit = defineEmits<{
  'update:headings': [headings: Heading[]]
  rendered: [el: HTMLElement | null]
}>()

const { html, error, headings, ready } = useMarkdownRender(
  toRef(props, 'raw'),
  props.resolver,
  {
    sourcePath: props.sourcePath,
    resourceResolver: props.resourceResolver,
  },
)
const articleEl = ref<HTMLElement | null>(null)
const vaultContext = useVaultContext()
const router = inject(routerKey, null)
useMarkmapMount(articleEl, toRef(props, 'renderTheme'))
useMermaidMount(articleEl, toRef(props, 'renderTheme'))
useMathMount(articleEl)
useCodeGroupMount(articleEl)
useBoardEmbedMount(articleEl, toRef(props, 'renderTheme'))

watch(headings, (value) => emit('update:headings', value), { immediate: true })
watch([ready, html, articleEl], async ([isReady]) => {
  // useMarkdownRender is asynchronous. articleEl is mounted once with an
  // empty html ref before the current Markdown source finishes rendering;
  // emitting that transient node made PDF export snapshot a blank article.
  if (!isReady) return
  await nextTick()
  emit('rendered', articleEl.value)
}, { flush: 'post', immediate: true })

function onArticleClick(event: MouseEvent) {
  if (event.button !== 0) return
  const boardLink = (event.target as HTMLElement | null)?.closest<HTMLAnchorElement>('a.board-embed-link')
  if (boardLink) {
    if (!router || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    void router.push(boardLink.getAttribute('href')!)
    return
  }
  const anchor = (event.target as HTMLElement | null)?.closest('a.wiki-link') as HTMLAnchorElement | null
  const destination = anchor?.dataset.target
  if (!destination) return
  event.preventDefault()
  void vaultContext.editor.openLink(destination, anchor.dataset.anchor)
}

defineExpose({ el: articleEl })
</script>

<template>
  <div v-if="error" class="render-error">{{ error }}</div>
  <component
    :is="tag"
    v-else
    ref="articleEl"
    class="article reading"
    v-html="html"
    @click="onArticleClick"
  />
</template>

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
import { copyTextToClipboard } from './workspaceTabActions'
import { useI18n } from '../../composables/useI18n'
import { useToast } from '../../composables/useToast'

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
const { t, locale } = useI18n()
const toast = useToast()
const copyButtons = new WeakMap<HTMLButtonElement, HTMLElement>()
const vaultContext = useVaultContext()
const router = inject(routerKey, null)
useMarkmapMount(articleEl, toRef(props, 'renderTheme'))
useMermaidMount(articleEl, toRef(props, 'renderTheme'))
useMathMount(articleEl)
useCodeGroupMount(articleEl)
useBoardEmbedMount(articleEl, toRef(props, 'renderTheme'))

watch(headings, (value) => emit('update:headings', value), { immediate: true })
watch([ready, html, articleEl, locale], async ([isReady]) => {
  // useMarkdownRender is asynchronous. articleEl is mounted once with an
  // empty html ref before the current Markdown source finishes rendering;
  // emitting that transient node made PDF export snapshot a blank article.
  if (!isReady) return
  await nextTick()
  for (const pre of articleEl.value?.querySelectorAll<HTMLElement>('pre.shiki[data-language]') ?? []) {
    const code = pre.querySelector<HTMLElement>(':scope > code')
    if (!code) continue
    let button = Array.from(pre.querySelectorAll<HTMLButtonElement>(':scope > button'))
      .find((candidate) => copyButtons.has(candidate))
    if (!button) {
      button = document.createElement('button')
      button.type = 'button'
      button.className = 'nuvyn-code-copy'
      button.textContent = pre.dataset.language ?? ''
      copyButtons.set(button, code)
      pre.append(button)
      pre.classList.add('has-code-copy')
    }
    button.title = t('editor.copy_code')
    button.setAttribute('aria-label', `${t('editor.copy_code')} (${pre.dataset.language})`)
  }
  emit('rendered', articleEl.value)
}, { flush: 'post', immediate: true })

async function onArticleClick(event: MouseEvent) {
  if (event.button !== 0) return
  const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('button.nuvyn-code-copy')
  const code = button && copyButtons.get(button)
  if (button && code) {
    event.preventDefault()
    if (button.disabled) return
    const clone = code.cloneNode(true) as HTMLElement
    clone.querySelectorAll('.nuvyn-line-number').forEach((number) => number.remove())
    button.disabled = true
    const copied = await copyTextToClipboard(clone.textContent ?? '')
    button.disabled = false
    if (!articleEl.value?.contains(button)) return
    if (copied) toast.success(t('editor.code_copied'))
    else toast.error(t('vault.copy_failed'))
    return
  }
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

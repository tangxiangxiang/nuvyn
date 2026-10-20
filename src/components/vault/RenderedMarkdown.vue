<script setup lang="ts">
import { inject, nextTick, onBeforeUnmount, ref, toRef, watch } from 'vue'
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
import { enhanceMarkdownFolding, revealMarkdownTarget, type ReaderFolding } from '../../lib/markdownReaderFolding'
import { MARKDOWN_FOLDING_LIMIT } from '../../lib/markdownFolding'

const props = withDefaults(defineProps<{
  raw: string
  resolver?: WikiResolver
  sourcePath?: string
  resourceResolver?: MarkdownResourceResolver
  tag?: 'div' | 'article'
  renderTheme?: Theme
  deferImages?: boolean
  /** Only the interactive reader enables folding; export surfaces stay inert. */
  foldingEnabled?: boolean
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
    deferImages: props.deferImages,
  },
)
const articleEl = ref<HTMLElement | null>(null)
const { t, locale } = useI18n()
const toast = useToast()
const copyButtons = new WeakMap<HTMLButtonElement, HTMLElement>()
const vaultContext = useVaultContext()
const router = inject(routerKey, null)
let folding: ReaderFolding | null = null
let foldedRoot: HTMLElement | null = null
let foldedHtml: string | null = null
let foldedPath: string | undefined
const foldingLabels = () => ({
  expand: t('ai.tool_expand'), collapse: t('ai.tool_collapse'),
})
function clearFolding() {
  folding?.dispose()
  folding = null
  foldedRoot = null
  foldedHtml = null
}
onBeforeUnmount(clearFolding)
useMarkmapMount(articleEl, toRef(props, 'renderTheme'), props.deferImages)
useMermaidMount(articleEl, toRef(props, 'renderTheme'), props.deferImages)
useMathMount(articleEl)
useCodeGroupMount(articleEl)
useBoardEmbedMount(articleEl, toRef(props, 'renderTheme'))

watch(headings, (value) => emit('update:headings', value), { immediate: true })
watch([ready, html, articleEl, error, locale, () => props.foldingEnabled, () => props.sourcePath], async ([isReady], _previous, onCleanup) => {
  let cancelled = false
  onCleanup(() => { cancelled = true })
  // Invalidate unavailable/disabled surfaces even while a render is pending.
  // Keep a still-valid controller during ordinary asynchronous rendering.
  if (!articleEl.value || error.value || !props.foldingEnabled
    || (foldedRoot && foldedRoot !== articleEl.value)) clearFolding()
  // useMarkdownRender is asynchronous. articleEl is mounted once with an
  // empty html ref before the current Markdown source finishes rendering;
  // emitting that transient node made PDF export snapshot a blank article.
  if (!isReady) return
  await nextTick()
  if (cancelled || !ready.value) return
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
  const root = articleEl.value
  if (!props.foldingEnabled || props.raw.length >= MARKDOWN_FOLDING_LIMIT || !root) clearFolding()
  else if (foldedRoot !== root || foldedHtml !== html.value || foldedPath !== props.sourcePath) {
    clearFolding()
    folding = enhanceMarkdownFolding(root, foldingLabels())
    foldedRoot = root
    foldedHtml = html.value
    foldedPath = props.sourcePath
  } else folding?.updateLabels(foldingLabels())
  emit('rendered', articleEl.value)
}, { flush: 'post', immediate: true })

async function onArticleClick(event: MouseEvent) {
  if (event.button !== 0) return
  const localAnchor = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[href^="#"]')
  if (localAnchor && articleEl.value) {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
    let id: string
    try { id = decodeURIComponent(localAnchor.hash.slice(1)) } catch { return }
    const target = Array.from(articleEl.value.querySelectorAll<HTMLElement>('[id]')).find((el) => el.id === id)
    if (target) {
      event.preventDefault()
      revealMarkdownTarget(articleEl.value, target)
      target.scrollIntoView({ block: 'start' })
      if (history.replaceState) history.replaceState(history.state, '', `#${encodeURIComponent(id)}`)
    }
    return
  }
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

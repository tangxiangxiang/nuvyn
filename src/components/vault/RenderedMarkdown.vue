<script setup lang="ts">
import { inject, nextTick, onBeforeUnmount, onMounted, ref, toRef, watch } from 'vue'
import { NButton } from 'naive-ui'
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
  /** Interactive Note reader only; export renderers leave this disabled. */
  speechEnabled?: boolean
}>(), { tag: 'div' })
const emit = defineEmits<{
  'update:headings': [headings: Heading[]]
  rendered: [el: HTMLElement | null]
  'read-selection': [text: string]
  'correct-pronunciation': [text: string]
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
const selectionAction = ref<{ text: string; top: number; left: number } | null>(null)
const copyButtons = new WeakMap<HTMLButtonElement, HTMLElement>()
const groupCopyButtons = new WeakMap<HTMLButtonElement, HTMLElement>()
const vaultContext = useVaultContext()
const router = inject(routerKey, null)
let folding: ReaderFolding | null = null
let foldedRoot: HTMLElement | null = null
let foldedHtml: string | null = null
let foldedPath: string | undefined

const CODE_ACTION_REVEAL_MS = 3000
type CodeTouch = { identifier: number; x: number; y: number; startedAt: number; pre: HTMLElement }
let codeTouch: CodeTouch | null = null
let visibleCodeBlock: HTMLElement | null = null
let codeRevealTimer: ReturnType<typeof setTimeout> | null = null

function readArticleSelection(): { text: string; top: number; left: number } | null {
  const root = articleEl.value
  const selection = window.getSelection()
  if (!props.speechEnabled || !root || !selection || selection.isCollapsed || !selection.toString().trim()) return null
  const anchor = selection.anchorNode
  const focus = selection.focusNode
  if (!anchor || !focus || !root.contains(anchor) || !root.contains(focus)) return null
  const range = selection.getRangeAt(0)
  const rect = range.getBoundingClientRect()
  const width = 360
  const left = Math.max(10, Math.min(window.innerWidth - width - 10, rect.left + rect.width / 2 - width / 2))
  return { text: selection.toString(), top: Math.max(8, rect.top - 44), left }
}

function updateSelectionAction(): void {
  selectionAction.value = readArticleSelection()
}

function onSelectionContextMenu(event: MouseEvent): void {
  const action = readArticleSelection()
  if (!action) return
  const isTouch = typeof window.matchMedia === 'function'
    && window.matchMedia('(hover: none) and (pointer: coarse)').matches
  if (!isTouch) event.preventDefault()
  selectionAction.value = action
}

function onDocumentPointerDown(event: PointerEvent): void {
  const target = event.target
  if (target instanceof Element && target.closest('.note-reading-selection-actions')) return
  if (target instanceof Node && articleEl.value?.contains(target)) return
  selectionAction.value = null
}

async function copySelectedText(): Promise<void> {
  const text = selectionAction.value?.text
  if (!text) return
  const copied = await copyTextToClipboard(text)
  selectionAction.value = null
  if (copied) toast.success(t('vault.content_copied'))
  else toast.error(t('vault.copy_failed'))
}

function speakSelectedText(): void {
  const text = selectionAction.value?.text
  selectionAction.value = null
  if (text) emit('read-selection', text)
}

function correctSelectedPronunciation(): void {
  const text = selectionAction.value?.text
  selectionAction.value = null
  if (text && props.speechEnabled) emit('correct-pronunciation', text.trim())
}

watch(() => props.speechEnabled, (enabled) => {
  if (enabled) document.addEventListener('selectionchange', updateSelectionAction)
  else {
    document.removeEventListener('selectionchange', updateSelectionAction)
    selectionAction.value = null
  }
}, { immediate: true, flush: 'sync' })
onMounted(() => document.addEventListener('pointerdown', onDocumentPointerDown))

function clearCodeActionReveal(): void {
  if (codeRevealTimer !== null) clearTimeout(codeRevealTimer)
  codeRevealTimer = null
  visibleCodeBlock?.classList.remove('is-code-actions-visible')
  visibleCodeBlock = null
  codeTouch = null
}

function revealCodeActions(pre: HTMLElement): void {
  clearCodeActionReveal()
  visibleCodeBlock = pre
  pre.classList.add('is-code-actions-visible')
  codeRevealTimer = setTimeout(clearCodeActionReveal, CODE_ACTION_REVEAL_MS)
}

function onCodeTouchStart(event: TouchEvent): void {
  codeTouch = null
  if (event.touches.length !== 1 || !(event.target instanceof Element)) return
  // Only interactive code blocks get a reveal; touching the copy button
  // must keep its native click-to-copy behavior.
  if (event.target.closest('button.nuvyn-code-copy')) return
  const pre = event.target.closest<HTMLElement>('pre.shiki[data-language]')
  if (!pre || !articleEl.value?.contains(pre)) return
  // Code groups expose a copy action in their tab bar. Only standalone
  // fences require a tap to reveal the floating language/copy action.
  const frame = pre.parentElement
  if (!frame?.classList.contains('nuvyn-code-frame')
    || !frame.querySelector(':scope > button.nuvyn-code-copy')) return
  const finger = event.touches[0]
  if (!finger) return
  codeTouch = { identifier: finger.identifier, x: finger.clientX, y: finger.clientY, startedAt: Date.now(), pre }
}

function onCodeTouchMove(event: TouchEvent): void {
  if (!codeTouch) return
  const finger = Array.from(event.touches).find(touch => touch.identifier === codeTouch?.identifier)
  if (!finger || Math.abs(finger.clientX - codeTouch.x) > 10
    || Math.abs(finger.clientY - codeTouch.y) > 10) codeTouch = null
}

function onCodeTouchEnd(event: TouchEvent): void {
  const start = codeTouch
  codeTouch = null
  if (!start || !articleEl.value?.contains(start.pre)) return
  const finger = Array.from(event.changedTouches).find(touch => touch.identifier === start.identifier)
  if (!finger || Math.abs(finger.clientX - start.x) > 10
    || Math.abs(finger.clientY - start.y) > 10
    || Date.now() - start.startedAt > 750
    || window.getSelection()?.toString()) return
  revealCodeActions(start.pre)
}

function createGroupCopyButton(): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'nuvyn-code-copy nuvyn-code-group-copy'
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.8')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  for (const [name, value] of Object.entries({ x: '8', y: '8', width: '14', height: '14', rx: '2' })) {
    rect.setAttribute(name, value)
  }
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2')
  svg.append(rect, path)
  button.append(svg)
  return button
}

const foldingLabels = () => ({
  expand: t('ai.tool_expand'), collapse: t('ai.tool_collapse'),
})
function clearFolding() {
  folding?.dispose()
  folding = null
  foldedRoot = null
  foldedHtml = null
}
onBeforeUnmount(() => {
  document.removeEventListener('selectionchange', updateSelectionAction)
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  selectionAction.value = null
  clearFolding()
  clearCodeActionReveal()
})
// A new article cannot inherit the previous document's transient action.
watch([html, () => props.sourcePath], clearCodeActionReveal)
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

    // The pre must retain native horizontal scrolling. Absolute controls
    // placed above it are clipped by overflow-x:auto, so standalone fences
    // get a layout-neutral outer positioning frame. Code groups already
    // display the language in their tab bar and retain their own overflow.
    // Group tabs already identify the language; copying belongs to the
    // group toolbar, never as a duplicate label inside each code panel.
    if (pre.closest('.nuvyn-code-group')) continue
    let owner: HTMLElement = pre
    const parent = pre.parentElement
    if (parent?.classList.contains('nuvyn-code-frame')) owner = parent
    else {
      const frame = document.createElement('div')
      frame.className = 'nuvyn-code-frame'
      pre.before(frame)
      frame.append(pre)
      owner = frame
    }
    let button = Array.from(owner.querySelectorAll<HTMLButtonElement>(':scope > button'))
      .find((candidate) => copyButtons.has(candidate))
    if (!button) {
      button = document.createElement('button')
      button.type = 'button'
      button.className = 'nuvyn-code-copy'
      button.textContent = pre.dataset.language ?? ''
      copyButtons.set(button, code)
      owner.append(button)
      pre.classList.add('has-code-copy')
    }
    button.title = t('editor.copy_code')
    button.setAttribute('aria-label', `${t('editor.copy_code')} (${pre.dataset.language})`)
  }
  for (const group of articleEl.value?.querySelectorAll<HTMLElement>('.nuvyn-code-group') ?? []) {
    const tabs = group.querySelector<HTMLElement>(':scope > .nuvyn-code-group-tabs[role="tablist"]')
    const activeCode = group.querySelector<HTMLElement>(
      ':scope > .nuvyn-code-group-panels > .nuvyn-code-group-panel.is-active > pre.shiki > code',
    )
    if (!tabs || !activeCode) continue
    let button = Array.from(group.children).find((child): child is HTMLButtonElement => (
      child instanceof HTMLButtonElement && groupCopyButtons.has(child)
    ))
    if (!button) {
      button = createGroupCopyButton()
      // Follow the tablist in keyboard order, before the code panels.
      tabs.after(button)
      groupCopyButtons.set(button, group)
    }
    button.title = t('editor.copy_code')
    button.setAttribute('aria-label', t('editor.copy_code'))
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
  const group = button && groupCopyButtons.get(button)
  const code = button && (copyButtons.get(button) ?? group?.querySelector<HTMLElement>(
    ':scope > .nuvyn-code-group-panels > .nuvyn-code-group-panel.is-active > pre.shiki > code',
  ))
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
    @contextmenu="onSelectionContextMenu"
    @mouseup="updateSelectionAction"
    @touchstart.passive="onCodeTouchStart"
    @touchmove.passive="onCodeTouchMove"
    @touchend.passive="onCodeTouchEnd"
    @touchcancel.passive="clearCodeActionReveal"
  />
  <Teleport to="body">
    <div v-if="selectionAction && speechEnabled" class="note-reading-selection-actions"
      :style="{ top: `${selectionAction.top}px`, left: `${selectionAction.left}px` }"
      data-testid="note-reading-selection-actions" @pointerdown.stop>
      <NButton size="small" type="primary" @click="speakSelectedText">{{ t('note.speech_read_selection') }}</NButton>
      <NButton size="small" @click="correctSelectedPronunciation">{{ t('speech.correct') }}</NButton>
      <NButton size="small" quaternary @click="copySelectedText">{{ t('note.speech_copy') }}</NButton>
    </div>
  </Teleport>
</template>

<style scoped>
.note-reading-selection-actions {
  position: fixed;
  z-index: 4000;
  display: flex;
  gap: 4px;
  padding: 4px;
  border: 1px solid var(--border, #dfe2e8);
  border-radius: 9px;
  background: var(--bg, #fff);
  box-shadow: 0 4px 18px rgb(20 24 40 / 16%);
}
</style>

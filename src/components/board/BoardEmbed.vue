<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from '../../composables/useI18n'
import type { Theme } from '../../composables/useTheme'
import { BoardApiError, getBoardMetadata } from '../../features/board/api'
import { boardMetadataSource } from '../../features/board/boardMetadataSource'
import { loadBoardPreview } from '../../features/board/preview'
import { parseBoardReference } from '../../lib/boardReferences'
import type { PdfEnhancementState } from '../../lib/pdf-readiness'

const props = defineProps<{
  boardId: string
  label?: string
  renderTheme?: Theme
}>()
const { t } = useI18n()
const title = ref(props.label || t('board.embed_label'))
const imageUrl = ref('')
const state = ref<PdfEnhancementState>('pending')
const outcome = ref<'image' | 'empty' | 'missing' | 'failed'>('empty')
const revision = ref<number | null>(null)
const href = computed(() => `/board/${encodeURIComponent(props.boardId)}`)
const statusText = computed(() => {
  if (state.value === 'pending') return t('board.embed_loading')
  if (outcome.value === 'missing') return t('board.embed_missing')
  if (outcome.value === 'failed') return t('board.embed_failed')
  return t('board.embed_empty')
})

let generation = 0
let imageGeneration = 0
let disposed = false
let loadedUpdatedAt: number | null = null
let controller: AbortController | null = null
let metadataController: AbortController | null = null
let refreshTimer: ReturnType<typeof setInterval> | null = null

function replaceImage(url = ''): void {
  const previous = imageUrl.value
  imageUrl.value = url
  if (previous) URL.revokeObjectURL(previous)
}

function showError(error: unknown): void {
  replaceImage()
  outcome.value = error instanceof BoardApiError && error.status === 404 ? 'missing' : 'failed'
  state.value = 'error'
}

async function loadPreview(): Promise<void> {
  if (disposed) return
  const current = ++generation
  controller?.abort()
  metadataController?.abort()
  metadataController = null
  const request = new AbortController()
  controller = request
  state.value = 'pending'
  try {
    if (!parseBoardReference(`board:${props.boardId}`)) throw new Error('Invalid Board reference')
    const preview = await loadBoardPreview(props.boardId, request.signal)
    if (disposed || current !== generation) return
    title.value = preview.metadata.title
    loadedUpdatedAt = preview.metadata.updatedAt
    revision.value = preview.revision
    outcome.value = preview.image ? 'image' : 'empty'
    imageGeneration = current
    replaceImage(preview.image ? URL.createObjectURL(preview.image) : '')
    // The image's load event settles a non-empty preview for PDF export.
    if (!preview.image) state.value = 'ready'
  } catch (error) {
    if (disposed || current !== generation || request.signal.aborted) return
    showError(error)
  }
}

async function refresh(): Promise<void> {
  if (disposed || document.hidden || state.value === 'pending' || metadataController) return
  const current = generation
  const request = new AbortController()
  metadataController = request
  try {
    const metadata = await getBoardMetadata(props.boardId, request.signal)
    if (disposed || current !== generation || request.signal.aborted) return
    title.value = metadata.title
    if (metadata.updatedAt !== loadedUpdatedAt || state.value === 'error') await loadPreview()
  } catch (error) {
    if (disposed || current !== generation || request.signal.aborted) return
    // Never leave a deleted or inaccessible Board displayed as a current preview.
    showError(error)
  } finally {
    if (metadataController === request) metadataController = null
  }
}

function onImageLoad(event: Event): void {
  if (!disposed && imageGeneration === generation && (event.target as HTMLImageElement).getAttribute('src') === imageUrl.value) state.value = 'ready'
}

function onImageError(event: Event): void {
  if (!disposed && imageGeneration === generation && (event.target as HTMLImageElement).getAttribute('src') === imageUrl.value) showError(new Error('Image unavailable'))
}

watch(() => props.boardId, () => {
  loadedUpdatedAt = null
  revision.value = null
  title.value = props.label || t('board.embed_label')
  replaceImage()
  void loadPreview()
}, { immediate: true })

watch(() => boardMetadataSource.snapshot.value.find((board) => board.id === props.boardId), (metadata, previous) => {
  if (state.value === 'pending' || props.renderTheme) return
  if (metadata) {
    title.value = metadata.title
    if (metadata.updatedAt !== loadedUpdatedAt) void loadPreview()
  } else if (previous) {
    void loadPreview()
  }
})

onMounted(() => {
  // An export surface is a one-shot snapshot. The visible Note additionally
  // refreshes on return and checks lightweight metadata for cross-tab edits.
  if (props.renderTheme) return
  window.addEventListener('focus', refresh)
  document.addEventListener('visibilitychange', refresh)
  refreshTimer = setInterval(() => { void refresh() }, 15_000)
})

onBeforeUnmount(() => {
  disposed = true
  generation += 1
  controller?.abort()
  metadataController?.abort()
  if (refreshTimer) clearInterval(refreshTimer)
  window.removeEventListener('focus', refresh)
  document.removeEventListener('visibilitychange', refresh)
  replaceImage()
})
</script>

<template>
  <span
    class="board-embed"
    :data-board-id="boardId"
    :data-board-revision="revision"
    :data-board-state="state"
    :data-render-theme="renderTheme"
    :aria-busy="state === 'pending'"
  >
    <a v-if="imageUrl" :href="href" class="board-embed-link board-embed-preview" :title="t('board.embed_open')">
      <img :key="imageUrl" :src="imageUrl" :alt="title" @load="onImageLoad" @error="onImageError" />
    </a>
    <span v-else class="board-embed-status" role="status">
      <span>{{ statusText }}</span>
      <button v-if="state === 'error'" class="board-embed-retry" type="button" @click="loadPreview">{{ t('board.embed_retry') }}</button>
    </span>
  </span>
</template>

<style scoped>
.board-embed {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  margin: 1em 0;
  border: 1px solid var(--vs-border, var(--border));
  border-radius: 12px;
  background: var(--vs-bg-1, var(--bg));
}
.board-embed .board-embed-preview {
  display: block;
  padding: 16px;
  background: #fff;
  text-decoration: none;
}
.board-embed .board-embed-preview img {
  display: block;
  width: auto;
  height: auto;
  max-width: 100%;
  max-height: min(480px, 60vh);
  margin: 0 auto;
  border: 0;
  border-radius: 0;
  object-fit: contain;
}
.board-embed-status {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  min-height: 140px;
  padding: 24px;
  color: var(--vs-text-3, var(--text-muted));
  font-size: 14px;
  text-align: center;
}
.board-embed-retry {
  padding: 0;
  border: 0;
  color: var(--vs-accent, var(--accent));
  background: none;
  font: inherit;
  cursor: pointer;
}
.board-embed a:focus-visible,
.board-embed-retry:focus-visible { outline: 2px solid var(--vs-accent, var(--accent)); outline-offset: -2px; }
.board-embed[data-render-theme="light"] { background: #fff; border-color: #e0e0e0; color: #666; }
</style>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { NButton, NModal, NSpin, type DropdownOption } from 'naive-ui'
import { Download, Paperclip, X } from '@vicons/tabler'
import { subscribeDiaryTeardown } from '../../composables/diary/useDiaryAccessSession'
import { diaryAttachmentsApi } from '../../lib/diary-attachments-api'
import type { DiaryAttachment } from '../../../shared/diaryAttachments'
import DiaryActionMenu from './DiaryActionMenu.vue'

type DraftAttachment = DiaryAttachment & { pending?: boolean; localPreviewUrl?: string }
const props = withDefaults(defineProps<{
  date: string
  attachments: DraftAttachment[]
  mode: 'read' | 'edit'
  embedded?: boolean
  targetEntryId?: string | null
  placementOptions?: Array<{ id: string; line: number }>
  disabled?: boolean
}>(), {
  embedded: false,
  targetEntryId: null,
  placementOptions: () => [],
})
const emit = defineEmits<{
  remove: [id: string]
  move: [id: string, targetEntryId: string | null]
}>()

const preview = ref<{ id: string; url: string; name: string } | null>(null)
const urls = reactive(new Map<string, string>())
const controllers = new Map<string, AbortController>()
const loads = new Map<string, Promise<void>>()
const visibleIds = new Set<string>()
const loading = ref(new Set<string>())
const failed = ref(new Set<string>())
const elements = new Map<string, HTMLElement>()
const refCallbacks = new Map<string, (node: unknown) => void>()
const downloadUrls = new Set<string>()
const gridVariant = computed(() => props.attachments.length === 1 ? 'is-single' : props.attachments.length === 2 ? 'is-double' : '')
let observer: IntersectionObserver | null = null
let active = true

function revoke(id: string) {
  const url = urls.get(id)
  if (url) URL.revokeObjectURL(url)
  urls.delete(id)
}

function clearAll() {
  active = false
  preview.value = null
  for (const controller of controllers.values()) controller.abort()
  controllers.clear()
  loads.clear()
  visibleIds.clear()
  loading.value = new Set()
  failed.value = new Set()
  for (const id of [...urls.keys()]) revoke(id)
  for (const url of downloadUrls) URL.revokeObjectURL(url)
  downloadUrls.clear()
}

async function loadImage(attachment: DraftAttachment) {
  if (!active || attachment.pending || attachment.mimeType === 'application/pdf' || urls.has(attachment.id)) return
  const pending = loads.get(attachment.id)
  if (pending) return pending
  const controller = new AbortController()
  controllers.set(attachment.id, controller)
  loading.value = new Set(loading.value).add(attachment.id)
  failed.value = new Set([...failed.value].filter(id => id !== attachment.id))
  const task = (async () => {
    try {
      const blob = await diaryAttachmentsApi.content(attachment, controller.signal)
      if (!active || controller.signal.aborted || controllers.get(attachment.id) !== controller) return
      urls.set(attachment.id, URL.createObjectURL(blob))
    } catch {
      if (active && !controller.signal.aborted) failed.value = new Set(failed.value).add(attachment.id)
    } finally {
      if (controllers.get(attachment.id) === controller) controllers.delete(attachment.id)
      loading.value = new Set([...loading.value].filter(id => id !== attachment.id))
    }
  })()
  loads.set(attachment.id, task)
  try { await task } finally {
    if (loads.get(attachment.id) === task) loads.delete(attachment.id)
  }
}

function tileRef(id: string) {
  let callback = refCallbacks.get(id)
  if (!callback) {
    callback = value => {
      const node = value instanceof Element ? value : null
      const previous = elements.get(id)
      if (previous) observer?.unobserve(previous)
      if (node instanceof HTMLElement) {
        elements.set(id, node)
        observer?.observe(node)
      } else {
        elements.delete(id)
      }
    }
    refCallbacks.set(id, callback)
  }
  return callback
}

function setVisible(id: string, visible: boolean) {
  const attachment = props.attachments.find(item => item.id === id)
  if (!attachment || attachment.mimeType === 'application/pdf') return
  if (visible) {
    visibleIds.add(id)
    void loadImage(attachment)
  } else {
    visibleIds.delete(id)
    if (preview.value?.id === id) return
    controllers.get(id)?.abort()
    controllers.delete(id)
    loads.delete(id)
    loading.value = new Set([...loading.value].filter(value => value !== id))
    revoke(id)
  }
}

function closePreview() {
  const id = preview.value?.id
  preview.value = null
  if (id && !visibleIds.has(id)) revoke(id)
}

function refreshObservedTiles() {
  observer?.disconnect()
  for (const element of elements.values()) observer?.observe(element)
}

const stopTeardown = subscribeDiaryTeardown(clearAll)
watch(() => JSON.stringify(props.attachments.map(item => [item.id, Boolean(item.pending), item.localPreviewUrl ?? null])), async () => {
  const retained = new Set(props.attachments.map(item => item.id))
  for (const id of [...urls.keys()]) if (!retained.has(id)) revoke(id)
  for (const [id, controller] of [...controllers]) {
    if (!retained.has(id)) { controller.abort(); controllers.delete(id) }
  }
  for (const [id, element] of [...elements]) {
    if (retained.has(id)) continue
    observer?.unobserve(element)
    elements.delete(id)
    refCallbacks.delete(id)
  }
  await nextTick()
  if (!active) return
  refreshObservedTiles()
  for (const id of visibleIds) {
    const attachment = props.attachments.find(item => item.id === id)
    if (attachment && !attachment.pending) void loadImage(attachment)
  }
}, { flush: 'post' })

onMounted(() => {
  if ('IntersectionObserver' in window) {
    observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const element = entry.target as HTMLElement
        setVisible(element.dataset.attachmentId ?? '', entry.isIntersecting)
      }
    }, { rootMargin: '80px' })
    void nextTick(refreshObservedTiles)
  }
})

onBeforeUnmount(() => {
  stopTeardown()
  observer?.disconnect()
  clearAll()
})

const imageActions = computed<DropdownOption[]>(() => [
  ...props.placementOptions
    .filter(option => option.id !== props.targetEntryId)
    .map(option => ({ key: option.id, label: `移动到第 ${option.line} 行后` })),
  ...(props.targetEntryId ? [{ key: 'end', label: '移动到日记末尾' }] : []),
  { key: 'remove', label: '移除图片' },
])
const pdfActions = [{ key: 'remove', label: '移除附件' }]

function selectAttachmentAction(id: string, action: string) {
  if (props.disabled) return
  if (action === 'remove') emit('remove', id)
  else emit('move', id, action === 'end' ? null : action)
}

async function openImage(attachment: DraftAttachment) {
  if (attachment.localPreviewUrl) {
    preview.value = { id: attachment.id, url: attachment.localPreviewUrl, name: attachment.name }
    return
  }
  if (attachment.pending) return
  if (!urls.has(attachment.id)) await loadImage(attachment)
  const url = urls.get(attachment.id)
  if (url && active) preview.value = { id: attachment.id, url, name: attachment.name }
}

async function downloadPdf(attachment: DraftAttachment) {
  if (!active) return
  const controller = new AbortController()
  controllers.set(attachment.id, controller)
  loading.value = new Set(loading.value).add(attachment.id)
  try {
    const blob = await diaryAttachmentsApi.content(attachment, controller.signal)
    if (!active || controller.signal.aborted) return
    const url = URL.createObjectURL(blob)
    downloadUrls.add(url)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = attachment.name
    anchor.click()
    window.setTimeout(() => {
      URL.revokeObjectURL(url)
      downloadUrls.delete(url)
    }, 60_000)
  } catch {
    failed.value = new Set(failed.value).add(attachment.id)
  } finally {
    if (controllers.get(attachment.id) === controller) controllers.delete(attachment.id)
    loading.value = new Set([...loading.value].filter(id => id !== attachment.id))
  }
}

</script>

<template>
  <section v-if="props.attachments.length" class="diary-attachment-section" :class="{ 'is-embedded': props.embedded }" :data-testid="props.embedded ? 'diary-attachment-gallery' : 'diary-attachments'">
    <header v-if="!props.embedded" class="diary-attachment-header"><h3>附件</h3></header>
    <div v-if="props.attachments.length" class="diary-attachment-grid" :class="gridVariant">
      <article v-for="attachment in props.attachments" :key="attachment.id" class="diary-attachment-item" :class="{ 'is-pdf': attachment.mimeType === 'application/pdf' }" :data-testid="`diary-attachment-${attachment.id}`">
        <button v-if="attachment.mimeType !== 'application/pdf'" :ref="tileRef(attachment.id)" type="button" class="diary-attachment-image" :data-attachment-id="attachment.id" :aria-label="`预览 ${attachment.name}`" @click="openImage(attachment)">
          <img v-if="attachment.localPreviewUrl || urls.get(attachment.id)" :src="attachment.localPreviewUrl || urls.get(attachment.id)" :alt="attachment.name" loading="lazy">
          <span v-else-if="loading.has(attachment.id)" class="diary-attachment-placeholder"><NSpin size="small" /></span>
          <span v-else-if="failed.has(attachment.id)" class="diary-attachment-placeholder is-error">加载失败</span>
          <span v-else class="diary-attachment-placeholder"><Paperclip :size="22" /></span>
        </button>
        <button v-else type="button" class="diary-attachment-pdf" :disabled="props.disabled || attachment.pending || loading.has(attachment.id)" :aria-label="`下载 ${attachment.name}`" @click="downloadPdf(attachment)">
          <NSpin v-if="loading.has(attachment.id)" size="small" />
          <Download v-else :size="22" />
        </button>
        <div v-if="attachment.mimeType === 'application/pdf'" class="diary-attachment-meta">
          <span class="diary-attachment-name" :title="attachment.name">{{ attachment.name }}</span>
          <small v-if="attachment.pending">待保存</small>
        </div>
        <DiaryActionMenu
          v-if="props.mode === 'edit'"
          contextual
          class="diary-attachment-actions"
          :label="`${attachment.name} 的操作`"
          :options="attachment.mimeType === 'application/pdf' ? pdfActions : imageActions"
          :disabled="props.disabled"
          @select="selectAttachmentAction(attachment.id, $event)"
        />
      </article>
    </div>
    <NModal v-if="preview" :show="true" :mask-closable="true" :close-on-esc="true" @update:show="value => !value && closePreview()">
      <div class="diary-attachment-preview" role="dialog" aria-modal="true" :aria-label="preview.name">
        <NButton attr-type="button" quaternary circle class="diary-attachment-preview-close" aria-label="关闭图片预览" @click="closePreview"><X :size="20" /></NButton>
        <img :src="preview.url" :alt="preview.name">
        <p>{{ preview.name }}</p>
      </div>
    </NModal>
  </section>
</template>

<style scoped>
.diary-attachment-section { display: flex; min-width: 0; flex-direction: column; gap: 12px; }
.diary-attachment-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 40px; }
.diary-attachment-header h3 { margin: 0; font-size: .95rem; font-weight: 600; }
.diary-attachment-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.diary-attachment-grid.is-single { grid-template-columns: minmax(0, 176px); }
.diary-attachment-grid.is-double { grid-template-columns: repeat(2, minmax(0, 176px)); max-width: 360px; }
.diary-attachment-item { position: relative; min-width: 0; overflow: hidden; border-radius: 10px; }
.diary-attachment-item.is-pdf { background: color-mix(in srgb, var(--text) 5%, transparent); }
.diary-attachment-image, .diary-attachment-pdf { display: grid; width: 100%; aspect-ratio: 1; place-items: center; padding: 0; border: 0; border-radius: 10px 10px 0 0; background: transparent; color: var(--text-muted); cursor: pointer; overflow: hidden; }
.diary-attachment-image { border-radius: 10px; }
.diary-attachment-image img { display: block; width: 100%; height: 100%; object-fit: cover; }
.diary-attachment-placeholder { display: grid; width: 100%; height: 100%; place-items: center; color: var(--text-muted); }
.diary-attachment-placeholder.is-error { font-size: .78rem; }
.diary-attachment-pdf { background: color-mix(in srgb, var(--accent) 8%, transparent); color: var(--accent); }
.diary-attachment-meta { display: flex; min-width: 0; flex-direction: column; gap: 2px; padding: 7px 9px 9px; }
.diary-attachment-name { overflow: hidden; color: var(--text); font-size: .82rem; text-overflow: ellipsis; white-space: nowrap; }
.diary-attachment-actions { position: absolute; z-index: 1; top: 4px; right: 4px; color: #fff; }
.diary-attachment-actions :deep(.diary-action-trigger) { position: relative; isolation: isolate; }
.diary-attachment-actions :deep(.diary-action-trigger)::before {
  position: absolute;
  z-index: -1;
  inset: 4px;
  border-radius: 8px;
  background: rgb(18 20 24 / 68%);
  content: '';
}
.diary-attachment-preview { position: relative; display: grid; width: min(94vw, 1100px); height: min(90dvh, 900px); place-items: center; gap: 8px; padding: 24px; border-radius: 12px; background: var(--card); color: var(--text); box-sizing: border-box; }
.diary-attachment-preview img { display: block; max-width: 100%; max-height: calc(100% - 38px); object-fit: contain; }
.diary-attachment-preview p { max-width: 100%; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.diary-attachment-preview-close { position: absolute; top: 8px; right: 8px; z-index: 1; min-width: 40px; min-height: 40px; background: color-mix(in srgb, var(--card) 80%, transparent); }
@media (max-width: 600px) { .diary-attachment-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; } .diary-attachment-grid.is-single { grid-template-columns: minmax(0, 144px); } .diary-attachment-grid.is-double { grid-template-columns: repeat(2, minmax(0, 144px)); max-width: 294px; } .diary-attachment-preview { width: 100vw; height: 90dvh; border-radius: 16px 16px 0 0; padding: 20px 12px calc(20px + env(safe-area-inset-bottom)); } }
</style>

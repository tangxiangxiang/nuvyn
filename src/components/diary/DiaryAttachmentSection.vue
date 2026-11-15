<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { NButton, NModal, NSpin } from 'naive-ui'
import { ArrowsCross, Download, Paperclip, Plus, X } from '@vicons/tabler'
import { subscribeDiaryTeardown } from '../../composables/diary/useDiaryAccessSession'
import { diaryAttachmentsApi } from '../../lib/diary-attachments-api'
import type { DiaryAttachment } from '../../../shared/diaryAttachments'

type DraftAttachment = DiaryAttachment & { pending?: boolean; localPreviewUrl?: string }
const props = withDefaults(defineProps<{
  date: string
  attachments: DraftAttachment[]
  mode: 'read' | 'edit'
  embedded?: boolean
  showAdd?: boolean
  addLabel?: string
  imageOnly?: boolean
  targetEntryId?: string | null
  placementOptions?: Array<{ id: string; label: string }>
  disabled?: boolean
  uploading?: boolean
  error?: string
}>(), {
  embedded: false,
  showAdd: true,
  addLabel: '添加附件',
  imageOnly: false,
  targetEntryId: null,
  placementOptions: () => [],
})
const emit = defineEmits<{
  add: [files: File[], targetEntryId: string | null]
  remove: [id: string]
  move: [id: string, targetEntryId: string | null]
}>()

const input = ref<HTMLInputElement | null>(null)
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

function selectFiles(event: Event) {
  const element = event.currentTarget as HTMLInputElement
  const files = Array.from(element.files ?? [])
  element.value = ''
  if (files.length) emit('add', files, props.targetEntryId)
}

function moveAttachment(id: string, event: Event) {
  const target = (event.currentTarget as HTMLSelectElement).value
  emit('move', id, target || null)
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
  <section v-if="props.attachments.length || (props.mode === 'edit' && props.showAdd)" class="diary-attachment-section" :class="{ 'is-embedded': props.embedded }" :data-testid="props.embedded ? 'diary-attachment-gallery' : 'diary-attachments'">
    <header v-if="!props.embedded || (props.mode === 'edit' && props.showAdd)" class="diary-attachment-header" :class="{ 'is-embedded': props.embedded }">
      <h3 v-if="!props.embedded">附件</h3>
      <NButton v-if="props.mode === 'edit' && props.showAdd" attr-type="button" quaternary :disabled="props.disabled || props.uploading" :data-testid="props.targetEntryId ? 'diary-add-entry-image' : 'diary-add-attachment'" @click="input?.click()">
        <template #icon><Plus :size="16" /></template>{{ props.addLabel }}
      </NButton>
      <input ref="input" data-testid="diary-attachment-input" class="diary-attachment-input" type="file" multiple :accept="props.imageOnly ? 'image/png,image/jpeg,image/webp,image/gif,image/avif,.png,.jpg,.jpeg,.webp,.gif,.avif' : 'image/png,image/jpeg,image/webp,image/gif,image/avif,application/pdf,.png,.jpg,.jpeg,.webp,.gif,.avif,.pdf'" @change="selectFiles">
    </header>
    <p v-if="props.uploading" class="diary-attachment-status" role="status"><NSpin size="small" />正在加密上传…</p>
    <p v-if="props.error" class="diary-attachment-error" role="alert">{{ props.error }}</p>
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
        <label v-if="props.mode === 'edit' && attachment.mimeType !== 'application/pdf' && props.placementOptions.length" class="diary-attachment-move">
          <ArrowsCross :size="15" aria-hidden="true" />
          <select :value="props.targetEntryId ?? ''" :aria-label="`移动 ${attachment.name} 到其他日记条目`" :disabled="props.disabled || props.uploading" @change="moveAttachment(attachment.id, $event)">
            <option value="">未关联文字（末尾）</option>
            <option v-for="option in props.placementOptions" :key="option.id" :value="option.id">移至：{{ option.label }}</option>
          </select>
        </label>
        <button v-if="props.mode === 'edit'" type="button" class="diary-attachment-remove" :disabled="props.disabled || props.uploading" :aria-label="`移除 ${attachment.name}`" @click="emit('remove', attachment.id)"><X :size="16" /></button>
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
.diary-attachment-header.is-embedded { justify-content: flex-start; min-height: 32px; }
.diary-attachment-header h3 { margin: 0; font-size: .95rem; font-weight: 600; }
.diary-attachment-header :deep(.n-button) { min-height: 40px; }
.diary-attachment-header.is-embedded :deep(.n-button) { min-height: 32px; padding-inline: 0; }
.diary-attachment-input { display: none; }
.diary-attachment-status { display: flex; align-items: center; gap: 8px; margin: 0; color: var(--text-muted); font-size: .88rem; }
.diary-attachment-error { margin: 0; color: var(--error, #d03050); font-size: .88rem; white-space: pre-line; }
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
.diary-attachment-move { position: absolute; z-index: 1; top: 6px; left: 6px; display: grid; width: 32px; height: 32px; place-items: center; border-radius: 8px; background: rgb(18 20 24 / 68%); color: #fff; cursor: pointer; }
.diary-attachment-move select { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
.diary-attachment-move:focus-within { outline: 2px solid var(--accent); outline-offset: 1px; }
.diary-attachment-remove { position: absolute; z-index: 1; top: 4px; right: 4px; display: grid; width: 40px; min-width: 40px; height: 40px; place-items: center; padding: 0; border: 0; border-radius: 10px; background: transparent; color: #fff; cursor: pointer; opacity: 1; transition: opacity 140ms ease; }
.diary-attachment-remove::before { position: absolute; inset: 4px; border-radius: 8px; background: rgb(18 20 24 / 68%); content: ''; transition: background-color 140ms ease; }
.diary-attachment-remove > svg { position: relative; width: 16px; height: 16px; }
.diary-attachment-remove:hover:not(:disabled)::before { background: rgb(12 14 18 / 82%); }
.diary-attachment-remove:focus-visible { outline: 2px solid var(--accent); outline-offset: -1px; opacity: 1; }
.diary-attachment-remove:disabled { cursor: not-allowed; }
@media (hover: hover) and (pointer: fine) {
  .diary-attachment-remove { opacity: 0; pointer-events: none; }
  .diary-attachment-item:hover .diary-attachment-remove,
  .diary-attachment-item:focus-within .diary-attachment-remove,
  .diary-attachment-remove:focus-visible { opacity: 1; pointer-events: auto; }
}
@media (hover: none) {
  .diary-attachment-remove { opacity: 1; pointer-events: auto; }
}
@media (prefers-reduced-motion: reduce) {
  .diary-attachment-remove,
  .diary-attachment-remove::before { transition: none; }
}
.diary-attachment-preview { position: relative; display: grid; width: min(94vw, 1100px); height: min(90dvh, 900px); place-items: center; gap: 8px; padding: 24px; border-radius: 12px; background: var(--card); color: var(--text); box-sizing: border-box; }
.diary-attachment-preview img { display: block; max-width: 100%; max-height: calc(100% - 38px); object-fit: contain; }
.diary-attachment-preview p { max-width: 100%; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.diary-attachment-preview-close { position: absolute; top: 8px; right: 8px; z-index: 1; min-width: 40px; min-height: 40px; background: color-mix(in srgb, var(--card) 80%, transparent); }
@media (max-width: 600px) { .diary-attachment-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; } .diary-attachment-grid.is-single { grid-template-columns: minmax(0, 144px); } .diary-attachment-grid.is-double { grid-template-columns: repeat(2, minmax(0, 144px)); max-width: 294px; } .diary-attachment-preview { width: 100vw; height: 90dvh; border-radius: 16px 16px 0 0; padding: 20px 12px calc(20px + env(safe-area-inset-bottom)); } }
</style>

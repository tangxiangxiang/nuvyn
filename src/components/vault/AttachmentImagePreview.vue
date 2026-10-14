<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { NButton, NSpin } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { fetchAttachmentPreview } from '../../lib/attachmentPreview'
import type { ManagedAttachment } from '../../../shared/attachmentProtocol'

const props = defineProps<{
  item: ManagedAttachment
  compact?: boolean
}>()
const { t } = useI18n()
const loading = ref(false)
const error = ref(false)
const objectUrl = ref<string | null>(null)
let controller: AbortController | null = null
let requestSequence = 0

function clearObjectUrl(): void {
  if (!objectUrl.value) return
  URL.revokeObjectURL(objectUrl.value)
  objectUrl.value = null
}

async function loadPreview(): Promise<void> {
  controller?.abort()
  const currentController = new AbortController()
  controller = currentController
  const current = ++requestSequence
  clearObjectUrl()
  loading.value = true
  error.value = false
  try {
    const blob = await fetchAttachmentPreview(props.item, currentController.signal)
    if (current !== requestSequence || currentController.signal.aborted) return
    objectUrl.value = URL.createObjectURL(blob)
  } catch {
    if (current === requestSequence && !currentController.signal.aborted) error.value = true
  } finally {
    if (current === requestSequence) loading.value = false
  }
}

function onPreviewImageError(event: Event): void {
  const image = event.currentTarget
  if (!(image instanceof HTMLImageElement) || image.getAttribute('src') !== objectUrl.value) return
  error.value = true
  clearObjectUrl()
}

watch(() => `${props.item.key.kind}:${props.item.key.kind === 'vault-file' ? props.item.key.path : props.item.key.id}:${props.item.modifiedAt ?? ''}:${props.item.byteSize ?? ''}`, () => {
  void loadPreview()
}, { immediate: true })

onBeforeUnmount(() => {
  requestSequence += 1
  controller?.abort()
  clearObjectUrl()
})
</script>

<template>
  <div class="attachment-image-preview" :class="{ 'is-compact': compact }" :aria-busy="loading">
    <div v-if="loading" class="attachment-image-preview-state" role="status"><NSpin size="small" /><span>{{ t('attachments.preview.loading') }}</span></div>
    <div v-else-if="error" class="attachment-image-preview-state is-error" role="status">
      <span>{{ t('attachments.preview.failed') }}</span>
      <NButton size="tiny" quaternary @click="loadPreview">{{ t('attachments.preview.retry') }}</NButton>
    </div>
    <img v-else-if="objectUrl" :src="objectUrl" :alt="item.displayName ?? t('attachments.type.image')" @error="onPreviewImageError" />
    <div v-else class="attachment-image-preview-state">{{ t('attachments.preview.unavailable') }}</div>
  </div>
</template>

<style scoped>
.attachment-image-preview { min-height: 140px; display: grid; place-items: center; overflow: hidden; border: 1px solid var(--settings-border); border-radius: 8px; background: color-mix(in srgb, var(--settings-card) 88%, var(--settings-muted)); }
.attachment-image-preview.is-compact { min-height: 110px; }
.attachment-image-preview img { display: block; max-width: 100%; max-height: min(34vh, 420px); object-fit: contain; }
.attachment-image-preview-state { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 20px; color: var(--settings-muted); font-size: .8rem; text-align: center; }
.attachment-image-preview-state.is-error { color: var(--settings-danger); }
</style>

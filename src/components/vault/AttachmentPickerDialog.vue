<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { NButton, NEmpty, NInput, NModal, NSelect, NSpin, NTag } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { listAttachments } from '../../lib/attachments-api'
import { isCanonicalVaultImagePath } from '../../lib/attachmentPreview'
import AttachmentImagePreview from './AttachmentImagePreview.vue'
import type { AttachmentPage, AttachmentSource, ManagedAttachment } from '../../../shared/attachmentProtocol'

const props = defineProps<{
  show: boolean
  target: 'note' | 'board'
}>()
const emit = defineEmits<{
  close: []
  select: [item: ManagedAttachment]
  upload: []
}>()
const { t } = useI18n()
const page = ref<AttachmentPage | null>(null)
const selectedKey = ref('')
const search = ref('')
const source = ref<AttachmentSource | 'all'>('all')
const type = ref<'all' | 'raster' | 'svg'>('all')
const offset = ref(0)
const loading = ref(false)
const failed = ref(false)
const previewableMimeTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml'])
let requestSequence = 0
let controller: AbortController | null = null
let searchTimer: ReturnType<typeof setTimeout> | null = null

function itemKey(item: ManagedAttachment): string {
  return item.key.kind === 'vault-file' ? `vault-file:${item.key.path}` : `${item.key.kind}:${item.key.id}`
}

function operationKey(item: ManagedAttachment): 'direct_reference' | 'import_copy' | 'reuse_asset' {
  if (item.key.kind === 'vault-file' && props.target === 'note') return 'direct_reference'
  if (item.key.kind === 'asset' && props.target === 'board') return 'reuse_asset'
  return 'import_copy'
}

const supportedItems = computed(() => (page.value?.items ?? []).filter((item) => (
  item.type === 'image'
  && ((item.key.kind === 'asset' && previewableMimeTypes.has(item.mimeType?.toLowerCase() ?? ''))
    || (item.key.kind === 'vault-file' && isCanonicalVaultImagePath(item.key.path)))
)))
const filteredItems = computed(() => supportedItems.value.filter((item) => {
  const mime = item.mimeType?.toLowerCase() ?? ''
  return type.value === 'all' || (type.value === 'svg' ? mime === 'image/svg+xml' : mime !== 'image/svg+xml')
}))
const selected = computed(() => filteredItems.value.find((item) => itemKey(item) === selectedKey.value) ?? null)
const hasNext = computed(() => Boolean(page.value && page.value.offset + page.value.limit < page.value.total))

async function loadPage(): Promise<void> {
  controller?.abort()
  const nextController = new AbortController()
  controller = nextController
  const current = ++requestSequence
  loading.value = true
  failed.value = false
  try {
    const result = await listAttachments({
      search: search.value.trim() || undefined,
      type: 'image',
      source: source.value === 'all' ? undefined : source.value,
      offset: offset.value,
      limit: 30,
    }, nextController.signal)
    if (current !== requestSequence || nextController.signal.aborted) return
    page.value = result
    if (!result.items.some((item) => itemKey(item) === selectedKey.value)) selectedKey.value = ''
  } catch {
    if (current === requestSequence && !nextController.signal.aborted) failed.value = true
  } finally {
    if (current === requestSequence) loading.value = false
  }
}

function scheduleLoad(): void {
  offset.value = 0
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => { void loadPage() }, 180)
}

function close(): void {
  emit('close')
}

function confirmSelection(): void {
  if (selected.value) emit('select', selected.value)
}

watch(() => props.show, (show) => {
  if (show) {
    selectedKey.value = ''
    offset.value = 0
    void loadPage()
  } else {
    requestSequence += 1
    controller?.abort()
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = null
    page.value = null
  }
})
watch([search, source], scheduleLoad)
onBeforeUnmount(() => {
  requestSequence += 1
  controller?.abort()
  if (searchTimer) clearTimeout(searchTimer)
})
</script>

<template>
  <NModal :show="show" preset="card" :title="t('attachments.picker.title')" class="attachment-picker-modal" :mask-closable="true" @update:show="(value) => { if (!value) close() }" @esc="close">
    <div class="attachment-picker">
      <div class="attachment-picker-filters">
        <NInput v-model:value="search" clearable :placeholder="t('attachments.search_placeholder')" :aria-label="t('attachments.search')" />
        <NSelect v-model:value="source" :options="[
          { label: t('attachments.filter.all_sources'), value: 'all' },
          { label: t('attachments.source.vault-file'), value: 'vault-file' },
          { label: t('attachments.source.board-asset'), value: 'board-asset' },
        ]" :to="false" :aria-label="t('attachments.filter.source')" />
        <NSelect v-model:value="type" :options="[
          { label: t('attachments.picker.type_all'), value: 'all' },
          { label: t('attachments.picker.type_raster'), value: 'raster' },
          { label: t('attachments.picker.type_svg'), value: 'svg' },
        ]" :to="false" :aria-label="t('attachments.picker.type')" />
      </div>
      <div class="attachment-picker-body">
        <div class="attachment-picker-list" role="listbox" :aria-label="t('attachments.picker.title')" :aria-busy="loading">
          <div v-if="loading && !page" class="attachment-picker-state" role="status"><NSpin size="small" /></div>
          <div v-else-if="failed" class="attachment-picker-state is-error" role="alert">
            <span>{{ t('attachments.load_failed') }}</span>
            <NButton size="small" @click="loadPage">{{ t('attachments.retry') }}</NButton>
          </div>
          <NEmpty v-else-if="filteredItems.length === 0" class="attachment-picker-empty" :description="t('attachments.no_matches')" />
          <button
            v-for="item in filteredItems"
            :key="itemKey(item)"
            type="button"
            role="option"
            class="attachment-picker-item"
            :aria-selected="selectedKey === itemKey(item)"
            @click="selectedKey = itemKey(item)"
          >
            <strong>{{ item.displayName || t('attachments.unnamed_asset', { id: item.key.kind === 'vault-file' ? item.key.path.slice(-8) : item.key.id.slice(0, 8) }) }}</strong>
            <small>{{ t(`attachments.source.${item.source}`) }} · {{ item.mimeType || t('attachments.not_available') }}</small>
            <small>{{ item.byteSize === null ? t('attachments.size_unknown') : `${(item.byteSize / 1024).toFixed(1)} KB` }}</small>
            <NTag size="small" :bordered="false">{{ t(`attachments.picker.${operationKey(item)}`) }}</NTag>
          </button>
          <div v-if="page && page.total > 30" class="attachment-picker-pagination">
            <NButton size="tiny" quaternary :disabled="loading || offset === 0" @click="offset = Math.max(0, offset - 30); void loadPage()">{{ t('attachments.previous') }}</NButton>
            <span>{{ Math.min(offset + 1, page.total) }}–{{ Math.min(offset + page.limit, page.total) }} / {{ page.total }}</span>
            <NButton size="tiny" quaternary :disabled="loading || !hasNext" @click="offset += 30; void loadPage()">{{ t('attachments.next') }}</NButton>
          </div>
        </div>
        <aside class="attachment-picker-preview" :aria-label="t('attachments.preview.title')">
          <AttachmentImagePreview v-if="selected" :item="selected" compact />
          <NEmpty v-else :description="t('attachments.select_item')" />
          <p v-if="selected" class="attachment-picker-operation">
            {{ t(`attachments.picker.${operationKey(selected)}_detail`, { target: t(`attachments.picker.target.${target}`) }) }}
          </p>
        </aside>
      </div>
      <footer class="attachment-picker-actions">
        <NButton v-if="target === 'note'" quaternary @click="emit('upload')">{{ t('attachments.picker.upload_new') }}</NButton>
        <span class="attachment-picker-spacer" />
        <NButton @click="close">{{ t('common.cancel') }}</NButton>
        <NButton type="primary" :disabled="!selected" @click="confirmSelection">{{ t('attachments.picker.select') }}</NButton>
      </footer>
    </div>
  </NModal>
</template>

<style>
.attachment-picker-modal { width: min(760px, calc(100vw - 28px)); }
.attachment-picker { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.attachment-picker-filters { display: grid; grid-template-columns: minmax(150px, 1fr) minmax(130px, .65fr) minmax(110px, .55fr); gap: 8px; }
.attachment-picker-body { min-height: 280px; display: grid; grid-template-columns: minmax(0, 1fr) minmax(180px, .75fr); gap: 12px; }
.attachment-picker-list { min-width: 0; min-height: 0; max-height: 48vh; overflow: auto; border: 1px solid var(--settings-border); border-radius: 8px; }
.attachment-picker-item { width: 100%; display: flex; flex-direction: column; align-items: flex-start; gap: 3px; box-sizing: border-box; padding: 10px 12px; border: 0; border-bottom: 1px solid var(--settings-border); background: transparent; color: var(--settings-text); text-align: left; cursor: pointer; }
.attachment-picker-item:hover, .attachment-picker-item[aria-selected='true'] { background: color-mix(in srgb, var(--settings-accent) 10%, transparent); }
.attachment-picker-item strong { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .84rem; }
.attachment-picker-item small { max-width: 100%; overflow: hidden; color: var(--settings-muted); text-overflow: ellipsis; white-space: nowrap; font-size: .72rem; }
.attachment-picker-item .n-tag { margin-top: 3px; }
.attachment-picker-pagination, .attachment-picker-actions { display: flex; align-items: center; gap: 8px; }
.attachment-picker-pagination { justify-content: space-between; padding: 7px; color: var(--settings-muted); font-size: .73rem; }
.attachment-picker-state, .attachment-picker-empty { min-height: 180px; display: grid; place-items: center; color: var(--settings-muted); }
.attachment-picker-state.is-error { color: var(--settings-danger); }
.attachment-picker-preview { min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.attachment-picker-operation { margin: 0; color: var(--settings-muted); font-size: .76rem; }
.attachment-picker-spacer { flex: 1; }
@media (max-width: 640px) {
  .attachment-picker-filters { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .attachment-picker-filters > :first-child { grid-column: 1 / -1; }
  .attachment-picker-body { grid-template-columns: minmax(0, 1fr); }
  .attachment-picker-list { max-height: 28vh; }
  .attachment-picker-preview .attachment-image-preview { min-height: 100px; }
}
</style>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NButton, NEmpty, NInput, NSpin } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { useToast } from '../../composables/useToast'
import { listAttachmentTrash, restoreAttachment } from '../../lib/attachments-api'
import type { AttachmentTrashItem, AttachmentTrashPage, ManagedAttachment } from '../../../shared/attachmentProtocol'
import AttachmentImagePreview from './AttachmentImagePreview.vue'

const emit = defineEmits<{ changed: []; storage: [bytes: number] }>()
const { t } = useI18n()
const toast = useToast()
const search = ref('')
const offset = ref(0)
const page = ref<AttachmentTrashPage | null>(null)
const selectedId = ref('')
const loading = ref(false)
const failed = ref(false)
const busy = ref(false)
let sequence = 0
let controller: AbortController | null = null
let searchTimer: ReturnType<typeof setTimeout> | undefined
const selected = computed(() => page.value?.items.find((item) => item.id === selectedId.value))

function previewItem(item: AttachmentTrashItem): ManagedAttachment {
  return { key: { kind: 'vault-file', path: item.path }, source: 'vault-file', type: 'image',
    displayName: item.path.split('/').at(-1) ?? item.path, mimeType: item.mimeType, byteSize: item.byteSize,
    createdAt: null, modifiedAt: item.recycledAt, referenceStatus: 'unknown' }
}
function size(bytes: number): string { return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB` }
function date(time: number): string { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(time) }
async function load(nextOffset = offset.value): Promise<void> {
  controller?.abort()
  const current = ++sequence
  controller = new AbortController()
  loading.value = true
  failed.value = false
  try {
    const result = await listAttachmentTrash(search.value.trim(), nextOffset, controller.signal)
    if (current !== sequence) return
    page.value = result
    offset.value = nextOffset
    if (!result.items.some((item) => item.id === selectedId.value)) selectedId.value = ''
    emit('storage', result.knownBytes)
  } catch { if (current === sequence) failed.value = true }
  finally { if (current === sequence) loading.value = false }
}
async function restore(): Promise<void> {
  const item = selected.value
  if (!item || busy.value) return
  busy.value = true
  try {
    await restoreAttachment(item.id)
    toast.success(t('attachments.trash.restored'))
    await load(0)
    emit('changed')
  } catch { toast.error(t('attachments.trash.failed')); await load() }
  finally { busy.value = false }
}
watch(search, () => {
  sequence += 1
  controller?.abort()
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => { void load(0) }, 180)
})
onMounted(() => { void load() })
onBeforeUnmount(() => { sequence += 1; controller?.abort(); if (searchTimer) clearTimeout(searchTimer) })
</script>

<template>
  <section class="attachment-trash" :aria-label="t('attachments.trash.title')">
    <NInput v-model:value="search" clearable :placeholder="t('attachments.search_placeholder')" :aria-label="t('attachments.search')" />
    <p>{{ t('attachments.trash.storage') }}: {{ size(page?.knownBytes ?? 0) }}</p>
    <div v-if="loading" role="status"><NSpin size="small" /></div>
    <div v-if="failed" role="alert">{{ t('attachments.trash.failed') }} <NButton size="small" @click="load()">{{ t('attachments.retry') }}</NButton></div>
    <NEmpty v-else-if="page?.total === 0" :description="t('attachments.trash.empty')" />
    <div v-if="page && !failed" class="trash-content">
      <div class="trash-list" role="list">
        <button v-for="item in page.items" :key="item.id" type="button" role="listitem" :aria-pressed="selectedId === item.id" :disabled="loading || busy" @click="selectedId = item.id">
          <strong>{{ item.path }}</strong><small>{{ date(item.recycledAt) }} · {{ size(item.byteSize) }}</small>
        </button>
      </div>
      <aside v-if="selected" class="trash-detail">
        <AttachmentImagePreview :item="previewItem(selected)" />
        <p class="trash-path">{{ selected.path }}</p>
        <p>{{ t('attachments.trash.date') }}: {{ date(selected.recycledAt) }}</p>
        <p>{{ size(selected.byteSize) }}</p>
        <p v-if="selected.state !== 'trashed'">{{ t('attachments.trash.pending') }}</p>
        <NButton size="small" :loading="busy" :disabled="loading || busy" @click="restore">{{ t('attachments.trash.restore') }}</NButton>
      </aside>
    </div>
    <footer v-if="page && page.total > 0">
      <span>{{ t('attachments.range', { start: page.offset + 1, end: Math.min(page.total, page.offset + page.limit), total: page.total }) }}</span>
      <NButton size="tiny" :disabled="offset === 0 || loading || busy" @click="load(Math.max(0, offset - 30))">{{ t('attachments.previous') }}</NButton>
      <NButton size="tiny" :disabled="offset + 30 >= page.total || loading || busy" @click="load(offset + 30)">{{ t('attachments.next') }}</NButton>
    </footer>
  </section>
</template>

<style scoped>
.attachment-trash { min-width: 0; }
.trash-content { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; }
.trash-list, .trash-detail { min-width: 0; }
.trash-list button { display: flex; flex-direction: column; gap: 6px; width: 100%; padding: 12px; text-align: start; background: transparent; color: var(--settings-text); border: 0; border-bottom: 1px solid var(--settings-border); cursor: pointer; }
.trash-list button[aria-pressed="true"] { background: var(--settings-card); }
.trash-list strong, .trash-path { overflow-wrap: anywhere; }
.trash-list small { color: var(--settings-muted); }
footer { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding-block: 12px; }
@media (max-width: 600px) { .trash-content { grid-template-columns: minmax(0, 1fr); } }
</style>

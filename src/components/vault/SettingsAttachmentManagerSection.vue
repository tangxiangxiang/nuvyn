<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NButton, NEmpty, NIcon, NInput, NSelect, NSpin, NTag } from 'naive-ui'
import { ArrowLeft, File, Photo, Refresh, Shape, Copy, Upload } from '@vicons/tabler'
import { useI18n } from '../../composables/useI18n'
import { useToast } from '../../composables/useToast'
import { useConfirm } from '../../composables/useConfirm'
import AttachmentTrashView from './AttachmentTrashView.vue'
import { copyTextToClipboard } from './workspaceTabActions'
import {
  listAttachmentAudit,
  listAttachmentTrash,
  quarantineAttachment,
  listAttachments,
  previewAttachmentCleanup,
  queryAttachmentReferences,
  refreshAttachmentIndex,
  refreshAttachmentReferences,
} from '../../lib/attachments-api'
import { uploadNoteImage } from '../../lib/noteImages'
import AttachmentImagePreview from './AttachmentImagePreview.vue'
import type {
  AttachmentAuditEntry,
  AttachmentCleanupPreview,
  AttachmentIndexStatus,
  AttachmentListQuery,
  AttachmentPage,
  AttachmentReferenceStatus,
  AttachmentReferencePage,
  AttachmentReference,
  AttachmentResourceType,
  AttachmentSource,
  ManagedAttachment,
} from '../../../shared/attachmentProtocol'

const emit = defineEmits<{
  back: []
  navigateReference: [reference: AttachmentReference, destination: 'owner' | 'source']
}>()
const { t } = useI18n()
const toast = useToast()
const { confirmCancellable } = useConfirm()
const trashVisible = ref(false)
const trashBytes = ref<number | null>(null)
const quarantineBusy = ref(false)
let cancelConfirm: (() => void) | undefined
let disposed = false
const page = ref<AttachmentPage | null>(null)
const loading = ref(false)
const refreshing = ref(false)
const loadError = ref<'query' | 'after-refresh' | null>(null)
const refreshError = ref(false)
const referenceRefreshError = ref(false)
const references = ref<AttachmentReferencePage | null>(null)
const referencesLoading = ref(false)
const referencesError = ref(false)
const riskPreview = ref<AttachmentCleanupPreview | null>(null)
const previewLoading = ref(false)
const previewError = ref(false)
const pageQueryKey = ref<string | null>(null)
const search = ref('')
const typeFilter = ref<AttachmentResourceType | 'all'>('all')
const sourceFilter = ref<AttachmentSource | 'all'>('all')
const referenceFilter = ref<AttachmentReferenceStatus | 'all'>('all')
const offset = ref(0)
const selectedKey = ref('')
const pageSize = 30
let loadSequence = 0
let referenceSequence = 0
let previewSequence = 0
let referenceController: AbortController | null = null
let previewController: AbortController | null = null
let searchTimer: ReturnType<typeof setTimeout> | undefined
const uploadInput = ref<HTMLInputElement | null>(null)
const uploadBusy = ref(false)
const auditEntries = ref<AttachmentAuditEntry[]>([])
const auditLoading = ref(false)
const auditFailed = ref(false)

async function loadTrashStorage(): Promise<void> {
  try {
    const result = await listAttachmentTrash()
    if (!disposed) trashBytes.value = result.knownBytes
  } catch { if (!disposed) trashBytes.value = null }
}

async function quarantine(): Promise<void> {
  const preview = riskPreview.value
  if (!preview?.quarantineAllowed || !preview.quarantineToken || quarantineBusy.value) return
  const confirmation = confirmCancellable(t('attachments.trash.confirm'), t('attachments.trash.warning'), { confirmLabel: t('attachments.trash.quarantine') })
  cancelConfirm = confirmation.cancel
  const approved = await confirmation.promise
  cancelConfirm = undefined
  if (!approved || disposed) return
  quarantineBusy.value = true
  try {
    await quarantineAttachment(preview.quarantineToken)
    if (disposed) return
    toast.success(t('attachments.trash.success'))
    selectedKey.value = ''
    riskPreview.value = null
    await refresh()
    await Promise.all([loadAudit(), loadTrashStorage()])
  } catch {
    if (!disposed) { riskPreview.value = null; toast.error(t('attachments.trash.failed')); await refresh() }
  } finally { quarantineBusy.value = false }
}

function onTrashChanged(): void { void refresh(); void loadAudit(); void loadTrashStorage() }

const currentQueryKey = computed(() => JSON.stringify(query()))
const isPageQueryStale = computed(() => Boolean(page.value && pageQueryKey.value !== currentQueryKey.value))
const selected = computed(() => page.value?.items.find((item) => resourceKey(item) === selectedKey.value) ?? null)
const hasSourceFailure = computed(() => Object.values(page.value?.indexStatus.sources ?? {}).some((source) => source.state === 'failed'))
const allSourcesFailed = computed(() => Object.values(page.value?.indexStatus.sources ?? {}).every((source) => source.state === 'failed'))
const isInitialFailure = computed(() => loadError.value !== null && !page.value)
const hasNextPage = computed(() => Boolean(page.value && page.value.offset + page.value.limit < page.value.total))
const rangeStart = computed(() => page.value?.total ? page.value.offset + 1 : 0)
const rangeEnd = computed(() => Math.min((page.value?.offset ?? 0) + (page.value?.limit ?? pageSize), page.value?.total ?? 0))

function markReferencesStale(): void {
  if (!references.value) return
  references.value = {
    ...references.value,
    currentFinding: 'unknown',
    stale: true,
    coverage: {
      ...references.value.coverage,
      currentNotes: 'unknown',
      boardReferences: 'unknown',
    },
  }
}

function resourceKey(item: ManagedAttachment): string {
  switch (item.key.kind) {
    case 'asset': return `asset:${item.key.id}`
    case 'vault-file': return `vault-file:${item.key.path}`
    case 'board-material': return `board-material:${item.key.id}`
  }
}

function resourceIdentity(item: ManagedAttachment): string {
  return item.key.kind === 'vault-file' ? item.key.path : item.key.id
}

function displayName(item: ManagedAttachment): string {
  if (item.displayName) return item.displayName
  const shortId = item.key.kind === 'asset' ? item.key.id.slice(0, 8) : resourceIdentity(item).slice(0, 8)
  return t('attachments.unnamed_asset', { id: shortId })
}

function resourceIcon(item: ManagedAttachment) {
  if (item.type === 'image') return Photo
  if (item.type === 'material') return Shape
  return File
}

function formatBytes(value: number | null): string {
  if (value === null) return t('attachments.size_unknown')
  if (value < 1024) return `${value} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = value / 1024
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: size >= 10 ? 1 : 2 }).format(size)} ${units[index]}`
}

function formatDate(value: number | null): string {
  if (value === null) return t('attachments.not_available')
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(value)
}

function selectedSourceLabel(item: ManagedAttachment): string {
  return t(`attachments.source.${item.source}`)
}

function sourceLabel(item: ManagedAttachment): string {
  return selectedSourceLabel(item)
}

function typeLabel(item: ManagedAttachment): string {
  return t(`attachments.type.${item.type}`)
}

function referenceLabel(status: AttachmentReferenceStatus): string {
  return t(`attachments.reference.${status}`)
}

function indexStatusLabel(status: AttachmentIndexStatus | undefined): string {
  if (!status?.ready) return t('attachments.index_not_ready')
  if (status.refreshing) return t('attachments.refreshing')
  return status.complete ? t('attachments.index_complete') : t('attachments.index_partial')
}

function query(): AttachmentListQuery {
  return {
    search: search.value.trim() || undefined,
    type: typeFilter.value === 'all' ? undefined : typeFilter.value,
    source: sourceFilter.value === 'all' ? undefined : sourceFilter.value,
    referenceStatus: referenceFilter.value === 'all' ? undefined : referenceFilter.value,
    offset: offset.value,
    limit: pageSize,
  }
}

async function loadPage(failureContext: 'query' | 'after-refresh' = 'query'): Promise<boolean> {
  const current = ++loadSequence
  const requestedQuery = query()
  loading.value = true
  loadError.value = null
  try {
    const next = await listAttachments(requestedQuery)
    if (current !== loadSequence) return false
    page.value = next
    pageQueryKey.value = JSON.stringify(requestedQuery)
    if (selectedKey.value && !next.items.some((item) => resourceKey(item) === selectedKey.value)) {
      selectedKey.value = ''
    }
    return true
  } catch {
    if (current === loadSequence) loadError.value = failureContext
    return false
  } finally {
    if (current === loadSequence) loading.value = false
  }
}

async function loadAudit(): Promise<void> {
  auditLoading.value = true
  auditFailed.value = false
  try {
    auditEntries.value = await listAttachmentAudit(20)
  } catch {
    auditFailed.value = true
  } finally {
    auditLoading.value = false
  }
}

async function refresh(): Promise<void> {
  if (refreshing.value) return
  refreshing.value = true
  refreshError.value = false
  referenceRefreshError.value = false
  markReferencesStale()
  const [catalogResult, referenceResult] = await Promise.allSettled([
    refreshAttachmentIndex(),
    refreshAttachmentReferences(),
  ])
  if (catalogResult.status === 'rejected') refreshError.value = true
  if (referenceResult.status === 'rejected') {
    referenceRefreshError.value = true
    markReferencesStale()
  }
  if (catalogResult.status === 'fulfilled') await loadPage('after-refresh')
  if (referenceResult.status === 'fulfilled') {
    references.value = null
    if (selected.value) void loadReferences(selected.value)
  }
  refreshing.value = false
}

function loadReferences(item: ManagedAttachment, offset = 0): void {
  referenceController?.abort()
  const controller = new AbortController()
  referenceController = controller
  const sequence = ++referenceSequence
  referencesLoading.value = true
  referencesError.value = false
  riskPreview.value = null
  previewError.value = false
  void queryAttachmentReferences(item.key, { offset, limit: 30, signal: controller.signal }).then((result) => {
    if (sequence !== referenceSequence || controller.signal.aborted) return
    references.value = offset === 0 || !references.value
      ? result
      : { ...result, references: [...references.value.references, ...result.references] }
    if (offset === 0) void loadPage()
  }).catch(() => {
    if (sequence === referenceSequence && !controller.signal.aborted) {
      referencesError.value = true
      markReferencesStale()
    }
  }).finally(() => {
    if (sequence === referenceSequence) referencesLoading.value = false
  })
}

function loadMoreReferences(): void {
  if (!selected.value || !references.value?.nextOffset || referencesLoading.value) return
  loadReferences(selected.value, references.value.nextOffset)
}

function retryReferences(): void {
  if (selected.value) loadReferences(selected.value)
}

function runRiskPreview(): void {
  if (!selected.value) return
  previewController?.abort()
  const controller = new AbortController()
  previewController = controller
  const sequence = ++previewSequence
  previewLoading.value = true
  previewError.value = false
  riskPreview.value = null
  void previewAttachmentCleanup(selected.value.key, controller.signal).then((result) => {
    if (sequence === previewSequence && !controller.signal.aborted) riskPreview.value = result
  }).catch(() => {
    if (sequence === previewSequence && !controller.signal.aborted) previewError.value = true
  }).finally(() => {
    if (sequence === previewSequence) previewLoading.value = false
  })
}

function referenceKindLabel(reference: AttachmentReference): string {
  return t(`attachments.reference_kind.${reference.kind}`)
}

function referenceOwnerLabel(reference: AttachmentReference): string {
  return t(reference.owner.kind === 'note' ? 'attachments.owner.note' : 'attachments.owner.board')
}

function referenceViaLabel(reference: AttachmentReference): string {
  const via = reference.via?.map((item) => item.title || item.id).filter(Boolean) ?? []
  return via.length ? t('attachments.reference_via', { path: via.join(' → ') }) : ''
}

function referenceSourceLabel(reference: AttachmentReference): string {
  if (reference.owner.kind !== 'note' || !reference.navigable || !reference.sourcePath) return ''
  const sourcePath = reference.sourcePath.replace(/\.md$/iu, '')
  if (sourcePath === reference.owner.id.replace(/\.md$/iu, '')) return ''
  const source = reference.via?.find((item) => item.kind === 'include'
    && item.id.replace(/\.md$/iu, '') === sourcePath)
  if (!source) return ''
  const sourceTitle = source.title
  return sourceTitle || sourcePath.split('/').at(-1) || sourcePath
}

function riskLevelLabel(preview: AttachmentCleanupPreview): string {
  return t(`attachments.risk.${preview.riskLevel}`)
}

function riskReasonLabel(reason: AttachmentCleanupPreview['riskReasons'][number]): string {
  return t(`attachments.risk_reason.${reason}`)
}

function scheduleFilterLoad(): void {
  offset.value = 0
  // Invalidate an in-flight response as soon as the controls change, rather
  // than letting it briefly masquerade as the result for the new filters.
  loadSequence += 1
  loading.value = false
  loadError.value = null
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => { void loadPage() }, 180)
}

function selectPage(nextOffset: number): void {
  offset.value = Math.max(0, nextOffset)
  void loadPage()
}

async function copyIdentity(): Promise<void> {
  if (!selected.value) return
  const copied = await copyTextToClipboard(selected.value.key.kind === 'vault-file'
    ? selected.value.key.path
    : selected.value.key.id)
  toast[copied ? 'success' : 'error'](t(copied ? 'attachments.copied' : 'attachments.copy_failed'))
}

async function uploadToNoteLibrary(event: Event): Promise<void> {
  const input = event.currentTarget as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || uploadBusy.value) return
  uploadBusy.value = true
  try {
    await uploadNoteImage(file, undefined, { operation: 'attachment-manager-upload' })
    toast.success(t('attachments.upload_success'))
    await refresh()
    if (selected.value) loadReferences(selected.value)
    await loadAudit()
  } catch {
    toast.error(t('attachments.upload_failed'))
  } finally {
    uploadBusy.value = false
  }
}

const typeOptions = computed(() => [
  { label: t('attachments.filter.all_types'), value: 'all' },
  { label: t('attachments.type.image'), value: 'image' },
  { label: t('attachments.type.file'), value: 'file' },
  { label: t('attachments.type.material'), value: 'material' },
])
const sourceOptions = computed(() => [
  { label: t('attachments.filter.all_sources'), value: 'all' },
  { label: t('attachments.source.board-asset'), value: 'board-asset' },
  { label: t('attachments.source.vault-file'), value: 'vault-file' },
  { label: t('attachments.source.board-material'), value: 'board-material' },
])
const referenceOptions = computed(() => [
  { label: t('attachments.filter.all_reference_states'), value: 'all' },
  { label: t('attachments.reference.referenced'), value: 'referenced' },
  { label: t('attachments.reference.unreferenced'), value: 'unreferenced' },
  { label: t('attachments.reference.unknown'), value: 'unknown' },
])

watch([search, typeFilter, sourceFilter, referenceFilter], scheduleFilterLoad)
watch(selectedKey, (key) => {
  referenceController?.abort()
  previewController?.abort()
  references.value = null
  riskPreview.value = null
  referencesError.value = false
  previewError.value = false
  if (key && selected.value) loadReferences(selected.value)
})
onMounted(() => { void loadPage(); void loadAudit(); void loadTrashStorage() })
onBeforeUnmount(() => {
  disposed = true
  cancelConfirm?.()
  loadSequence += 1
  referenceSequence += 1
  previewSequence += 1
  referenceController?.abort()
  previewController?.abort()
  if (searchTimer) clearTimeout(searchTimer)
})
</script>

<template>
  <section class="settings-section attachment-manager" aria-labelledby="attachment-manager-title" :aria-busy="loading || refreshing || isPageQueryStale">
    <header class="settings-section-header attachment-manager-header">
      <div class="attachment-manager-heading">
        <NButton attr-type="button" size="small" quaternary class="attachment-back" @click="emit('back')">
          <template #icon><NIcon aria-hidden="true"><ArrowLeft /></NIcon></template>
          {{ t('attachments.back_to_settings') }}
        </NButton>
        <div class="attachment-title-row">
          <h3 id="attachment-manager-title">{{ t('attachments.title') }}</h3>
          <NButton size="tiny" quaternary :disabled="quarantineBusy" @click="trashVisible = !trashVisible">{{ t(trashVisible ? 'attachments.trash.active' : 'attachments.trash.title') }}</NButton>
        </div>
        <p>{{ t('attachments.subtitle') }}</p>
      </div>
      <NButton attr-type="button" size="medium" class="btn attachment-refresh" :loading="refreshing" :disabled="refreshing" @click="refresh">
        <template #icon><NIcon aria-hidden="true"><Refresh /></NIcon></template>
        {{ t(refreshing ? 'attachments.refreshing' : 'attachments.refresh') }}
      </NButton>
      <NButton attr-type="button" size="medium" class="btn attachment-upload" :loading="uploadBusy" :disabled="uploadBusy" @click="uploadInput?.click()">
        <template #icon><NIcon aria-hidden="true"><Upload /></NIcon></template>
        {{ t('attachments.upload') }}
      </NButton>
      <input ref="uploadInput" class="attachment-upload-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/svg+xml,.svg" @change="uploadToNoteLibrary">
    </header>

    <AttachmentTrashView v-if="trashVisible" @changed="onTrashChanged" @storage="trashBytes = $event" />

    <template v-else>

    <div v-if="page" class="attachment-summary" :aria-label="t('attachments.summary.label')">
      <div><span>{{ t('attachments.summary.total') }}</span><strong>{{ page.summary.total }}</strong></div>
      <div><span>{{ t('attachments.summary.storage') }}</span><strong>{{ formatBytes(page.summary.knownBytes) }}<small v-if="page.summary.unknownByteSizeCount"> + {{ t('attachments.summary.unknown_sizes', { count: page.summary.unknownByteSizeCount }) }}</small><small> · {{ t('attachments.trash.storage') }} {{ formatBytes(trashBytes) }}</small></strong></div>
      <div><span>{{ t('attachments.summary.review') }}</span><strong>{{ page.summary.unknownReferenceCount }}</strong></div>
      <div class="attachment-index-status" role="status">
        <span>{{ t('attachments.index_status') }}</span>
        <strong :class="{ 'is-incomplete': !page.summary.complete }">{{ indexStatusLabel(page.indexStatus) }}</strong>
      </div>
    </div>

    <div class="attachment-toolbar" role="search">
      <NInput v-model:value="search" clearable :placeholder="t('attachments.search_placeholder')" :aria-label="t('attachments.search')" />
      <NSelect v-model:value="typeFilter" :options="typeOptions" :to="false" :aria-label="t('attachments.filter.type')" />
      <NSelect v-model:value="sourceFilter" :options="sourceOptions" :to="false" :aria-label="t('attachments.filter.source')" />
      <NSelect v-model:value="referenceFilter" :options="referenceOptions" :to="false" :aria-label="t('attachments.filter.reference')" />
    </div>

    <div v-if="hasSourceFailure" class="attachment-warning" role="status">
      {{ t('attachments.partial_warning') }}
      <span v-for="source in ['board-asset', 'vault-file', 'board-material'] as const" :key="source">
        <template v-if="page?.indexStatus.sources[source].state === 'failed'">{{ t(`attachments.source.${source}`) }}</template>
      </span>
    </div>

    <div v-if="refreshError" class="attachment-request-message is-error" role="alert">
      <span>{{ t('attachments.refresh_failed') }}</span>
      <NButton attr-type="button" size="small" class="btn" :loading="refreshing" @click="refresh">{{ t('attachments.retry') }}</NButton>
    </div>
    <div v-if="referenceRefreshError" class="attachment-request-message is-error" role="alert">
      <span>{{ t('attachments.reference_refresh_failed') }}</span>
      <NButton attr-type="button" size="small" class="btn" :loading="refreshing" @click="refresh">{{ t('attachments.retry') }}</NButton>
    </div>
    <div v-if="loadError && page" class="attachment-request-message is-error" role="alert">
      <span>{{ t(loadError === 'after-refresh' ? 'attachments.refresh_list_failed' : 'attachments.previous_results_error') }}</span>
      <NButton attr-type="button" size="small" class="btn" :loading="loading" @click="loadPage()">{{ t('attachments.retry') }}</NButton>
    </div>
    <div v-else-if="(loading || isPageQueryStale) && page" class="attachment-request-message" role="status">
      <span>{{ t(isPageQueryStale ? 'attachments.filters_loading_previous' : 'attachments.updating_previous') }}</span>
    </div>

    <div class="attachment-manager-content">
      <div class="attachment-list-panel" :aria-busy="loading">
        <div v-if="loading && !page" class="attachment-state"><NSpin size="small" /><span>{{ t('attachments.loading') }}</span></div>
        <div v-else-if="isInitialFailure" class="attachment-state attachment-error" role="alert">
          <p>{{ t(loadError === 'after-refresh' ? 'attachments.refresh_list_failed' : 'attachments.load_failed') }}</p>
          <NButton attr-type="button" size="small" class="btn" @click="loadPage()">{{ t('attachments.retry') }}</NButton>
        </div>
        <div v-else-if="page && page.total === 0 && isPageQueryStale" class="attachment-empty" aria-hidden="true"></div>
        <div v-else-if="page && page.total === 0 && !hasSourceFailure" class="attachment-empty">
          <NEmpty :description="search || typeFilter !== 'all' || sourceFilter !== 'all' || referenceFilter !== 'all' ? t('attachments.no_matches') : t('attachments.empty')" />
        </div>
        <div v-else-if="page && page.total === 0 && !isPageQueryStale && allSourcesFailed" class="attachment-state attachment-error" role="alert">
          <p>{{ t('attachments.no_sources_available') }}</p>
          <NButton attr-type="button" size="small" class="btn" :loading="refreshing" @click="refresh">{{ t('attachments.retry') }}</NButton>
        </div>
        <div v-else-if="page && page.total === 0 && !isPageQueryStale && hasSourceFailure" class="attachment-state" role="status">
          <p>{{ t('attachments.no_items_partial') }}</p>
          <NButton attr-type="button" size="small" class="btn" :loading="refreshing" @click="refresh">{{ t('attachments.retry') }}</NButton>
        </div>
        <div v-else class="attachment-resource-list" role="list" :aria-label="t('attachments.list_label')">
          <div v-for="item in page?.items ?? []" :key="resourceKey(item)" role="listitem">
            <button
              type="button"
              class="attachment-resource-row"
              :class="{ 'is-selected': selectedKey === resourceKey(item) }"
              :aria-pressed="selectedKey === resourceKey(item)"
              @click="selectedKey = resourceKey(item)"
            >
              <NIcon class="attachment-resource-icon" aria-hidden="true"><component :is="resourceIcon(item)" /></NIcon>
              <span class="attachment-resource-main">
                <strong :title="displayName(item)">{{ displayName(item) }}</strong>
                <small :title="resourceIdentity(item)">{{ sourceLabel(item) }}<template v-if="item.key.kind === 'vault-file'"> · {{ item.key.path }}</template></small>
              </span>
              <span class="attachment-resource-meta">
                <small>{{ formatBytes(item.byteSize) }}</small>
                <NTag size="small" :bordered="false" :type="item.referenceStatus === 'referenced' ? 'success' : 'default'">
                  {{ referenceLabel(item.referenceStatus) }}
                </NTag>
              </span>
            </button>
          </div>
        </div>
        <footer v-if="page && page.total > 0" class="attachment-pagination">
          <span>{{ t('attachments.range', { start: rangeStart, end: rangeEnd, total: page.total }) }}</span>
          <div>
            <NButton attr-type="button" size="tiny" quaternary :disabled="page.offset === 0 || loading || isPageQueryStale || Boolean(loadError)" :aria-label="t('attachments.previous_page')" @click="selectPage(page.offset - pageSize)">{{ t('attachments.previous') }}</NButton>
            <NButton attr-type="button" size="tiny" quaternary :disabled="!hasNextPage || loading || isPageQueryStale || Boolean(loadError)" :aria-label="t('attachments.next_page')" @click="selectPage(page.offset + pageSize)">{{ t('attachments.next') }}</NButton>
          </div>
        </footer>
      </div>

      <aside class="attachment-detail-panel" :aria-label="t('attachments.details')">
        <template v-if="selected">
          <div class="attachment-detail-heading">
            <NIcon aria-hidden="true"><component :is="resourceIcon(selected)" /></NIcon>
            <div><h4>{{ displayName(selected) }}</h4><p>{{ typeLabel(selected) }} · {{ sourceLabel(selected) }}</p></div>
          </div>
          <AttachmentImagePreview v-if="selected.type === 'image' || selected.type === 'material'" :item="selected" />
          <dl class="attachment-detail-list">
            <div><dt>{{ t('attachments.detail.size') }}</dt><dd>{{ formatBytes(selected.byteSize) }}</dd></div>
            <div><dt>{{ t('attachments.detail.mime') }}</dt><dd>{{ selected.mimeType ?? t('attachments.not_available') }}</dd></div>
            <div><dt>{{ t('attachments.detail.created') }}</dt><dd>{{ formatDate(selected.createdAt) }}</dd></div>
            <div><dt>{{ t('attachments.detail.modified') }}</dt><dd>{{ formatDate(selected.modifiedAt) }}</dd></div>
            <div><dt>{{ t('attachments.detail.reference') }}</dt><dd>{{ referenceLabel(selected.referenceStatus) }}</dd></div>
            <div v-if="selected.knownReferenceCount !== undefined"><dt>{{ t('attachments.detail.known_references') }}</dt><dd>{{ selected.knownReferenceCount }}</dd></div>
            <div v-if="selected.archived"><dt>{{ t('attachments.detail.archive_state') }}</dt><dd>{{ t('attachments.archived') }}</dd></div>
            <div class="attachment-identity-row"><dt>{{ selected.key.kind === 'vault-file' ? t('attachments.detail.path') : t('attachments.detail.id') }}</dt><dd>{{ resourceIdentity(selected) }}</dd></div>
          </dl>
          <NButton attr-type="button" size="small" class="btn attachment-copy" @click="copyIdentity">
            <template #icon><NIcon aria-hidden="true"><Copy /></NIcon></template>
            {{ t('attachments.copy_identity') }}
          </NButton>
          <section class="attachment-reference-section" :aria-label="t('attachments.references.title')">
            <header class="attachment-reference-heading">
              <h5>{{ t('attachments.references.title') }}</h5>
              <span v-if="references">{{ t('attachments.references.count', { count: references.referenceCount, owners: references.ownerCount }) }}</span>
            </header>
            <div v-if="referencesLoading && !references" class="attachment-reference-state" role="status">
              <NSpin size="small" /><span>{{ t('attachments.references.loading') }}</span>
            </div>
            <div v-else-if="referencesError && !references" class="attachment-reference-state is-error" role="alert">
              <span>{{ t('attachments.references.failed') }}</span>
              <NButton attr-type="button" size="tiny" quaternary @click="retryReferences">{{ t('attachments.retry') }}</NButton>
            </div>
            <div v-if="referencesError && references" class="attachment-reference-state is-error" role="status">
              <span>{{ t('attachments.references.failed') }}</span>
              <NButton attr-type="button" size="tiny" quaternary @click="retryReferences">{{ t('attachments.retry') }}</NButton>
            </div>
            <div v-if="references?.stale" class="attachment-reference-stale" role="status">
              {{ t('attachments.references.stale') }}
            </div>
            <div v-if="references && references.referenceCount === 0" class="attachment-reference-state">
              {{ t(references.currentFinding === 'unknown' ? 'attachments.references.unknown' : 'attachments.references.empty') }}
            </div>
            <div v-if="references && references.referenceCount > 0" class="attachment-reference-list">
              <div
                v-for="(reference, index) in references.references"
                :key="`${reference.owner.kind}:${reference.owner.id}:${reference.kind}:${reference.sourcePath ?? ''}:${reference.line ?? index}`"
                class="attachment-reference-item"
              >
                <button
                  type="button"
                  class="attachment-reference-row"
                  :disabled="!reference.navigable"
                  :title="reference.owner.title ?? reference.owner.id"
                  @click="emit('navigateReference', reference, 'owner')"
                >
                  <NIcon class="attachment-reference-icon" aria-hidden="true"><component :is="reference.owner.kind === 'note' ? File : Shape" /></NIcon>
                  <span class="attachment-reference-main">
                    <strong>{{ reference.owner.title || reference.owner.id }}</strong>
                    <small>{{ referenceOwnerLabel(reference) }} · {{ referenceKindLabel(reference) }} · {{ t(`attachments.relation.${reference.relation}`) }}</small>
                    <small v-if="referenceViaLabel(reference)" class="attachment-reference-via">{{ referenceViaLabel(reference) }}</small>
                  </span>
                  <span v-if="reference.navigable" class="attachment-reference-arrow" aria-hidden="true">→</span>
                </button>
                <button
                  v-if="referenceSourceLabel(reference)"
                  type="button"
                  class="attachment-reference-source"
                  @click="emit('navigateReference', reference, 'source')"
                >{{ t('attachments.references.view_source', { source: referenceSourceLabel(reference) }) }}</button>
              </div>
              <NButton
                v-if="references.nextOffset !== null"
                attr-type="button"
                size="small"
                quaternary
                class="attachment-reference-more"
                :loading="referencesLoading"
                @click="loadMoreReferences"
              >{{ t('attachments.references.more') }}</NButton>
            </div>
            <p v-if="references" class="attachment-reference-coverage">
              {{ t('attachments.references.coverage') }} ·
              {{ t(references.coverage.currentNotes === 'complete'
                ? 'attachments.coverage.complete'
                : references.coverage.currentNotes === 'partial'
                  ? 'attachments.coverage.partial'
                  : 'attachments.coverage.unknown') }}
              <span v-if="references.coverage.protectedDiary === 'restricted'"> · {{ t('attachments.coverage.diary_restricted') }}</span>
            </p>
            <NButton attr-type="button" size="small" class="btn attachment-risk-button" :loading="previewLoading" @click="runRiskPreview">
              {{ t('attachments.risk.check') }}
            </NButton>
            <div v-if="previewError" class="attachment-risk-result is-error" role="alert">{{ t('attachments.risk.failed') }}</div>
            <div v-else-if="riskPreview" class="attachment-risk-result" role="status">
              <strong>{{ riskLevelLabel(riskPreview) }}</strong>
              <p>{{ t(`attachments.finding.${riskPreview.currentFinding}`) }}</p>
              <ul>
                <li v-for="reason in riskPreview.riskReasons" :key="reason">{{ riskReasonLabel(reason) }}</li>
              </ul>
              <small>{{ t('attachments.risk.no_delete') }}</small>
              <p v-if="riskPreview.quarantineReason">{{ t(`attachments.trash.reason.${riskPreview.quarantineReason}`) }}</p>
              <NButton v-if="riskPreview.resource.kind === 'vault-file'" size="small" :disabled="!riskPreview.quarantineAllowed || quarantineBusy" :loading="quarantineBusy" @click="quarantine">{{ t('attachments.trash.quarantine') }}</NButton>
            </div>
          </section>
        </template>
        <NEmpty v-else :description="t('attachments.select_item')" />
      </aside>
    </div>

    </template>
    <details class="attachment-audit">
      <summary>{{ t('attachments.audit.title') }}</summary>
      <div v-if="auditLoading" class="attachment-audit-state" role="status"><NSpin size="small" />{{ t('attachments.audit.loading') }}</div>
      <div v-else-if="auditFailed" class="attachment-audit-state is-error" role="alert">{{ t('attachments.audit.failed') }}</div>
      <div v-else-if="auditEntries.length === 0" class="attachment-audit-state">{{ t('attachments.audit.empty') }}</div>
      <ol v-else class="attachment-audit-list">
        <li v-for="entry in auditEntries" :key="entry.id" class="attachment-audit-item">
          <div>
            <strong>{{ t(`attachments.audit.operation.${entry.operation}`) }}</strong>
            <small>{{ t(`attachments.audit.workspace.${entry.sourceWorkspace}`) }} → {{ t(`attachments.audit.workspace.${entry.targetWorkspace}`) }}</small>
          </div>
          <code :title="entry.resourceId">{{ entry.resourceId }}</code>
          <span :class="entry.result === 'success' ? 'is-success' : 'is-failure'">
            {{ t(`attachments.audit.${entry.result}`) }}<template v-if="entry.failureCategory"> · {{ t(`attachments.audit.failure.${entry.failureCategory}`) }}</template>
          </span>
          <time :datetime="new Date(entry.occurredAt).toISOString()">{{ formatDate(entry.occurredAt) }}</time>
        </li>
      </ol>
      <small class="attachment-audit-retention">{{ t('attachments.audit.retention') }}</small>
    </details>

    <p class="attachment-reference-note">{{ t('attachments.reference_note') }}</p>
  </section>
</template>

<style scoped>
.attachment-title-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.attachment-manager { gap: 16px; height: 100%; min-height: 0; }
.attachment-manager-header { flex: 0 0 auto; align-items: flex-end; }
.attachment-manager-heading { min-width: 0; }
.attachment-back { margin: -8px 0 8px -8px; color: var(--settings-muted); }
.attachment-refresh { flex: 0 0 auto; }
.attachment-upload { flex: 0 0 auto; }
.attachment-upload-input { position: fixed; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.attachment-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.attachment-summary > div { min-width: 0; display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; border: 1px solid var(--settings-border); border-radius: 9px; background: var(--settings-card); }
.attachment-summary span { color: var(--settings-muted); font-size: .78rem; }
.attachment-summary strong { overflow: hidden; color: var(--settings-text); font-size: 1.05rem; font-variant-numeric: tabular-nums; text-overflow: ellipsis; white-space: nowrap; }
.attachment-summary strong small { color: var(--settings-muted); font-size: .72rem; font-weight: 400; }
.attachment-summary .attachment-index-status strong { font-size: .9rem; }
.attachment-index-status strong.is-incomplete { color: var(--settings-warning); }
.attachment-toolbar { display: grid; grid-template-columns: minmax(180px, 1.8fr) repeat(3, minmax(130px, 1fr)); gap: 10px; }
.attachment-warning { display: flex; flex-wrap: wrap; gap: 4px 10px; padding: 9px 12px; border: 1px solid color-mix(in srgb, var(--settings-warning) 36%, transparent); border-radius: 8px; color: var(--settings-warning); font-size: .82rem; }
.attachment-request-message { min-width: 0; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 12px; padding: 9px 12px; border: 1px solid var(--settings-border); border-radius: 8px; color: var(--settings-muted); font-size: .82rem; }
.attachment-request-message.is-error { border-color: color-mix(in srgb, var(--settings-danger) 36%, transparent); color: var(--settings-danger); }
.attachment-manager-content { flex: 1 1 auto; min-height: 220px; display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(270px, .8fr); gap: 14px; overflow: hidden; }
.attachment-list-panel, .attachment-detail-panel { min-width: 0; min-height: 0; display: flex; flex-direction: column; border: 1px solid var(--settings-border); border-radius: 9px; background: var(--settings-card); overflow: hidden; }
.attachment-resource-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.attachment-resource-list > [role="listitem"] { display: contents; }
.attachment-resource-row { width: 100%; min-height: 60px; display: flex; align-items: center; gap: 11px; box-sizing: border-box; padding: 9px 12px; border: 0; border-bottom: 1px solid var(--settings-border); background: transparent; color: var(--settings-text); text-align: left; cursor: pointer; }
.attachment-resource-row:hover, .attachment-resource-row.is-selected { background: color-mix(in srgb, var(--settings-accent) 10%, transparent); }
.attachment-resource-icon { flex: 0 0 20px; color: var(--settings-muted); font-size: 19px; }
.attachment-resource-main { min-width: 0; flex: 1 1 auto; display: flex; flex-direction: column; gap: 3px; }
.attachment-resource-main strong, .attachment-resource-main small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.attachment-resource-main strong { font-size: .88rem; font-weight: 550; }
.attachment-resource-main small, .attachment-resource-meta small { color: var(--settings-muted); font-size: .73rem; }
.attachment-resource-meta { flex: 0 0 auto; display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
.attachment-pagination { min-height: 42px; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 10px; border-top: 1px solid var(--settings-border); color: var(--settings-muted); font-size: .76rem; }
.attachment-pagination > div { display: flex; gap: 4px; }
.attachment-state, .attachment-empty { flex: 1 1 auto; min-height: 170px; display: flex; align-items: center; justify-content: center; gap: 10px; padding: 24px; color: var(--settings-muted); text-align: center; }
.attachment-state { flex-direction: column; }
.attachment-state p { margin: 0; }
.attachment-state.attachment-error { color: var(--settings-danger); }
.attachment-detail-panel { padding: 18px; gap: 16px; overflow-y: auto; overscroll-behavior: contain; }
.attachment-detail-heading { min-width: 0; display: flex; align-items: flex-start; gap: 12px; }
.attachment-detail-heading > .n-icon { flex: 0 0 auto; margin-top: 2px; color: var(--settings-accent); font-size: 22px; }
.attachment-detail-heading h4 { margin: 0; overflow-wrap: anywhere; font-size: 1rem; font-weight: 600; }
.attachment-detail-heading p { margin: 5px 0 0; color: var(--settings-muted); font-size: .8rem; }
.attachment-detail-list { display: flex; flex-direction: column; margin: 0; }
.attachment-detail-list > div { min-width: 0; display: grid; grid-template-columns: minmax(90px, .75fr) minmax(0, 1.25fr); gap: 12px; padding: 9px 0; border-top: 1px solid var(--settings-border); font-size: .8rem; }
.attachment-detail-list dt { color: var(--settings-muted); }
.attachment-detail-list dd { min-width: 0; margin: 0; overflow-wrap: anywhere; color: var(--settings-text); text-align: right; }
.attachment-identity-row dd { font-family: var(--font-mono, ui-monospace, monospace); font-size: .76rem; }
.attachment-copy { align-self: flex-start; }
.attachment-reference-section { display: flex; flex-direction: column; gap: 9px; min-height: 0; border-top: 1px solid var(--settings-border); padding-top: 12px; }
.attachment-reference-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.attachment-reference-heading h5 { margin: 0; color: var(--settings-text); font-size: .88rem; font-weight: 600; }
.attachment-reference-heading > span, .attachment-reference-coverage { color: var(--settings-muted); font-size: .72rem; }
.attachment-reference-state { min-height: 42px; display: flex; align-items: center; justify-content: center; gap: 8px; color: var(--settings-muted); font-size: .8rem; text-align: center; }
.attachment-reference-state.is-error, .attachment-risk-result.is-error { color: var(--settings-danger); }
.attachment-reference-list { display: flex; flex-direction: column; gap: 5px; }
.attachment-reference-item { display: flex; flex-direction: column; gap: 3px; }
.attachment-reference-row { width: 100%; min-width: 0; display: flex; align-items: center; gap: 8px; padding: 8px; border: 1px solid var(--settings-border); border-radius: 7px; background: transparent; color: var(--settings-text); text-align: left; cursor: pointer; }
.attachment-reference-row:hover:not(:disabled) { background: color-mix(in srgb, var(--settings-accent) 9%, transparent); }
.attachment-reference-row:disabled { cursor: default; }
.attachment-reference-icon { flex: 0 0 auto; color: var(--settings-muted); }
.attachment-reference-main { min-width: 0; flex: 1 1 auto; display: flex; flex-direction: column; gap: 3px; }
.attachment-reference-main strong, .attachment-reference-main small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.attachment-reference-main strong { font-size: .8rem; font-weight: 550; }
.attachment-reference-main small { color: var(--settings-muted); font-size: .7rem; }
.attachment-reference-main .attachment-reference-via { color: var(--settings-accent); }
.attachment-reference-source { align-self: flex-start; padding: 1px 6px; border: 0; background: transparent; color: var(--settings-accent); font-size: .7rem; cursor: pointer; }
.attachment-reference-source:hover { text-decoration: underline; }
.attachment-reference-stale { padding: 7px 9px; border-radius: 6px; background: color-mix(in srgb, var(--settings-warning) 9%, transparent); color: var(--settings-warning); font-size: .74rem; }
.attachment-reference-arrow { flex: 0 0 auto; color: var(--settings-accent); }
.attachment-reference-more { align-self: center; }
.attachment-reference-coverage { margin: 0; }
.attachment-risk-button { align-self: flex-start; }
.attachment-risk-result { padding: 9px 10px; border: 1px solid var(--settings-border); border-radius: 7px; color: var(--settings-text); font-size: .76rem; }
.attachment-risk-result p { margin: 5px 0; }
.attachment-risk-result ul { display: flex; flex-direction: column; gap: 3px; margin: 6px 0; padding-left: 18px; color: var(--settings-muted); }
.attachment-risk-result small { color: var(--settings-muted); }
.attachment-reference-note { flex: 0 0 auto; margin: 0; color: var(--settings-muted); font-size: .76rem; }
@media (max-width: 900px) {
  .attachment-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .attachment-toolbar { grid-template-columns: minmax(0, 1fr) repeat(2, minmax(0, 1fr)); }
  .attachment-toolbar :deep(.n-input) { grid-column: 1 / -1; }
  .attachment-manager { height: auto; min-height: 100%; }
  .attachment-manager-content { flex: 0 0 auto; min-height: 0; grid-template-columns: minmax(0, 1fr); grid-template-rows: auto auto; overflow: visible; }
  .attachment-list-panel, .attachment-detail-panel { overflow: visible; }
  .attachment-resource-list { flex: 0 0 auto; overflow: visible; }
  .attachment-detail-panel { min-height: 180px; }
}
@media (max-width: 520px) {
  .attachment-manager-header { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: center; gap: 8px; }
  .attachment-manager-heading { grid-column: 1 / -1; }
  .attachment-manager-heading h3 { font-size: 1.1rem; }
  .attachment-manager-heading p { max-width: 42vw; font-size: .75rem; }
  .attachment-refresh, .attachment-upload { width: 100%; min-width: 0; padding-inline: 6px; }
  .attachment-refresh { grid-column: 1; grid-row: 2; }
  .attachment-upload { grid-column: 2; grid-row: 2; }
  .attachment-refresh :deep(.n-button__content), .attachment-upload :deep(.n-button__content) { white-space: normal; text-align: center; }
  .attachment-summary { gap: 7px; }
  .attachment-summary > div { padding: 9px 10px; }
  .attachment-toolbar { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; }
  .attachment-toolbar :deep(.n-input) { grid-column: 1 / -1; }
  .attachment-resource-row { gap: 8px; padding-inline: 9px; }
  .attachment-resource-meta :deep(.n-tag) { min-width: 0; max-width: 92px; overflow: hidden; }
  .attachment-resource-meta :deep(.n-tag__content) { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
}
</style>

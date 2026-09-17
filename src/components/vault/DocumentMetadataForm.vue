<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { NButton, NIcon, NInput, type InputInst } from 'naive-ui'
import { Stars } from '@vicons/tabler'
import {
  getPost,
  updateDocumentMetadata,
  type DocumentMetadata,
  type PostDetail,
  type UpdateDocumentMetadata,
} from '../../lib/api'
import { suggestSummary } from '../../lib/ai-api'
import { useToast } from '../../composables/useToast'
import { useI18n } from '../../composables/useI18n'
import type { MetadataBase, MetadataContext, MetadataDraft, MetadataDraftKey } from './metadataDraftStore'
import {
  normalizeTagDisplay,
  normalizeTagIdentity,
} from '../../../shared/tagNormalization'
import {
  getMetadataDraft,
  metadataDraftKey,
  metadataDrafts,
  migrateMetadataDraft,
  setMetadataDraft,
} from './metadataDraftStore'

const props = withDefaults(defineProps<{
  path: string | null
  enabled?: boolean
  autofocus?: boolean
  showActions?: boolean
  showCancel?: boolean
  readonly?: boolean
  context?: MetadataContext
  summarySource?: string | null
}>(), {
  enabled: true,
  autofocus: false,
  showActions: true,
  showCancel: true,
  readonly: false,
  context: 'document',
  summarySource: null,
})

const emit = defineEmits<{
  cancel: []
  saved: [metadata: DocumentMetadata]
  'dirty-change': [dirty: boolean]
}>()

const toast = useToast()
const { locale, t } = useI18n()
const titleInput = ref<InputInst | null>(null)
const loading = ref(false)
const saving = ref(false)
const loadError = ref<string | null>(null)
const title = ref('')
const summary = ref('')
const tags = ref('')
const metadata = ref<DocumentMetadata | null>(null)
const loadedBase = ref<MetadataBase | null>(null)
const loadedIdentity = ref<{ path: string; documentId: string | null } | null>(null)
const draftRevision = ref(0)
const uncertainSaveKey = ref<MetadataDraftKey | null>(null)
const generatingSummary = ref(false)
const isReadonly = computed(() => props.readonly || props.context !== 'document')
let summaryGenerationId = 0
let summaryGenerationController: AbortController | null = null
let loadSequence = 0
let applyingFields = false
type ActiveMetadataSave = {
  revision: number
  payload: UpdateDocumentMetadata
  intended: {
    title: string
    summary: string
    tags: string[]
  }
  base: MetadataBase
}
const activeSaveByKey = new Map<MetadataDraftKey, ActiveMetadataSave>()

const directory = computed(() => {
  if (!props.path) return '—'
  const index = props.path.lastIndexOf('/')
  return index < 0 ? t('metadata.root') : props.path.slice(0, index)
})

const dirty = computed(() => {
  const base = loadedBase.value
  const identity = loadedIdentity.value
  if (isReadonly.value || !base || !identity || !props.path || identity.path !== props.path) return false
  if (uncertainSaveKey.value === metadataDraftKey(identity)) return true
  return normalizeTitle(title.value) !== base.title
    || normalizeSummary(summary.value) !== base.summary
    || JSON.stringify(split(tags.value)) !== JSON.stringify(base.tags)
})

function formatDate(value?: number): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat(locale.value === 'zh' ? 'zh-CN' : 'en-US', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(value)
}

function normalizeTitle(value: string): string { return value.trim() }
function normalizeSummary(value: string): string { return value.trim() }

function join(values: string[]): string { return values.join(', ') }

function split(value: string): string[] {
  const seen = new Set<string>()
  return value.split(/[,\n]/).map((item) => normalizeTagDisplay(item)).filter((item) => {
    const key = normalizeTagIdentity(item)
    if (!item || !key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function normalizeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function fieldsFromPost(post: PostDetail, path: string): { metadata: DocumentMetadata | null; base: MetadataBase } {
  const serverMetadata = post.metadata ?? null
  const fallbackTitle = String(post.frontmatter.title ?? path.split('/').pop() ?? '')
  const fallbackSummary = String(post.frontmatter.summary ?? '')
  const fallbackTags = Array.isArray(post.frontmatter.tags) ? post.frontmatter.tags as string[] : []
  return {
    metadata: serverMetadata,
    base: {
      title: normalizeTitle(serverMetadata?.title ?? fallbackTitle),
      summary: normalizeSummary(serverMetadata?.summary ?? fallbackSummary),
      tags: split(join(serverMetadata?.tags ?? fallbackTags)),
      updatedAt: serverMetadata?.updatedAt ?? post.mtime ?? 0,
    },
  }
}

function setFields(next: { title: string; summary: string; tags: string[] }): void {
  applyingFields = true
  title.value = next.title
  summary.value = next.summary
  tags.value = join(next.tags)
  applyingFields = false
}

function applyLoadedPost(path: string, post: PostDetail): void {
  const loaded = fieldsFromPost(post, path)
  metadata.value = loaded.metadata
  const identity = { path, documentId: loaded.metadata?.id ?? null }
  loadedIdentity.value = identity
  const draft = getMetadataDraft(identity)
  if (draft?.uncertain) uncertainSaveKey.value = metadataDraftKey(identity)
  else if (uncertainSaveKey.value === metadataDraftKey(identity)) uncertainSaveKey.value = null
  if (!isReadonly.value && draft?.dirty) {
    draft.path = path
    loadedBase.value = draft.base
    setMetadataDraft(draft)
    setFields({ title: draft.title, summary: draft.summary, tags: split(draft.tagsText) })
  } else {
    loadedBase.value = loaded.base
    setFields(loaded.base)
  }
  draftRevision.value = draft?.revision ?? 0
}

function clearVisibleFields(): void {
  metadata.value = null
  loadedBase.value = null
  loadedIdentity.value = null
  setFields({ title: '', summary: '', tags: [] })
  draftRevision.value = 0
}

function clearCurrentView(): void {
  loadSequence++
  loading.value = false
  loadError.value = null
  clearVisibleFields()
}

async function load(): Promise<void> {
  const requestedPath = props.path
  if (!requestedPath) {
    clearCurrentView()
    return
  }

  const sequence = ++loadSequence
  loading.value = true
  loadError.value = null
  clearVisibleFields()

  try {
    const post = await getPost(requestedPath)
    if (sequence !== loadSequence || props.path !== requestedPath) return
    applyLoadedPost(requestedPath, post)
    if (props.autofocus) {
      await nextTick()
      if (sequence === loadSequence && props.path === requestedPath) {
        titleInput.value?.focus()
        titleInput.value?.select()
      }
    }
  } catch (cause) {
    if (sequence !== loadSequence || props.path !== requestedPath) return
    loadError.value = normalizeError(cause)
    clearVisibleFields()
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

function syncDraft(): void {
  const identity = loadedIdentity.value
  const base = loadedBase.value
  if (applyingFields || loading.value || isReadonly.value || !identity || !base || identity.path !== props.path) return
  const nextRevision = draftRevision.value + 1
  draftRevision.value = nextRevision
  const key = metadataDraftKey(identity)
  if (uncertainSaveKey.value === key) uncertainSaveKey.value = null
  if (!dirty.value) {
    if (activeSaveByKey.has(key)) {
      setMetadataDraft({
        documentId: identity.documentId,
        path: identity.path,
        title: title.value,
        summary: summary.value,
        tagsText: tags.value,
        base,
        dirty: false,
        uncertain: false,
        revision: nextRevision,
      })
    } else {
      metadataDrafts.delete(key)
    }
    return
  }
  setMetadataDraft({
    documentId: identity.documentId,
    path: identity.path,
    title: title.value,
    summary: summary.value,
    tagsText: tags.value,
    base,
    dirty: true,
    uncertain: false,
    revision: nextRevision,
  })
}

function snapshotCurrentFields() {
  return {
    title: normalizeTitle(title.value),
    summary: normalizeSummary(summary.value),
    tags: split(tags.value),
  }
}

type MetadataFieldSnapshot = {
  title: string
  summary: string
  tagsText: string
  revision: number
}

function snapshotVisibleFieldsWithRevision(): MetadataFieldSnapshot {
  return {
    title: title.value,
    summary: summary.value,
    tagsText: tags.value,
    revision: draftRevision.value,
  }
}

function fieldsFromSavePayload(
  intended: ActiveMetadataSave['intended'],
  revision: number,
): MetadataFieldSnapshot {
  return {
    title: intended.title,
    summary: intended.summary,
    tagsText: join(intended.tags),
    revision,
  }
}

function fieldsDifferFromBase(fields: MetadataFieldSnapshot, base: MetadataBase): boolean {
  return normalizeTitle(fields.title) !== base.title
    || normalizeSummary(fields.summary) !== base.summary
    || JSON.stringify(split(fields.tagsText)) !== JSON.stringify(base.tags)
}

function metadataMatchesPayload(
  metadata: DocumentMetadata,
  payload: UpdateDocumentMetadata,
): boolean {
  return (payload.title === undefined || normalizeTitle(metadata.title) === payload.title)
    && (payload.summary === undefined || normalizeSummary(metadata.summary) === payload.summary)
    && (payload.tags === undefined || JSON.stringify(split(join(metadata.tags))) === JSON.stringify(split(join(payload.tags))))
}

type SaveContext = {
  savingPath: string
  savingDocumentId: string | null
  savingKey: MetadataDraftKey
  activeSave: ActiveMetadataSave
  outcome: SaveOutcome
}

type SaveOutcome = 'confirmed-saved' | 'confirmed-not-saved' | 'unknown'

function formMatchesSave(context: SaveContext, savedId: string | null): boolean {
  return loadedIdentity.value?.path === context.savingPath
    && (
      loadedIdentity.value.documentId === context.savingDocumentId
      || (!context.savingDocumentId && loadedIdentity.value.documentId === null)
      || (savedId !== null && loadedIdentity.value.documentId === savedId)
    )
}

function reconcileMetadataAgainstBase(
  context: SaveContext,
  saved: DocumentMetadata | null,
  savedBase: MetadataBase,
): void {
  const savedIdentity = {
    path: saved?.path ?? context.savingPath,
    documentId: saved?.id ?? context.savingDocumentId,
  }
  const currentFormMatchesRequest = formMatchesSave(context, saved?.id ?? null)
  const currentDraft = metadataDrafts.get(context.savingKey)
  const visibleDraft = currentFormMatchesRequest && loadedIdentity.value
    ? getMetadataDraft(loadedIdentity.value)
    : undefined
  const liveFields = currentFormMatchesRequest && draftRevision.value > context.activeSave.revision
    ? snapshotVisibleFieldsWithRevision()
    : null
  const newerDraft = liveFields ?? [visibleDraft, currentDraft]
        .filter((draft): draft is MetadataDraft => draft !== undefined && draft.revision > context.activeSave.revision)
        .sort((left, right) => right.revision - left.revision)[0] ?? null
  const candidate = newerDraft ?? (
    context.outcome === 'confirmed-saved'
      ? null
      : fieldsFromSavePayload(context.activeSave.intended, context.activeSave.revision)
  )
  const hasNewerFields = candidate !== null && candidate.revision > context.activeSave.revision
  const provisionalBase: MetadataBase = {
    title: context.activeSave.intended.title,
    summary: context.activeSave.intended.summary,
    tags: [...context.activeSave.intended.tags],
    updatedAt: context.activeSave.base.updatedAt,
  }
  const reconciliationBase = context.outcome === 'unknown' && hasNewerFields
    ? provisionalBase
    : savedBase
  const preserveUnknownPayload = context.outcome === 'unknown' && !hasNewerFields
  if (preserveUnknownPayload) {
    uncertainSaveKey.value = metadataDraftKey(savedIdentity)
  } else if (
    uncertainSaveKey.value === context.savingKey
    || uncertainSaveKey.value === metadataDraftKey(savedIdentity)
  ) {
    uncertainSaveKey.value = null
  }
  const nextRevision = Math.max(
    draftRevision.value,
    context.activeSave.revision,
    candidate?.revision ?? context.activeSave.revision,
  )

  if (candidate) {
    const draftSource = liveFields && loadedIdentity.value
      ? loadedIdentity.value
      : visibleDraft === candidate && loadedIdentity.value
        ? loadedIdentity.value
        : { path: context.savingPath, documentId: context.savingDocumentId }
    const reconciledDraft = {
      documentId: savedIdentity.documentId,
      path: savedIdentity.path,
      title: candidate.title,
      summary: candidate.summary,
      tagsText: candidate.tagsText,
      base: reconciliationBase,
      dirty: preserveUnknownPayload || fieldsDifferFromBase(candidate, reconciliationBase),
      uncertain: preserveUnknownPayload,
      revision: nextRevision,
    }
    if (reconciledDraft.dirty) {
      if (savedIdentity.documentId) {
        migrateMetadataDraft(
          draftSource,
          { path: savedIdentity.path, documentId: savedIdentity.documentId },
          reconciledDraft,
        )
      } else {
        setMetadataDraft(reconciledDraft)
      }
    } else {
      metadataDrafts.delete(metadataDraftKey(draftSource))
      metadataDrafts.delete(metadataDraftKey(savedIdentity))
    }
  } else {
    metadataDrafts.delete(context.savingKey)
    metadataDrafts.delete(metadataDraftKey(savedIdentity))
  }

  if (!currentFormMatchesRequest) return
  if (saved) {
    metadata.value = saved
    loadedIdentity.value = savedIdentity
  }
  loadedBase.value = reconciliationBase
  draftRevision.value = nextRevision
  if (candidate) {
    setFields({ title: candidate.title, summary: candidate.summary, tags: split(candidate.tagsText) })
  } else {
    setFields(savedBase)
  }
}

const canSave = computed(() => {
  const identity = loadedIdentity.value
  return Boolean(
    props.path
    && identity
    && identity.path === props.path
    && loadedBase.value
    && dirty.value
    && normalizeTitle(title.value)
    && !loadError.value
    && !loading.value
    && !saving.value
    && !generatingSummary.value
    && !isReadonly.value,
  )
})

async function save(): Promise<void> {
  const identity = loadedIdentity.value
  if (!canSave.value || !identity) return
  const savingPath = identity.path
  const savingDocumentId = identity.documentId
  const savingKey = metadataDraftKey(identity)
  const savingRevision = draftRevision.value
  const intended = snapshotCurrentFields()
  const savingBase = loadedBase.value
  if (!savingBase) return
  const payload: UpdateDocumentMetadata = {}
  if (intended.title !== savingBase.title) payload.title = intended.title
  if (intended.summary !== savingBase.summary) payload.summary = intended.summary
  if (JSON.stringify(intended.tags) !== JSON.stringify(savingBase.tags)) {
    payload.tags = intended.tags
    payload.expectedUpdatedAt = savingBase.updatedAt
  }
  if (Object.keys(payload).length === 0) return
  const saveSnapshot: ActiveMetadataSave = { revision: savingRevision, payload, intended, base: savingBase }
  activeSaveByKey.set(savingKey, saveSnapshot)
  saving.value = true
  try {
    const saved = await updateDocumentMetadata(savingPath, payload)
    const savedMatchesPath = saved.path === savingPath
    const savedMatchesDocument = savingDocumentId ? saved.id === savingDocumentId : true
    if (!savedMatchesPath || !savedMatchesDocument) {
      const message = `metadata response identity mismatch for ${savingPath}`
      console.warn(message, { savingDocumentId, savedId: saved.id, savedPath: saved.path })
      toast.error(t('metadata.save_failed', { error: message }))
      return
    }

    const savedBase: MetadataBase = {
      title: normalizeTitle(saved.title),
      summary: normalizeSummary(saved.summary),
      tags: split(join(saved.tags)),
      updatedAt: saved.updatedAt,
    }
    // The server result is a global fact even when the form has since
    // switched to another document. Let the Vault update all consumers;
    // only the matching form instance is allowed to update its fields.
    emit('saved', saved)

    reconcileMetadataAgainstBase(
      {
        savingPath,
        savingDocumentId,
        savingKey,
        activeSave: saveSnapshot,
        outcome: 'confirmed-saved',
      },
      saved,
      savedBase,
    )
    toast.success(t('metadata.saved'))
  } catch (cause) {
    const activeSave = activeSaveByKey.get(savingKey) ?? saveSnapshot
    let confirmedServerState = false
    let refreshFailed = false
    try {
      const post = await getPost(savingPath)
      if (post.path !== savingPath) throw new Error(`metadata refresh identity mismatch for ${savingPath}`)
      const reread = fieldsFromPost(post, savingPath)
      if (savingDocumentId && reread.metadata && reread.metadata.id !== savingDocumentId) {
        throw new Error(`metadata refresh document mismatch for ${savingPath}`)
      }
      if (reread.metadata && reread.metadata.path !== savingPath) {
        throw new Error(`metadata refresh path mismatch for ${savingPath}`)
      }
      const rereadMetadata = reread.metadata
      const rereadMatchesPayload = rereadMetadata
        ? metadataMatchesPayload(rereadMetadata, activeSave.payload)
        : false
      reconcileMetadataAgainstBase(
        {
          savingPath,
          savingDocumentId,
          savingKey,
          activeSave,
          outcome: rereadMatchesPayload ? 'confirmed-saved' : 'confirmed-not-saved',
        },
        rereadMetadata,
        reread.base,
      )
      if (rereadMetadata && rereadMatchesPayload) {
        emit('saved', rereadMetadata)
        toast.success(t('metadata.saved'))
        confirmedServerState = true
      }
    } catch {
      refreshFailed = true
      if (activeSave) {
        reconcileMetadataAgainstBase(
          {
            savingPath,
            savingDocumentId,
            savingKey,
            activeSave,
            outcome: 'unknown',
          },
          null,
          activeSave.base,
        )
      }
      toast.error(t('metadata.save_unknown'))
    }
    if (!confirmedServerState && !refreshFailed) {
      toast.error(t('metadata.save_failed', { error: normalizeError(cause) }))
    }
  } finally {
    activeSaveByKey.delete(savingKey)
    saving.value = false
  }
}

async function generateSummary(): Promise<void> {
  const identity = loadedIdentity.value
  if (
    !props.path || !identity || loading.value || saving.value
    || generatingSummary.value || isReadonly.value || !loadedBase.value
  ) return
  const currentGeneration = ++summaryGenerationId
  const pathSnapshot = props.path
  const documentIdSnapshot = identity.documentId
  const contentSnapshot = props.summarySource
  const summaryFieldSnapshot = summary.value
  summaryGenerationController?.abort()
  const controller = new AbortController()
  summaryGenerationController = controller
  generatingSummary.value = true
  try {
    const request: { path: string; language: 'zh' | 'en'; content?: string } = {
      path: pathSnapshot,
      language: locale.value,
    }
    if (contentSnapshot !== null) request.content = contentSnapshot
    const result = await suggestSummary(request, controller.signal)
    if (
      currentGeneration !== summaryGenerationId || controller.signal.aborted
      || props.path !== pathSnapshot || loadedIdentity.value?.documentId !== documentIdSnapshot
      || summary.value !== summaryFieldSnapshot || loading.value || saving.value || isReadonly.value
    ) return
    const suggestion = result.summary.trim()
    if (!suggestion) {
      toast.error(t('metadata.ai_summary_empty'))
      return
    }
    summary.value = suggestion
  } catch (cause) {
    if (controller.signal.aborted || currentGeneration !== summaryGenerationId) return
    toast.error(t('metadata.ai_summary_failed', { error: normalizeError(cause) }))
  } finally {
    if (currentGeneration === summaryGenerationId) {
      generatingSummary.value = false
      summaryGenerationController = null
    }
  }
}

function reset(): void {
  const identity = loadedIdentity.value
  const base = loadedBase.value
  if (isReadonly.value || !identity || !base) return
  metadataDrafts.delete(metadataDraftKey(identity))
  if (uncertainSaveKey.value === metadataDraftKey(identity)) uncertainSaveKey.value = null
  setFields(base)
  draftRevision.value++
}

function cancelSummaryGeneration(): void {
  summaryGenerationId++
  summaryGenerationController?.abort()
  summaryGenerationController = null
  generatingSummary.value = false
}

function retry(): void { void load() }

function onKeydown(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    if (isReadonly.value) return
    event.preventDefault()
    void save()
  }
}

watch([title, summary, tags], syncDraft, { flush: 'sync' })
watch(dirty, (value) => emit('dirty-change', value), { immediate: true })
watch(
  () => [props.enabled, props.path] as const,
  ([enabled]) => {
    cancelSummaryGeneration()
    if (!enabled) return
    if (props.path && loadedIdentity.value?.path === props.path && !loadError.value) return
    void load()
  },
  { immediate: true },
)
watch(() => [props.context, props.readonly] as const, () => {
  if (props.enabled) void load()
})

onBeforeUnmount(cancelSummaryGeneration)
</script>

<template>
  <form class="document-metadata-form" @submit.prevent="save" @keydown="onKeydown">
    <div v-if="path" class="document-metadata-body" :aria-busy="loading || generatingSummary">
      <div v-if="loading" class="document-metadata-status" role="status">{{ t('metadata.loading') }}</div>
      <div v-else-if="loadError" class="document-metadata-error" role="alert">
        <span>{{ t('metadata.load_failed', { error: loadError }) }}</span>
        <NButton attr-type="button" :bordered="false" class="btn" @click="retry">{{ t('metadata.retry') }}</NButton>
      </div>
      <template v-else>
        <p v-if="isReadonly" class="document-metadata-readonly-hint">
          {{ t(`metadata.readonly_${context}`) }}
        </p>
        <label class="document-metadata-field">
          <span>{{ t('metadata.field_title') }}</span>
          <NInput
            ref="titleInput"
            v-model:value="title"
            class="document-metadata-input"
            type="text"
            size="small"
            :bordered="false"
            :maxlength="200"
            :disabled="loading || isReadonly || !path"
            :input-props="{ required: true }"
          />
        </label>
        <div class="document-metadata-field">
          <div class="document-metadata-field-head">
            <span>{{ t('metadata.summary') }}</span>
            <NButton
              v-if="!isReadonly"
              attr-type="button"
              :bordered="false"
              class="metadata-generate-summary"
              :disabled="loading || saving || generatingSummary || !path"
              :aria-label="t(generatingSummary ? 'metadata.ai_generating_summary' : 'metadata.ai_generate_summary')"
              :title="t(generatingSummary ? 'metadata.ai_generating_summary' : 'metadata.ai_generate_summary')"
              @click="generateSummary"
            >
              <NIcon class="metadata-generate-summary-icon" aria-hidden="true">
                <Stars />
              </NIcon>
              <span>{{ t(generatingSummary ? 'metadata.ai_generating_summary' : 'metadata.ai_generate_summary') }}</span>
            </NButton>
          </div>
          <div class="document-metadata-textarea-wrap">
            <NInput
              v-model:value="summary"
              class="document-metadata-input"
              type="textarea"
              size="small"
              :bordered="false"
              :maxlength="2000"
              :rows="4"
              :input-props="{ 'aria-label': t('metadata.summary') }"
              :disabled="loading || isReadonly || !path"
            />
            <small>{{ summary.length }} / 2000</small>
          </div>
        </div>
        <label class="document-metadata-field">
          <span>{{ t('metadata.tags') }}</span>
          <NInput
            v-model:value="tags"
            class="document-metadata-input"
            type="text"
            size="small"
            :bordered="false"
            placeholder="rag, notes"
            :disabled="loading || isReadonly || !path"
          />
        </label>
        <section class="document-metadata-readonly" :aria-label="t('metadata.readonly')">
          <div><span>{{ t('metadata.created_at') }}</span><output>{{ formatDate(metadata?.createdAt) }}</output></div>
          <div><span>{{ t('metadata.updated_at') }}</span><output>{{ formatDate(metadata?.updatedAt) }}</output></div>
          <div><span>{{ t('metadata.document_id') }}</span><output class="is-mono" :title="metadata?.id">{{ metadata?.id ?? '—' }}</output></div>
          <div><span>{{ t('metadata.directory') }}</span><output class="is-mono" :title="directory">{{ directory }}</output></div>
        </section>
      </template>
    </div>
    <div v-else class="document-metadata-empty right-rail-empty-state">{{ t('metadata.no_document') }}</div>

    <footer v-if="showActions && path && !isReadonly && !loadError" class="document-metadata-actions">
      <NButton v-if="showCancel" attr-type="button" :bordered="false" class="btn" @click="emit('cancel')">{{ t('metadata.cancel') }}</NButton>
      <NButton attr-type="button" :bordered="false" class="btn" :disabled="loading || saving || generatingSummary || !dirty" @click="reset">{{ t('metadata.reset') }}</NButton>
      <NButton attr-type="submit" :bordered="false" class="btn btn-primary" :disabled="!canSave">
        {{ t(saving ? 'metadata.saving' : 'metadata.save') }}
      </NButton>
    </footer>
  </form>
</template>

<style scoped>
.document-metadata-body { display: grid; gap: 15px; padding: 18px; }
.document-metadata-status { color: var(--text-muted); font-size: 0.78rem; }
.document-metadata-error { display: grid; gap: 9px; color: var(--danger, #d14); font-size: 0.78rem; }
.document-metadata-error .btn { justify-self: start; }
.document-metadata-readonly-hint { margin: 0; color: var(--text-muted); font-size: 0.76rem; line-height: 1.5; }
.document-metadata-field { position: relative; display: grid; gap: 6px; }
.document-metadata-field > span { color: var(--text-muted); font-size: 0.76rem; font-weight: 600; }
/* Field head: label + optional field-level action (e.g. AI summary). The head
   is only present when a field has an inline action; otherwise the label sits
   directly inside the field as before. */
.document-metadata-field-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 0; }
.document-metadata-field-head > span { color: var(--text-muted); font-size: 0.76rem; font-weight: 600; }
.document-metadata-field :deep(.document-metadata-input) { width: 100%; }
.document-metadata-field :deep(.document-metadata-input input),
.document-metadata-field :deep(.document-metadata-input textarea) { width: 100%; box-sizing: border-box; border: 1px solid var(--border); border-radius: 4px; padding: 8px 10px; background: var(--bg-soft); color: var(--text); font: inherit; letter-spacing: 0; outline: none; }
.document-metadata-textarea-wrap { position: relative; min-width: 0; }
.document-metadata-textarea-wrap :deep(.document-metadata-input textarea) { padding-right: 10px; padding-bottom: 29px; }
.document-metadata-field :deep(.document-metadata-input textarea) { resize: vertical; min-height: 92px; line-height: 1.5; }
.document-metadata-field :deep(.document-metadata-input input:focus),
.document-metadata-field :deep(.document-metadata-input textarea:focus) { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
/* AI generate: ghost button sitting on the label row, no longer absolute over
   the textarea. Sizing baseline matches the other ghost buttons in the panel. */
.metadata-generate-summary { display: inline-flex; align-items: center; gap: 3px; min-height: 18px; padding: 0 5px; border: 0; border-radius: 3px; background: transparent; color: var(--text-muted); font: inherit; font-size: 0.66rem; cursor: pointer; transition: color 0.12s ease, background 0.12s ease; }
.metadata-generate-summary-icon { display: inline-flex; flex: 0 0 12px; }
.metadata-generate-summary-icon :deep(svg) { display: block; width: 12px; height: 12px; }
.metadata-generate-summary:hover:not(:disabled) { background: var(--code-bg); color: var(--accent); }
.metadata-generate-summary:focus-visible { outline: 1px solid color-mix(in srgb, var(--accent) 72%, transparent); outline-offset: 1px; }
.metadata-generate-summary:disabled { cursor: default; opacity: 0.5; }
.document-metadata-readonly { display: grid; grid-template-columns: 1fr 1fr; gap: 0; margin-top: 3px; border-top: 1px solid var(--border); }
.document-metadata-readonly > div { min-width: 0; display: grid; gap: 4px; padding: 12px 0; border-bottom: 1px solid var(--border); }
.document-metadata-readonly > div:nth-child(odd) { padding-right: 16px; }
.document-metadata-readonly > div:nth-child(even) { padding-left: 16px; border-left: 1px solid var(--border); }
.document-metadata-readonly span { color: var(--text-muted); font-size: 0.7rem; }
.document-metadata-readonly output { min-width: 0; overflow: hidden; color: var(--text); font-size: 0.78rem; text-overflow: ellipsis; white-space: nowrap; }
.document-metadata-readonly output.is-mono { font-family: var(--mono); font-size: 0.72rem; }
.document-metadata-actions { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--border); background: var(--bg-soft); }
</style>

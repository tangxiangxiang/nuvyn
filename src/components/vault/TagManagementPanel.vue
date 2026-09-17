<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NButton, NInput, NSelect, type InputInst, type SelectInst, type SelectNodeProps, type SelectOption } from 'naive-ui'
import { useConfirm } from '../../composables/useConfirm'
import { useI18n } from '../../composables/useI18n'
import { formatHistoryDate } from '../../lib/history-date'
import {
  applyTagOperation,
  assertApplyResultMatchesReviewedPreview,
  getTagOperationPreviewPage,
  listManagedTags,
  previewTagOperation,
  TagManagementApiError,
  type ManagedTag,
  type PreviewDocument,
  type TagManagementClientErrorCode,
  type TagOperationApplyResult,
  type TagOperationKind,
  type TagOperationPreview,
  type TagOperationRequest,
} from '../../lib/tag-management-api'
import {
  applyUndo,
  getUndoAvailability,
  getUndoPreviewPage,
  previewUndo,
  TagUndoApiError,
  type UndoApplyResult,
  type UndoAvailability,
  type UndoPreview,
  type UndoWarningCode,
} from '../../lib/tag-undo-api'
import {
  captureTagSelection,
  resolveManagedTagId,
  type TagSelectionSnapshot,
} from '../../lib/tag-selection-reconciliation'

type ManagerState =
  | 'loading'
  | 'ready'
  | 'editing'
  | 'previewing'
  | 'preview-ready'
  | 'applying'
  | 'syncing'
  | 'success'
  | 'sync-pending'
  | 'unavailable'
  | 'error'

type UndoUiState =
  | 'undo-unavailable'
  | 'undo-available'
  | 'undo-previewing'
  | 'undo-preview-ready'
  | 'undo-confirming'
  | 'undo-applying'
  | 'undo-committed-refreshing'
  | 'undo-sync-pending'
  | 'undo-conflict'
  | 'undo-stale'
  | 'undo-success'
  | 'undo-superseded'
  | 'undo-terminal-unavailable'

type VisibleOperationKind = TagOperationKind

interface RemovalConfirmationContext {
  operation: TagOperationRequest
  planFingerprint: string
  sourceDisplayName: string
}

interface UndoConfirmationContext {
  recordId: string
  undoFingerprint: string
  preview: UndoPreview
}

interface UndoSyncResult {
  managedTags: ManagedTag[]
  selectedTag: string | null
  undoAvailability: UndoAvailability
}

interface CommittedUndoRecoveryResult extends UndoSyncResult {
  outcome: 'consumed' | 'superseded' | 'terminal-unavailable'
}

interface TagManagementPanelProps {
  selectedTag?: string | null
  selectionEpoch?: number
  /** The VaultView-owned canonical refresh and stable-ID reconciliation seam. */
  syncAfterCommit: (
    result: TagOperationApplyResult,
    snapshot: TagSelectionSnapshot,
  ) => Promise<{
    managedTags: ManagedTag[]
    selectedTag: string | null
    undoAvailability?: UndoAvailability
  }>
  /** The VaultView-owned recovery seam for a committed, untrusted Apply response. */
  recoverCommittedOperation: (
    operation: TagOperationRequest,
    snapshot: TagSelectionSnapshot,
  ) => Promise<{
    managedTags: ManagedTag[]
    selectedTag: string | null
    undoAvailability?: UndoAvailability
  }>
  /** VaultView-owned authoritative sync after a trusted Undo Apply. */
  syncAfterUndo?: (
    result: UndoApplyResult,
    snapshot: TagSelectionSnapshot,
  ) => Promise<UndoSyncResult>
  /** Read-only committed recovery anchored by the submitted Undo record. */
  recoverCommittedUndo?: (
    recordId: string,
    snapshot: TagSelectionSnapshot,
  ) => Promise<CommittedUndoRecoveryResult>
}

const props = withDefaults(defineProps<TagManagementPanelProps>(), {
  selectedTag: null,
  selectionEpoch: 0,
})

const emit = defineEmits<{
  success: [result: TagOperationApplyResult]
}>()

const { locale, t } = useI18n()
const { confirmCancellable } = useConfirm()
const panelRef = ref<HTMLElement | null>(null)
const isMounted = ref(false)
const sourceSelectRef = ref<SelectInst | null>(null)
const destinationInputRef = ref<InputInst | null>(null)
const destinationSelectRef = ref<SelectInst | null>(null)
const previewHeadingRef = ref<HTMLElement | null>(null)
const undoPreviewHeadingRef = ref<HTMLElement | null>(null)
const undoApplyButtonRef = ref<{ $el: HTMLButtonElement } | null>(null)

const state = ref<ManagerState>('loading')
const managedTags = ref<ManagedTag[]>([])
const operationKind = ref<VisibleOperationKind>('rename')
const sourceTagId = ref<number | null>(null)
const destinationName = ref('')
const tagSearch = ref('')
const destinationSearch = ref('')
const destinationTagId = ref<number | null>(null)
const preview = ref<TagOperationPreview | null>(null)
const reviewedOperation = ref<TagOperationRequest | null>(null)
const continuationPages = ref<PreviewDocument[][]>([])
const nextAfterDocumentId = ref<string | null>(null)
const pageLoading = ref(false)
const applyResult = ref<TagOperationApplyResult | null>(null)
const finalTags = ref<ManagedTag[]>([])
const destinationError = ref('')
const sourceError = ref('')
const errorMessage = ref('')
const staleMessage = ref('')
const liveMessage = ref('')
const diagnosticStage = ref('loading')
const diagnosticCode = ref<string | null>(null)
const selectionSnapshot = ref<TagSelectionSnapshot | null>(null)
const reconciledSelectedTag = ref<string | null>(null)
const committedSourceDisplayName = ref<string | null>(null)
const committedRecoveryOperation = ref<TagOperationRequest | null>(null)
// A successful Apply whose response fails the reviewed-Preview contract is
// committed, but its contradictory identity fields are unsafe for the normal
// VaultView reconciliation seam. Retry therefore uses the dedicated
// VaultView-owned recovery seam and never passes this result for reconciliation.
const authoritativeRecoveryPending = ref(false)
const removalConfirmation = ref<RemovalConfirmationContext | null>(null)
let cancelRemovalConfirmation: (() => void) | null = null

const undoState = ref<UndoUiState>('undo-unavailable')
const undoAvailability = ref<UndoAvailability | null>(null)
const undoPreview = ref<UndoPreview | null>(null)
const reviewedUndoPreview = ref<UndoPreview | null>(null)
const undoContinuationPages = ref<Array<UndoPreview['sample']>>([])
const undoNextCursor = ref<string | null>(null)
const undoPageLoading = ref(false)
const undoResult = ref<UndoApplyResult | null>(null)
const undoSelectionSnapshot = ref<TagSelectionSnapshot | null>(null)
const undoRecoveryRecordId = ref<string | null>(null)
const undoRecoveryPending = ref(false)
const undoConfirmation = ref<UndoConfirmationContext | null>(null)
let cancelUndoConfirmation: (() => void) | null = null

let loadRun = 0
let previewRun = 0
let syncRun = 0
let pageRun = 0
let operationRevision = 0
let undoPreviewRun = 0
let undoPageRun = 0
let undoAvailabilityRevision = 0
let undoSyncRun = 0
let undoRefreshRun = 0

const filteredManagedTags = computed(() => {
  const needle = tagSearch.value.trim().toLocaleLowerCase()
  const filtered = needle
    ? managedTags.value.filter((tag) => (
        tag.displayName.toLocaleLowerCase().includes(needle)
        || tag.normalizedName.includes(needle)
      ))
    : managedTags.value
  if (sourceTagId.value !== null && !filtered.some((tag) => tag.id === sourceTagId.value)) {
    const selected = managedTags.value.find((tag) => tag.id === sourceTagId.value)
    return selected ? [selected, ...filtered] : filtered
  }
  return filtered
})

const filteredDestinationTags = computed(() => {
  const needle = destinationSearch.value.trim().toLocaleLowerCase()
  const filtered = managedTags.value.filter((tag) => (
    tag.id !== sourceTagId.value
    && (!needle
      || tag.displayName.toLocaleLowerCase().includes(needle)
      || tag.normalizedName.includes(needle))
  ))
  if (destinationTagId.value !== null && !filtered.some((tag) => tag.id === destinationTagId.value)) {
    const selected = managedTags.value.find((tag) => (
      tag.id === destinationTagId.value && tag.id !== sourceTagId.value
    ))
    return selected ? [selected, ...filtered] : filtered
  }
  return filtered
})

const sourceOptions = computed<SelectOption[]>(() => [
  { value: '', label: t('tags.manage.source_placeholder') },
  ...filteredManagedTags.value.map((tag) => ({
    value: String(tag.id),
    label: `#${tag.displayName} · ${tag.documentCount}`,
  })),
])

const destinationOptions = computed<SelectOption[]>(() => [
  { value: '', label: t('tags.manage.destination_placeholder') },
  ...filteredDestinationTags.value.map((tag) => ({
    value: String(tag.id),
    label: `#${tag.displayName} · ${tag.documentCount}`,
  })),
])

// SettingsModal is a custom teleported surface rather than Naive UI's modal
// provider, so its backdrop sits above the default body-level follower. Keep
// these menus above that backdrop without changing the global overlay stack.
const tagSelectMenuProps = {
  class: 'tag-management-select-menu',
  style: { zIndex: 10000 },
}

const tagSelectNodeProps: SelectNodeProps = (option) => ({
  role: 'option',
  'aria-label': String(option.label),
})

const selectedDestinationTag = computed(() => (
  destinationTagId.value === null
    ? null
    : managedTags.value.find((tag) => tag.id === destinationTagId.value) ?? null
))

const selectedSourceTag = computed(() => (
  sourceTagId.value === null
    ? null
    : managedTags.value.find((tag) => tag.id === sourceTagId.value) ?? null
))

const renderedSample = computed(() => {
  const seen = new Set<string>()
  const result: PreviewDocument[] = []
  for (const document of continuationPages.value.flat()) {
    if (seen.has(document.id)) continue
    seen.add(document.id)
    result.push(document)
  }
  return result
})

const renderedUndoSample = computed(() => {
  const seen = new Set<string>()
  const result: UndoPreview['sample'] = []
  for (const page of undoContinuationPages.value) {
    for (const document of page) {
      if (seen.has(document.id)) continue
      seen.add(document.id)
      result.push(document)
    }
  }
  return result
})

const undoOperationLabel = computed(() => {
  const current = undoPreview.value ?? undoAvailability.value
  if (!current || !current.kind) return t('tags.manage.undo')
  if (current.kind === 'merge') return t('tags.manage.undo_merge')
  if (current.kind === 'remove') return t('tags.manage.undo_remove')
  return current.displayOnly
    ? t('tags.manage.undo_display_rename')
    : t('tags.manage.undo_rename')
})

const undoCommitTime = computed(() => {
  const timestamp = (undoPreview.value ?? undoAvailability.value)?.committedAt
  return timestamp === null || timestamp === undefined
    ? ''
    : formatHistoryDate(timestamp, locale.value)
})

const undoLocksEditing = computed(() => [
  'undo-previewing', 'undo-confirming', 'undo-applying',
  'undo-committed-refreshing', 'undo-sync-pending',
].includes(undoState.value))

const ordinaryAllowsUndoInteraction = computed(() => [
  'ready', 'editing', 'preview-ready', 'success', 'error',
].includes(state.value))

const undoCanDiscoverPreview = computed(() => (
  ordinaryAllowsUndoInteraction.value
  && (undoState.value === 'undo-available'
    || undoState.value === 'undo-conflict'
    || undoState.value === 'undo-stale')
  && undoAvailability.value?.state === 'available'
  && undoAvailability.value.validation !== 'temporary-unavailable'
  && undoAvailability.value.recordId !== null
))

const undoCanApply = computed(() => (
  ordinaryAllowsUndoInteraction.value
  && undoState.value === 'undo-preview-ready'
  && undoPreview.value !== null
  && reviewedUndoPreview.value !== null
  && undoPreview.value === reviewedUndoPreview.value
  && undoPreview.value.state === 'available'
  && undoPreview.value.validation === 'safe'
  && undoPreview.value.allowedToApply
  && undoPreview.value.recordId !== null
  && undoPreview.value.undoFingerprint !== null
  && undoAvailability.value?.state === 'available'
  && undoAvailability.value.recordId === undoPreview.value.recordId
  && !undoPageLoading.value
))

const finalDisplayName = computed(() => {
  const result = applyResult.value
  if (!result) return null
  if (result.operation.kind === 'remove') return committedSourceDisplayName.value
  if (result.survivorTagId !== null) {
    const fresh = finalTags.value.find((tag) => tag.id === result.survivorTagId)
    if (fresh) return fresh.displayName
  }
  return result.survivorDisplayName ?? result.sourceDisplayName
})

const diagnosticLabel = computed(() => {
  const labels: Record<string, string> = {
    loading: t('tags.manage.diagnostic_loading'),
    ready: t('tags.manage.diagnostic_ready'),
    unavailable: t('tags.manage.diagnostic_unavailable'),
    'load-failure': t('tags.manage.diagnostic_load_failure'),
    'preview-loading': t('tags.manage.diagnostic_preview_loading'),
    'preview-page-loading': t('tags.manage.diagnostic_preview_page_loading'),
    'preview-ready': t('tags.manage.diagnostic_preview_ready'),
    'preview-failure': t('tags.manage.diagnostic_preview_failure'),
    'preview-stale': t('tags.manage.diagnostic_preview_stale'),
    applying: t('tags.manage.diagnostic_applying'),
    syncing: t('tags.manage.diagnostic_syncing'),
    success: t('tags.manage.diagnostic_success'),
    'apply-failure': t('tags.manage.diagnostic_apply_failure'),
    'sync-pending': t('tags.manage.diagnostic_sync_pending'),
    'undo-preview-loading': t('tags.manage.diagnostic_undo_preview_loading'),
    'undo-preview-ready': t('tags.manage.diagnostic_undo_preview_ready'),
    'undo-conflict': t('tags.manage.diagnostic_undo_conflict'),
    'undo-stale': t('tags.manage.diagnostic_undo_stale'),
    'undo-applying': t('tags.manage.diagnostic_undo_applying'),
    'undo-refreshing': t('tags.manage.diagnostic_undo_refreshing'),
    'undo-pending': t('tags.manage.diagnostic_undo_pending'),
    'undo-success': t('tags.manage.diagnostic_undo_success'),
    'undo-superseded': t('tags.manage.diagnostic_undo_superseded'),
    'undo-terminal': t('tags.manage.diagnostic_undo_terminal'),
  }
  return labels[diagnosticStage.value] ?? diagnosticStage.value
})

const canEdit = computed(() => ![
  'loading', 'previewing', 'applying', 'syncing', 'sync-pending', 'unavailable',
].includes(state.value) && !undoLocksEditing.value)

const hasValidMergeDestination = computed(() => (
  operationKind.value === 'merge'
  && selectedSourceTag.value !== null
  && destinationTagId.value !== null
  && sourceTagId.value !== destinationTagId.value
  && managedTags.value.some((tag) => tag.id === destinationTagId.value)
))

const canPreview = computed(() => (
  canEdit.value
  && selectedSourceTag.value !== null
  && (operationKind.value === 'merge'
    ? hasValidMergeDestination.value
    : operationKind.value === 'remove' || destinationName.value.trim().length > 0)
))

const canApply = computed(() => (
  state.value === 'preview-ready'
  && !undoLocksEditing.value
  && !undoPreview.value
  && !reviewedUndoPreview.value
  && preview.value !== null
  && reviewedOperation.value !== null
  && operationsEqual(preview.value.operation, reviewedOperation.value)
  && (() => {
    const current = operationFromForm()
    return current !== null && operationsEqual(current, reviewedOperation.value)
  })()
  && preview.value.allowedToApply
  && preview.value.planFingerprint.length === 64
  && !pageLoading.value
))

const canDismiss = computed(() => ![
  'loading', 'previewing', 'applying', 'syncing', 'sync-pending',
].includes(state.value) && !undoLocksEditing.value)

// SettingsModal uses this host-level signal to keep the Panel mounted while a
// committed mutation, synchronization, or Undo recovery is still unsafe to
// abandon. The Panel remains the only owner of the domain state machine.
const canLeave = computed(() => canDismiss.value)
defineExpose({ canLeave })

function setDiagnostic(stage: string, code: string | null = null): void {
  diagnosticStage.value = stage
  diagnosticCode.value = code
}

function announce(message: string): void {
  liveMessage.value = message
}

function cancelPendingUndoConfirmation(): void {
  undoConfirmation.value = null
  const cancel = cancelUndoConfirmation
  cancelUndoConfirmation = null
  cancel?.()
}

function cancelPendingRemovalConfirmation(): void {
  removalConfirmation.value = null
  const cancel = cancelRemovalConfirmation
  cancelRemovalConfirmation = null
  cancel?.()
}

function clearPreview(): void {
  // A new Preview, an input edit, a reset, and close all invalidate every
  // outstanding continuation request. The page generation is independent of
  // the normal Preview run so an old page's finally block cannot touch a
  // newer page's loading state.
  pageRun += 1
  cancelPendingRemovalConfirmation()
  preview.value = null
  reviewedOperation.value = null
  continuationPages.value = []
  nextAfterDocumentId.value = null
  pageLoading.value = false
}

function clearUndoPreview(): void {
  undoPageRun += 1
  cancelPendingUndoConfirmation()
  undoPreview.value = null
  reviewedUndoPreview.value = null
  undoContinuationPages.value = []
  undoNextCursor.value = null
  undoPageLoading.value = false
}

function undoStateForAvailability(value: UndoAvailability): UndoUiState {
  if (value.reasonCode === 'UNDO_RECORD_CORRUPT') return 'undo-terminal-unavailable'
  if (value.state === 'consumed') return 'undo-terminal-unavailable'
  if (value.state === 'superseded') return 'undo-superseded'
  if (value.state === 'terminal-unavailable') return 'undo-terminal-unavailable'
  if (value.validation === 'stale') return 'undo-stale'
  if (value.validation === 'conflict') return 'undo-conflict'
  if (value.validation === 'temporary-unavailable') return 'undo-unavailable'
  if (value.state === 'available') return 'undo-available'
  return 'undo-unavailable'
}

function setUndoAvailability(
  value: UndoAvailability,
  stateOverride?: UndoUiState,
): void {
  const previousRecordId = undoAvailability.value?.recordId ?? null
  undoAvailability.value = value
  undoAvailabilityRevision += 1
  if (previousRecordId !== null && previousRecordId !== value.recordId) clearUndoPreview()
  undoState.value = stateOverride ?? undoStateForAvailability(value)
}

function setUndoUnavailable(error: unknown): void {
  const code = error instanceof TagUndoApiError ? error.code : 'CLIENT_PROTOCOL_ERROR'
  undoAvailability.value = null
  undoAvailabilityRevision += 1
  clearUndoPreview()
  undoState.value = code === 'UNDO_RECORD_CORRUPT' || code === 'CLIENT_PROTOCOL_ERROR'
    ? 'undo-terminal-unavailable'
    : code === 'UNDO_STALE' || code === 'UNDO_PREVIEW_REQUIRED'
      ? 'undo-stale'
      : 'undo-unavailable'
}

function settleUndoStateAfterCommittedSync(
  availability: UndoAvailability,
  completedRecordId: string,
  outcome: 'success' | 'consumed' | 'superseded' | 'terminal-unavailable',
): void {
  setUndoAvailability(availability)

  // The outcome belongs to the submitted record. It may decorate the
  // announcement, but it cannot override a newer authoritative target. Keep
  // the success presentation only when the fresh read proves that the same
  // submitted record is the current consumed record.
  if (outcome === 'success' || outcome === 'consumed') {
    const isCurrentConsumedRecord = availability.state === 'consumed'
      && availability.recordId === completedRecordId
      && availability.reasonCode === 'UNDO_ALREADY_APPLIED'
    if (isCurrentConsumedRecord) undoState.value = 'undo-success'
  }
}

async function refreshUndoAuthoritativeState(): Promise<void> {
  const run = ++undoRefreshRun
  const [tagsResult, undoResult] = await Promise.allSettled([
    listManagedTags(),
    getUndoAvailability(),
  ])
  if (run !== undoRefreshRun || !isMounted.value) return
  if (tagsResult.status === 'fulfilled') {
    managedTags.value = tagsResult.value
    finalTags.value = tagsResult.value
    selectInitialSource(tagsResult.value, props.selectedTag)
    reconcileDestinationWithTags(tagsResult.value)
  }
  if (undoResult.status === 'fulfilled') {
    setUndoAvailability(undoResult.value)
  } else {
    setUndoUnavailable(undoResult.reason)
  }
}

function mapUndoError(error: unknown): string {
  const code = error instanceof TagUndoApiError ? error.code : 'CLIENT_PROTOCOL_ERROR'
  if (code === 'UNDO_CONFLICT'
    || code === 'UNDO_STABLE_ID_CONFLICT'
    || code === 'UNDO_IDENTITY_CONFLICT'
    || code === 'UNDO_DOCUMENT_MISSING'
    || code === 'UNDO_ASSOCIATION_CONFLICT') {
    return t('tags.manage.undo_conflict')
  }
  if (code === 'UNDO_STALE' || code === 'UNDO_PREVIEW_REQUIRED') return t('tags.manage.undo_stale')
  if (code === 'UNDO_SUPERSEDED') return t('tags.manage.undo_superseded')
  if (code === 'UNDO_ALREADY_APPLIED') return t('tags.manage.undo_consumed')
  if (code === 'UNDO_RECORD_CORRUPT') return t('tags.manage.undo_terminal')
  if (code === 'TAG_MANAGEMENT_UNAVAILABLE' || code === 'UNDO_UNAVAILABLE') return t('tags.manage.undo_unavailable')
  return t('tags.manage.undo_sync_pending')
}

function warningLabel(warning: UndoWarningCode): string {
  if (warning === 'DESTRUCTIVE') return t('tags.manage.undo_warning_destructive')
  if (warning === 'HIGH_IMPACT') return t('tags.manage.undo_warning_high_impact')
  return t('tags.manage.undo_warning_dynamic_conflict')
}

function operationsEqual(left: TagOperationRequest, right: TagOperationRequest): boolean {
  if (left.kind !== right.kind || left.sourceTagId !== right.sourceTagId) return false
  if (left.kind === 'rename' && right.kind === 'rename') return left.destinationName === right.destinationName
  if (left.kind === 'merge' && right.kind === 'merge') return left.destinationTagId === right.destinationTagId
  return left.kind === 'remove' && right.kind === 'remove'
}

function invalidatePreview(nextState: ManagerState = 'editing'): void {
  previewRun += 1
  clearPreview()
  if (state.value !== 'applying' && state.value !== 'syncing' && state.value !== 'sync-pending') {
    state.value = nextState
  }
}

function focusDestination(): void {
  void nextTick(() => {
    if (operationKind.value === 'merge') destinationSelectRef.value?.focus()
    else destinationInputRef.value?.focus()
  })
}

function validateForm(): boolean {
  sourceError.value = ''
  destinationError.value = ''
  errorMessage.value = ''
  if (selectedSourceTag.value === null) {
    sourceError.value = t('tags.manage.source_required')
    void nextTick(() => sourceSelectRef.value?.focus())
    return false
  }
  if (operationKind.value === 'merge') {
    if (!hasValidMergeDestination.value) {
      destinationError.value = sourceTagId.value === destinationTagId.value
        ? t('tags.manage.merge_same_tag')
        : t('tags.manage.destination_required_merge')
      focusDestination()
      return false
    }
    return true
  }
  if (operationKind.value === 'remove') return true
  const value = destinationName.value
  if (!value.trim()) {
    destinationError.value = t('tags.manage.destination_required')
    focusDestination()
    return false
  }
  if (value.length > 100) {
    destinationError.value = t('tags.manage.destination_too_long')
    focusDestination()
    return false
  }
  return true
}

function operationFromForm(): TagOperationRequest | null {
  const source = sourceTagId.value
  if (source === null || selectedSourceTag.value === null) return null
  if (operationKind.value === 'merge') {
    const destination = destinationTagId.value
    if (!hasValidMergeDestination.value || destination === null) return null
    return {
      kind: 'merge',
      sourceTagId: source,
      destinationTagId: destination,
    }
  }
  if (operationKind.value === 'remove') {
    return {
      kind: 'remove',
      sourceTagId: source,
    }
  }
  return {
    kind: 'rename',
    sourceTagId: source,
    destinationName: destinationName.value,
  }
}

function isHealthBlocked(code: TagManagementClientErrorCode): boolean {
  return code === 'TAG_MANAGEMENT_UNAVAILABLE' || code === 'TAG_IDENTITY_CONFLICT'
}

function mapError(error: unknown, stage: 'preview' | 'apply' | 'load'): string {
  const code = error instanceof TagManagementApiError ? error.code : 'CLIENT_PROTOCOL_ERROR'
  diagnosticCode.value = code
  if (code === 'TAG_MANAGEMENT_UNAVAILABLE') return t('tags.manage.error_unavailable')
  if (code === 'TAG_IDENTITY_CONFLICT') return t('tags.manage.error_identity_conflict')
  if (code === 'TAG_NOT_FOUND') return t('tags.manage.error_not_found')
  if (code === 'DESTINATION_EXISTS') {
    return operationKind.value === 'merge'
      ? t('tags.manage.conflict_generic')
      : t('tags.manage.conflict_destination_exists')
  }
  if (code === 'INVALID_OPERATION' || code === 'SOURCE_DESTINATION_SAME') {
    return stage === 'preview' ? t('tags.manage.conflict_generic') : t('tags.manage.error_generic')
  }
  if (code === 'INVALID_TAG_NAME') return t('tags.manage.destination_invalid')
  if (code === 'PREVIEW_STALE' || code === 'PREVIEW_REQUIRED') return t('tags.manage.preview_stale')
  if (code === 'TRANSACTION_FAILED') return t('tags.manage.error_transaction')
  if (stage === 'load') return t('tags.manage.error_unavailable')
  return stage === 'preview' ? t('tags.manage.preview_failed') : t('tags.manage.error_generic')
}

function selectInitialSource(tags: ManagedTag[], selectedTag = props.selectedTag): void {
  const fromSelected = resolveManagedTagId(selectedTag, tags)
  if (fromSelected !== null) {
    sourceTagId.value = fromSelected
    return
  }
  if (sourceTagId.value !== null && tags.some((tag) => tag.id === sourceTagId.value)) return
  sourceTagId.value = null
}

function reconcileDestinationWithTags(tags: ManagedTag[]): void {
  if (destinationTagId.value === null) return
  if (!tags.some((tag) => tag.id === destinationTagId.value && tag.id !== sourceTagId.value)) {
    destinationTagId.value = null
    destinationError.value = ''
  }
}

async function fetchManagedTagsForOpening(): Promise<void> {
  const run = ++loadRun
  state.value = 'loading'
  setDiagnostic('loading')
  errorMessage.value = ''
  staleMessage.value = ''
  announce(t('tags.manage.loading'))
  const [tagsResult, undoResult] = await Promise.allSettled([
    listManagedTags(),
    getUndoAvailability(),
  ])
  if (run !== loadRun || !isMounted.value) return

  if (tagsResult.status === 'rejected') {
    const error = tagsResult.reason
    const code = error instanceof TagManagementApiError ? error.code : 'CLIENT_PROTOCOL_ERROR'
    state.value = isHealthBlocked(code) ? 'unavailable' : 'error'
    setDiagnostic(isHealthBlocked(code) ? 'unavailable' : 'load-failure', code)
    errorMessage.value = mapError(error, 'load')
    announce(errorMessage.value)
    await nextTick()
    panelRef.value?.querySelector<HTMLButtonElement>('[data-action="reload"]')?.focus()
    return
  }

  const tags = tagsResult.value
  managedTags.value = tags
  finalTags.value = tags
  selectInitialSource(tags)
  reconcileDestinationWithTags(tags)
  if (undoResult.status === 'fulfilled') {
    setUndoAvailability(undoResult.value)
  } else {
    setUndoUnavailable(undoResult.reason)
  }
  state.value = 'ready'
  setDiagnostic('ready')
  announce(t('tags.manage.preview_required'))
  await nextTick()
  sourceSelectRef.value?.focus()
}

/** Recover a missing stable source without reusing a stale Preview. */
async function refreshManagedTagsAfterTagNotFound(): Promise<void> {
  const run = ++loadRun
  ++previewRun
  clearPreview()
  state.value = 'loading'
  setDiagnostic('loading', 'TAG_NOT_FOUND')
  staleMessage.value = ''
  errorMessage.value = t('tags.manage.error_not_found')
  announce(errorMessage.value)
  try {
    const tags = await listManagedTags()
    if (run !== loadRun || !isMounted.value) return
    managedTags.value = tags
    finalTags.value = tags
    if (sourceTagId.value !== null && !tags.some((tag) => tag.id === sourceTagId.value)) {
      sourceTagId.value = null
      sourceError.value = ''
    }
    reconcileDestinationWithTags(tags)
    state.value = 'editing'
    setDiagnostic('ready', 'TAG_NOT_FOUND')
    errorMessage.value = t('tags.manage.error_not_found')
    announce(errorMessage.value)
    await nextTick()
    if (sourceTagId.value === null) sourceSelectRef.value?.focus()
  } catch (error) {
    if (run !== loadRun || !isMounted.value) return
    const code = error instanceof TagManagementApiError ? error.code : 'CLIENT_PROTOCOL_ERROR'
    state.value = isHealthBlocked(code) ? 'unavailable' : 'error'
    setDiagnostic(isHealthBlocked(code) ? 'unavailable' : 'load-failure', code)
    errorMessage.value = mapError(error, 'load')
    announce(errorMessage.value)
    await nextTick()
    panelRef.value?.querySelector<HTMLButtonElement>('[data-action="reload"]')?.focus()
  }
}

function resetForOpen(): void {
  state.value = 'loading'
  ++previewRun
  ++syncRun
  ++undoPreviewRun
  ++undoSyncRun
  ++undoRefreshRun
  clearPreview()
  clearUndoPreview()
  managedTags.value = []
  finalTags.value = []
  operationKind.value = 'rename'
  sourceTagId.value = null
  destinationName.value = ''
  tagSearch.value = ''
  destinationSearch.value = ''
  destinationTagId.value = null
  applyResult.value = null
  committedSourceDisplayName.value = null
  authoritativeRecoveryPending.value = false
  committedRecoveryOperation.value = null
  selectionSnapshot.value = null
  sourceError.value = ''
  destinationError.value = ''
  errorMessage.value = ''
  staleMessage.value = ''
  reconciledSelectedTag.value = null
  undoState.value = 'undo-unavailable'
  undoAvailability.value = null
  undoAvailabilityRevision += 1
  undoResult.value = null
  undoSelectionSnapshot.value = null
  undoRecoveryRecordId.value = null
  undoRecoveryPending.value = false
}

async function onPreview(): Promise<void> {
  if (!validateForm()) return
  const operation = operationFromForm()
  if (!operation || state.value === 'unavailable') return
  clearUndoPreview()
  if (undoAvailability.value) undoState.value = undoStateForAvailability(undoAvailability.value)
  const run = ++previewRun
  const revision = operationRevision
  clearPreview()
  applyResult.value = null
  committedSourceDisplayName.value = null
  authoritativeRecoveryPending.value = false
  committedRecoveryOperation.value = null
  errorMessage.value = ''
  staleMessage.value = ''
  state.value = 'previewing'
  setDiagnostic('preview-loading')
  announce(t('tags.manage.previewing'))
  try {
    const result = await previewTagOperation(operation)
    if (run !== previewRun || revision !== operationRevision || !isMounted.value) return
    preview.value = result
    reviewedOperation.value = result.operation
    continuationPages.value = [result.sample]
    nextAfterDocumentId.value = result.nextAfterDocumentId
    state.value = 'preview-ready'
    setDiagnostic('preview-ready')
    announce(t('tags.manage.preview_ready', { count: result.affectedCount }))
    await nextTick()
    previewHeadingRef.value?.focus()
  } catch (error) {
    if (run !== previewRun || revision !== operationRevision || !isMounted.value) return
    const code = error instanceof TagManagementApiError ? error.code : 'CLIENT_PROTOCOL_ERROR'
    if (code === 'TAG_NOT_FOUND') {
      await refreshManagedTagsAfterTagNotFound()
      return
    }
    errorMessage.value = mapError(error, 'preview')
    setDiagnostic(code === 'PREVIEW_STALE' ? 'preview-stale' : 'preview-failure', code)
    if (code === 'PREVIEW_STALE') {
      staleMessage.value = t('tags.manage.preview_stale')
      invalidatePreview('editing')
    } else if (isHealthBlocked(code)) {
      clearPreview()
      state.value = 'unavailable'
      setDiagnostic('unavailable', code)
    } else {
      state.value = 'error'
    }
    if (code === 'INVALID_TAG_NAME') focusDestination()
    announce(errorMessage.value)
  }
}

async function onUndoPreview(): Promise<void> {
  const availability = undoAvailability.value
  if (!undoCanDiscoverPreview.value || !availability?.recordId) return

  if (state.value === 'preview-ready') invalidatePreview('editing')
  clearUndoPreview()
  const run = ++undoPreviewRun
  const availabilityRevision = undoAvailabilityRevision
  const recordId = availability.recordId
  undoResult.value = null
  undoRecoveryRecordId.value = null
  undoRecoveryPending.value = false
  undoState.value = 'undo-previewing'
  setDiagnostic('undo-preview-loading')
  announce(t('tags.manage.undo_previewing'))

  try {
    const result = await previewUndo(recordId, 20)
    if (
      run !== undoPreviewRun
      || availabilityRevision !== undoAvailabilityRevision
      || !isMounted.value
      || undoAvailability.value?.recordId !== recordId
    ) return

    if (result.state !== 'available') {
      clearUndoPreview()
      if (result.state === 'superseded') {
        undoState.value = 'undo-superseded'
        setDiagnostic('undo-superseded', 'UNDO_SUPERSEDED')
        await refreshUndoAuthoritativeState()
        if (run !== undoPreviewRun || !isMounted.value) return
        announce(t('tags.manage.undo_superseded'))
        return
      }

      setUndoAvailability(result)
      announce(result.state === 'consumed'
        ? t('tags.manage.undo_consumed')
        : result.validation === 'stale'
          ? t('tags.manage.undo_stale')
          : result.validation === 'conflict'
            ? t('tags.manage.undo_conflict')
            : t('tags.manage.undo_terminal'))
      return
    }

    if (result.validation === 'temporary-unavailable') {
      setUndoAvailability(result, 'undo-unavailable')
      clearUndoPreview()
      announce(t('tags.manage.undo_unavailable'))
      return
    }

    undoAvailability.value = result
    undoPreview.value = result
    reviewedUndoPreview.value = result
    undoContinuationPages.value = [result.sample]
    undoNextCursor.value = result.nextCursor
    undoState.value = result.validation === 'safe' ? 'undo-preview-ready' : 'undo-conflict'
    setDiagnostic(result.validation === 'safe' ? 'undo-preview-ready' : 'undo-conflict')
    announce(t('tags.manage.undo_preview_ready'))
    await nextTick()
    undoPreviewHeadingRef.value?.focus()
  } catch (error) {
    if (run !== undoPreviewRun || availabilityRevision !== undoAvailabilityRevision || !isMounted.value) return
    const code = error instanceof TagUndoApiError ? error.code : 'CLIENT_PROTOCOL_ERROR'
    clearUndoPreview()
    if (code === 'UNDO_CONFLICT'
      || code === 'UNDO_STABLE_ID_CONFLICT'
      || code === 'UNDO_IDENTITY_CONFLICT'
      || code === 'UNDO_DOCUMENT_MISSING'
      || code === 'UNDO_ASSOCIATION_CONFLICT') {
      undoState.value = 'undo-conflict'
      setDiagnostic('undo-conflict', code)
    } else if (code === 'UNDO_STALE' || code === 'UNDO_PREVIEW_REQUIRED') {
      undoState.value = 'undo-stale'
      setDiagnostic('undo-stale', code)
    } else if (code === 'UNDO_SUPERSEDED') {
      undoState.value = 'undo-superseded'
      setDiagnostic('undo-superseded', code)
      await refreshUndoAuthoritativeState()
    } else if (code === 'UNDO_RECORD_CORRUPT') {
      undoState.value = 'undo-terminal-unavailable'
      setDiagnostic('undo-terminal', code)
    } else {
      const terminal = code === 'CLIENT_PROTOCOL_ERROR'
      setUndoUnavailable(error)
      setDiagnostic(terminal ? 'undo-terminal' : 'unavailable', code)
    }
    announce(mapUndoError(error))
  }
}

async function loadMoreUndo(): Promise<void> {
  const currentPreview = undoPreview.value
  const reviewed = reviewedUndoPreview.value
  const cursor = undoNextCursor.value
  if (!currentPreview || !reviewed || !cursor || undoPageLoading.value) return
  const recordId = currentPreview.recordId
  const fingerprint = currentPreview.undoFingerprint
  if (!recordId || !fingerprint) return

  const previewGeneration = undoPreviewRun
  const run = ++undoPageRun
  undoPageLoading.value = true
  setDiagnostic('undo-preview-loading')
  try {
    const page = await getUndoPreviewPage(recordId, fingerprint, cursor, 100)
    if (
      run !== undoPageRun
      || previewGeneration !== undoPreviewRun
      || !isMounted.value
      || reviewedUndoPreview.value !== reviewed
      || undoPreview.value !== currentPreview
      || undoNextCursor.value !== cursor
    ) return
    if (page.recordId !== recordId || page.undoFingerprint !== fingerprint) {
      throw new TagUndoApiError(t('tags.manage.undo_stale'), 409, 'UNDO_STALE')
    }
    if (page.validation !== 'safe' || !page.allowedToApply) {
      clearUndoPreview()
      undoState.value = page.validation === 'stale' ? 'undo-stale' : 'undo-conflict'
      setDiagnostic(page.validation === 'stale' ? 'undo-stale' : 'undo-conflict')
      announce(page.validation === 'stale' ? t('tags.manage.undo_stale') : t('tags.manage.undo_conflict'))
      return
    }
    undoContinuationPages.value.push(page.sample)
    undoNextCursor.value = page.nextCursor
    undoState.value = 'undo-preview-ready'
    setDiagnostic('undo-preview-ready')
  } catch (error) {
    if (run !== undoPageRun || previewGeneration !== undoPreviewRun || !isMounted.value) return
    const code = error instanceof TagUndoApiError ? error.code : 'CLIENT_PROTOCOL_ERROR'
    clearUndoPreview()
    if (code === 'UNDO_STALE' || code === 'UNDO_PREVIEW_REQUIRED') {
      undoState.value = 'undo-stale'
      setDiagnostic('undo-stale', code)
    } else if (code === 'UNDO_CONFLICT'
      || code === 'UNDO_STABLE_ID_CONFLICT'
      || code === 'UNDO_IDENTITY_CONFLICT'
      || code === 'UNDO_DOCUMENT_MISSING'
      || code === 'UNDO_ASSOCIATION_CONFLICT') {
      undoState.value = 'undo-conflict'
      setDiagnostic('undo-conflict', code)
    } else {
      undoState.value = 'undo-unavailable'
      setDiagnostic('unavailable', code)
    }
    announce(mapUndoError(error))
  } finally {
    if (run === undoPageRun) undoPageLoading.value = false
  }
}

async function loadMore(): Promise<void> {
  if (!preview.value || !reviewedOperation.value || !nextAfterDocumentId.value || pageLoading.value) return
  const fingerprint = preview.value.planFingerprint
  const cursor = nextAfterDocumentId.value
  const operation = reviewedOperation.value
  const previewGeneration = previewRun
  const run = ++pageRun
  pageLoading.value = true
  setDiagnostic('preview-page-loading')
  try {
    const page = await getTagOperationPreviewPage(operation, fingerprint, cursor, 100)
    if (
      run !== pageRun
      || previewGeneration !== previewRun
      || !isMounted.value
      || !preview.value
      || preview.value.planFingerprint !== fingerprint
      || reviewedOperation.value !== operation
      || nextAfterDocumentId.value !== cursor
    ) {
      // A page belonging to an obsolete Preview is intentionally ignored.
      // In particular, it must not turn a newer Preview into PREVIEW_STALE.
      return
    }
    if (page.planFingerprint !== fingerprint) {
      throw new TagManagementApiError(
        t('tags.manage.preview_stale'),
        409,
        'PREVIEW_STALE',
      )
    }
    continuationPages.value.push(page.sample)
    nextAfterDocumentId.value = page.nextAfterDocumentId
    setDiagnostic('preview-ready')
  } catch (error) {
    if (run !== pageRun || previewGeneration !== previewRun || !isMounted.value) return
    const code = error instanceof TagManagementApiError ? error.code : 'CLIENT_PROTOCOL_ERROR'
    if (code === 'PREVIEW_STALE') {
      staleMessage.value = t('tags.manage.preview_stale')
      errorMessage.value = staleMessage.value
      invalidatePreview('editing')
      setDiagnostic('preview-stale', code)
    } else if (code === 'TAG_NOT_FOUND') {
      await refreshManagedTagsAfterTagNotFound()
      return
    } else if (isHealthBlocked(code)) {
      clearPreview()
      state.value = 'unavailable'
      errorMessage.value = mapError(error, 'preview')
      setDiagnostic('unavailable', code)
    } else {
      errorMessage.value = mapError(error, 'preview')
      state.value = 'error'
      setDiagnostic('preview-failure', code)
    }
    announce(errorMessage.value)
  } finally {
    if (run === pageRun) pageLoading.value = false
  }
}

function isCurrentUndoConfirmation(context: UndoConfirmationContext): boolean {
  return ordinaryAllowsUndoInteraction.value
    && (undoState.value === 'undo-confirming' || undoState.value === 'undo-preview-ready')
    && undoPreview.value?.validation === 'safe'
    && undoPreview.value?.allowedToApply === true
    && reviewedUndoPreview.value === context.preview
    && undoPreview.value === context.preview
    && undoAvailability.value?.recordId === context.recordId
    && context.preview.undoFingerprint === context.undoFingerprint
}

async function requestUndoConfirmation(currentPreview: UndoPreview): Promise<void> {
  if (!undoCanApply.value || !currentPreview.recordId || !currentPreview.undoFingerprint) return
  const context: UndoConfirmationContext = {
    recordId: currentPreview.recordId,
    undoFingerprint: currentPreview.undoFingerprint,
    preview: reviewedUndoPreview.value ?? currentPreview,
  }
  undoConfirmation.value = context
  undoState.value = 'undo-confirming'
  const pending = confirmCancellable(
    t('tags.manage.undo_confirm_title', { operation: undoOperationLabel.value }),
    t('tags.manage.undo_confirm_detail', {
      count: currentPreview.affectedCount,
      adds: currentPreview.associationAdds,
      removes: currentPreview.associationRemoves,
    }),
    {
      cancelLabel: t('common.cancel'),
      confirmLabel: t('tags.manage.confirm_undo'),
      destructive: true,
    },
  )
  cancelUndoConfirmation = pending.cancel
  const confirmed = await pending.promise
  if (cancelUndoConfirmation === pending.cancel) cancelUndoConfirmation = null
  if (undoConfirmation.value?.undoFingerprint === context.undoFingerprint) {
    undoConfirmation.value = null
  }
  if (!confirmed) {
    if (reviewedUndoPreview.value === context.preview && isMounted.value) {
      undoState.value = 'undo-preview-ready'
      setDiagnostic('undo-preview-ready')
      announce(t('tags.manage.undo_preview_ready'))
      await nextTick()
      undoApplyButtonRef.value?.$el.focus()
    }
    return
  }
  if (!isCurrentUndoConfirmation(context)) {
    undoState.value = 'undo-stale'
    clearUndoPreview()
    setDiagnostic('undo-stale')
    announce(t('tags.manage.undo_stale'))
    return
  }
  await applyReviewedUndo(context.preview)
}

async function applyUndoErrorState(error: unknown): Promise<void> {
  const code = error instanceof TagUndoApiError ? error.code : 'CLIENT_PROTOCOL_ERROR'
  clearUndoPreview()
  if (code === 'UNDO_CONFLICT'
    || code === 'UNDO_STABLE_ID_CONFLICT'
    || code === 'UNDO_IDENTITY_CONFLICT'
    || code === 'UNDO_DOCUMENT_MISSING'
    || code === 'UNDO_ASSOCIATION_CONFLICT') {
    undoState.value = 'undo-conflict'
    setDiagnostic('undo-conflict', code)
  } else if (code === 'UNDO_STALE' || code === 'UNDO_PREVIEW_REQUIRED') {
    undoState.value = 'undo-stale'
    setDiagnostic('undo-stale', code)
  } else if (code === 'UNDO_SUPERSEDED') {
    undoState.value = 'undo-superseded'
    setDiagnostic('undo-superseded', code)
    await refreshUndoAuthoritativeState()
  } else if (code === 'UNDO_ALREADY_APPLIED') {
    undoState.value = 'undo-terminal-unavailable'
    setDiagnostic('undo-terminal', code)
    await refreshUndoAuthoritativeState()
  } else if (code === 'UNDO_RECORD_CORRUPT') {
    undoState.value = 'undo-terminal-unavailable'
    setDiagnostic('undo-terminal', code)
  } else if (code === 'UNDO_UNAVAILABLE' || code === 'TAG_MANAGEMENT_UNAVAILABLE') {
    undoState.value = 'undo-unavailable'
    setDiagnostic('unavailable', code)
  } else {
    undoState.value = 'undo-terminal-unavailable'
    setDiagnostic('undo-terminal', code)
  }
  announce(mapUndoError(error))
}

function applyUndoSynchronizationResult(synchronized: UndoSyncResult): void {
  finalTags.value = synchronized.managedTags
  managedTags.value = synchronized.managedTags
  reconciledSelectedTag.value = synchronized.selectedTag
}

async function runUndoSynchronization(
  result: UndoApplyResult,
  snapshot: TagSelectionSnapshot,
): Promise<void> {
  const run = undoSyncRun
  undoState.value = 'undo-committed-refreshing'
  setDiagnostic('undo-refreshing')
  announce(t('tags.manage.undo_committed_refreshing'))
  try {
    if (typeof props.syncAfterUndo !== 'function') throw new Error('Undo synchronization seam is unavailable')
    const synchronized = await props.syncAfterUndo(result, snapshot)
    if (run !== undoSyncRun || !isMounted.value) return
    applyUndoSynchronizationResult(synchronized)
    settleUndoStateAfterCommittedSync(synchronized.undoAvailability, result.undoRecordId, 'success')
    undoSelectionSnapshot.value = null
    undoRecoveryRecordId.value = null
    undoRecoveryPending.value = false
    setDiagnostic('undo-success')
    announce(t('tags.manage.undo_success'))
  } catch {
    if (run !== undoSyncRun || !isMounted.value) return
    undoState.value = 'undo-sync-pending'
    setDiagnostic('undo-pending')
    announce(t('tags.manage.undo_sync_pending'))
  }
}

async function recoverCommittedUndoReadOnly(): Promise<void> {
  const run = undoSyncRun
  const recordId = undoRecoveryRecordId.value
  const snapshot = undoSelectionSnapshot.value
  if (!recordId || !snapshot || typeof props.recoverCommittedUndo !== 'function') {
    undoState.value = 'undo-sync-pending'
    setDiagnostic('undo-pending', 'CLIENT_PROTOCOL_ERROR')
    announce(t('tags.manage.undo_sync_pending'))
    return
  }
  undoState.value = 'undo-committed-refreshing'
  setDiagnostic('undo-refreshing', 'CLIENT_PROTOCOL_ERROR')
  announce(t('tags.manage.undo_committed_refreshing'))
  try {
    const recovered = await props.recoverCommittedUndo(recordId, snapshot)
    if (run !== undoSyncRun || !isMounted.value) return
    finalTags.value = recovered.managedTags
    managedTags.value = recovered.managedTags
    reconciledSelectedTag.value = recovered.selectedTag
    settleUndoStateAfterCommittedSync(
      recovered.undoAvailability,
      recordId,
      recovered.outcome,
    )
    undoRecoveryPending.value = false
    undoRecoveryRecordId.value = null
    undoSelectionSnapshot.value = null
    if (recovered.outcome === 'consumed') {
      setDiagnostic('undo-success')
      announce(t('tags.manage.undo_success'))
    } else if (recovered.outcome === 'superseded') {
      setDiagnostic('undo-superseded')
      announce(t('tags.manage.undo_superseded'))
    } else {
      setDiagnostic('undo-terminal')
      announce(t('tags.manage.undo_terminal'))
    }
  } catch {
    if (run !== undoSyncRun || !isMounted.value) return
    undoState.value = 'undo-sync-pending'
    setDiagnostic('undo-pending', 'CLIENT_PROTOCOL_ERROR')
    announce(t('tags.manage.undo_sync_pending'))
  }
}

async function applyReviewedUndo(reviewed: UndoPreview): Promise<void> {
  const snapshot = captureTagSelection(
    props.selectedTag,
    managedTags.value,
    props.selectionEpoch,
  )
  undoSelectionSnapshot.value = snapshot
  undoRecoveryRecordId.value = null
  undoRecoveryPending.value = false
  const run = ++undoSyncRun
  invalidatePreview('editing')
  clearUndoPreview()
  undoState.value = 'undo-applying'
  setDiagnostic('undo-applying')
  announce(t('tags.manage.undo_applying'))

  let result: UndoApplyResult
  try {
    // The exact reviewed Preview is the sole Apply authority. No inverse
    // scope, document list, or replacement request is constructed here.
    result = await applyUndo(reviewed)
  } catch (error) {
    if (run !== undoSyncRun || !isMounted.value) return
    const typed = error instanceof TagUndoApiError ? error : null
    if (typed?.code === 'CLIENT_PROTOCOL_ERROR' && typed.recoveryRecordId) {
      undoRecoveryRecordId.value = typed.recoveryRecordId
      undoRecoveryPending.value = true
      undoState.value = 'undo-committed-refreshing'
      setDiagnostic('undo-refreshing', 'CLIENT_PROTOCOL_ERROR')
      announce(t('tags.manage.undo_committed_refreshing'))
      await recoverCommittedUndoReadOnly()
      return
    }
    await applyUndoErrorState(error)
    return
  }

  if (run !== undoSyncRun || !isMounted.value) return
  undoResult.value = result
  undoRecoveryPending.value = false
  undoState.value = 'undo-committed-refreshing'
  await runUndoSynchronization(result, snapshot)
}

async function onUndoApply(): Promise<void> {
  if (!undoCanApply.value || !reviewedUndoPreview.value) return
  await requestUndoConfirmation(reviewedUndoPreview.value)
}

async function retryUndoSynchronization(): Promise<void> {
  if (undoState.value !== 'undo-sync-pending') return
  ++undoSyncRun
  if (undoRecoveryPending.value) {
    await recoverCommittedUndoReadOnly()
    return
  }
  const result = undoResult.value
  const snapshot = undoSelectionSnapshot.value
  if (!result || !snapshot) return
  await runUndoSynchronization(result, snapshot)
}

async function runSynchronization(result: TagOperationApplyResult): Promise<void> {
  const run = syncRun
  state.value = 'syncing'
  setDiagnostic('syncing')
  announce(t('tags.manage.syncing'))
  try {
    const snapshot = selectionSnapshot.value
    if (!snapshot || typeof props.syncAfterCommit !== 'function') {
      // A missing ownership seam is a synchronization failure, never a
      // successful Apply. The committed result remains available for a
      // retry, but Apply is not repeated.
      state.value = 'sync-pending'
      setDiagnostic('sync-pending', 'CLIENT_PROTOCOL_ERROR')
      errorMessage.value = t('tags.manage.sync_pending')
      announce(errorMessage.value)
      return
    }
    const synchronized = await props.syncAfterCommit(result, snapshot)
    if (run !== syncRun || !isMounted.value) return
    finalTags.value = synchronized.managedTags
    managedTags.value = synchronized.managedTags
    reconciledSelectedTag.value = synchronized.selectedTag
    if (synchronized.undoAvailability) setUndoAvailability(synchronized.undoAvailability)
    state.value = 'success'
    setDiagnostic('success')
    announce(finalDisplayName.value
      ? result.operation.kind === 'remove'
        ? t('tags.manage.remove_success', { name: finalDisplayName.value })
        : t('tags.manage.success', { name: finalDisplayName.value })
      : t('tags.manage.success_generic'))
    emit('success', result)
  } catch (error) {
    if (run !== syncRun || !isMounted.value) return
    const code = error instanceof TagManagementApiError ? error.code : 'CLIENT_PROTOCOL_ERROR'
    state.value = 'sync-pending'
    setDiagnostic('sync-pending', code)
    errorMessage.value = t('tags.manage.sync_pending')
    announce(errorMessage.value)
  }
}

function isCurrentRemovalConfirmation(context: RemovalConfirmationContext): boolean {
  const currentOperation = operationFromForm()
  return canApply.value
    && preview.value?.planFingerprint === context.planFingerprint
    && reviewedOperation.value !== null
    && operationsEqual(reviewedOperation.value, context.operation)
    && currentOperation !== null
    && operationsEqual(currentOperation, context.operation)
}

async function requestRemovalConfirmation(
  currentPreview: TagOperationPreview,
  operation: TagOperationRequest,
): Promise<void> {
  const context: RemovalConfirmationContext = {
    operation,
    planFingerprint: currentPreview.planFingerprint,
    sourceDisplayName: currentPreview.sourceTag.displayName,
  }
  removalConfirmation.value = context
  const pending = confirmCancellable(
    t('tags.manage.remove_confirm_title', { name: context.sourceDisplayName }),
    t('tags.manage.remove_confirm_detail', { name: context.sourceDisplayName }),
    {
      cancelLabel: t('common.cancel'),
      confirmLabel: t('tags.manage.confirm_remove', { name: context.sourceDisplayName }),
      destructive: true,
    },
  )
  cancelRemovalConfirmation = pending.cancel
  const confirmed = await pending.promise
  if (cancelRemovalConfirmation === pending.cancel) cancelRemovalConfirmation = null
  if (removalConfirmation.value?.planFingerprint === context.planFingerprint) {
    removalConfirmation.value = null
  }
  if (!confirmed) {
    announce(t('tags.manage.remove_cancelled'))
    return
  }
  if (!isCurrentRemovalConfirmation(context)) {
    announce(t('tags.manage.preview_required'))
    return
  }
  await applyReviewedPreview(currentPreview, operation)
}

async function recoverCommittedProtocolMismatch(): Promise<void> {
  const run = syncRun
  state.value = 'syncing'
  setDiagnostic('syncing', 'CLIENT_PROTOCOL_ERROR')
  announce(t('tags.manage.syncing'))
  try {
    const operation = committedRecoveryOperation.value
    const snapshot = selectionSnapshot.value
    if (!operation || !snapshot || typeof props.recoverCommittedOperation !== 'function') {
      throw new Error('committed tag recovery seam is unavailable')
    }
    const synchronized = await props.recoverCommittedOperation(operation, snapshot)
    if (run !== syncRun || !isMounted.value) return
    managedTags.value = synchronized.managedTags
    finalTags.value = synchronized.managedTags
    reconciledSelectedTag.value = synchronized.selectedTag
    if (synchronized.undoAvailability) setUndoAvailability(synchronized.undoAvailability)
    selectInitialSource(synchronized.managedTags, synchronized.selectedTag)
    reconcileDestinationWithTags(synchronized.managedTags)
    applyResult.value = null
    selectionSnapshot.value = null
    committedRecoveryOperation.value = null
    authoritativeRecoveryPending.value = false
    state.value = 'editing'
    setDiagnostic('ready', 'CLIENT_PROTOCOL_ERROR')
    errorMessage.value = t('tags.manage.committed_protocol_mismatch')
    announce(errorMessage.value)
  } catch {
    if (run !== syncRun || !isMounted.value) return
    state.value = 'sync-pending'
    setDiagnostic('sync-pending', 'CLIENT_PROTOCOL_ERROR')
    errorMessage.value = t('tags.manage.committed_protocol_mismatch')
    announce(errorMessage.value)
  }
}

async function onApply(): Promise<void> {
  if (!canApply.value || !preview.value || !reviewedOperation.value) return
  const currentPreview = preview.value
  const operation = reviewedOperation.value
  if (operation.kind === 'remove') {
    if (removalConfirmation.value) return
    await requestRemovalConfirmation(currentPreview, operation)
    return
  }
  await applyReviewedPreview(currentPreview, operation)
}

async function applyReviewedPreview(
  currentPreview: TagOperationPreview,
  operation: TagOperationRequest,
): Promise<void> {
  // Any successful ordinary Apply supersedes the previously reviewed Undo
  // target once VaultView confirms the authoritative cycle. Clear the
  // ephemeral client review now so it can never be applied against the new
  // ordinary operation.
  clearUndoPreview()
  selectionSnapshot.value = captureTagSelection(
    props.selectedTag,
    managedTags.value,
    props.selectionEpoch,
  )
  committedSourceDisplayName.value = currentPreview.sourceTag.displayName
  const run = ++syncRun
  errorMessage.value = ''
  staleMessage.value = ''
  state.value = 'applying'
  setDiagnostic('applying')
  announce(t('tags.manage.applying'))
  let result: TagOperationApplyResult
  try {
    result = await applyTagOperation(operation, currentPreview.planFingerprint)
  } catch (error) {
    if (run !== syncRun || !isMounted.value) return
    const code = error instanceof TagManagementApiError ? error.code : 'CLIENT_PROTOCOL_ERROR'
    if (code === 'PREVIEW_STALE' || code === 'PREVIEW_REQUIRED') {
      staleMessage.value = t('tags.manage.preview_stale')
      errorMessage.value = staleMessage.value
      invalidatePreview('editing')
      setDiagnostic('preview-stale', code)
      announce(errorMessage.value)
      return
    }
    if (code === 'TAG_NOT_FOUND') {
      await refreshManagedTagsAfterTagNotFound()
      return
    }
    clearPreview()
    state.value = isHealthBlocked(code) ? 'unavailable' : 'error'
    errorMessage.value = mapError(error, 'apply')
    setDiagnostic(isHealthBlocked(code) ? 'unavailable' : 'apply-failure', code)
    if (code === 'INVALID_TAG_NAME') focusDestination()
    announce(errorMessage.value)
    return
  }

  if (run !== syncRun || !isMounted.value) return
  applyResult.value = result

  try {
    assertApplyResultMatchesReviewedPreview(result, currentPreview)
  } catch {
    // The successful response proves that the mutation committed. Its
    // contradictory fields cannot be used for reconciliation, so retain
    // only enough committed context for safe VaultView-owned recovery.
    authoritativeRecoveryPending.value = true
    committedRecoveryOperation.value = operation
    clearPreview()
    state.value = 'sync-pending'
    setDiagnostic('sync-pending', 'CLIENT_PROTOCOL_ERROR')
    errorMessage.value = t('tags.manage.committed_protocol_mismatch')
    announce(errorMessage.value)
    return
  }

  authoritativeRecoveryPending.value = false
  clearPreview()
  await runSynchronization(result)
}

async function retrySynchronization(): Promise<void> {
  if (state.value !== 'sync-pending') return
  ++syncRun
  if (authoritativeRecoveryPending.value) {
    await recoverCommittedProtocolMismatch()
    return
  }
  if (!applyResult.value) return
  await runSynchronization(applyResult.value)
}

async function reloadManagedTags(): Promise<void> {
  ++previewRun
  ++undoPreviewRun
  clearPreview()
  clearUndoPreview()
  applyResult.value = null
  committedSourceDisplayName.value = null
  authoritativeRecoveryPending.value = false
  committedRecoveryOperation.value = null
  destinationTagId.value = null
  destinationError.value = ''
  await fetchManagedTagsForOpening()
}

function onSourceChange(value: string | number | null): void {
  sourceTagId.value = value === '' || value === null ? null : Number(value)
  if (sourceTagId.value !== null && sourceTagId.value === destinationTagId.value) {
    destinationTagId.value = null
  }
}

function onDestinationChange(value: string | number | null): void {
  destinationTagId.value = value === '' || value === null ? null : Number(value)
}

function setOperationKind(kind: VisibleOperationKind): void {
  if (operationKind.value === kind) return
  operationKind.value = kind
  destinationTagId.value = null
  destinationSearch.value = ''
  operationRevision += 1
  invalidatePreview('editing')
  clearUndoPreview()
  if (undoAvailability.value) undoState.value = undoStateForAvailability(undoAvailability.value)
  sourceError.value = ''
  destinationError.value = ''
  announce(
    kind === 'merge'
      ? t('tags.manage.merge_selected')
      : kind === 'remove'
        ? t('tags.manage.remove_selected')
        : t('tags.manage.rename_selected'),
  )
}

watch([operationKind, sourceTagId, destinationTagId, destinationName], (next, previous) => {
  if (next.every((value, index) => value === previous[index])) return
  operationRevision += 1
  sourceError.value = ''
  destinationError.value = ''
  if (undoPreview.value || reviewedUndoPreview.value || undoState.value === 'undo-previewing') {
    clearUndoPreview()
    if (undoAvailability.value) undoState.value = undoStateForAvailability(undoAvailability.value)
  }
  if (state.value === 'preview-ready' || state.value === 'previewing' || state.value === 'error') {
    invalidatePreview('editing')
  }
  if (state.value === 'success') state.value = 'editing'
})

onMounted(() => {
  isMounted.value = true
  resetForOpen()
  void fetchManagedTagsForOpening()
})

onBeforeUnmount(() => {
  isMounted.value = false
  ++loadRun
  ++previewRun
  ++syncRun
  ++pageRun
  ++undoPreviewRun
  ++undoSyncRun
  ++undoPageRun
  ++undoRefreshRun
  cancelPendingRemovalConfirmation()
  cancelPendingUndoConfirmation()
  clearPreview()
  clearUndoPreview()
})
</script>

<template>
  <section
    ref="panelRef"
    class="tag-management-panel"
    data-tag-management-panel
    aria-labelledby="settings-tags-title"
    :aria-label="t('settings.tags')"
    :data-state="state"
    :data-can-leave="canLeave"
    :data-undo-state="undoState"
    :data-diagnostic-stage="diagnosticStage"
    :data-diagnostic-code="diagnosticCode ?? undefined"
  >
    <div class="tag-management-body">
          <p class="tag-management-live" role="status" aria-live="polite">{{ liveMessage }}</p>

          <div v-if="state === 'loading'" class="tag-management-state" aria-busy="true">
            {{ t('tags.manage.loading') }}
          </div>

          <div v-else-if="state === 'unavailable'" class="tag-management-state tag-management-state-error">
            <p>{{ t('tags.manage.unavailable') }}</p>
            <NButton attr-type="button" :bordered="false" data-action="reload" class="tag-management-button primary" @click="reloadManagedTags">
              {{ t('tags.manage.reload') }}
            </NButton>
          </div>

          <template v-else>
            <section
              v-if="undoAvailability?.state === 'available' && undoAvailability.validation !== 'temporary-unavailable'"
              class="tag-management-undo-last-change"
              data-undo-last-change
              aria-labelledby="tag-management-undo-last-change-title"
            >
              <div class="tag-management-undo-section-heading">
                <h3 id="tag-management-undo-last-change-title">{{ t('tags.manage.last_change') }}</h3>
                <span class="tag-management-undo-operation-label">{{ undoOperationLabel }}</span>
              </div>
              <dl class="tag-management-undo-summary">
                <div><dt>{{ t('tags.manage.undo_original_operation') }}</dt><dd>{{ undoOperationLabel }}</dd></div>
                <div><dt>{{ t('tags.manage.undo_commit_time') }}</dt><dd>{{ undoCommitTime }}</dd></div>
                <div><dt>{{ t('tags.manage.undo_source_before') }}</dt><dd>#{{ undoAvailability.sourceBefore?.displayName }}</dd></div>
                <div><dt>{{ t('tags.manage.undo_source_after') }}</dt><dd>{{ undoAvailability.sourceAfter ? `#${undoAvailability.sourceAfter.displayName}` : '—' }}</dd></div>
                <div v-if="undoAvailability.kind === 'merge'"><dt>{{ t('tags.manage.undo_destination') }}</dt><dd>#{{ undoAvailability.destinationAfter?.displayName }}</dd></div>
                <div><dt>{{ t('tags.manage.undo_affected_documents') }}</dt><dd>{{ undoAvailability.affectedCount }}</dd></div>
                <div><dt>{{ t('tags.manage.undo_association_adds') }}</dt><dd>{{ undoAvailability.associationAdds }}</dd></div>
                <div><dt>{{ t('tags.manage.undo_association_removes') }}</dt><dd>{{ undoAvailability.associationRemoves }}</dd></div>
                <div><dt>{{ t('tags.manage.undo_version_updates') }}</dt><dd>{{ undoAvailability.versionUpdateCount }}</dd></div>
              </dl>
              <p v-if="undoAvailability.kind === 'merge' || undoAvailability.kind === 'remove'" class="tag-management-undo-note">
                {{ t('tags.manage.undo_stable_id_restored') }}
              </p>
              <div class="tag-management-actions">
                <NButton
                  v-if="undoCanDiscoverPreview"
                  attr-type="button"
                  :bordered="false"
                  class="tag-management-button secondary"
                  data-action="undo-preview"
                  :disabled="undoState === 'undo-previewing'"
                  @click="onUndoPreview"
                >{{ t('tags.manage.undo_preview') }}</NButton>
              </div>
            </section>

            <section v-if="undoState === 'undo-unavailable' && !undoAvailability" class="tag-management-undo-state" role="status">
              {{ t('tags.manage.undo_unavailable') }}
            </section>
            <section v-else-if="undoState === 'undo-conflict'" class="tag-management-undo-state tag-management-conflict" role="alert">
              {{ t('tags.manage.undo_conflict') }}
              <NButton v-if="undoCanDiscoverPreview" attr-type="button" :bordered="false" class="tag-management-button secondary" data-action="undo-preview" @click="onUndoPreview">
                {{ t('tags.manage.undo_preview') }}
              </NButton>
            </section>
            <section v-else-if="undoState === 'undo-stale'" class="tag-management-undo-state tag-management-conflict" role="alert">
              {{ t('tags.manage.undo_stale') }}
              <NButton v-if="undoCanDiscoverPreview" attr-type="button" :bordered="false" class="tag-management-button secondary" data-action="undo-preview" @click="onUndoPreview">
                {{ t('tags.manage.undo_preview') }}
              </NButton>
            </section>
            <section v-else-if="undoState === 'undo-superseded'" class="tag-management-undo-state" role="status">
              {{ t('tags.manage.undo_superseded') }}
            </section>
            <section v-else-if="undoState === 'undo-terminal-unavailable'" class="tag-management-undo-state tag-management-state-error" role="alert">
              {{ undoAvailability?.state === 'consumed' ? t('tags.manage.undo_consumed') : t('tags.manage.undo_terminal') }}
            </section>
            <section v-if="undoState === 'undo-previewing'" class="tag-management-undo-state" aria-busy="true" role="status">
              {{ t('tags.manage.undo_previewing') }}
            </section>

            <section
              v-if="undoPreview"
              class="tag-management-undo-preview"
              data-undo-preview
              :aria-busy="undoState === 'undo-previewing'"
              aria-live="polite"
              aria-labelledby="tag-management-undo-preview-title"
            >
              <h3 ref="undoPreviewHeadingRef" id="tag-management-undo-preview-title" tabindex="-1">
                {{ t('tags.manage.undo_preview_ready') }}
              </h3>
              <dl class="tag-management-summary">
                <div><dt>{{ t('tags.manage.undo_original_operation') }}</dt><dd>{{ undoOperationLabel }}</dd></div>
                <div><dt>{{ t('tags.manage.undo_commit_time') }}</dt><dd>{{ undoCommitTime }}</dd></div>
                <div><dt>{{ t('tags.manage.undo_source_before') }}</dt><dd>#{{ undoPreview.sourceBefore?.displayName }}</dd></div>
                <div><dt>{{ t('tags.manage.undo_source_after') }}</dt><dd>{{ undoPreview.sourceAfter ? `#${undoPreview.sourceAfter.displayName}` : '—' }}</dd></div>
                <div v-if="undoPreview.kind === 'merge'"><dt>{{ t('tags.manage.undo_destination') }}</dt><dd>#{{ undoPreview.destinationAfter?.displayName }}</dd></div>
                <div><dt>{{ t('tags.manage.undo_affected_documents') }}</dt><dd>{{ undoPreview.affectedCount }}</dd></div>
                <div><dt>{{ t('tags.manage.undo_association_adds') }}</dt><dd>{{ undoPreview.associationAdds }}</dd></div>
                <div><dt>{{ t('tags.manage.undo_association_removes') }}</dt><dd>{{ undoPreview.associationRemoves }}</dd></div>
                <div><dt>{{ t('tags.manage.undo_version_updates') }}</dt><dd>{{ undoPreview.versionUpdateCount }}</dd></div>
              </dl>
              <p v-if="undoPreview.kind === 'merge' || undoPreview.kind === 'remove'" class="tag-management-undo-note">
                {{ t('tags.manage.undo_stable_id_restored') }}
              </p>
              <div v-if="undoPreview.warnings.length" class="tag-management-warnings">
                <h4>{{ t('tags.manage.warnings') }}</h4>
                <ul>
                  <li v-for="warning in undoPreview.warnings" :key="warning">{{ warningLabel(warning) }}</li>
                </ul>
              </div>
              <div id="tag-management-undo-preservation" class="tag-management-undo-preservation">
                <strong>{{ t('tags.manage.undo_no_file_rollback') }}</strong>
                <span>{{ t('tags.manage.undo_preserved_documents') }}</span>
                <span>{{ t('tags.manage.undo_preserved_git') }}</span>
                <span>{{ t('tags.manage.undo_preserved_unrelated') }}</span>
              </div>
              <div class="tag-management-sample">
                <h4>{{ t('tags.manage.undo_sample') }}</h4>
                <ul v-if="renderedUndoSample.length">
                  <li v-for="document in renderedUndoSample" :key="document.id">
                    <strong>{{ document.title || document.path }}</strong>
                    <span>{{ document.path }}</span>
                  </li>
                </ul>
                <p v-else>{{ t('tags.manage.sample_empty') }}</p>
                <NButton
                  v-if="undoNextCursor"
                  attr-type="button"
                  :bordered="false"
                  class="tag-management-button secondary"
                  data-action="undo-load-more"
                  :disabled="undoPageLoading"
                  @click="loadMoreUndo"
                >{{ undoPageLoading ? t('tags.manage.loading_more') : t('tags.manage.load_more') }}</NButton>
              </div>
              <p v-if="undoState === 'undo-conflict'" class="tag-management-conflict" role="alert">{{ t('tags.manage.undo_conflict') }}</p>
              <div class="tag-management-actions">
                <NButton
                  ref="undoApplyButtonRef"
                  attr-type="button"
                  :bordered="false"
                  class="tag-management-button primary destructive"
                  data-action="undo-apply"
                  aria-describedby="tag-management-undo-preservation"
                  :disabled="!undoCanApply"
                  @click="onUndoApply"
                >{{ undoState === 'undo-confirming' || undoState === 'undo-applying' ? t('tags.manage.undo_applying') : t('tags.manage.undo_apply') }}</NButton>
              </div>
            </section>

            <section v-if="undoState === 'undo-confirming'" class="tag-management-undo-state" role="status">
              {{ t('tags.manage.undo_preview_ready') }}
            </section>
            <section v-else-if="undoState === 'undo-applying' || undoState === 'undo-committed-refreshing'" class="tag-management-undo-state" aria-busy="true" role="status">
              {{ undoState === 'undo-applying' ? t('tags.manage.undo_applying') : t('tags.manage.undo_committed_refreshing') }}
            </section>
            <section v-else-if="undoState === 'undo-sync-pending'" class="tag-management-undo-state tag-management-state-error" role="alert">
              <p>{{ t('tags.manage.undo_sync_pending') }}</p>
              <NButton attr-type="button" :bordered="false" class="tag-management-button primary" data-action="undo-retry-sync" @click="retryUndoSynchronization">
                {{ t('tags.manage.undo_retry_sync') }}
              </NButton>
            </section>
            <section
              v-else-if="undoState === 'undo-success'"
              class="tag-management-undo-state tag-management-state-success"
              role="status"
              :data-selected-tag="reconciledSelectedTag ?? undefined"
            >
              {{ t('tags.manage.undo_success') }}
            </section>

            <form class="tag-management-form" @submit.prevent="onPreview">
              <fieldset class="tag-management-mode" :disabled="!canEdit">
                <legend>{{ t('tags.manage.operation') }}</legend>
                <div class="tag-management-mode-buttons" role="group" :aria-label="t('tags.manage.operation')">
                  <NButton
                    attr-type="button"
                    :bordered="false"
                    class="tag-management-mode-button"
                    data-operation="rename"
                    :aria-pressed="operationKind === 'rename'"
                    @click="setOperationKind('rename')"
                  >{{ t('tags.manage.rename') }}</NButton>
                  <NButton
                    attr-type="button"
                    :bordered="false"
                    class="tag-management-mode-button"
                    data-operation="merge"
                    :aria-pressed="operationKind === 'merge'"
                    @click="setOperationKind('merge')"
                  >{{ t('tags.manage.merge') }}</NButton>
                  <NButton
                    attr-type="button"
                    :bordered="false"
                    class="tag-management-mode-button"
                    data-operation="remove"
                    :aria-pressed="operationKind === 'remove'"
                    @click="setOperationKind('remove')"
                  >{{ t('tags.manage.remove') }}</NButton>
                </div>
              </fieldset>

              <div class="tag-management-field">
                <label for="tag-management-search">{{ t('tags.manage.search') }}</label>
                <NInput
                  v-model:value="tagSearch"
                  class="tag-management-input-control"
                  size="medium"
                  :placeholder="t('tags.manage.search')"
                  :disabled="!canEdit"
                  :input-props="{ id: 'tag-management-search', class: 'tag-management-input', type: 'search', 'aria-label': t('tags.manage.search') }"
                />
              </div>

              <div class="tag-management-field">
                <label for="tag-management-source">{{ t('tags.manage.source') }}</label>
                <NSelect
                  ref="sourceSelectRef"
                  id="tag-management-source"
                  class="tag-management-input-control"
                  size="medium"
                  :bordered="false"
                  :value="sourceTagId === null ? null : String(sourceTagId)"
                  :options="sourceOptions"
                  :to="false"
                  :menu-props="tagSelectMenuProps"
                  :node-props="tagSelectNodeProps"
                  :disabled="!canEdit || managedTags.length === 0"
                  :aria-invalid="sourceError ? 'true' : undefined"
                  :aria-describedby="sourceError ? 'tag-management-source-error' : undefined"
                  :aria-label="t('tags.manage.source')"
                  @update:value="onSourceChange"
                />
                <p v-if="sourceError" id="tag-management-source-error" class="tag-management-error" role="alert">{{ sourceError }}</p>
              </div>

              <template v-if="operationKind === 'merge'">
                <div class="tag-management-field">
                  <label for="tag-management-destination-search">{{ t('tags.manage.destination_search') }}</label>
                  <NInput
                    v-model:value="destinationSearch"
                    class="tag-management-input-control"
                    size="medium"
                    :placeholder="t('tags.manage.destination_search_placeholder')"
                    :disabled="!canEdit"
                    :input-props="{ id: 'tag-management-destination-search', class: 'tag-management-input', type: 'search', 'aria-label': t('tags.manage.destination_search') }"
                    @update:value="destinationError = ''"
                  />
                </div>

                <div class="tag-management-field">
                  <label for="tag-management-destination">{{ t('tags.manage.destination_tag') }}</label>
                  <NSelect
                    ref="destinationSelectRef"
                    id="tag-management-destination"
                    class="tag-management-input-control"
                    size="medium"
                    :bordered="false"
                    :value="destinationTagId === null ? null : String(destinationTagId)"
                    :options="destinationOptions"
                    :to="false"
                    :menu-props="tagSelectMenuProps"
                    :node-props="tagSelectNodeProps"
                    :disabled="!canEdit || managedTags.length === 0"
                    :aria-invalid="destinationError ? 'true' : undefined"
                    :aria-describedby="destinationError ? 'tag-management-destination-error tag-management-destination-help' : 'tag-management-destination-help'"
                    :aria-label="t('tags.manage.destination_tag')"
                    @update:value="onDestinationChange"
                  />
                  <p id="tag-management-destination-help" class="tag-management-help">{{ t('tags.manage.destination_help_merge') }}</p>
                  <p v-if="selectedDestinationTag" class="tag-management-selected" data-selected-destination>
                    {{ t('tags.manage.destination_selected', { name: selectedDestinationTag.displayName }) }}
                  </p>
                  <p v-if="destinationSearch.trim() && filteredDestinationTags.length === 0" class="tag-management-help">
                    {{ t('tags.manage.destination_no_matches') }}
                  </p>
                  <p v-if="destinationError" id="tag-management-destination-error" class="tag-management-error" role="alert">{{ destinationError }}</p>
                </div>
              </template>

              <div v-else-if="operationKind === 'rename'" class="tag-management-field">
                <label for="tag-management-destination">{{ t('tags.manage.destination') }}</label>
                <NInput
                  ref="destinationInputRef"
                  v-model:value="destinationName"
                  class="tag-management-input-control"
                  size="medium"
                  type="text"
                  :disabled="!canEdit"
                  :input-props="{
                    id: 'tag-management-destination',
                    class: 'tag-management-input',
                    'aria-invalid': destinationError ? 'true' : undefined,
                    'aria-describedby': destinationError ? 'tag-management-destination-error tag-management-destination-help' : 'tag-management-destination-help',
                    'aria-label': t('tags.manage.destination'),
                  }"
                />
                <p id="tag-management-destination-help" class="tag-management-help">{{ t('tags.manage.destination_help') }}</p>
                <p v-if="destinationError" id="tag-management-destination-error" class="tag-management-error" role="alert">{{ destinationError }}</p>
              </div>

              <div class="tag-management-actions">
                <NButton attr-type="submit" :bordered="false" class="tag-management-button primary" :disabled="!canPreview">
                  {{ state === 'previewing' ? t('tags.manage.previewing') : t('tags.manage.preview') }}
                </NButton>
              </div>
            </form>

            <p v-if="state === 'error' || errorMessage" class="tag-management-error tag-management-banner" role="alert">{{ errorMessage }}</p>
            <p v-if="staleMessage" class="tag-management-error tag-management-banner" role="alert">{{ staleMessage }}</p>

            <section v-if="preview" class="tag-management-preview" aria-live="polite" :aria-busy="state === 'previewing'">
              <h3 ref="previewHeadingRef" tabindex="-1">{{ t('tags.manage.preview_ready', { count: preview.affectedCount }) }}</h3>
              <dl class="tag-management-summary">
                <div><dt>{{ t('tags.manage.preview_operation') }}</dt><dd>{{ preview.operation.kind === 'merge' ? t('tags.manage.merge') : preview.operation.kind === 'remove' ? t('tags.manage.remove') : t('tags.manage.rename') }}</dd></div>
                <div><dt>{{ t('tags.manage.source') }}</dt><dd>#{{ preview.sourceTag.displayName }}</dd></div>
                <template v-if="preview.operation.kind === 'merge'">
                  <div><dt>{{ t('tags.manage.destination_tag') }}</dt><dd>#{{ preview.destinationTag?.displayName }}</dd></div>
                </template>
                <template v-else-if="preview.operation.kind === 'rename'">
                  <div><dt>{{ t('tags.manage.requested_destination') }}</dt><dd>#{{ preview.requestedDestination?.displayName ?? destinationName }}</dd></div>
                </template>
                <div><dt>{{ t('tags.manage.affected_documents') }}</dt><dd>{{ preview.affectedCount }}</dd></div>
                <div><dt>{{ t('tags.manage.association_adds') }}</dt><dd>{{ preview.associationAdds }}</dd></div>
                <div><dt>{{ t('tags.manage.association_removes') }}</dt><dd>{{ preview.associationRemoves }}</dd></div>
                <div><dt>{{ t('tags.manage.duplicate_collapses') }}</dt><dd>{{ preview.duplicateCollapses }}</dd></div>
                <div><dt>{{ t('tags.manage.tag_creates') }}</dt><dd>{{ preview.tagCreates }}</dd></div>
                <div><dt>{{ t('tags.manage.tag_deletes') }}</dt><dd>{{ preview.tagDeletes }}</dd></div>
              </dl>

              <div v-if="preview.displayOnly" class="tag-management-display-only">
                <strong>{{ t('tags.manage.display_rename') }}</strong>
                <span>{{ t('tags.manage.display_rename_detail') }}</span>
              </div>

              <div v-if="preview.operation.kind === 'merge'" class="tag-management-merge-guidance">
                <strong>{{ t('tags.manage.merge_destination_survives') }}</strong>
                <span>{{ t('tags.manage.merge_destination_survives_detail', { destination: preview.destinationTag?.displayName ?? '', source: preview.sourceTag.displayName }) }}</span>
                <span>{{ t('tags.manage.merge_source_deletion', { source: preview.sourceTag.displayName, destination: preview.destinationTag?.displayName ?? '' }) }}</span>
                <span>{{ t('tags.manage.merge_overlap_detail') }}</span>
              </div>

              <div
                v-if="preview.operation.kind === 'remove'"
                id="tag-management-remove-explanation"
                class="tag-management-remove-guidance"
                role="alert"
              >
                <strong>{{ t('tags.manage.remove_explanation_title', { name: preview.sourceTag.displayName }) }}</strong>
                <span>{{ t('tags.manage.remove_explanation_documents') }}</span>
                <span>{{ t('tags.manage.remove_explanation_markdown') }}</span>
                <span>{{ t('tags.manage.remove_explanation_tag') }}</span>
                <span v-if="preview.affectedCount === 0">{{ t('tags.manage.remove_explanation_orphan') }}</span>
              </div>

              <div v-if="preview.conflictCode" class="tag-management-conflict" role="alert">
                {{ preview.operation.kind === 'merge'
                  ? preview.conflictCode === 'SOURCE_DESTINATION_SAME'
                    ? t('tags.manage.merge_same_tag')
                    : t('tags.manage.conflict_generic')
                  : preview.conflictCode === 'DESTINATION_EXISTS'
                  ? t('tags.manage.conflict_destination_exists')
                  : preview.conflictCode === 'INVALID_OPERATION'
                    ? t('tags.manage.conflict_noop')
                    : t('tags.manage.conflict_generic') }}
              </div>

              <div v-if="preview.warnings.length" class="tag-management-warnings">
                <h4>{{ t('tags.manage.warnings') }}</h4>
                <ul>
                  <li v-for="warning in preview.warnings" :key="warning">
                    {{ warning === 'HIGH_IMPACT' ? t('tags.manage.warning_high_impact') : t('tags.manage.warning_destructive') }}
                  </li>
                </ul>
              </div>

              <div class="tag-management-sample">
                <h4>{{ t('tags.manage.sample') }}</h4>
                <ul v-if="renderedSample.length">
                  <li v-for="document in renderedSample" :key="document.id">
                    <strong>{{ document.title || document.path }}</strong>
                    <span>{{ document.path }}</span>
                  </li>
                </ul>
                <p v-else>{{ t('tags.manage.sample_empty') }}</p>
                <NButton
                  v-if="nextAfterDocumentId"
                  attr-type="button"
                  :bordered="false"
                  class="tag-management-button secondary"
                  :disabled="pageLoading"
                  @click="loadMore"
                >
                  {{ pageLoading ? t('tags.manage.loading_more') : t('tags.manage.load_more') }}
                </NButton>
              </div>

              <div class="tag-management-actions">
                <NButton
                  attr-type="button"
                  :bordered="false"
                  class="tag-management-button primary"
                  :class="{ destructive: operationKind === 'remove' }"
                  :data-action="operationKind === 'remove' ? 'remove-apply' : 'apply'"
                  :aria-describedby="operationKind === 'remove' ? 'tag-management-remove-explanation' : undefined"
                  :disabled="!canApply"
                  @click="onApply"
                >
                  {{ state === 'applying'
                    ? t('tags.manage.applying')
                    : operationKind === 'remove'
                      ? t('tags.manage.apply_remove', { name: preview.sourceTag.displayName })
                      : operationKind === 'merge'
                      ? t('tags.manage.apply_merge')
                      : t('tags.manage.apply') }}
                </NButton>
              </div>
            </section>

            <section v-if="state === 'syncing'" class="tag-management-state" aria-busy="true">
              {{ t('tags.manage.syncing') }}
            </section>

            <section v-if="state === 'sync-pending'" class="tag-management-state tag-management-state-error" role="alert">
              <p>{{ t('tags.manage.sync_pending') }}</p>
              <NButton attr-type="button" :bordered="false" class="tag-management-button primary" @click="retrySynchronization">
                {{ t('tags.manage.retry_sync') }}
              </NButton>
            </section>

            <section
              v-if="state === 'success'"
              class="tag-management-state tag-management-state-success"
              role="status"
              :data-selected-tag="reconciledSelectedTag ?? undefined"
            >
              <p>{{ t('tags.manage.committed') }}</p>
              <p>{{ finalDisplayName
                ? (applyResult?.operation.kind === 'merge'
                  ? t('tags.manage.merge_success', { name: finalDisplayName })
                  : applyResult?.operation.kind === 'remove'
                    ? t('tags.manage.remove_success', { name: finalDisplayName })
                    : t('tags.manage.success', { name: finalDisplayName }))
                : t('tags.manage.success_generic') }}</p>
            </section>

            <p v-if="managedTags.length === 0 && state !== 'sync-pending' && state !== 'success'" class="tag-management-empty">
              {{ t('tags.manage.no_tags') }}
            </p>
          </template>

          <p class="tag-management-diagnostic" :data-code="diagnosticCode ?? undefined">
            {{ t('tags.manage.diagnostic', { stage: diagnosticLabel }) }}
          </p>
    </div>
  </section>
</template>

<style scoped>
.tag-management-panel {
  width: 100%;
  min-width: 0;
  color: var(--text-h);
}
.tag-management-body { padding: 0; }
.tag-management-live { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.tag-management-form { display: grid; gap: 14px; }
.tag-management-mode { display: grid; gap: 7px; margin: 0; padding: 0; border: 0; }
.tag-management-mode legend { padding: 0; color: var(--text-h); font-size: 0.78rem; font-weight: 600; }
.tag-management-mode-buttons { display: flex; flex-wrap: wrap; gap: 7px; }
.tag-management-mode-button { min-height: 32px; padding: 5px 12px; border: 1px solid var(--border); border-radius: 5px; background: transparent; color: var(--text); font: inherit; font-size: 0.78rem; cursor: pointer; }
.tag-management-mode-button[aria-pressed="true"] { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--text-h); }
.tag-management-mode-button:hover:not(:disabled) { background: var(--bg-soft); }
.tag-management-mode:disabled .tag-management-mode-button { cursor: not-allowed; opacity: 0.55; }
.tag-management-field { display: grid; gap: 5px; }
.tag-management-field label { color: var(--text-h); font-size: 0.78rem; font-weight: 600; }
.tag-management-input-control {
  width: 100%;
  min-height: 34px;
  box-sizing: border-box;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg-soft);
  color: var(--text);
  font: inherit;
  font-size: 0.84rem;
}
.tag-management-input-control:focus-within { outline: 2px solid var(--accent); outline-offset: 1px; }
.tag-management-input-control :deep(.tag-management-input) {
  min-height: 32px;
  box-sizing: border-box;
  padding: 6px 9px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 0.84rem;
}
.tag-management-input {
  min-height: 32px;
}
.tag-management-input-control :deep(.tag-management-input:focus-visible) { outline: none; }
.tag-management-input-control :deep(.tag-management-input:disabled) { cursor: not-allowed; opacity: 0.55; }
.tag-management-help { margin: 0; color: var(--text-muted); font-size: 0.72rem; line-height: 1.4; }
.tag-management-selected { margin: 0; color: var(--text); font-size: 0.76rem; font-weight: 600; }
.tag-management-error { margin: 0; color: var(--danger, #c94f4f); font-size: 0.76rem; line-height: 1.45; }
.tag-management-banner { margin-top: 14px; padding: 9px 10px; border: 1px solid color-mix(in srgb, var(--danger, #c94f4f) 35%, var(--border)); border-radius: 5px; background: color-mix(in srgb, var(--danger, #c94f4f) 8%, transparent); }
.tag-management-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 2px; }
.tag-management-button { min-height: 32px; padding: 5px 12px; border: 1px solid var(--border); border-radius: 5px; background: transparent; color: var(--text); font: inherit; font-size: 0.78rem; cursor: pointer; }
.tag-management-button:hover:not(:disabled) { background: var(--bg-soft); }
.tag-management-button.primary { border-color: var(--accent); background: var(--accent); color: var(--bg); }
.tag-management-button.primary:hover:not(:disabled) { background: var(--accent-hover, var(--accent)); }
.tag-management-button.destructive { border-color: var(--danger, #b42318); background: var(--danger, #b42318); color: #fff; }
.tag-management-button.destructive:hover:not(:disabled) { background: color-mix(in srgb, var(--danger, #b42318) 84%, #000); }
.tag-management-button.secondary { margin-top: 8px; }
.tag-management-button:disabled { cursor: not-allowed; opacity: 0.48; }
.tag-management-state { display: grid; justify-items: start; gap: 12px; min-height: 150px; padding: 36px 12px; color: var(--text-muted); text-align: left; }
.tag-management-state-error { color: var(--text); }
.tag-management-state-success { color: var(--text); }
.tag-management-state p { max-width: 540px; margin: 0; line-height: 1.55; }
.tag-management-preview { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--border); }
.tag-management-preview h3 { margin: 0 0 12px; font-size: 0.9rem; }
.tag-management-preview h3:focus { outline: 2px solid var(--accent); outline-offset: 3px; }
.tag-management-undo-last-change,
.tag-management-undo-preview { margin-bottom: 18px; padding: 12px; border: 1px solid color-mix(in srgb, var(--accent) 38%, var(--border)); border-radius: 7px; background: color-mix(in srgb, var(--accent) 5%, transparent); }
.tag-management-undo-preview { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--border); }
.tag-management-undo-section-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.tag-management-undo-section-heading h3, .tag-management-undo-preview h3 { margin: 0 0 10px; font-size: 0.9rem; }
.tag-management-undo-section-heading h3:focus, .tag-management-undo-preview h3:focus { outline: 2px solid var(--accent); outline-offset: 3px; }
.tag-management-undo-operation-label { color: var(--text-h); font-size: 0.78rem; font-weight: 600; }
.tag-management-undo-summary { margin-top: 4px; }
.tag-management-undo-note { margin: 10px 0 0; color: var(--text-muted); font-size: 0.76rem; line-height: 1.45; }
.tag-management-undo-preservation { display: grid; gap: 4px; margin-top: 14px; padding: 10px 12px; border-left: 3px solid var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); font-size: 0.76rem; line-height: 1.45; }
.tag-management-undo-preservation span { color: var(--text-muted); }
.tag-management-undo-state { display: grid; justify-items: start; gap: 9px; margin: 12px 0; padding: 12px; color: var(--text-muted); text-align: left; font-size: 0.78rem; line-height: 1.45; }
.tag-management-undo-state.tag-management-conflict { justify-items: stretch; text-align: left; }
.tag-management-undo-state .tag-management-button { justify-self: start; }
.tag-management-summary, .tag-management-undo-summary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 18px; margin: 0; }
.tag-management-summary div, .tag-management-undo-summary div { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; border-bottom: 1px solid color-mix(in srgb, var(--border) 55%, transparent); font-size: 0.76rem; }
.tag-management-summary dt, .tag-management-undo-summary dt { color: var(--text-muted); }
.tag-management-summary dd, .tag-management-undo-summary dd { margin: 0; color: var(--text); font-variant-numeric: tabular-nums; text-align: right; }
.tag-management-display-only { display: grid; gap: 4px; margin-top: 14px; padding: 10px 12px; border-left: 3px solid var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); font-size: 0.78rem; line-height: 1.45; }
.tag-management-display-only span { color: var(--text-muted); }
.tag-management-merge-guidance { display: grid; gap: 5px; margin-top: 14px; padding: 10px 12px; border-left: 3px solid var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); font-size: 0.78rem; line-height: 1.45; }
.tag-management-merge-guidance span { color: var(--text-muted); }
.tag-management-remove-guidance { display: grid; gap: 5px; margin-top: 14px; padding: 10px 12px; border-left: 3px solid var(--danger, #b42318); background: color-mix(in srgb, var(--danger, #b42318) 8%, transparent); font-size: 0.78rem; line-height: 1.45; }
.tag-management-remove-guidance span { color: var(--text-muted); }
.tag-management-conflict { margin-top: 14px; padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--danger, #c94f4f) 35%, var(--border)); border-radius: 5px; color: var(--danger, #c94f4f); font-size: 0.78rem; line-height: 1.45; }
.tag-management-warnings { margin-top: 14px; padding: 10px 12px; border-left: 3px solid var(--warning, #d97706); background: color-mix(in srgb, var(--warning, #d97706) 8%, transparent); font-size: 0.76rem; }
.tag-management-warnings h4, .tag-management-sample h4 { margin: 0 0 7px; font-size: 0.78rem; }
.tag-management-warnings ul, .tag-management-sample ul { display: grid; gap: 5px; margin: 0; padding-left: 18px; }
.tag-management-sample { margin-top: 16px; }
.tag-management-sample li { display: flex; flex-wrap: wrap; gap: 5px 10px; color: var(--text); font-size: 0.76rem; }
.tag-management-sample li span { color: var(--text-muted); font-family: var(--mono); font-size: 0.7rem; }
.tag-management-sample > p { margin: 0; color: var(--text-muted); font-size: 0.76rem; }
.tag-management-empty { margin: 18px 0 0; color: var(--text-muted); font-size: 0.78rem; }
.tag-management-diagnostic { margin: 18px 0 0; color: var(--text-muted); font-size: 0.68rem; }
@media (max-width: 600px) {
  .tag-management-summary, .tag-management-undo-summary { grid-template-columns: minmax(0, 1fr); }
  .tag-management-undo-section-heading { align-items: flex-start; flex-direction: column; gap: 2px; }
}
</style>

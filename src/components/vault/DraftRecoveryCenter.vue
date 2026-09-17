<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NCheckbox } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import {
  recoveryRecordId,
  type DraftCapacitySnapshot,
  type RecoveryRecordRef,
} from '../../composables/vault/draft-recovery/draftCleanup'
import type { DraftRecoveryItem } from '../../composables/vault/draft-recovery/useUnsavedDraftRecovery'

const props = defineProps<{
  records: readonly RecoveryRecordRef[]
  items: readonly DraftRecoveryItem[]
  capacity: DraftCapacitySnapshot
  unsupportedCount: number
  selectedIds: ReadonlySet<string>
  protectedIds: ReadonlySet<string>
  loading: boolean
  error: string | null
}>()

const emit = defineEmits<{
  refresh: []
  'delete-selected': []
  toggle: [recoveryId: string]
  open: [recoveryId: string]
  retry: [recoveryId: string]
  delete: [recoveryId: string]
}>()

const { t } = useI18n()
// The error state and the empty state are mutually exclusive: when the
// storage read fails, `records` is just the default empty array — NOT a
// certified "no unsaved content" result. Rendering the summary/empty
// states on top of the error would tell the user both "0 items to
// review" and "could not read recovery storage" at once.
const errorMessage = computed(() => (
  props.error === 'upgrade-blocked'
    ? t('draft_recovery.center.read_blocked')
    : t('draft_recovery.center.load_failed')
))
const itemsById = computed(() => new Map(props.items.map((item) => [item.recoveryId, item])))
function decisionLabel(id: string): string {
  const item = itemsById.value.get(id)
  if (!item) return t('draft_recovery.center.unclassified')
  if (item.status === 'error') return t('draft_recovery.center.classification_error')
  return t(`draft_recovery.center.decision.${item.decision?.kind ?? 'unknown'}`)
}
</script>

<template>
  <section class="recovery-center" :aria-busy="loading">
    <header>
      <h2>{{ t('draft_recovery.center.title') }}</h2>
      <p>{{ t('draft_recovery.center.local_only') }}</p>
    </header>

    <div v-if="loading" class="recovery-state" role="status">{{ t('draft_recovery.center.loading') }}</div>

    <div v-else-if="error" class="recovery-state" role="alert">
      <p class="warning">{{ errorMessage }}</p>
      <NButton attr-type="button" :bordered="false" @click="emit('refresh')">{{ t('draft_recovery.center.refresh') }}</NButton>
    </div>

    <template v-else>
      <p class="recovery-summary-line">{{ t('draft_recovery.center.summary', { count: capacity.recordCount }) }}</p>
      <p v-if="capacity.overCapacity" class="warning" role="alert">{{ t('draft_recovery.center.over_capacity') }}</p>
      <p v-if="unsupportedCount > 0" class="warning" role="alert">
        {{ t('draft_recovery.center.unsupported_notice') }}
      </p>

      <div class="recovery-toolbar">
        <NButton attr-type="button" :bordered="false" @click="emit('refresh')">{{ t('draft_recovery.center.refresh') }}</NButton>
        <NButton attr-type="button" :bordered="false" :disabled="selectedIds.size === 0" @click="emit('delete-selected')">{{ t('draft_recovery.center.delete_selected') }}</NButton>
      </div>

      <p v-if="records.length === 0" class="empty">{{ t('draft_recovery.center.empty') }}</p>
      <ul v-else class="recovery-list">
      <li v-for="entry in records" :key="recoveryRecordId(entry)">
        <NCheckbox
          :aria-label="t('draft_recovery.center.select_record', { path: entry.record.documentPath })"
          :checked="selectedIds.has(recoveryRecordId(entry))"
          :disabled="protectedIds.has(recoveryRecordId(entry))"
          :aria-disabled="protectedIds.has(recoveryRecordId(entry)) ? 'true' : undefined"
          @update:checked="emit('toggle', recoveryRecordId(entry))"
        />
        <div class="record-main">
          <strong>{{ entry.record.documentPath }}</strong>
          <span class="record-meta">
            {{ decisionLabel(recoveryRecordId(entry)) }}
            · {{ new Date(entry.record.updatedAt).toLocaleString() }}
          </span>
          <span v-if="protectedIds.has(recoveryRecordId(entry))" class="in-use">{{ t('draft_recovery.center.in_use') }}</span>
        </div>
        <div class="record-actions">
          <NButton attr-type="button" :bordered="false" @click="emit('open', recoveryRecordId(entry))">{{ t('draft_recovery.center.open') }}</NButton>
          <NButton attr-type="button" :bordered="false" @click="emit('retry', recoveryRecordId(entry))">{{ t('draft_recovery.center.retry') }}</NButton>
          <NButton attr-type="button" :bordered="false" :disabled="protectedIds.has(recoveryRecordId(entry))" @click="emit('delete', recoveryRecordId(entry))">{{ t('draft_recovery.center.delete') }}</NButton>
        </div>
      </li>
    </ul>
    </template>
  </section>
</template>

<style scoped>
.recovery-center { height: 100%; overflow: auto; padding: 14px; color: var(--text-primary); }
.recovery-center h2 { margin: 0 0 4px; font-size: 15px; }
.recovery-center p { margin: 4px 0 12px; color: var(--text-secondary); font-size: 12px; }
.recovery-summary { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 12px 0; }
.recovery-summary div { padding: 8px; background: var(--bg-secondary); border-radius: 4px; }
.recovery-summary dt { color: var(--text-secondary); font-size: 11px; }
.recovery-summary dd { margin: 2px 0 0; font-size: 12px; }
.recovery-toolbar { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
button { font: inherit; }
.recovery-list { list-style: none; margin: 0; padding: 0; }
.recovery-list li { display: flex; align-items: flex-start; gap: 8px; padding: 10px 0; border-top: 1px solid var(--border); }
.record-main { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 3px; }
.record-main strong { overflow-wrap: anywhere; font-size: 12px; }
.record-meta, .in-use { color: var(--text-secondary); font-size: 11px; }
.record-actions { display: flex; flex-direction: column; gap: 4px; }
.warning { color: var(--warning, #b7791f) !important; }
.recovery-state { padding: 16px 0; font-size: 12px; color: var(--text-secondary); }
.empty { text-align: left; padding: 24px 0; }
</style>

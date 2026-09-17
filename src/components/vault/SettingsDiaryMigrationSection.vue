<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NButton } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { usePrompt } from '../../composables/usePrompt'
import { useToast } from '../../composables/useToast'
import { useOptionalVaultContext } from '../../composables/vault/context/useVaultContext'
import {
  createDraftStore,
  type DraftConditionalDeleteOutcome,
} from '../../composables/vault/draft-recovery/draftStore'
import type { DraftConflictRecord, UnsavedDraft } from '../../composables/vault/draft-recovery/draftTypes'
import { getPost, savePost } from '../../lib/api'
import {
  getDiaryMigrationStatus,
  resolveDiaryMigrationItem,
  resumeDiaryMigration,
  scanDiaryMigration,
  startDiaryMigration,
  type MigrationActionScope,
  type MigrationItem,
  type MigrationStatus,
} from '../../lib/diary-migration-api'

const { t } = useI18n()
const { prompt } = usePrompt()
const toast = useToast()
const vaultContext = useOptionalVaultContext()
const draftStore = createDraftStore()
const status = ref<MigrationStatus | null>(null)
const managedDrafts = ref<Array<{ kind: 'primary'; record: UnsavedDraft } | { kind: 'conflict'; record: DraftConflictRecord }>>([])
const loading = ref(false)
const working = ref(false)
const errorCode = ref('')
const discardConfirmationPending = ref(false)
const LEGACY_RECOVERY_CONFIRMATION = 'DISCARD LEGACY DIARY RECOVERY'

const runReady = computed(() => Boolean(status.value?.runId && status.value.inventoryRevision !== undefined))
const pendingItems = computed(() => status.value?.items.filter((item) => item.state !== 'COMPLETE') ?? [])

function safeError(error: unknown): string {
  const code = (error as { code?: unknown })?.code
  return typeof code === 'string' ? code : 'diary-migration-unavailable'
}

async function load() {
  loading.value = true
  errorCode.value = ''
  try { status.value = await getDiaryMigrationStatus(); await loadManagedDrafts() }
  catch (error) { errorCode.value = safeError(error) }
  finally { loading.value = false }
}

async function loadManagedDrafts() {
  const vaultId = vaultContext?.vaultId.value
  if (!vaultId || !draftStore.inspectManagedDiaryRecovery) {
    managedDrafts.value = []
    return
  }
  const result = await draftStore.inspectManagedDiaryRecovery(vaultId)
  if (result.status !== 'ok') {
    managedDrafts.value = []
    return
  }
  managedDrafts.value = [
    ...result.inventory.primary.map((record) => ({ kind: 'primary' as const, record })),
    ...result.inventory.conflicts.map((record) => ({ kind: 'conflict' as const, record })),
  ]
}

function draftsFor(item: MigrationItem) {
  const logicalPath = item.canonicalPath
  return managedDrafts.value.filter(({ record }) => (
    record.documentPath.replace(/\.md$/, '') === logicalPath
      && (!item.documentId || record.documentId === item.documentId)
  ))
}

function isDeleteSuccess(result: DraftConditionalDeleteOutcome): boolean {
  return result.status === 'deleted' || result.status === 'missing'
}

async function requestDiscardConfirmation(): Promise<string | null> {
  if (discardConfirmationPending.value) return null
  discardConfirmationPending.value = true
  try {
    return await prompt({
      title: `Type ${LEGACY_RECOVERY_CONFIRMATION} to confirm`,
      placeholder: LEGACY_RECOVERY_CONFIRMATION,
      actionLabel: t('common.confirm'),
      actionTitle: t('common.confirm'),
    })
  } finally {
    discardConfirmationPending.value = false
  }
}

async function importDraft(item: MigrationItem, entry: { kind: 'primary'; record: UnsavedDraft } | { kind: 'conflict'; record: DraftConflictRecord }) {
  if (!item.documentId || !draftStore.inspectManagedDiaryRecovery) return
  working.value = true
  errorCode.value = ''
  try {
    const current = await getPost(item.canonicalPath)
    await savePost(item.canonicalPath, entry.record.content, current.raw)
    const deletion = entry.kind === 'primary'
      ? await draftStore.deleteManagedDraftIfUnchanged?.(entry.record)
      : await draftStore.deleteManagedConflictDraftIfUnchanged?.(entry.record)
    if (!deletion || !isDeleteSuccess(deletion)) {
      throw Object.assign(new Error('legacy Draft changed before deletion'), { code: 'diary-migration-consent-required' })
    }
    status.value = await resolveDiaryMigrationItem(status.value!.runId!, item.itemKey, status.value!.inventoryRevision!, 'import-to-primary')
    await loadManagedDrafts()
  } catch (error) {
    errorCode.value = safeError(error)
    await load()
  } finally { working.value = false }
}

async function discardDraft(item: MigrationItem, entry: { kind: 'primary'; record: UnsavedDraft } | { kind: 'conflict'; record: DraftConflictRecord }) {
  const confirmation = await requestDiscardConfirmation()
  if (confirmation !== LEGACY_RECOVERY_CONFIRMATION) return
  working.value = true
  errorCode.value = ''
  try {
    const deletion = entry.kind === 'primary'
      ? await draftStore.deleteManagedDraftIfUnchanged?.(entry.record)
      : await draftStore.deleteManagedConflictDraftIfUnchanged?.(entry.record)
    if (!deletion || !isDeleteSuccess(deletion)) {
      throw Object.assign(new Error('legacy Draft changed before deletion'), { code: 'diary-migration-consent-required' })
    }
    status.value = await resolveDiaryMigrationItem(status.value!.runId!, item.itemKey, status.value!.inventoryRevision!, 'discard-draft', confirmation)
    await loadManagedDrafts()
  } catch (error) {
    errorCode.value = safeError(error)
    await load()
  } finally { working.value = false }
}

async function scan() {
  working.value = true
  errorCode.value = ''
  try {
    await scanDiaryMigration()
    await load()
    toast.success(t('settings.diary_migration_scanned'))
  } catch (error) {
    errorCode.value = safeError(error)
  } finally { working.value = false }
}

async function start() {
  if (!status.value?.runId || status.value.inventoryRevision === undefined) return
  working.value = true
  errorCode.value = ''
  try {
    const requestedScopes: Array<{ itemKey: string; scope: MigrationActionScope }> = []
    for (const item of pendingItems.value) {
      if (
        item.classification === 'LEGACY_PLAINTEXT'
        || item.classification === 'NEEDS_UNLOCK'
        || item.classification === 'RECOVERY_AUTH_REQUIRED'
      ) {
        requestedScopes.push({ itemKey: item.itemKey, scope: 'MIGRATE_PRIMARY' })
        continue
      }
      if (item.classification === 'CLEANUP_PENDING') {
        requestedScopes.push({ itemKey: item.itemKey, scope: 'CLEAN_PRIVATE_SQLITE' })
        continue
      }
      if (item.canonicalPath === '@git/retention') {
        requestedScopes.push({ itemKey: item.itemKey, scope: 'ACKNOWLEDGE_GIT_RETENTION' })
      }
    }
    status.value = await startDiaryMigration(status.value.runId, status.value.inventoryRevision, requestedScopes)
  } catch (error) {
    errorCode.value = safeError(error)
    await load()
  } finally { working.value = false }
}

async function resume() {
  if (!status.value?.runId || status.value.inventoryRevision === undefined) return
  working.value = true
  errorCode.value = ''
  try {
    status.value = await resumeDiaryMigration(status.value.runId, status.value.inventoryRevision)
  } catch (error) {
    errorCode.value = safeError(error)
    await load()
  } finally { working.value = false }
}

async function acknowledgePlaintextResidual(item: MigrationItem) {
  if (!status.value?.runId || status.value.inventoryRevision === undefined) return
  working.value = true
  errorCode.value = ''
  try {
    status.value = await startDiaryMigration(status.value.runId, status.value.inventoryRevision, [
      { itemKey: item.itemKey, scope: 'REMOVE_VERIFIED_LEGACY_PRIMARY' },
    ])
  } catch (error) {
    errorCode.value = safeError(error)
    await load()
  } finally { working.value = false }
}

async function resolveItem(
  item: MigrationItem,
  action: 'adopt-metadata' | 'acknowledge-attention' | 'retain-ai-history' | 'discard-ai-session' | 'discard-draft' | 'bind-frontmatter-identity' | 'retry-item',
) {
  if (!status.value?.runId || status.value.inventoryRevision === undefined) return
  let confirmation: string | undefined
  if (action === 'discard-draft') {
    const answer = await requestDiscardConfirmation()
    if (answer !== LEGACY_RECOVERY_CONFIRMATION) return
    confirmation = answer
  }
  working.value = true
  try {
    status.value = await resolveDiaryMigrationItem(status.value.runId, item.itemKey, status.value.inventoryRevision, action, confirmation)
  } catch (error) {
    errorCode.value = safeError(error)
  } finally { working.value = false }
}

onMounted(() => { void load() })
</script>

<template>
  <section class="settings-section" aria-labelledby="settings-diary-migration-title">
    <header class="settings-section-header">
      <div>
        <h3 id="settings-diary-migration-title">{{ t('settings.diary_migration') }}</h3>
        <p>{{ t('settings.diary_migration_subtitle') }}</p>
      </div>
      <div class="settings-section-actions">
        <NButton attr-type="button" size="medium" class="btn" :bordered="false" :disabled="loading || working" @click="scan">
          {{ t(loading ? 'settings.checking' : 'settings.diary_migration_scan') }}
        </NButton>
      </div>
    </header>
    <div class="settings-section-body diary-migration-body">
      <div v-if="errorCode" class="settings-warning-card" role="alert">{{ errorCode }}</div>
      <div v-if="status" class="settings-card" aria-live="polite">
        <div class="diary-migration-summary">
          <strong>{{ status.state }}</strong>
          <span v-if="status.inventoryRevision !== undefined">Revision {{ status.inventoryRevision }}</span>
          <span>{{ status.counts.total ?? 0 }} items</span>
        </div>
        <p v-if="status.residuals.userControlledPlaintextResidual || status.residuals.policyRetainedAiHistory" class="diary-migration-residuals">
          Residuals: {{ status.residuals.userControlledPlaintextResidual }} user-controlled plaintext copy/copies;
          {{ status.residuals.policyRetainedAiHistory }} policy-retained AI session(s).
        </p>
        <p class="diary-migration-capability">
          {{ status.migrationFinalizeCapability === 'USER_FINALIZE_REQUIRED'
            ? t('settings.diary_migration_manual_finalize')
            : status.migrationFinalizeCapability === 'AUTOMATIC_HANDLE_BOUND'
              ? t('settings.diary_migration_automatic_finalize')
              : t('settings.diary_migration_unsupported') }}
        </p>
        <ol v-if="pendingItems.some((item) => item.state === 'USER_FINALIZE_REQUIRED')" class="diary-migration-instructions">
          <li>{{ t('settings.diary_migration_instruction_stop') }}</li>
          <li>{{ t('settings.diary_migration_instruction_replace') }}</li>
          <li>{{ t('settings.diary_migration_instruction_resume') }}</li>
        </ol>
        <ul v-if="status.items.length" class="diary-migration-items">
          <li v-for="item in status.items" :key="item.itemKey">
            <span class="diary-migration-item-path">{{ item.canonicalPath }}</span>
            <span>{{ item.classification }} · {{ item.state }}</span>
            <template v-for="entry in draftsFor(item)" :key="`${entry.kind}-${entry.record.documentId}-${entry.kind === 'conflict' ? entry.record.conflictId : entry.record.updatedAt}`">
              <span class="diary-migration-draft-label">{{ t('settings.diary_migration_legacy_draft') }}</span>
              <NButton
                attr-type="button"
                size="medium"
                class="btn"
                :bordered="false"
                :disabled="working"
                @click="importDraft(item, entry)"
              >{{ t('settings.diary_migration_import_draft') }}</NButton>
              <NButton
                attr-type="button"
                size="medium"
                class="btn"
                :bordered="false"
                :disabled="working || discardConfirmationPending"
                @click="discardDraft(item, entry)"
              >{{ t('settings.diary_migration_discard_draft') }}</NButton>
            </template>
            <NButton
              v-if="item.canonicalPath.startsWith('diary/') && (item.classification === 'USER_FINALIZE_REQUIRED' || item.classification === 'CLEANUP_PENDING') && (item.state === 'PUBLISHED' || item.state === 'CLEANUP_PENDING' || item.state === 'COMPLETE')"
              attr-type="button"
              size="medium"
              class="btn"
              :bordered="false"
              :disabled="working || item.userResidualState === 'USER_CONTROLLED_PLAINTEXT_RESIDUAL'"
              @click="acknowledgePlaintextResidual(item)"
            >{{ t('settings.diary_migration_acknowledge_plaintext') }}</NButton>
            <NButton
              v-if="item.classification === 'METADATA_MISSING'"
              attr-type="button"
              size="medium"
              class="btn"
              :bordered="false"
              :disabled="working"
              @click="resolveItem(item, 'adopt-metadata')"
            >{{ t('settings.diary_migration_adopt') }}</NButton>
            <NButton
              v-else-if="item.classification === 'LEGACY_DIARY_AI_HISTORY'"
              attr-type="button"
              size="medium"
              class="btn"
              :bordered="false"
              :disabled="working"
              @click="resolveItem(item, 'retain-ai-history')"
            >{{ t('settings.diary_migration_retain_ai') }}</NButton>
            <NButton
              v-if="item.classification === 'LEGACY_DIARY_AI_HISTORY'"
              attr-type="button"
              size="medium"
              class="btn"
              :bordered="false"
              :disabled="working"
              @click="resolveItem(item, 'discard-ai-session')"
            >{{ t('settings.diary_migration_discard_ai') }}</NButton>
            <NButton
              v-else-if="item.classification === 'FRONTMATTER_IDENTITY_UNRESOLVED'"
              attr-type="button"
              size="medium"
              class="btn"
              :bordered="false"
              :disabled="working"
              @click="resolveItem(item, 'bind-frontmatter-identity')"
            >{{ t('settings.diary_migration_bind_frontmatter') }}</NButton>
            <NButton
              v-else-if="item.classification === 'NEEDS_ATTENTION' && item.canonicalPath !== '@git/retention'"
              attr-type="button"
              size="medium"
              class="btn"
              :bordered="false"
              :disabled="working"
              @click="resolveItem(item, 'retry-item')"
            >{{ t('settings.diary_migration_retry') }}</NButton>
            <NButton
              v-else-if="item.state === 'NEEDS_ATTENTION' && item.canonicalPath !== '@git/retention'"
              attr-type="button"
              size="medium"
              class="btn"
              :bordered="false"
              :disabled="working"
              @click="resolveItem(item, 'acknowledge-attention')"
            >{{ t('settings.diary_migration_acknowledge') }}</NButton>
          </li>
        </ul>
        <div class="settings-metadata-actions">
          <NButton attr-type="button" type="primary" size="medium" class="btn btn-primary" :bordered="false" :disabled="!runReady || working" @click="start">
            {{ t('settings.diary_migration_start') }}
          </NButton>
          <NButton attr-type="button" size="medium" class="btn" :bordered="false" :disabled="!runReady || working" @click="resume">
            {{ t('settings.diary_migration_resume') }}
          </NButton>
        </div>
      </div>
      <p v-else class="settings-empty">{{ t('settings.diary_migration_scan_first') }}</p>
    </div>
  </section>
</template>

<style scoped>
.diary-migration-body { gap: 12px; }
.diary-migration-summary { display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline; }
.diary-migration-capability { margin: 10px 0; color: var(--vs-text-2, var(--text-muted, #6b6b6b)); }
.diary-migration-residuals { margin: 8px 0; color: var(--vs-text-2, var(--text-muted, #6b6b6b)); }
.diary-migration-instructions { margin: 8px 0 14px; padding-left: 20px; }
.diary-migration-items { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.diary-migration-items li { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; border-top: 1px solid var(--vs-border, #e5e7eb); padding-top: 8px; }
.diary-migration-item-path { min-width: 10rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.diary-migration-draft-label { color: var(--vs-text-2, var(--text-muted, #6b6b6b)); }
.settings-empty { color: var(--vs-text-2, var(--text-muted, #6b6b6b)); }
</style>

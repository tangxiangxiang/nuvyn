<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NButton, NIcon } from 'naive-ui'
import { Book, Edit, FileText, MoodSmile, Robot, Tag, Wallet, X } from '@vicons/tabler'
import {
  clearAiApiKey,
  getAiCredentialStatus,
  getAiSettings,
  saveAiSettings,
  testAiConnection,
  type AiCredentialStatus,
  type AiConnectionErrorCode,
  type AiConnectionState,
  type AiConnectionTestResult,
  type AiKeyErrorCode,
  type AiProvider,
  type AiSettings,
} from '../../lib/ai-api'
import { useToast } from '../../composables/useToast'
import { useAiHistory } from '../../composables/vault/useAiHistory'
import { useFocusTrap } from '../../composables/useFocusTrap'
import { useConfirm } from '../../composables/useConfirm'
import { useI18n } from '../../composables/useI18n'
import { getFallbackVaultFileChanges } from '../../composables/vault/context/fileChanges'
import { useOptionalVaultContext } from '../../composables/vault/context/useVaultContext'
import {
  cleanDocumentFrontmatter,
  getFrontmatterCleanupPreview,
  getMetadataMigrationStatus,
  restoreDocumentFrontmatter,
  type FrontmatterCleanupPreview,
  type MetadataMigrationSummary,
} from '../../lib/api'
import SettingsAiSection from './SettingsAiSection.vue'
import SettingsEditorSection from './SettingsEditorSection.vue'
import SettingsMetadataSection from './SettingsMetadataSection.vue'
import SettingsTagsSection from './SettingsTagsSection.vue'
import SettingsDiaryMigrationSection from './SettingsDiaryMigrationSection.vue'
import SettingsLedgerAccountIconsSection from './SettingsLedgerAccountIconsSection.vue'
import SettingsLedgerCategoriesSection from './SettingsLedgerCategoriesSection.vue'
import SettingsDiaryMoodIconsSection from './SettingsDiaryMoodIconsSection.vue'

const props = withDefaults(defineProps<{
  open: boolean
  /** Host-level guard supplied by the active embedded Settings page. */
  activeSectionCanLeave?: boolean
}>(), {
  activeSectionCanLeave: true,
})
const emit = defineEmits<{ close: [] }>()

const toast = useToast()
const aiHistory = useAiHistory()
const trap = useFocusTrap()
const { confirm } = useConfirm()
const { t } = useI18n()
const vaultContext = useOptionalVaultContext()

const loading = ref(false)
const saving = ref(false)
const settings = ref<AiSettings | null>(null)
const aiErrorCode = ref<AiKeyErrorCode | undefined>()
const credentialStatus = ref<AiCredentialStatus | null>(null)
const apiKey = ref('')
const baseURL = ref('')
const model = ref('claude-sonnet-4-6')
const connectionState = ref<AiConnectionState>('untested')
const connectionResult = ref<AiConnectionTestResult | null>(null)
const connectionError = ref('')
const connectionController = ref<AbortController | null>(null)
let connectionRunId = 0
const modalRef = ref<HTMLElement | null>(null)
const migrationSummary = ref<MetadataMigrationSummary | null>(null)
const cleanupPreview = ref<FrontmatterCleanupPreview | null>(null)
const previewing = ref(false)
const mutatingMetadata = ref(false)
const cleanedPaths = ref<string[]>([])

/* Left nav + right detail. Each section is its own .vue file
   (SettingsAiSection / SettingsEditorSection / SettingsMetadataSection /
   SettingsTagsSection)
   so the shell stays a routing layer — no inline form templates.
   The active pane resets to AI every time the modal opens so a
   returning user always lands somewhere predictable. */
type SectionId = 'ai' | 'editor' | 'metadata' | 'diary-migration' | 'tags' | 'ledger-account-icons' | 'ledger-categories' | 'diary-mood-icons'
const SECTIONS = [
  { id: 'ai', labelKey: 'settings.ai', icon: Robot },
  { id: 'editor', labelKey: 'settings.editor', icon: Edit },
  { id: 'metadata', labelKey: 'settings.metadata', icon: FileText },
  { id: 'diary-migration', labelKey: 'settings.diary_migration', icon: Book },
  { id: 'tags', labelKey: 'settings.tags', icon: Tag },
  { id: 'ledger-account-icons', labelKey: 'settings.ledger_account_icons', icon: Wallet },
  { id: 'ledger-categories', labelKey: 'settings.ledger_categories', icon: Tag },
  { id: 'diary-mood-icons', labelKey: 'settings.diary_mood_icons', icon: MoodSmile },
] as const satisfies ReadonlyArray<{ id: SectionId; labelKey: string; icon: typeof Robot }>
const active = ref<SectionId>('ai')

async function load() {
  loading.value = true
  resetConnectionStatus()
  aiErrorCode.value = undefined
  credentialStatus.value = null
  try {
    const [next, migration] = await Promise.all([
      getAiSettings(),
      getMetadataMigrationStatus().catch(() => null),
    ])
    settings.value = next
    apiKey.value = ''
    baseURL.value = next.baseURL
    model.value = next.model || 'claude-sonnet-4-6'
    migrationSummary.value = migration?.summary ?? null
    cleanedPaths.value = migration?.cleanedPaths ?? []
  } catch (e: any) {
    aiErrorCode.value = e.code
    if (e.code === 'master-key-required') {
      credentialStatus.value = await getAiCredentialStatus().catch(() => null)
    }
    toast.error(t('settings.load_failed', { error: e.message ?? t('common.unknown_error') }))
  } finally {
    loading.value = false
  }
}

function resetConnectionStatus() {
  connectionRunId += 1
  connectionController.value?.abort()
  connectionController.value = null
  connectionState.value = 'untested'
  connectionResult.value = null
  connectionError.value = ''
}

function abortConnectionTest() {
  connectionRunId += 1
  connectionController.value?.abort()
  connectionController.value = null
}

function updateApiKey(value: string) {
  apiKey.value = value
  resetConnectionStatus()
}

function updateBaseURL(value: string) {
  baseURL.value = value
  resetConnectionStatus()
}

function updateModel(value: string) {
  model.value = value
  resetConnectionStatus()
}

function connectionErrorMessage(error: any): string {
  const code = error?.code as AiConnectionErrorCode | 'openai-tools-unsupported' | undefined
  if (code === 'ai-connection-timeout') return t('settings.connection_timeout')
  if (code === 'ai-authentication-failed') return t('settings.connection_auth_failed')
  if (code === 'ai-model-unavailable') return t('settings.connection_model_unavailable')
  return error?.message || t('settings.connection_failed')
}

async function onTestConnection() {
  connectionController.value?.abort()
  const controller = new AbortController()
  const runId = ++connectionRunId
  connectionController.value = controller
  connectionState.value = 'checking'
  connectionResult.value = null
  connectionError.value = ''
  const provider = settings.value?.provider ?? credentialStatus.value?.provider ?? 'anthropic'
  try {
    const result = await testAiConnection({
      provider,
      ...(apiKey.value.trim() ? { apiKey: apiKey.value } : {}),
      baseURL: baseURL.value,
      model: model.value,
    }, controller.signal)
    if (runId !== connectionRunId || controller.signal.aborted) return
    connectionResult.value = result
    connectionState.value = 'connected'
  } catch (error) {
    if (runId !== connectionRunId || controller.signal.aborted) return
    connectionState.value = 'failed'
    connectionError.value = connectionErrorMessage(error)
  } finally {
    if (runId === connectionRunId) connectionController.value = null
  }
}

async function reloadMetadataStatus() {
  const migration = await getMetadataMigrationStatus()
  migrationSummary.value = migration.summary
  cleanedPaths.value = migration.cleanedPaths
  cleanupPreview.value = await getFrontmatterCleanupPreview()
}

function publishChanges(result: { changed: Array<{ path: string; newRaw: string; newMtime: number }> }) {
  const publishChange = vaultContext?.fileChanges.publish ?? getFallbackVaultFileChanges().publish
  for (const change of result.changed) publishChange({ ...change, kind: 'write' })
}

async function removeFrontmatter() {
  const paths = cleanupPreview.value?.candidates.map((item) => item.path) ?? []
  if (!paths.length) return
  const ok = await confirm(
    t('settings.remove_confirm', { count: paths.length }),
    t('settings.remove_detail'),
  )
  if (!ok) return
  mutatingMetadata.value = true
  try {
    const result = await cleanDocumentFrontmatter(paths)
    publishChanges(result)
    await reloadMetadataStatus()
    if (result.failed.length) toast.error(t('settings.operation_failed_count', { count: result.failed.length }))
    if (result.changed.length) toast.success(t('settings.cleaned_count', { count: result.changed.length }))
  } catch (e: any) {
    toast.error(t('settings.remove_failed', { error: e.message ?? t('common.unknown_error') }))
  } finally {
    mutatingMetadata.value = false
  }
}

async function restoreOriginalFrontmatter() {
  if (!cleanedPaths.value.length) return
  const paths = [...cleanedPaths.value]
  const ok = await confirm(
    t('settings.restore_confirm', { count: paths.length }),
    t('settings.restore_detail'),
  )
  if (!ok) return
  mutatingMetadata.value = true
  try {
    const result = await restoreDocumentFrontmatter(paths, 'original')
    publishChanges(result)
    await reloadMetadataStatus()
    if (result.failed.length) toast.error(t('settings.operation_failed_count', { count: result.failed.length }))
    if (result.changed.length) toast.success(t('settings.restored_count', { count: result.changed.length }))
  } catch (e: any) {
    toast.error(t('settings.restore_failed', { error: e.message ?? t('common.unknown_error') }))
  } finally {
    mutatingMetadata.value = false
  }
}

async function previewCleanup() {
  previewing.value = true
  try {
    cleanupPreview.value = await getFrontmatterCleanupPreview()
  } catch (e: any) {
    toast.error(t('settings.cleanup_failed', { error: e.message ?? t('common.unknown_error') }))
  } finally {
    previewing.value = false
  }
}

async function onSave() {
  resetConnectionStatus()
  saving.value = true
  try {
    const next = await saveAiSettings({
      ...(apiKey.value.trim() ? { apiKey: apiKey.value } : {}),
      baseURL: baseURL.value,
      model: model.value,
    })
    settings.value = next
    apiKey.value = ''
    baseURL.value = next.baseURL
    model.value = next.model
    await aiHistory.loadActive()
    toast.success(t('settings.saved'))
  } catch (e: any) {
    toast.error(t('settings.save_failed', { error: e.message ?? t('common.unknown_error') }))
  } finally {
    saving.value = false
  }
}

/* Provider switch — saves { provider } only (no apiKey/baseURL/model),
   which on the server side updates the active provider and returns the
   new view. We then refresh local refs from the response so the form
   fields show the new provider's saved config. The local input values
   (apiKey/baseURL/model) get overwritten by the response so the user
   sees what is now active. */
async function onSwitchProvider(provider: 'anthropic' | 'openai') {
  resetConnectionStatus()
  saving.value = true
  try {
    const next = await saveAiSettings({ provider })
    settings.value = next
    apiKey.value = ''
    baseURL.value = next.baseURL
    model.value = next.model
  } catch (e: any) {
    toast.error(t('settings.save_failed', { error: e.message ?? t('common.unknown_error') }))
  } finally {
    saving.value = false
  }
}

async function onClearKey(provider?: AiProvider) {
  const target = provider ?? settings.value?.provider ?? credentialStatus.value?.provider ?? 'anthropic'
  const ok = await confirm(
    t('settings.forget_key_confirm', { provider: target }),
    t('settings.forget_key_detail'),
    {
      confirmLabel: t('settings.forget_key_action'),
      cancelLabel: t('settings.cancel'),
      destructive: true,
    },
  )
  if (!ok) return
  resetConnectionStatus()
  saving.value = true
  try {
    await clearAiApiKey(target)
    apiKey.value = ''
    if (settings.value?.provider === target) {
      settings.value = {
        ...settings.value,
        configured: false,
        source: 'none',
        maskedKey: '',
      }
    }
    try {
      const next = await getAiSettings()
      settings.value = next
      baseURL.value = next.baseURL
      model.value = next.model
      aiErrorCode.value = undefined
      credentialStatus.value = null
      await aiHistory.loadActive()
    } catch (error: any) {
      aiErrorCode.value = error.code
      if (error.code === 'master-key-required') {
        credentialStatus.value = await getAiCredentialStatus().catch(() => null)
      }
    }
    toast.success(t('settings.key_cleared'))
  } catch (e: any) {
    toast.error(t('settings.clear_failed', { error: e.message ?? t('common.unknown_error') }))
  } finally {
    saving.value = false
  }
}

watch(() => props.open, async (open) => {
  if (open) {
    active.value = 'ai'
    trap.activate()
    void focusFirstSettingsField()
    await load()
    await focusFirstSettingsField()
  } else {
    abortConnectionTest()
    await trap.deactivate()
  }
})

onMounted(() => {
  if (props.open) {
    trap.activate()
    void focusFirstSettingsField()
    void load().then(focusFirstSettingsField)
  }
})

async function focusFirstSettingsField(): Promise<void> {
  await nextTick()
  if (!props.open) return
  const first = modalRef.value?.querySelector<HTMLInputElement>('input:not([disabled])')
  first?.focus()
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    closeSettings()
    return
  }
  if (e.key === 'Tab') {
    trap.onTab(() => modalRef.value, e)
  }
}

function selectSection(section: SectionId): void {
  if (section === active.value) return
  if (active.value === 'tags' && !props.activeSectionCanLeave) return
  active.value = section
}

function closeSettings() {
  abortConnectionTest()
  if (active.value === 'tags' && !props.activeSectionCanLeave) return
  emit('close')
}

onBeforeUnmount(() => {
  abortConnectionTest()
  void trap.deactivate()
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="settings-backdrop"
      role="presentation"
      @click.self="closeSettings"
      @keydown="onKeydown"
      tabindex="-1"
    >
      <section
        ref="modalRef"
        class="settings-modal"
        role="dialog"
        aria-modal="true"
        :aria-label="t('settings.title')"
      >
        <header class="settings-header">
          <h2>{{ t('settings.title') }}</h2>
          <NButton
            attr-type="button"
            size="small"
            quaternary
            circle
            :bordered="false"
            class="settings-icon-btn"
            :title="t('settings.close')"
            :aria-label="t('settings.close')"
            @click="closeSettings"
          ><NIcon aria-hidden="true"><X /></NIcon></NButton>
        </header>

        <div class="settings-body">
          <nav class="settings-nav" :aria-label="t('settings.title')">
            <NButton
              v-for="section in SECTIONS"
              :key="section.id"
              attr-type="button"
              size="medium"
              text
              class="settings-nav-item"
              :class="{ active: active === section.id }"
              :aria-current="active === section.id ? 'page' : undefined"
              @click="selectSection(section.id)"
            >
              <NIcon class="settings-nav-icon" aria-hidden="true"><component :is="section.icon" /></NIcon>
              <span>{{ t(section.labelKey) }}</span>
            </NButton>
          </nav>

          <div class="settings-detail" role="region" aria-live="polite">
            <SettingsAiSection
              v-if="active === 'ai'"
              :settings="settings"
              :apiKey="apiKey"
              :baseURL="baseURL"
              :model="model"
              :recoveryCode="aiErrorCode"
              :credentialStatus="credentialStatus"
              :loading="loading"
              :saving="saving"
              :connectionState="connectionState"
              :connectionResult="connectionResult"
              :connectionError="connectionError"
              @update:apiKey="updateApiKey"
              @update:baseURL="updateBaseURL"
              @update:model="updateModel"
              @save="onSave"
              @clear-key="onClearKey()"
              @forget-credential="onClearKey"
              @switch-provider="onSwitchProvider"
              @test-connection="onTestConnection"
            />
            <SettingsEditorSection v-else-if="active === 'editor'" />
            <SettingsMetadataSection
              v-else-if="active === 'metadata'"
              :migrationSummary="migrationSummary"
              :cleanupPreview="cleanupPreview"
              :cleanedPaths="cleanedPaths"
              :previewing="previewing"
              :mutatingMetadata="mutatingMetadata"
              @preview="previewCleanup"
              @restore="restoreOriginalFrontmatter"
              @remove="removeFrontmatter"
            />
            <SettingsDiaryMigrationSection v-else-if="active === 'diary-migration'" />
            <SettingsLedgerAccountIconsSection v-else-if="active === 'ledger-account-icons'" />
            <SettingsLedgerCategoriesSection v-else-if="active === 'ledger-categories'" />
            <SettingsDiaryMoodIconsSection v-else-if="active === 'diary-mood-icons'" />
            <SettingsTagsSection v-else>
              <slot name="tags" />
            </SettingsTagsSection>
          </div>
        </div>
      </section>
    </div>
  </Teleport>
</template>

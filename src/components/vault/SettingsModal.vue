<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NButton, NIcon } from 'naive-ui'
import { Book, Edit, FileText, MoodSmile, Paperclip, Robot, Tag, Wallet, X } from '@vicons/tabler'
import { useToast } from '../../composables/useToast'
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
import SettingsAttachmentManagerSection from './SettingsAttachmentManagerSection.vue'
import type { AttachmentReference } from '../../../shared/attachmentProtocol'

const props = withDefaults(defineProps<{
  open: boolean
  /** Host-level guard supplied by the active embedded Settings page. */
  activeSectionCanLeave?: boolean
}>(), {
  activeSectionCanLeave: true,
})
const emit = defineEmits<{
  close: []
  navigateReference: [reference: AttachmentReference, destination: 'owner' | 'source']
}>()

const toast = useToast()
const trap = useFocusTrap()
const { confirm } = useConfirm()
const { t } = useI18n()
const vaultContext = useOptionalVaultContext()

const aiSection = ref<InstanceType<typeof SettingsAiSection> | null>(null)
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
type SectionId = 'ai' | 'editor' | 'metadata' | 'diary-migration' | 'tags' | 'ledger-account-icons' | 'ledger-categories' | 'diary-mood-icons' | 'storage-attachments'
const SECTIONS = [
  { id: 'ai', labelKey: 'settings.ai', icon: Robot },
  { id: 'editor', labelKey: 'settings.editor', icon: Edit },
  { id: 'metadata', labelKey: 'settings.metadata', icon: FileText },
  { id: 'diary-migration', labelKey: 'settings.diary_migration', icon: Book },
  { id: 'tags', labelKey: 'settings.tags', icon: Tag },
  { id: 'ledger-account-icons', labelKey: 'settings.ledger_account_icons', icon: Wallet },
  { id: 'ledger-categories', labelKey: 'settings.ledger_categories', icon: Tag },
  { id: 'diary-mood-icons', labelKey: 'settings.diary_mood_icons', icon: MoodSmile },
  { id: 'storage-attachments', labelKey: 'settings.storage_attachments', icon: Paperclip },
] as const satisfies ReadonlyArray<{ id: SectionId; labelKey: string; icon: typeof Robot }>
const active = ref<SectionId>('ai')

async function load() {
  const migration = await getMetadataMigrationStatus().catch(() => null)
  if (!props.open) return
  migrationSummary.value = migration?.summary ?? null
  cleanedPaths.value = migration?.cleanedPaths ?? []
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

watch(() => props.open, async (open) => {
  if (open) {
    active.value = 'ai'
    trap.activate()
    void focusFirstSettingsField()
    await load()
    await focusFirstSettingsField()
  } else {
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
  if (e.defaultPrevented) return
  if (e.key === 'Escape') {
    e.preventDefault()
    closeSettings()
    return
  }
  if (e.key === 'Tab') {
    trap.onTab(() => modalRef.value, e)
  }
}

async function selectSection(section: SectionId): Promise<void> {
  if (section === active.value) return
  if (active.value === 'tags' && !props.activeSectionCanLeave) return
  if (aiSection.value && !await aiSection.value.canLeave()) return
  active.value = section
}

async function closeSettings() {
  if (active.value === 'tags' && !props.activeSectionCanLeave) return
  if (aiSection.value && !await aiSection.value.canLeave()) return
  emit('close')
}

onBeforeUnmount(() => {
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
        :class="{ 'is-attachment-manager': active === 'storage-attachments' }"
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
          <nav v-if="active !== 'storage-attachments'" class="settings-nav" :aria-label="t('settings.title')">
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
            <SettingsAttachmentManagerSection
              v-if="active === 'storage-attachments'"
              @back="active = 'ai'"
              @navigate-reference="(reference, destination) => emit('navigateReference', reference, destination)"
            />
            <SettingsAiSection v-else-if="active === 'ai'" ref="aiSection" />
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

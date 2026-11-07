<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NButton, NIcon } from 'naive-ui'
import { Book, FileText, Robot, Settings, Wallet, X } from '@vicons/tabler'
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

const CATEGORIES = {
  ai: { label: 'settings.ai', icon: Robot, sections: [{ id: 'ai', label: 'settings.ai' }] },
  note: { label: 'settings.category_note', icon: FileText, sections: [
    { id: 'editor', label: 'settings.editor' },
    { id: 'tags', label: 'settings.tags' },
  ] },
  diary: { label: 'settings.category_diary', icon: Book, sections: [
    { id: 'diary-mood-icons', label: 'settings.diary_mood_icons' },
  ] },
  ledger: { label: 'settings.category_ledger', icon: Wallet, sections: [
    { id: 'ledger-categories', label: 'settings.ledger_categories' },
    { id: 'ledger-account-icons', label: 'settings.ledger_account_icons' },
  ] },
  maintenance: { label: 'settings.category_maintenance', icon: Settings, sections: [
    { id: 'metadata', label: 'settings.metadata' },
    { id: 'storage-attachments', label: 'settings.storage_attachments' },
    { id: 'diary-migration', label: 'settings.diary_migration_nav' },
  ] },
} as const

type CategoryId = keyof typeof CATEGORIES
type SectionId = (typeof CATEGORIES)[CategoryId]['sections'][number]['id']

const activeCategory = ref<CategoryId>('ai')
const rememberedSections = ref<Partial<Record<CategoryId, SectionId>>>({})
const sections = computed(() => CATEGORIES[activeCategory.value].sections)
const active = computed(() => rememberedSections.value[activeCategory.value] ?? sections.value[0].id)
const closeButton = ref<InstanceType<typeof NButton> | null>(null)
const detailRef = ref<HTMLElement | null>(null)
let leaving = false

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

function openSettings() {
  activeCategory.value = 'ai'
  rememberedSections.value = {}
  trap.activate()
  void nextTick(() => closeButton.value?.$el.focus())
  void load()
}

watch(() => props.open, (open) => {
  if (open) openSettings()
  else void trap.deactivate()
})

onMounted(() => {
  if (props.open) openSettings()
})

async function focusAiField(): Promise<void> {
  await nextTick()
  if (!props.open || active.value !== 'ai' || document.activeElement !== closeButton.value?.$el) return
  if (window.matchMedia?.('(max-width: 600px), (pointer: coarse)').matches) return
  modalRef.value?.querySelector<HTMLInputElement>('input:not([disabled]):not([type="hidden"])')?.focus()
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

async function leaveSection(action: () => void): Promise<void> {
  const modal = modalRef.value
  if (!modal || leaving || (active.value === 'tags' && !props.activeSectionCanLeave)) return
  leaving = true
  try {
    if (aiSection.value && !await aiSection.value.canLeave()) return
    if (props.open && modalRef.value === modal) action()
  } finally {
    leaving = false
  }
}

async function navigate(category: CategoryId, section: SectionId): Promise<void> {
  if (category === activeCategory.value && section === active.value) return
  await leaveSection(() => {
    rememberedSections.value[category] = section
    activeCategory.value = category
    void nextTick(() => {
      if (detailRef.value) detailRef.value.scrollTop = 0
      const modal = modalRef.value
      if (modal && !modal.contains(document.activeElement)) {
        const target = modal.querySelector<HTMLElement>('.settings-subnav [aria-current]') ?? closeButton.value?.$el
        target?.focus()
      }
    })
  })
}

function selectCategory(category: CategoryId) {
  return navigate(category, rememberedSections.value[category] ?? CATEGORIES[category].sections[0].id)
}

function onCategoryChange(event: Event) {
  const select = event.target as HTMLSelectElement
  const category = select.value as CategoryId
  // Keep the committed selection visible if the leave guard rejects the change.
  select.value = activeCategory.value
  void selectCategory(category)
}

function closeSettings() {
  return leaveSection(() => emit('close'))
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
            ref="closeButton"
            class="settings-icon-btn"
            :title="t('settings.close')"
            :aria-label="t('settings.close')"
            @click="closeSettings"
          ><NIcon aria-hidden="true"><X /></NIcon></NButton>
        </header>

        <div class="settings-body">
          <nav v-if="active !== 'storage-attachments'" class="settings-nav" :aria-label="t('settings.title')">
            <div class="settings-category-list">
              <NButton
                v-for="(category, id) in CATEGORIES"
                :key="id"
                attr-type="button"
                text
                class="settings-nav-item"
                :class="{ active: activeCategory === id }"
                :aria-current="activeCategory === id ? 'true' : undefined"
                @click="selectCategory(id)"
              >
                <NIcon class="settings-nav-icon" aria-hidden="true"><component :is="category.icon" /></NIcon>
                <span>{{ t(category.label) }}</span>
              </NButton>
            </div>
            <select
              class="settings-category-select"
              :aria-label="t('settings.categories')"
              :value="activeCategory"
              @change="onCategoryChange"
            >
              <option v-for="(category, id) in CATEGORIES" :key="id" :value="id">{{ t(category.label) }}</option>
            </select>
          </nav>

          <div class="settings-main">
            <nav
              v-if="active !== 'storage-attachments' && sections.length > 1"
              class="settings-subnav"
              :aria-label="t(CATEGORIES[activeCategory].label)"
            >
              <NButton
                v-for="section in sections"
                :key="section.id"
                attr-type="button"
                text
                :aria-current="active === section.id ? 'page' : undefined"
                @click="navigate(activeCategory, section.id)"
              >{{ t(section.label) }}</NButton>
            </nav>
            <div ref="detailRef" class="settings-detail" role="region" aria-live="polite">
              <SettingsAttachmentManagerSection
                v-if="active === 'storage-attachments'"
                @back="navigate('maintenance', 'metadata')"
                @navigate-reference="(reference, destination) => emit('navigateReference', reference, destination)"
              />
              <SettingsAiSection v-else-if="active === 'ai'" ref="aiSection" @loaded="focusAiField" />
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
        </div>
      </section>
    </div>
  </Teleport>
</template>

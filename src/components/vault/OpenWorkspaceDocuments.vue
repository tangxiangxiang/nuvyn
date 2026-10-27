<script setup lang="ts">
import { computed, ref } from 'vue'
import type { WorkspaceTab } from './tabs'
import { deriveTabUiPresentation } from '../../composables/vault/editor-tabs/tabPresentation'
import { useI18n } from '../../composables/useI18n'

const props = defineProps<{
  tabs: WorkspaceTab[]
  activeId: string | null
}>()

const emit = defineEmits<{
  select: [id: string]
  pin: [id: string]
  close: [id: string]
}>()

const { t } = useI18n()
const expanded = ref(false)
const toggleRef = ref<HTMLButtonElement | null>(null)

const entries = computed(() => props.tabs.map((tab) => ({
  tab,
  presentation: deriveTabUiPresentation(tab, t),
  typeLabel: tab.kind === 'diff'
    ? t('workspace_tab.type_diff')
    : tab.kind === 'recovery'
      ? t('workspace_tab.type_recovery')
      : t(tab.mode === 'preview' ? 'workspace_tab.preview' : 'workspace_tab.pinned'),
})))

function focusToggle(): void {
  toggleRef.value?.focus()
}

defineExpose({ focusToggle })
</script>

<template>
  <section class="open-workspace-documents" data-testid="open-workspace-documents">
    <button
      ref="toggleRef"
      type="button"
      class="open-workspace-documents-toggle"
      :aria-expanded="expanded"
      :aria-controls="'open-workspace-documents-list'"
      @click="expanded = !expanded"
    >
      <span>{{ t('workspace_tab.open_documents') }}</span>
      <span class="open-workspace-documents-count">{{ tabs.length }}</span>
      <span class="open-workspace-documents-chevron" :class="{ expanded }" aria-hidden="true">⌄</span>
    </button>

    <ul v-if="expanded" id="open-workspace-documents-list" class="open-workspace-documents-list">
      <li
        v-for="{ tab, presentation, typeLabel } in entries"
        :key="tab.id"
        class="open-workspace-document"
        :class="{ active: tab.id === activeId, preview: tab.kind === 'document' && tab.mode === 'preview' }"
        :data-workspace-document-id="tab.id"
        :data-workspace-document-kind="tab.kind"
        :data-tab-mode="tab.kind === 'document' ? (tab.mode ?? 'pinned') : undefined"
        :data-save-status="tab.kind === 'document' ? tab.save.status : undefined"
      >
        <button
          type="button"
          class="open-workspace-document-select"
          :aria-current="tab.id === activeId ? 'page' : undefined"
          :aria-label="presentation.ariaLabel"
          @click="emit('select', tab.id)"
        >
          <span class="open-workspace-document-title">{{ presentation.displayTitle }}</span>
          <span class="open-workspace-document-meta">
            <span class="open-workspace-document-type">{{ typeLabel }}</span>
            <span
              v-if="presentation.statusText"
              class="open-workspace-document-status"
              :data-kind="presentation.statusKind"
            >{{ presentation.statusText }}</span>
          </span>
        </button>
        <button
          v-if="tab.kind === 'document' && tab.mode === 'preview'"
          type="button"
          class="open-workspace-document-action"
          :aria-label="t('workspace_tab.pin_named', { name: presentation.displayTitle })"
          :title="t('workspace_tab.pin')"
          @click.stop="emit('pin', tab.id)"
        >
          <span aria-hidden="true">⌖</span>
        </button>
        <button
          type="button"
          class="open-workspace-document-action close"
          :aria-label="t('workspace_tab.close_named', { name: presentation.displayTitle })"
          :title="t('workspace_tab.close')"
          @click.stop="emit('close', tab.id)"
        >
          <span aria-hidden="true">×</span>
        </button>
      </li>
    </ul>
  </section>
</template>

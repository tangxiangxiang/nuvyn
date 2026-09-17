<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton } from 'naive-ui'
import type { DraftRecoveryTab } from '../../composables/vault/draft-recovery/useDraftRecoveryTabs'
import { computeFileDiff } from '../../../shared/file-diff'
import { useI18n } from '../../composables/useI18n'
import ReadingPane from './ReadingPane.vue'
import HistoryUnifiedDiff from './HistoryUnifiedDiff.vue'

const props = defineProps<{ recovery: DraftRecoveryTab }>()
const emit = defineEmits<{
  'update-view': [view: 'content' | 'diff']
  'view-current': [recoveryId: string]
  discard: [recoveryId: string]
  close: [tabId: string]
}>()
const { t } = useI18n()
const heading = ref<HTMLElement | null>(null)
const diff = computed(() =>
  props.recovery.diskRaw === null
    ? null
    : computeFileDiff(props.recovery.diskRaw, props.recovery.draftRaw),
)
function focusViewer(): void {
  heading.value?.focus()
}
defineExpose({ focusViewer })
</script>

<template>
  <section class="draft-recovery-pane" :aria-label="t('draft_recovery.viewer')">
    <header class="history-viewer-header">
      <div class="history-viewer-heading">
        <h2 ref="heading" tabindex="-1">
          {{ t('draft_recovery.recovered_title', { title: recovery.documentTitle }) }}
        </h2>
        <span>{{ t('draft_recovery.local_only') }}</span>
      </div>
      <span class="history-readonly-badge">{{ t('history.read_only') }}</span>
      <div class="history-viewer-toolbar" role="toolbar" :aria-label="t('draft_recovery.toolbar')">
        <NButton
          v-if="recovery.canViewDiff && recovery.view !== 'diff'"
          attr-type="button"
          :bordered="false"
          @click="emit('update-view', 'diff')"
        >
          {{ t('draft_recovery.view_diff') }}
        </NButton>
        <NButton
          v-if="recovery.view !== 'content'"
          attr-type="button"
          :bordered="false"
          @click="emit('update-view', 'content')"
        >
          {{ t('draft_recovery.open_content') }}
        </NButton>
        <NButton
          v-if="recovery.canViewCurrent"
          attr-type="button"
          :bordered="false"
          @click="emit('view-current', recovery.recoveryId)"
        >
          {{ t('draft_recovery.view_current') }}
        </NButton>
        <NButton attr-type="button" :bordered="false" @click="emit('discard', recovery.recoveryId)">
          {{ recovery.source === 'conflict' || recovery.diskRaw === null
            ? t('draft_recovery.discard')
            : t('draft_recovery.use_disk') }}
        </NButton>
        <NButton attr-type="button" :bordered="false" @click="emit('close', recovery.tabId)">
          {{ t('draft_recovery.close') }}
        </NButton>
      </div>
    </header>
    <div class="history-viewer-meta">
      <span class="history-comparison-direction">
        <span class="history-revision-chip">{{ t('draft_recovery.disk_version') }}</span>
        <span aria-hidden="true">→</span>
        <span class="history-revision-chip">{{ t('draft_recovery.unsaved_draft') }}</span>
      </span>
      {{ recovery.documentPath }} · {{ t('draft_recovery.read_only') }}
    </div>
    <HistoryUnifiedDiff
      v-if="recovery.view === 'diff' && diff"
      :diff="diff"
      :comparison-key="`${recovery.recoveryId}\0${recovery.diskDocumentId ?? 'missing'}`"
    />
    <ReadingPane v-else :raw="recovery.draftRaw" />
  </section>
</template>

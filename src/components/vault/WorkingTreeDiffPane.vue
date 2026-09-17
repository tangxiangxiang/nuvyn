<script setup lang="ts">
import { ref } from 'vue'
import { NButton } from 'naive-ui'
import type { WorkingTreeDiff } from '../../composables/vault/useWorkingTreeDiffs'
import { useI18n } from '../../composables/useI18n'
import HistoryUnifiedDiff from './HistoryUnifiedDiff.vue'

const props = defineProps<{ diff: WorkingTreeDiff }>()
const emit = defineEmits<{ retry: [tabId: string] }>()
const { t } = useI18n()
const headingRef = ref<HTMLElement | null>(null)

function focusViewer(): void {
  headingRef.value?.focus()
}

defineExpose({ focusViewer })
</script>

<template>
  <section
    class="history-comparison-pane"
    :aria-label="t('history.working_tree_comparison_viewer')"
    :aria-busy="diff.status === 'loading' || undefined"
  >
    <header class="history-diff-header">
      <div class="history-diff-title">
        <h2 ref="headingRef" tabindex="-1">{{ diff.documentTitle }}</h2>
        <span class="history-comparison-direction">
          <span class="history-revision-chip">HEAD</span>
          <span aria-hidden="true">→</span>
          <span class="history-revision-chip">{{ t('history.working_tree') }}</span>
        </span>
      </div>
      <div v-if="diff.diff" class="history-diff-header-meta">
        <span class="history-diff-stats" :aria-label="t('history.diff_stats', { added: diff.diff.stats.added, removed: diff.diff.stats.removed })">
          <span class="is-added">+{{ diff.diff.stats.added }}</span>
          <span class="is-removed">−{{ diff.diff.stats.removed }}</span>
        </span>
      </div>
    </header>

    <div v-if="diff.status === 'loading'" class="history-diff-state" role="status">
      {{ t('history.loading_comparison') }}
    </div>
    <div v-else-if="diff.status === 'error'" class="history-diff-state history-diff-error is-error" role="alert">
      <span>{{ diff.error || t('history.working_tree_diff_load_failed') }}</span>
      <NButton attr-type="button" :bordered="false" @click="emit('retry', diff.tabId)">{{ t('history.retry') }}</NButton>
    </div>
    <div v-else-if="!diff.diff || diff.diff.ops.length === 0" class="history-diff-state">
      {{ t('history.no_working_tree_changes') }}
    </div>
    <HistoryUnifiedDiff
      v-else
      :diff="diff.diff"
      :comparison-key="diff.tabId"
    />
  </section>
</template>

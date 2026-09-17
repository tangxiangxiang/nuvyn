<script setup lang="ts">
import { NButton } from 'naive-ui'
import type { FileHistoryCommitItem, FileHistoryState } from '../../composables/vault/useFileHistory'
import type { HistoryRevisionSelection } from '../../composables/vault/useHistoryComparisons'
import { useI18n } from '../../composables/useI18n'
import TimelineFileCommitRow from './TimelineFileCommitRow.vue'
import TimelineGroup from './TimelineGroup.vue'

const props = defineProps<{
  fileHistory: FileHistoryState
  path: string | null
}>()

const emit = defineEmits<{
  'open-revision': [selection: HistoryRevisionSelection]
}>()

const { locale, t } = useI18n()

function localeCode(): string {
  return locale.value === 'zh' ? 'zh-CN' : 'en-US'
}

function clockLabel(timestamp: number): string {
  return new Intl.DateTimeFormat(localeCode(), {
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp)
}

function versionCountLabel(count: number): string {
  return t(count === 1 ? 'history.version_count_one' : 'history.version_count_many', { count })
}

function dayToggleLabel(label: string, expanded: boolean): string {
  return t(expanded ? 'history.collapse_date' : 'history.expand_date', { date: label })
}

function selectCommit(commit: FileHistoryCommitItem): void {
  const selection = props.fileHistory.selectCommit(commit)
  if (selection) emit('open-revision', selection)
}

function onTreeKeydown(event: KeyboardEvent): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  const rows = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[data-history-row]')]
  if (rows.length === 0) return
  event.preventDefault()
  const current = rows.indexOf(document.activeElement as HTMLElement)
  const next = event.key === 'ArrowDown'
    ? Math.min(current + 1, rows.length - 1)
    : Math.max(current < 0 ? rows.length - 1 : current - 1, 0)
  rows[next]?.focus()
}
</script>

<template>
  <section class="right-rail-history" :aria-label="t('rail.history')">
    <header v-if="path" class="right-rail-path-header">
      <span :title="path">{{ path }}</span>
    </header>

    <div v-if="!path" class="right-rail-history-empty right-rail-empty-state">
      {{ t('rail.history_empty') }}
    </div>

    <div v-else-if="fileHistory.error.value" class="history-error" role="alert">
      <span>{{ t('history.file_history_failed') }}</span>
      <NButton attr-type="button" :bordered="false" @click="fileHistory.refresh()">{{ t('history.retry') }}</NButton>
    </div>

    <div
      v-else-if="fileHistory.loading.value || fileHistory.target.value?.documentPath !== path"
      class="history-timeline-scroll"
      role="status"
      :aria-label="t('history.file_history_loading', { title: fileHistory.target.value?.documentTitle ?? path })"
    >
      <div class="history-skeleton">
        <span v-for="index in 5" :key="index" class="history-skeleton-row" />
      </div>
    </div>

    <div v-else-if="fileHistory.loaded.value && fileHistory.commits.value.length === 0" class="history-empty-inline">
      {{ t('history.file_history_empty') }}
    </div>

    <div v-else class="right-rail-history-scroll" role="tree" :aria-label="t('history.file_history_tree')" @keydown="onTreeKeydown">
      <TimelineGroup
        v-for="group in fileHistory.dayGroups.value"
        :key="group.key"
        :label="group.label"
        :count-label="versionCountLabel(group.commits.length)"
        :expanded="fileHistory.expandedDays.value.has(group.key)"
        :toggle-label="dayToggleLabel(group.label, fileHistory.expandedDays.value.has(group.key))"
        @toggle="fileHistory.toggleDay(group.key)"
      >
        <TimelineFileCommitRow
          v-for="item in group.commits"
          :key="item.id"
          :commit="item"
          :time-label="clockLabel(item.modifiedAt)"
          :selected="fileHistory.selectedCommitId.value === item.id"
          :can-withdraw="false"
          :open-label="`${t('history.open_file_version', { message: item.message })} (${item.shortId})`"
          @select="selectCommit(item)"
        />
      </TimelineGroup>
    </div>
  </section>
</template>

<style scoped>
.right-rail-history {
  display: flex;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
}
.right-rail-history-scroll {
  min-height: 0;
  overflow-y: auto;
  scrollbar-width: thin;
}
.right-rail-history :deep(.history-timeline-group-header) {
  padding-left: 18px;
  padding-right: 18px;
}
.right-rail-history :deep(.history-file-commit-row) {
  min-height: 32px;
  padding-left: 28px;
  padding-right: 18px;
}
.right-rail-history :deep(.history-row-copy) {
  flex-direction: row;
  align-items: baseline;
  gap: 8px;
}
.right-rail-history :deep(.history-row-title) {
  flex: 1 1 auto;
  min-width: 0;
}
.right-rail-history :deep(.history-row-meta) {
  flex: 0 0 auto;
  white-space: nowrap;
}
.right-rail-history .history-error,
.right-rail-history .history-empty-inline,
.right-rail-history .history-skeleton {
  margin: 16px 18px;
}
</style>

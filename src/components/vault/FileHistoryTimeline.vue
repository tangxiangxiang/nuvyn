<script setup lang="ts">
import { NButton } from 'naive-ui'
import type { FileHistoryCommitItem, FileHistoryState } from '../../composables/vault/useFileHistory'
import type { HistoryRevisionSelection } from '../../composables/vault/useHistoryComparisons'
import { useI18n } from '../../composables/useI18n'
import TimelineFileCommitRow from './TimelineFileCommitRow.vue'
import TimelineGroup from './TimelineGroup.vue'

const props = defineProps<{
  fileHistory: FileHistoryState
  repositoryHeadId: string | null
  withdrawAvailable: boolean
}>()

const emit = defineEmits<{
  'show-all': []
  'open-revision': [selection: HistoryRevisionSelection]
  contextmenu: [event: MouseEvent, commit: FileHistoryCommitItem]
  menukey: [event: KeyboardEvent, commit: FileHistoryCommitItem]
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

function canWithdraw(commit: FileHistoryCommitItem): boolean {
  return Boolean(props.repositoryHeadId)
    && commit.id === props.repositoryHeadId
    && props.withdrawAvailable
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
  <section class="history-timeline-section history-file-timeline" aria-labelledby="file-history-title">
    <header class="history-timeline-heading history-file-heading">
      <NButton
        attr-type="button"
        text
        :bordered="false"
        class="history-back-button"
        :aria-label="t('history.back_to_all')"
        :title="t('history.back_to_all')"
        @click="emit('show-all')"
      >
        ‹
      </NButton>
      <h2 id="file-history-title">{{ fileHistory.target.value?.documentTitle }}</h2>
    </header>

    <div v-if="fileHistory.error.value" class="history-error" role="alert">
      <span>{{ t('history.file_history_failed') }}</span>
      <NButton attr-type="button" :bordered="false" @click="fileHistory.refresh()">{{ t('history.retry') }}</NButton>
    </div>

    <div
      class="history-timeline-scroll"
      role="tree"
      :aria-label="t('history.file_history_tree')"
      @keydown="onTreeKeydown"
    >
      <div
        v-if="fileHistory.loading.value && fileHistory.commits.value.length === 0"
        class="history-skeleton"
        role="status"
        :aria-label="t('history.file_history_loading', { title: fileHistory.target.value?.documentTitle ?? '' })"
      >
        <span v-for="index in 6" :key="index" class="history-skeleton-row" />
      </div>
      <div
        v-else-if="fileHistory.loaded.value && fileHistory.commits.value.length === 0 && !fileHistory.error.value"
        class="history-empty-inline"
      >
        {{ t('history.file_history_empty') }}
      </div>
      <template v-else-if="!fileHistory.error.value">
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
            :can-withdraw="canWithdraw(item)"
            :open-label="`${t('history.open_file_version', { message: item.message })} (${item.shortId})`"
            @select="selectCommit(item)"
            @contextmenu="emit('contextmenu', $event, item)"
            @menukey="emit('menukey', $event, item)"
          />
        </TimelineGroup>
      </template>
    </div>
  </section>
</template>

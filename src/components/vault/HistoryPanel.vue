<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, toRef, watch } from 'vue'
import { NButton } from 'naive-ui'
import type { PostSummary } from '../../lib/api'
import type { HistoryState } from '../../composables/vault/useHistory'
import type { HistoryCommitState } from '../../composables/vault/useHistoryCommit'
import type { HistoryWithdrawState } from '../../composables/vault/useHistoryWithdraw'
import {
  useHistoryTimeline,
  type HistoryCommitItem,
  type HistoryFileItem,
} from '../../composables/vault/useHistoryTimeline'
import type { HistoryRevisionSelection } from '../../composables/vault/useHistoryComparisons'
import type {
  FileHistoryCommitItem,
  FileHistoryState,
} from '../../composables/vault/useFileHistory'
import type { StatusEntry } from '../../lib/history-api'
import { useI18n } from '../../composables/useI18n'
import EmptyState from './EmptyState.vue'
import HistoryChangesPanel from './HistoryChangesPanel.vue'
import FileHistoryTimeline from './FileHistoryTimeline.vue'
import TimelineCommitRow from './TimelineCommitRow.vue'
import TimelineFileRow from './TimelineFileRow.vue'
import TimelineGroup from './TimelineGroup.vue'

const props = withDefaults(defineProps<{
  history: HistoryState
  commit: HistoryCommitState
  withdraw: HistoryWithdrawState
  fileHistory?: FileHistoryState
  posts?: PostSummary[]
  activeDiffPath?: string | null
}>(), {
  posts: () => [],
  activeDiffPath: null,
})
const emit = defineEmits<{
  'open-revision': [selection: HistoryRevisionSelection]
  'open-diff': [entry: StatusEntry]
  'show-all-history': []
}>()

const h = props.history
const commit = props.commit
const { locale, t } = useI18n()
const timeline = useHistoryTimeline(h, toRef(props, 'posts'), locale)
const timelineHeading = ref<HTMLElement | null>(null)
const commitMenu = ref<HTMLElement | null>(null)
const commitMenuOpen = ref(false)
const commitMenuX = ref(0)
const commitMenuY = ref(0)
const commitMenuCommit = ref<HistoryCommitItem | FileHistoryCommitItem | null>(null)
let commitMenuOrigin: HTMLElement | null = null

const logErrorLabel = computed(() => h.logError.value?.message || t('history.load_failed'))
const repositoryHeadId = computed(() => h.log.value[0]?.sha ?? null)
const ambiguousTitles = computed(() => {
  const pathsByTitle = new Map<string, Set<string>>()
  for (const commitItem of timeline.commits.value) {
    for (const file of commitItem.files) {
      const paths = pathsByTitle.get(file.title) ?? new Set<string>()
      paths.add(file.documentPath)
      pathsByTitle.set(file.title, paths)
    }
  }
  return new Set([...pathsByTitle].filter(([, paths]) => paths.size > 1).map(([title]) => title))
})

function localeCode(): string {
  return locale.value === 'zh' ? 'zh-CN' : 'en-US'
}

function clockLabel(timestamp: number): string {
  return new Intl.DateTimeFormat(localeCode(), {
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp)
}

function commitCountLabel(count: number): string {
  return t(count === 1 ? 'history.commit_count_one' : 'history.commit_count_many', { count })
}

function fileCountLabel(count: number): string {
  return t(count === 1 ? 'history.file_count_one' : 'history.file_count_many', { count })
}

function dayToggleLabel(label: string, expanded: boolean): string {
  return t(expanded ? 'history.collapse_date' : 'history.expand_date', { date: label })
}

function commitToggleLabel(item: HistoryCommitItem, expanded: boolean): string {
  return `${t(expanded ? 'history.collapse_commit_files' : 'history.expand_commit_files', { message: item.message })} (${item.shortId})`
}

function openFile(file: HistoryFileItem, item: HistoryCommitItem): void {
  closeCommitMenu()
  emit('open-revision', timeline.selectFile(file, item))
}

function isSelected(file: HistoryFileItem, item: HistoryCommitItem): boolean {
  return timeline.selectedRevisionKey.value === `${item.id}\0${file.path}`
}

function isLatestCommit(item: { id: string }): boolean {
  return item.id === repositoryHeadId.value
}

function closeCommitMenu(restoreFocus = false): void {
  commitMenuOpen.value = false
  commitMenuCommit.value = null
  document.removeEventListener('pointerdown', onCommitMenuOutside)
  document.removeEventListener('keydown', onCommitMenuEscape)
  if (restoreFocus) commitMenuOrigin?.focus()
  if (!restoreFocus) commitMenuOrigin = null
}

function onCommitMenuOutside(event: PointerEvent): void {
  if (!commitMenu.value?.contains(event.target as Node)) closeCommitMenu()
}

function onCommitMenuEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  event.preventDefault()
  closeCommitMenu(true)
}

async function showCommitMenu(item: HistoryCommitItem | FileHistoryCommitItem, origin: HTMLElement, x: number, y: number): Promise<void> {
  closeCommitMenu()
  if (!isLatestCommit(item) || !props.withdraw.canWithdraw.value || props.withdraw.busy.value) return
  commitMenuCommit.value = item
  commitMenuOrigin = origin
  commitMenuX.value = x
  commitMenuY.value = y
  commitMenuOpen.value = true
  await nextTick()
  const menu = commitMenu.value
  if (!menu) return
  const gutter = 8
  commitMenuX.value = Math.max(gutter, Math.min(x, window.innerWidth - menu.offsetWidth - gutter))
  commitMenuY.value = Math.max(gutter, Math.min(y, window.innerHeight - menu.offsetHeight - gutter))
  menu.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  document.addEventListener('pointerdown', onCommitMenuOutside)
  document.addEventListener('keydown', onCommitMenuEscape)
}

function onCommitContextMenu(event: MouseEvent, item: HistoryCommitItem): void {
  void showCommitMenu(item, event.currentTarget as HTMLElement, event.clientX, event.clientY)
}

function onCommitMenuKeydown(event: KeyboardEvent, item: HistoryCommitItem): void {
  const origin = event.currentTarget as HTMLElement
  const rect = origin.getBoundingClientRect()
  void showCommitMenu(item, origin, rect.left + Math.min(24, rect.width / 2), rect.bottom)
}

function onFileCommitContextMenu(event: MouseEvent, item: FileHistoryCommitItem): void {
  void showCommitMenu(item, event.currentTarget as HTMLElement, event.clientX, event.clientY)
}

function onFileCommitMenuKeydown(event: KeyboardEvent, item: FileHistoryCommitItem): void {
  const origin = event.currentTarget as HTMLElement
  const rect = origin.getBoundingClientRect()
  void showCommitMenu(item, origin, rect.left + Math.min(24, rect.width / 2), rect.bottom)
}

async function showAllHistory(): Promise<void> {
  closeCommitMenu()
  emit('show-all-history')
  await nextTick()
  timelineHeading.value?.focus()
}

function withdrawCommit(): void {
  const item = commitMenuCommit.value
  closeCommitMenu()
  if (!item || !isLatestCommit(item) || !props.withdraw.canWithdraw.value || props.withdraw.busy.value) return
  void props.withdraw.withdraw(item.id)
}

function onTreeKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    ;(document.activeElement as HTMLElement | null)?.blur()
    return
  }
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

watch(commit.completionId, async () => {
  const targetPath = props.fileHistory?.target.value?.documentPath
  if (targetPath && commit.lastCommittedPaths.value.includes(`${targetPath}.md`)) {
    await props.fileHistory?.refresh()
    props.fileHistory?.expandNewestDay()
  }
  await nextTick()
  timeline.expandNewestDay()
})
watch(props.withdraw.completionId, async () => {
  closeCommitMenu()
  await props.fileHistory?.refresh()
  await nextTick()
  timelineHeading.value?.focus()
})
watch(() => h.log.value, () => closeCommitMenu())
watch(() => props.fileHistory?.target.value?.documentPath, () => closeCommitMenu())
watch(props.withdraw.busy, (busy) => {
  if (busy) closeCommitMenu()
})
onBeforeUnmount(closeCommitMenu)
</script>

<template>
  <section class="history-panel" :aria-label="t('history.title')">
    <div v-if="h.capability.value && !h.capability.value.gitAvailable" class="history-empty">
      <EmptyState size="compact" :title="t('history.git_unavailable')">
        {{ t('history.git_unavailable_body') }}
      </EmptyState>
    </div>
    <div v-else-if="h.capability.value && !h.capability.value.repoInitialized" class="history-empty">
      <EmptyState size="compact" :title="h.capability.value.initError ? t('history.vault_git_unavailable') : t('history.initializing')">
        <template v-if="h.capability.value.initError">{{ h.capability.value.initError }}</template>
      </EmptyState>
    </div>

    <template v-else>
      <HistoryChangesPanel
        :entries="h.status.value"
        :selected-paths="commit.selectedPaths.value"
        :message="commit.message.value"
        :busy="commit.busy.value"
        :mutation-locked="props.withdraw.busy.value"
        :can-commit="commit.canCommit.value"
        :error="commit.error.value"
        :posts="props.posts"
        :active-diff-path="props.activeDiffPath"
        :index-repair-pending="commit.indexRepairPaths.value.length > 0"
        :index-repair-busy="commit.indexRepairBusy.value"
        :index-repair-conflict="commit.indexRepairConflictToken.value !== null"
        @toggle="commit.toggle"
        @open-diff="emit('open-diff', $event)"
        @select-all="commit.selectAll"
        @clear-selection="commit.clearSelection"
        @update:message="commit.message.value = $event"
        @submit="commit.submit"
        @repair-index="commit.retryIndexRepair"
        @discard-index-repair="commit.discardConflictingIndexRepair"
      />
      <FileHistoryTimeline
        v-if="props.fileHistory?.target.value"
        :file-history="props.fileHistory"
        :repository-head-id="repositoryHeadId"
        :withdraw-available="props.withdraw.canWithdraw.value && !props.withdraw.busy.value"
        @show-all="showAllHistory"
        @open-revision="emit('open-revision', $event)"
        @contextmenu="onFileCommitContextMenu"
        @menukey="onFileCommitMenuKeydown"
      />
      <section v-else class="history-timeline-section" aria-labelledby="history-timeline-title">
        <div ref="timelineHeading" class="history-timeline-heading" tabindex="-1">
          <h2 id="history-timeline-title">{{ t('history.timeline') }}</h2>
        </div>
        <div v-if="h.logError.value" class="history-error" role="alert">
          <span>{{ logErrorLabel }}</span>
          <NButton attr-type="button" :bordered="false" @click="h.refreshLog()">{{ t('history.retry') }}</NButton>
        </div>
        <div
          class="history-timeline-scroll"
          role="tree"
          :aria-label="t('history.timeline_tree')"
          @keydown="onTreeKeydown"
        >
          <div v-if="timeline.loading.value || (h.logLoading.value && timeline.commits.value.length === 0)" class="history-skeleton" role="status" :aria-label="t('history.loading')">
            <span v-for="index in 7" :key="index" class="history-skeleton-row" />
          </div>
          <div v-else-if="timeline.commits.value.length === 0 && !h.logError.value" class="history-empty-inline">
            {{ t('history.no_history') }}
          </div>
          <template v-else>
            <TimelineGroup
              v-for="group in timeline.dayGroups.value"
              :key="group.key"
              :label="group.label"
              :count-label="commitCountLabel(group.commits.length)"
              :expanded="timeline.expandedDays.value.has(group.key)"
              :toggle-label="dayToggleLabel(group.label, timeline.expandedDays.value.has(group.key))"
              @toggle="timeline.toggleDay(group.key)"
            >
              <template v-for="item in group.commits" :key="item.id">
                <TimelineCommitRow
                  :commit="item"
                  :time-label="clockLabel(item.modifiedAt)"
                  :file-count-label="fileCountLabel(item.files.length)"
                  :expanded="timeline.expandedCommits.value.has(item.id)"
                  :toggle-label="commitToggleLabel(item, timeline.expandedCommits.value.has(item.id))"
                  @toggle="timeline.toggleCommit(item.id)"
                  @contextmenu="onCommitContextMenu($event, item)"
                  @menukey="onCommitMenuKeydown($event, item)"
                />
                <div v-if="timeline.expandedCommits.value.has(item.id)" class="history-file-list" role="group">
                  <TimelineFileRow
                    v-for="file in item.files"
                    :key="file.path"
                    :file="file"
                    :selected="isSelected(file, item)"
                    :show-parent="ambiguousTitles.has(file.title)"
                    @select="openFile(file, item)"
                  />
                </div>
              </template>
            </TimelineGroup>
          </template>
        </div>
      </section>
      <Teleport to="body">
        <div
          v-if="commitMenuOpen"
          ref="commitMenu"
          class="history-context-menu"
          role="menu"
          :aria-label="t(props.fileHistory?.target.value ? 'history.latest_version_actions' : 'history.latest_commit_actions')"
          :style="{ left: commitMenuX + 'px', top: commitMenuY + 'px' }"
        >
          <NButton attr-type="button" :bordered="false" role="menuitem" class="danger" @click="withdrawCommit">
            {{ t('history.withdraw_latest') }}
          </NButton>
        </div>
      </Teleport>
    </template>
  </section>
</template>

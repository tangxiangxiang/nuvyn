<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { NButton } from 'naive-ui'
import type { HistoryComparison } from '../../composables/vault/useHistoryComparisons'
import { useI18n } from '../../composables/useI18n'
import HistoryUnifiedDiff from './HistoryUnifiedDiff.vue'
import HistoryUnchangedContent from './HistoryUnchangedContent.vue'
import { formatHistoryDate } from '../../lib/history-date'

const props = defineProps<{
  comparison: HistoryComparison
  restoring?: boolean
  mutationLocked?: boolean
}>()

const emit = defineEmits<{
  restore: [comparison: HistoryComparison]
  retry: [tabId: string]
  compareWithWorkingTree: [tabId: string]
  viewCommitChanges: [tabId: string]
}>()

const { locale, t } = useI18n()
const headingRef = ref<HTMLElement | null>(null)
const menuRef = ref<HTMLElement | null>(null)
const menuButtonRef = ref<{ $el: HTMLButtonElement } | null>(null)
const menuOpen = ref(false)

const revisionTimeLabel = computed(() => formatHistoryDate(props.comparison.revisionTime, locale.value))
const beforeLabel = computed(() => (
  props.comparison.mode === 'commit-change'
    ? (props.comparison.parentRevisionId?.slice(0, 7) ?? '∅')
    : props.comparison.revisionId.slice(0, 7)
))
const beforeAccessibleLabel = computed(() => (
    props.comparison.mode === 'commit-change'
    ? (props.comparison.parentRevisionId
      ? t('history.revision_label', { sha: props.comparison.parentRevisionId })
      : t('history.empty_content'))
    : t('history.revision_label', { sha: props.comparison.revisionId })
))
const afterLabel = computed(() => (
  props.comparison.mode === 'revision-to-worktree'
    ? t('history.working_tree')
    : props.comparison.revisionId.slice(0, 7)
))
const afterAccessibleLabel = computed(() => (
  props.comparison.mode === 'revision-to-worktree'
    ? t('history.working_tree')
    : t('history.revision_label', { sha: props.comparison.revisionId })
))
const comparisonKey = computed(() => `${props.comparison.documentPath}\0${props.comparison.revisionId}`)
const stats = computed(() => props.comparison.diff?.stats ?? null)
const restoreTargetExists = computed(() => (
  props.comparison.mode === 'commit-change'
    ? props.comparison.afterExists
    : props.comparison.beforeExists
))
const canRestore = computed(() => (
  props.comparison.status === 'ready'
  && restoreTargetExists.value
  && !props.restoring
  && !props.mutationLocked
))

const errorLabel = computed(() => (
  props.comparison.error || t('history.comparison_load_failed')
))

function focusViewer(): void {
  headingRef.value?.focus()
}

function toggleMenu(): void {
  menuOpen.value = !menuOpen.value
  if (menuOpen.value) {
    void nextTick(() => {
      menuRef.value?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    })
    document.addEventListener('pointerdown', onMenuOutside)
    document.addEventListener('keydown', onMenuEscape)
  } else {
    closeMenu()
  }
}

function closeMenu(restoreFocus = false): void {
  menuOpen.value = false
  document.removeEventListener('pointerdown', onMenuOutside)
  document.removeEventListener('keydown', onMenuEscape)
  if (restoreFocus) menuButtonRef.value?.$el.focus()
}

function menuButtonElement(): HTMLButtonElement | null {
  return menuButtonRef.value?.$el ?? null
}

function onMenuOutside(event: PointerEvent): void {
  if (!menuRef.value?.contains(event.target as Node)
    && !menuButtonElement()?.contains(event.target as Node)) {
    closeMenu()
  }
}

function onMenuEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  event.preventDefault()
  closeMenu(true)
}

function restore(): void {
  closeMenu()
  emit('restore', props.comparison)
}

function compareWithWorkingTree(): void {
  closeMenu()
  emit('compareWithWorkingTree', props.comparison.tabId)
}

function viewCommitChanges(): void {
  closeMenu()
  emit('viewCommitChanges', props.comparison.tabId)
}

function retry(): void {
  emit('retry', props.comparison.tabId)
}

defineExpose({ focusViewer })
watch(() => props.comparison.status, (status) => {
  if (status !== 'ready') closeMenu()
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onMenuOutside)
  document.removeEventListener('keydown', onMenuEscape)
})
</script>

<template>
  <section
    class="history-comparison-pane"
    :class="{
      'has-summary': Boolean(comparison.summary),
    }"
    :aria-label="t('history.comparison_viewer')"
    :aria-busy="restoring || undefined"
  >
    <header class="history-diff-header">
      <div class="history-diff-title">
        <h2 ref="headingRef" tabindex="-1">{{ comparison.documentTitle }}</h2>
        <span class="history-comparison-direction">
          <span
            class="history-revision-chip"
            :aria-label="beforeAccessibleLabel"
            :title="beforeAccessibleLabel"
          >{{ beforeLabel }}</span>
          <span aria-hidden="true">→</span>
          <span
            class="history-revision-chip"
            :aria-label="afterAccessibleLabel"
            :title="afterAccessibleLabel"
          >{{ afterLabel }}</span>
        </span>
      </div>
      <div class="history-diff-header-meta">
        <span v-if="stats" class="history-diff-stats" :aria-label="t('history.diff_stats', { added: stats.added, removed: stats.removed })">
          <span class="is-added">+{{ stats.added }}</span>
          <span class="is-removed">−{{ stats.removed }}</span>
        </span>
        <NButton
          attr-type="button"
          text
          :bordered="false"
          v-if="comparison.status === 'ready'"
          ref="menuButtonRef"
          class="history-pane-menu-trigger"
          aria-haspopup="menu"
          :aria-expanded="menuOpen"
          :aria-label="t('history.more_actions')"
          @click="toggleMenu"
        >
          ⋯
        </NButton>
        <div
          v-if="menuOpen"
          ref="menuRef"
          class="history-pane-menu"
          role="menu"
          :aria-label="t('history.version_actions')"
        >
          <NButton
            attr-type="button"
            text
            :bordered="false"
            v-if="comparison.mode === 'commit-change'"
            role="menuitem"
            @click="compareWithWorkingTree"
          >
            {{ t('history.compare_with_working_tree') }}
          </NButton>
          <NButton
            attr-type="button"
            text
            :bordered="false"
            v-else
            role="menuitem"
            @click="viewCommitChanges"
          >
            {{ t('history.view_commit_changes') }}
          </NButton>
          <NButton
            attr-type="button"
            text
            :bordered="false"
            v-if="restoreTargetExists"
            role="menuitem"
            :disabled="!canRestore"
            @click="restore"
          >
            {{ t('history.restore_version_ellipsis') }}
          </NButton>
          <NButton
            attr-type="button"
            text
            :bordered="false"
            v-else
            role="menuitem"
            disabled
            class="history-pane-menu-disabled"
          >
            {{ t('history.version_deletes_file') }}
          </NButton>
        </div>
      </div>
    </header>

    <div v-if="comparison.summary" class="history-diff-summary">
      <span class="history-diff-summary-text">{{ comparison.summary }}</span>
      <span class="history-diff-summary-date">· {{ revisionTimeLabel }}</span>
    </div>

    <div v-if="comparison.status === 'loading'" class="history-diff-state" role="status">
      {{ t('history.loading_comparison') }}
    </div>
    <div
      v-else-if="comparison.status === 'error'"
      class="history-diff-state history-diff-error is-error"
      role="alert"
    >
      <span>{{ errorLabel }}</span>
      <NButton attr-type="button" :bordered="false" @click="retry">
        {{ t('history.retry') }}
      </NButton>
    </div>
    <div
      v-else-if="comparison.diff && comparison.diff.ops.length === 0"
      class="history-unchanged-view"
    >
      <div v-if="comparison.beforeRaw.length > 0" class="history-unchanged-notice" role="status">
        <span class="history-unchanged-notice-icon" aria-hidden="true">✓</span>
        <span>{{ t('history.comparison_identical') }}</span>
      </div>
      <HistoryUnchangedContent
        v-if="comparison.beforeRaw.length > 0"
        :raw="comparison.beforeRaw"
        :comparison-key="comparisonKey"
      />
      <div v-else class="history-diff-state">
        {{ t('history.both_versions_empty') }}
      </div>
    </div>
    <HistoryUnifiedDiff
      v-else-if="comparison.diff && comparison.diff.ops.length > 0"
      :diff="comparison.diff"
      :comparison-key="comparisonKey"
    />
    <div v-else class="history-diff-state">
      {{ t('history.no_comparison_changes') }}
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { NButton, NCheckbox, NIcon, NInput } from 'naive-ui'
import { Stars } from '@vicons/tabler'
import type { PostSummary } from '../../lib/api'
import type { StatusEntry } from '../../lib/history-api'
import { suggestCommitMessage } from '../../lib/ai-api'
import { useI18n } from '../../composables/useI18n'
import { useToast } from '../../composables/useToast'

const props = withDefaults(defineProps<{
  entries: StatusEntry[]
  selectedPaths: Set<string>
  message: string
  busy: boolean
  mutationLocked?: boolean
  canCommit: boolean
  error: string | null
  posts?: PostSummary[]
  activeDiffPath?: string | null
  indexRepairPending?: boolean
  indexRepairBusy?: boolean
  indexRepairConflict?: boolean
}>(), {
  indexRepairPending: false,
  indexRepairBusy: false,
  indexRepairConflict: false,
  mutationLocked: false,
  posts: () => [],
  activeDiffPath: null,
})
const emit = defineEmits<{
  toggle: [path: string]
  'open-diff': [entry: StatusEntry]
  'select-all': []
  'clear-selection': []
  'update:message': [value: string]
  submit: []
  'repair-index': []
  'discard-index-repair': []
}>()
const { locale, t } = useI18n()
const toast = useToast()
const generatingMessage = ref(false)
let generationId = 0
let generationController: AbortController | null = null
const allSelected = computed(() => (
  props.entries.length > 0 && props.entries.every((entry) => props.selectedPaths.has(entry.path))
))

function displayName(path: string): string {
  const name = path.split('/').pop() ?? path
  return name.endsWith('.md') ? name.slice(0, -3) : name
}

function displayTitle(path: string): string {
  const postPath = path.endsWith('.md') ? path.slice(0, -3) : path
  return props.posts.find((post) => post.path === postPath)?.title || displayName(path)
}

function statusKey(entry: StatusEntry): string {
  if (entry.index === '?' || entry.worktree === '?' || entry.index === 'A') return 'history.change_new'
  if (entry.index === 'D' || entry.worktree === 'D') return 'history.change_deleted'
  return 'history.change_modified'
}

function statusTone(entry: StatusEntry): 'new' | 'deleted' | 'modified' {
  if (entry.index === '?' || entry.worktree === '?' || entry.index === 'A') return 'new'
  if (entry.index === 'D' || entry.worktree === 'D') return 'deleted'
  return 'modified'
}

function onMessage(value: string): void {
  emit('update:message', value)
}

function onMessageKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || (!event.ctrlKey && !event.metaKey)) return
  event.preventDefault()
  submit()
}

function toggleAll(): void {
  if (allSelected.value) emit('clear-selection')
  else emit('select-all')
}

async function generateMessage(): Promise<void> {
  if (generatingMessage.value || props.busy || props.mutationLocked || props.selectedPaths.size === 0) return
  const currentGeneration = ++generationId
  const selectedSnapshot = [...props.selectedPaths].sort()
  const messageSnapshot = props.message
  generationController?.abort()
  const controller = new AbortController()
  generationController = controller
  generatingMessage.value = true
  try {
    const result = await suggestCommitMessage({
      paths: selectedSnapshot,
      language: locale.value,
    }, controller.signal)
    if (
      currentGeneration !== generationId
      || controller.signal.aborted
      || props.busy
      || props.mutationLocked
      || props.message !== messageSnapshot
      || JSON.stringify([...props.selectedPaths].sort()) !== JSON.stringify(selectedSnapshot)
    ) return
    const suggestion = result.message.trim()
    if (!suggestion) {
      toast.error(t('history.ai_commit_message_empty'))
      return
    }
    emit('update:message', suggestion)
  } catch (cause) {
    if (controller.signal.aborted || currentGeneration !== generationId) return
    const detail = cause instanceof Error ? cause.message : t('common.unknown_error')
    toast.error(t('history.ai_commit_message_failed', { error: detail }))
  } finally {
    if (currentGeneration === generationId) {
      generatingMessage.value = false
      generationController = null
    }
  }
}

function cancelGeneration(): void {
  generationId += 1
  generationController?.abort()
  generationController = null
  generatingMessage.value = false
}

function submit(): void {
  cancelGeneration()
  emit('submit')
}

watch(() => props.busy || props.mutationLocked, (locked) => {
  if (locked) cancelGeneration()
})

onBeforeUnmount(cancelGeneration)
</script>

<template>
  <section class="history-create-section" :aria-busy="busy || mutationLocked">
    <section class="history-changes" aria-labelledby="history-changes-title" :aria-busy="busy || mutationLocked">
      <header class="history-changes-header">
        <h2 id="history-changes-title">{{ t('history.changes') }}</h2>
        <span>{{ entries.length }}</span>
        <span class="history-changes-actions">
          <NButton attr-type="button" :bordered="false" :disabled="busy || mutationLocked || entries.length === 0" @click="toggleAll">
            {{ t(allSelected ? 'history.clear_selection' : 'history.select_all') }}
          </NButton>
        </span>
      </header>

      <div v-if="entries.length === 0" class="history-changes-empty">
        {{ t('history.no_changed_documents') }}
      </div>
      <ul v-else class="history-changes-list" :aria-label="t('history.changed_document_list')">
        <li
          v-for="entry in entries"
          :key="entry.path"
          class="history-change-row"
          :class="{ active: activeDiffPath === entry.path }"
        >
          <NCheckbox
            size="small"
            :checked="selectedPaths.has(entry.path)"
            :disabled="busy || mutationLocked"
            :aria-disabled="busy || mutationLocked ? 'true' : undefined"
            :aria-label="t('history.include_document', { path: entry.path })"
            @update:checked="emit('toggle', entry.path)"
          />
          <NButton
            attr-type="button"
            text
            :bordered="false"
            class="history-change-open"
            :class="{ active: activeDiffPath === entry.path }"
            :aria-current="activeDiffPath === entry.path ? 'true' : undefined"
            :title="entry.path"
            @click="emit('open-diff', entry)"
          >
            <span class="history-change-copy">
              <strong>{{ displayTitle(entry.path) }}</strong>
            </span>
            <span class="history-change-status" :class="`is-${statusTone(entry)}`">{{ t(statusKey(entry)) }}</span>
          </NButton>
        </li>
      </ul>
    </section>

    <section class="history-version-composer" :aria-label="t('history.version_message')">
      <div class="history-version-message-field">
        <NInput
          type="textarea"
          :autosize="{ minRows: 2, maxRows: 8 }"
          :input-props="{ id: 'history-version-message', class: 'history-version-message-input', 'aria-label': t('history.version_message') }"
          :value="message"
          :disabled="busy || mutationLocked"
          :placeholder="t('history.version_message_placeholder')"
          @update:value="onMessage"
          @keydown="onMessageKeydown"
        />
        <NButton
          attr-type="button"
          size="small"
          :bordered="false"
          class="history-generate-message"
          :disabled="busy || mutationLocked || generatingMessage || selectedPaths.size === 0"
          :aria-label="t(generatingMessage ? 'history.generating_message' : 'history.generate_message')"
          :title="t(generatingMessage ? 'history.generating_message' : 'history.generate_message')"
          @click="generateMessage"
        >
          <NIcon class="history-generate-message-icon" aria-hidden="true">
            <Stars />
          </NIcon>
          <span>{{ t(generatingMessage ? 'history.generating_message' : 'history.generate_message') }}</span>
        </NButton>
      </div>
      <div v-if="error" class="history-commit-error" role="alert">{{ error }}</div>
      <NButton
        attr-type="button"
        size="small"
        :bordered="false"
        class="history-create-version"
        :disabled="!canCommit || generatingMessage"
        @click="submit"
      >
        {{ busy ? t('history.creating_version') : t('history.create_version') }}
      </NButton>
      <span v-if="busy" class="sr-only" role="status">{{ t('history.creating_version') }}</span>
      <div v-if="indexRepairPending" class="history-commit-error" role="status">
        <span>{{ t(indexRepairConflict ? 'history.index_repair_conflict' : 'history.commit_index_refresh_failed') }}</span>
        <NButton v-if="!indexRepairConflict" attr-type="button" :bordered="false" :disabled="indexRepairBusy" @click="emit('repair-index')">
          {{ t('history.index_repair_action') }}
        </NButton>
        <NButton v-else attr-type="button" :bordered="false" :disabled="indexRepairBusy" @click="emit('discard-index-repair')">
          {{ t('history.index_repair_discard_action') }}
        </NButton>
      </div>
    </section>
  </section>
</template>

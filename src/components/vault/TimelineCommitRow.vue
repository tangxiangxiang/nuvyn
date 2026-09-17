<script setup lang="ts">
import { NButton, NIcon } from 'naive-ui'
import { ChevronRight } from '@vicons/tabler'
import type { HistoryCommitItem } from '../../composables/vault/useHistoryTimeline'

defineProps<{
  commit: HistoryCommitItem
  timeLabel: string
  fileCountLabel: string
  expanded: boolean
  toggleLabel: string
}>()

const emit = defineEmits<{
  toggle: []
  contextmenu: [event: MouseEvent]
  menukey: [event: KeyboardEvent]
}>()

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
    event.preventDefault()
    emit('menukey', event)
    return
  }
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  emit('toggle')
}
</script>

<template>
  <NButton
    attr-type="button"
    text
    :bordered="false"
    class="history-commit-row"
    :class="{ active: expanded }"
    data-history-row
    role="treeitem"
    aria-level="2"
    :aria-expanded="expanded"
    :aria-label="toggleLabel"
    @click="emit('toggle')"
    @keydown="onKeydown"
    @contextmenu.prevent="emit('contextmenu', $event)"
  >
    <NIcon class="history-disclosure" :class="{ expanded }" aria-hidden="true"><ChevronRight /></NIcon>
    <span class="history-row-title" :title="`${commit.message} · ${commit.shortId}`">{{ commit.message }}</span>
    <span class="history-row-meta">
      {{ timeLabel }} · {{ fileCountLabel }}
    </span>
  </NButton>
</template>

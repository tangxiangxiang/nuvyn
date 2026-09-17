<script setup lang="ts">
import { NButton, NIcon } from 'naive-ui'
import { History } from '@vicons/tabler'
import type { FileHistoryCommitItem } from '../../composables/vault/useFileHistory'

defineProps<{
  commit: FileHistoryCommitItem
  timeLabel: string
  selected: boolean
  canWithdraw: boolean
  openLabel: string
}>()

const emit = defineEmits<{
  select: []
  contextmenu: [event: MouseEvent]
  menukey: [event: KeyboardEvent]
}>()

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
    if (!event.currentTarget || !(event.currentTarget as HTMLElement).dataset.canWithdraw) return
    event.preventDefault()
    emit('menukey', event)
    return
  }
  if (event.key !== 'Enter') return
  event.preventDefault()
  emit('select')
}
</script>

<template>
  <NButton
    attr-type="button"
    text
    :bordered="false"
    class="history-file-commit-row"
    :class="{ selected }"
    data-history-row
    :data-can-withdraw="canWithdraw ? 'true' : undefined"
    role="treeitem"
    aria-level="2"
    :aria-selected="selected"
    :aria-label="openLabel"
    :aria-haspopup="canWithdraw ? 'menu' : undefined"
    :title="`${commit.message} · ${commit.shortId}`"
    @click="emit('select')"
    @keydown="onKeydown"
    @contextmenu.prevent="canWithdraw && emit('contextmenu', $event)"
  >
    <NIcon class="history-commit-marker" aria-hidden="true"><History /></NIcon>
    <span class="history-row-copy">
      <span class="history-row-title">{{ commit.message }}</span>
      <span class="history-row-meta">
        {{ timeLabel }}
      </span>
    </span>
  </NButton>
</template>

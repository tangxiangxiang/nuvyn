<script setup lang="ts">
import { NButton, NIcon } from 'naive-ui'
import { FileText } from '@vicons/tabler'
import type { HistoryFileItem } from '../../composables/vault/useHistoryTimeline'

defineProps<{
  file: HistoryFileItem
  selected?: boolean
  showParent?: boolean
}>()

const emit = defineEmits<{ select: [] }>()

function onKeydown(event: KeyboardEvent): void {
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
    class="history-file-row"
    :class="{ active: selected }"
    data-history-row
    role="treeitem"
    aria-level="3"
    :aria-selected="selected ? 'true' : 'false'"
    :title="file.path"
    @click="emit('select')"
    @keydown="onKeydown"
  >
    <span class="history-file-chevron-spacer" aria-hidden="true" />
    <NIcon class="history-file-icon" aria-hidden="true"><FileText /></NIcon>
    <span class="history-file-label">
      <span class="history-file-title">{{ file.title }}</span>
      <span v-if="showParent && file.parentPath" class="history-file-path">{{ file.parentPath }}/</span>
    </span>
  </NButton>
</template>

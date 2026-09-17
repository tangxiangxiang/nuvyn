<script setup lang="ts">
import { NButton, NIcon } from 'naive-ui'
import { ChevronRight } from '@vicons/tabler'

defineProps<{
  label: string
  countLabel: string
  expanded: boolean
  toggleLabel: string
}>()

const emit = defineEmits<{ toggle: [] }>()

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  emit('toggle')
}
</script>

<template>
  <section class="history-timeline-group">
    <NButton
      attr-type="button"
      text
      :bordered="false"
      class="history-timeline-group-header"
      data-history-row
      role="treeitem"
      aria-level="1"
      :aria-expanded="expanded"
      :aria-label="toggleLabel"
      @click="emit('toggle')"
      @keydown="onKeydown"
    >
      <NIcon class="history-disclosure" :class="{ expanded }" aria-hidden="true"><ChevronRight /></NIcon>
      <span class="history-timeline-group-title">{{ label }}</span>
      <span class="history-timeline-count">{{ countLabel }}</span>
    </NButton>
    <div v-if="expanded" class="history-timeline-group-items" role="group">
      <slot />
    </div>
  </section>
</template>

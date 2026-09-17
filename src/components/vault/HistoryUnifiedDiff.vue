<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { DiffOp, FileDiff } from '../../lib/history-api'
import {
  buildUnifiedDiffRows,
  type UnifiedDiffLineRow,
} from '../../lib/unified-diff'
import { useI18n } from '../../composables/useI18n'

const props = defineProps<{
  diff: FileDiff
  comparisonKey: string
}>()

const { t } = useI18n()
const scrollSurface = ref<HTMLElement | null>(null)
const rows = computed(() => buildUnifiedDiffRows(props.diff))
const lineDigits = computed(() => String(Math.max(1, ...props.diff.ops.flatMap((op) => [
  op.oldLine ?? 0,
  op.newLine ?? 0,
]))).length)

function marker(operation: UnifiedDiffLineRow['operation']): string {
  return operation === 'add' ? '+' : operation === 'remove' ? '−' : ''
}

function operationLabel(operation: UnifiedDiffLineRow['operation']): string {
  if (operation === 'add') return t('history.added_line')
  if (operation === 'remove') return t('history.removed_line')
  return t('history.unchanged_line')
}

function wordClass(word: DiffOp): string {
  return `unified-diff-word unified-diff-word-${word.op}`
}

async function scrollToFirstChange(): Promise<void> {
  await nextTick()
  scrollSurface.value?.querySelector<HTMLElement>('.unified-diff-line.is-add, .unified-diff-line.is-remove')
    ?.scrollIntoView?.({ block: 'center' })
}

watch(() => props.comparisonKey, () => {
  void scrollToFirstChange()
})
onMounted(scrollToFirstChange)
</script>

<template>
  <div
    ref="scrollSurface"
    class="unified-diff-scroll"
    role="table"
    :aria-label="t('history.unified_diff')"
    :style="{ '--diff-line-digits': lineDigits }"
    tabindex="0"
  >
    <div
      v-for="row in rows"
      :key="row.key"
      class="unified-diff-line"
      :class="`is-${row.operation}`"
      role="row"
      :aria-label="`${operationLabel(row.operation)}: ${row.text}`"
    >
      <span class="unified-diff-gutter unified-diff-old" aria-hidden="true" :data-line="row.oldLine ?? ''" />
      <span class="unified-diff-gutter unified-diff-new" aria-hidden="true" :data-line="row.newLine ?? ''" />
      <span class="unified-diff-marker" aria-hidden="true" :data-marker="marker(row.operation)" />
      <span class="unified-diff-content">
        <template v-if="row.words"><span
          v-for="(word, index) in row.words"
          :key="index"
          :class="wordClass(word)"
        >{{ word.text }}</span></template><template v-else>{{ row.text }}</template>
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '../../composables/useI18n'

const props = defineProps<{
  raw: string
  comparisonKey: string
}>()

const { t } = useI18n()
const lines = computed(() => props.raw.split('\n'))
const lineDigits = computed(() => String(Math.max(1, lines.value.length)).length)
</script>

<template>
  <div
    class="history-unchanged-content"
    role="region"
    :aria-label="t('history.unchanged_content')"
    :style="{ '--diff-line-digits': lineDigits }"
    tabindex="0"
  >
    <div
      v-for="(text, index) in lines"
      :key="`${comparisonKey}:${index}`"
      class="unified-diff-line is-equal history-unchanged-line"
    >
      <span
        class="unified-diff-gutter unified-diff-old history-unchanged-gutter history-unchanged-old"
        aria-hidden="true"
        :data-line="index + 1"
      />
      <span
        class="unified-diff-gutter unified-diff-new history-unchanged-gutter history-unchanged-new"
        aria-hidden="true"
        :data-line="index + 1"
      />
      <span
        class="unified-diff-marker history-unchanged-marker"
        aria-hidden="true"
        data-marker=""
      />
      <span class="unified-diff-content history-unchanged-line-content">{{ text }}</span>
    </div>
  </div>
</template>

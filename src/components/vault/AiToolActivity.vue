<script setup lang="ts">
import { computed } from 'vue'
import { NIcon } from 'naive-ui'
import { ChevronRight } from '@vicons/tabler'
import { toolCallStatus, type ToolCallRecord } from '../../lib/ai-api'
import { useI18n } from '../../composables/useI18n'
import AiToolCallCard from './AiToolCallCard.vue'

const props = defineProps<{ calls: ToolCallRecord[] }>()
const { t } = useI18n()
// Only known read-only tools with a successful result can be tucked away.
// Unknown tools, mutations, failures and in-flight actions remain visible.
function isQuiet(call: ToolCallRecord): boolean {
  return ['read_file', 'list_files'].includes(call.name) && toolCallStatus(call) === 'success'
}
const quietCalls = computed(() => props.calls.filter(isQuiet))
const visibleCalls = computed(() => props.calls.filter(call => !isQuiet(call)))
const summary = computed(() => {
  const documents = new Set(quietCalls.value.filter(call => call.name === 'read_file').map(call =>
    typeof call.input.path === 'string' ? call.input.path.replace(/\.md$/i, '') : call.id,
  )).size
  const lookups = quietCalls.value.filter(call => call.name === 'list_files').length
  return [
    documents ? t('ai.activity_documents', { count: documents }) : '',
    lookups ? t('ai.activity_lookups', { count: lookups }) : '',
  ].filter(Boolean).join(' · ')
})
</script>

<template>
  <div class="ai-tool-activity">
    <AiToolCallCard v-for="call in visibleCalls" :key="call.id" :call="call" />
    <details v-if="quietCalls.length" class="ai-activity-details">
      <summary class="ai-activity-summary">
        <NIcon class="ai-activity-chevron" aria-hidden="true"><ChevronRight /></NIcon>
        <span>{{ summary }}</span>
      </summary>
      <AiToolCallCard v-for="call in quietCalls" :key="call.id" :call="call" />
    </details>
  </div>
</template>

<style scoped>
.ai-activity-details { margin-top: 8px; }
.ai-activity-summary { display: flex; align-items: center; gap: 4px; padding: 3px 0; color: var(--vs-text-2, var(--text-muted)); font-size: 0.72rem; line-height: 1.5; cursor: pointer; list-style: none; }
.ai-activity-summary::-webkit-details-marker { display: none; }
.ai-activity-summary:hover { color: var(--vs-text-1, var(--text)); }
.ai-activity-summary:focus-visible { outline: 1px solid var(--vs-accent, var(--accent)); outline-offset: 2px; border-radius: 3px; }
.ai-activity-chevron { flex-shrink: 0; transition: transform 0.15s; }
.ai-activity-details[open] .ai-activity-chevron { transform: rotate(90deg); }
</style>

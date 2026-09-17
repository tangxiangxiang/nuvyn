<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NIcon, NInput } from 'naive-ui'
import { FileText } from '@vicons/tabler'
import { useI18n } from '../../composables/useI18n'

const props = defineProps<{
  paths: string[]
}>()

const emit = defineEmits<{
  select: [path: string]
  close: []
}>()

const { t } = useI18n()
const query = ref('')

const filteredPaths = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase()
  if (!needle) return props.paths
  return props.paths.filter((path) => path.toLocaleLowerCase().includes(needle))
})
</script>

<template>
  <section
    class="ai-context-picker"
    role="dialog"
    :aria-label="t('ai.choose_context')"
    @keydown.esc="emit('close')"
  >
    <header class="ai-context-picker-header">
      <span class="ai-context-picker-title">{{ t('ai.choose_context') }}</span>
      <NButton
        attr-type="button"
        text
        :bordered="false"
        class="ai-context-picker-close"
        :aria-label="t('ai.close')"
        @click="emit('close')"
      >×</NButton>
    </header>

    <NInput
      v-model:value="query"
      class="ai-context-picker-search-control"
      type="text"
      size="small"
      :bordered="false"
      :placeholder="t('ai.search_context')"
      :input-props="{ class: 'ai-context-picker-search', type: 'search', 'aria-label': t('ai.search_context') }"
    />

    <div class="ai-context-picker-list" role="listbox">
      <NButton
        v-for="path in filteredPaths"
        :key="path"
        class="ai-context-option"
        attr-type="button"
        text
        :bordered="false"
        role="option"
        @click="emit('select', path)"
      >
        <NIcon class="ai-context-option-icon" aria-hidden="true"><FileText /></NIcon>
        <span class="ai-context-option-path" :title="path">{{ path }}</span>
        <span class="ai-context-option-add" aria-hidden="true">＋</span>
      </NButton>
      <span v-if="filteredPaths.length === 0" class="ai-context-empty">
        {{ query ? t('ai.no_context_match') : t('ai.no_context_documents') }}
      </span>
    </div>
  </section>
</template>

<style scoped>
.ai-context-picker {
  position: relative;
  display: flex;
  flex-direction: column;
  width: calc(100% - 16px);
  max-height: min(300px, 42vh);
  margin: 0 8px 6px;
  box-sizing: border-box;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--vs-border) 38%, transparent);
  border-radius: 9px;
  background: var(--vs-bg-2);
  box-shadow: 0 8px 24px color-mix(in srgb, #000 28%, transparent);
}
.ai-context-picker-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 30px;
  padding: 0 8px 0 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--vs-border) 24%, transparent);
}
.ai-context-picker-title {
  color: var(--vs-text-2);
  font-size: 0.72rem;
  font-weight: 600;
}
.ai-context-picker-close {
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--vs-text-3);
  font-size: 1rem;
  line-height: 1;
  cursor: pointer;
}
.ai-context-picker-close:hover {
  background: var(--vs-hover-bg);
  color: var(--vs-text-1);
}
.ai-context-picker-search-control :deep(.ai-context-picker-search) {
  width: 100%;
  height: 27px;
  margin: 0;
  padding: 0 7px;
  box-sizing: border-box;
  border: 1px solid color-mix(in srgb, var(--vs-border) 28%, transparent);
  border-radius: 5px;
  outline: none;
  background: color-mix(in srgb, var(--vs-bg-1) 50%, transparent);
  color: var(--vs-text-1);
  font: inherit;
  font-family: var(--mono);
  font-size: 0.7rem;
}
.ai-context-picker-search-control :deep(.ai-context-picker-search:focus) {
  border-color: color-mix(in srgb, var(--vs-accent) 62%, var(--vs-border));
}
.ai-context-picker-search-control :deep(.ai-context-picker-search::placeholder) { color: var(--vs-text-3); }
.ai-context-picker-search-control {
  width: calc(100% - 12px);
  margin: 6px;
}
.ai-context-picker-list {
  min-height: 0;
  overflow-y: auto;
  padding: 0 4px 4px;
}
.ai-context-option {
  display: flex;
  align-items: center;
  width: 100%;
  min-width: 0;
  gap: 7px;
  padding: 6px 6px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--vs-text-2);
  font: inherit;
  font-family: var(--mono);
  font-size: 0.69rem;
  line-height: 1.25;
  text-align: left;
  cursor: pointer;
}
.ai-context-option:hover {
  background: var(--vs-hover-bg);
  color: var(--vs-text-1);
}
.ai-context-option-icon {
  display: inline-flex;
  flex: 0 0 auto;
  color: var(--vs-text-3);
}
.ai-context-option-icon :deep(svg) { width: 13px; height: 13px; }
.ai-context-option-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ai-context-option-add {
  flex: 0 0 auto;
  margin-left: auto;
  color: var(--vs-accent);
  font-family: var(--sans);
  font-size: 0.85rem;
  opacity: 0;
}
.ai-context-option:hover .ai-context-option-add { opacity: 1; }
.ai-context-empty {
  display: block;
  padding: 9px 7px;
  color: var(--vs-text-3);
  font-size: 0.7rem;
}
</style>

<script setup lang="ts">
defineProps<{ entries: string[]; entryIds?: string[] }>()
</script>

<template>
  <ul v-if="entries.length" class="diary-bullet-reader" data-testid="diary-bullet-reader">
    <li v-for="(entry, index) in entries" :key="entryIds?.[index] ?? index" :data-entry-id="entryIds?.[index]">
      <div class="diary-bullet-reader-text">{{ entry }}</div>
      <slot name="after-entry" :entry-id="entryIds?.[index] ?? null" :entry="entry" :index="index" />
    </li>
  </ul>
  <p v-else class="diary-empty-reading" data-testid="diary-empty-reading">今天还没有文字记录。</p>
</template>

<style scoped>
.diary-bullet-reader { margin: 0; padding-inline-start: 1.4em; list-style: disc; }
.diary-bullet-reader li { display: list-item; min-width: 0; color: var(--text); font-size: 1rem; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.diary-bullet-reader li + li { margin-block-start: 10px; }
.diary-bullet-reader li::marker { color: var(--text-muted); font-size: .8em; }
.diary-bullet-reader li :deep(.diary-attachment-section) { margin-top: 8px; }
.diary-empty-reading { margin: 0; color: var(--text-muted); line-height: 1.7; }
</style>

<script setup lang="ts">
defineProps<{ entries: string[] }>()
</script>

<template>
  <ul v-if="entries.length" class="diary-bullet-reader" data-testid="diary-bullet-reader">
    <li v-for="(entry, index) in entries" :key="index">{{ entry }}</li>
  </ul>
  <p v-else class="diary-empty-reading" data-testid="diary-empty-reading">今天还没有文字记录。</p>
</template>

<style scoped>
.diary-bullet-reader { display: flex; flex-direction: column; gap: 12px; margin: 18px 0 4px; padding-inline-start: 1.4em; }
.diary-bullet-reader li { padding-inline-start: 2px; color: var(--text); line-height: 1.75; white-space: pre-wrap; overflow-wrap: anywhere; }
.diary-bullet-reader li::marker { color: var(--text-muted); }
.diary-empty-reading { margin: 18px 0 4px; color: var(--text-muted); line-height: 1.7; }
</style>

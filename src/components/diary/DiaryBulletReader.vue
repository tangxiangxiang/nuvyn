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
.diary-bullet-reader { display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 0; list-style: none; }
.diary-bullet-reader li { min-width: 0; color: var(--text); font-size: 1rem; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.diary-empty-reading { margin: 0; color: var(--text-muted); line-height: 1.7; }
</style>

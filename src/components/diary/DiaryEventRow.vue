<script setup lang="ts">
import { eventEmojiSource } from '../../features/diary/eventEmoji'
import './diaryCloudCard.css'

defineProps<{
  title: string
  emoji: string
  singleLine?: boolean
  searchHighlighted?: boolean
}>()
</script>

<template>
  <button type="button" class="diary-event-row diary-cloud-card" :class="{ 'diary-event-row--single-line': singleLine, 'diary-event-row--search-highlight': searchHighlighted }" :data-search-highlight="searchHighlighted ? 'event' : undefined">
    <strong class="diary-event-row-heading">
      <span class="diary-event-row-emoji" aria-hidden="true">
        <img v-if="eventEmojiSource(emoji)" :src="eventEmojiSource(emoji)" alt="">
        <span v-else>{{ emoji }}</span>
      </span>
      <span class="diary-event-row-title">{{ title }}</span>
    </strong>
    <slot />
  </button>
</template>

<style scoped>
.diary-event-row {
  display: grid;
  width: 100%;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  column-gap: 8px;
  padding: 0 12px;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.diary-event-row:focus-visible { outline: none; }
.diary-event-row--search-highlight { border-color: color-mix(in srgb, var(--primary, #6366f1) 36%, var(--border, #d9dce5)); background-color: color-mix(in srgb, var(--primary, #6366f1) 13%, var(--bg)); }
.diary-event-row-heading {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
  padding-block: 13px;
  font-size: 16px;
  font-weight: 600;
}
.diary-event-row-emoji { display: grid; flex: none; place-items: center; font-size: 20px; line-height: 1; }
.diary-event-row-emoji img { width: 20px; height: 20px; object-fit: contain; }
.diary-event-row-title { min-width: 0; line-height: 20px; overflow-wrap: anywhere; }
.diary-event-row--single-line .diary-event-row-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>

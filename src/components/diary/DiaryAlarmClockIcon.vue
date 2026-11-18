<script setup lang="ts">
import { computed } from 'vue'
import { ALARM_CLOCK_ANIMATED_ASSET, ALARM_CLOCK_STATIC_ASSET } from '../../features/diary/deadlineReminderAssets'
import DiaryAnimatedEmoji from './DiaryAnimatedEmoji.vue'

const props = defineProps<{ src: string }>()
const animate = computed(() => props.src === ALARM_CLOCK_ANIMATED_ASSET)
</script>

<template>
  <DiaryAnimatedEmoji
    :animated-src="ALARM_CLOCK_ANIMATED_ASSET"
    :static-src="ALARM_CLOCK_STATIC_ASSET"
    :animate="animate"
  />
</template>

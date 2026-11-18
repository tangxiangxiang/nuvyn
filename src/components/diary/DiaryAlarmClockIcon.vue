<script setup lang="ts">
import { computed, ref } from 'vue'
import { ALARM_CLOCK_ANIMATED_ASSET, ALARM_CLOCK_STATIC_ASSET } from '../../features/diary/deadlineReminderAssets'

const props = defineProps<{ src: string }>()
const animatedAssetFailed = ref(false)
const imageSource = computed(() => animatedAssetFailed.value && props.src === ALARM_CLOCK_ANIMATED_ASSET
  ? ALARM_CLOCK_STATIC_ASSET
  : props.src)

function onImageError() {
  if (imageSource.value === ALARM_CLOCK_ANIMATED_ASSET) animatedAssetFailed.value = true
}
</script>

<template>
  <img :src="imageSource" @error="onImageError">
</template>

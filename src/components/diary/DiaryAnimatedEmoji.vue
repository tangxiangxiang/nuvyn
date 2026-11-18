<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { usePrefersReducedMotion } from '../../composables/usePrefersReducedMotion'

const props = withDefaults(defineProps<{
  animatedSrc: string | null
  staticSrc: string
  animate?: boolean
}>(), {
  animate: false,
})

const prefersReducedMotion = usePrefersReducedMotion()
const animatedAssetFailed = ref(false)
const useAnimation = computed(() => Boolean(props.animate && props.animatedSrc && !prefersReducedMotion.value))
const imageSource = computed(() => useAnimation.value && !animatedAssetFailed.value
  ? props.animatedSrc!
  : props.staticSrc)

watch(() => [props.animatedSrc, props.staticSrc, props.animate, prefersReducedMotion.value], () => {
  animatedAssetFailed.value = false
})

function onImageError() {
  if (useAnimation.value && imageSource.value === props.animatedSrc) animatedAssetFailed.value = true
}
</script>

<template>
  <img :src="imageSource" @error="onImageError">
</template>

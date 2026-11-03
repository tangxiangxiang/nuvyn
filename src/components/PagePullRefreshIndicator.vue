<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '../composables/useI18n'

const props = defineProps<{
  distance: number
  refreshing: boolean
  armed: boolean
  offset: string
  top: number
}>()
const { t } = useI18n()
const label = computed(() => props.refreshing ? t('vault.refreshing')
  : props.armed ? t('vault.release_to_refresh') : t('vault.pull_to_refresh'))
</script>

<template>
  <Teleport to="body">
    <div
      v-if="distance > 0 || refreshing"
      class="vault-tablet-refresh-indicator page-pull-refresh-indicator"
      :class="{ 'is-armed': armed, 'is-refreshing': refreshing }"
      :style="{ top: `${top}px`, '--pull-offset': offset }"
      role="status"
      :aria-label="label"
      aria-live="polite"
    >
      <span class="vault-tablet-refresh-icon" aria-hidden="true" />
      <span>{{ label }}</span>
    </div>
  </Teleport>
</template>

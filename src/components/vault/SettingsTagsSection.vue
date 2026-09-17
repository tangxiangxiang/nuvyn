<script setup lang="ts">
import { useI18n } from '../../composables/useI18n'

const { t } = useI18n()
</script>

<template>
  <section class="settings-section" aria-labelledby="settings-tags-title">
    <header class="settings-section-header">
      <div>
        <h3 id="settings-tags-title">{{ t('settings.tags') }}</h3>
        <p>{{ t('settings.tags_subtitle') }}</p>
      </div>
    </header>

    <div class="settings-section-body settings-tags-body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.settings-tags-body { gap: 0; }
</style>

<script setup lang="ts">
import { NIcon } from 'naive-ui'
import { Stars } from '@vicons/tabler'
import { useI18n } from '../../composables/useI18n'

const { t } = useI18n()
</script>

<template>
  <section class="ai-coming-soon" role="status" data-testid="ai-coming-soon">
    <NIcon class="ai-coming-soon-icon" aria-hidden="true"><Stars /></NIcon>
    <h2>{{ t('ai.coming_soon') }}</h2>
    <p>{{ t('ai.coming_soon_description') }}</p>
  </section>
</template>

<style scoped>
.ai-coming-soon {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 28px;
  overflow: hidden;
  box-sizing: border-box;
  text-align: center;
}

.ai-coming-soon-icon {
  flex: none;
  color: var(--vs-accent);
  font-size: 32px;
}

.ai-coming-soon h2 {
  margin: 0;
  color: var(--vs-text-1);
  font-size: 1.125rem;
  font-weight: 600;
}

.ai-coming-soon p {
  max-width: 32rem;
  margin: 0;
  color: var(--vs-text-2);
  font-size: 0.875rem;
  line-height: 1.6;
}
</style>

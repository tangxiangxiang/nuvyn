<script setup lang="ts">
import { computed } from 'vue'
import { NIcon } from 'naive-ui'
import { Check, ChevronRight, Circle, Clock, Rotate, X } from '@vicons/tabler'
import type { FinanceActivity } from '../../../shared/ledgerAiAnalysis'
import { useI18n } from '../../composables/useI18n'

const props = defineProps<{ activity: FinanceActivity[]; streaming: boolean }>()
const { t } = useI18n()
const operations: Record<FinanceActivity['operation'], string> = {
  accounts: 'ai.finance_accounts',
  details: 'ai.finance_details',
  cashflow: 'ai.finance_cashflow',
  spending: 'ai.finance_spending',
  trend: 'ai.finance_trend',
  repayment: 'ai.finance_repayment',
  query: 'ai.finance_query',
}
const icons = { success: Check, failed: X, cancelled: Circle, running: Clock, reused: Rotate }
const summary = computed(() => (['success', 'failed', 'cancelled', 'reused'] as const).map(status => {
  const count = props.activity.filter(item => item.status === status).length
  return count ? t(`ai.finance_activity_count_${status}`, { count }) : ''
}).filter(Boolean).join(' · '))
</script>

<template>
  <component :is="streaming ? 'div' : 'details'" class="ai-finance-activity" data-testid="finance-activity">
    <summary v-if="!streaming">
      <span>{{ summary }}</span>
      <NIcon aria-hidden="true" class="ai-finance-chevron"><ChevronRight /></NIcon>
    </summary>
    <ul>
      <li v-for="item in activity" :key="item.id" :data-status="item.status">
        <NIcon aria-hidden="true" :component="icons[item.status]" />
        <span>{{ t(operations[item.operation]) }}</span>
        <small>{{ t(`ai.finance_activity_${item.status}`) }}</small>
      </li>
    </ul>
  </component>
</template>

<style scoped>
.ai-finance-activity {
  color: var(--vs-text-2);
  font-size: 0.75rem;
  line-height: 1.5;
}
summary, li { display: flex; align-items: center; gap: 6px; }
summary { width: fit-content; min-height: 28px; cursor: pointer; list-style: none; }
summary::-webkit-details-marker { display: none; }
summary:hover { color: var(--vs-text-1); }
summary:focus-visible { outline: 1px solid var(--vs-accent); outline-offset: 2px; border-radius: 4px; }
details[open] .ai-finance-chevron { transform: rotate(90deg); }
ul { list-style: none; padding: 0; margin: 0; }
li { padding: 2px 0; }
li[data-status="running"] { color: var(--vs-accent); }
small { font-size: inherit; color: var(--vs-text-3); }
</style>

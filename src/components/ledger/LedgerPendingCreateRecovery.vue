<script setup lang="ts">
import { NAlert, NButton, NCard } from 'naive-ui'
import type { LedgerPendingCreateIntent } from '../../features/ledger/recovery'

defineProps<{
  intent: LedgerPendingCreateIntent
  busy?: boolean
  error?: string
}>()

const emit = defineEmits<{ retry: [] }>()

function operationLabel(operation: LedgerPendingCreateIntent['operation']): string {
  switch (operation) {
    case 'settings': return 'Ledger 设置'
    case 'account': return '账户'
    case 'category': return '分类'
    case 'transaction': return '交易'
  }
}
</script>

<template>
  <NCard class="ledger-recovery-card" data-testid="ledger-recovery" :bordered="false" size="small" aria-labelledby="ledger-recovery-title">
    <p class="ledger-eyebrow">需要确认</p>
    <h2 id="ledger-recovery-title">上一次{{ operationLabel(intent.operation) }}保存结果未知</h2>
    <p>
      上一次提交的结果尚未确认。为避免重复保存，已保留这次操作的原始内容；请用同一份内容安全重试。
    </p>
    <p class="ledger-recovery-detail">原始提交时间：{{ new Date(intent.createdAt).toLocaleString('zh-CN') }}</p>
    <NAlert v-if="error" class="ledger-form-error" type="error" :show-icon="false" role="alert">{{ error }}</NAlert>
    <NButton
      class="ledger-primary-button"
      attr-type="button"
      type="primary"
      size="small"
      :bordered="false"
      :disabled="busy"
      :aria-busy="busy ? 'true' : undefined"
      @click="emit('retry')"
    >
      {{ busy ? '正在确认…' : '用同一内容重试' }}
    </NButton>
  </NCard>
</template>

<style scoped>
.ledger-recovery-card {
  width: min(100%, 560px);
  box-sizing: border-box;
  border: 1px solid color-mix(in srgb, #b7791f 35%, var(--border));
  border-radius: 14px;
  background: color-mix(in srgb, #f6ad55 9%, var(--bg));
}
.ledger-recovery-card :deep(.n-card__content) { display: grid; gap: 12px; padding: 28px; }
.ledger-recovery-card h2,
.ledger-recovery-card p { margin: 0; }
.ledger-recovery-card h2 { color: var(--text-h); font-size: 1.28rem; line-height: 1.3; }
.ledger-recovery-card p:not(.ledger-eyebrow):not(.ledger-form-error):not(.ledger-recovery-detail) { color: var(--text); }
.ledger-eyebrow { color: #8a5a16; font-size: .75rem; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
.ledger-recovery-detail { color: var(--text-muted); font-size: .78rem; }
.ledger-form-error { color: #b42318; font-size: .82rem; }
.ledger-form-error :deep(.n-alert-body) { color: #b42318; }
.ledger-primary-button {
  min-height: 32px;
  padding: 6px 12px;
  border: 1px solid var(--accent);
  border-radius: 7px;
  background: var(--accent);
  color: #fff;
  font: inherit;
  font-size: .78rem;
  font-weight: 650;
  cursor: pointer;
}
.ledger-primary-button:hover:not(:disabled) { background: var(--accent-hover); }
.ledger-primary-button:disabled { cursor: wait; opacity: .65; }
@media (max-width: 560px) {
  .ledger-recovery-card :deep(.n-card__content) { padding: 22px 18px; }
}
</style>

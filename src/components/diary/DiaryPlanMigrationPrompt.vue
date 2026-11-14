<script setup lang="ts">
import { ref } from 'vue'
import { NButton, NCheckbox, NModal } from 'naive-ui'
import type { DiaryPlanMigrationStatus } from '../../../shared/diaryPlan'
import { useI18n } from '../../composables/useI18n'

defineProps<{ status: DiaryPlanMigrationStatus | null; busy: boolean; error: boolean }>()
const emit = defineEmits<{ migrate: []; reload: [] }>()
const { t } = useI18n()
const show = ref(false)
const confirmed = ref(false)

function submit() {
  if (!confirmed.value) return
  confirmed.value = false
  emit('migrate')
}
</script>

<template>
  <div v-if="status?.pending || error" class="diary-plan-migration">
    <NButton size="small" quaternary data-testid="diary-plan-migration-open" @click="show = true">
      {{ t(error || status?.failures.length ? 'diary.plan.migration_issue' : 'diary.plan.migration_title') }}
    </NButton>
    <NModal
      v-model:show="show"
      preset="card"
      :title="t('diary.plan.migration_title')"
      :aria-label="t('diary.plan.migration_title')"
      :style="{ width: 'min(480px, calc(100% - 32px))' }"
      @after-leave="confirmed = false"
    >
      <div class="diary-plan-migration-details">
        <p v-if="status" role="status">
          {{ t('diary.plan.migration_progress', { pending: String(status.pending), completed: String(status.completed) }) }}
        </p>
        <p v-if="error" role="alert">{{ t('diary.plan.migration_request_failed') }}</p>
        <ul v-if="status?.failures.length" aria-live="polite">
          <li v-for="(failure, index) in status.failures" :key="index">
            {{ failure.date ?? t('diary.plan.migration_invalid_date') }} ·
            {{ t(`diary.plan.migration_error.${failure.code}`) }}
          </li>
        </ul>
        <p v-if="status?.hasConflicts">{{ t('diary.plan.migration_conflict_help') }}</p>
        <template v-if="status?.pending">
          <p>{{ t('diary.plan.migration_notice') }}</p>
          <NCheckbox v-model:checked="confirmed" :disabled="busy">
            {{ t('diary.plan.migration_backup') }}
          </NCheckbox>
          <NButton type="primary" :loading="busy" :disabled="!confirmed || busy" @click="submit">
            {{ t(error || status.failures.length ? 'diary.plan.migration_retry' : 'diary.plan.migration_start') }}
          </NButton>
        </template>
        <NButton v-else-if="error" :disabled="busy" @click="emit('reload')">
          {{ t('diary.plan.migration_retry') }}
        </NButton>
      </div>
    </NModal>
  </div>
</template>

<style scoped>
.diary-plan-migration {
  display: flex;
  justify-content: flex-end;
  padding-inline: 12px;
}

.diary-plan-migration-details {
  display: grid;
  gap: 12px;
}

.diary-plan-migration-details p,
.diary-plan-migration-details ul {
  margin: 0;
}

.diary-plan-migration-details ul {
  max-height: 30vh;
  overflow: auto;
}
</style>

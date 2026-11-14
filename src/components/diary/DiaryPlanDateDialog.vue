<script setup lang="ts">
import { ref } from 'vue'
import { NButton, NModal } from 'naive-ui'
import { parseDiaryDate, type DiaryDate } from '../../../shared/diaryProtocol'
import { useI18n } from '../../composables/useI18n'

const props = defineProps<{ date: DiaryDate }>()
const emit = defineEmits<{ close: []; select: [date: DiaryDate] }>()
const { t } = useI18n()
const value = ref<string>(props.date)

function submit() {
  const date = parseDiaryDate(value.value)
  if (date) emit('select', date)
}
</script>

<template>
  <NModal
    :show="true"
    preset="card"
    :title="t('diary.plan.choose_date')"
    :style="{ width: 'min(360px, calc(100% - 32px))' }"
    :return-focus-on-deactivated="false"
    @update:show="(show) => { if (!show) emit('close') }"
  >
    <form class="diary-plan-date-form" @submit.prevent="submit">
      <input
        v-model="value"
        type="date"
        autofocus
        required
        min="0001-01-01"
        max="9999-12-31"
        :aria-label="t('diary.plan.choose_date')"
      >
      <NButton attr-type="submit" type="primary" :disabled="!parseDiaryDate(value)">
        {{ t('diary.plan.open_document') }}
      </NButton>
    </form>
  </NModal>
</template>

<style scoped>
.diary-plan-date-form {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.diary-plan-date-form input {
  flex: 1 1 140px;
  min-width: 0;
  min-height: 34px;
  padding-inline: 8px;
  border: 1px solid var(--vs-border, #888);
  border-radius: 6px;
  color: inherit;
  background: transparent;
  font: inherit;
}
</style>

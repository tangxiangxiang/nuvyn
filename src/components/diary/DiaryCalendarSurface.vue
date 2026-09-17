<script setup lang="ts">
import { computed, ref } from 'vue'
import type { PostSummary, TreeNode } from '../../lib/api'
import type { DiaryDate } from '../../../shared/diaryProtocol'
import type { DiaryMoodId } from '../../../shared/diaryMood'
import { useI18n } from '../../composables/useI18n'
import DiaryCalendar from './DiaryCalendar.vue'
import { projectDiaryDaysFromTree } from './diaryCalendarProjection'
import type { DiaryCalendarDay, DiaryCalendarMonth } from './diaryCalendarAdapter'

const props = withDefaults(defineProps<{
  tree: readonly TreeNode[]
  posts?: readonly PostSummary[]
  loading?: boolean
  error?: string | null
  initialMonth?: DiaryCalendarMonth
  moodBusy?: boolean
}>(), {
  posts: () => [],
  loading: false,
  error: null,
  moodBusy: false,
})

const emit = defineEmits<{
  'date-selected': [date: DiaryDate]
  'month-change': [month: DiaryCalendarMonth]
  'mood-change': [date: DiaryDate, mood: DiaryMoodId | null]
}>()

const { t } = useI18n()
const days = computed<DiaryCalendarDay[]>(() => projectDiaryDaysFromTree(props.tree, props.posts))
const calendarRef = ref<InstanceType<typeof DiaryCalendar> | null>(null)

function focusDate(date: DiaryDate): boolean {
  return calendarRef.value?.focusDate(date) ?? false
}

function closeMoodPicker(restoreFocus = true): void {
  calendarRef.value?.closeMoodPicker(restoreFocus)
}

function clearSelection(): void {
  calendarRef.value?.clearSelection()
}

function onMoodChange(date: DiaryDate, mood: DiaryMoodId | null): void {
  emit('mood-change', date, mood)
}

defineExpose({ focusDate, closeMoodPicker, clearSelection })
</script>

<template>
  <section
    class="diary-calendar-surface"
    data-testid="diary-calendar-surface"
    role="region"
    :aria-label="t('diary.surface.label')"
    :aria-busy="props.loading || undefined"
  >
    <DiaryCalendar
      ref="calendarRef"
      :days="days"
      :loading="props.loading"
      :error="props.error"
      :initial-month="props.initialMonth"
      :mood-busy="props.moodBusy"
      @date-selected="emit('date-selected', $event)"
      @month-change="emit('month-change', $event)"
      @mood-change="onMoodChange"
    />
  </section>
</template>

<style scoped>
.diary-calendar-surface {
  flex: 1 1 auto;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  position: relative;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-sizing: border-box;
  background: var(--vs-bg-1, var(--bg, #fff));
  color: var(--vs-text-1, var(--text, #1f1f1f));
}

</style>

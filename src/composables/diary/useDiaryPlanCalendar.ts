import { onScopeDispose, shallowRef, watch, type Ref } from 'vue'
import type { DiaryPlanDaySummary } from '../../../shared/diaryPlan'
import { diaryPlanApi } from '../../lib/diary-plan-api'
import type { DiaryCalendarMonth } from '../../components/diary/diaryCalendarAdapter'

export function useDiaryPlanCalendar(
  month: Ref<DiaryCalendarMonth>,
  visible: Ref<boolean>,
  unlocked: Ref<boolean>,
  accessEpoch: Ref<number | null>,
  load = diaryPlanApi.month,
) {
  const days = shallowRef<readonly DiaryPlanDaySummary[]>([])
  let pending: AbortController | undefined

  function clear() {
    pending?.abort()
    days.value = []
  }

  function refresh() {
    clear()
    if (!visible.value || !unlocked.value) return
    const request = new AbortController()
    const { year, month: number } = month.value
    const key = `${String(year).padStart(4, '0')}-${String(number).padStart(2, '0')}`
    pending = request
    void load(key, request.signal).then((result) => {
      if (!request.signal.aborted) days.value = result
    }).catch(() => { /* Summaries are optional; the date still opens normally. */ })
  }

  watch([month, visible, unlocked, accessEpoch], refresh, { immediate: true, flush: 'sync' })
  onScopeDispose(clear)
  return { days, clear, refresh }
}

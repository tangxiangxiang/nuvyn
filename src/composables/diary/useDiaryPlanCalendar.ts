import { computed, onScopeDispose, shallowReactive, watch, type Ref } from 'vue'
import type { DiaryPlanDaySummary } from '../../../shared/diaryPlan'
import type { DiaryDate } from '../../../shared/diaryProtocol'
import { diaryPlanApi } from '../../lib/diary-plan-api'
import type { DiaryCalendarMonth } from '../../components/diary/diaryCalendarAdapter'

export function useDiaryPlanCalendar(
  month: Ref<DiaryCalendarMonth>,
  visible: Ref<boolean>,
  unlocked: Ref<boolean>,
  accessEpoch: Ref<number | null>,
  load = diaryPlanApi.month,
) {
  const cache = shallowReactive(new Map<string, readonly DiaryPlanDaySummary[]>())
  const staleMonths = new Set<string>()
  const changedDays = shallowReactive(new Map<DiaryDate, DiaryPlanDaySummary>())
  const key = computed(() => (
    `${String(month.value.year).padStart(4, '0')}-${String(month.value.month).padStart(2, '0')}`
  ))
  let pending: AbortController | undefined

  function refresh() {
    pending?.abort()
    if (!unlocked.value || !visible.value || (cache.has(key.value) && !staleMonths.has(key.value))) return
    const request = new AbortController()
    const requestedMonth = key.value
    pending = request
    void load(requestedMonth, request.signal).then((days) => {
      if (!request.signal.aborted && unlocked.value && key.value === requestedMonth) {
        if (cache.size >= 12 && !cache.has(requestedMonth)) {
          const oldest = cache.keys().next().value!
          cache.delete(oldest)
          staleMonths.delete(oldest)
        }
        cache.set(requestedMonth, days)
        staleMonths.delete(requestedMonth)
        for (const date of changedDays.keys()) {
          if (date.startsWith(requestedMonth)) changedDays.delete(date)
        }
      }
    }).catch(() => { /* Plan summaries never block Diary. */ })
  }

  function clear() {
    pending?.abort()
    cache.clear()
    staleMonths.clear()
    changedDays.clear()
  }

  function updateDay(date: DiaryDate, summary?: DiaryPlanDaySummary) {
    if (summary) {
      if (changedDays.size >= 42 && !changedDays.has(date)) changedDays.delete(changedDays.keys().next().value!)
      changedDays.set(date, summary)
    }
    const monthKey = date.slice(0, 7)
    if (key.value === monthKey) {
      if (cache.has(monthKey)) staleMonths.add(monthKey)
      refresh()
    } else {
      cache.delete(monthKey)
      staleMonths.delete(monthKey)
    }
  }

  watch([key, visible, unlocked], () => {
    if (!unlocked.value || !visible.value) clear()
    else refresh()
  }, { immediate: true, flush: 'sync' })
  watch(accessEpoch, () => {
    clear()
    refresh()
  })
  onScopeDispose(clear)

  return {
    days: computed(() => {
      if (!unlocked.value || !visible.value) return []
      const days = new Map(cache.get(key.value)?.map((day) => [day.date, day]))
      for (const [date, day] of changedDays) {
        if (day.total) days.set(date, day)
        else days.delete(date)
      }
      return [...days.values()]
    }),
    updateDay,
    clear,
    refresh,
  }
}

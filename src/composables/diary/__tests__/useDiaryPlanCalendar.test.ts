import { effectScope, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { parseDiaryDate } from '../../../../shared/diaryProtocol'
import type { DiaryPlanDaySummary } from '../../../../shared/diaryPlan'
import { useDiaryPlanCalendar } from '../useDiaryPlanCalendar'

describe('Diary Plan calendar summaries', () => {
  it('discards out-of-order months, reloads on calendar return and clears pending work on lock', async () => {
    const queries: Array<{ month: string; done: (days: DiaryPlanDaySummary[]) => void }> = []
    const load = vi.fn((month: string) => new Promise<DiaryPlanDaySummary[]>((done) => queries.push({ month, done })))
    const scope = effectScope()
    const active = ref({ year: 2032, month: 1 })
    const unlocked = ref(true)
    const visible = ref(true)
    const plans = scope.run(() => useDiaryPlanCalendar(active, visible, unlocked, ref(1), load))!
    const day = { date: parseDiaryDate('2032-03-01')!, total: 2, completed: 1 }
    try {
      active.value = { year: 2032, month: 2 }
      active.value = { year: 2032, month: 3 }
      expect(queries.map((query) => query.month)).toEqual(['2032-01', '2032-02', '2032-03'])
      queries[2]!.done([day])
      queries[1]!.done([])
      queries[0]!.done([])
      await Promise.resolve()
      expect(plans.days.value).toEqual([day])
      visible.value = false
      expect(plans.days.value).toEqual([])
      visible.value = true
      expect(load).toHaveBeenCalledTimes(4)
      queries[3]!.done([{ ...day, completed: 2 }])
      await Promise.resolve()
      expect(plans.days.value).toEqual([{ ...day, completed: 2 }])
      plans.refresh()
      unlocked.value = false
      queries[4]!.done([day])
      await Promise.resolve()
      expect(plans.days.value).toEqual([])
      unlocked.value = true
      expect(load).toHaveBeenCalledTimes(6)
    } finally {
      scope.stop()
    }
  })
})

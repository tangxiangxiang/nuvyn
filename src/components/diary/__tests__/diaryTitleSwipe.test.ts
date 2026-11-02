import { describe, expect, it } from 'vitest'
import { parseDiaryDate } from '../../../../shared/diaryProtocol'
import { adjacentDiaryDate, diaryTitleSwipeDirection } from '../diaryTitleSwipe'

function date(value: string) {
  const parsed = parseDiaryDate(value)
  if (!parsed) throw new Error(value)
  return parsed
}

describe('Diary title swipe navigation', () => {
  it('recognizes intentional right/left motions without treating vertical or long touches as navigation', () => {
    expect(diaryTitleSwipeDirection({ deltaX: 82, deltaY: 9, durationMs: 220 })).toBe('previous')
    expect(diaryTitleSwipeDirection({ deltaX: -82, deltaY: 9, durationMs: 220 })).toBe('next')
    expect(diaryTitleSwipeDirection({ deltaX: 54, deltaY: 0, durationMs: 200 })).toBeNull()
    expect(diaryTitleSwipeDirection({ deltaX: 84, deltaY: 68, durationMs: 200 })).toBeNull()
    expect(diaryTitleSwipeDirection({ deltaX: 84, deltaY: 2, durationMs: 900 })).toBeNull()
    expect(diaryTitleSwipeDirection({ deltaX: 0, deltaY: 120, durationMs: 200 })).toBeNull()
  })

  it('skips dates with no document and stops at either end', () => {
    const a = date('2026-10-26')
    const b = date('2026-10-30')
    const c = date('2026-11-02')
    const dates = [c, a, b, b]
    expect(adjacentDiaryDate(dates, c, 'previous')).toBe(b)
    expect(adjacentDiaryDate(dates, b, 'previous')).toBe(a)
    expect(adjacentDiaryDate(dates, b, 'next')).toBe(c)
    expect(adjacentDiaryDate(dates, a, 'previous')).toBeNull()
    expect(adjacentDiaryDate(dates, c, 'next')).toBeNull()
    expect(adjacentDiaryDate(dates, date('2026-11-01'), 'previous')).toBeNull()
  })
})

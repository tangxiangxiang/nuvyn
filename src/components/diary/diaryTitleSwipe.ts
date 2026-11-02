import type { DiaryDate } from '../../../shared/diaryProtocol'

export type DiarySwipeDirection = 'previous' | 'next'

/** Only a deliberate, quick horizontal motion can navigate; vertical
 * scrolling, taps, diagonals and long presses never qualify. */
export function diaryTitleSwipeDirection(motion: {
  deltaX: number
  deltaY: number
  durationMs: number
}): DiarySwipeDirection | null {
  const { deltaX, deltaY, durationMs } = motion
  if (durationMs < 0 || durationMs > 850) return null
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return null
  if (Math.abs(deltaX) < 64 || Math.abs(deltaX) < Math.abs(deltaY) * 1.5) return null
  return deltaX > 0 ? 'previous' : 'next'
}

/** Navigation is among *existing* managed Diary dates; never synthesize
 * missing dates or use local/UTC day arithmetic to infer an entry. */
export function adjacentDiaryDate(
  dates: readonly DiaryDate[],
  current: DiaryDate,
  direction: DiarySwipeDirection,
): DiaryDate | null {
  const sorted = [...new Set(dates)].sort()
  const index = sorted.indexOf(current)
  if (index < 0) return null
  return sorted[index + (direction === 'previous' ? -1 : 1)] ?? null
}

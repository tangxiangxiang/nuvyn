import type { DeadlineVisualState, TodoDayVisualState } from './deadlineVisualState'

export const STOPWATCH_ASSET = '/emoji/stopwatch.svg'
export const ALARM_CLOCK_ANIMATED_ASSET = '/emoji/alarm-clock-animated.png'
export const ALARM_CLOCK_STATIC_ASSET = '/emoji/alarm-clock.svg'
export const BOMB_ANIMATED_ASSET = '/emoji/bomb-animated.png'
export const BOMB_STATIC_ASSET = '/emoji/bomb.svg'
export const PARTY_POPPER_ASSET = '/emoji/party-popper.svg'

export interface TodoDayMarkerAssets {
  animatedSrc: string | null
  staticSrc: string
}

export function alarmClockAsset(prefersReducedMotion: boolean): string {
  return prefersReducedMotion ? ALARM_CLOCK_STATIC_ASSET : ALARM_CLOCK_ANIMATED_ASSET
}

export function taskDeadlineAsset(state: DeadlineVisualState, prefersReducedMotion: boolean): string {
  if (state === 'due-soon') return alarmClockAsset(prefersReducedMotion)
  if (state === 'overdue') return ALARM_CLOCK_STATIC_ASSET
  return STOPWATCH_ASSET
}

export function taskDeadlineReminderAsset(state: DeadlineVisualState, prefersReducedMotion: boolean): string | null {
  if (state === 'due-soon') return alarmClockAsset(prefersReducedMotion)
  if (state === 'overdue') return ALARM_CLOCK_STATIC_ASSET
  return null
}

export function todoDayMarkerAssets(state: TodoDayVisualState): TodoDayMarkerAssets | null {
  if (state === 'pending') return { animatedSrc: null, staticSrc: STOPWATCH_ASSET }
  if (state === 'due-soon') return { animatedSrc: ALARM_CLOCK_ANIMATED_ASSET, staticSrc: ALARM_CLOCK_STATIC_ASSET }
  if (state === 'overdue') return { animatedSrc: BOMB_ANIMATED_ASSET, staticSrc: BOMB_STATIC_ASSET }
  if (state === 'completed' || state === 'completed-late') return { animatedSrc: null, staticSrc: PARTY_POPPER_ASSET }
  return null
}

/** Only dates inside the currently viewed calendar month may animate. */
export function shouldAnimateTodoDayMarker(date: string, displayedMonth: string, today: string): boolean {
  const currentMonth = today.slice(0, 7)
  return displayedMonth.slice(0, 7) === currentMonth && date.slice(0, 7) === currentMonth
}

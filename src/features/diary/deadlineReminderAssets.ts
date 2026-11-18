import type { DeadlineVisualState } from './deadlineVisualState'

export const STOPWATCH_ASSET = '/emoji/stopwatch.svg'
export const ALARM_CLOCK_ANIMATED_ASSET = '/emoji/alarm-clock-animated.png'
export const ALARM_CLOCK_STATIC_ASSET = '/emoji/alarm-clock.svg'

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

import type { DeadlineVisualState } from './deadlineVisualState'

export const STOPWATCH_ASSET = '/emoji/stopwatch.svg'
export const ALARM_CLOCK_ANIMATED_ASSET = '/emoji/alarm-clock-animated.png'
export const ALARM_CLOCK_STATIC_ASSET = '/emoji/alarm-clock.svg'

export function alarmClockAsset(prefersReducedMotion: boolean): string {
  return prefersReducedMotion ? ALARM_CLOCK_STATIC_ASSET : ALARM_CLOCK_ANIMATED_ASSET
}

export function taskDeadlineAsset(state: DeadlineVisualState, prefersReducedMotion: boolean): string {
  return state === 'due-soon' || state === 'overdue'
    ? alarmClockAsset(prefersReducedMotion)
    : STOPWATCH_ASSET
}

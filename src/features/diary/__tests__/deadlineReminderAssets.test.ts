import { describe, expect, it } from 'vitest'
import {
  ALARM_CLOCK_ANIMATED_ASSET,
  ALARM_CLOCK_STATIC_ASSET,
  BOMB_ANIMATED_ASSET,
  BOMB_STATIC_ASSET,
  PARTY_POPPER_ASSET,
  STOPWATCH_ASSET,
  shouldAnimateTodoDayMarker,
  todoDayMarkerAssets,
} from '../deadlineReminderAssets'

describe('Diary Todo day marker assets', () => {
  it('maps each derived state to a single Fluent Emoji asset', () => {
    expect(todoDayMarkerAssets('none')).toBeNull()
    expect(todoDayMarkerAssets('pending')).toEqual({ animatedSrc: null, staticSrc: STOPWATCH_ASSET })
    expect(todoDayMarkerAssets('due-soon')).toEqual({ animatedSrc: ALARM_CLOCK_ANIMATED_ASSET, staticSrc: ALARM_CLOCK_STATIC_ASSET })
    expect(todoDayMarkerAssets('overdue')).toEqual({ animatedSrc: BOMB_ANIMATED_ASSET, staticSrc: BOMB_STATIC_ASSET })
    expect(todoDayMarkerAssets('completed')).toEqual({ animatedSrc: null, staticSrc: PARTY_POPPER_ASSET })
    expect(todoDayMarkerAssets('completed-late')).toEqual({ animatedSrc: null, staticSrc: PARTY_POPPER_ASSET })
  })

  it('allows animation only for dates inside the currently viewed current month', () => {
    expect(shouldAnimateTodoDayMarker('2026-11-17', '2026-11-01', '2026-11-18')).toBe(true)
    expect(shouldAnimateTodoDayMarker('2026-11-19', '2026-11-01', '2026-11-18')).toBe(true)
    expect(shouldAnimateTodoDayMarker('2026-10-31', '2026-11-01', '2026-11-18')).toBe(false)
    expect(shouldAnimateTodoDayMarker('2026-10-17', '2026-10-01', '2026-11-18')).toBe(false)
    expect(shouldAnimateTodoDayMarker('2026-12-19', '2026-12-01', '2026-11-18')).toBe(false)
  })
})

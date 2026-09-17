import type { Locator, Page } from '@playwright/test'

/**
 * Calendar E2E time contract. The browser clock is fixed before the
 * application is first navigated so Calendar's local `new Date()` reads are
 * independent of the runner's wall clock.
 */
export const CALENDAR_TEST_TIME_ZONE = 'Asia/Shanghai'
export const CALENDAR_TEST_NOW = '2026-08-15T12:00:00+08:00'
export const CALENDAR_TEST_DATE = '2026-08-15'
export const CALENDAR_TEST_MONTH = CALENDAR_TEST_DATE.slice(0, 7)

/**
 * Freeze only the browser-observed time. Playwright keeps timers progressing
 * normally, so UI transitions and network/bootstrap logic retain their real
 * behavior while Date/Date.now stay deterministic.
 */
export async function freezeCalendarClock(
  page: Page,
  time: string = CALENDAR_TEST_NOW,
): Promise<void> {
  await page.clock.setFixedTime(time)
}

/**
 * Return a date button from the currently rendered Naive UI Calendar.
 * DiaryCalendar exposes the canonical civil date so callers do not depend on
 * the calendar library's internal cell structure.
 */
export function calendarDay(calendar: Locator, date: string): Locator {
  return calendar.locator(`[data-diary-day-content][data-date="${date}"]`)
}

export function calendarMoodButton(calendar: Locator, date: string): Locator {
  return calendar.locator(`[data-testid="diary-calendar-mood"][data-date="${date}"]`)
}

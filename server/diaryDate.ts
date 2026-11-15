import { Temporal } from '@js-temporal/polyfill'

export function diaryToday(): string {
  return Temporal.Instant.fromEpochMilliseconds(Date.now())
    .toZonedDateTimeISO(Temporal.Now.timeZoneId())
    .toPlainDate()
    .toString()
}

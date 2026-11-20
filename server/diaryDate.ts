import { Temporal } from '@js-temporal/polyfill'

export const DIARY_TIME_ZONE_HEADER = 'X-Diary-Time-Zone'
export const LEGACY_DIARY_TIME_ZONE = 'UTC'

// Keep Diary's timezone validation independent of Ledger's account settings.
// This grammar rejects fixed offsets before Temporal validates the IANA name.
const IANA_TIME_ZONE_ID_RE = /^[A-Za-z_][A-Za-z0-9_.+-]*(?:\/[A-Za-z0-9_.+-]+)*$/

export function resolveDiaryTimeZone(value: string | undefined): string | null {
  // Older clients have no timezone header. UTC is a stable, container-neutral
  // compatibility default; never infer a date boundary from the host TZ.
  if (value === undefined) return LEGACY_DIARY_TIME_ZONE
  if (!IANA_TIME_ZONE_ID_RE.test(value)) return null
  try {
    Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(value)
    return value
  } catch {
    return null
  }
}

export function diaryToday(timeZone = LEGACY_DIARY_TIME_ZONE, now = Date.now()): string {
  return Temporal.Instant.fromEpochMilliseconds(now)
    .toZonedDateTimeISO(timeZone)
    .toPlainDate()
    .toString()
}

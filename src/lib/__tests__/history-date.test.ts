import { describe, expect, it } from 'vitest'
import { formatHistoryDate, historyLocale } from '../history-date'

describe('History date formatting', () => {
  it('uses the application locale instead of the browser default', () => {
    const timestamp = new Date(2026, 6, 15, 10, 31).getTime()
    expect(historyLocale('zh')).toBe('zh-CN')
    expect(historyLocale('en')).toBe('en-US')
    expect(formatHistoryDate(timestamp, 'zh')).toContain('2026年7月15日')
    expect(formatHistoryDate(timestamp, 'en')).toContain('Jul 15, 2026')
  })
})

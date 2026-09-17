import { describe, expect, it } from 'vitest'
import {
  classifyDiaryPath,
  diaryDateFromPath,
  diaryLogicalPathForDate,
  isDiaryRoot,
  isManagedDiaryPath,
  isValidDiaryDate,
  parseDiaryDate,
} from '../diaryProtocol'

describe('Diary date protocol', () => {
  it.each([
    '2026-08-24',
    '2024-02-29',
    '2000-02-29',
  ])('accepts valid calendar date %s', (value) => {
    expect(isValidDiaryDate(value)).toBe(true)
    expect(parseDiaryDate(value)).toBe(value)
  })

  it.each([
    '2026-02-29',
    '1900-02-29',
    '2026-02-30',
    '2026-02-31',
    '2026-04-31',
    '2026-13-01',
    '2026-00-10',
    '2026-01-00',
    '2026-8-24',
    '26-08-24',
    '2026/08/24',
    '2026-08-24-extra',
    'foo',
    '',
  ])('rejects invalid calendar date %s', (value) => {
    expect(isValidDiaryDate(value)).toBe(false)
    expect(parseDiaryDate(value)).toBeNull()
  })

  it('keeps date identity local and maps it without UTC conversion', () => {
    const date = parseDiaryDate('2026-08-24')!
    const logicalPath = diaryLogicalPathForDate(date)

    expect(logicalPath).toBe('diary/2026-08-24')
    expect(diaryDateFromPath(logicalPath)).toBe(date)
    expect(diaryLogicalPathForDate(diaryDateFromPath(logicalPath)!)).toBe(logicalPath)
  })
})

describe('Diary path protocol', () => {
  it('classifies the fixed root', () => {
    expect(isDiaryRoot('diary')).toBe(true)
    expect(classifyDiaryPath('diary')).toBe('root')
  })

  it.each([
    'diary/2026-08-24',
    'diary/2024-02-29',
  ])('classifies %s as managed content', (path) => {
    expect(isManagedDiaryPath(path)).toBe(true)
    expect(classifyDiaryPath(path)).toBe('managed')
  })

  it.each([
    'diary/foo',
    'diary/2026-02-31',
    'diary/2026-8-24',
    'diary/foo/bar',
    'diary/2026/08/24',
    'diary/.hidden',
    'diary/2026-08-24/child',
  ])('classifies invalid content %s as unmanaged', (path) => {
    expect(isManagedDiaryPath(path)).toBe(false)
    expect(classifyDiaryPath(path)).toBe('unmanaged')
  })

  it('does not create a second identity for a physical .md spelling', () => {
    expect(diaryDateFromPath('diary/2026-08-24.md')).toBeNull()
    expect(classifyDiaryPath('diary/2026-08-24.md')).toBe('unmanaged')
  })

  it.each([
    'inbox/foo',
    'literature/bar',
    'archive/abc',
    'ledger/foo',
  ])('classifies outside path %s as outside Diary', (path) => {
    expect(classifyDiaryPath(path)).toBe('outside')
    expect(isManagedDiaryPath(path)).toBe(false)
  })
})

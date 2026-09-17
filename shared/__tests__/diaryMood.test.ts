import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { getMoodDefinition, isMoodId, MOOD_CATALOG } from '../diaryMood'

describe('D7 Diary Mood registry', () => {
  it('freezes the 24-item row-major 4-column by 6-row catalog', () => {
    expect(MOOD_CATALOG).toHaveLength(24)
    expect(MOOD_CATALOG.map((mood) => mood.id)).toEqual([
      'kiss', 'sad', 'surprised-big', 'surprised-small',
      'watching', 'like', 'laughing', 'disappointed',
      'afraid', 'shy', 'happy', 'smiling',
      'amazed', 'angry', 'flirty', 'speechless',
      'dizzy', 'indignant', 'frowning', 'mysterious',
      'laughing-tears', 'playful', 'unwell', 'devilish',
    ])
    expect(MOOD_CATALOG.every((mood) => mood.column >= 1 && mood.column <= 4)).toBe(true)
    expect(MOOD_CATALOG.every((mood) => mood.row >= 1 && mood.row <= 6)).toBe(true)
    expect(new Set(MOOD_CATALOG.map((mood) => `${mood.row}:${mood.column}`)).size).toBe(24)
  })

  it('maps every stable ID to its real repository asset and accessible labels', () => {
    for (const mood of MOOD_CATALOG) {
      expect(isMoodId(mood.id)).toBe(true)
      expect(getMoodDefinition(mood.id)).toEqual(mood)
      expect(mood.zhLabel).not.toBe('')
      expect(mood.enLabel).not.toBe('')
      expect(mood.accessibilityName).toContain(mood.enLabel)
      expect(existsSync(path.resolve(process.cwd(), mood.asset))).toBe(true)
    }
    expect(isMoodId('future-mood')).toBe(false)
    expect(getMoodDefinition('future-mood')).toBeUndefined()
  })
})

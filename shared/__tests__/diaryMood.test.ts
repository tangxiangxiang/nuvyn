import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { getMoodDefinition, isMoodId, MOOD_CATALOG } from '../diaryMood'

describe('D7 Diary Mood registry', () => {
  it('keeps the original 24 stable mood IDs and extends the catalog to 48 Fluent icons', () => {
    expect(MOOD_CATALOG).toHaveLength(48)
    expect(MOOD_CATALOG.slice(0, 24).map((mood) => mood.id)).toEqual([
      'kiss', 'sad', 'surprised-big', 'surprised-small',
      'watching', 'like', 'laughing', 'disappointed',
      'afraid', 'shy', 'happy', 'smiling',
      'amazed', 'angry', 'flirty', 'speechless',
      'dizzy', 'indignant', 'frowning', 'mysterious',
      'laughing-tears', 'playful', 'unwell', 'devilish',
    ])
    expect(MOOD_CATALOG.slice(24).map((mood) => mood.id)).toEqual([
      'relieved',
      'thinking',
      'confused',
      'worried',
      'anxious',
      'tired',
      'sleepy',
      'sleeping',
      'yawning',
      'crying',
      'teary',
      'touched',
      'in-love',
      'celebrating',
      'cool',
      'silly',
      'awkward',
      'eye-roll',
      'neutral',
      'melting',
      'terrified',
      'sweating',
      'comforted',
      'pleading',
    ])
    expect(MOOD_CATALOG.every((mood) => mood.column >= 1 && mood.column <= 4)).toBe(true)
    expect(MOOD_CATALOG.every((mood) => mood.row >= 1 && mood.row <= 12)).toBe(true)
    expect(new Set(MOOD_CATALOG.map((mood) => `${mood.row}:${mood.column}`)).size).toBe(48)
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

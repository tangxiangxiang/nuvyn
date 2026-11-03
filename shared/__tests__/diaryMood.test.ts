import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { getMoodDefinition, isMoodId, MOOD_CATALOG } from '../diaryMood'

describe('D7 Diary Mood registry', () => {
  it('keeps the original 48 stable mood IDs and extends the catalog to 76 Fluent icons', () => {
    expect(MOOD_CATALOG).toHaveLength(76)
    expect(MOOD_CATALOG.slice(0, 24).map((mood) => mood.id)).toEqual([
      'kiss', 'sad', 'surprised-big', 'surprised-small',
      'watching', 'like', 'laughing', 'disappointed',
      'afraid', 'shy', 'happy', 'smiling',
      'amazed', 'angry', 'flirty', 'speechless',
      'dizzy', 'indignant', 'frowning', 'mysterious',
      'laughing-tears', 'playful', 'unwell', 'devilish',
    ])
    expect(MOOD_CATALOG.slice(24, 48).map((mood) => mood.id)).toEqual([
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
    expect(MOOD_CATALOG.slice(48).map((mood) => mood.id)).toEqual([
      'pensive',
      'unamused',
      'persevering',
      'downcast',
      'clouded',
      'invisible',
      'skeptical',
      'zipper',
      'delicious',
      'drooling',
      'nerdy',
      'woozy',
      'hot',
      'cold',
      'sick',
      'sneezing',
      'upside-down',
      'giggle',
      'salute',
      'cowboy',
      'disguise',
      'rofl',
      'silent',
      'uncertain',
      'exhale',
      'monocle',
      'halo',
      'beam',
    ])
    expect(MOOD_CATALOG.every((mood) => mood.column >= 1 && mood.column <= 4)).toBe(true)
    expect(MOOD_CATALOG.every((mood) => mood.row >= 1 && mood.row <= 19)).toBe(true)
    expect(new Set(MOOD_CATALOG.map((mood) => `${mood.row}:${mood.column}`)).size).toBe(76)
  })

  it('uses natural emotion names while preserving surprise mood IDs and image paths', () => {
    expect(getMoodDefinition('surprised-big')).toMatchObject({
      zhLabel: '震惊',
      enLabel: 'Astonished',
      accessibilityName: '震惊 / Astonished',
      asset: 'public/emoji/吃惊-大.svg',
    })
    expect(getMoodDefinition('surprised-small')).toMatchObject({
      zhLabel: '诧异',
      enLabel: 'Surprised',
      accessibilityName: '诧异 / Surprised',
      asset: 'public/emoji/吃惊-小.svg',
    })
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

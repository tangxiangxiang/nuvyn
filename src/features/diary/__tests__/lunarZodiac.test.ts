import { describe, expect, it } from 'vitest'
import { lunarZodiacIcon } from '../lunarZodiac'

describe('lunar zodiac Fluent Emoji assets', () => {
  it.each([
    ['鼠', 'rat'],
    ['牛', 'ox'],
    ['虎', 'tiger'],
    ['兔', 'rabbit'],
    ['龙', 'dragon'],
    ['蛇', 'snake'],
    ['马', 'horse'],
    ['羊', 'goat'],
    ['猴', 'monkey'],
    ['鸡', 'rooster'],
    ['狗', 'dog'],
    ['猪', 'pig'],
  ])('maps %s to its static Fluent Emoji asset and accessible name', (zodiac, asset) => {
    expect(lunarZodiacIcon(zodiac)).toEqual({
      src: `/emoji/zodiac-${asset}.svg`,
      alt: `生肖：${zodiac}`,
    })
  })

  it('returns no icon for unknown zodiac labels', () => {
    expect(lunarZodiacIcon('未知')).toBeNull()
  })
})

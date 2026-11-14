export const EVENT_EMOJI = [
  { glyph: '🎂', name: '生日', asset: 'birthday' },
  { glyph: '🚗', name: '汽车', asset: 'car' },
  { glyph: '🏠', name: '房屋', asset: 'house' },
  { glyph: '💍', name: '戒指', asset: 'ring' },
  { glyph: '🎓', name: '毕业', asset: 'graduation' },
  { glyph: '✈️', name: '旅行', asset: 'travel' },
  { glyph: '🎯', name: '目标', asset: 'goal' },
  { glyph: '💼', name: '工作', asset: 'work' },
  { glyph: '🏥', name: '健康', asset: 'health' },
] as const
export function eventEmojiSource(glyph: string): string | undefined {
  const asset = EVENT_EMOJI.find(item => item.glyph === glyph)?.asset
  return asset ? `/emoji/event-${asset}.svg` : undefined
}

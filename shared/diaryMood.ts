/**
 * The single product registry for D7 Mood Diary.
 *
 * This module is deliberately framework-independent so the server, future
 * picker, and tests all consume the same stable IDs, labels, grid order, and
 * canonical assets. Only the stable ID belongs in persisted metadata; the
 * asset name is a presentation mapping.
 */

export type DiaryMoodDefinition = {
  readonly id: string
  readonly zhLabel: string
  readonly enLabel: string
  readonly accessibilityName: string
  readonly row: 1 | 2 | 3 | 4 | 5 | 6
  readonly column: 1 | 2 | 3 | 4
  readonly asset: string
}

export const MOOD_CATALOG = [
  { id: 'kiss', zhLabel: '亲亲', enLabel: 'Kiss', accessibilityName: '亲亲 / Kiss', row: 1, column: 1, asset: 'public/emoji/亲亲.svg' },
  { id: 'sad', zhLabel: '伤心', enLabel: 'Sad', accessibilityName: '伤心 / Sad', row: 1, column: 2, asset: 'public/emoji/伤心.svg' },
  { id: 'surprised-big', zhLabel: '吃惊-大', enLabel: 'Big surprise', accessibilityName: '大幅吃惊 / Big surprise', row: 1, column: 3, asset: 'public/emoji/吃惊-大.svg' },
  { id: 'surprised-small', zhLabel: '吃惊-小', enLabel: 'Small surprise', accessibilityName: '小幅吃惊 / Small surprise', row: 1, column: 4, asset: 'public/emoji/吃惊-小.svg' },
  { id: 'watching', zhLabel: '吃瓜', enLabel: 'Watching the drama', accessibilityName: '吃瓜 / Watching the drama', row: 2, column: 1, asset: 'public/emoji/吃瓜.svg' },
  { id: 'like', zhLabel: '喜欢', enLabel: 'Like', accessibilityName: '喜欢 / Like', row: 2, column: 2, asset: 'public/emoji/喜欢.svg' },
  { id: 'laughing', zhLabel: '大笑', enLabel: 'Laughing', accessibilityName: '大笑 / Laughing', row: 2, column: 3, asset: 'public/emoji/大笑.svg' },
  { id: 'disappointed', zhLabel: '失落', enLabel: 'Disappointed', accessibilityName: '失落 / Disappointed', row: 2, column: 4, asset: 'public/emoji/失落.svg' },
  { id: 'afraid', zhLabel: '害怕', enLabel: 'Afraid', accessibilityName: '害怕 / Afraid', row: 3, column: 1, asset: 'public/emoji/害怕.svg' },
  { id: 'shy', zhLabel: '害羞', enLabel: 'Shy', accessibilityName: '害羞 / Shy', row: 3, column: 2, asset: 'public/emoji/害羞.svg' },
  { id: 'happy', zhLabel: '开心', enLabel: 'Happy', accessibilityName: '开心 / Happy', row: 3, column: 3, asset: 'public/emoji/开心.svg' },
  { id: 'smiling', zhLabel: '微笑', enLabel: 'Smiling', accessibilityName: '微笑 / Smiling', row: 3, column: 4, asset: 'public/emoji/微笑.svg' },
  { id: 'amazed', zhLabel: '惊讶', enLabel: 'Amazed', accessibilityName: '惊讶 / Amazed', row: 4, column: 1, asset: 'public/emoji/惊讶.svg' },
  { id: 'angry', zhLabel: '愤怒', enLabel: 'Angry', accessibilityName: '愤怒 / Angry', row: 4, column: 2, asset: 'public/emoji/愤怒.svg' },
  { id: 'flirty', zhLabel: '放电', enLabel: 'Flirty', accessibilityName: '放电 / Flirty', row: 4, column: 3, asset: 'public/emoji/放电.svg' },
  { id: 'speechless', zhLabel: '无语', enLabel: 'Speechless', accessibilityName: '无语 / Speechless', row: 4, column: 4, asset: 'public/emoji/无语.svg' },
  { id: 'dizzy', zhLabel: '晕', enLabel: 'Dizzy', accessibilityName: '晕 / Dizzy', row: 5, column: 1, asset: 'public/emoji/晕.svg' },
  { id: 'indignant', zhLabel: '气愤', enLabel: 'Indignant', accessibilityName: '气愤 / Indignant', row: 5, column: 2, asset: 'public/emoji/气愤.svg' },
  { id: 'frowning', zhLabel: '皱眉', enLabel: 'Frowning', accessibilityName: '皱眉 / Frowning', row: 5, column: 3, asset: 'public/emoji/皱眉.svg' },
  { id: 'mysterious', zhLabel: '神秘', enLabel: 'Mysterious', accessibilityName: '神秘 / Mysterious', row: 5, column: 4, asset: 'public/emoji/神秘.svg' },
  { id: 'laughing-tears', zhLabel: '笑哭', enLabel: 'Laughing with tears', accessibilityName: '笑哭 / Laughing with tears', row: 6, column: 1, asset: 'public/emoji/笑哭.svg' },
  { id: 'playful', zhLabel: '调皮', enLabel: 'Playful', accessibilityName: '调皮 / Playful', row: 6, column: 2, asset: 'public/emoji/调皮.svg' },
  { id: 'unwell', zhLabel: '难受', enLabel: 'Unwell', accessibilityName: '难受 / Unwell', row: 6, column: 3, asset: 'public/emoji/难受.svg' },
  { id: 'devilish', zhLabel: '魔鬼', enLabel: 'Devilish', accessibilityName: '魔鬼 / Devilish', row: 6, column: 4, asset: 'public/emoji/魔鬼.svg' },
] as const satisfies readonly DiaryMoodDefinition[]

export type MoodId = typeof MOOD_CATALOG[number]['id']

/** Canonical or user-managed Diary mood icon identity. */
export type DiaryCustomMoodId = `custom_mood_${string}`
export type DiaryMoodId = MoodId | DiaryCustomMoodId

export interface DiaryMoodIconConfig {
  readonly version: number
  readonly availableIcons: readonly DiaryMoodId[]
  /** User icons removed from the picker but retained for restore/permanent deletion. */
  readonly archivedIcons?: readonly DiaryMoodId[]
  readonly customIcons: Readonly<Record<string, string>>
  readonly customIconNames: Readonly<Record<string, string>>
}

export const DIARY_DEFAULT_MOOD_ICONS: readonly MoodId[] = MOOD_CATALOG.map(({ id }) => id)

export function isDiaryCustomMoodId(value: unknown): value is DiaryCustomMoodId {
  return typeof value === 'string' && /^custom_mood_[a-z0-9_-]+$/i.test(value)
}

const MOOD_IDS = new Set<string>(MOOD_CATALOG.map((mood) => mood.id))
const MOOD_BY_ID = new Map<string, DiaryMoodDefinition>(MOOD_CATALOG.map((mood) => [mood.id, mood]))

export function isMoodId(value: unknown): value is MoodId {
  return typeof value === 'string' && MOOD_IDS.has(value)
}

export function getMoodDefinition(id: string): DiaryMoodDefinition | undefined {
  return MOOD_BY_ID.get(id)
}

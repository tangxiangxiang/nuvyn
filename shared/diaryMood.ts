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
  readonly row: number
  readonly column: 1 | 2 | 3 | 4
  readonly asset: string
}

export const MOOD_CATALOG = [
  { id: 'kiss', zhLabel: '亲亲', enLabel: 'Kiss', accessibilityName: '亲亲 / Kiss', row: 1, column: 1, asset: 'public/emoji/亲亲.svg' },
  { id: 'sad', zhLabel: '伤心', enLabel: 'Sad', accessibilityName: '伤心 / Sad', row: 1, column: 2, asset: 'public/emoji/伤心.svg' },
  { id: 'surprised-big', zhLabel: '震惊', enLabel: 'Astonished', accessibilityName: '震惊 / Astonished', row: 1, column: 3, asset: 'public/emoji/吃惊-大.svg' },
  { id: 'surprised-small', zhLabel: '诧异', enLabel: 'Surprised', accessibilityName: '诧异 / Surprised', row: 1, column: 4, asset: 'public/emoji/吃惊-小.svg' },
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
  { id: 'relieved', zhLabel: '放松', enLabel: 'Relieved', accessibilityName: '放松 / Relieved', row: 7, column: 1, asset: 'public/emoji/放松.svg' },
  { id: 'thinking', zhLabel: '思考', enLabel: 'Thinking', accessibilityName: '思考 / Thinking', row: 7, column: 2, asset: 'public/emoji/思考.svg' },
  { id: 'confused', zhLabel: '困惑', enLabel: 'Confused', accessibilityName: '困惑 / Confused', row: 7, column: 3, asset: 'public/emoji/困惑.svg' },
  { id: 'worried', zhLabel: '担忧', enLabel: 'Worried', accessibilityName: '担忧 / Worried', row: 7, column: 4, asset: 'public/emoji/担忧.svg' },
  { id: 'anxious', zhLabel: '焦虑', enLabel: 'Anxious', accessibilityName: '焦虑 / Anxious', row: 8, column: 1, asset: 'public/emoji/焦虑.svg' },
  { id: 'tired', zhLabel: '疲惫', enLabel: 'Tired', accessibilityName: '疲惫 / Tired', row: 8, column: 2, asset: 'public/emoji/疲惫.svg' },
  { id: 'sleepy', zhLabel: '困倦', enLabel: 'Sleepy', accessibilityName: '困倦 / Sleepy', row: 8, column: 3, asset: 'public/emoji/困倦.svg' },
  { id: 'sleeping', zhLabel: '熟睡', enLabel: 'Sleeping', accessibilityName: '熟睡 / Sleeping', row: 8, column: 4, asset: 'public/emoji/熟睡.svg' },
  { id: 'yawning', zhLabel: '打哈欠', enLabel: 'Yawning', accessibilityName: '打哈欠 / Yawning', row: 9, column: 1, asset: 'public/emoji/打哈欠.svg' },
  { id: 'crying', zhLabel: '大哭', enLabel: 'Crying hard', accessibilityName: '大哭 / Crying hard', row: 9, column: 2, asset: 'public/emoji/大哭.svg' },
  { id: 'teary', zhLabel: '强忍泪水', enLabel: 'Holding back tears', accessibilityName: '强忍泪水 / Holding back tears', row: 9, column: 3, asset: 'public/emoji/强忍泪水.svg' },
  { id: 'touched', zhLabel: '感动', enLabel: 'Touched', accessibilityName: '感动 / Touched', row: 9, column: 4, asset: 'public/emoji/感动.svg' },
  { id: 'in-love', zhLabel: '心动', enLabel: 'In love', accessibilityName: '心动 / In love', row: 10, column: 1, asset: 'public/emoji/心动.svg' },
  { id: 'celebrating', zhLabel: '庆祝', enLabel: 'Celebrating', accessibilityName: '庆祝 / Celebrating', row: 10, column: 2, asset: 'public/emoji/庆祝.svg' },
  { id: 'cool', zhLabel: '自信', enLabel: 'Cool', accessibilityName: '自信 / Cool', row: 10, column: 3, asset: 'public/emoji/自信.svg' },
  { id: 'silly', zhLabel: '搞怪', enLabel: 'Silly', accessibilityName: '搞怪 / Silly', row: 10, column: 4, asset: 'public/emoji/搞怪.svg' },
  { id: 'awkward', zhLabel: '尴尬', enLabel: 'Awkward', accessibilityName: '尴尬 / Awkward', row: 11, column: 1, asset: 'public/emoji/尴尬.svg' },
  { id: 'eye-roll', zhLabel: '白眼', enLabel: 'Eye roll', accessibilityName: '白眼 / Eye roll', row: 11, column: 2, asset: 'public/emoji/白眼.svg' },
  { id: 'neutral', zhLabel: '平静', enLabel: 'Neutral', accessibilityName: '平静 / Neutral', row: 11, column: 3, asset: 'public/emoji/平静.svg' },
  { id: 'melting', zhLabel: '融化', enLabel: 'Melting', accessibilityName: '融化 / Melting', row: 11, column: 4, asset: 'public/emoji/融化.svg' },
  { id: 'terrified', zhLabel: '惊恐', enLabel: 'Terrified', accessibilityName: '惊恐 / Terrified', row: 12, column: 1, asset: 'public/emoji/惊恐.svg' },
  { id: 'sweating', zhLabel: '出汗', enLabel: 'Sweating', accessibilityName: '出汗 / Sweating', row: 12, column: 2, asset: 'public/emoji/出汗.svg' },
  { id: 'comforted', zhLabel: '拥抱', enLabel: 'Hugging', accessibilityName: '拥抱 / Hugging', row: 12, column: 3, asset: 'public/emoji/拥抱.svg' },
  { id: 'pleading', zhLabel: '可怜', enLabel: 'Pleading', accessibilityName: '可怜 / Pleading', row: 12, column: 4, asset: 'public/emoji/可怜.svg' },
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

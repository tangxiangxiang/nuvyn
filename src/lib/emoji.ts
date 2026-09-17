import { EMOJI_ENTRIES } from './generated/emojiData'

export interface EmojiEntry {
  readonly name: string
  readonly glyph: string
}

export const MAX_EMOJI_SUGGESTIONS = 30

export const emojiEntries: readonly EmojiEntry[] = EMOJI_ENTRIES

export const emojiDefinitions: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(emojiEntries.map(({ name, glyph }) => [name, glyph])),
)

export function normalizeEmojiName(name: string): string {
  return name.toLowerCase()
}

export function rankEmojiSuggestions(query: string, options: { allowEmpty?: boolean } = {}): readonly EmojiEntry[] {
  const needle = normalizeEmojiName(query.trim())
  if (!needle) return options.allowEmpty ? emojiEntries.slice(0, MAX_EMOJI_SUGGESTIONS) : []

  return emojiEntries
    .map((entry, sourceIndex) => {
      const name = normalizeEmojiName(entry.name)
      const relevance = name === needle ? 0 : name.startsWith(needle) ? 1 : name.includes(needle) ? 2 : 3
      return { entry, name, relevance, sourceIndex }
    })
    .filter((item) => item.relevance < 3)
    .sort((left, right) => (
      left.relevance - right.relevance
      || (left.name < right.name ? -1 : left.name > right.name ? 1 : left.sourceIndex - right.sourceIndex)
      || left.sourceIndex - right.sourceIndex
    ))
    .slice(0, MAX_EMOJI_SUGGESTIONS)
    .map(({ entry }) => entry)
}

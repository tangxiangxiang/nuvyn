// @vitest-environment jsdom
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EMOJI_GENERATOR_VERSION,
  EMOJI_SOURCE_REVISION,
  EMOJI_SOURCE_REVISION_DATE,
  EMOJI_ENTRIES,
} from '../generated/emojiData'
import {
  emojiDefinitions,
  emojiEntries,
  MAX_EMOJI_SUGGESTIONS,
  rankEmojiSuggestions,
} from '../emoji'

const generator = resolve(dirname(fileURLToPath(import.meta.url)), '../../../scripts/generate-emoji-data.mjs')
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('generated Emoji data', () => {
  it('contains the full shared alias mapping without glyph deduplication', () => {
    expect(EMOJI_ENTRIES.length).toBe(1957)
    expect(emojiEntries).toBe(EMOJI_ENTRIES)
    expect(emojiDefinitions['+1']).toBe('👍')
    expect(emojiDefinitions.thumbsup).toBe('👍')
    expect(emojiDefinitions.rocket).toBe('🚀')
    expect(emojiDefinitions.smile).toBe('😄')
    expect(emojiEntries.filter((entry) => entry.glyph === '👍').map((entry) => entry.name)).toEqual(['+1', 'thumbsup'])
  })

  it('ranks exact matches before prefixes and contained names', () => {
    const results = rankEmojiSuggestions('heart')
    expect(results[0]).toEqual({ name: 'heart', glyph: '❤️' })
    expect(results.slice(1).some((entry) => entry.name === 'broken_heart')).toBe(true)
    expect(rankEmojiSuggestions('sparkling_heart')).toEqual([{ name: 'sparkling_heart', glyph: '💖' }])
    expect(rankEmojiSuggestions('SMILe')[0]).toEqual({ name: 'smile', glyph: '😄' })
    expect(rankEmojiSuggestions('not_an_emoji')).toEqual([])
    expect(rankEmojiSuggestions('')).toEqual([])
    expect(rankEmojiSuggestions('e')).toHaveLength(MAX_EMOJI_SUGGESTIONS)
  })
})

describe('Emoji data generator', () => {
  it('is deterministic and fails closed on duplicate shortcode keys', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'nuvyn-emoji-generator-'))
    temporaryDirectories.push(directory)
    const source = resolve(directory, 'source.json')
    const first = resolve(directory, 'first.ts')
    const second = resolve(directory, 'second.ts')
    await writeFile(source, JSON.stringify([
      { emoji: '🧪', aliases: ['zeta', 'alpha'] },
      { emoji: '🧪', aliases: ['same_glyph'] },
      { emoji: '🚀', aliases: ['rocket'] },
    ]), 'utf8')

    execFileSync(process.execPath, [generator, '--input', source, '--output', first], { stdio: 'pipe' })
    execFileSync(process.execPath, [generator, '--input', source, '--output', second], { stdio: 'pipe' })
    expect(await readFile(first, 'utf8')).toBe(await readFile(second, 'utf8'))
    const generated = await readFile(first, 'utf8')
    expect(generated).toContain(`Source revision date: ${EMOJI_SOURCE_REVISION_DATE}`)
    expect(generated).toContain('Generator version: 1')
    expect(generated).not.toMatch(/Generated at|Current time|Date\.now\(\)/)
    expect(generated.indexOf('"name": "alpha"')).toBeLessThan(generated.indexOf('"name": "same_glyph"'))

    await writeFile(source, JSON.stringify([
      { emoji: '🧪', aliases: ['duplicate'] },
      { emoji: '🧪', aliases: ['duplicate'] },
    ]), 'utf8')
    expect(() => execFileSync(process.execPath, [generator, '--input', source, '--output', second], { stdio: 'pipe' })).toThrow()
    expect(EMOJI_SOURCE_REVISION).toHaveLength(40)
    expect(EMOJI_GENERATOR_VERSION).toBe('1')
  })
})

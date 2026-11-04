import { describe, expect, it } from 'vitest'
import { NOTE_SPEECH_LIMITS, NoteSpeechTextError, splitNoteSpeechText } from '../noteSpeechText'

const countCharacters = (value: string) => [...value].length

describe('splitNoteSpeechText', () => {
  it('rejects empty and whitespace-only input', () => {
    expect(() => splitNoteSpeechText('')).toThrowError(new NoteSpeechTextError('empty'))
    expect(() => splitNoteSpeechText(' \n\t ')).toThrowError(new NoteSpeechTextError('empty'))
  })

  it('enforces the document limit without truncating accepted text', () => {
    const accepted = '甲'.repeat(NOTE_SPEECH_LIMITS.maxDocumentChars)
    expect(splitNoteSpeechText(accepted).join('')).toBe(accepted)
    expect(() => splitNoteSpeechText(`${accepted}甲`)).toThrowError(new NoteSpeechTextError('too-long'))
  })

  it('splits at sentence boundaries when possible and preserves all interior text', () => {
    const source = '这是第一句。'.repeat(180)
    const segments = splitNoteSpeechText(source)
    expect(segments.length).toBeGreaterThan(1)
    expect(segments.join('')).toBe(source)
    expect(segments.every((segment) => countCharacters(segment) <= NOTE_SPEECH_LIMITS.requestChars)).toBe(true)
    expect(segments.slice(0, -1).every((segment) => /[。！？!?；;]$/u.test(segment))).toBe(true)
  })

  it('prefers whitespace boundaries and does not split an English word', () => {
    const source = 'read-aloud '.repeat(100)
    const segments = splitNoteSpeechText(source)
    expect(segments.join('')).toBe(source.trim())
    expect(segments.slice(0, -1).every((segment) => /\s$/u.test(segment))).toBe(true)
    expect(segments.every((segment) => countCharacters(segment) <= NOTE_SPEECH_LIMITS.requestChars)).toBe(true)
  })

  it('keeps grapheme clusters intact while measuring the API limit in Unicode code points', () => {
    const family = '👩‍👩‍👧‍👦'
    const source = `${family}`.repeat(180)
    const segments = splitNoteSpeechText(source)
    expect(segments.join('')).toBe(source)
    expect(segments.every((segment) => countCharacters(segment) <= NOTE_SPEECH_LIMITS.requestChars)).toBe(true)
    expect(segments.every((segment) => segment.replaceAll(family, '') === '')).toBe(true)
  })

  it('reports an unsegmentable grapheme instead of exceeding the API limit', () => {
    const oversizedGrapheme = `a${'\u0301'.repeat(800)}`
    expect(countCharacters(oversizedGrapheme)).toBeGreaterThan(NOTE_SPEECH_LIMITS.requestChars)
    expect(() => splitNoteSpeechText(oversizedGrapheme)).toThrowError(new NoteSpeechTextError('unsegmentable'))
  })
})

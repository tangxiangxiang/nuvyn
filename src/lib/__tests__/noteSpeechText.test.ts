import { describe, expect, it } from 'vitest'
import { NOTE_SPEECH_LIMITS, NoteSpeechTextError, splitNoteSpeechText } from '../noteSpeechText'

const countCharacters = (value: string) => [...value].length

describe('splitNoteSpeechText', () => {
  it('keeps unrelated paragraphs stable when inserting, changing or deleting a paragraph', () => {
    const paragraphs = ['Java 的基本概念。', 'JVM 的作用。', '垃圾回收机制。']
    const original = splitNoteSpeechText(paragraphs.join('\n\n'))
    const changed = splitNoteSpeechText([paragraphs[0], 'JVM 的内存管理机制。'.repeat(90), paragraphs[2]].join('\n\n'))
    expect(changed[0]).toBe(original[0])
    expect(changed.at(-1)).toBe(original.at(-1))
    expect(splitNoteSpeechText(['新段落。', ...paragraphs].join('\n\n')).slice(1)).toEqual(original)
    expect(splitNoteSpeechText([paragraphs[0], paragraphs[2]].join('\n\n'))).toEqual([original[0], original[2]])
    expect(original.join('')).toBe(paragraphs.join('\n\n'))
  })

  it('preserves short paragraphs, CRLF separators and mixed Unicode content', () => {
    const text = '标题\r\n\r\n短段落。\r\n\r\nEnglish e\u0301 与中文👩‍👩‍👧‍👦。'
    expect(splitNoteSpeechText(text)).toHaveLength(3)
    expect(splitNoteSpeechText(text).join('')).toBe(text)
  })
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

  it('splits an oversized English paragraph at sentence boundaries', () => {
    const text = 'This is one complete English sentence.'.repeat(35)
    const parts = splitNoteSpeechText(text)
    expect(parts.join('')).toBe(text)
    expect(parts.slice(0, -1).every((part) => part.endsWith('.'))).toBe(true)
    expect(parts.every((part) => countCharacters(part) <= 800)).toBe(true)
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

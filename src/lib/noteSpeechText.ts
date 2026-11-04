export const NOTE_SPEECH_LIMITS = {
  maxDocumentChars: 20_000,
  requestChars: 800,
  targetSegmentChars: 450,
} as const

export class NoteSpeechTextError extends Error {
  readonly code: 'empty' | 'too-long' | 'unsegmentable'

  constructor(code: 'empty' | 'too-long' | 'unsegmentable') {
    super(code === 'empty'
      ? 'There is no speakable text.'
      : code === 'too-long'
        ? 'The note exceeds the 20,000 character speech limit.'
        : 'A single grapheme exceeds the speech request limit.')
    this.name = 'NoteSpeechTextError'
    this.code = code
  }
}

function graphemes(text: string): string[] {
  if (typeof Intl.Segmenter === 'function') {
    return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (part) => part.segment)
  }
  return Array.from(text)
}

const SENTENCE_END = /^[。！？.!?；;]$/u
const SPACE = /^\s$/u

/** Split without dropping source characters or splitting a grapheme cluster. */
export function splitNoteSpeechText(text: string): string[] {
  const source = text.trim()
  if (!source) throw new NoteSpeechTextError('empty')
  if ([...source].length > NOTE_SPEECH_LIMITS.maxDocumentChars) throw new NoteSpeechTextError('too-long')
  // Never pack adjacent paragraphs: edits cannot shift unrelated paragraph boundaries.
  // Keep separators with their preceding paragraph to retain natural pauses.
  return (source.match(/[\s\S]+?(?:\r?\n[\t ]*\r?\n+|$)/g) ?? []).flatMap(splitParagraph)
}

function splitParagraph(source: string): string[] {
  const units = graphemes(source)
  const lengths = units.map((unit) => [...unit].length)
  const prefix = [0]
  for (const length of lengths) prefix.push(prefix.at(-1)! + length)
  const totalChars = prefix.at(-1)!
  if (!units.length) throw new NoteSpeechTextError('empty')
  if (totalChars > NOTE_SPEECH_LIMITS.maxDocumentChars) throw new NoteSpeechTextError('too-long')
  const output: string[] = []
  let start = 0
  while (start < units.length) {
    const remainingChars = totalChars - prefix[start]!
    if (remainingChars <= NOTE_SPEECH_LIMITS.requestChars) {
      output.push(units.slice(start).join(''))
      break
    }
    let target = start
    while (target < units.length
      && prefix[target + 1]! - prefix[start]! <= NOTE_SPEECH_LIMITS.targetSegmentChars) {
      target += 1
    }
    if (target === start) {
      if (lengths[target]! > NOTE_SPEECH_LIMITS.requestChars) throw new NoteSpeechTextError('unsegmentable')
      target += 1
    }
    let hardLimit = target
    while (hardLimit < units.length
      && prefix[hardLimit + 1]! - prefix[start]! <= NOTE_SPEECH_LIMITS.requestChars) {
      hardLimit += 1
    }
    let cut = -1
    for (let index = target - 1; index >= start; index -= 1) {
      if (SENTENCE_END.test(units[index]!)) { cut = index + 1; break }
    }
    if (cut < 0) {
      for (let index = target; index < hardLimit; index += 1) {
        if (SENTENCE_END.test(units[index]!)) { cut = index + 1; break }
      }
    }
    if (cut < 0) {
      for (let index = target - 1; index >= start; index -= 1) {
        if (SPACE.test(units[index]!)) { cut = index + 1; break }
      }
    }
    if (cut < 0) cut = target
    output.push(units.slice(start, cut).join(''))
    start = cut
  }
  return output
}

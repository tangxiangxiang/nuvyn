import { describe, expect, it } from 'vitest'
import {
  MAX_DOCUMENT_TAGS,
  TagNormalizationError,
  normalizeAndDedupeTags,
  normalizeTagDisplay,
  normalizeTagIdentity,
  validatePersistentTag,
} from '../tagNormalization'
import { TAG_NORMALIZATION_FIXTURES } from './tagNormalization.fixtures'

describe('tag-identity-v1', () => {
  it.each(TAG_NORMALIZATION_FIXTURES)('normalizes %#', (fixture) => {
    expect(normalizeTagIdentity(fixture.raw)).toBe(fixture.identity)
    expect(normalizeTagDisplay(fixture.raw)).toBe(fixture.display)
    expect(validatePersistentTag(fixture.raw).ok).toBe(fixture.valid)
  })

  it('does not apply NFKC or locale-sensitive lowercasing', () => {
    expect(normalizeTagIdentity('ﬁre')).toBe('ﬁre')
    expect(normalizeTagIdentity('İ')).toBe('i̇')
  })

  it('deduplicates by identity and preserves the first display', () => {
    expect(normalizeAndDedupeTags(['Java', '#java', 'JAVA'])).toEqual([
      { displayName: 'Java', normalizedName: 'java' },
    ])
  })

  it('rejects forbidden controls while allowing joiners', () => {
    expect(validatePersistentTag('a\t b').ok).toBe(false)
    expect(validatePersistentTag('a\u202E b').ok).toBe(false)
    expect(validatePersistentTag('👩‍💻').ok).toBe(true)
  })

  it('enforces the document tag count', () => {
    expect(() => normalizeAndDedupeTags(
      Array.from({ length: MAX_DOCUMENT_TAGS + 1 }, (_, index) => `tag-${index}`),
    )).toThrow(TagNormalizationError)
  })
})


export type TagNormalizationFixture = {
  raw: string | null | undefined
  identity: string
  display: string
  valid: boolean
}

export const TAG_NORMALIZATION_FIXTURES: readonly TagNormalizationFixture[] = [
  { raw: 'Java', identity: 'java', display: 'Java', valid: true },
  { raw: 'JAVA', identity: 'java', display: 'JAVA', valid: true },
  { raw: ' java ', identity: 'java', display: 'java', valid: true },
  { raw: '#java', identity: 'java', display: 'java', valid: true },
  { raw: '# java', identity: 'java', display: 'java', valid: true },
  { raw: '##java', identity: '#java', display: '#java', valid: true },
  { raw: '#', identity: '', display: '', valid: false },
  { raw: '人工智能', identity: '人工智能', display: '人工智能', valid: true },
  { raw: 'a/b', identity: 'a/b', display: 'a/b', valid: true },
  { raw: 'a-b', identity: 'a-b', display: 'a-b', valid: true },
  { raw: 'a_b', identity: 'a_b', display: 'a_b', valid: true },
  { raw: 'java script', identity: 'java script', display: 'java script', valid: true },
  { raw: 'ﬁre', identity: 'ﬁre', display: 'ﬁre', valid: true },
  { raw: 'line\nbreak', identity: 'line\nbreak', display: 'line\nbreak', valid: false },
  { raw: '\u0000nul', identity: '\u0000nul', display: '\u0000nul', valid: false },
  { raw: 'a'.repeat(100), identity: 'a'.repeat(100), display: 'a'.repeat(100), valid: true },
  { raw: 'a'.repeat(101), identity: 'a'.repeat(101), display: 'a'.repeat(101), valid: false },
]

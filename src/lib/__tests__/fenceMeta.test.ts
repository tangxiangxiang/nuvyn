import { describe, expect, it } from 'vitest'
import {
  getFenceMetaHighlightRaw,
  MAX_HIGHLIGHT_EXPANSION_WORK,
  parseFenceMeta,
} from '../fenceMeta'

describe('FenceMeta parser', () => {
  it('parses language and approved fence-info channels only', () => {
    const meta = parseFenceMeta('ts {1,3-5}:line-numbers [config.ts]')

    expect(meta).toMatchObject({
      rawInfo: 'ts {1,3-5}:line-numbers [config.ts]',
      language: 'ts',
      normalizedLanguage: 'ts',
      specialFence: null,
      highlightRanges: [1, 3, 4, 5],
      lineNumbers: 'on',
      label: 'config.ts',
      malformed: [],
    })
    expect(meta).not.toHaveProperty('notation')
    expect(meta).not.toHaveProperty('focus')
    expect(meta).not.toHaveProperty('sourceAnnotations')
  })

  it('accepts the approved compact and modifier forms without polluting language', () => {
    expect(parseFenceMeta('ts{1,3-5}').highlightRanges).toEqual([1, 3, 4, 5])
    expect(parseFenceMeta('ts:line-numbers').language).toBe('ts')
    expect(parseFenceMeta('ts:line-numbers=10')).toMatchObject({
      language: 'ts',
      lineNumbers: 'start',
      lineNumberStart: 10,
      malformed: [],
    })
    expect(parseFenceMeta('ts :no-line-numbers')).toMatchObject({
      language: 'ts',
      lineNumbers: 'off',
      malformed: [],
    })
    expect(parseFenceMeta('ts [config.ts]')).toMatchObject({
      language: 'ts',
      label: 'config.ts',
      malformed: [],
    })
  })

  it('normalizes duplicate and out-of-order ranges deterministically', () => {
    const meta = parseFenceMeta('ts {5,1,3-5,1}')

    expect(meta.highlightRanges).toEqual([1, 3, 4, 5])
    expect(getFenceMetaHighlightRaw(meta)).toBe('{1,3-5}')
  })

  it('rejects malformed or oversized ranges without throwing or allocating them', () => {
    for (const value of ['{0}', '{-1}', '{abc}', '{1-}', '{-3}', '{5-2}', '{1,,3}', '{1-999999999999999999999}']) {
      expect(() => parseFenceMeta(`ts ${value}`)).not.toThrow()
      const meta = parseFenceMeta(`ts ${value}`)
      expect(meta.highlightRanges).toEqual([])
      expect(meta.malformed).toContain(value)
      expect(getFenceMetaHighlightRaw(meta)).toBe('')
    }
  })

  it('bounds total range expansion work across every range token in one parse', () => {
    const repeated = parseFenceMeta('ts {1-100000} {1-100000}')
    expect(repeated.highlightRanges).toHaveLength(MAX_HIGHLIGHT_EXPANSION_WORK)
    expect(repeated.malformed).toEqual(['{1-100000}'])

    const mixed = parseFenceMeta('ts {1-60000} {60001-100000} {1-100000}')
    expect(mixed.highlightRanges).toHaveLength(MAX_HIGHLIGHT_EXPANSION_WORK)
    expect(mixed.highlightRanges[0]).toBe(1)
    expect(mixed.highlightRanges.at(-1)).toBe(100000)
    expect(mixed.malformed).toEqual(['{1-100000}'])
  })

  it('bounds future line-number metadata at 100000 and keeps it non-rendering', () => {
    expect(parseFenceMeta('ts:line-numbers=100000')).toMatchObject({
      lineNumbers: 'start',
      lineNumberStart: 100000,
      malformed: [],
    })

    for (const value of ['0', '-1', 'abc', '', '100001', '999999999999999999999']) {
      const meta = parseFenceMeta(`ts:line-numbers=${value}`)
      expect(meta.lineNumbers).toBe('off')
      expect(meta.lineNumberStart).toBeUndefined()
      expect(meta.malformed).toContain(`:line-numbers=${value}`)
    }
  })

  it('recognizes only exact bare, case-sensitive special fences', () => {
    expect(parseFenceMeta('mermaid').specialFence).toBe('mermaid')
    expect(parseFenceMeta('markmap').specialFence).toBe('markmap')

    for (const info of [
      'mermaid {1}',
      'mermaid{1}',
      'mermaid:line-numbers',
      'mermaid [diagram]',
      'markmap {1}',
      'markmap{1}',
      'markmap:line-numbers',
      'MARKMAP',
      'Mermaid',
    ]) {
      expect(parseFenceMeta(info).specialFence, info).toBeNull()
    }
  })

  it('keeps empty and unknown metadata safe', () => {
    expect(parseFenceMeta('')).toMatchObject({
      language: '',
      normalizedLanguage: '',
      specialFence: null,
      highlightRanges: [],
      lineNumbers: 'off',
      malformed: [],
    })

    const unknown = parseFenceMeta('totally-unknown {1} [label] :future')
    expect(unknown.language).toBe('totally-unknown')
    expect(unknown.highlightRanges).toEqual([1])
    expect(unknown.label).toBe('label')
    expect(unknown.malformed).toEqual([':future'])
  })
})

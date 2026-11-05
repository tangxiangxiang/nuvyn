import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateSpeechPronunciations, matchSpeechPronunciations } from '../../shared/speechPronunciations'
import { readSpeechPronunciations, saveSpeechPronunciations, resetCorruptSpeechPronunciations } from '../ai/speechPronunciations'

const entry = (text = '天姥', pinyin = 'tian1 mu3', id = 'entry-1') => ({ id, text, pinyin })

describe('speech pronunciations', () => {
  it('retains the dictionary after closing and reopening the database', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nuvyn-pronunciations-'))
    const file = path.join(root, 'test.db')
    const first = new Database(file)
    try {
      first.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
      saveSpeechPronunciations(first, [entry()])
    } finally { first.close() }
    const reopened = new Database(file)
    try { expect(readSpeechPronunciations(reopened)).toEqual([entry()]) }
    finally { reopened.close(); rmSync(root, { recursive: true, force: true }) }
  })
  it('normalizes pinyin and maps matching complete words without rewriting text', () => {
    const entries = validateSpeechPronunciations([entry('天姥', ' TIAN1   mu3 ')])
    expect(entries[0]?.pinyin).toBe('tian1 mu3')
    expect(matchSpeechPronunciations('梦游天姥吟留别，天姥连天向天横。', entries)).toEqual(['天姥/(tian1)(mu3)'])
    expect(matchSpeechPronunciations('姥姥', entries)).toEqual([])
  })

  it.each([1, 2, 3, 4, 5])('accepts tone %i', (tone) => {
    expect(validateSpeechPronunciations([entry('天', `tian${tone}`)])[0]?.pinyin).toBe(`tian${tone}`)
  })

  it.each([
    [entry('天姥', '')], [entry('天姥', 'tian0 mu3')], [entry('天姥', 'tian6 mu3')],
    [entry('天姥', 'tian1')], [entry('天姥', 'xxx1 mu3')], [entry('天姥', 'tian1\tmu3')],
    [entry('天 姥')], [entry('Hello', 'hello1')], [entry('')], [entry('天'.repeat(33))],
    [entry('天', 'tian1 '.repeat(30))], [entry(), entry('天姥', 'tian1 lao3', 'entry-2')],
    [entry(), entry('重庆', 'chong2 qing4')], [{ ...entry(), url: 'https://example.com' }],
    Array.from({ length: 201 }, (_, i) => entry('天', 'tian1', `id-${i}`)),
  ])('rejects invalid dictionary %#', (...entries) => {
    expect(() => validateSpeechPronunciations(entries)).toThrow()
  })

  it('resolves overlap by length, then position, with stable rules independent of saved order', () => {
    const entries = [entry('重庆', 'chong2 qing4', 'a'), entry('重庆市', 'chong2 qing4 shi4', 'b'), entry('庆市', 'qing4 shi4', 'c')]
    expect(matchSpeechPronunciations('重庆市', entries)).toEqual(['重庆市/(chong2)(qing4)(shi4)'])
    expect(matchSpeechPronunciations('重庆市，重庆', entries)).toEqual(['重庆市/(chong2)(qing4)(shi4)', '重庆/(chong2)(qing4)'])
    expect(matchSpeechPronunciations('重庆市，重庆', entries.toReversed())).toEqual(matchSpeechPronunciations('重庆市，重庆', entries))
  })

  it('persists atomically in settings, supports edit/delete, and fails closed on corrupt data', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    try {
      expect(readSpeechPronunciations(db)).toEqual([])
      saveSpeechPronunciations(db, [entry()])
      expect(readSpeechPronunciations(db)).toEqual([entry()])
      expect(() => saveSpeechPronunciations(db, [entry(), entry()])).toThrow()
      expect(readSpeechPronunciations(db)).toEqual([entry()])
      saveSpeechPronunciations(db, [entry('天姥', 'tian1 lao3')])
      expect(readSpeechPronunciations(db)[0]?.pinyin).toBe('tian1 lao3')
      saveSpeechPronunciations(db, [])
      expect(readSpeechPronunciations(db)).toEqual([])
      db.prepare('UPDATE settings SET value = ?').run('{broken')
      expect(() => readSpeechPronunciations(db)).toThrow('Stored pronunciation dictionary is invalid')
      saveSpeechPronunciations(db, [])
      expect(readSpeechPronunciations(db)).toEqual([])
    } finally { db.close() }
  })
  it('matches configured words without inferring single characters or other readings', () => {
    const rules = validateSpeechPronunciations([
      entry(), entry('行长', 'hang2 zhang3', 'b'), entry('银行行长', 'yin2 hang2 hang2 zhang3', 'c'),
      entry('还行', 'hai2 xing2', 'd'), entry('长大', 'zhang3 da4', 'e'), entry('重复', 'chong2 fu4', 'f'),
    ])
    for (const text of ['梦游天姥吟留别', '越人语天姥', '天姥连天向天横']) expect(matchSpeechPronunciations(text, rules)).toEqual(['天姥/(tian1)(mu3)'])
    expect(matchSpeechPronunciations('姥姥，银行，行走，长江，归还', rules)).toEqual([])
    expect(matchSpeechPronunciations('银行行长', rules)).toEqual(['银行行长/(yin2)(hang2)(hang2)(zhang3)'])
    for (const word of ['行长', '还行', '长大', '重复']) expect(matchSpeechPronunciations(word, rules)).toHaveLength(1)
    // A configured single character intentionally matches all contexts; the UI warns about this.
    expect(matchSpeechPronunciations('长大长江', [entry('长', 'chang2')])).toEqual(['长/(chang2)'])
  })

  it('explicitly resets corrupt data only and preserves all other settings', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    try {
      db.prepare('INSERT INTO settings VALUES (?, ?)').run('unrelated', 'preserve')
      db.prepare('INSERT INTO settings VALUES (?, ?)').run('ai.speech.pronunciations.v1', '{broken')
      expect(() => readSpeechPronunciations(db)).toThrow(expect.objectContaining({ code: 'tts-pronunciations-corrupt' }))
      expect(resetCorruptSpeechPronunciations(db)).toEqual([])
      expect(db.prepare('SELECT value FROM settings WHERE key = ?').get('unrelated')).toEqual({ value: 'preserve' })
      saveSpeechPronunciations(db, [entry()])
      expect(() => resetCorruptSpeechPronunciations(db)).toThrow()
      expect(readSpeechPronunciations(db)).toEqual([entry()])
    } finally { db.close() }
  })

})

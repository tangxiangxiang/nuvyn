import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateSpeechPronunciations, matchSpeechPronunciations } from '../../shared/speechPronunciations'
import { readSpeechPronunciations, saveSpeechPronunciations } from '../ai/speechPronunciations'

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
})

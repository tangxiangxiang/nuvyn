import type { Database } from 'better-sqlite3'
import { validateSpeechPronunciations, SpeechPronunciationError, type SpeechPronunciationEntry } from '../../shared/speechPronunciations.js'

const KEY = 'ai.speech.pronunciations.v1'

export function readSpeechPronunciations(db: Database): SpeechPronunciationEntry[] {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as { value: string } | undefined
  if (!row) return []
  try { return validateSpeechPronunciations(JSON.parse(row.value)) }
  catch { throw new SpeechPronunciationError('Stored pronunciation dictionary is invalid') }
}

export function saveSpeechPronunciations(db: Database, input: unknown): SpeechPronunciationEntry[] {
  const entries = validateSpeechPronunciations(input)
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(KEY, JSON.stringify(entries))
  return entries
}

import { describe, expect, it } from 'vitest'
import type { PostSummary } from '../../../lib/api'
import { resolveNativeDiaryMoodContext } from '../diaryMoodContext'

function post(path: string, overrides: Partial<PostSummary> = {}): PostSummary {
  return {
    path,
    title: path,
    created: '2026-08-24',
    updated: '2026-08-24',
    tags: [],
    size: 1,
    mtime: 1,
    ...overrides,
  }
}

function tab(path: string, overrides: Partial<{ loading: boolean; loadError: string | null }> = {}) {
  return { path, loading: false, loadError: null, ...overrides }
}

describe('resolveNativeDiaryMoodContext', () => {
  it('projects the matching managed Diary summary, including unknown mood values', () => {
    const result = resolveNativeDiaryMoodContext(
      tab('diary/2026-08-24'),
      [post('diary/2026-08-24', {
        mood: 'future-mood-v3',
        documentId: 'diary-id',
        metadataUpdatedAt: 42,
      })],
      false,
    )

    expect(result).toEqual({
      date: '2026-08-24',
      path: 'diary/2026-08-24',
      mood: 'future-mood-v3',
      documentId: 'diary-id',
      metadataUpdatedAt: 42,
    })
  })

  it.each([
    'note',
    'inbox/note',
    'literature/note',
    'archive/2026/note',
    'ledger/note',
    'diary',
    'diary/legacy',
    'diary/2026-08-24/child',
    'diary/2026-02-30',
  ])('excludes non-canonical path %s', (path) => {
    expect(resolveNativeDiaryMoodContext(tab(path), [post(path)], false)).toBeNull()
  })

  it('excludes special surfaces, loading tabs, missing summaries, and no active tab', () => {
    const summary = [post('diary/2026-08-24', { mood: 'happy', metadataUpdatedAt: 1 })]

    expect(resolveNativeDiaryMoodContext(tab('diary/2026-08-24'), summary, true)).toBeNull()
    expect(resolveNativeDiaryMoodContext(tab('diary/2026-08-24', { loading: true }), summary, false)).toBeNull()
    expect(resolveNativeDiaryMoodContext(tab('diary/2026-08-24', { loadError: 'failed' }), summary, false)).toBeNull()
    expect(resolveNativeDiaryMoodContext(tab('diary/2026-08-24'), [], false)).toBeNull()
    expect(resolveNativeDiaryMoodContext(null, summary, false)).toBeNull()
  })

  it('keeps a null mood and allows the caller to detect a missing CAS version', () => {
    const result = resolveNativeDiaryMoodContext(
      tab('diary/2026-08-24'),
      [post('diary/2026-08-24', { mood: null, documentId: 'diary-id' })],
      false,
    )

    expect(result?.mood).toBeNull()
    expect(result?.metadataUpdatedAt).toBeUndefined()
  })
})

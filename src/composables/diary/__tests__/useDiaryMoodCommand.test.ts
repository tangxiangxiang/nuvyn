import { describe, expect, it, vi } from 'vitest'
import type { DocumentMetadata, UpdateDocumentMetadata } from '../../../lib/api'
import { parseDiaryDate, type DiaryDate } from '../../../../shared/diaryProtocol'
import { useDiaryMoodCommand } from '../useDiaryMoodCommand'

function date(value: string): DiaryDate {
  const parsed = parseDiaryDate(value)
  if (!parsed) throw new Error(`invalid test date: ${value}`)
  return parsed
}

function metadata(mood: string | null): DocumentMetadata {
  return {
    id: 'diary-id',
    path: 'diary/2026-08-24',
    title: '2026-08-24',
    summary: '',
    tags: [],
    mood,
    createdAt: 1,
    updatedAt: 20,
  }
}

describe('useDiaryMoodCommand', () => {
  it('updates the exact Diary metadata path through the existing CAS API', async () => {
    const updateMetadata = vi.fn(async (path: string, input: UpdateDocumentMetadata) => {
      expect(path).toBe('diary/2026-08-24')
      expect(input).toEqual({ mood: 'happy', expectedUpdatedAt: 10 })
      return metadata(input.mood ?? null)
    })
    const command = useDiaryMoodCommand({ updateMetadata })

    await expect(command.setMood('2026-08-24', 'happy', 10)).resolves.toEqual({
      status: 'updated',
      date: date('2026-08-24'),
      path: 'diary/2026-08-24',
      metadata: metadata('happy'),
    })
    expect(updateMetadata).toHaveBeenCalledTimes(1)
  })

  it('supports explicit clear without creating, navigating, or touching body state', async () => {
    const updateMetadata = vi.fn(async () => metadata(null))
    const command = useDiaryMoodCommand({ updateMetadata })

    const result = await command.setDiaryMood('2026-08-24', null, 20)

    expect(result.status).toBe('updated')
    expect(updateMetadata).toHaveBeenCalledWith('diary/2026-08-24', {
      mood: null,
      expectedUpdatedAt: 20,
    })
  })

  it.each([
    ['bad-date', 'happy', 10],
    ['2026-08-24', 'future-mood', 10],
    ['2026-08-24', {}, 10],
    ['2026-08-24', 'happy', undefined],
    ['2026-08-24', 'happy', -1],
  ])('rejects invalid date, mood, or CAS input before API access', async (dateValue, mood, version) => {
    const updateMetadata = vi.fn()
    const command = useDiaryMoodCommand({ updateMetadata })

    const result = await command.setMood(dateValue, mood, version)

    expect(result.status).toBe('invalid')
    expect(updateMetadata).not.toHaveBeenCalled()
  })

  it('returns typed not-found and conflict outcomes from the existing metadata API', async () => {
    const notFound = Object.assign(new Error('missing'), { status: 404 })
    const conflict = Object.assign(new Error('stale'), { status: 409 })
    const onConflict = vi.fn()
    const updateMetadata = vi.fn()
      .mockRejectedValueOnce(notFound)
      .mockRejectedValueOnce(conflict)
    const command = useDiaryMoodCommand({ updateMetadata, onConflict })

    await expect(command.updateMood('2026-08-24', 'happy', 10)).resolves.toMatchObject({ status: 'not-found' })
    await expect(command.setMood('2026-08-24', 'happy', 10)).resolves.toMatchObject({ status: 'conflict' })
    expect(onConflict).toHaveBeenCalledTimes(1)
  })

  it('honors the existing mutation lock seam', async () => {
    const acquire = vi.fn(() => null)
    const updateMetadata = vi.fn()
    const command = useDiaryMoodCommand({ mutationLock: { acquire }, updateMetadata })

    const result = await command.setMood('2026-08-24', 'happy', 10)

    expect(result.status).toBe('busy')
    expect(acquire).toHaveBeenCalledWith(['diary/2026-08-24.md'])
    expect(updateMetadata).not.toHaveBeenCalled()
  })
})

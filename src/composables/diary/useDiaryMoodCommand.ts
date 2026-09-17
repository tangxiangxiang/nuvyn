import type { DocumentMetadata, UpdateDocumentMetadata } from '../../lib/api'
import { updateDocumentMetadata } from '../../lib/api'
import { diaryLogicalPathForDate, parseDiaryDate, type DiaryDate } from '../../../shared/diaryProtocol'
import { isMoodId, type DiaryMoodId } from '../../../shared/diaryMood'
import { useDiaryMoodIconPreferences } from './useDiaryMoodIconPreferences'
import { toMutationPaths } from '../vault/pathMutationLock'

export type DiaryMoodCommandResult =
  | { status: 'updated'; date: DiaryDate; path: string; metadata: DocumentMetadata }
  | { status: 'invalid' | 'not-found' | 'busy' | 'conflict' | 'error'; date?: DiaryDate; path?: string; error: Error }

export interface DiaryMoodCommandOptions {
  updateMetadata?: (path: string, input: UpdateDocumentMetadata) => Promise<DocumentMetadata>
  mutationLock?: { acquire: (paths: readonly string[]) => (() => void) | null }
  onBusy?: (date: DiaryDate) => void
  onConflict?: (error: Error, date: DiaryDate) => void
  onError?: (error: Error, date?: DiaryDate) => void
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function statusOf(value: unknown): number | undefined {
  if (!value || typeof value !== 'object') return undefined
  const status = (value as { status?: unknown }).status
  return typeof status === 'number' ? status : undefined
}

function invalidError(message: string): Error {
  return new Error(message)
}

/**
 * Own only the canonical Diary mood mutation. The command deliberately does
 * not create a missing file or open/navigate a document; callers that need a
 * missing today/past date must first use the existing Diary date command.
 */
export function useDiaryMoodCommand(options: DiaryMoodCommandOptions = {}) {
  const writeMetadata = options.updateMetadata ?? updateDocumentMetadata
  const moodPreferences = useDiaryMoodIconPreferences()

  function invalid(
    error: Error,
    date?: DiaryDate,
    path?: string,
  ): DiaryMoodCommandResult {
    options.onError?.(error, date)
    return { status: 'invalid', date, path, error }
  }

  async function setMood(
    dateValue: unknown,
    moodValue: unknown,
    expectedUpdatedAt: unknown,
  ): Promise<DiaryMoodCommandResult> {
    const date = parseDiaryDate(dateValue)
    if (!date) return invalid(invalidError('invalid Diary date; expected YYYY-MM-DD'))

    const path = diaryLogicalPathForDate(date)
    if (moodValue !== null && !isMoodId(moodValue) && !moodPreferences.isAvailable(moodValue)) {
      return invalid(invalidError('invalid Diary mood; expected a configured mood icon or null'), date, path)
    }
    if (typeof expectedUpdatedAt !== 'number'
      || !Number.isSafeInteger(expectedUpdatedAt)
      || expectedUpdatedAt < 0) {
      return invalid(invalidError('expectedUpdatedAt is required for a Diary mood mutation'), date, path)
    }
    const expectedVersion = expectedUpdatedAt

    const release = options.mutationLock?.acquire(toMutationPaths([path])) ?? null
    if (options.mutationLock && !release) {
      const error = new Error('Diary mood mutation is busy')
      options.onBusy?.(date)
      return { status: 'busy', date, path, error }
    }

    try {
      let metadata: DocumentMetadata
      try {
        metadata = await writeMetadata(path, {
          mood: moodValue as DiaryMoodId | null,
          expectedUpdatedAt: expectedVersion,
        })
      } catch (error) {
        const normalized = asError(error)
        if (statusOf(error) === 404) return { status: 'not-found', date, path, error: normalized }
        if (statusOf(error) === 409) {
          options.onConflict?.(normalized, date)
          return { status: 'conflict', date, path, error: normalized }
        }
        options.onError?.(normalized, date)
        return { status: 'error', date, path, error: normalized }
      }
      if (metadata.path !== path) {
        const error = new Error('Diary mood update returned a non-canonical path')
        options.onError?.(error, date)
        return { status: 'error', date, path, error }
      }
      return { status: 'updated', date, path, metadata }
    } finally {
      release?.()
    }
  }

  return { setMood, setDiaryMood: setMood, updateMood: setMood }
}

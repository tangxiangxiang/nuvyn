import type { PostDetail, DiaryDateCreateResult } from '../../lib/api'
import type { VaultFileChanges } from '../vault/context/fileChanges'
import { diaryLogicalPathForDate, parseDiaryDate, type DiaryDate } from '../../../shared/diaryProtocol'
import { localCivilToday } from '../../components/diary/diaryCalendarAdapter'
import { toMutationPaths } from '../vault/pathMutationLock'

export type DiaryDateCommandResult =
  | { status: 'opened' | 'created'; date: DiaryDate; path: string }
  | { status: 'future' | 'invalid' | 'busy' | 'error'; date?: DiaryDate; path?: string; error?: Error }

export type DiaryDateEnsureResult =
  | { status: 'existing'; date: DiaryDate; path: string }
  | { status: 'created'; date: DiaryDate; path: string }
  | { status: 'future' | 'invalid' | 'busy' | 'error'; date?: DiaryDate; path?: string; error?: Error }

export interface DiaryDateCommandOptions {
  getPost: (path: string) => Promise<Pick<PostDetail, 'path'>>
  createDiaryDate: (input: { date: DiaryDate; timeZone: string }) => Promise<DiaryDateCreateResult>
  openPost: (path: string, options?: { refresh?: boolean }) => Promise<void>
  refresh: () => Promise<void>
  fileChanges?: Pick<VaultFileChanges, 'publish'>
  mutationLock?: { acquire: (paths: readonly string[]) => (() => void) | null }
  getToday?: () => DiaryDate | null
  getTimeZone?: () => string
  onFuture?: (date: DiaryDate) => void
  onBusy?: (date: DiaryDate) => void
  onError?: (error: Error, date?: DiaryDate) => void
  onRefreshError?: (error: Error) => void
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function statusOf(value: unknown): number | undefined {
  if (!value || typeof value !== 'object') return undefined
  const status = (value as { status?: unknown }).status
  return typeof status === 'number' ? status : undefined
}

function isNotFound(value: unknown): boolean {
  return statusOf(value) === 404
}

function isConflict(value: unknown): boolean {
  return statusOf(value) === 409
}

/**
 * Resolve the browser's actual IANA timezone without falling back to UTC.
 * UTC is valid when it is what the browser reports; the command never
 * substitutes it for a missing or invalid browser timezone.
 */
export function localDiaryTimeZone(): string {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  if (typeof timeZone !== 'string' || !timeZone.trim()) {
    throw new Error('browser timezone is unavailable')
  }

  try {
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone
    if (!resolved) throw new Error('browser timezone is unavailable')
  } catch {
    throw new Error('browser timezone is invalid')
  }

  return timeZone
}

/**
 * Own the one Calendar-date intent orchestration while delegating every
 * document operation to the existing Vault lifecycle.
 */
export function useDiaryDateCommand(options: DiaryDateCommandOptions) {
  const inFlight = new Map<DiaryDate, Promise<DiaryDateCommandResult>>()
  const ensureInFlight = new Map<DiaryDate, Promise<DiaryDateEnsureResult>>()

  function fail(
    error: unknown,
    date?: DiaryDate,
    path?: string,
  ): DiaryDateEnsureResult {
    const normalized = asError(error)
    options.onError?.(normalized, date)
    return { status: 'error', date, path, error: normalized }
  }

  function validateCreateResult(
    result: DiaryDateCreateResult,
    date: DiaryDate,
    path: string,
  ): Error | null {
    if (!result || result.date !== date || result.path !== path || result.post?.path !== path) {
      return new Error('Diary date-create returned a non-canonical path')
    }
    return null
  }

  async function run(date: DiaryDate, openDocument: boolean): Promise<DiaryDateEnsureResult> {
    const path = diaryLogicalPathForDate(date)
    let release = options.mutationLock?.acquire(toMutationPaths([path])) ?? null
    if (options.mutationLock && !release) {
      options.onBusy?.(date)
      return { status: 'busy', date, path }
    }

    function releaseMutationLock(): void {
      release?.()
      release = null
    }

    try {
      let missing = false
      try {
        const post = await options.getPost(path)
        if (post.path !== path) return fail(new Error('Diary path resolution changed identity'), date, path)
      } catch (error) {
        if (!isNotFound(error)) return fail(error, date, path)
        missing = true
      }

      if (!missing) {
        try {
          // The lock owns exact-path resolution/create synchronization, not
          // ordinary Vault presentation. Release it before openPost so a
          // visible native document can be closed immediately instead of a
          // concurrent close being rejected as busy after the reader mounts.
          releaseMutationLock()
          if (openDocument) await options.openPost(path)
          return { status: 'existing', date, path }
        } catch (error) {
          return fail(error, date, path)
        }
      }

      const today = options.getToday?.() ?? localCivilToday()
      if (!today) return fail(new Error('local Diary date is unavailable'), date, path)
      if (date > today) {
        options.onFuture?.(date)
        return { status: 'future', date, path }
      }

      let timeZone: string
      try {
        timeZone = options.getTimeZone?.() ?? localDiaryTimeZone()
      } catch (error) {
        return fail(error, date, path)
      }

      let result: DiaryDateCreateResult
      try {
        result = await options.createDiaryDate({ date, timeZone })
      } catch (error) {
        // A concurrent creator may win the exact path. Read that exact path
        // once and open it; never retry under a suffix or another identity.
        if (isConflict(error)) {
          try {
            const post = await options.getPost(path)
            if (post.path !== path) return fail(new Error('Diary conflict resolved to a non-canonical path'), date, path)
            releaseMutationLock()
            if (openDocument) await options.openPost(path)
            return { status: 'existing', date, path }
          } catch (readError) {
            return fail(readError, date, path)
          }
        }
        return fail(error, date, path)
      }

      const invalidResult = validateCreateResult(result, date, path)
      if (invalidResult) return fail(invalidResult, date, path)

      if (result.created) {
        options.fileChanges?.publish({
          path,
          kind: 'write',
          source: 'editor-lifecycle',
        })
      }

      try {
        await options.refresh()
      } catch (error) {
        // The create is authoritative and the exact path is still safe to
        // open. Keep the marker refresh recoverable instead of opening a
        // second lifecycle or reporting a false create failure.
        options.onRefreshError?.(asError(error))
      }

      releaseMutationLock()
      if (openDocument) {
        try {
          await options.openPost(path, { refresh: false })
        } catch (error) {
          return fail(error, date, path)
        }
      }
      return { status: result.created ? 'created' : 'existing', date, path }
    } finally {
      releaseMutationLock()
    }
  }

  function invalidResult(): { status: 'invalid'; error: Error } {
    const error = new Error('invalid Diary date; expected YYYY-MM-DD')
    options.onError?.(error)
    return { status: 'invalid', error }
  }

  function toCommandResult(result: DiaryDateEnsureResult): DiaryDateCommandResult {
    switch (result.status) {
      case 'existing':
        return { status: 'opened', date: result.date, path: result.path }
      case 'created':
        return result
      default:
        return result
    }
  }

  function ensureDiaryDate(value: unknown): Promise<DiaryDateEnsureResult> {
    const date = parseDiaryDate(value)
    if (!date) return Promise.resolve(invalidResult())

    const existing = ensureInFlight.get(date)
    if (existing) return existing

    const path = diaryLogicalPathForDate(date)
    const promise = run(date, false).catch((error) => fail(error, date, path))
    ensureInFlight.set(date, promise)
    void promise.then(
      () => { if (ensureInFlight.get(date) === promise) ensureInFlight.delete(date) },
      () => { if (ensureInFlight.get(date) === promise) ensureInFlight.delete(date) },
    )
    return promise
  }

  function openDiaryDate(value: unknown): Promise<DiaryDateCommandResult> {
    const date = parseDiaryDate(value)
    if (!date) return Promise.resolve(invalidResult())

    const existing = inFlight.get(date)
    if (existing) return existing

    const path = diaryLogicalPathForDate(date)
    const promise = run(date, true)
      .then(toCommandResult)
      .catch((error) => fail(error, date, path) as DiaryDateCommandResult)
    inFlight.set(date, promise)
    void promise.then(
      () => { if (inFlight.get(date) === promise) inFlight.delete(date) },
      () => { if (inFlight.get(date) === promise) inFlight.delete(date) },
    )
    return promise
  }

  return { ensureDiaryDate, openDiaryDate }
}

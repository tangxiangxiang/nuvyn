import { describe, expect, it, vi } from 'vitest'
import type { PostDetail, PostSummary, DiaryDateCreateResult } from '../../../lib/api'
import type { VaultFileChanges } from '../../vault/context/fileChanges'
import { diaryLogicalPathForDate, parseDiaryDate, type DiaryDate } from '../../../../shared/diaryProtocol'
import {
  useDiaryDateCommand,
  type DiaryDateCommandOptions,
} from '../useDiaryDateCommand'

function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error(`HTTP ${status}`), { status })
}

function date(value: string): DiaryDate {
  const parsed = parseDiaryDate(value)
  if (!parsed) throw new Error(`invalid test date: ${value}`)
  return parsed
}

function post(path: string): Pick<PostDetail, 'path'> {
  return { path }
}

function createResult(
  value: { date: DiaryDate; path: string; created: boolean },
): DiaryDateCreateResult {
  return {
    ...value,
    post: { path: value.path } as PostSummary,
  }
}

function harness(options: {
  existing?: string[]
  getPost?: DiaryDateCommandOptions['getPost']
  createDiaryDate?: DiaryDateCommandOptions['createDiaryDate']
  openPost?: DiaryDateCommandOptions['openPost']
  refresh?: () => Promise<void>
  getToday?: () => DiaryDate | null
  mutationLock?: DiaryDateCommandOptions['mutationLock']
} = {}) {
  const existing = new Set(options.existing ?? [])
  const getPost = options.getPost ?? vi.fn(async (path: string) => {
    if (!existing.has(path)) throw httpError(404)
    return post(path)
  })
  const createDiaryDate = options.createDiaryDate ?? vi.fn(async (input: {
    date: DiaryDate
    timeZone: string
  }) => {
    const path = diaryLogicalPathForDate(input.date)
    existing.add(path)
    return createResult({ date: input.date, path, created: true })
  })
  const openPost = vi.fn(options.openPost
    ?? (async (_path: string, _options?: { refresh?: boolean }) => {}))
  const refresh = options.refresh ?? vi.fn(async () => {})
  const publish = vi.fn()
  const onFuture = vi.fn()
  const onBusy = vi.fn()
  const onError = vi.fn()
  const onRefreshError = vi.fn()
  const command = useDiaryDateCommand({
    getPost,
    createDiaryDate,
    openPost,
    refresh,
    fileChanges: { publish } as Pick<VaultFileChanges, 'publish'>,
    mutationLock: options.mutationLock,
    getToday: options.getToday ?? (() => date('2026-08-24')),
    getTimeZone: () => 'Asia/Shanghai',
    onFuture,
    onBusy,
    onError,
    onRefreshError,
  })

  return {
    ...command,
    getPost,
    createDiaryDate,
    openPost,
    refresh,
    publish,
    onFuture,
    onBusy,
    onError,
    onRefreshError,
  }
}

describe('useDiaryDateCommand', () => {
  it('opens an existing future Diary through the existing post lifecycle', async () => {
    const path = 'diary/2030-01-01'
    const state = harness({ existing: [path] })

    const result = await state.openDiaryDate('2030-01-01')

    expect(result).toEqual({ status: 'opened', date: date('2030-01-01'), path })
    expect(state.createDiaryDate).not.toHaveBeenCalled()
    expect(state.openPost).toHaveBeenCalledWith(path)
    expect(state.publish).not.toHaveBeenCalled()
  })

  it('releases the path mutation lock before adopting native Vault presentation', async () => {
    const path = 'diary/2026-08-24'
    let pathLocked = false
    const release = vi.fn(() => { pathLocked = false })
    const acquire = vi.fn(() => {
      pathLocked = true
      return release
    })
    const openPost = vi.fn(async () => {
      expect(pathLocked).toBe(false)
    })
    const state = harness({
      existing: [path],
      openPost,
      mutationLock: { acquire },
    })

    await expect(state.openDiaryDate('2026-08-24')).resolves.toMatchObject({
      status: 'opened',
      path,
    })
    expect(acquire).toHaveBeenCalledWith([`${path}.md`])
    expect(release).toHaveBeenCalledTimes(1)
    expect(openPost).toHaveBeenCalledWith(path)
  })

  it('creates a missing today date through the D2 command, refreshes, then opens it', async () => {
    const state = harness()

    const result = await state.openDiaryDate('2026-08-24')

    expect(result.status).toBe('created')
    expect(state.createDiaryDate).toHaveBeenCalledTimes(1)
    expect(state.createDiaryDate).toHaveBeenCalledWith({
      date: date('2026-08-24'),
      timeZone: 'Asia/Shanghai',
    })
    expect(state.refresh).toHaveBeenCalledTimes(1)
    expect(state.publish).toHaveBeenCalledWith({
      path: 'diary/2026-08-24',
      kind: 'write',
      source: 'editor-lifecycle',
    })
    expect(state.openPost).toHaveBeenCalledWith('diary/2026-08-24', { refresh: false })
  })

  it('can ensure a missing date without adopting native document presentation', async () => {
    const state = harness()

    const result = await state.ensureDiaryDate('2026-08-24')

    expect(result).toEqual({
      status: 'created',
      date: date('2026-08-24'),
      path: 'diary/2026-08-24',
    })
    expect(state.createDiaryDate).toHaveBeenCalledTimes(1)
    expect(state.refresh).toHaveBeenCalledTimes(1)
    expect(state.publish).toHaveBeenCalledWith({
      path: 'diary/2026-08-24',
      kind: 'write',
      source: 'editor-lifecycle',
    })
    expect(state.openPost).not.toHaveBeenCalled()
  })

  it('opens the exact server-resolved path when date creation reports created:false', async () => {
    const state = harness({
      createDiaryDate: vi.fn(async (input: { date: DiaryDate; timeZone: string }) => ({
        date: input.date,
        path: diaryLogicalPathForDate(input.date),
        created: false,
        post: { path: diaryLogicalPathForDate(input.date) } as PostSummary,
      })),
    })

    const result = await state.openDiaryDate('2026-08-24')

    expect(result).toEqual({
      status: 'opened',
      date: date('2026-08-24'),
      path: 'diary/2026-08-24',
    })
    expect(state.createDiaryDate).toHaveBeenCalledTimes(1)
    expect(state.refresh).toHaveBeenCalledTimes(1)
    expect(state.publish).not.toHaveBeenCalled()
    expect(state.openPost).toHaveBeenCalledWith('diary/2026-08-24', { refresh: false })
  })

  it.each(['0000-02-29', '0001-01-01', '0099-12-31', '0100-01-01', '2026-08-24'])(
    'preserves exact logical path identity for %s',
    async (value) => {
      const state = harness()

      const result = await state.openDiaryDate(value)

      expect(result.status).toBe('created')
      expect(state.createDiaryDate).toHaveBeenCalledWith({
        date: date(value),
        timeZone: 'Asia/Shanghai',
      })
      expect(state.openPost).toHaveBeenCalledWith(`diary/${value}`, { refresh: false })
    },
  )

  it('does not create or navigate to a missing future date', async () => {
    const state = harness()

    const result = await state.openDiaryDate('2026-08-25')

    expect(result).toEqual({
      status: 'future',
      date: date('2026-08-25'),
      path: 'diary/2026-08-25',
    })
    expect(state.createDiaryDate).not.toHaveBeenCalled()
    expect(state.openPost).not.toHaveBeenCalled()
    expect(state.refresh).not.toHaveBeenCalled()
    expect(state.publish).not.toHaveBeenCalled()
    expect(state.onFuture).toHaveBeenCalledWith(date('2026-08-25'))
  })

  it.each(['2026-02-31', '2026-13-01', 'not-a-date', 'diary/2026-08-24', '2026-8-24'])(
    'rejects invalid Diary identity %s before any mutation',
    async (value) => {
      const state = harness()

      const result = await state.openDiaryDate(value)

      expect(result.status).toBe('invalid')
      expect(state.getPost).not.toHaveBeenCalled()
      expect(state.createDiaryDate).not.toHaveBeenCalled()
      expect(state.openPost).not.toHaveBeenCalled()
      expect(state.onError).toHaveBeenCalledTimes(1)
    },
  )

  it('deduplicates concurrent clicks for the same exact date', async () => {
    let releaseCreate!: () => void
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve })
    const state = harness({
      createDiaryDate: vi.fn(async (input: { date: DiaryDate; timeZone: string }) => {
        await createGate
        const path = diaryLogicalPathForDate(input.date)
        return createResult({ date: input.date, path, created: true })
      }),
    })

    const first = state.openDiaryDate('2026-08-24')
    const second = state.openDiaryDate('2026-08-24')
    expect(second).toBe(first)

    releaseCreate()
    await expect(first).resolves.toMatchObject({ status: 'created', path: 'diary/2026-08-24' })
    expect(state.createDiaryDate).toHaveBeenCalledTimes(1)
    expect(state.openPost).toHaveBeenCalledTimes(1)
  })

  it('opens the exact path when the server reports an exact-path race', async () => {
    let firstProbe = true
    const getPost = vi.fn(async (path: string) => {
      if (firstProbe) {
        firstProbe = false
        throw httpError(404)
      }
      return post(path)
    })
    const createDiaryDate = vi.fn(async () => {
      throw httpError(409)
    })
    const state = harness({ getPost, createDiaryDate })

    const result = await state.openDiaryDate('2026-08-24')

    expect(result.status).toBe('opened')
    expect(state.createDiaryDate).toHaveBeenCalledTimes(1)
    expect(state.openPost).toHaveBeenCalledWith('diary/2026-08-24')
    expect(state.openPost.mock.calls[0]?.[0]).not.toContain('copy')
  })

  it('fails closed on a non-404 exact-path lookup error', async () => {
    const state = harness({
      getPost: vi.fn(async () => { throw httpError(500) }),
    })

    const result = await state.openDiaryDate('2026-08-24')

    expect(result.status).toBe('error')
    expect(state.createDiaryDate).not.toHaveBeenCalled()
    expect(state.openPost).not.toHaveBeenCalled()
    expect(state.publish).not.toHaveBeenCalled()
  })

  it('keeps the exact open path when marker refresh fails after creation', async () => {
    const refreshError = new Error('refresh unavailable')
    const state = harness({ refresh: vi.fn(async () => { throw refreshError }) })

    const result = await state.openDiaryDate('2026-08-24')

    expect(result.status).toBe('created')
    expect(state.openPost).toHaveBeenCalledWith('diary/2026-08-24', { refresh: false })
    expect(state.onRefreshError).toHaveBeenCalledWith(refreshError)
  })
})

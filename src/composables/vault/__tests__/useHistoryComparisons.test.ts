import { beforeEach, describe, expect, it, vi } from 'vitest'
import { watch } from 'vue'
import {
  getLoadedEditorDocument,
  useHistoryComparisons,
  type HistoryRevisionSelection,
} from '../useHistoryComparisons'
import * as api from '../../../lib/history-api'

vi.mock('../../../lib/history-api', async () => {
  const actual = await vi.importActual<typeof api>('../../../lib/history-api')
  return { ...actual, getFileAt: vi.fn() }
})

function selection(overrides: Partial<HistoryRevisionSelection> = {}): HistoryRevisionSelection {
  return {
    documentPath: 'inbox/redis',
    documentTitle: 'Redis Notes',
    revisionId: 'revision-a',
    parentRevisionId: 'parent-a',
    revisionTime: 1_752_566_260_000,
    summary: 'Update cache section',
    ...overrides,
  }
}

function file(ref: string, content: string) {
  return { path: 'inbox/redis.md', ref, content }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useHistoryComparisons', () => {
  it('opens a normal commit as parent revision → selected revision without loading the worktree', async () => {
    vi.mocked(api.getFileAt)
      .mockResolvedValueOnce(file('parent-a', '# Before'))
      .mockResolvedValueOnce(file('revision-a', '# After'))
    const loadCurrentDocument = vi.fn().mockResolvedValue('# Unsaved/current')
    const getCurrentDocument = vi.fn().mockReturnValue({ raw: '# Editor', dirty: true })
    const history = useHistoryComparisons({
      getCurrentDocument,
      loadCurrentDocument,
    })

    await history.openComparison(selection())

    expect(api.getFileAt).toHaveBeenNthCalledWith(1, 'inbox/redis.md', 'parent-a')
    expect(api.getFileAt).toHaveBeenNthCalledWith(2, 'inbox/redis.md', 'revision-a')
    expect(loadCurrentDocument).not.toHaveBeenCalled()
    expect(getCurrentDocument).not.toHaveBeenCalled()
    expect(history.activeComparison.value).toMatchObject({
      mode: 'commit-change',
      beforeRef: 'parent-a',
      afterRef: 'revision-a',
      beforeRaw: '# Before',
      afterRaw: '# After',
      beforeExists: true,
      afterExists: true,
      currentDirty: false,
      status: 'ready',
    })
  })

  it('loads root commits as empty → selected revision', async () => {
    vi.mocked(api.getFileAt).mockResolvedValue(file('root-sha', '# First'))
    const history = useHistoryComparisons({
      getCurrentDocument: () => null,
      loadCurrentDocument: vi.fn(),
    })

    await history.openComparison(selection({ revisionId: 'root-sha', parentRevisionId: null }))

    expect(api.getFileAt).toHaveBeenCalledOnce()
    expect(api.getFileAt).toHaveBeenCalledWith('inbox/redis.md', 'root-sha')
    expect(history.activeComparison.value).toMatchObject({
      beforeRef: null,
      afterRef: 'root-sha',
      beforeRaw: '',
      beforeExists: false,
      afterRaw: '# First',
      afterExists: true,
    })
  })

  it('treats a missing parent file as an empty side for a later file creation', async () => {
    vi.mocked(api.getFileAt)
      .mockRejectedValueOnce(new api.HistoryApiError('not found', 404))
      .mockResolvedValueOnce(file('revision-a', 'created'))
    const history = useHistoryComparisons({
      getCurrentDocument: () => null,
      loadCurrentDocument: vi.fn(),
    })

    await history.openComparison(selection())

    expect(history.activeComparison.value).toMatchObject({
      beforeRaw: '',
      beforeExists: false,
      afterRaw: 'created',
      afterExists: true,
      status: 'ready',
    })
    expect(history.activeComparison.value?.diff?.stats).toMatchObject({ added: 1, removed: 0 })
  })

  it('treats a missing selected file as an empty side for a deletion commit', async () => {
    vi.mocked(api.getFileAt)
      .mockResolvedValueOnce(file('parent-a', 'deleted content'))
      .mockRejectedValueOnce(new api.HistoryApiError('not found', 404))
    const history = useHistoryComparisons({
      getCurrentDocument: () => null,
      loadCurrentDocument: vi.fn(),
    })

    await history.openComparison(selection())

    expect(history.activeComparison.value).toMatchObject({
      beforeRaw: 'deleted content',
      beforeExists: true,
      afterRaw: '',
      afterExists: false,
      status: 'ready',
    })
    expect(history.activeComparison.value?.diff?.stats).toMatchObject({ added: 0, removed: 1 })
  })

  it('loads historical sides in parallel', async () => {
    let resolveParent!: (value: Awaited<ReturnType<typeof api.getFileAt>>) => void
    let resolveSelected!: (value: Awaited<ReturnType<typeof api.getFileAt>>) => void
    vi.mocked(api.getFileAt)
      .mockReturnValueOnce(new Promise((resolve) => { resolveParent = resolve }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveSelected = resolve }))
    const history = useHistoryComparisons({
      getCurrentDocument: () => null,
      loadCurrentDocument: vi.fn(),
    })

    const request = history.openComparison(selection())
    expect(api.getFileAt).toHaveBeenCalledTimes(2)
    expect(history.activeComparison.value?.status).toBe('loading')
    resolveParent(file('parent-a', 'before'))
    resolveSelected(file('revision-a', 'after'))
    await request
    expect(history.activeComparison.value?.status).toBe('ready')
  })

  it('publishes the first comparison transition from loading to ready', async () => {
    vi.mocked(api.getFileAt).mockResolvedValueOnce(file('parent-a', 'before')).mockResolvedValueOnce(file('revision-a', 'after'))
    const history = useHistoryComparisons({ getCurrentDocument: () => null, loadCurrentDocument: vi.fn() })
    const statuses: Array<'loading' | 'ready' | 'error' | undefined> = []
    const stop = watch(
      () => history.activeComparison.value?.status,
      (status) => statuses.push(status),
      { immediate: true },
    )

    await history.openComparison(selection())
    stop()

    expect(statuses).toEqual([undefined, 'loading', 'ready'])
  })

  it('switches to selected revision → working tree and preserves unsaved editor content', async () => {
    vi.mocked(api.getFileAt).mockResolvedValue(file('revision-a', 'historical'))
    const loadCurrentDocument = vi.fn()
    const history = useHistoryComparisons({
      getCurrentDocument: () => ({ raw: 'unsaved current', dirty: true }),
      loadCurrentDocument,
    })

    await history.openComparison(selection())
    await history.compareWithWorkingTree('diff:inbox/redis')

    expect(loadCurrentDocument).not.toHaveBeenCalled()
    expect(history.activeComparison.value).toMatchObject({
      mode: 'revision-to-worktree',
      beforeRef: 'revision-a',
      afterRef: api.WORKTREE_REF,
      beforeRaw: 'historical',
      afterRaw: 'unsaved current',
      currentDirty: true,
    })
  })

  it('switches back to commit-change mode and retry follows the active mode', async () => {
    vi.mocked(api.getFileAt)
      .mockResolvedValueOnce(file('parent-a', 'before'))
      .mockResolvedValueOnce(file('revision-a', 'after'))
      .mockResolvedValueOnce(file('revision-a', 'historical'))
      .mockResolvedValueOnce(file('parent-a', 'before retry'))
      .mockResolvedValueOnce(file('revision-a', 'after retry'))
    const loadCurrentDocument = vi.fn().mockResolvedValue('current')
    const history = useHistoryComparisons({ getCurrentDocument: () => null, loadCurrentDocument })

    await history.openComparison(selection())
    await history.compareWithWorkingTree('diff:inbox/redis')
    await history.viewCommitChanges('diff:inbox/redis')

    expect(loadCurrentDocument).toHaveBeenCalledOnce()
    expect(history.activeComparison.value).toMatchObject({
      mode: 'commit-change',
      beforeRaw: 'before retry',
      afterRaw: 'after retry',
    })
  })

  it('ignores a 500 historical failure instead of treating it as an empty file', async () => {
    vi.mocked(api.getFileAt).mockRejectedValueOnce(new api.HistoryApiError('server failed', 500))
    const history = useHistoryComparisons({ getCurrentDocument: () => null, loadCurrentDocument: vi.fn() })

    await history.openComparison(selection({ parentRevisionId: null }))

    expect(history.activeComparison.value).toMatchObject({ status: 'error', error: 'server failed' })
  })

  it('does not let a slower obsolete selection overwrite the newer selection', async () => {
    let resolveOld!: (value: Awaited<ReturnType<typeof api.getFileAt>>) => void
    vi.mocked(api.getFileAt)
      .mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve }))
      .mockResolvedValueOnce(file('revision-b', 'newer'))
    const history = useHistoryComparisons({ getCurrentDocument: () => null, loadCurrentDocument: vi.fn() })

    const oldRequest = history.openComparison(selection({ parentRevisionId: null }))
    const newRequest = history.openComparison(selection({ revisionId: 'revision-b', parentRevisionId: null }))
    await newRequest
    resolveOld(file('revision-a', 'older'))
    await oldRequest

    expect(history.activeComparison.value).toMatchObject({ revisionId: 'revision-b', afterRaw: 'newer' })
  })

  it('invalidates a pending request when the comparison tab closes', async () => {
    let resolveSelected!: (value: Awaited<ReturnType<typeof api.getFileAt>>) => void
    vi.mocked(api.getFileAt).mockReturnValueOnce(new Promise((resolve) => { resolveSelected = resolve }))
    const history = useHistoryComparisons({ getCurrentDocument: () => null, loadCurrentDocument: vi.fn() })

    const request = history.openComparison(selection({ parentRevisionId: null }))
    history.closeComparison('diff:inbox/redis')
    resolveSelected(file('revision-a', 'late'))
    await request

    expect(history.comparisons.value).toHaveLength(0)
  })

  it('rejects only non-404 historical errors from the state loader', async () => {
    vi.mocked(api.getFileAt).mockRejectedValueOnce(new Error('network down'))
    const history = useHistoryComparisons({ getCurrentDocument: () => null, loadCurrentDocument: vi.fn() })

    await history.openComparison(selection({ parentRevisionId: null }))

    expect(history.activeComparison.value).toMatchObject({ status: 'error', error: 'network down' })
  })

  it('recognizes loaded editor documents and their dirty state', () => {
    expect(getLoadedEditorDocument([
      { path: 'inbox/redis', raw: 'current', originalRaw: 'saved', loading: false, loadError: null },
    ], 'inbox/redis')).toEqual({ raw: 'current', dirty: true, exists: true })
  })
})

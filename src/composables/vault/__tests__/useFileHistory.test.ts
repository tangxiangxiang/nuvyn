import { ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../../../lib/history-api'
import {
  groupFileHistoryCommits,
  normalizeFileHistoryCommits,
  resolveFileHistoryTarget,
  useFileHistory,
  type FileHistoryTarget,
} from '../useFileHistory'

vi.mock('../../../lib/history-api', async () => {
  const actual = await vi.importActual<typeof api>('../../../lib/history-api')
  return { ...actual, getLog: vi.fn() }
})

const target = (path: string, title = path): FileHistoryTarget => ({
  documentPath: path,
  documentTitle: title,
})

const record = (
  sha: string,
  date: Date | string,
  files: string[],
  subject = sha,
  parents: string[] = [],
): api.CommitRecord => ({
  sha,
  parents,
  author: 'A',
  date: typeof date === 'string' ? date : date.toISOString(),
  subject,
  body: `${subject} body`,
  files,
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.getLog).mockResolvedValue({ commits: [] })
})

describe('useFileHistory', () => {
  it('resolves metadata titles and uses the shared readable filename fallback', () => {
    const posts = [{
      path: 'inbox/agents',
      title: 'Agent Guide',
      created: '',
      updated: '',
      tags: [],
      size: 0,
      mtime: 0,
    }]

    expect(resolveFileHistoryTarget('inbox/agents', posts).documentTitle).toBe('Agent Guide')
    expect(resolveFileHistoryTarget('inbox/getting-started', []).documentTitle).toBe('Getting Started')
  })

  it('requests an independent path-filtered log and creates the existing revision selection', async () => {
    const state = useFileHistory(ref('en-US'))
    vi.mocked(api.getLog).mockResolvedValue({
      commits: [record('abcdef123', new Date(2026, 7, 1, 15), ['inbox/agents.md'], 'Update agents')],
    })

    await state.open(target('inbox/agents', 'AGENTS'))

    expect(api.getLog).toHaveBeenCalledWith({ path: 'inbox/agents.md', limit: 200 })
    expect(state.selectCommit(state.commits.value[0]!)).toEqual({
      documentPath: 'inbox/agents',
      documentTitle: 'AGENTS',
      revisionId: 'abcdef123',
      parentRevisionId: null,
      revisionTime: new Date(2026, 7, 1, 15).getTime(),
      summary: 'Update agents',
    })
  })

  it('carries the actual first parent through a path-filtered file history', async () => {
    const state = useFileHistory(ref('en-US'))
    vi.mocked(api.getLog).mockResolvedValue({
      commits: [record('merge-sha', new Date(2026, 7, 1, 15), ['inbox/agents.md'], 'Merge', ['first-parent', 'second-parent'])],
    })

    await state.open(target('inbox/agents', 'AGENTS'))

    expect(state.selectCommit(state.commits.value[0]!)).toMatchObject({
      revisionId: 'merge-sha',
      parentRevisionId: 'first-parent',
    })
  })

  it('normalizes only valid commits associated with the selected current path and sorts newest first', () => {
    const commits = normalizeFileHistoryCommits([
      record('older', new Date(2026, 6, 31, 10), ['inbox/agents.md']),
      record('', new Date(2026, 7, 1, 13), ['inbox/agents.md']),
      record('wrong-file', new Date(2026, 7, 1, 14), ['inbox/readme.md']),
      record('invalid-date', 'not-a-date', ['inbox/agents.md']),
      record('newer', new Date(2026, 7, 1, 15), ['inbox/agents.md']),
    ], 'inbox/agents')

    expect(commits.map((commit) => commit.id)).toEqual(['newer', 'older'])
  })

  it('groups by stable local calendar date with dates and commits newest first', () => {
    const commits = normalizeFileHistoryCommits([
      record('same-day-older', new Date(2026, 7, 1, 9), ['inbox/a.md']),
      record('previous-day', new Date(2026, 6, 31, 23), ['inbox/a.md']),
      record('same-day-newer', new Date(2026, 7, 1, 17), ['inbox/a.md']),
    ], 'inbox/a')
    const groups = groupFileHistoryCommits(commits, 'en-US')

    expect(groups.map((group) => group.key)).toEqual(['2026-08-01', '2026-07-31'])
    expect(groups[0]!.commits.map((commit) => commit.id)).toEqual(['same-day-newer', 'same-day-older'])
  })

  it('prevents a stale response from replacing a newer file target', async () => {
    let resolveA!: (value: { commits: api.CommitRecord[] }) => void
    let resolveB!: (value: { commits: api.CommitRecord[] }) => void
    vi.mocked(api.getLog)
      .mockReturnValueOnce(new Promise((resolve) => { resolveA = resolve }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveB = resolve }))
    const state = useFileHistory(ref('en-US'))

    const requestA = state.open(target('inbox/a', 'A'))
    const requestB = state.open(target('inbox/b', 'B'))
    resolveB({ commits: [record('b-version', new Date(2026, 7, 1), ['inbox/b.md'])] })
    await requestB
    resolveA({ commits: [record('a-version', new Date(2026, 7, 2), ['inbox/a.md'])] })
    await requestA

    expect(state.target.value).toEqual(target('inbox/b', 'B'))
    expect(state.commits.value.map((commit) => commit.id)).toEqual(['b-version'])
  })

  it('expands the newest date by default and preserves valid user expansion on refresh', async () => {
    const newest = record('newest', new Date(2026, 7, 2), ['inbox/a.md'])
    const older = record('older', new Date(2026, 7, 1), ['inbox/a.md'])
    vi.mocked(api.getLog).mockResolvedValueOnce({ commits: [newest, older] })
    const state = useFileHistory(ref('en-US'))
    await state.open(target('inbox/a'))
    expect([...state.expandedDays.value]).toEqual(['2026-08-02'])

    state.toggleDay('2026-08-01')
    vi.mocked(api.getLog).mockResolvedValueOnce({ commits: [newest, older] })
    await state.refresh()
    expect(state.expandedDays.value).toEqual(new Set(['2026-08-02', '2026-08-01']))
  })

  it('cleans removed dates and a selected commit after refresh', async () => {
    const newest = record('newest', new Date(2026, 7, 2), ['inbox/a.md'])
    const older = record('older', new Date(2026, 7, 1), ['inbox/a.md'])
    vi.mocked(api.getLog).mockResolvedValueOnce({ commits: [newest, older] })
    const state = useFileHistory(ref('en-US'))
    await state.open(target('inbox/a'))
    state.selectCommit(state.commits.value[0]!)

    vi.mocked(api.getLog).mockResolvedValueOnce({ commits: [older] })
    await state.refresh()

    expect(state.selectedCommitId.value).toBeNull()
    expect(state.expandedDays.value.has('2026-08-02')).toBe(false)
  })

  it('keeps loading errors local and retries only the selected file request', async () => {
    vi.mocked(api.getLog).mockRejectedValueOnce(new Error('offline'))
    const state = useFileHistory(ref('en-US'))
    await state.open(target('inbox/a'))
    expect(state.error.value?.message).toBe('offline')

    vi.mocked(api.getLog).mockResolvedValueOnce({
      commits: [record('recovered', new Date(2026, 7, 1), ['inbox/a.md'])],
    })
    await state.refresh()
    expect(state.error.value).toBeNull()
    expect(state.commits.value[0]?.id).toBe('recovered')
    expect(api.getLog).toHaveBeenLastCalledWith({ path: 'inbox/a.md', limit: 200 })
  })

  it('keeps two file-history instances independent', async () => {
    const left = useFileHistory(ref('en-US'))
    const right = useFileHistory(ref('en-US'))
    vi.mocked(api.getLog)
      .mockResolvedValueOnce({ commits: [record('a', new Date(2026, 7, 1), ['inbox/a.md'])] })
      .mockResolvedValueOnce({ commits: [record('b', new Date(2026, 7, 2), ['inbox/b.md'])] })
    await Promise.all([left.open(target('inbox/a', 'A')), right.open(target('inbox/b', 'B'))])
    left.selectCommit(left.commits.value[0]!)
    expect(left.target.value?.documentPath).toBe('inbox/a')
    expect(right.target.value?.documentPath).toBe('inbox/b')
    expect(left.selectedCommitId.value).toBe('a')
    expect(right.selectedCommitId.value).toBeNull()
    left.clear()
    expect(right.target.value?.documentPath).toBe('inbox/b')
    expect(right.commits.value).toHaveLength(1)
  })
})

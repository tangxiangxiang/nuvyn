import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  changesDiffTabId,
  useWorkingTreeDiffs,
} from '../useWorkingTreeDiffs'
import * as api from '../../../lib/history-api'

vi.mock('../../../lib/history-api', async () => {
  const actual = await vi.importActual<typeof api>('../../../lib/history-api')
  return { ...actual, getDiff: vi.fn() }
})

const entry = { path: 'inbox/agents.md', index: ' ', worktree: 'M' }
const fileDiff = {
  ops: [
    { op: 'remove' as const, oldLine: 1, newLine: null, text: 'old' },
    { op: 'add' as const, oldLine: null, newLine: 1, text: 'new' },
  ],
  stats: { added: 1, removed: 1, equal: 0 },
}

beforeEach(() => vi.clearAllMocks())

describe('useWorkingTreeDiffs', () => {
  it('opens HEAD to WORKTREE directly and exposes loading immediately', async () => {
    let resolve!: (value: { path: string; oldRef: string; newRef: string; diff: typeof fileDiff }) => void
    vi.mocked(api.getDiff).mockReturnValue(new Promise((onResolve) => { resolve = onResolve }))
    const diffs = useWorkingTreeDiffs()

    const request = diffs.openDiff(entry, 'AGENTS')
    expect(changesDiffTabId(entry.path)).toBe('changes-diff:inbox/agents.md')
    expect(diffs.activeDiff.value).toMatchObject({
      tabId: 'changes-diff:inbox/agents.md',
      documentPath: 'inbox/agents',
      documentTitle: 'AGENTS',
      statusKind: 'modified',
      status: 'loading',
      diff: null,
    })
    expect(api.getDiff).toHaveBeenCalledWith('inbox/agents.md', 'HEAD', api.WORKTREE_REF)

    resolve({ path: entry.path, oldRef: 'HEAD', newRef: api.WORKTREE_REF, diff: fileDiff })
    await request
    expect(diffs.activeDiff.value).toMatchObject({ status: 'ready', diff: fileDiff })
  })

  it('maps new and deleted status entries without inventing client-side diffs', async () => {
    vi.mocked(api.getDiff).mockResolvedValue({ path: 'inbox/new.md', oldRef: 'HEAD', newRef: api.WORKTREE_REF, diff: fileDiff })
    const diffs = useWorkingTreeDiffs()
    await diffs.openDiff({ path: 'inbox/new.md', index: '?', worktree: '?' }, 'New')
    expect(diffs.activeDiff.value?.statusKind).toBe('added')

    await diffs.openDiff({ path: 'inbox/deleted.md', index: 'D', worktree: ' ' }, 'Deleted')
    expect(diffs.activeDiff.value?.statusKind).toBe('deleted')
    expect(api.getDiff).toHaveBeenLastCalledWith('inbox/deleted.md', 'HEAD', api.WORKTREE_REF)
  })

  it('keeps a failed diff in the tab and retries it', async () => {
    vi.mocked(api.getDiff)
      .mockRejectedValueOnce(new Error('disk unavailable'))
      .mockResolvedValueOnce({ path: entry.path, oldRef: 'HEAD', newRef: api.WORKTREE_REF, diff: fileDiff })
    const diffs = useWorkingTreeDiffs()
    await diffs.openDiff(entry, 'AGENTS')
    expect(diffs.activeDiff.value).toMatchObject({ status: 'error', error: 'disk unavailable' })

    await diffs.refreshDiff(diffs.activeDiff.value!.tabId)
    expect(diffs.activeDiff.value).toMatchObject({ status: 'ready', diff: fileDiff })
  })
})

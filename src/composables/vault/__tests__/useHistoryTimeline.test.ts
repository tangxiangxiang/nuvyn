import { nextTick, ref } from 'vue'
import { describe, expect, it } from 'vitest'
import type { PostSummary } from '../../../lib/api'
import type { CommitRecord } from '../../../lib/history-api'
import {
  buildHistoryDayGroups,
  toHistoryRevisionSelection,
  useHistoryTimeline,
} from '../useHistoryTimeline'

const record = (
  sha: string,
  date: Date,
  subject: string,
  files: string[],
  parents: string[] = [],
): CommitRecord => ({ sha, parents, date: date.toISOString(), subject, body: `${subject} body`, files, author: 'A' })

const post = (path: string, title: string): PostSummary => ({
  path,
  title,
  created: '',
  updated: '',
  tags: [],
  size: 0,
  mtime: 0,
})

describe('buildHistoryDayGroups', () => {
  it('groups by local calendar date and keeps days and commits newest first', () => {
    const newest = new Date(2026, 7, 1, 23, 30)
    const sameDayOlder = new Date(2026, 7, 1, 0, 15)
    const previousDay = new Date(2026, 6, 31, 23, 59)
    const groups = buildHistoryDayGroups([
      record('older-day', previousDay, 'Previous', ['inbox/c.md']),
      record('older-same-day', sameDayOlder, 'Morning', ['inbox/b.md']),
      record('newest', newest, 'Evening', ['inbox/a.md']),
    ], [], 'en-US')

    expect(groups.map((group) => group.key)).toEqual(['2026-08-01', '2026-07-31'])
    expect(groups[0]!.commits.map((commit) => commit.id)).toEqual(['newest', 'older-same-day'])
    expect(groups[0]!.label).toContain('Saturday')
  })

  it('renders one multi-file commit once with normalized Markdown children', () => {
    const groups = buildHistoryDayGroups([
      record('abcdef1234', new Date(2026, 7, 1, 14, 26), 'Multi-file', [
        'server/nope.ts',
        'inbox/getting-started.md',
        'literature/history-design.md',
        'inbox/getting-started.md',
        '../outside.md',
      ]),
    ], [post('inbox/getting-started', 'Getting Started')], 'en-US')

    expect(groups).toHaveLength(1)
    expect(groups[0]!.commits).toHaveLength(1)
    expect(groups[0]!.commits[0]).toMatchObject({
      id: 'abcdef1234',
      shortId: 'abcdef1',
      message: 'Multi-file',
    })
    expect(groups[0]!.commits[0]!.files).toEqual([
      {
        path: 'inbox/getting-started.md',
        documentPath: 'inbox/getting-started',
        title: 'Getting Started',
        parentPath: 'inbox',
      },
      {
        path: 'literature/history-design.md',
        documentPath: 'literature/history-design',
        title: 'History Design',
        parentPath: 'literature',
      },
    ])
  })

  it('filters commits without a valid date or Markdown file', () => {
    const invalidDate = record('bad-date', new Date(), 'Bad', ['inbox/a.md'])
    invalidDate.date = 'not-a-date'
    expect(buildHistoryDayGroups([
      invalidDate,
      record('typescript-only', new Date(), 'TS', ['src/a.ts']),
    ], [], 'en-US')).toEqual([])
  })
})

describe('useHistoryTimeline', () => {
  it('opens a historical file with the parent commit selection contract', async () => {
    const log = ref([record('revision-sha', new Date(2026, 7, 1, 14, 26), 'Update note', ['inbox/a.md'], ['parent-sha'])])
    const timeline = useHistoryTimeline(
      { log, logLoaded: ref(true) },
      ref([post('inbox/a', 'Document A')]),
      ref('en-US'),
    )
    await nextTick()
    const commit = timeline.commits.value[0]!
    const file = commit.files[0]!

    expect(timeline.selectFile(file, commit)).toEqual({
      documentPath: 'inbox/a',
      documentTitle: 'Document A',
      revisionId: 'revision-sha',
      parentRevisionId: 'parent-sha',
      revisionTime: commit.modifiedAt,
      summary: 'Update note',
    })
    expect(toHistoryRevisionSelection(file, commit).revisionId).toBe('revision-sha')
  })

  it('uses the first parent for merge commits instead of filtered-log ordering', () => {
    const groups = buildHistoryDayGroups([
      record('merge-sha', new Date(2026, 7, 1, 14), 'Merge', ['inbox/a.md'], ['first-parent', 'second-parent']),
    ], [], 'en-US')
    const commit = groups[0]!.commits[0]!
    expect(commit.parentId).toBe('first-parent')
  })

  it('keeps the timeline collapsed by default, retains expansion on refresh, and cleans removed commits', async () => {
    const first = record('first', new Date(2026, 7, 1, 12), 'First', ['inbox/a.md'])
    const second = record('second', new Date(2026, 6, 30, 12), 'Second', ['inbox/b.md'])
    const log = ref([first, second])
    const logLoaded = ref(false)
    const timeline = useHistoryTimeline({ log, logLoaded }, ref([]), ref('en-US'))
    timeline.toggleCommit('first')
    logLoaded.value = true
    await nextTick()

    expect(timeline.expandedDays.value.size).toBe(0)
    expect(timeline.expandedDays.value.has('2026-07-30')).toBe(false)
    expect(timeline.expandedCommits.value.size).toBe(0)

    timeline.toggleDay('2026-07-30')
    timeline.toggleCommit('second')
    log.value = [
      record('new', new Date(2026, 7, 2, 12), 'New', ['inbox/c.md']),
      first,
      second,
    ]
    await nextTick()
    expect(timeline.expandedDays.value.has('2026-07-30')).toBe(true)
    expect(timeline.expandedCommits.value.has('second')).toBe(true)
    expect(timeline.expandedCommits.value.has('new')).toBe(false)

    log.value = [first]
    await nextTick()
    expect(timeline.expandedCommits.value.has('second')).toBe(false)
  })
})

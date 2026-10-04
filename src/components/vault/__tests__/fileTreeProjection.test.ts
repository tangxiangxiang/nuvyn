import { describe, expect, it } from 'vitest'
import type { PostSummary, TreeNode } from '../../../lib/api'
import { parseTagQuery } from '../../../lib/tags'
import { managedDiaryPathsInProjection } from '../../../features/diary/diaryAnalysisExport'
import { projectFileTree } from '../fileTreeProjection'

const posts: PostSummary[] = [
  { path: 'diary/2026-09-01', title: 'Work reflection', tags: ['work'], summary: 'secret body', created: '', updated: '', size: 0, mtime: 0 },
  { path: 'diary/2026-09-02', title: 'Rest reflection', tags: ['rest'], created: '', updated: '', size: 0, mtime: 0 },
  { path: 'diary/2026-09-03', title: 'Work reflection', tags: ['work', 'stress'], created: '', updated: '', size: 0, mtime: 0 },
]
const tree: TreeNode[] = [{ kind: 'folder', path: '', name: 'content', children: [
  { kind: 'folder', path: 'diary', name: 'diary', children: [
    ...posts.map((post): TreeNode => ({ kind: 'file', name: post.path.slice(6), path: post.path, title: post.title, mtime: 0 })),
    { kind: 'file', name: '2026-09-04', path: 'diary/2026-09-04', title: 'Work reflection', mtime: 0 },
    { kind: 'folder', name: 'legacy', path: 'diary/legacy', children: [
      { kind: 'file', name: 'child', path: 'diary/legacy/child', title: 'Work reflection', mtime: 0 },
    ] },
  ] },
  { kind: 'folder', name: 'inbox', path: 'inbox', children: [
    { kind: 'file', name: 'note', path: 'inbox/note', title: 'Work reflection', mtime: 0 },
  ] },
] }]

function paths(nodes: readonly TreeNode[]): string[] {
  return nodes.flatMap((node) => node.kind === 'file' ? [node.path] : paths(node.children))
}

describe('shared FileTree projection', () => {
  it.each([
    ['2026-09', ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']],
    ['work reflection', ['2026-09-01', '2026-09-03', '2026-09-04']],
    ['#work -#stress', ['2026-09-01']],
    ['#rest reflection', ['2026-09-02']],
    ['secret body', []],
    ['#missing', []],
    ['#', ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']],
  ])('preserves query semantics and managed export scope for %s', (filter, dates) => {
    const result = projectFileTree({ tree, posts, scope: 'diary', query: parseTagQuery(filter) })
    expect(managedDiaryPathsInProjection(result)).toEqual(dates.map((date) => `diary/${date}`))
    expect(managedDiaryPathsInProjection(result)).toEqual(paths(result).filter((path) => /^diary\/2026-09-\d\d$/.test(path)))
    expect(result.some((node) => node.path === 'diary')).toBe(false)
  })

  it('retains typed includeAny semantics even though the current parser does not generate them', () => {
    const query = { ...parseTagQuery('-#stress'), includeAny: ['rest', 'work'] }
    const result = projectFileTree({ tree, posts, scope: 'diary', query })
    expect(managedDiaryPathsInProjection(result)).toEqual(['diary/2026-09-01', 'diary/2026-09-02'])
  })

  it('intersects exact path with the existing query, never broadening a missing match', () => {
    for (const filter of ['', '#work', '2026-09']) {
      const result = projectFileTree({ tree, posts, scope: 'diary', query: parseTagQuery(filter), exactPathFilter: 'diary/2026-09-03' })
      expect(paths(result)).toEqual(['diary/2026-09-03'])
      expect(managedDiaryPathsInProjection(result)).toEqual(paths(result))
    }
    expect(projectFileTree({ tree, posts, scope: 'diary', query: parseTagQuery('-#stress'), exactPathFilter: 'diary/2026-09-03' })).toEqual([])
    expect(projectFileTree({ tree, posts, scope: 'diary', query: parseTagQuery(''), exactPathFilter: 'diary/2026-09-30' })).toEqual([])
  })

  it('keeps Note scope behavior and does not export Diary from another workspace', () => {
    const result = projectFileTree({ tree, posts, scope: 'note', query: parseTagQuery('work') })
    expect(paths(result)).toEqual(['inbox/note'])
    expect(managedDiaryPathsInProjection(result)).toEqual([])
  })

  it('keeps unmanaged Diary presentation but does not include it in an analysis export', () => {
    const result = projectFileTree({ tree, posts, scope: 'diary', query: parseTagQuery('legacy') })
    expect(paths(result)).toEqual(['diary/legacy/child'])
    expect(managedDiaryPathsInProjection(result)).toEqual([])
  })

  it('does not mutate the original tree, posts or query during projection', () => {
    const query = parseTagQuery('#work')
    const before = JSON.stringify({ tree, posts, query })
    projectFileTree({ tree, posts, scope: 'diary', query, exactPathFilter: 'diary/2026-09-01' })
    expect(JSON.stringify({ tree, posts, query })).toBe(before)
  })

  it('returns an empty projection for missing or non-folder implicit roots', () => {
    expect(projectFileTree({ tree: [], posts, scope: 'diary', query: parseTagQuery('') })).toEqual([])
    expect(projectFileTree({ tree: [{ kind: 'file', name: 'bad-root', path: 'diary/2026-09-01', title: '', mtime: 0 }], posts, scope: 'diary', query: parseTagQuery('') })).toEqual([])
  })
})

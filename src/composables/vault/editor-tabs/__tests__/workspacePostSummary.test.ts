import { describe, expect, it } from 'vitest'
import type { PostSummary, TreeNode } from '../../../../lib/api'
import {
  applyPostSummaryToWorkspace,
  createLocalPostPatchTracker,
  upsertPostSummary,
  upsertTreeFile,
} from '../workspacePostSummary'

function post(path: string, overrides: Partial<PostSummary> = {}): PostSummary {
  return {
    path,
    title: path,
    created: '2026-01-01',
    updated: '2026-01-01',
    tags: [],
    summary: '',
    size: 1,
    mtime: 1,
    ...overrides,
  }
}

function file(path: string, title = path, mtime = 1): TreeNode {
  return { kind: 'file', path, name: path.split('/').pop()!, title, mtime }
}

function root(children: TreeNode[]): TreeNode {
  return { kind: 'folder', path: '', name: 'content', children }
}

function findFile(nodes: readonly TreeNode[], path: string): Extract<TreeNode, { kind: 'file' }> | null {
  for (const node of nodes) {
    if (node.kind === 'file' && node.path === path) return node
    if (node.kind === 'folder') {
      const found = findFile(node.children, path)
      if (found) return found
    }
  }
  return null
}

describe('Workspace PostSummary patches', () => {
  it('upserts posts by path with a cloned response and natural path sorting', () => {
    const incoming = post('chapter2', { tags: ['new'], size: 20, mtime: 2 })
    const result = upsertPostSummary([
      post('chapter10'),
      post('chapter2', { size: 10 }),
      post('chapter2', { size: 11 }),
    ], incoming)

    expect(result.map((item) => item.path)).toEqual(['chapter2', 'chapter10'])
    expect(result[0]).toMatchObject({ size: 20, mtime: 2 })
    expect(result[0]).not.toBe(incoming)
    expect(result[0]!.tags).not.toBe(incoming.tags)
  })

  it('replaces only the matching file node and preserves unrelated references', () => {
    const unrelated = file('inbox/other', 'Other', 1)
    const folder: TreeNode = {
      kind: 'folder', path: 'inbox', name: 'inbox',
      children: [file('inbox/note', 'Old', 1), unrelated],
    }
    const tree = [root([folder])]
    const result = upsertTreeFile(tree, post('inbox/note', { title: 'New', mtime: 2 }))

    expect(findFile(result, 'inbox/note')).toMatchObject({ title: 'New', mtime: 2 })
    expect(findFile(result, 'inbox/other')).toBe(unrelated)
    expect(result).not.toBe(tree)
  })

  it('distinguishes same-path folders from files and removes duplicate file nodes', () => {
    const samePathFolder: TreeNode = {
      kind: 'folder', path: 'notes', name: 'notes', children: [file('notes/child')],
    }
    const tree = [root([file('notes', 'Old 1'), samePathFolder, file('notes', 'Old 2')])]
    const result = upsertTreeFile(tree, post('notes', { title: 'New', mtime: 3 }))
    const rootNode = result[0] as Extract<TreeNode, { kind: 'folder' }>

    expect(rootNode.children.filter((node) => node.kind === 'file' && node.path === 'notes')).toHaveLength(1)
    expect(rootNode.children.find((node) => node.kind === 'folder' && node.path === 'notes')).toBe(samePathFolder)
    expect(findFile(result, 'notes')).toMatchObject({ title: 'New', mtime: 3 })
  })

  it('creates missing parent folders without removing an existing same-path file', () => {
    const samePathFile = file('inbox', 'Inbox note')
    const result = upsertTreeFile(
      [root([samePathFile])],
      post('inbox/backend/note', { title: 'Backend note', mtime: 4 }),
    )

    expect(findFile(result, 'inbox')).toBe(samePathFile)
    expect(findFile(result, 'inbox/backend/note')).toMatchObject({
      title: 'Backend note', mtime: 4,
    })
  })

  it('updates posts and tree from one authoritative summary', () => {
    const result = applyPostSummaryToWorkspace(
      [root([file('a', 'Old', 1)])],
      [post('a', { title: 'Old', mtime: 1 })],
      post('a', { title: 'New', size: 20, mtime: 2 }),
    )

    expect(result.posts[0]).toMatchObject({ title: 'New', size: 20, mtime: 2 })
    expect(findFile(result.tree, 'a')).toMatchObject({ title: 'New', mtime: 2 })
  })

  it('preserves the managed Diary Mood and metadata version in replacement summaries', () => {
    const incoming = post('diary/2026-08-24', {
      mood: 'future-mood-v3',
      documentId: 'diary-id',
      metadataUpdatedAt: 42,
    })
    const result = applyPostSummaryToWorkspace(
      [root([file('diary/2026-08-24')])],
      [post('diary/2026-08-24', { mood: 'happy', documentId: 'diary-id', metadataUpdatedAt: 41 })],
      incoming,
    )

    expect(result.posts[0]).toMatchObject({
      path: 'diary/2026-08-24',
      mood: 'future-mood-v3',
      documentId: 'diary-id',
      metadataUpdatedAt: 42,
    })
  })

  it('settles only patches that existed when an accepted refresh started', () => {
    const tracker = createLocalPostPatchTracker()
    tracker.record(post('a', { mtime: 1 }))
    const startedAt = tracker.currentSeq()
    tracker.record(post('a', { mtime: 2 }))

    expect(tracker.after(startedAt).map((patch) => patch.post.mtime)).toEqual([2])
    tracker.settleThrough(startedAt)
    expect(tracker.pendingCount()).toBe(1)
    expect(tracker.after(startedAt).map((patch) => patch.post.mtime)).toEqual([2])

    tracker.settleThrough(tracker.currentSeq())
    expect(tracker.pendingCount()).toBe(0)
  })
})

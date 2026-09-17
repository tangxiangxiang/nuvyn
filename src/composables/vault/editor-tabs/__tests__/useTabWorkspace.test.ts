import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  getPost: vi.fn(),
  getTree: vi.fn(),
  listPosts: vi.fn(),
}))

vi.mock('../../../../lib/api', () => api)
vi.mock('vue-router', () => ({ useRouter: () => ({ replace: vi.fn() }) }))

import { useTabWorkspace } from '../useTabWorkspace'

function workspaceOptions() {
  return {
    confirm: async () => true,
    toastError: vi.fn(),
    toastInfo: vi.fn(),
  }
}

function postDetail(path: string) {
  return {
    path, raw: 'body', content: 'body', frontmatter: {},
    metadata: {
      id: 'doc', path, title: 'title', summary: '', tags: [],
      createdAt: 1, updatedAt: 1,
    },
    size: 4, mtime: 1,
  }
}

describe('useTabWorkspace openPost workspace refresh', () => {
  beforeEach(() => {
    api.getPost.mockReset()
    api.getTree.mockReset()
    api.listPosts.mockReset()
    api.getTree.mockResolvedValue([])
    api.listPosts.mockResolvedValue([])
  })

  it('propagates a workspace refresh failure by default', async () => {
    api.getPost.mockResolvedValue(postDetail('notes/a'))
    api.getTree.mockRejectedValue(new Error('tree refresh failed'))
    const workspace = useTabWorkspace(workspaceOptions())

    await expect(workspace.openPost('notes/a')).rejects.toThrow('tree refresh failed')

    // The document itself loaded — only the tree/posts refresh failed.
    const tab = workspace.tabs.value[0]
    expect(tab?.raw).toBe('body')
    expect(tab?.loadError).toBeNull()
    expect(tab?.loading).toBe(false)
  })

  it('loads the document and skips the workspace refresh with refresh: false', async () => {
    api.getPost.mockResolvedValue(postDetail('notes/b'))
    // A refresh failure that would reject a default openPost.
    api.getTree.mockRejectedValue(new Error('tree refresh failed'))
    api.listPosts.mockRejectedValue(new Error('posts refresh failed'))
    const workspace = useTabWorkspace(workspaceOptions())

    await expect(workspace.openPost('notes/b', { refresh: false })).resolves.toBeUndefined()

    expect(api.getTree).not.toHaveBeenCalled()
    expect(api.listPosts).not.toHaveBeenCalled()
    const tab = workspace.tabs.value[0]
    expect(tab?.raw).toBe('body')
    expect(tab?.loadError).toBeNull()
    expect(tab?.loading).toBe(false)
  })
})

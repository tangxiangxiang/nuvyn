import { it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as historyGit from '../history/git.js'
import { ensureRepo } from '../history/repo.js'
import { setContentDir, CONTENT_DIR } from '../paths.js'
import {
  cleanupHistoryTempRepo,
  describeHistoryIntegration,
} from './helpers/historyIntegration.js'

const { commitMessageMock } = vi.hoisted(() => ({
  commitMessageMock: vi.fn(),
}))

vi.mock('../ai/commitMessage.js', () => ({
  generateCommitMessage: commitMessageMock,
  CommitMessagePromptLimitError: class CommitMessagePromptLimitError extends Error {},
}))

import aiRoutes from '../ai/routes.js'

let root: string
const originalContentDir = CONTENT_DIR

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-ai-history-'))
  setContentDir(root)
  await ensureRepo(root)
  commitMessageMock.mockReset()
  commitMessageMock.mockResolvedValue('Update changed note')
})

afterEach(async () => {
  setContentDir(originalContentDir)
  await cleanupHistoryTempRepo(root)
})

async function call(body: unknown): Promise<Response> {
  return aiRoutes.fetch(new Request('http://localhost/commit-message', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

async function write(filePath: string, content: string): Promise<void> {
  await fs.writeFile(path.join(root, filePath), content, 'utf8')
}

describeHistoryIntegration('POST /api/ai/commit-message History boundary', () => {
  it.each([
    ['.git/config'],
    ['.nuvyn/vault-writer.json'],
    ['../secret.md'],
    ['notes/not-text.txt'],
    ['/tmp/secret.md'],
    ['notes\\secret.md'],
  ])('rejects unsafe path %s before calling the AI provider', async (filePath) => {
    const response = await call({ paths: [filePath], language: 'en' })
    expect(response.status).toBe(400)
    expect(commitMessageMock).not.toHaveBeenCalled()
  })

  it('rejects a mixed valid and invalid path list as one request', async () => {
    await write('good.md', 'changed')
    const response = await call({ paths: ['good.md', '.git/config'], language: 'en' })
    expect(response.status).toBe(400)
    expect(commitMessageMock).not.toHaveBeenCalled()
  })

  it('rejects duplicate paths without producing duplicate work', async () => {
    await write('good.md', 'changed')
    const response = await call({ paths: ['good.md', 'good.md'], language: 'en' })
    expect(response.status).toBe(400)
    expect(commitMessageMock).not.toHaveBeenCalled()
  })

  it('rejects a valid Markdown path that is no longer changed', async () => {
    await write('good.md', 'initial')
    await historyGit.addAndCommit(root, ['good.md'], 'initial')
    const response = await call({ paths: ['good.md'], language: 'en' })
    expect(response.status).toBe(409)
    expect(commitMessageMock).not.toHaveBeenCalled()
  })

  it('generates from a changed Markdown path after rechecking status', async () => {
    await write('good.md', 'changed')
    const response = await call({ paths: ['good.md'], language: 'en' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ message: 'Update changed note' })
    expect(commitMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      paths: ['good.md'],
      changes: [expect.objectContaining({ path: 'good.md', changeKind: 'added' })],
    }))
  })

  it('sends line-oriented unified Diff text for modified, added, and deleted files', async () => {
    await write('modified.md', 'first\nold\nlast\n')
    await write('deleted.md', 'line1\nline2\n')
    await historyGit.addAndCommit(root, ['modified.md', 'deleted.md'], 'initial')
    await write('modified.md', 'first\nnew\nlast\n')
    await write('added.md', 'line1\nline2\n')
    await fs.rm(path.join(root, 'deleted.md'))

    const response = await call({
      paths: ['modified.md', 'added.md', 'deleted.md'],
      language: 'en',
    })

    expect(response.status).toBe(200)
    const request = commitMessageMock.mock.calls[0]?.[0] as {
      changes: Array<{ path: string; changeKind: string; diff: string }>
    }
    expect(request.changes).toEqual([
      { path: 'modified.md', changeKind: 'modified', diff: ' first\n-old\n+new\n last' },
      { path: 'added.md', changeKind: 'added', diff: '+line1\n+line2' },
      { path: 'deleted.md', changeKind: 'deleted', diff: '-line1\n-line2' },
    ])
    expect(request.changes.every((change) => !change.diff.startsWith('\n') && !change.diff.endsWith('\n'))).toBe(true)
  })

  it('rejects a changed symlink Markdown path without reading or sending its target', async () => {
    if (process.platform === 'win32') return
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-ai-outside-'))
    try {
      await fs.writeFile(path.join(outside, 'secret.md'), 'outside secret', 'utf8')
      await fs.symlink(path.join(outside, 'secret.md'), path.join(root, 'link.md'))
      const response = await call({ paths: ['link.md'], language: 'en' })
      expect(response.status).toBe(400)
      expect(commitMessageMock).not.toHaveBeenCalled()
    } finally {
      await fs.rm(outside, {
        recursive: true,
        force: true,
        maxRetries: process.platform === 'win32' ? 10 : 3,
        retryDelay: 100,
      })
    }
  })

  it('rejects a too-large added file before calling the AI provider', async () => {
    await write('large.md', 'x'.repeat(256 * 1024 + 1))
    const response = await call({ paths: ['large.md'], language: 'en' })
    expect(response.status).toBe(413)
    expect(commitMessageMock).not.toHaveBeenCalled()
  })

  it('applies the same budget to a deleted historical blob', async () => {
    await write('large.md', 'x'.repeat(256 * 1024 + 1))
    await historyGit.addAndCommit(root, ['large.md'], 'large')
    await fs.rm(path.join(root, 'large.md'))
    const response = await call({ paths: ['large.md'], language: 'en' })
    expect(response.status).toBe(413)
    expect(commitMessageMock).not.toHaveBeenCalled()
  })
})

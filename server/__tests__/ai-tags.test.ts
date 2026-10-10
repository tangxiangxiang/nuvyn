import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setContentDir, CONTENT_DIR } from '../paths.js'
import { ChatError } from '../ai/errors.js'

const { tagsMock, titleMock } = vi.hoisted(() => ({ tagsMock: vi.fn(), titleMock: vi.fn() }))
vi.mock('../ai/tags.js', () => ({ generateTags: tagsMock }))
vi.mock('../ai/title.js', () => ({ generateTitle: titleMock }))
import aiRoutes from '../ai/routes.js'

let root: string
const originalContentDir = CONTENT_DIR
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-ai-tags-'))
  setContentDir(root)
  tagsMock.mockReset().mockResolvedValue(['Vue', 'TypeScript'])
  titleMock.mockReset().mockResolvedValue('Vue components')
})
afterEach(async () => {
  setContentDir(originalContentDir)
  await fs.rm(root, { recursive: true, force: true })
})
function call(body: unknown) {
  return aiRoutes.fetch(new Request('http://localhost/tags', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }))
}
describe('POST /api/ai/tags', () => {
  it('also generates a title through the protected metadata route', async () => {
    const response = await aiRoutes.fetch(new Request('http://localhost/title', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'note', content: '# Vue', language: 'zh' }),
    }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ title: 'Vue components' })
    expect(titleMock).toHaveBeenCalledWith(expect.objectContaining({ content: '# Vue', language: 'zh' }))
  })
  it('uses unsaved editor content', async () => {
    const response = await call({ path: 'note', content: '# Vue', language: 'zh' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ tags: ['Vue', 'TypeScript'] })
    expect(tagsMock).toHaveBeenCalledWith(expect.objectContaining({ path: 'note', content: '# Vue', language: 'zh' }))
  })
  it('reads Markdown without frontmatter', async () => {
    await fs.writeFile(path.join(root, 'note.md'), '---\ntags: [old]\n---\n# Body')
    expect((await call({ path: 'note' })).status).toBe(200)
    expect(tagsMock).toHaveBeenCalledWith(expect.objectContaining({ content: '# Body' }))
  })
  it('rejects invalid paths, content, empty documents and oversized prompts', async () => {
    expect((await call({ path: '../secret', content: 'body' })).status).toBe(400)
    expect((await call({ path: 'note', content: 5 })).status).toBe(400)
    expect((await call({ path: 'note', content: ' ' })).status).toBe(400)
    expect((await call({ path: 'note', content: 'a'.repeat(20_001) })).status).toBe(413)
    expect((await call({ path: 'missing' })).status).toBe(404)
    expect(tagsMock).not.toHaveBeenCalled()
  })
  it('returns actionable AI configuration and parse errors', async () => {
    tagsMock.mockRejectedValueOnce(new ChatError('no-api-key'))
    expect((await call({ path: 'note', content: 'body' })).status).toBe(503)
    tagsMock.mockRejectedValueOnce(new ChatError('parse-failed'))
    expect((await call({ path: 'note', content: 'body' })).status).toBe(502)
  })
  it('rejects managed Diary content before sending anything to AI', async () => {
    const response = await call({ path: 'diary/2026-08-24', content: 'private diary' })
    expect(response.status).toBe(422)
    expect(tagsMock).not.toHaveBeenCalled()
  })
})

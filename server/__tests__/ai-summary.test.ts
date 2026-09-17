import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setContentDir, CONTENT_DIR } from '../paths.js'

const { summaryMock } = vi.hoisted(() => ({
  summaryMock: vi.fn(),
}))

vi.mock('../ai/summary.js', () => ({
  generateSummary: summaryMock,
  SummaryPromptLimitError: class SummaryPromptLimitError extends Error {},
}))

import aiRoutes from '../ai/routes.js'

let root: string
const originalContentDir = CONTENT_DIR

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-ai-summary-'))
  setContentDir(root)
  summaryMock.mockReset().mockResolvedValue('Generated summary')
})

afterEach(async () => {
  setContentDir(originalContentDir)
  await fs.rm(root, { recursive: true, force: true })
})

async function call(body: unknown): Promise<Response> {
  return aiRoutes.fetch(new Request('http://localhost/summary', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

describe('POST /api/ai/summary', () => {
  it('validates the document path before reading or calling AI', async () => {
    const response = await call({ path: '../secret', language: 'zh' })
    expect(response.status).toBe(400)
    expect(summaryMock).not.toHaveBeenCalled()
  })

  it('reads the current Markdown body without Frontmatter', async () => {
    await fs.writeFile(
      path.join(root, 'inbox-note.md'),
      '---\ntitle: Note\nsummary: Old summary\n---\n\n# Heading\n\nThe document body.',
      'utf8',
    )
    const response = await call({ path: 'inbox-note', language: 'zh' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ summary: 'Generated summary' })
    expect(summaryMock).toHaveBeenCalledWith(expect.objectContaining({
      path: 'inbox-note',
      language: 'zh',
      content: '# Heading\n\nThe document body.',
    }))
  })

  it('returns 404 without calling AI when the document is missing', async () => {
    const response = await call({ path: 'missing', language: 'en' })
    expect(response.status).toBe(404)
    expect(summaryMock).not.toHaveBeenCalled()
  })

  it('uses client-provided editor content without reading the file', async () => {
    const response = await call({ path: 'inbox-note', language: 'en', content: '# Unsaved editor body' })
    expect(response.status).toBe(200)
    expect(summaryMock).toHaveBeenCalledWith(expect.objectContaining({
      path: 'inbox-note',
      content: '# Unsaved editor body',
    }))
  })

  it('rejects non-string and empty client content', async () => {
    expect((await call({ path: 'note', content: 42 })).status).toBe(400)
    expect((await call({ path: 'note', content: '   ' })).status).toBe(400)
    expect(summaryMock).not.toHaveBeenCalled()
  })
})

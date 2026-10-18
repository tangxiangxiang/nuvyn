// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Blob as NodeBlob } from 'node:buffer'
import { canExportMarkdownDocument, captureDocumentExportSnapshot, downloadMarkdownDocument, markdownExportFilename } from '../documentExport'

const original = '---\r\ntitle: 中文 🚀\r\ncustom: keep\r\n---\r\n:::: flex direction=row\r\n![图](@/attachments/images/a.svg)\r\n::::\r\n> [!NOTE]\r\n> 原文\r\n```mermaid\r\nA-->B\r\n```\r\n```markmap\r\n# Map\r\n```\r\n$E=mc^2$ [[target]]\r\n<!--@include: ./other.md-->\r\n<<< ./snippet.ts\r\n![Board](board:8a1c2544-dad0-4f20-a593-7bbc59882921)\r\n'

describe('Document export source snapshots', () => {
  it('captures the exact loaded target buffer without saving, parsing or fetching', async () => {
    const active = { path: 'inbox/active', raw: 'wrong', title: 'Active', loading: false }
    const target = { path: 'archive/target', raw: original, title: 'Display title', loading: false }
    const getPost = vi.fn()
    const pending = captureDocumentExportSnapshot(target.path, { tabs: [active, target], posts: [], getPost })
    target.raw = 'later edit'
    const snapshot = await pending
    expect(snapshot).toEqual({ path: 'archive/target', raw: original, title: 'Display title', filename: 'target.md' })
    expect(getPost).not.toHaveBeenCalled()
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(active.raw).toBe('wrong')
  })

  it.each([
    ['unopened', []],
    ['loading', [{ path: 'inbox/target', raw: 'partial', title: 'Tab', loading: true }]],
    ['load error', [{ path: 'inbox/target', raw: 'partial', title: 'Tab', loading: false, loadError: 'failed' }]],
  ])('reads the authenticated target for an %s document', async (_kind, tabs) => {
    const getPost = vi.fn(async () => ({ raw: original, metadata: { title: 'Server title' } }))
    const result = await captureDocumentExportSnapshot('inbox/target', { tabs, posts: [], getPost })
    expect(getPost).toHaveBeenCalledExactlyOnceWith('inbox/target')
    expect(result.raw).toBe(original)
    expect(result.title).toBe('Server title')
  })

  it('keeps delayed, out-of-order reads tied to their original paths', async () => {
    let finishA!: (value: { raw: string }) => void
    const getPost = vi.fn((path: string) => path === 'inbox/a'
      ? new Promise<{ raw: string }>((resolve) => { finishA = resolve })
      : Promise.resolve({ raw: 'B\n' }))
    const a = captureDocumentExportSnapshot('inbox/a', { tabs: [], posts: [], getPost })
    const b = await captureDocumentExportSnapshot('inbox/b', { tabs: [], posts: [], getPost })
    finishA({ raw: 'A\r\n' })
    expect((await a).raw).toBe('A\r\n')
    expect(b).toMatchObject({ path: 'inbox/b', raw: 'B\n' })
  })

  it('does not replace an empty loaded buffer with disk content', async () => {
    const getPost = vi.fn()
    const result = await captureDocumentExportSnapshot('inbox/empty', {
      tabs: [{ path: 'inbox/empty', raw: '', title: '', loading: false }], posts: [], getPost,
    })
    expect(result.raw).toBe('')
    expect(getPost).not.toHaveBeenCalled()
  })
})

describe('Markdown filenames and permissions', () => {
  it.each([
    ['inbox/java-interview', 'java-interview.md'],
    ['inbox/already.md', 'already.md'],
    ['inbox/中文 空格 🚀.MD', '中文 空格 🚀.md'],
    ['inbox/a<>:"|?*\u0000.md', 'a--------.md'],
    ['inbox/CON.md', '_CON.md'],
    ['inbox/report. ', 'report.md'],
    ['inbox/.md', 'nuvyn-document.md'],
    ['', 'nuvyn-document.md'],
  ])('uses a safe original basename for %s', (path, expected) => {
    expect(markdownExportFilename(path)).toBe(expected)
  })
  it('bounds UTF-8 bytes without splitting Unicode characters', () => {
    const filename = markdownExportFilename(`inbox/${'中文🚀'.repeat(100)}.md`)
    expect(new TextEncoder().encode(filename).length).toBeLessThanOrEqual(203)
    expect(filename).not.toContain('\ufffd')
    expect(filename.endsWith('.md')).toBe(true)
  })
  it.each(['diary/2026-10-18', 'diary/2026-10-18.md', 'diary/2026-10-18.MD', 'diary', 'inbox/../diary/2026-10-18', 'diary\\2026-10-18', '/diary/2026-10-18'])('rejects protected or noncanonical paths: %s', (path) => {
    expect(canExportMarkdownDocument(path)).toBe(false)
  })
  it.each(['inbox/a', 'literature/a', 'archive/a', 'custom/a', 'diary/legacy'])('retains ordinary document access: %s', (path) => {
    expect(canExportMarkdownDocument(path)).toBe(true)
  })
})

describe('Markdown browser downloads', () => {
  const create = vi.fn((_blob: Blob) => 'blob:export')
  const revoke = vi.fn()
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('Blob', NodeBlob)
    vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke })
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })
  const snapshot = { path: 'inbox/source', raw: original, title: 'Not a filename', filename: 'source.md' }

  it('downloads exact UTF-8 text and releases the URL after a Safari-safe grace period', async () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe('source.md')
      expect(this.isConnected).toBe(true)
      expect(this.hidden).toBe(true)
    })
    downloadMarkdownDocument(snapshot)
    expect(document.querySelector('a[download]')).toBeNull()
    const blob = create.mock.calls[0]![0] as unknown as NodeBlob
    expect(blob.type).toBe('text/markdown;charset=utf-8')
    expect(await blob.text()).toBe(original)
    expect(revoke).not.toHaveBeenCalled()
    vi.advanceTimersByTime(59_999)
    expect(revoke).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:export')
  })

  it('cleans up immediately if clicking fails', () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => { throw new Error('blocked') })
    expect(() => downloadMarkdownDocument(snapshot)).toThrow('blocked')
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:export')
    expect(document.querySelector('a[download]')).toBeNull()
  })
  it('does not create a URL after cancellation or for managed Diary', () => {
    downloadMarkdownDocument(snapshot, () => false)
    expect(() => downloadMarkdownDocument({ ...snapshot, path: 'diary/2026-10-18' })).toThrow('MARKDOWN_EXPORT_NOT_ALLOWED')
    expect(create).not.toHaveBeenCalled()
  })
})

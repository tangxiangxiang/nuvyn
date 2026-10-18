// @vitest-environment jsdom
import { effectScope, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDocumentExport } from '../useDocumentExport'
import { downloadMarkdownDocument } from '../../../lib/documentExport'
import type { DocumentExportSnapshot } from '../../../lib/documentExport'
import { downloadHtmlDocument } from '../../../lib/htmlExport'
import { advanceAuthSessionGeneration, captureAuthSessionGeneration, observeAuthSessionResponse } from '../../../lib/auth-session'

vi.mock('../../../lib/htmlExport', () => ({ downloadHtmlDocument: vi.fn() }))

vi.mock('../../../lib/documentExport', async (original) => ({
  ...await original<typeof import('../../../lib/documentExport')>(),
  downloadMarkdownDocument: vi.fn(),
}))
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers() })

function setup() {
  const options = {
    pdfBusy: ref(false),
    snapshot: vi.fn(async (path: string) => ({ path, raw: 'raw', title: 'Title', filename: 'a.md' })),
    exportPdf: vi.fn(async () => true), onBusy: vi.fn(), onError: vi.fn(),
    exportHtml: vi.fn(async (_snapshot: DocumentExportSnapshot, _signal: AbortSignal) => '<!DOCTYPE html>'),
  }
  const scope = effectScope()
  const controller = scope.run(() => useDocumentExport(options))!
  return { options, scope, controller }
}

describe('Document export transactions', () => {
  it('ignores an old session 401 while exporting in a newer authenticated generation', async () => {
    const { options, scope, controller } = setup()
    const oldGeneration = captureAuthSessionGeneration()
    advanceAuthSessionGeneration()
    let release!: (html: string) => void
    options.exportHtml.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    controller.request('inbox/a')
    const pending = controller.run('html')
    await Promise.resolve()
    await Promise.resolve()
    await observeAuthSessionResponse(new Response(JSON.stringify({ code: 'auth-session-required' }), { status: 401, headers: { 'content-type': 'application/json' } }), oldGeneration)
    expect(controller.busy.value).toBe(true)
    release('<!DOCTYPE html>')
    await pending
    expect(downloadHtmlDocument).toHaveBeenCalledOnce()
    scope.stop()
  })
  it('does not download a timed-out packager result even if the packager resolves late', async () => {
    vi.useFakeTimers()
    const { options, scope, controller } = setup()
    options.exportHtml.mockImplementationOnce(async () => { vi.advanceTimersByTime(45_000); return '<!DOCTYPE html>' })
    controller.request('inbox/a')
    await controller.run('html')
    expect(downloadHtmlDocument).not.toHaveBeenCalled()
    expect(options.onError).toHaveBeenCalledOnce()
    expect(controller.busy.value).toBe(false)
    expect(controller.target.value).toBe('inbox/a')
    scope.stop()
  })
  it('uses the same exact-target source snapshot for HTML and closes after the guarded download', async () => {
    const { options, scope, controller } = setup()
    controller.request('archive/html-target')
    await controller.run('html')
    expect(options.snapshot).toHaveBeenCalledExactlyOnceWith('archive/html-target')
    expect(options.exportHtml).toHaveBeenCalledWith(expect.objectContaining({ path: 'archive/html-target', raw: 'raw' }), expect.any(AbortSignal))
    expect(downloadHtmlDocument).toHaveBeenCalledOnce()
    expect(controller.target.value).toBeNull()
    expect(controller.busy.value).toBe(false)
    scope.stop()
  })
  it('aborts an in-flight HTML surface on cancellation and prevents its late download', async () => {
    const { options, scope, controller } = setup()
    let release!: (html: string) => void
    options.exportHtml.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    controller.request('inbox/a')
    const pending = controller.run('html')
    await Promise.resolve()
    await Promise.resolve()
    const signal = options.exportHtml.mock.calls[0]![1]
    controller.cancel()
    expect(signal.aborted).toBe(true)
    release('<!DOCTYPE html>')
    await pending
    expect(downloadHtmlDocument).not.toHaveBeenCalled()
    expect(controller.busy.value).toBe(false)
    scope.stop()
  })
  it('clears busy and rejects an HTML result from a replaced authentication generation', async () => {
    const { options, scope, controller } = setup()
    options.exportHtml.mockImplementationOnce(async () => { advanceAuthSessionGeneration(); return '<!DOCTYPE html>' })
    controller.request('inbox/a')
    await controller.run('html')
    expect(downloadHtmlDocument).not.toHaveBeenCalled()
    expect(controller.busy.value).toBe(false)
    expect(controller.target.value).toBeNull()
    scope.stop()
  })
  it('keeps the HTML choice retryable after a packaging failure', async () => {
    const { options, scope, controller } = setup()
    options.exportHtml.mockRejectedValueOnce(new Error('missing image'))
    controller.request('inbox/a')
    await controller.run('html')
    expect(options.onError).toHaveBeenCalledOnce()
    expect(controller.target.value).toBe('inbox/a')
    expect(controller.busy.value).toBe(false)
    await controller.run('html')
    expect(downloadHtmlDocument).toHaveBeenCalledOnce()
    scope.stop()
  })
  it('captures the requested non-active path and closes after success', async () => {
    const { options, scope, controller } = setup()
    controller.request('archive/target')
    await controller.run('markdown')
    expect(options.snapshot).toHaveBeenCalledExactlyOnceWith('archive/target')
    expect(downloadMarkdownDocument).toHaveBeenCalledWith(expect.objectContaining({ path: 'archive/target', raw: 'raw' }), expect.any(Function))
    expect(controller.target.value).toBeNull()
    expect(controller.busy.value).toBe(false)
    scope.stop()
  })
  it('prevents duplicates and keeps the original target during a delayed request', async () => {
    const { options, scope, controller } = setup()
    let finish!: (value: Awaited<ReturnType<typeof options.snapshot>>) => void
    options.snapshot.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    controller.request('inbox/a')
    const pending = controller.run('markdown')
    controller.request('inbox/b')
    await controller.run('markdown')
    controller.close()
    expect(controller.busy.value).toBe(true)
    expect(controller.target.value).toBe('inbox/a')
    expect(options.snapshot).toHaveBeenCalledTimes(1)
    finish({ path: 'inbox/a', raw: 'A', title: '', filename: 'a.md' })
    await pending
    expect(downloadMarkdownDocument).toHaveBeenCalledTimes(1)
    scope.stop()
  })
  it('allows retry after a failed source read', async () => {
    const { options, scope, controller } = setup()
    options.snapshot.mockRejectedValueOnce(new Error('offline'))
    controller.request('inbox/a')
    await controller.run('markdown')
    expect(options.onError).toHaveBeenCalledOnce()
    expect(controller.target.value).toBe('inbox/a')
    expect(controller.busy.value).toBe(false)
    await controller.run('markdown')
    expect(downloadMarkdownDocument).toHaveBeenCalledOnce()
    scope.stop()
  })
  it('uses the canonical PDF command and preserves the dialog on PDF failure', async () => {
    const { options, scope, controller } = setup()
    options.exportPdf.mockResolvedValueOnce(false)
    controller.request('inbox/a')
    await controller.run('pdf')
    expect(options.exportPdf).toHaveBeenCalledExactlyOnceWith('inbox/a')
    expect(options.snapshot).not.toHaveBeenCalled()
    expect(controller.target.value).toBe('inbox/a')
    await controller.run('pdf')
    expect(controller.target.value).toBeNull()
    scope.stop()
  })
  it('never offers or executes Markdown for managed Diary, but retains PDF', () => {
    const { options, scope, controller } = setup()
    controller.request('diary/2026-10-18')
    expect(controller.target.value).toBeNull()
    expect(options.exportPdf).toHaveBeenCalledExactlyOnceWith('diary/2026-10-18')
    expect(options.snapshot).not.toHaveBeenCalled()
    expect(downloadMarkdownDocument).not.toHaveBeenCalled()
    scope.stop()
  })
  it.each(['cancel', 'dispose'] as const)('does not download a late response after %s', async (action) => {
    const { options, scope, controller } = setup()
    let finish!: (value: Awaited<ReturnType<typeof options.snapshot>>) => void
    options.snapshot.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    controller.request('inbox/a')
    const pending = controller.run('markdown')
    if (action === 'cancel') controller.cancel()
    else scope.stop()
    finish({ path: 'inbox/a', raw: 'late', title: '', filename: 'a.md' })
    await pending
    expect(downloadMarkdownDocument).not.toHaveBeenCalled()
    expect(controller.busy.value).toBe(false)
    expect(controller.target.value).toBeNull()
    scope.stop()
  })
  it('does not start while PDF is already busy', async () => {
    const { options, scope, controller } = setup()
    options.pdfBusy.value = true
    controller.request('inbox/a')
    await controller.run('markdown')
    expect(options.onBusy).toHaveBeenCalledOnce()
    expect(options.snapshot).not.toHaveBeenCalled()
    scope.stop()
  })
})

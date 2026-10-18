// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest'
import { auditHtmlArticle, buildHtmlDocument, downloadHtmlDocument, HTML_EXPORT_CSP, prepareHtmlDiagramMath, waitForHtmlWidgets } from '../htmlExport'
import { auditImageSvg, auditStaticCss, bytesDataUrl, createHtmlResourceReader, HTML_EXPORT_LIMITS, localImageUrl } from '../htmlExportResources'
import { authFetch } from '../auth-session'

// Vitest intentionally stubs CSS imports. Use the actual trusted files in
// these module tests; browser geometry is verified independently via file://.
vi.mock('../../style.css?raw', async () => ({ default: (await import('node:fs')).readFileSync('src/style.css', 'utf8') }))
vi.mock('../../shiki.css?raw', async () => ({ default: (await import('node:fs')).readFileSync('src/shiki.css', 'utf8') }))

vi.mock('../auth-session', () => ({ authFetch: vi.fn() }))
const snapshot = { path: 'inbox/中文', raw: '# Title', title: 'Title', filename: '中文.md' }
function article(html: string) {
  const root = document.createElement('article')
  root.className = 'article reading'
  root.innerHTML = html
  return root
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = '' })

describe('self-contained HTML export', () => {
  it('keeps semantic diagram math without WebKit foreignObject relative-position layers', () => {
    const root = article('<svg><foreignObject><div><span class="katex"><span class="katex-mathml"><math><msup style="display:block"><mi>a</mi><mn>2</mn></msup></math></span><span class="katex-html">visual copy</span></span></div></foreignObject></svg>')
    const svg = root.querySelector('svg')!
    prepareHtmlDiagramMath(svg)
    expect(svg.querySelector('.katex-html')).toBeNull()
    expect(svg.querySelector('.katex-mathml')).toBeNull()
    expect(svg.querySelector('math msup')?.textContent).toBe('a2')
    expect(svg.querySelector('math [style]')).toBeNull()
  })
  it('builds HTML5 with escaped title, offline CSP, its own responsive reading styles and no PDF layout', async () => {
    const html = await buildHtmlDocument({ snapshot, article: article('<h1>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</h1><p>正文</p>'), signal: new AbortController().signal })
    expect(html).toMatch(/^<!DOCTYPE html>/u)
    const doc = new DOMParser().parseFromString(html, 'text/html')
    expect(doc.title).toBe('</title><script>alert(1)</script>')
    expect(doc.querySelector('script')).toBeNull()
    expect(doc.querySelector('meta[http-equiv]')?.getAttribute('content')).toBe(HTML_EXPORT_CSP)
    expect(html).toContain('@container (max-width: 600px)')
    expect(html).not.toContain('@page')
    expect(html).not.toContain('.activity-bar')
  })
  it('keeps local anchors and public links but removes internal navigation and transient identity', () => {
    const root = article('<h2 id="target">Target</h2><a href="#target">jump</a><a class="wiki-link" href="/vault/a" data-target="private">wiki</a><a href="https://example.com">site</a>')
    auditHtmlArticle(root)
    expect(root.querySelector('a')?.getAttribute('href')).toBe('#target')
    expect(root.querySelector('.wiki-link')?.hasAttribute('href')).toBe(false)
    expect(root.innerHTML).not.toContain('data-target')
    expect(root.querySelector('a:last-child')?.getAttribute('rel')).toBe('noopener noreferrer')
  })
  it.each(['<script>x</script>', '<iframe src="https://example.com"></iframe>', '<p onclick="x()">x</p>', '<input type="text">'])('rejects active HTML %s', (html) => {
    expect(() => auditHtmlArticle(article(html))).toThrow(/HTML_EXPORT/u)
  })
  it.each(['<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>', '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>', '<svg xmlns="http://www.w3.org/2000/svg"><animate/></svg>', '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///secret">]><svg/>', '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/a.png"/></svg>'])('rejects unsafe image SVG', (source) => {
    expect(() => auditImageSvg(new TextEncoder().encode(source))).toThrow()
  })
  it('accepts static SVG with local gradient references', () => {
    expect(() => auditImageSvg(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="20" height="20" fill="url(#g)"/></svg>'))).not.toThrow()
  })
  it.each(['x{fill:url(https://example.com)}', '@import "https://example.com";', 'x{color:expression(x)}'])('rejects resource CSS', (css) => expect(() => auditStaticCss(css)).toThrow())
  it.each(['https://example.com/a.png', '/api/board/private', '/api/markdown-resources?kind=image&path=../private.png', '/api/markdown-resources?kind=image&path=a.png&source=diary/2026-10-18'])('does not fetch unauthorized image source %s', (url) => {
    expect(() => localImageUrl(url, false)).toThrow()
    expect(authFetch).not.toHaveBeenCalled()
  })
  it('deduplicates authenticated original-byte reads', async () => {
    vi.stubGlobal('Image', class { naturalWidth = 1; naturalHeight = 1; src = ''; decode() { return Promise.resolve() }; removeAttribute() {} })
    const bytes = Uint8Array.from([137,80,78,71,13,10,26,10])
    vi.mocked(authFetch).mockResolvedValue(new Response(bytes, { headers: { 'content-type': 'image/png' } }))
    const reader = createHtmlResourceReader(new AbortController().signal)
    const [a, b] = await Promise.all([reader.read('/api/markdown-resources?kind=image&path=a.png'), reader.read('/api/markdown-resources?kind=image&path=a.png')])
    expect(a.bytes).toEqual(bytes)
    expect(b).toBe(a)
    expect(authFetch).toHaveBeenCalledOnce()
  })
  it.each([403,404,500])('fails rather than exporting missing resources (%s)', async (status) => {
    vi.mocked(authFetch).mockResolvedValue(new Response('', { status }))
    await expect(createHtmlResourceReader(new AbortController().signal).read('/api/markdown-resources?kind=image&path=a.png')).rejects.toThrow('RESOURCE_UNAVAILABLE')
  })
  it('blocks managed Diary in both build and download functions', async () => {
    const diary = { ...snapshot, path: 'diary/2026-10-18' }
    await expect(buildHtmlDocument({ snapshot: diary, article: article('secret'), signal: new AbortController().signal })).rejects.toThrow('NOT_ALLOWED')
    expect(() => downloadHtmlDocument(diary, 'secret', () => true)).toThrow('NOT_ALLOWED')
  })
  it('rejects render errors and cleans cancellation waiters', async () => {
    await expect(waitForHtmlWidgets(article('<span class="markdown-resource-error">missing</span>'), new AbortController().signal)).rejects.toThrow('RENDER_FAILED')
    const controller = new AbortController()
    const pending = waitForHtmlWidgets(article('<div class="mermaid-mount"></div>'), controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow('cancelled')
  })
  it('rejects a claimed PNG whose decoded image is broken', async () => {
    vi.stubGlobal('Image', class { src = ''; decode() { return Promise.reject(new Error('bad image')) }; removeAttribute() {} })
    vi.mocked(authFetch).mockResolvedValue(new Response(Uint8Array.from([137,80,78,71,13,10,26,10]), { headers: { 'content-type': 'image/png' } }))
    await expect(createHtmlResourceReader(new AbortController().signal).read('/api/markdown-resources?kind=image&path=a.png')).rejects.toThrow('bad image')
  })
  it('bounds streamed resource bytes before assembling an oversized image', async () => {
    vi.mocked(authFetch).mockResolvedValue(new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(HTML_EXPORT_LIMITS.resourceBytes + 1)); controller.close() } }), { headers: { 'content-type': 'image/png' } }))
    await expect(createHtmlResourceReader(new AbortController().signal).read('/api/markdown-resources?kind=image&path=a.png')).rejects.toThrow('RESOURCE_SIZE')
  })
  it('cleans the resource timeout and propagates cancellation', async () => {
    const controller = new AbortController()
    vi.mocked(authFetch).mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true })
    }))
    const pending = createHtmlResourceReader(controller.signal).read('/api/markdown-resources?kind=image&path=a.png')
    controller.abort()
    await expect(pending).rejects.toThrow('cancelled')
  })
  it('caps distinct packaged resources including data URLs', async () => {
    vi.stubGlobal('Image', class { naturalWidth = 1; naturalHeight = 1; src = ''; decode() { return Promise.resolve() }; removeAttribute() {} })
    const reader = createHtmlResourceReader(new AbortController().signal)
    const makeUrl = (index: number) => bytesDataUrl(Uint8Array.from([137,80,78,71,13,10,26,10,index]), 'image/png')
    for (let index = 0; index < HTML_EXPORT_LIMITS.resources; index += 1) await reader.read(makeUrl(index))
    await expect(reader.read(makeUrl(128))).rejects.toThrow('RESOURCE_COUNT')
  })
  it('fails a font which passes the header check but cannot be decoded', async () => {
    const bytes = new Uint8Array(48)
    bytes.set([119,79,70,50])
    new DataView(bytes.buffer).setUint32(8, bytes.length)
    vi.mocked(authFetch).mockResolvedValue(new Response(bytes, { headers: { 'content-type': 'font/woff2' } }))
    vi.stubGlobal('FontFace', class { load() { return Promise.reject(new Error('invalid font')) } })
    await expect(createHtmlResourceReader(new AbortController().signal).read('/trusted-font.woff2', true)).rejects.toThrow('invalid font')
  })
  it('downloads only an audited document and releases its Blob URL after the Safari grace period', async () => {
    const html = await buildHtmlDocument({ snapshot, article: article('<h1>Complete</h1>'), signal: new AbortController().signal })
    vi.useFakeTimers()
    const create = vi.fn(() => 'blob:export')
    const revoke = vi.fn()
    vi.stubGlobal('URL', class extends URL { static createObjectURL = create; static revokeObjectURL = revoke })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    downloadHtmlDocument(snapshot, html, () => true)
    expect(create).toHaveBeenCalledOnce()
    expect(document.querySelector('a[download]')).toBeNull()
    expect(revoke).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(revoke).toHaveBeenCalledWith('blob:export')
    expect(() => downloadHtmlDocument(snapshot, '<script>unsafe</script>', () => true)).toThrow('INVALID_DOCUMENT')
    expect(create).toHaveBeenCalledOnce()
  })
})

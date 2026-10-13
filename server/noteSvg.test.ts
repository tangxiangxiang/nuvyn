import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { NOTE_SVG_MAX_BYTES } from '../shared/noteImageProtocol.js'
import { NoteSvgValidationError, sanitizeNoteSvg } from './noteSvg.js'

const woff2 = Buffer.alloc(52)
woff2.write('wOF2', 0, 'ascii')
woff2.writeUInt32BE(52, 8)
woff2.writeUInt16BE(1, 12)
woff2.writeUInt32BE(1, 20)

const VALID_EXCALIDRAW_STYLE_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 240 120" width="240" height="120">
  <metadata>excalidraw scene payload</metadata>
  <defs>
    <linearGradient id="paint0"><stop offset="0%" stop-color="#6270ac"/><stop offset="100%" stop-color="#c4c1fa"/></linearGradient>
    <clipPath id="clip0"><rect x="0" y="0" width="240" height="120"/></clipPath>
    <style class="style-fonts">@font-face { font-family: Excalifont; src: url(data:font/woff2;base64,${woff2.toString('base64')}); }</style>
  </defs>
  <g clip-path="url(#clip0)">
    <path d="M 10 10 L 210 10 L 210 90 Z" fill="url(#paint0)" stroke="#1e1e1e" stroke-width="2"/>
    <text x="16" y="110" font-family="Excalifont, sans-serif" font-size="16px" style="white-space: pre;">Architecture</text>
  </g>
</svg>`

const SVG_11_DOCTYPE = '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">'
const EXCALIDRAW_FIXTURE = readFileSync(new URL('../e2e/fixtures/excalidraw-note-image.svg', import.meta.url))

function bytes(svg: string): Buffer {
  return Buffer.from(svg, 'utf8')
}

function expectRejected(svg: string): void {
  expect(() => sanitizeNoteSvg(bytes(svg))).toThrow(NoteSvgValidationError)
}

describe('Note SVG security profile', () => {
  it('keeps static Excalidraw-style paths, text, clipping, gradients, and bounded WOFF2 data', () => {
    const sanitized = sanitizeNoteSvg(bytes(VALID_EXCALIDRAW_STYLE_SVG)).toString('utf8')
    expect(sanitized).toContain('<linearGradient id="paint0">')
    expect(sanitized).toContain('<clipPath id="clip0">')
    expect(sanitized).toContain('fill="url(#paint0)"')
    expect(sanitized).toContain('clip-path="url(#clip0)"')
    expect(sanitized).toContain(`@font-face{font-family:Excalifont;src:url(data:font/woff2;base64,${woff2.toString('base64')})}`)
    expect(sanitized).toContain('white-space:pre')
    expect(sanitized).toContain('Architecture')
    expect(sanitized).not.toContain('<?xml')
  })

  it('supports standard multi-word font family names without accepting CSS escapes', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text font-family="Helvetica, sans-serif, Segoe UI Emoji">Label</text></svg>'
    expect(sanitizeNoteSvg(bytes(svg)).toString()).toContain('font-family="Helvetica, sans-serif, Segoe UI Emoji"')
    expectRejected('<svg xmlns="http://www.w3.org/2000/svg"><text font-family="Se\\67oe UI">Label</text></svg>')
    expectRejected('<svg xmlns="http://www.w3.org/2000/svg"><text font-family="&quot;Arial&quot; &quot;Helvetica&quot;">Label</text></svg>')
  })

  it('sanitizes an SVG exported by the pinned Excalidraw package', () => {
    const source = EXCALIDRAW_FIXTURE.toString('utf8')
    const sanitized = sanitizeNoteSvg(EXCALIDRAW_FIXTURE).toString('utf8')

    expect(source).toContain('svg-source:excalidraw')
    expect(sanitized).toContain('中文 / English')
    expect(sanitized).toContain('<clipPath')
    expect(sanitized).toContain('<symbol id="image-fixture-png">')
    expect(sanitized).toContain('<use href="#image-fixture-png"')
    expect(sanitized).toContain('<path')
    expect(sanitized).toContain('data:font/woff2;base64,')
  })

  it('retains Excalidraw local symbol/use image and crop mask references only', () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><defs><symbol id="image"><image href="data:image/png;base64,${png.toString('base64')}" width="100%" height="100%" preserveAspectRatio="none"/></symbol><mask id="crop"><rect x="0" y="0" width="10" height="10" fill="#fff"/></mask></defs><g mask="url(#crop)"><use href="#image" x="2" y="2" width="10" height="10"/></g></svg>`
    const sanitized = sanitizeNoteSvg(bytes(svg)).toString('utf8')
    expect(sanitized).toContain('<symbol id="image">')
    expect(sanitized).toContain('<use href="#image"')
    expect(sanitized).toContain('mask="url(#crop)"')
    expectRejected('<svg xmlns="http://www.w3.org/2000/svg"><use href="https://example.test/shape.svg#shape"/></svg>')
    expectRejected('<svg xmlns="http://www.w3.org/2000/svg"><defs><symbol id="safe"><path d="M0 0"/></symbol></defs><use href="#missing"/></svg>')
    const nestedSymbol = '<svg xmlns="http://www.w3.org/2000/svg"><defs><symbol id="base"><path d="M0 0L10 10"/></symbol><symbol id="composed"><use href="#base"/></symbol></defs><use href="#composed"/></svg>'
    expect(sanitizeNoteSvg(bytes(nestedSymbol)).toString()).toContain('<use href="#base"')
    expectRejected('<svg xmlns="http://www.w3.org/2000/svg"><defs><symbol id="loop"><use href="#loop"/></symbol></defs><use href="#loop"/></svg>')
  })

  it('requires paintable document content rather than counting the SVG root or empty containers', () => {
    const emptySvg = [
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
      '<svg xmlns="http://www.w3.org/2000/svg"> \n </svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><title>Title only</title></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><desc>Description only</desc></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><metadata>Metadata only</metadata></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="paint"><stop offset="0%" stop-color="#fff"/></linearGradient></defs></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><defs><path id="unused" d="M0 0L10 10"/></defs></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><mask/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><g><g/></g></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><text> \n <tspan> </tspan></text></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><rect width="0" height="20"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><circle r="0"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><image width="10" height="10"/></svg>',
    ]
    for (const svg of emptySvg) expectRejected(svg)

    const validDrawing = [
      '<path d="M0 0L10 10"/>',
      '<rect width="10" height="20"/>',
      '<circle r="4"/>',
      '<line x1="0px" y1="0" x2="1px" y2="1"/>',
      '<text>Meaningful text</text>',
    ]
    for (const drawing of validDrawing) {
      expect(sanitizeNoteSvg(bytes(`<svg xmlns="http://www.w3.org/2000/svg">${drawing}</svg>`)).byteLength).toBeGreaterThan(0)
    }
  })

  it('accepts used definitions and embedded raster drawings, but rejects cyclic symbol use', () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64')
    const embeddedImage = `<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,${png}" width="10" height="10"/></svg>`
    expect(sanitizeNoteSvg(bytes(embeddedImage)).toString()).toContain('<image')

    const referencedSymbol = '<svg xmlns="http://www.w3.org/2000/svg"><defs><symbol id="shape"><g><path d="M0 0L10 10"/></g></symbol></defs><use href="#shape"/></svg>'
    expect(sanitizeNoteSvg(bytes(referencedSymbol)).toString()).toContain('<use href="#shape"')
    expectRejected('<svg xmlns="http://www.w3.org/2000/svg"><defs><symbol id="first"><use href="#second"/></symbol><symbol id="second"><use href="#first"/></symbol></defs><use href="#first"/></svg>')
  })

  it('strips the standard SVG 1.1 external DTD without loading it', () => {
    const svg = `<?xml version="1.0" standalone="no"?>${SVG_11_DOCTYPE}<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L10 10"/></svg>`
    const sanitized = sanitizeNoteSvg(bytes(svg)).toString('utf8')
    expect(sanitized).toContain('<path d="M0 0L10 10">')
    expect(sanitized).not.toContain('DOCTYPE')
    expectRejected('<!DOCTYPE svg SYSTEM "file:///etc/passwd"><svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>')
    expectRejected(`<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [<!ENTITY x "external text">]><svg xmlns="http://www.w3.org/2000/svg"><text>&x;</text></svg>`)
  })

  it('rejects malformed XML, HTML roots, duplicate IDs, and excessive node counts', () => {
    expectRejected('<svg xmlns="http://www.w3.org/2000/svg"><path></svg>')
    expectRejected('<html><body>not an SVG</body></html>')
    expectRejected('<svg xmlns="http://www.w3.org/2000/svg"><path id="same"/><rect id="same"/></svg>')
    const manyNodes = `<svg xmlns="http://www.w3.org/2000/svg">${'<g/>'.repeat(50_001)}</svg>`
    expect(() => sanitizeNoteSvg(bytes(manyNodes))).toThrow(NoteSvgValidationError)
  })

  it('rejects active elements, event attributes, external resources, and unsafe CSS', () => {
    expectRejected('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    expectRejected('<svg xmlns="http://www.w3.org/2000/svg"><path onload="alert(1)" d="M0 0"/></svg>')
    expectRejected('<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>html</div></foreignObject></svg>')
    expectRejected('<svg xmlns="http://www.w3.org/2000/svg"><image href="javascript:alert(1)" width="10" height="10"/></svg>')
    expectRejected('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.test/image.png" width="10" height="10"/></svg>')
    expectRejected('<svg xmlns="http://www.w3.org/2000/svg"><defs><style>@import url(https://example.test/a.css);</style></defs><path d="M0 0"/></svg>')
    expectRejected('<svg xmlns="http://www.w3.org/2000/svg"><path style="fill: url(https://example.test/a.svg#x)" d="M0 0"/></svg>')
  })

  it('rejects DTDs, entities, processing instructions, and unresolved internal references', () => {
    expectRejected('<!DOCTYPE svg [<!ENTITY x "boom">]><svg xmlns="http://www.w3.org/2000/svg"><text>&x;</text></svg>')
    expectRejected('<?xml-stylesheet href="https://example.test/a.css"?><svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>')
    expectRejected('<svg xmlns="http://www.w3.org/2000/svg"><path fill="url(#missing)" d="M0 0"/></svg>')
    expectRejected('<svg xmlns="http://www.w3.org/2000/svg"><path clip-path="url(#paint)" d="M0 0"/><linearGradient id="paint"/></svg>')
    expectRejected('<svg xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="recursive" clip-path="url(#recursive)"><rect width="1" height="1"/></clipPath></defs><rect width="1" height="1" clip-path="url(#recursive)"/></svg>')
    expectRejected('<svg xmlns="http://www.w3.org/2000/svg"><defs><mask id="recursive" mask="url(#recursive)"><rect width="1" height="1"/></mask></defs><rect width="1" height="1" mask="url(#recursive)"/></svg>')
  })

  it('rejects malformed namespace combinations, escaped external CSS URLs, and bounded parser abuse', () => {
    expectRejected('<svg xmlns="http://www.w3.org/2000/svg"><g xmlns="http://www.w3.org/1999/xhtml"><path d="M0 0L10 10"/></g></svg>')
    expectRejected('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="https://example.test/xlink"><path d="M0 0L10 10"/></svg>')
    expectRejected('<svg xmlns="http://www.w3.org/2000/svg" xmlns:svg="http://www.w3.org/2000/svg"><svg:path d="M0 0L10 10"/></svg>')
    expectRejected('<svg xmlns="http://www.w3.org/2000/svg"><path style="fill:u\\72l(https://example.test/x.svg#paint)" d="M0 0L10 10"/></svg>')
    expectRejected('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0&#x0;L10 10"/></svg>')

    const deep = `<svg xmlns="http://www.w3.org/2000/svg">${'<g>'.repeat(65)}<path d="M0 0L10 10"/>${'</g>'.repeat(65)}</svg>`
    expectRejected(deep)
    const longAttribute = `<svg xmlns="http://www.w3.org/2000/svg"><path d="${'M0 '.repeat(512 * 1024)}"/></svg>`
    expectRejected(longAttribute)
    const longText = `<svg xmlns="http://www.w3.org/2000/svg"><text>${'x'.repeat(512 * 1024 + 1)}</text></svg>`
    expectRejected(longText)
  })

  it('bounds cumulative embedded raster data and produces deterministic results on repeated validation', () => {
    const imageBytes = Buffer.alloc(2 * 1024)
    imageBytes.set([137, 80, 78, 71, 13, 10, 26, 10])
    const encoded = imageBytes.toString('base64')
    const image = `<image href="data:image/png;base64,${encoded}" width="1" height="1"/>`
    const tooManyEmbeddedBytes = `<svg xmlns="http://www.w3.org/2000/svg">${image.repeat(2_049)}</svg>`
    expectRejected(tooManyEmbeddedBytes)

    const valid = bytes('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L10 10"/></svg>')
    const firstResult = sanitizeNoteSvg(valid)
    for (let iteration = 0; iteration < 32; iteration += 1) {
      expect(sanitizeNoteSvg(valid)).toEqual(firstResult)
    }
  })

  it('only retains verified raster data URIs and reports SVG bounds explicitly', () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    const embedded = `<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,${png.toString('base64')}" width="1" height="1"/></svg>`
    expect(sanitizeNoteSvg(bytes(embedded)).toString('utf8')).toContain('data:image/png;base64,')
    expectRejected('<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/svg+xml;base64,PHN2Zy8+" width="1" height="1"/></svg>')
    expect(NOTE_SVG_MAX_BYTES).toBe(8 * 1024 * 1024)
    expect(() => sanitizeNoteSvg(Buffer.alloc(NOTE_SVG_MAX_BYTES + 1))).toThrow(NoteSvgValidationError)
  })
})

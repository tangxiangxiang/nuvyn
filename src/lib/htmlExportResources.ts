import { parse as parseCss } from 'postcss'
import { detectNoteImageFormat, NOTE_IMAGE_UPLOAD_MAX_BYTES } from '../../shared/noteImageProtocol'
import { sanitizeStaticNoteSvg } from '../../shared/noteSvg'
import { isAllowedResourcePath, resolveLogicalResourceReference } from './markdownResources'
import { authFetch } from './auth-session'

export const HTML_EXPORT_LIMITS = Object.freeze({ resourceBytes: NOTE_IMAGE_UPLOAD_MAX_BYTES, totalBytes: 64 * 1024 * 1024, resources: 128, widgets: 32, elements: 100_000, timeoutMs: 15_000, transactionMs: 45_000 })
export function exportError(code: string): never { throw new Error(`HTML_EXPORT_${code}`) }

export function checkExportSignal(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError')
}

export function abortableExport<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Export cancelled', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    void pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

async function assertImageDecodes(bytes: Uint8Array, mime: string, signal: AbortSignal): Promise<void> {
  const image = new Image()
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, HTML_EXPORT_LIMITS.timeoutMs)
  try {
    checkExportSignal(signal)
    image.src = bytesDataUrl(bytes, mime)
    await abortableExport(image.decode(), controller.signal)
    if (!image.naturalWidth || !image.naturalHeight) exportError('IMAGE_DECODE')
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); image.removeAttribute('src') }
}

export function bytesDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return `data:${mime};base64,${btoa(binary)}`
}

/** No author CSS is promoted to a stylesheet. Audit generated layout styles
 * structurally, including every URL token (SVG fragment references only). */
export function auditStaticCss(css: string, fonts = false): void {
  const root = parseCss(css)
  root.walkAtRules((rule) => { if (rule.name.toLowerCase() === 'import') exportError('UNSAFE_CSS') })
  root.walkDecls((decl) => {
    if (/expression|javascript|@import|image-set|cross-fade|paint\(|\\|[<>]/iu.test(decl.value) || /behavior|-moz-binding/iu.test(decl.prop)) exportError('UNSAFE_CSS')
    for (const match of decl.value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/giu)) {
      if (!/^#[\w:.-]+$/u.test(match[2] ?? '') && !(fonts && /^data:font\/woff2;base64,[\w+/=]+$/u.test(match[2] ?? ''))) exportError('EXTERNAL_CSS')
    }
  })
}

/** Uploaded, data-URL and Board SVG all use the server\'s unchanged policy. */
export function auditImageSvg(bytes: Uint8Array): void {
  sanitizeStaticNoteSvg(bytes)
}

export function validateImage(bytes: Uint8Array, mime: string): void {
  if (mime === 'image/svg+xml') auditImageSvg(bytes)
  else if (detectNoteImageFormat(bytes)?.mimeType !== mime) exportError('IMAGE_MIME')
}

export function decodeImageDataUrl(url: string): { bytes: Uint8Array; mime: string } {
  const match = /^data:(image\/(?:png|jpeg|gif|webp|avif|svg\+xml));base64,([A-Za-z0-9+/]*={0,2})$/u.exec(url)
  if (!match || match[2].length > HTML_EXPORT_LIMITS.resourceBytes * 4 / 3 + 4) exportError('INVALID_DATA_IMAGE')
  const binary = atob(match[2])
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  validateImage(bytes, match[1])
  return { bytes, mime: match[1] }
}

export function localImageUrl(source: string, boardPreview: boolean): string {
  if (source.startsWith('data:')) { decodeImageDataUrl(source); return source }
  if (boardPreview && source.startsWith(`blob:${location.origin}/`)) return source
  const url = new URL(source, location.origin)
  const resource = url.searchParams.get('path') ?? ''
  if (url.origin !== location.origin || url.pathname !== '/api/markdown-resources'
    || url.searchParams.get('kind') !== 'image' || url.hash
    || url.username || url.password
    || url.searchParams.getAll('kind').length !== 1 || url.searchParams.getAll('path').length !== 1
    || [...url.searchParams.keys()].some((k) => k !== 'kind' && k !== 'path')
    || resolveLogicalResourceReference(undefined, `@/${resource}`) !== resource
    || !isAllowedResourcePath('image', resource)) exportError('UNSUPPORTED_IMAGE')
  return `${url.pathname}?${new URLSearchParams({ kind: 'image', path: resource }).toString()}`
}

export function createHtmlResourceReader(signal: AbortSignal) {
  const cache = new Map<string, Promise<{ bytes: Uint8Array; mime: string }>>()
  let total = 0
  async function read(url: string, font = false): Promise<{ bytes: Uint8Array; mime: string }> {
    checkExportSignal(signal)
    const cached = cache.get(url)
    if (cached) return cached
    if (cache.size >= HTML_EXPORT_LIMITS.resources) exportError('RESOURCE_COUNT')
    const pending = (async () => {
      const controller = new AbortController()
      const abort = () => controller.abort()
      signal.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(abort, HTML_EXPORT_LIMITS.timeoutMs)
      try {
        if (url.startsWith('data:')) {
          const data = decodeImageDataUrl(url)
          total += data.bytes.length
          if (total > HTML_EXPORT_LIMITS.totalBytes) exportError('RESOURCE_SIZE')
          await assertImageDecodes(data.bytes, data.mime, controller.signal)
          return data
        }
        const response = await authFetch(url, { signal: controller.signal, redirect: 'error' })
        if (!response.ok || !response.body) exportError('RESOURCE_UNAVAILABLE')
        const declaredMime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
        if (font && !['font/woff2', 'application/font-woff2', 'application/octet-stream'].includes(declaredMime)) exportError('FONT_MIME')
        const mime = font ? 'font/woff2' : declaredMime
        const reader = response.body.getReader()
        const chunks: Uint8Array[] = []
        let length = 0
        try {
          while (true) {
            checkExportSignal(signal)
            const part = await reader.read()
            if (part.done) break
            length += part.value.byteLength
            total += part.value.byteLength
            if (length > HTML_EXPORT_LIMITS.resourceBytes || total > HTML_EXPORT_LIMITS.totalBytes) exportError('RESOURCE_SIZE')
            chunks.push(part.value)
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
        const bytes = new Uint8Array(length)
        let offset = 0
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
        if (font) {
          if (length < 48 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'wOF2' || length > 512 * 1024
            || new DataView(bytes.buffer).getUint32(8) !== length) exportError('FONT')
          const face = new FontFace('NuvynExportValidation', new Uint8Array(bytes).buffer)
          await abortableExport(face.load(), controller.signal)
        } else {
          validateImage(bytes, mime)
          await assertImageDecodes(bytes, mime, controller.signal)
        }
        return { bytes, mime }
      } finally { clearTimeout(timer); signal.removeEventListener('abort', abort) }
    })()
    cache.set(url, pending)
    return pending
  }
  return { read }
}

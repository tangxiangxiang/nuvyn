import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import app from '../index.js'
import { CONTENT_DIR, setContentDir } from '../paths.js'
import { MAX_IMAGE_BYTES, readMarkdownResource } from '../markdownResources.js'
import {
  authenticatedRequest,
  closeAuthTestContext,
  createAuthenticatedTestContext,
  type AuthenticatedTestContext,
} from '../__tests__/helpers/auth.js'
import { NOTE_IMAGE_UPLOAD_MAX_BYTES } from '../../shared/noteImageProtocol.js'

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00])
const SVG_TEXT = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60" width="120" height="60"><rect width="120" height="60" fill="#6270ac"/><text x="8" y="36" fill="#fff">Safe vector</text></svg>'
const SVG_BYTES = Buffer.from(SVG_TEXT)

let tempRoot: string
let originalContentDir: string
let auth: AuthenticatedTestContext

function imageForm(bytes: Uint8Array, name = 'image.png', type = 'image/png'): FormData {
  const form = new FormData()
  form.append('image', new Blob([bytes], { type }), name)
  return form
}

async function upload(form: FormData, options: { origin?: string; authenticated?: boolean } = {}): Promise<Response> {
  const headers = new Headers()
  if (options.origin !== undefined) headers.set('Origin', options.origin)
  if (options.authenticated !== false) headers.set('Cookie', auth.cookie)
  return app.fetch(new Request('http://localhost/api/note/images', {
    method: 'POST',
    headers,
    body: form,
  }))
}

describe('Note image uploads', () => {
  beforeEach(async () => {
    originalContentDir = CONTENT_DIR
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-note-images-'))
    setContentDir(tempRoot)
    auth = createAuthenticatedTestContext()
  })

  afterEach(async () => {
    closeAuthTestContext(auth)
    setContentDir(originalContentDir)
    await fs.rm(tempRoot, { recursive: true, force: true })
  })

  it('requires authentication and an exact same-origin Origin header', async () => {
    const unauthenticated = await upload(imageForm(PNG_BYTES), { authenticated: false })
    expect(unauthenticated.status).toBe(401)

    const missingOrigin = await upload(imageForm(PNG_BYTES))
    expect(missingOrigin.status).toBe(403)
    expect(await missingOrigin.json()).toMatchObject({ code: 'csrf-origin-mismatch' })

    const crossOrigin = await upload(imageForm(PNG_BYTES), { origin: 'https://attacker.example' })
    expect(crossOrigin.status).toBe(403)
    expect(await crossOrigin.json()).toMatchObject({ code: 'csrf-origin-mismatch' })
  })

  it('stores signature-verified images under a generated create-only path and serves them', async () => {
    const response = await upload(imageForm(PNG_BYTES), { origin: auth.runtime.config.publicOrigin })
    expect(response.status).toBe(201)
    const result = await response.json() as {
      id: string
      path: string
      markdownUrl: string
      mimeType: string
      byteSize: number
    }
    expect(result).toMatchObject({
      path: expect.stringMatching(/^attachments\/images\/[0-9a-f-]{36}\.png$/u),
      markdownUrl: expect.stringMatching(/^@\/attachments\/images\/[0-9a-f-]{36}\.png$/u),
      mimeType: 'image/png',
      byteSize: PNG_BYTES.byteLength,
    })
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/u)
    expect(JSON.stringify(result)).not.toContain(tempRoot)
    expect(await fs.readFile(path.join(tempRoot, result.path))).toEqual(PNG_BYTES)

    const served = await app.fetch(authenticatedRequest(
      auth,
      `/api/markdown-resources?kind=image&path=${encodeURIComponent(result.path)}`,
    ))
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(new Uint8Array(PNG_BYTES))
  })

  it('stores sanitized SVG under a generated create-only path and serves the safe vector', async () => {
    const response = await upload(imageForm(SVG_BYTES, 'Architecture.svg', 'image/svg+xml'), {
      origin: auth.runtime.config.publicOrigin,
    })
    expect(response.status).toBe(201)
    const result = await response.json() as { id: string; path: string; markdownUrl: string; mimeType: string; byteSize: number }
    expect(result).toMatchObject({
      path: expect.stringMatching(/^attachments\/images\/[0-9a-f-]{36}\.svg$/u),
      markdownUrl: expect.stringMatching(/^@\/attachments\/images\/[0-9a-f-]{36}\.svg$/u),
      mimeType: 'image/svg+xml',
    })
    expect(result.byteSize).toBeLessThanOrEqual(8 * 1024 * 1024)
    const stored = await fs.readFile(path.join(tempRoot, result.path), 'utf8')
    expect(stored).toContain('<rect')
    expect(stored).toContain('Safe vector')
    expect(stored).not.toContain('<script')

    const served = await app.fetch(authenticatedRequest(
      auth,
      `/api/markdown-resources?kind=image&path=${encodeURIComponent(result.path)}`,
    ))
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('image/svg+xml')
    expect(served.headers.get('content-security-policy')).toContain("script-src 'none'")
    expect(served.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await served.text()).toContain('Safe vector')
  })

  it.each(['application/xml', 'text/xml', 'text/plain', 'image/svg+xml; charset=utf-8'])(
    'accepts valid .svg content when the platform reports %s',
    async (mimeType) => {
      const response = await upload(imageForm(SVG_BYTES, 'vector.svg', mimeType), {
        origin: auth.runtime.config.publicOrigin,
      })
      expect(response.status).toBe(201)
      expect(await response.json()).toMatchObject({ mimeType: 'image/svg+xml' })
    },
  )

  it('rejects declared type mismatches and unsafe SVG without creating files', async () => {
    const wrongType = await upload(imageForm(PNG_BYTES, 'image.png', 'image/jpeg'), {
      origin: auth.runtime.config.publicOrigin,
    })
    expect(wrongType.status).toBe(415)
    expect(await wrongType.json()).toMatchObject({ code: 'NOTE_IMAGE_INVALID' })

    const wrongExtension = await upload(imageForm(PNG_BYTES, 'image.jpg', 'image/png'), {
      origin: auth.runtime.config.publicOrigin,
    })
    expect(wrongExtension.status).toBe(415)
    expect(await wrongExtension.json()).toMatchObject({ code: 'NOTE_IMAGE_INVALID' })

    const wrongSvgType = await upload(imageForm(SVG_BYTES, 'vector.svg', 'image/png'), {
      origin: auth.runtime.config.publicOrigin,
    })
    expect(wrongSvgType.status).toBe(415)
    expect(await wrongSvgType.json()).toMatchObject({ code: 'NOTE_IMAGE_INVALID' })

    const hostile = await upload(imageForm(Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>window.__noteSvgRan=true</script><rect width="10" height="10" onload="alert(1)"/></svg>',
    ), 'hostile.svg', 'image/svg+xml'), { origin: auth.runtime.config.publicOrigin })
    expect(hostile.status).toBe(415)
    expect(await hostile.json()).toMatchObject({ code: 'NOTE_IMAGE_INVALID' })
    const imageDirectory = path.join(tempRoot, 'attachments', 'images')
    await expect(fs.access(imageDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('enforces the stricter 8 MiB SVG limit', async () => {
    const oversized = Buffer.alloc(8 * 1024 * 1024 + 1, 0x20)
    const rejected = await upload(imageForm(oversized, 'large.svg', 'image/svg+xml'), {
      origin: auth.runtime.config.publicOrigin,
    })
    expect(rejected.status).toBe(413)
    expect(await rejected.json()).toMatchObject({ code: 'NOTE_IMAGE_TOO_LARGE' })
    await expect(fs.access(path.join(tempRoot, 'attachments', 'images'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('enforces the 20 MiB upload and image-read limit without widening text resources', async () => {
    expect(MAX_IMAGE_BYTES).toBe(NOTE_IMAGE_UPLOAD_MAX_BYTES)
    const oversized = Buffer.alloc(NOTE_IMAGE_UPLOAD_MAX_BYTES + 1)
    PNG_BYTES.copy(oversized)
    const rejected = await upload(imageForm(oversized), { origin: auth.runtime.config.publicOrigin })
    expect(rejected.status).toBe(413)
    expect(await rejected.json()).toMatchObject({ code: 'NOTE_IMAGE_TOO_LARGE' })

    const largePng = Buffer.alloc(NOTE_IMAGE_UPLOAD_MAX_BYTES)
    PNG_BYTES.copy(largePng)
    await fs.mkdir(path.join(tempRoot, 'attachments', 'images'), { recursive: true })
    await fs.writeFile(path.join(tempRoot, 'attachments', 'images', 'large.png'), largePng)
    const loaded = await readMarkdownResource('image', 'attachments/images/large.png')
    expect(loaded.kind).toBe('image')
    if (loaded.kind === 'image') expect(loaded.content.byteLength).toBe(largePng.byteLength)

    await fs.writeFile(path.join(tempRoot, 'snippet.ts'), Buffer.alloc(256 * 1024 + 1))
    await expect(readMarkdownResource('snippet', 'snippet.ts')).rejects.toMatchObject({ code: 'resource-size-limit' })
  })

  it('does not follow a symlinked upload directory or write outside the image directory', async () => {
    const outside = path.join(tempRoot, 'outside')
    await fs.mkdir(outside)
    await fs.symlink(outside, path.join(tempRoot, 'attachments'))
    const response = await upload(imageForm(PNG_BYTES), { origin: auth.runtime.config.publicOrigin })
    expect(response.status).toBe(500)
    expect(JSON.stringify(await response.json())).not.toContain(tempRoot)
    expect(await fs.readdir(outside)).toEqual([])
  })
})

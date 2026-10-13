import { afterEach, describe, expect, it, vi } from 'vitest'
import { __testing__, markdownImageReference, uploadNoteImage } from '../noteImages'

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }))
vi.mock('../auth-session', () => ({ authFetch }))

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])
const SVG_BYTES = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')
const UUID = '550e8400-e29b-41d4-a716-446655440000'

function file(name = 'diagram.png', bytes = PNG_BYTES, type = 'image/png'): File {
  return new File([bytes], name, { type })
}

function successResponse(fileName = 'diagram.png', format: 'png' | 'svg' = 'png'): Response {
  return Response.json({
    id: UUID,
    path: `attachments/images/${UUID}.${format}`,
    markdownUrl: `@/attachments/images/${UUID}.${format}`,
    mimeType: format === 'svg' ? 'image/svg+xml' : 'image/png',
    byteSize: fileName.length ? (format === 'svg' ? SVG_BYTES.byteLength : PNG_BYTES.byteLength) : 0,
  })
}

describe('Note image upload client', () => {
  afterEach(() => {
    __testing__.resetQueue()
    vi.clearAllMocks()
  })

  it('validates content and uploads through the shared authenticated multipart service', async () => {
    authFetch.mockResolvedValue(successResponse())
    const result = await uploadNoteImage(file())
    expect(result.markdownUrl).toBe(`@/attachments/images/${UUID}.png`)
    expect(authFetch).toHaveBeenCalledOnce()
    const [url, init] = authFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/note/images')
    expect(init.method).toBe('POST')
    expect(init.headers).toBeUndefined()
    expect(init.body).toBeInstanceOf(FormData)
    expect((init.body as FormData).get('image')).toBeInstanceOf(File)
  })

  it('preflights and validates SVG upload responses without raster magic detection', async () => {
    authFetch.mockResolvedValue(successResponse('Architecture.svg', 'svg'))
    const result = await uploadNoteImage(file('Architecture.svg', SVG_BYTES, 'image/svg+xml'))
    expect(result.path).toBe(`attachments/images/${UUID}.svg`)
    expect(result.mimeType).toBe('image/svg+xml')

    authFetch.mockResolvedValue(successResponse('wrong-path', 'png'))
    await expect(uploadNoteImage(file('diagram.svg', SVG_BYTES, 'image/svg+xml')))
      .rejects.toMatchObject({ code: 'unknown' })
  })

  it.each(['application/xml', 'text/xml', 'text/plain', 'image/svg+xml; charset=utf-8'])(
    'accepts a sanitized .svg file reported by the browser as %s',
    async (mimeType) => {
      authFetch.mockResolvedValue(successResponse('Architecture.svg', 'svg'))
      const result = await uploadNoteImage(file('Architecture.svg', SVG_BYTES, mimeType))
      expect(result.mimeType).toBe('image/svg+xml')
      expect(authFetch).toHaveBeenCalledOnce()
    },
  )

  it('rejects SVG declaration mismatches and its stricter size limit before upload', async () => {
    await expect(uploadNoteImage(file('diagram.png', SVG_BYTES, 'image/svg+xml')))
      .rejects.toMatchObject({ code: 'invalid' })
    const tooLarge = new File([new Uint8Array(8 * 1024 * 1024 + 1)], 'large.svg', { type: 'image/svg+xml' })
    await expect(uploadNoteImage(tooLarge)).rejects.toMatchObject({ code: 'too-large' })
    expect(authFetch).not.toHaveBeenCalled()
  })

  it('rejects unsupported and over-limit files before making a request', async () => {
    await expect(uploadNoteImage(file('fake.png', new TextEncoder().encode('<svg/>'))))
      .rejects.toMatchObject({ code: 'unsupported' })
    const tooLarge = new File([new Uint8Array(20 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' })
    await expect(uploadNoteImage(tooLarge)).rejects.toMatchObject({ code: 'too-large' })
    expect(authFetch).not.toHaveBeenCalled()
  })

  it('maps server and network failures to stable user-facing error codes', async () => {
    authFetch.mockResolvedValue(Response.json({ code: 'NOTE_IMAGE_TOO_LARGE' }, { status: 413 }))
    await expect(uploadNoteImage(file())).rejects.toMatchObject({ code: 'too-large' })

    authFetch.mockRejectedValueOnce(new Error('offline'))
    await expect(uploadNoteImage(file())).rejects.toMatchObject({ code: 'network' })
    expect(authFetch).toHaveBeenCalledTimes(2)
  })

  it('limits concurrent uploads to two while preserving each result', async () => {
    const deferred: Array<{ resolve: (response: Response) => void }> = []
    authFetch.mockImplementation(() => new Promise<Response>((resolve) => deferred.push({ resolve })))
    const uploads = [
      uploadNoteImage(file('one.png')),
      uploadNoteImage(file('two.png')),
      uploadNoteImage(file('three.png')),
    ]
    await vi.waitFor(() => expect(deferred).toHaveLength(2))
    expect(__testing__.activeCount()).toBe(2)
    expect(__testing__.queuedCount()).toBe(1)
    expect(deferred).toHaveLength(2)

    deferred[0]!.resolve(successResponse('one.png'))
    await vi.waitFor(() => expect(deferred).toHaveLength(3))
    expect(deferred).toHaveLength(3)
    deferred[1]!.resolve(successResponse('two.png'))
    deferred[2]!.resolve(successResponse('three.png'))
    await Promise.all(uploads)
  })

  it('escapes Markdown alt text and never trusts a path embedded in a file name', () => {
    expect(markdownImageReference('../a]b.png', '@/attachments/images/id.png'))
      .toBe('![a\\]b](@/attachments/images/id.png)')
  })
})

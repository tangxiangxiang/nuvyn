import { describe, expect, it } from 'vitest'
import { detectNoteImageFormat, NOTE_IMAGE_UPLOAD_MAX_BYTES } from '../noteImageProtocol.js'

describe('Note image upload protocol', () => {
  it('recognizes only the supported binary image signatures', () => {
    expect(detectNoteImageFormat(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]))?.mimeType).toBe('image/png')
    expect(detectNoteImageFormat(new Uint8Array([255, 216, 255]))?.mimeType).toBe('image/jpeg')
    expect(detectNoteImageFormat(new TextEncoder().encode('GIF89a'))?.mimeType).toBe('image/gif')
    expect(detectNoteImageFormat(new TextEncoder().encode('RIFFxxxxWEBP'))?.mimeType).toBe('image/webp')
    expect(detectNoteImageFormat(new TextEncoder().encode('xxxxftypavif'))?.mimeType).toBe('image/avif')
    expect(detectNoteImageFormat(new TextEncoder().encode('<svg'))).toBeNull()
  })

  it('uses the documented 20 MiB per-image maximum', () => {
    expect(NOTE_IMAGE_UPLOAD_MAX_BYTES).toBe(20 * 1024 * 1024)
  })
})

export const NOTE_IMAGE_UPLOAD_MAX_BYTES = 20 * 1024 * 1024
export const NOTE_IMAGE_UPLOAD_MAX_MULTIPART_OVERHEAD = 64 * 1024

export const NOTE_IMAGE_FORMATS = [
  { extension: '.png', mimeType: 'image/png' },
  { extension: '.jpg', mimeType: 'image/jpeg' },
  { extension: '.jpeg', mimeType: 'image/jpeg' },
  { extension: '.webp', mimeType: 'image/webp' },
  { extension: '.gif', mimeType: 'image/gif' },
  { extension: '.avif', mimeType: 'image/avif' },
] as const

export type NoteImageFormat = typeof NOTE_IMAGE_FORMATS[number]

export interface NoteImageUploadResult {
  id: string
  path: string
  markdownUrl: string
  mimeType: NoteImageFormat['mimeType']
  byteSize: number
}

export function detectNoteImageFormat(bytes: Uint8Array): NoteImageFormat | null {
  if (bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a) {
    return NOTE_IMAGE_FORMATS[0]
  }

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return NOTE_IMAGE_FORMATS[1]
  }

  if (bytes.length >= 6) {
    const signature = String.fromCharCode(...bytes.subarray(0, 6))
    if (signature === 'GIF87a' || signature === 'GIF89a') return NOTE_IMAGE_FORMATS[4]
  }

  if (bytes.length >= 12
    && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') {
    return NOTE_IMAGE_FORMATS[3]
  }

  if (bytes.length >= 12
    && String.fromCharCode(...bytes.subarray(4, 8)) === 'ftyp'
    && ['avif', 'avis'].includes(String.fromCharCode(...bytes.subarray(8, 12)))) {
    return NOTE_IMAGE_FORMATS[5]
  }

  return null
}

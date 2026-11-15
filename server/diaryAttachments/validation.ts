import path from 'node:path'
import { isDiaryAttachmentMimeType, type DiaryAttachmentMimeType } from '../../shared/diaryAttachments.js'

const EXTENSIONS: Record<DiaryAttachmentMimeType, readonly string[]> = {
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/webp': ['.webp'],
  'image/gif': ['.gif'],
  'image/avif': ['.avif'],
  'application/pdf': ['.pdf'],
}
const PNG_CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  return crc >>> 0
})

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return Buffer.from(bytes.subarray(start, start + length)).toString('ascii')
}

function pngCrc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff
  for (let index = start; index < end; index += 1) crc = PNG_CRC_TABLE[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function validPng(bytes: Uint8Array): boolean {
  if (bytes.length < 57 || !Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false
  let offset = 8
  let first = true
  let sawImageData = false
  while (offset + 12 <= bytes.length) {
    const length = Buffer.from(bytes).readUInt32BE(offset)
    const type = ascii(bytes, offset + 4, 4)
    const end = offset + 12 + length
    if (end > bytes.length || !/^[A-Za-z]{4}$/u.test(type)) return false
    const expectedCrc = Buffer.from(bytes).readUInt32BE(offset + 8 + length)
    if (pngCrc32(bytes, offset + 4, offset + 8 + length) !== expectedCrc) return false
    if (first && (type !== 'IHDR' || length !== 13)) return false
    first = false
    if (type === 'IDAT') sawImageData = true
    if (type === 'IEND') return length === 0 && sawImageData && end === bytes.length
    // Unknown critical chunks are not accepted. Ancillary chunks remain
    // compatible with common camera metadata and do not execute in browsers.
    if ((type.charCodeAt(0) & 0x20) === 0 && !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type)) return false
    offset = end
  }
  return false
}

function validJpeg(bytes: Uint8Array): boolean {
  if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return false
  let offset = 2
  let sawFrame = false
  let sawScan = false
  // EOI is a standalone two-byte marker, so the scan loop must allow the
  // final marker even when no segment length follows it.
  while (offset + 2 <= bytes.length) {
    if (bytes[offset] !== 0xff) return false
    while (bytes[offset] === 0xff) offset += 1
    const marker = bytes[offset++]!
    if (marker === 0xd9) return sawFrame && sawScan && offset === bytes.length
    if (marker === 0xda) {
      const length = Buffer.from(bytes).readUInt16BE(offset)
      if (length < 2 || offset + length > bytes.length) return false
      sawScan = true
      offset += length
      // Entropy data may contain only stuffed FF bytes or restart markers.
      // The first non-stuffed marker ends the scan and is parsed below.
      while (offset + 1 < bytes.length) {
        if (bytes[offset] !== 0xff) { offset += 1; continue }
        const markerByte = bytes[offset + 1]!
        if (markerByte === 0x00 || (markerByte >= 0xd0 && markerByte <= 0xd7)) { offset += 2; continue }
        break
      }
      continue
    }
    if (marker === 0x00 || marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) return false
    if (offset + 2 > bytes.length) return false
    const length = Buffer.from(bytes).readUInt16BE(offset)
    if (length < 2 || offset + length > bytes.length) return false
    if ((marker >= 0xc0 && marker <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(marker)) sawFrame = true
    offset += length
  }
  return false
}

function skipGifSubBlocks(bytes: Uint8Array, start: number): number | null {
  let offset = start
  while (offset < bytes.length) {
    const size = bytes[offset++]!
    if (size === 0) return offset
    if (offset + size > bytes.length) return null
    offset += size
  }
  return null
}

function validGif(bytes: Uint8Array): boolean {
  if (bytes.length < 14 || !['GIF87a', 'GIF89a'].includes(ascii(bytes, 0, 6))) return false
  const packed = bytes[10]!
  let offset = 13
  if (packed & 0x80) offset += 3 * (2 ** ((packed & 0x07) + 1))
  let frames = 0
  while (offset < bytes.length) {
    const marker = bytes[offset++]!
    if (marker === 0x3b) return frames > 0 && offset === bytes.length
    if (marker === 0x21) {
      if (offset >= bytes.length) return false
      offset += 1
      const next = skipGifSubBlocks(bytes, offset)
      if (next === null) return false
      offset = next
      continue
    }
    if (marker !== 0x2c || offset + 9 > bytes.length) return false
    const localPacked = bytes[offset + 8]!
    offset += 9
    if (localPacked & 0x80) offset += 3 * (2 ** ((localPacked & 0x07) + 1))
    if (offset >= bytes.length || bytes[offset]! > 12) return false
    offset += 1
    const next = skipGifSubBlocks(bytes, offset)
    if (next === null) return false
    offset = next
    frames += 1
  }
  return false
}

function validWebp(bytes: Uint8Array): boolean {
  if (bytes.length < 20 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') return false
  if (Buffer.from(bytes).readUInt32LE(4) !== bytes.length - 8) return false
  let offset = 12
  let image = false
  while (offset + 8 <= bytes.length) {
    const kind = ascii(bytes, offset, 4)
    const size = Buffer.from(bytes).readUInt32LE(offset + 4)
    const end = offset + 8 + size + (size & 1)
    if (end > bytes.length) return false
    if (['VP8 ', 'VP8L', 'VP8X'].includes(kind)) image = true
    offset = end
  }
  return image && offset === bytes.length
}

type IsoBmffBox = { kind: string; offset: number; headerSize: number; end: number }

function isoBmffBox(bytes: Uint8Array, offset: number, limit: number): IsoBmffBox | null {
  if (offset + 8 > limit) return null
  const view = Buffer.from(bytes)
  const size = view.readUInt32BE(offset)
  const kind = ascii(bytes, offset + 4, 4)
  let headerSize = 8
  let boxSize = size
  if (size === 1) {
    if (offset + 16 > limit) return null
    const extendedSize = view.readBigUInt64BE(offset + 8)
    if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) return null
    boxSize = Number(extendedSize)
    headerSize = 16
  } else if (size === 0) {
    boxSize = limit - offset
  }
  if (boxSize < headerSize || offset + boxSize > limit) return null
  return { kind, offset, headerSize, end: offset + boxSize }
}

function metaHasItemData(bytes: Uint8Array, meta: IsoBmffBox): boolean {
  let offset = meta.offset + meta.headerSize + 4 // meta FullBox version and flags
  while (offset < meta.end) {
    const child = isoBmffBox(bytes, offset, meta.end)
    if (!child) return false
    if (child.kind === 'idat' && child.end > child.offset + child.headerSize) return true
    offset = child.end
  }
  return false
}

function validAvif(bytes: Uint8Array): boolean {
  if (bytes.length < 32) return false
  let offset = 0
  let brand = false
  let meta: IsoBmffBox | null = null
  let media = false
  while (offset < bytes.length) {
    const box = isoBmffBox(bytes, offset, bytes.length)
    if (!box) return false
    const bodyLength = box.end - box.offset - box.headerSize
    if (box.kind === 'ftyp') {
      if (bodyLength < 8) return false
      const brands = [ascii(bytes, box.offset + box.headerSize, 4)]
      for (let brandOffset = box.offset + box.headerSize + 8; brandOffset + 4 <= box.end; brandOffset += 4) {
        brands.push(ascii(bytes, brandOffset, 4))
      }
      brand = brands.includes('avif') || brands.includes('avis')
    }
    if (box.kind === 'meta') {
      if (bodyLength < 4) return false
      meta = box
    }
    if (box.kind === 'mdat' && bodyLength > 0) media = true
    offset = box.end
  }
  return brand && meta !== null && (media || metaHasItemData(bytes, meta))
}

function validPdf(bytes: Uint8Array): boolean {
  if (bytes.length < 16 || !/^%PDF-(?:1\.[0-7]|2\.0)/u.test(ascii(bytes, 0, 8))) return false
  const text = Buffer.from(bytes).toString('latin1')
  const eof = text.lastIndexOf('%%EOF')
  if (eof < 0 || text.slice(eof + 5).trim().length !== 0) return false
  return /startxref\s+\d+/u.test(text.slice(0, eof))
}

export function detectDiaryAttachmentMime(bytes: Uint8Array): DiaryAttachmentMimeType | null {
  if (validPng(bytes)) return 'image/png'
  if (validJpeg(bytes)) return 'image/jpeg'
  if (validWebp(bytes)) return 'image/webp'
  if (validGif(bytes)) return 'image/gif'
  if (validAvif(bytes)) return 'image/avif'
  if (validPdf(bytes)) return 'application/pdf'
  return null
}

export function validateDiaryAttachmentInput(input: {
  bytes: Uint8Array
  mimeType: string
  name: string
}): { mimeType: DiaryAttachmentMimeType; name: string } | null {
  const mimeType = detectDiaryAttachmentMime(input.bytes)
  if (!mimeType || !isDiaryAttachmentMimeType(input.mimeType) || mimeType !== input.mimeType) return null
  const name = path.basename(input.name.replaceAll('\\', '/')).trim()
  if (!name || [...name].length > 255 || /[\u0000-\u001f\u007f]/u.test(name)) return null
  const extension = path.extname(name).toLowerCase()
  if (!EXTENSIONS[mimeType].includes(extension)) return null
  return { mimeType, name }
}

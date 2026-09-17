export type BoardExportFormat = 'png' | 'svg'

const INVALID_FILENAME_CHARACTERS = /[\\/:*?"<>|]+/g
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]+/g

export function sanitizeBoardExportFilename(title: string): string {
  const sanitized = title
    .replace(CONTROL_CHARACTERS, ' ')
    .replace(INVALID_FILENAME_CHARACTERS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, '')
    .trim()
  return sanitized || 'Untitled Board'
}

export function boardExportFilename(title: string, format: BoardExportFormat): string {
  return `${sanitizeBoardExportFilename(title)}.${format}`
}

export interface ObjectUrlApi {
  createObjectURL(blob: Blob): string
  revokeObjectURL(url: string): void
}

export function downloadBoardBlob(
  blob: Blob,
  filename: string,
  objectUrlApi: ObjectUrlApi = URL,
): void {
  const objectUrl = objectUrlApi.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = filename
  anchor.rel = 'noopener'
  anchor.hidden = true
  document.body.appendChild(anchor)
  try {
    anchor.click()
  } finally {
    anchor.remove()
    objectUrlApi.revokeObjectURL(objectUrl)
  }
}

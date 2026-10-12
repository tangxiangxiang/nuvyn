import { authFetch } from './auth-session'
import {
  detectNoteImageFormat,
  NOTE_IMAGE_FORMATS,
  NOTE_IMAGE_UPLOAD_MAX_BYTES,
  type NoteImageUploadResult,
} from '../../shared/noteImageProtocol'

export type NoteImageErrorCode =
  | 'unsupported'
  | 'too-large'
  | 'invalid'
  | 'busy'
  | 'network'
  | 'unauthorized'
  | 'storage'
  | 'unknown'

export class NoteImageError extends Error {
  readonly code: NoteImageErrorCode

  constructor(code: NoteImageErrorCode) {
    super('Note image upload failed.')
    this.name = 'NoteImageError'
    this.code = code
  }
}

const MAX_CONCURRENT_UPLOADS = 2
type UploadTask = {
  file: File
  signal?: AbortSignal
  resolve: (result: NoteImageUploadResult) => void
  reject: (error: NoteImageError) => void
}
const uploadQueue: UploadTask[] = []
let activeUploads = 0

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot).toLowerCase() : ''
}

async function validateFile(file: File): Promise<void> {
  if (file.size > NOTE_IMAGE_UPLOAD_MAX_BYTES) throw new NoteImageError('too-large')
  if (file.size === 0) throw new NoteImageError('invalid')
  const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer())
  const format = detectNoteImageFormat(bytes)
  if (!format) throw new NoteImageError('unsupported')

  const declaredType = file.type.trim().toLowerCase()
  if (declaredType && declaredType !== 'application/octet-stream' && declaredType !== format.mimeType) {
    throw new NoteImageError('invalid')
  }
  const extension = extensionOf(file.name)
  if (extension && !NOTE_IMAGE_FORMATS.some((candidate) => (
    candidate.extension === extension && candidate.mimeType === format.mimeType
  ))) throw new NoteImageError('invalid')
}

async function performUpload(file: File, signal?: AbortSignal): Promise<NoteImageUploadResult> {
  await validateFile(file)
  const form = new FormData()
  form.append('image', file, file.name || 'pasted-image')

  let response: Response
  try {
    response = await authFetch('/api/note/images', { method: 'POST', body: form, signal })
  } catch {
    if (signal?.aborted) throw new NoteImageError('network')
    throw new NoteImageError('network')
  }

  if (!response.ok) {
    let code = ''
    try {
      code = String((await response.json() as { code?: unknown }).code ?? '')
    } catch { /* A generic HTTP failure is still reported below. */ }
    if (response.status === 401 || code === 'auth-session-required') throw new NoteImageError('unauthorized')
    if (response.status === 413 || code === 'NOTE_IMAGE_TOO_LARGE') throw new NoteImageError('too-large')
    if (code === 'NOTE_IMAGE_INVALID') throw new NoteImageError('invalid')
    if (code === 'NOTE_IMAGE_UPLOAD_BUSY') throw new NoteImageError('busy')
    if (response.status >= 500) throw new NoteImageError('storage')
    throw new NoteImageError('unknown')
  }

  let result: NoteImageUploadResult
  try {
    result = await response.json() as NoteImageUploadResult
  } catch {
    throw new NoteImageError('unknown')
  }
  const expectedPath = /^attachments\/images\/[0-9a-f-]{36}\.(?:png|jpg|gif|webp|avif)$/iu
  if (!result || typeof result !== 'object'
    || typeof result.id !== 'string'
    || typeof result.path !== 'string'
    || !expectedPath.test(result.path)
    || result.markdownUrl !== `@/${result.path}`
    || !NOTE_IMAGE_FORMATS.some((format) => format.mimeType === result.mimeType)
    || !Number.isSafeInteger(result.byteSize)
    || result.byteSize < 1
    || result.byteSize > NOTE_IMAGE_UPLOAD_MAX_BYTES) {
    throw new NoteImageError('unknown')
  }
  return result
}

function pumpQueue(): void {
  while (activeUploads < MAX_CONCURRENT_UPLOADS && uploadQueue.length > 0) {
    const task = uploadQueue.shift()!
    if (task.signal?.aborted) {
      task.reject(new NoteImageError('network'))
      continue
    }
    activeUploads += 1
    void performUpload(task.file, task.signal)
      .then(task.resolve, task.reject)
      .finally(() => {
        activeUploads -= 1
        pumpQueue()
      })
  }
}

export function uploadNoteImage(file: File, signal?: AbortSignal): Promise<NoteImageUploadResult> {
  return new Promise((resolve, reject) => {
    uploadQueue.push({ file, signal, resolve, reject })
    pumpQueue()
  })
}

export function markdownImageReference(fileName: string, markdownUrl: string): string {
  const baseName = fileName.replaceAll('\\', '/').split('/').at(-1) ?? ''
  const label = baseName.replace(/\.[^.]*$/u, '').replace(/[\u0000-\u001f\u007f]/gu, '').trim() || 'Image'
  const escaped = label.replace(/[\\[\]]/gu, '\\$&')
  return `![${escaped}](${markdownUrl})`
}

export function isPotentialNoteImage(file: File): boolean {
  return file.type.toLowerCase().startsWith('image/')
    || NOTE_IMAGE_FORMATS.some((format) => format.extension === extensionOf(file.name))
}

export const __testing__ = {
  resetQueue: () => { uploadQueue.length = 0; activeUploads = 0 },
  activeCount: () => activeUploads,
  queuedCount: () => uploadQueue.length,
}

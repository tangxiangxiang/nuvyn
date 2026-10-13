import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import {
  detectNoteImageFormat,
  isCompatibleNoteSvgMimeType,
  isNoteSvgMimeType,
  normalizeNoteImageMimeType,
  NOTE_IMAGE_FORMATS,
  NOTE_IMAGE_UPLOAD_MAX_BYTES,
  NOTE_IMAGE_UPLOAD_MAX_MULTIPART_OVERHEAD,
  NOTE_SVG_FORMAT,
  type NoteImageFormat,
  type NoteImageUploadResult,
} from '../../shared/noteImageProtocol.js'
import { ApiRequestError, apiErrorResponse } from '../apiErrors.js'
import { readBoundedBody } from '../apiBody.js'
import { invalidateDefaultAttachmentCatalog } from '../attachments/routes.js'
import { CONTENT_DIR, resolveSafeRelativePathDetailed } from '../paths.js'
import { writeCreateOnlyDurableFile } from '../durableCreateOnlyFile.js'
import { NoteSvgValidationError, sanitizeNoteSvg } from '../noteSvg.js'

const IMAGE_DIRECTORY = path.join('attachments', 'images')
const MAX_UPLOADS_IN_FLIGHT = 2
const routes = new Hono()
let activeUploads = 0

async function ensureImageDirectory(): Promise<void> {
  const rootStat = await fs.lstat(CONTENT_DIR)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('vault root is unsafe')

  let parent = CONTENT_DIR
  for (const segment of ['attachments', 'images']) {
    parent = path.join(parent, segment)
    try {
      await fs.mkdir(parent, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const stat = await fs.lstat(parent)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('image directory is unsafe')
  }
}

function multipartContentType(value: string | null): value is string {
  return value !== null && /^multipart\/form-data\s*;\s*boundary=(?:"[^"]+"|[^;\s]+)(?:\s*;.*)?$/iu.test(value)
}

function validateDeclaredType(file: File, format: NoteImageFormat): void {
  const declaredMime = normalizeNoteImageMimeType(file.type)
  const compatibleSvgMime = format.mimeType === NOTE_SVG_FORMAT.mimeType
    && isCompatibleNoteSvgMimeType(declaredMime)
  if (declaredMime && declaredMime !== 'application/octet-stream'
    && declaredMime !== format.mimeType && !compatibleSvgMime) {
    throw new ApiRequestError('NOTE_IMAGE_INVALID', 415, 'Image content does not match its declared type.')
  }
  const extension = path.extname(file.name).toLowerCase()
  if (extension && !NOTE_IMAGE_FORMATS.some((candidate) => candidate.extension === extension
    && candidate.mimeType === format.mimeType)) {
    throw new ApiRequestError('NOTE_IMAGE_INVALID', 415, 'Image content does not match its file extension.')
  }
}

async function parseImage(request: Request): Promise<{ file: File; bytes: Buffer; format: NoteImageFormat }> {
  const contentType = request.headers.get('content-type')
  if (!multipartContentType(contentType)) {
    throw new ApiRequestError('NOTE_IMAGE_MULTIPART_REQUIRED', 415, 'An image file is required.')
  }

  const body = await readBoundedBody(
    request,
    NOTE_IMAGE_UPLOAD_MAX_BYTES + NOTE_IMAGE_UPLOAD_MAX_MULTIPART_OVERHEAD,
    'NOTE_IMAGE_TOO_LARGE',
    'Image exceeds the 20 MiB limit.',
  )
  let form: FormData
  try {
    form = await new Response(body, { headers: { 'Content-Type': contentType } }).formData()
  } catch {
    throw new ApiRequestError('NOTE_IMAGE_MULTIPART_INVALID', 400, 'Image upload request is invalid.')
  }

  const entries = [...form.entries()]
  if (entries.length !== 1 || entries[0]?.[0] !== 'image' || typeof entries[0][1] === 'string') {
    throw new ApiRequestError('NOTE_IMAGE_MULTIPART_INVALID', 400, 'Upload exactly one image file.')
  }
  const file = entries[0][1] as File
  if (file.size < 1) throw new ApiRequestError('NOTE_IMAGE_INVALID', 415, 'Image content is invalid.')
  if (file.size > NOTE_IMAGE_UPLOAD_MAX_BYTES) {
    throw new ApiRequestError('NOTE_IMAGE_TOO_LARGE', 413, 'Image exceeds the 20 MiB limit.')
  }

  const bytes = Buffer.from(await file.arrayBuffer())
  const declaredMime = normalizeNoteImageMimeType(file.type)
  const extension = path.extname(file.name).toLowerCase()
  const svgDeclared = isNoteSvgMimeType(declaredMime) || extension === NOTE_SVG_FORMAT.extension
  let format: NoteImageFormat
  let safeBytes: Buffer<ArrayBufferLike> = bytes
  if (svgDeclared) {
    if (!isCompatibleNoteSvgMimeType(declaredMime)) {
      throw new ApiRequestError('NOTE_IMAGE_INVALID', 415, 'Image content does not match its declared type.')
    }
    if (extension && extension !== NOTE_SVG_FORMAT.extension) {
      throw new ApiRequestError('NOTE_IMAGE_INVALID', 415, 'Image content does not match its file extension.')
    }
    try {
      safeBytes = sanitizeNoteSvg(bytes)
    } catch (error) {
      if (error instanceof NoteSvgValidationError && error.code === 'too-large') {
        throw new ApiRequestError('NOTE_IMAGE_TOO_LARGE', 413, 'SVG image exceeds its safe size limit.')
      }
      throw new ApiRequestError('NOTE_IMAGE_INVALID', 415, 'SVG image content is invalid or unsupported.')
    }
    format = NOTE_SVG_FORMAT
  } else {
    const rasterFormat = detectNoteImageFormat(bytes)
    if (!rasterFormat) throw new ApiRequestError('NOTE_IMAGE_INVALID', 415, 'Image content is invalid or unsupported.')
    format = rasterFormat
  }
  validateDeclaredType(file, format)
  return { file, bytes: safeBytes, format }
}

routes.post('/api/note/images', async (c) => {
  if (activeUploads >= MAX_UPLOADS_IN_FLIGHT) {
    return apiErrorResponse(c, new ApiRequestError('NOTE_IMAGE_UPLOAD_BUSY', 429, 'Image upload capacity is busy.'), {
      code: 'NOTE_IMAGE_UPLOAD_FAILED',
      message: 'Image could not be uploaded.',
    })
  }

  activeUploads += 1
  try {
    const { bytes, format } = await parseImage(c.req.raw)

    await ensureImageDirectory()
    const id = randomUUID()
    const relativePath = `${IMAGE_DIRECTORY.split(path.sep).join('/')}/${id}${format.extension}`
    const resolution = await resolveSafeRelativePathDetailed(CONTENT_DIR, relativePath, { allowMissingFinal: true })
    // The durable create-only helper fsyncs and verifies the completed bytes
    // before returning; no temporary or partially written file is exposed.
    await writeCreateOnlyDurableFile(resolution.absolute, bytes, { mode: 0o600 })

    invalidateDefaultAttachmentCatalog()
    const result: NoteImageUploadResult = {
      id,
      path: relativePath,
      markdownUrl: `@/${relativePath}`,
      mimeType: format.mimeType,
      byteSize: bytes.byteLength,
    }
    c.header('Cache-Control', 'no-store')
    return c.json(result, 201)
  } catch (error) {
    return apiErrorResponse(c, error, {
      code: 'NOTE_IMAGE_UPLOAD_FAILED',
      message: 'Image could not be stored.',
    })
  } finally {
    activeUploads = Math.max(0, activeUploads - 1)
  }
})

export default routes

export const __testing__ = {
  ensureImageDirectory,
  parseImage,
  resetActiveUploads: () => { activeUploads = 0 },
}

import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { civilDate } from '../../shared/diaryLife.js'
import { MAX_DIARY_ATTACHMENT_BYTES } from '../../shared/diaryAttachments.js'
import { withDiaryBodyOperation } from '../diaryAccess/guard.js'
import { diaryToday, DIARY_TIME_ZONE_HEADER, resolveDiaryTimeZone } from '../diaryDate.js'
import type { DiaryBodyOperation } from '../diaryAccess/service.js'
import { DiaryAttachmentError, discardStagedDiaryAttachment, readDiaryAttachment, renewDiaryAttachmentStageSession, renewDiaryEventAttachmentStageSession, stageDiaryAttachment, stageDiaryEventAttachment } from '../diaryAttachments/service.js'
import { DiaryAttachmentStorage } from '../diaryAttachments/storage.js'
import { validateDiaryAttachmentInput } from '../diaryAttachments/validation.js'
import { metadataDb } from './shared.js'

type Env = { Variables: { authUser: { id: number }; authSessionId: number; diaryTimeZone: string } }
const routes = new Hono<Env>()
const MAX_MULTIPART_OVERHEAD = 64 * 1024
routes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  await next()
})
routes.use('*', async (c, next) => {
  const timeZone = resolveDiaryTimeZone(c.req.header(DIARY_TIME_ZONE_HEADER))
  if (!timeZone) return c.json({ code: 'invalid-diary-time-zone' }, 400)
  c.set('diaryTimeZone', timeZone)
  await next()
})
routes.use('*', bodyLimit({ maxSize: MAX_DIARY_ATTACHMENT_BYTES + MAX_MULTIPART_OVERHEAD }))

async function guarded(c: Context<Env>, run: (owner: number, operation: DiaryBodyOperation) => Promise<Response> | Response) {
  const owner = c.get('authUser')?.id
  if (!owner) return c.json({ code: 'auth-session-required' }, 401)
  try {
    return await withDiaryBodyOperation(c, async operation => {
      if (!operation.attachments) return c.json({ code: 'diary-unavailable' }, 503)
      const response = await run(owner, operation)
      operation.assertCurrent()
      return response
    }) ?? c.json({ code: 'diary-locked' }, 423)
  } catch (error) {
    if (error instanceof DiaryAttachmentError) return c.json({ code: `diary-attachment-${error.code}` }, error.status)
    c.header('Cache-Control', 'no-store')
    return c.json({ code: 'diary-attachment-unavailable' }, 503)
  }
}

routes.post('/stage', c => guarded(c, async (owner, operation) => {
  let form: FormData
  try { form = await c.req.formData() } catch { return c.json({ code: 'diary-attachment-invalid' }, 400) }
  const date = form.get('date')
  const sessionId = form.get('sessionId')
  const file = form.get('file')
  const requestKey = c.req.header('Idempotency-Key') ?? ''
  if (typeof date !== 'string' || !civilDate(date) || typeof sessionId !== 'string' || !(file instanceof File)) return c.json({ code: 'diary-attachment-invalid' }, 400)
  if (date > diaryToday(c.get('diaryTimeZone'))) return c.json({ code: 'diary-future-date' }, 403)
  if (file.size < 1) return c.json({ code: 'diary-attachment-invalid' }, 400)
  if (file.size > MAX_DIARY_ATTACHMENT_BYTES) return c.json({ code: 'diary-attachment-too-large' }, 413)
  const bytes = Buffer.from(await file.arrayBuffer())
  try {
    const validated = validateDiaryAttachmentInput({
      bytes,
      mimeType: file.type.trim().toLowerCase(),
      name: file.name,
    })
    if (!validated) return c.json({ code: 'diary-attachment-unsupported' }, 415)
    const db = metadataDb()
    const metadata = await stageDiaryAttachment({
      db, owner, date, sessionId, name: validated.name, mimeType: validated.mimeType,
      bytes, requestKey, operation, storage: new DiaryAttachmentStorage(db),
    })
    return c.json({ attachment: metadata }, 201)
  } finally { bytes.fill(0) }
}))

routes.post('/events/:eventId/stage', c => guarded(c, async (owner, operation) => {
  let form: FormData
  try { form = await c.req.formData() } catch { return c.json({ code: 'diary-attachment-invalid' }, 400) }
  const eventId = c.req.param('eventId')
  const sessionId = form.get('sessionId')
  const file = form.get('file')
  const requestKey = c.req.header('Idempotency-Key') ?? ''
  if (typeof sessionId !== 'string' || !(file instanceof File)) return c.json({ code: 'diary-attachment-invalid' }, 400)
  if (file.size < 1) return c.json({ code: 'diary-attachment-invalid' }, 400)
  if (file.size > MAX_DIARY_ATTACHMENT_BYTES) return c.json({ code: 'diary-attachment-too-large' }, 413)
  const bytes = Buffer.from(await file.arrayBuffer())
  try {
    const validated = validateDiaryAttachmentInput({ bytes, mimeType: file.type.trim().toLowerCase(), name: file.name })
    if (!validated) return c.json({ code: 'diary-attachment-unsupported' }, 415)
    const db = metadataDb()
    const attachment = await stageDiaryEventAttachment({ db, owner, eventId, sessionId, name: validated.name,
      mimeType: validated.mimeType, bytes, requestKey, operation, storage: new DiaryAttachmentStorage(db) })
    return c.json({ attachment }, 201)
  } finally { bytes.fill(0) }
}))

routes.post('/sessions/:sessionId/heartbeat', c => guarded(c, async (owner, operation) => {
  let body: unknown
  try { body = await c.req.json() } catch { return c.json({ code: 'diary-attachment-invalid' }, 400) }
  const date = (body as { date?: unknown } | null)?.date
  if (!civilDate(date)) {
    return c.json({ code: 'diary-attachment-invalid' }, 400)
  }
  if (date > diaryToday(c.get('diaryTimeZone'))) return c.json({ code: 'diary-future-date' }, 403)
  const db = metadataDb()
  await renewDiaryAttachmentStageSession({
    db, owner, date,
    sessionId: c.req.param('sessionId'), operation, storage: new DiaryAttachmentStorage(db),
  })
  return c.body(null, 204)
}))

routes.post('/events/:eventId/sessions/:sessionId/heartbeat', c => guarded(c, async (owner, operation) => {
  const db = metadataDb()
  await renewDiaryEventAttachmentStageSession({ db, owner, eventId: c.req.param('eventId'),
    sessionId: c.req.param('sessionId'), operation, storage: new DiaryAttachmentStorage(db) })
  return c.body(null, 204)
}))

routes.get('/:id/content', c => guarded(c, async (owner, operation) => {
  const db = metadataDb()
  const result = await readDiaryAttachment({ db, owner, id: c.req.param('id'), operation, storage: new DiaryAttachmentStorage(db) })
  if (!result) return c.json({ code: 'diary-attachment-not-found' }, 404)
  let responseBytes: Uint8Array | null = null
  try {
    const encodedName = encodeURIComponent(result.metadata.name).replace(/[!'()*]/gu, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    const disposition = result.metadata.mimeType === 'application/pdf' ? 'attachment' : 'inline'
    responseBytes = Uint8Array.from(result.bytes)
    return new Response(responseBytes, { status: 200, headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Type': result.metadata.mimeType,
      'Content-Disposition': `${disposition}; filename*=UTF-8''${encodedName}`,
      'Content-Length': String(responseBytes.byteLength),
      'Content-Security-Policy': "default-src 'none'; sandbox",
    } })
  } catch (error) {
    responseBytes?.fill(0)
    throw error
  } finally {
    result.bytes.fill(0)
  }
}))

routes.delete('/:id', c => guarded(c, async (owner, operation) => {
  const db = metadataDb()
  await discardStagedDiaryAttachment({ db, owner, id: c.req.param('id'), operation, storage: new DiaryAttachmentStorage(db) })
  return c.json({ ok: true })
}))

routes.onError((_error, c) => {
  c.header('Cache-Control', 'no-store')
  return c.json({ code: 'diary-attachment-unavailable' }, 503)
})

export default routes

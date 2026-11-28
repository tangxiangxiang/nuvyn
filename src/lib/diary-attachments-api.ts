import { diaryAuthFetch } from './auth-session'
import { MAX_DIARY_ATTACHMENT_BYTES, type DiaryAttachment } from '../../shared/diaryAttachments'

export function createDiaryAttachmentClientId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}

async function assertResponse(response: Response): Promise<void> {
  if (response.ok) return
  let code = ''
  try { code = String((await response.clone().json() as { code?: unknown }).code ?? '') } catch { /* use the stable fallback below */ }
  if (code === 'diary-future-date') throw new Error('未来日期的日记只能查看。')
  if (response.status === 413 || code === 'diary-attachment-too-large') throw new Error('单个附件不能超过 20 MiB。')
  if (code === 'diary-attachment-too-many') throw new Error('最多添加 20 个附件。')
  if (response.status === 409) throw new Error('日记附件已发生变化，请重新打开后再试。')
  if (response.status === 423) throw new Error('日记已锁定，请重新解锁。')
  if (response.status === 415 || code === 'diary-attachment-unsupported') throw new Error('仅支持 PNG、JPEG、WebP、GIF、AVIF 图片和 PDF 文件。')
  throw new Error('附件操作失败，请重试。')
}

export const diaryAttachmentsApi = {
  async stage(date: string, sessionId: string, file: File, signal?: AbortSignal): Promise<DiaryAttachment> {
    if (file.size < 1 || file.size > MAX_DIARY_ATTACHMENT_BYTES) throw new Error('单个附件不能超过 20 MiB。')
    const form = new FormData()
    form.append('date', date)
    form.append('sessionId', sessionId)
    form.append('file', file, file.name)
    const response = await diaryAuthFetch('/api/diary/attachments/stage', {
      method: 'POST', signal, cache: 'no-store', headers: { 'Idempotency-Key': createDiaryAttachmentClientId() }, body: form,
    })
    await assertResponse(response)
    const result = await response.json() as { attachment?: DiaryAttachment }
    if (!result.attachment || result.attachment.date !== date || result.attachment.size !== file.size) throw new Error('附件响应无效，请重试。')
    return result.attachment
  },

  async heartbeat(date: string, sessionId: string, signal?: AbortSignal): Promise<void> {
    const response = await diaryAuthFetch(`/api/diary/attachments/sessions/${encodeURIComponent(sessionId)}/heartbeat`, {
      method: 'POST', signal, cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date }),
    })
    await assertResponse(response)
  },

  async discard(id: string, signal?: AbortSignal): Promise<void> {
    const response = await diaryAuthFetch(`/api/diary/attachments/${encodeURIComponent(id)}`, {
      method: 'DELETE', signal, cache: 'no-store',
    })
    await assertResponse(response)
  },

  async content(attachment: DiaryAttachment, signal?: AbortSignal): Promise<Blob> {
    const response = await diaryAuthFetch(`/api/diary/attachments/${encodeURIComponent(attachment.id)}/content`, {
      method: 'GET', signal, cache: 'no-store',
    })
    await assertResponse(response)
    if (response.headers.get('cache-control') !== 'no-store'
      || response.headers.get('x-content-type-options')?.toLowerCase() !== 'nosniff'
      || response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== attachment.mimeType) {
      throw new Error('附件响应校验失败。')
    }
    const blob = await response.blob()
    if (blob.size !== attachment.size) throw new Error('附件内容不完整，请重试。')
    return blob
  },
}

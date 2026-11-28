export const MAX_DIARY_ATTACHMENT_BYTES = 20 * 1024 * 1024
export const MAX_DIARY_DAY_ATTACHMENTS = 20
export const DIARY_ATTACHMENT_STAGE_LEASE_MS = 15 * 60 * 1000
export const DIARY_ATTACHMENT_STAGE_HEARTBEAT_INTERVAL_MS = 60 * 1000

export const DIARY_ATTACHMENT_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
  'application/pdf',
] as const

export type DiaryAttachmentMimeType = typeof DIARY_ATTACHMENT_MIME_TYPES[number]
type DiaryAttachmentFields = {
  id: string
  name: string
  mimeType: DiaryAttachmentMimeType
  size: number
  createdAt: number
  order: number
}
export type DiaryAttachment = DiaryAttachmentFields & { date: string }

export function isDiaryAttachmentMimeType(value: unknown): value is DiaryAttachmentMimeType {
  return typeof value === 'string' && (DIARY_ATTACHMENT_MIME_TYPES as readonly string[]).includes(value)
}

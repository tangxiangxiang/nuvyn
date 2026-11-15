import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DiaryAttachmentPreviewUrls } from '../diaryAttachmentPreviewUrls'

let revoked: string[]
let nextUrl: number
let originalCreate: PropertyDescriptor | undefined
let originalRevoke: PropertyDescriptor | undefined

beforeEach(() => {
  revoked = []
  nextUrl = 0
  originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
  originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => `blob:diary-preview-${++nextUrl}`),
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn((url: string) => { revoked.push(url) }),
  })
})

afterEach(() => {
  if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate)
  else Reflect.deleteProperty(URL, 'createObjectURL')
  if (originalRevoke) Object.defineProperty(URL, 'revokeObjectURL', originalRevoke)
  else Reflect.deleteProperty(URL, 'revokeObjectURL')
})

describe('DiaryAttachmentPreviewUrls', () => {
  it('creates and associates only local image previews, then releases them once', () => {
    const previews = new DiaryAttachmentPreviewUrls()
    const imageUrl = previews.create(new File(['image'], 'memory.png', { type: 'image/png' }))
    const pdfUrl = previews.create(new File(['pdf'], 'memory.pdf', { type: 'application/pdf' }))

    expect(imageUrl).toBe('blob:diary-preview-1')
    expect(pdfUrl).toBeNull()
    previews.associate('attachment-1', imageUrl!)
    previews.release('attachment-1')
    previews.release('attachment-1')

    expect(revoked).toEqual([imageUrl])
  })

  it('releases failed uploads and clears both pending and associated URLs', () => {
    const previews = new DiaryAttachmentPreviewUrls()
    const failedUrl = previews.create(new File(['failed'], 'failed.webp', { type: 'image/webp' }))
    const stagedUrl = previews.create(new File(['staged'], 'staged.jpg', { type: 'image/jpeg' }))
    previews.releaseUnassigned(failedUrl)
    previews.associate('attachment-2', stagedUrl!)

    previews.clear()
    previews.clear()

    expect(revoked).toEqual([failedUrl, stagedUrl])
  })
})

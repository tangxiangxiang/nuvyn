const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'])

/** Owns in-memory object URLs used only while a Diary attachment is staged. */
export class DiaryAttachmentPreviewUrls {
  private readonly byAttachment = new Map<string, string>()
  private readonly unassigned = new Set<string>()

  create(file: File): string | null {
    if (!IMAGE_MIME_TYPES.has(file.type.toLowerCase())) return null
    const url = URL.createObjectURL(file)
    this.unassigned.add(url)
    return url
  }

  associate(id: string, url: string): void {
    if (!this.unassigned.delete(url)) return
    const previous = this.byAttachment.get(id)
    if (previous) URL.revokeObjectURL(previous)
    this.byAttachment.set(id, url)
  }

  releaseUnassigned(url: string | null): void {
    if (!url || !this.unassigned.delete(url)) return
    URL.revokeObjectURL(url)
  }

  release(id: string): void {
    const url = this.byAttachment.get(id)
    if (!url) return
    this.byAttachment.delete(id)
    URL.revokeObjectURL(url)
  }

  clear(): void {
    for (const url of this.byAttachment.values()) URL.revokeObjectURL(url)
    for (const url of this.unassigned) URL.revokeObjectURL(url)
    this.byAttachment.clear()
    this.unassigned.clear()
  }
}

type AttachmentReferenceChangeListener = () => void

const listeners = new Set<AttachmentReferenceChangeListener>()

export function notifyAttachmentReferencesChanged(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // A derived reference index must not fail the completed source mutation.
    }
  }
}

export function onAttachmentReferencesChanged(listener: AttachmentReferenceChangeListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

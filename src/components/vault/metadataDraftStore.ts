export type MetadataContext = 'document' | 'history' | 'diff' | 'recovery'

export interface MetadataBase {
  title: string
  summary: string
  tags: string[]
  updatedAt: number
}

export interface MetadataDraft {
  documentId: string | null
  path: string
  title: string
  summary: string
  tagsText: string
  base: MetadataBase
  dirty: boolean
  uncertain?: boolean
  revision: number
}

/** Session-only drafts. Deliberately not persisted or connected to recovery. */
export type MetadataDraftKey = `id:${string}` | `path:${string}`

export const metadataDrafts = new Map<MetadataDraftKey, MetadataDraft>()

/** Backwards-compatible name for callers that only need to clear the store. */
export const draftsByDocumentId = metadataDrafts

export function metadataDraftKey(identity: {
  path: string
  documentId: string | null
}): MetadataDraftKey {
  return identity.documentId ? `id:${identity.documentId}` : `path:${identity.path}`
}

export function getMetadataDraft(identity: {
  path: string
  documentId: string | null
}): MetadataDraft | undefined {
  return metadataDrafts.get(metadataDraftKey(identity))
}

export function setMetadataDraft(draft: MetadataDraft): void {
  metadataDrafts.set(metadataDraftKey(draft), draft)
}

export function migrateMetadataDraft(
  from: { path: string; documentId: string | null },
  to: { path: string; documentId: string },
  draft: MetadataDraft,
): void {
  metadataDrafts.delete(metadataDraftKey(from))
  metadataDrafts.delete(metadataDraftKey(to))
  metadataDrafts.set(metadataDraftKey(to), { ...draft, path: to.path, documentId: to.documentId })
}

export function clearMetadataDraftForPath(path: string): void {
  for (const [key, draft] of metadataDrafts) {
    if (draft.path === path) metadataDrafts.delete(key)
  }
}

export function updateMetadataDraftPath(oldPath: string, newPath: string): void {
  for (const [key, draft] of [...metadataDrafts]) {
    if (draft.path !== oldPath) continue
    const next = { ...draft, path: newPath }
    if (draft.documentId) {
      metadataDrafts.set(key, next)
    } else {
      metadataDrafts.delete(key)
      metadataDrafts.set(metadataDraftKey(next), next)
    }
  }
}

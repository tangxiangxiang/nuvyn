import { getDocumentMetadataById } from '../../../lib/api'
import type { CurrentDocumentLocation } from './useUnsavedDraftPersistence'

/** The production resolver for a move-indeterminate retry whose draft
 *  family has emptied out of IndexedDB: answers "where does this
 *  document live RIGHT NOW" with a by-stable-identity SERVER query —
 *  the only authoritative source once every local draft row is gone.
 *  Local caches are deliberately off-limits here: the posts list, the
 *  file tree and the Tab's own path can all be stale under a
 *  concurrent rename (the exact race this resolver exists for), so
 *  none of them may stand in for the server's answer.
 *  The `vaultId` parameter satisfies the persistence contract but is
 *  ignored: the server is single-vault, so the identity alone keys
 *  the lookup.
 *  `version` carries the server's updatedAt: authentication compares
 *  PATHS (a metadata-only edit bumps updatedAt without renaming, and
 *  treating that drift as a conflict would fail closed spuriously),
 *  but the token travels with the contract for any future
 *  server-side CAS.
 *  Failure policy: 404 (document deleted server-side) answers null
 *  and the retry fails closed; any other error THROWS so the retry
 *  fails closed rather than trusting a stale path. */
export function createServerDocumentPathResolver(): (
  vaultId: string,
  documentId: string,
) => Promise<CurrentDocumentLocation | null> {
  return async (_vaultId, documentId) => {
    const metadata = await getDocumentMetadataById(documentId)
    if (!metadata) return null
    return { path: metadata.path, version: metadata.updatedAt }
  }
}

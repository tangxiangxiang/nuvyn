import {
  hasValidSnapshotRowSchema,
  isSerializedMetadataSnapshot,
} from './folderMoveTransaction.js'
import type { SerializedMetadataSnapshot } from './folderMoveTransaction.js'

export type MetadataSnapshotValidationMode = 'row-schema-only' | 'closed-graph'

/**
 * Unified metadata snapshot validator for the four durable snapshot
 * sites (parser, prefix preparedSnapshot, prefix committedSnapshot,
 * snapshot-restore snapshot + expectedCurrentSnapshot).
 *
 *   'row-schema-only' -> hasValidSnapshotRowSchema (cheap; rows typed)
 *   'closed-graph'    -> isSerializedMetadataSnapshot (top-level ID
 *                        set + row set equality + cross-row references
 *                        + duplicate detection). Equivalent to the
 *                        combination of isSerializedMetadataSnapshot
 *                        plus the latent validateSnapshotClosure set
 *                        equality that round-17 was missing.
 *
 * Mode 'closed-graph' is what durable sites require; the
 * row-schema-only mode is kept for diagnostic / non-persistence
 * callers that want the cheaper check.
 */
export function validateSerializedMetadataSnapshot(
  snapshot: SerializedMetadataSnapshot,
  options: {
    mode: MetadataSnapshotValidationMode
    /** Exact durable mutation-footprint paths that may intentionally
     * have no current document/migration row. */
    ownershipPaths?: readonly string[]
  },
): SerializedMetadataSnapshot | null {
  if (options.mode === 'row-schema-only') {
    return hasValidSnapshotRowSchema(snapshot) ? snapshot : null
  }
  if (!isSerializedMetadataSnapshot(snapshot)) return null

  const explainedPaths = new Set<string>(
    snapshot.documents.map(row => String(row.path)),
  )
  for (const row of snapshot.migrations) {
    const migrationPath = String(row.path)
    if (!migrationPath.startsWith('@deleted/')) {
      explainedPaths.add(migrationPath)
    }
    const originalPath = String(row.original_path ?? '')
    if (originalPath !== '') explainedPaths.add(originalPath)
  }
  const exactOwnership = new Set(options.ownershipPaths ?? [])
  if (!snapshot.paths.every(snapshotPath =>
    explainedPaths.has(snapshotPath)
    || exactOwnership.has(snapshotPath))) {
    return null
  }
  return snapshot
}

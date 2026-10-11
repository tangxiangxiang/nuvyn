import type { Database as DatabaseT } from 'better-sqlite3'
import type { ManagedAttachment } from '../../../shared/attachmentProtocol.js'
import { isBoardAssetMimeType } from '../../../shared/assetProtocol.js'

interface BoardAssetCatalogRow {
  id: string
  mime_type: string
  byte_size: number
  created_at: number
  reference_count: number
}

/** Reads only Board Asset metadata and the existing direct-reference index. */
export function listBoardAssetCatalog(db: DatabaseT): ManagedAttachment[] {
  const rows = db.prepare(`
    SELECT
      assets.id,
      assets.mime_type,
      assets.byte_size,
      assets.created_at,
      COUNT(asset_references.asset_id) AS reference_count
    FROM assets
    LEFT JOIN asset_references ON asset_references.asset_id = assets.id
    GROUP BY assets.id
    ORDER BY assets.created_at DESC, assets.id ASC
  `).all() as BoardAssetCatalogRow[]

  return rows.map((row) => {
    const mimeType = isBoardAssetMimeType(row.mime_type) ? row.mime_type : null
    const knownReferenceCount = Math.max(0, Number(row.reference_count) || 0)
    return {
      key: { kind: 'asset', id: row.id },
      source: 'board-asset',
      type: 'image',
      displayName: null,
      mimeType,
      byteSize: Number.isSafeInteger(row.byte_size) && row.byte_size >= 0 ? row.byte_size : null,
      createdAt: Number.isSafeInteger(row.created_at) && row.created_at >= 0 ? row.created_at : null,
      modifiedAt: null,
      // A zero in this Board-specific table is not proof that no Note or
      // historical reference exists, so only positive counts are conclusive.
      referenceStatus: knownReferenceCount > 0 ? 'referenced' : 'unknown',
      knownReferenceCount,
    }
  })
}

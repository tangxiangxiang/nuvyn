import type { Database as DatabaseT } from 'better-sqlite3'
import type { ManagedAttachment } from '../../../shared/attachmentProtocol.js'

interface BoardMaterialCatalogRow {
  id: string
  name: string
  byte_size: number
  archived: number
  created_at: number
  updated_at: number
}

/** The SQL projection computes UTF-8 byte size without returning SVG content. */
export function listBoardMaterialCatalog(db: DatabaseT): ManagedAttachment[] {
  const rows = db.prepare(`
    SELECT
      id,
      name,
      length(CAST(content AS BLOB)) AS byte_size,
      archived,
      created_at,
      updated_at
    FROM board_materials
    ORDER BY archived ASC, updated_at DESC, id ASC
  `).all() as BoardMaterialCatalogRow[]

  return rows.map((row) => ({
    key: { kind: 'board-material', id: row.id },
    source: 'board-material',
    type: 'material',
    displayName: row.name,
    mimeType: 'image/svg+xml',
    byteSize: Number.isSafeInteger(row.byte_size) && row.byte_size >= 0 ? row.byte_size : null,
    createdAt: Number.isSafeInteger(row.created_at) && row.created_at >= 0 ? row.created_at : null,
    modifiedAt: Number.isSafeInteger(row.updated_at) && row.updated_at >= 0 ? row.updated_at : null,
    referenceStatus: 'unknown',
    archived: row.archived === 1,
  }))
}

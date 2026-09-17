import type { Database as DatabaseT } from 'better-sqlite3'
import type { AssetMetadata } from '../../shared/assetProtocol.js'

export interface AssetReferenceOwner {
  readonly ownerType: string
  readonly ownerId: string
  readonly purpose: string
}

export interface AssetRepository {
  findAsset(assetId: string): AssetMetadata | null
  insertAsset(metadata: AssetMetadata): void
  listReferenceIds(owner: AssetReferenceOwner): string[]
  replaceReferences(owner: AssetReferenceOwner, assetIds: readonly string[], createdAt: number): void
  deleteReferences(owner: AssetReferenceOwner): string[]
  deleteAllReferencesForOwner(owner: Pick<AssetReferenceOwner, 'ownerType' | 'ownerId'>): string[]
  tryClaimUnreferencedAssetForDeletion(assetId: string): { claimed: boolean; storageKey?: string }
}

type AssetRow = {
  id: string
  mime_type: string
  byte_size: number
  sha256: string
  storage_key: string
  created_at: number
}

function toAssetMetadata(row: AssetRow): AssetMetadata {
  return {
    id: row.id,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    sha256: row.sha256,
    storageKey: row.storage_key,
    createdAt: row.created_at,
  }
}

function runImmediate<T>(db: DatabaseT, callback: () => T): T {
  if (db.inTransaction) return callback()
  return db.transaction(callback).immediate()
}

export class SqliteAssetRepository implements AssetRepository {
  private readonly db: DatabaseT

  constructor(db: DatabaseT) {
    this.db = db
  }

  findAsset(assetId: string): AssetMetadata | null {
    const row = this.db.prepare(`
      SELECT id, mime_type, byte_size, sha256, storage_key, created_at
      FROM assets
      WHERE id = ?
    `).get(assetId) as AssetRow | undefined
    return row ? toAssetMetadata(row) : null
  }

  insertAsset(metadata: AssetMetadata): void {
    runImmediate(this.db, () => {
      this.db.prepare(`
        INSERT INTO assets (id, mime_type, byte_size, sha256, storage_key, created_at)
        VALUES (@id, @mimeType, @byteSize, @sha256, @storageKey, @createdAt)
      `).run(metadata)
    })
  }

  listReferenceIds(owner: AssetReferenceOwner): string[] {
    const rows = this.db.prepare(`
      SELECT asset_id
      FROM asset_references
      WHERE owner_type = @ownerType
        AND owner_id = @ownerId
        AND purpose = @purpose
      ORDER BY asset_id ASC
    `).all(owner) as Array<{ asset_id: string }>
    return rows.map((row) => row.asset_id)
  }

  replaceReferences(owner: AssetReferenceOwner, assetIds: readonly string[], createdAt: number): void {
    const replace = () => {
      this.db.prepare(`
        DELETE FROM asset_references
        WHERE owner_type = @ownerType
          AND owner_id = @ownerId
          AND purpose = @purpose
      `).run(owner)

      const insert = this.db.prepare(`
        INSERT INTO asset_references (
          asset_id, owner_type, owner_id, purpose, created_at
        ) VALUES (@assetId, @ownerType, @ownerId, @purpose, @createdAt)
      `)
      for (const assetId of assetIds) {
        insert.run({
          assetId,
          ownerType: owner.ownerType,
          ownerId: owner.ownerId,
          purpose: owner.purpose,
          createdAt,
        })
      }
    }
    runImmediate(this.db, replace)
  }

  deleteReferences(owner: AssetReferenceOwner): string[] {
    const assetIds = this.listReferenceIds(owner)
    this.db.prepare(`
      DELETE FROM asset_references
      WHERE owner_type = @ownerType
        AND owner_id = @ownerId
        AND purpose = @purpose
    `).run(owner)
    return assetIds
  }

  deleteAllReferencesForOwner(owner: Pick<AssetReferenceOwner, 'ownerType' | 'ownerId'>): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT asset_id
      FROM asset_references
      WHERE owner_type = @ownerType
        AND owner_id = @ownerId
      ORDER BY asset_id ASC
    `).all(owner) as Array<{ asset_id: string }>
    this.db.prepare(`
      DELETE FROM asset_references
      WHERE owner_type = @ownerType
        AND owner_id = @ownerId
    `).run(owner)
    return rows.map((row) => row.asset_id)
  }

  /**
   * Claim and remove metadata under one BEGIN IMMEDIATE transaction.  The
   * NOT EXISTS predicate is part of the DELETE itself; no count-then-delete
   * window exists for a concurrent reference writer.
   */
  tryClaimUnreferencedAssetForDeletion(assetId: string): { claimed: boolean; storageKey?: string } {
    if (this.db.inTransaction) {
      throw new Error('asset cleanup claim must run in an independent transaction')
    }

    return this.db.transaction(() => {
      const candidate = this.db.prepare(`
        SELECT storage_key
        FROM assets
        WHERE id = @assetId
          AND NOT EXISTS (
            SELECT 1
            FROM asset_references
            WHERE asset_id = @assetId
          )
      `).get({ assetId }) as { storage_key: string } | undefined

      if (!candidate) return { claimed: false }

      const deleted = this.db.prepare(`
        DELETE FROM assets
        WHERE id = @assetId
          AND NOT EXISTS (
            SELECT 1
            FROM asset_references
            WHERE asset_id = @assetId
          )
      `).run({ assetId })

      if (deleted.changes !== 1) return { claimed: false }
      return { claimed: true, storageKey: candidate.storage_key }
    }).immediate()
  }
}

export function createAssetRepository(db: DatabaseT): AssetRepository {
  return new SqliteAssetRepository(db)
}

import { createHash } from 'node:crypto'
import type { Database as DatabaseT } from 'better-sqlite3'
import type { AssetMetadata } from '../../shared/assetProtocol.js'
import { AssetError } from './errors.js'
import { createAssetRepository, type AssetRepository } from './repository.js'
import { AssetStorage } from './storage.js'
import type {
  AssetCleanupResult,
  AssetServiceDependencies,
  PersistAssetInput,
} from './types.js'
import { assertAssetId, assertBoardAssetMimeType, normalizeAssetIds } from './validation.js'

function isFileExists(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'EEXIST'
}

function isSafeTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function isSafeMaxBytes(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function toBuffer(data: Uint8Array): Buffer {
  if (!(data instanceof Uint8Array)) {
    throw new AssetError('ASSET_BINARY_CONFLICT', 400, 'Asset binary must be bytes')
  }
  return Buffer.from(data)
}

export class AssetService {
  readonly repository: AssetRepository
  readonly storage: AssetStorage
  private readonly now: () => number

  constructor(db: DatabaseT, dependencies: AssetServiceDependencies = {}) {
    this.repository = dependencies.repository ?? createAssetRepository(db)
    this.storage = dependencies.storage ?? new AssetStorage()
    this.now = dependencies.now ?? Date.now
  }

  getAssetMetadata(assetId: string): AssetMetadata | null {
    return this.repository.findAsset(assertAssetId(assetId))
  }

  async persistAsset(input: PersistAssetInput): Promise<AssetMetadata> {
    const assetId = assertAssetId(input.assetId)
    const mimeType = assertBoardAssetMimeType(input.mimeType)
    const data = toBuffer(input.data)
    if (input.maxBytes !== undefined && !isSafeMaxBytes(input.maxBytes)) {
      throw new AssetError('ASSET_BINARY_CONFLICT', 400, 'Asset byte limit must be a non-negative safe integer')
    }
    if (input.maxBytes !== undefined && data.byteLength > input.maxBytes) {
      throw new AssetError('ASSET_BINARY_CONFLICT', 413, 'Asset binary exceeds the configured byte limit')
    }

    const sha256 = createHash('sha256').update(data).digest('hex')
    const byteSize = data.byteLength
    const existing = this.repository.findAsset(assetId)
    if (existing) return this.verifyIdempotentAsset(existing, byteSize, sha256)

    const createdAt = this.now()
    if (!isSafeTimestamp(createdAt)) {
      throw new AssetError('ASSET_STORAGE_ERROR', 500, 'Asset timestamp is not a safe millisecond value')
    }
    const metadata: AssetMetadata = {
      id: assetId,
      mimeType,
      byteSize,
      sha256,
      storageKey: assetId,
      createdAt,
    }

    let owned: import('../durableCreateOnlyFile.js').CreatedDurableFile | null = null
    try {
      owned = await this.storage.createAssetBinary(assetId, data)
    } catch (error) {
      if (!isFileExists(error)) throw error

      // Another writer may have committed metadata between our initial read
      // and the create-only collision.  Re-read before considering the file an
      // orphan incumbent.
      const raced = this.repository.findAsset(assetId)
      if (raced) return this.verifyIdempotentAsset(raced, byteSize, sha256)

      // EEXIST means this call never owned the incumbent directory entry.
      // Without committed metadata there is no safe way to distinguish an
      // orphan from a cleanup or concurrent-commit window, so fail closed.
      throw new AssetError(
        'ASSET_BINARY_CONFLICT',
        409,
        'Asset binary exists without committed metadata',
      )
    }

    try {
      this.repository.insertAsset(metadata)
      return metadata
    } catch (error) {
      // A commit error can be ambiguous.  Never remove a file if metadata for
      // this ID is now visible; doing so could turn that row into a dangling
      // reference.  If no row exists, only the file owned by this call may be
      // compensated, and a failed compensation intentionally leaves an orphan.
      let incumbent: AssetMetadata | null = null
      try {
        incumbent = this.repository.findAsset(assetId)
      } catch {
        // With no reliable DB answer, fail closed and retain the binary.
      }
      if (incumbent) return this.verifyIdempotentAsset(incumbent, byteSize, sha256)
      if (owned) await this.storage.removeCreatedFile(owned).catch(() => {})
      throw new AssetError('ASSET_METADATA_PERSIST_FAILED', 500, 'Asset metadata could not be persisted', { cause: error })
    }
  }

  async readAssetBinary(assetId: string): Promise<Buffer> {
    const metadata = this.repository.findAsset(assertAssetId(assetId))
    if (!metadata) throw new AssetError('ASSET_NOT_FOUND', 404, 'Asset was not found')
    this.assertStorageKey(metadata)

    let data: Buffer
    try {
      data = await this.storage.readAssetBinary(metadata.id)
    } catch (error) {
      if (AssetStorage.isMissing(error)) {
        throw new AssetError('ASSET_BINARY_MISSING', 500, 'Asset metadata points to a missing binary', { cause: error })
      }
      if (error instanceof AssetError) throw error
      throw new AssetError('ASSET_BINARY_UNREADABLE', 500, 'Asset binary could not be read', { cause: error })
    }
    const observedHash = createHash('sha256').update(data).digest('hex')
    if (data.byteLength !== metadata.byteSize || observedHash !== metadata.sha256) {
      throw new AssetError('ASSET_BINARY_CORRUPT', 500, 'Asset binary does not match its metadata')
    }
    return data
  }

  async assertAssetReferencesReadable(assetIds: unknown): Promise<string[]> {
    const normalized = normalizeAssetIds(assetIds)
    for (const assetId of normalized) await this.readAssetBinary(assetId)
    return normalized
  }

  /** Claim metadata atomically, then perform physical cleanup post-commit. */
  async tryClaimUnreferencedAssetForDeletion(assetId: string): Promise<AssetCleanupResult> {
    const validated = assertAssetId(assetId)
    const claim = this.repository.tryClaimUnreferencedAssetForDeletion(validated)
    if (!claim.claimed || !claim.storageKey) {
      return {
        assetId: validated,
        claimed: false,
        physicalDeleted: false,
      }
    }

    try {
      if (claim.storageKey !== validated) {
        throw new AssetError('ASSET_STORAGE_ERROR', 500, 'Asset storage key failed its identity check')
      }
      const physicalDeleted = await this.storage.removeAssetBinary(claim.storageKey)
      return {
        assetId: validated,
        claimed: true,
        storageKey: claim.storageKey,
        physicalDeleted,
      }
    } catch (error) {
      return {
        assetId: validated,
        claimed: true,
        storageKey: claim.storageKey,
        physicalDeleted: false,
        error,
      }
    }
  }

  private assertStorageKey(metadata: AssetMetadata): void {
    if (metadata.storageKey !== metadata.id) {
      throw new AssetError('ASSET_STORAGE_ERROR', 500, 'Asset metadata contains an unsafe storage key')
    }
    assertAssetId(metadata.storageKey)
  }

  private async verifyIdempotentAsset(
    metadata: AssetMetadata,
    byteSize: number,
    sha256: string,
  ): Promise<AssetMetadata> {
    this.assertStorageKey(metadata)
    if (metadata.byteSize !== byteSize || metadata.sha256 !== sha256) {
      throw new AssetError('ASSET_ID_CONFLICT', 409, 'Asset ID is already used for different content')
    }
    await this.readAssetBinary(metadata.id)
    return metadata
  }
}

export function createAssetService(
  db: DatabaseT,
  dependencies: AssetServiceDependencies = {},
): AssetService {
  return new AssetService(db, dependencies)
}

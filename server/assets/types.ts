import type { AssetMetadata } from '../../shared/assetProtocol.js'
import type { CreatedDurableFile } from '../durableCreateOnlyFile.js'

export interface PersistAssetInput {
  readonly assetId: string
  readonly mimeType: string
  readonly data: Uint8Array
  readonly maxBytes?: number
}

export interface AssetCleanupResult {
  readonly assetId: string
  readonly claimed: boolean
  readonly storageKey?: string
  readonly physicalDeleted: boolean
  readonly error?: unknown
}

export interface AssetServiceDependencies {
  readonly now?: () => number
  readonly storage?: import('./storage.js').AssetStorage
  readonly repository?: import('./repository.js').AssetRepository
}

export type { AssetMetadata, CreatedDurableFile }

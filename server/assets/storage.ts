import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { getDataDir } from '../db.js'
import {
  captureDurableFile,
  removeCreatedDurableFile,
  writeCreateOnlyDurableFile,
  type CreatedDurableFile,
} from '../durableCreateOnlyFile.js'
import { AssetError } from './errors.js'
import { assertAssetId } from './validation.js'

function isNotFound(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
}

function sameIdentity(left: { dev: bigint; ino: bigint }, right: { dev: bigint; ino: bigint }): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

/** Filesystem boundary for durable Board assets. */
export class AssetStorage {
  readonly directory: string

  constructor(directory = path.join(getDataDir(), 'assets')) {
    this.directory = path.resolve(directory)
  }

  /** Create the directory if absent, then fail closed on symlinks/objects. */
  async ensureDirectory(): Promise<void> {
    try {
      await fs.mkdir(this.directory, { recursive: true })
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error
    }

    const stat = await fs.lstat(this.directory)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new AssetError(
        'ASSET_STORAGE_ERROR',
        500,
        `Asset storage path is not a regular directory: ${this.directory}`,
      )
    }
  }

  /** Resolve only a validated UUID into the storage directory. */
  pathForAssetId(assetId: unknown): string {
    const validated = assertAssetId(assetId)
    const resolved = path.resolve(this.directory, validated)
    if (resolved !== path.join(this.directory, validated)) {
      throw new AssetError('ASSET_STORAGE_ERROR', 500, 'Asset storage key escaped its directory')
    }
    return resolved
  }

  async createAssetBinary(assetId: string, data: Uint8Array): Promise<CreatedDurableFile> {
    await this.ensureDirectory()
    return writeCreateOnlyDurableFile(this.pathForAssetId(assetId), data, { mode: 0o600 })
  }

  async removeCreatedFile(owned: CreatedDurableFile): Promise<void> {
    await removeCreatedDurableFile(owned)
  }

  /** Read a regular asset file and reject a replacement observed mid-read. */
  async readAssetBinary(assetId: string): Promise<Buffer> {
    await this.ensureDirectory()
    const filePath = this.pathForAssetId(assetId)
    const before = await fs.lstat(filePath, { bigint: true })
    if (before.isSymbolicLink() || !before.isFile()) {
      throw new AssetError('ASSET_BINARY_UNREADABLE', 500, `Asset binary is not a regular file: ${assetId}`)
    }
    const data = await fs.readFile(filePath)
    const after = await fs.lstat(filePath, { bigint: true })
    if (after.isSymbolicLink() || !after.isFile() || !sameIdentity(before, after)) {
      throw new AssetError('ASSET_BINARY_UNREADABLE', 500, `Asset binary changed while reading: ${assetId}`)
    }
    return data
  }

  /**
   * Delete a binary only after the existing durable ownership proof has been
   * captured.  Missing bytes are already physically absent and are treated as
   * an idempotent cleanup success.
   */
  async removeAssetBinary(storageKey: string): Promise<boolean> {
    await this.ensureDirectory()
    const filePath = this.pathForAssetId(storageKey)
    const owned = await captureDurableFile(filePath)
    if (!owned) return false
    await removeCreatedDurableFile(owned)
    return true
  }

  async hashAssetBinary(assetId: string): Promise<{ byteSize: number; sha256: string }> {
    const data = await this.readAssetBinary(assetId)
    return {
      byteSize: data.byteLength,
      sha256: createHash('sha256').update(data).digest('hex'),
    }
  }

  static isMissing(error: unknown): boolean {
    return isNotFound(error)
  }
}

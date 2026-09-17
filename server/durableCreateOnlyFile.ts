import { constants, promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'

export interface CreatedDurableFile {
  path: string
  parentPath: string
  fileIdentity: { dev: string; ino: string }
  parentIdentity: { dev: string; ino: string }
  contentHash?: string
}

export type DurableArtifactTestHooks = {
  beforeDurableArtifactUnlink?: (artifactPath: string) => void | Promise<void>
}

let durableArtifactTestHooks: DurableArtifactTestHooks | null = null

export function __setDurableArtifactTestHooksForTesting(
  hooks: DurableArtifactTestHooks | null,
): void {
  durableArtifactTestHooks = hooks
}

async function captureDirectoryIdentity(directoryPath: string): Promise<{ dev: string; ino: string }> {
  const stat = await fs.lstat(directoryPath, { bigint: true })
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`durable file parent is not a directory: ${directoryPath}`)
  return { dev: stat.dev.toString(), ino: stat.ino.toString() }
}

async function captureFileIdentity(filePath: string): Promise<{ dev: string; ino: string }> {
  const stat = await fs.lstat(filePath, { bigint: true })
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`durable file is not a regular file: ${filePath}`)
  return { dev: stat.dev.toString(), ino: stat.ino.toString() }
}

async function verifyCreatedDurableFile(owned: CreatedDurableFile): Promise<void> {
  const [file, parent] = await Promise.all([
    captureFileIdentity(owned.path),
    captureDirectoryIdentity(owned.parentPath),
  ])
  if (file.dev !== owned.fileIdentity.dev || file.ino !== owned.fileIdentity.ino
    || parent.dev !== owned.parentIdentity.dev || parent.ino !== owned.parentIdentity.ino) {
    throw new Error(`durable file ownership changed: ${owned.path}`)
  }
  if (owned.contentHash !== undefined) {
    const raw = await fs.readFile(owned.path)
    const observed = createHash('sha256').update(raw).digest('hex')
    if (observed !== owned.contentHash) throw new Error(`durable file content changed: ${owned.path}`)
  }
}

export async function removeCreatedDurableFile(owned: CreatedDurableFile): Promise<void> {
  await verifyCreatedDurableFile(owned)
  await durableArtifactTestHooks?.beforeDurableArtifactUnlink?.(owned.path)
  // The hook models an external writer between the first proof and unlink.
  // A second proof prevents the deterministic race from deleting its
  // replacement; the remaining portable check/use window is documented.
  await verifyCreatedDurableFile(owned)
  await fs.unlink(owned.path)
  await syncParentDirectoryBestEffort(owned.path)
}

/** Capture a recovery-discovered artifact. A missing path is not an error;
 * any other inability to prove the current generation is fail-closed. */
export async function captureDurableFile(
  filePath: string,
): Promise<CreatedDurableFile | null> {
  const parentPath = path.dirname(filePath)
  let parentIdentity: { dev: string; ino: string }
  try {
    parentIdentity = await captureDirectoryIdentity(parentPath)
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  try {
    const fileIdentity = await captureFileIdentity(filePath)
    const raw = await fs.readFile(filePath)
    const owned: CreatedDurableFile = {
      path: filePath,
      parentPath,
      fileIdentity,
      parentIdentity,
      contentHash: createHash('sha256').update(raw).digest('hex'),
    }
    await verifyCreatedDurableFile(owned)
    return owned
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function syncParentDirectoryBestEffort(filePath: string): Promise<void> {
  let directory: Awaited<ReturnType<typeof fs.open>> | null = null
  try {
    directory = await fs.open(path.dirname(filePath), 'r')
    await directory.sync()
  } catch {
    // Directory fsync is not supported uniformly (notably on Windows).
  } finally {
    await directory?.close().catch(() => {})
  }
}

/**
 * Durably create one file without ever replacing or removing an incumbent.
 *
 * Cleanup is deliberately conditional on a successful O_EXCL open.  In
 * particular, EEXIST means this call never owned the directory entry and
 * therefore must leave both its bytes and inode untouched.
 */
export async function writeCreateOnlyDurableFile(
  filePath: string,
  data: string | Buffer | Uint8Array,
  options: { mode?: number; encoding?: BufferEncoding } = {},
): Promise<CreatedDurableFile> {
  const parentPath = path.dirname(filePath)
  const parentIdentity = await captureDirectoryIdentity(parentPath)
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null
  let createdByThisCall = false
  let owned: CreatedDurableFile | null = null
  try {
    handle = await fs.open(
      filePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      options.mode,
    )
    createdByThisCall = true
    const stat = await handle.stat({ bigint: true })
    if (!stat.isFile()) throw new Error(`durable file is not regular: ${filePath}`)
    owned = {
      path: filePath,
      parentPath,
      fileIdentity: { dev: stat.dev.toString(), ino: stat.ino.toString() },
      parentIdentity,
    }
    await verifyCreatedDurableFile(owned)
    if (typeof data === 'string') {
      await handle.writeFile(data, options.encoding ?? 'utf8')
    } else {
      await handle.writeFile(data)
    }
    await handle.sync()
    owned.contentHash = createHash('sha256')
      .update(typeof data === 'string' ? Buffer.from(data, options.encoding ?? 'utf8') : data)
      .digest('hex')
    await handle.close()
    handle = null
    if (!owned) throw new Error(`durable file ownership was not established: ${filePath}`)
    await verifyCreatedDurableFile(owned)
    await syncParentDirectoryBestEffort(filePath)
    return owned
  } catch (error) {
    await handle?.close().catch(() => {})
    if (createdByThisCall && owned) {
      await removeCreatedDurableFile(owned).catch(() => {})
    }
    throw error
  }
}

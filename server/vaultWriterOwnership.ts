import { randomUUID } from 'node:crypto'
import { constants, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { syncParentDirectoryBestEffort } from './atomicTextWrite.js'
import { NUVYN_VAULT_DIRECTORY } from './technicalNamespace.js'

const OWNERSHIP_VERSION = 1
const OPERATIONAL_DIRECTORY = NUVYN_VAULT_DIRECTORY
const OWNER_FILE = 'vault-writer.json'
const TAKEOVER_DIRECTORY = 'vault-writer.takeover'

export type VaultWriterRecord = {
  version: 1
  nonce: string
  host: string
  pid: number
  startedAt: string
}

export class VaultWriterOwnershipError extends Error {
  readonly code = 'HISTORY_VAULT_WRITER_ACTIVE'

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'VaultWriterOwnershipError'
  }
}

export type VaultWriterOwnership = {
  readonly vaultRoot: string
  readonly record: VaultWriterRecord
  release(): Promise<boolean>
}

type VaultWriterOwnershipTestHooks = {
  afterTakeoverGuard?: (context: {
    guard: string
    ownerPath: string
  }) => void | Promise<void>
  beforeReplacementWrite?: (context: {
    guard: string
    ownerPath: string
  }) => void | Promise<void>
}

let ownershipTestHooks: VaultWriterOwnershipTestHooks | null = null

export function __setVaultWriterOwnershipHooksForTesting(
  hooks: VaultWriterOwnershipTestHooks | null,
): void {
  ownershipTestHooks = hooks
}

function isCompleteRecord(value: unknown): value is VaultWriterRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<VaultWriterRecord>
  return record.version === OWNERSHIP_VERSION
    && typeof record.nonce === 'string'
    && /^[0-9a-f-]{36}$/.test(record.nonce)
    && typeof record.host === 'string'
    && record.host.length > 0
    && typeof record.pid === 'number'
    && Number.isSafeInteger(record.pid)
    && record.pid > 0
    && typeof record.startedAt === 'string'
    && !Number.isNaN(Date.parse(record.startedAt))
}

async function readRecord(ownerPath: string): Promise<VaultWriterRecord> {
  let raw: string
  try {
    raw = await fs.readFile(ownerPath, 'utf8')
  } catch (error) {
    throw new VaultWriterOwnershipError(
      `Vault writer ownership at ${ownerPath} could not be read; refusing startup`,
      { cause: error },
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new VaultWriterOwnershipError(
      `Vault writer ownership at ${ownerPath} is malformed; refusing startup`,
      { cause: error },
    )
  }
  if (!isCompleteRecord(parsed)) {
    throw new VaultWriterOwnershipError(
      `Vault writer ownership at ${ownerPath} is incomplete or unsupported; refusing startup`,
    )
  }
  return parsed
}

async function writeRecordExclusive(
  ownerPath: string,
  record: VaultWriterRecord,
): Promise<void> {
  const handle = await fs.open(
    ownerPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  )
  try {
    await handle.writeFile(JSON.stringify(record), 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await syncParentDirectoryBestEffort(ownerPath)
}

function pidIsPositivelyDead(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

async function ensureOperationalDirectory(vaultRoot: string): Promise<string> {
  const operational = path.join(vaultRoot, OPERATIONAL_DIRECTORY)
  try {
    await fs.mkdir(operational)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const stat = await fs.lstat(operational)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new VaultWriterOwnershipError(
      `Vault writer operational path ${operational} is not a real directory; refusing startup`,
    )
  }
  return operational
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function assertNoExistingTakeoverGuard(operational: string): Promise<void> {
  const guard = path.join(operational, TAKEOVER_DIRECTORY)
  if (await pathExists(guard)) {
    throw new VaultWriterOwnershipError(
      `Vault writer stale-owner takeover is already present at ${guard}; refusing startup. `
      + 'Inspect and remove it only after proving no Nuvyn process is using this Vault.',
    )
  }
}

async function acquireTakeoverGuard(operational: string): Promise<string> {
  const guard = path.join(operational, TAKEOVER_DIRECTORY)
  try {
    await fs.mkdir(guard)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new VaultWriterOwnershipError(
        `Vault writer stale-owner takeover is already present at ${guard}; refusing startup. `
        + 'Inspect and remove it only after proving no Nuvyn process is using this Vault.',
      )
    }
    throw error
  }
  await syncParentDirectoryBestEffort(guard)
  try {
    await fs.writeFile(path.join(guard, 'record.json'), JSON.stringify({
      version: OWNERSHIP_VERSION,
      nonce: randomUUID(),
      host: os.hostname(),
      pid: process.pid,
      startedAt: new Date().toISOString(),
    }), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await syncParentDirectoryBestEffort(path.join(guard, 'record.json'))
    return guard
  } catch (error) {
    // A partial takeover guard is intentionally authoritative. Do not guess
    // whether another process or a crash created it.
    throw new VaultWriterOwnershipError(
      `Vault writer takeover guard ${guard} could not be completed; refusing startup`,
      { cause: error },
    )
  }
}

async function releaseTakeoverGuard(guard: string): Promise<void> {
  await fs.rm(path.join(guard, 'record.json'), { force: true })
  await fs.rmdir(guard)
  await syncParentDirectoryBestEffort(guard)
}

function assertStaleOwner(incumbent: VaultWriterRecord, currentHost: string): void {
  if (incumbent.host !== currentHost) {
    throw new VaultWriterOwnershipError(
      `Vault writer is owned by host ${incumbent.host} (pid ${incumbent.pid}); refusing startup on ${currentHost}`,
    )
  }
  if (!pidIsPositivelyDead(incumbent.pid)) {
    throw new VaultWriterOwnershipError(
      `Vault writer is active on ${incumbent.host} with pid ${incumbent.pid}; refusing startup`,
    )
  }
}

function assertSameNonce(
  expected: VaultWriterRecord,
  actual: VaultWriterRecord,
  context: 'stale-owner takeover',
): void {
  if (actual.nonce !== expected.nonce) {
    throw new VaultWriterOwnershipError(
      `Vault writer ownership changed during ${context}; refusing startup`,
    )
  }
}

function takeoverContext(
  guard: string,
  ownerPath: string,
): {
  guard: string
  ownerPath: string
} {
  return { guard, ownerPath }
}

async function notifyAfterTakeoverGuard(context: {
  guard: string
  ownerPath: string
}): Promise<void> {
  await ownershipTestHooks?.afterTakeoverGuard?.(context)
}

async function notifyBeforeReplacementWrite(context: {
  guard: string
  ownerPath: string
}): Promise<void> {
  await ownershipTestHooks?.beforeReplacementWrite?.(context)
}

export async function acquireVaultWriterOwnership(
  requestedVaultRoot: string,
): Promise<VaultWriterOwnership> {
  await fs.mkdir(path.resolve(requestedVaultRoot), { recursive: true })
  const vaultRoot = await fs.realpath(path.resolve(requestedVaultRoot))
  const operational = await ensureOperationalDirectory(vaultRoot)
  const ownerPath = path.join(operational, OWNER_FILE)
  await assertNoExistingTakeoverGuard(operational)
  const record: VaultWriterRecord = {
    version: OWNERSHIP_VERSION,
    nonce: randomUUID(),
    host: os.hostname(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
  }

  try {
    await writeRecordExclusive(ownerPath, record)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const incumbent = await readRecord(ownerPath)
    assertStaleOwner(incumbent, record.host)

    // A fixed, exclusive guard serializes stale-owner takeover contenders.
    // The guard itself is never auto-recovered: if a hard crash strands it,
    // startup fails closed instead of recreating an unlink/create race.
    const guard = await acquireTakeoverGuard(operational)
    let acquired = false
    let ownerRemoved = false
    try {
      await notifyAfterTakeoverGuard(takeoverContext(guard, ownerPath))
      const rechecked = await readRecord(ownerPath)
      assertSameNonce(incumbent, rechecked, 'stale-owner takeover')
      assertStaleOwner(rechecked, record.host)
      await fs.unlink(ownerPath)
      ownerRemoved = true
      await syncParentDirectoryBestEffort(ownerPath)
      await notifyBeforeReplacementWrite(takeoverContext(guard, ownerPath))
      await writeRecordExclusive(ownerPath, record)
      acquired = true
    } finally {
      // If replacement creation failed after unlinking the stale record, the
      // guard must remain authoritative. Removing it would reopen the exact
      // unlink/create gap this guard exists to close.
      if (acquired || !ownerRemoved) {
        await releaseTakeoverGuard(guard).catch(() => {})
      }
    }
    if (!acquired) {
      throw new VaultWriterOwnershipError('Vault writer stale-owner takeover failed closed')
    }
  }

  let released = false
  return {
    vaultRoot,
    record,
    async release(): Promise<boolean> {
      if (released) return true
      let current: VaultWriterRecord
      try {
        current = await readRecord(ownerPath)
      } catch {
        return false
      }
      if (current.nonce !== record.nonce) return false
      try {
        await fs.unlink(ownerPath)
        await syncParentDirectoryBestEffort(ownerPath)
        released = true
        return true
      } catch {
        return false
      }
    },
  }
}

export function installVaultWriterShutdownHandlers(
  ownership: VaultWriterOwnership,
  stopServing: () => Promise<void> = async () => {},
): () => void {
  let stopping = false
  const shutdown = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    try {
      await stopServing()
      await ownership.release()
      process.exit(0)
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`[nuvyn] Vault writer graceful shutdown failed: ${(error as Error).message}`)
      process.exit(1)
    }
  }
  const onSigint = (): void => { void shutdown() }
  const onSigterm = (): void => { void shutdown() }
  process.once('SIGINT', onSigint)
  process.once('SIGTERM', onSigterm)
  return () => {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
  }
}

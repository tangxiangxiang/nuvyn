import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  __setVaultMutationHooksForTesting,
  pendingVaultMutationsForTesting,
  VaultMutationOrderError,
  withVaultMutation,
} from '../vaultMutation.js'
import {
  acquireVaultWriterOwnership,
  __setVaultWriterOwnershipHooksForTesting,
  VaultWriterOwnershipError,
} from '../vaultWriterOwnership.js'
import type { VaultWriterRecord } from '../vaultWriterOwnership.js'
import { NUVYN_VAULT_DIRECTORY } from '../technicalNamespace.js'
import { isValidHistoryPath } from '../history/validation.js'
import { isValidPathSyntax } from '../paths.js'

let vault: string

beforeEach(async () => {
  vault = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-vault-mutation-'))
})

afterEach(async () => {
  __setVaultWriterOwnershipHooksForTesting(null)
  __setVaultMutationHooksForTesting(null)
  await fs.rm(vault, { recursive: true, force: true })
})

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'])
  const pid = child.pid!
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', () => resolve())
  })
  return pid
}

function completeRecord(overrides: Partial<VaultWriterRecord> = {}): VaultWriterRecord {
  return {
    version: 1,
    nonce: randomUUID(),
    host: os.hostname(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
    ...overrides,
  }
}

async function writeOwnerRecord(
  ownerPath: string,
  record: VaultWriterRecord,
): Promise<void> {
  await fs.mkdir(path.dirname(ownerPath), { recursive: true })
  await fs.writeFile(ownerPath, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 })
}

describe('withVaultMutation lock order and release', () => {
  it('rejects recursive acquisition instead of deterministically deadlocking', async () => {
    await expect(withVaultMutation(vault, () => withVaultMutation(vault, async () => {})))
      .rejects.toBeInstanceOf(VaultMutationOrderError)
    expect(await pendingVaultMutationsForTesting(vault)).toBe(0)
  })

  it('releases the Vault after success and failure', async () => {
    await withVaultMutation(vault, async () => {})
    expect(await pendingVaultMutationsForTesting(vault)).toBe(0)

    await expect(withVaultMutation(vault, async () => {
      throw new Error('injected mutation failure')
    })).rejects.toThrow('injected mutation failure')
    expect(await pendingVaultMutationsForTesting(vault)).toBe(0)

    await expect(withVaultMutation(vault, async () => 'available'))
      .resolves.toBe('available')
  })
})

describe('Vault writer ownership', () => {
  const ownerPath = () => path.join(vault, NUVYN_VAULT_DIRECTORY, 'vault-writer.json')

  it('allows only one live owner and never removes the incumbent', async () => {
    const first = await acquireVaultWriterOwnership(vault)
    const incumbent = JSON.parse(await fs.readFile(ownerPath(), 'utf8')) as { nonce: string }

    await expect(acquireVaultWriterOwnership(vault)).rejects.toMatchObject({
      name: 'VaultWriterOwnershipError',
      code: 'HISTORY_VAULT_WRITER_ACTIVE',
    })
    expect(JSON.parse(await fs.readFile(ownerPath(), 'utf8'))).toMatchObject({
      nonce: incumbent.nonce,
    })
    expect(await first.release()).toBe(true)
    await expect(fs.stat(ownerPath())).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('safely takes over a complete same-host record whose PID is positively dead', async () => {
    const deadPid = await exitedPid()
    const staleNonce = randomUUID()
    await writeOwnerRecord(ownerPath(), completeRecord({ nonce: staleNonce, pid: deadPid }))

    const ownership = await acquireVaultWriterOwnership(vault)

    expect(ownership.record.nonce).not.toBe(staleNonce)
    expect(JSON.parse(await fs.readFile(ownerPath(), 'utf8'))).toMatchObject({
      nonce: ownership.record.nonce,
      pid: process.pid,
    })
    expect(await ownership.release()).toBe(true)
  })

  it('fails closed for malformed and cross-host ownership records', async () => {
    await fs.mkdir(path.dirname(ownerPath()), { recursive: true })
    await fs.writeFile(ownerPath(), '{partial', 'utf8')
    await expect(acquireVaultWriterOwnership(vault))
      .rejects.toBeInstanceOf(VaultWriterOwnershipError)
    expect(await fs.readFile(ownerPath(), 'utf8')).toBe('{partial')

    await writeOwnerRecord(ownerPath(), completeRecord({
      host: `${os.hostname()}-other`,
      pid: 999_999,
    }))
    await expect(acquireVaultWriterOwnership(vault))
      .rejects.toThrow(/owned by host/i)
    expect(JSON.parse(await fs.readFile(ownerPath(), 'utf8'))).toMatchObject({
      host: `${os.hostname()}-other`,
    })
  })

  it('release refuses a nonce mismatch and never deletes the replacement record', async () => {
    const ownership = await acquireVaultWriterOwnership(vault)
    const replacementNonce = randomUUID()
    await fs.writeFile(ownerPath(), JSON.stringify({
      ...ownership.record,
      nonce: replacementNonce,
    }), 'utf8')

    expect(await ownership.release()).toBe(false)
    expect(JSON.parse(await fs.readFile(ownerPath(), 'utf8'))).toMatchObject({
      nonce: replacementNonce,
    })
  })

  it('does not treat elapsed time as proof that a live owner is stale', async () => {
    const liveNonce = randomUUID()
    await writeOwnerRecord(ownerPath(), completeRecord({
      nonce: liveNonce,
      startedAt: '2000-01-01T00:00:00.000Z',
    }))

    await expect(acquireVaultWriterOwnership(vault)).rejects.toThrow(/active/i)
    expect(JSON.parse(await fs.readFile(ownerPath(), 'utf8'))).toMatchObject({
      nonce: liveNonce,
    })
  })

  it('fails closed on an indeterminate stale-takeover guard', async () => {
    const deadPid = await exitedPid()
    await fs.mkdir(path.join(vault, NUVYN_VAULT_DIRECTORY, 'vault-writer.takeover'), {
      recursive: true,
    })
    await writeOwnerRecord(ownerPath(), completeRecord({ pid: deadPid }))
    await expect(acquireVaultWriterOwnership(vault))
      .rejects.toThrow(/takeover is already present/i)
    await expect(fs.stat(path.join(vault, NUVYN_VAULT_DIRECTORY, 'vault-writer.takeover')))
      .resolves.toBeDefined()
  })

  it('rejects when the owner nonce changes during stale-owner takeover', async () => {
    await writeOwnerRecord(ownerPath(), completeRecord({ pid: await exitedPid() }))
    __setVaultWriterOwnershipHooksForTesting({
      afterTakeoverGuard: async ({ ownerPath: changedPath }) => {
        const current = JSON.parse(await fs.readFile(changedPath, 'utf8')) as VaultWriterRecord
        await fs.writeFile(changedPath, JSON.stringify({ ...current, nonce: randomUUID() }), 'utf8')
      },
    })

    await expect(acquireVaultWriterOwnership(vault))
      .rejects.toThrow(/ownership changed during stale-owner takeover/i)
    await expect(fs.stat(ownerPath())).resolves.toBeDefined()
    await expect(fs.stat(path.join(vault, NUVYN_VAULT_DIRECTORY, 'vault-writer.takeover')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('allows at most one concurrent stale-owner takeover', async () => {
    await writeOwnerRecord(ownerPath(), completeRecord({ pid: await exitedPid() }))

    const results = await Promise.allSettled([
      acquireVaultWriterOwnership(vault),
      acquireVaultWriterOwnership(vault),
    ])
    const successes = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireVaultWriterOwnership>>> => result.status === 'fulfilled')
    expect(successes).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(JSON.parse(await fs.readFile(ownerPath(), 'utf8'))).toMatchObject({
      nonce: successes[0]!.value.record.nonce,
      pid: process.pid,
    })
    await successes[0]!.value.release()
  })

  it('keeps the takeover guard after replacement failure', async () => {
    await writeOwnerRecord(ownerPath(), completeRecord({ pid: await exitedPid() }))
    __setVaultWriterOwnershipHooksForTesting({
      beforeReplacementWrite: () => {
        throw new Error('injected replacement failure')
      },
    })

    await expect(acquireVaultWriterOwnership(vault))
      .rejects.toThrow('injected replacement failure')
    __setVaultWriterOwnershipHooksForTesting(null)
    await expect(fs.stat(ownerPath())).rejects.toMatchObject({ code: 'ENOENT' })
    const guardPath = path.join(vault, NUVYN_VAULT_DIRECTORY, 'vault-writer.takeover')
    await expect(fs.stat(guardPath)).resolves.toBeDefined()
    await expect(acquireVaultWriterOwnership(vault))
      .rejects.toThrow(/takeover is already present/i)
  })

  it('stores ownership under a path reserved from Vault and History content', () => {
    expect(isValidPathSyntax(NUVYN_VAULT_DIRECTORY)).toBe(false)
    expect(isValidHistoryPath(`${NUVYN_VAULT_DIRECTORY}/vault-writer.json`)).toBe(false)
  })
})

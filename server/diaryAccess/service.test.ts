import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { applyMigrations } from '../db.js'
import { KdfGuard } from '../auth/kdfGuard.js'
import { SCRYPT_KEY_BYTES } from '../auth/password.js'
import { unwrapDiaryDek, wrapDiaryDek } from './crypto.js'
import {
  DIARY_ACCESS_CAPABILITY_HEADER,
  DiaryAccessService,
  readDiaryAccessCapability,
  type DiaryAccessServiceOptions,
  type DiaryBodyOperation,
} from './service.js'

const PASSWORD = 'diary-access-test-password'
const VAULT_ID = 'test-vault-01'

function makeService(
  db: Database.Database,
  now = 1_700_000_000_000,
  vaultId = VAULT_ID,
  resolveAuthSession: (sessionId: number) => { valid: boolean; expiresAt?: number } = () => ({
    valid: true,
    expiresAt: now + 60_000,
  }),
  options: Pick<DiaryAccessServiceOptions, 'unwrapDek'> = {},
): DiaryAccessService {
  return new DiaryAccessService({
    db,
    kdfGuard: new KdfGuard({ concurrency: 1, maxQueue: 2, maxQueueWaitMs: 10_000 }),
    now: () => now,
    getVaultId: () => vaultId,
    resolveAuthSession,
    ...options,
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

describe('D8.1 Diary access foundation', () => {
  it('accepts the canonical capability header', () => {
    const capability = 'test-capability'
    expect(readDiaryAccessCapability(new Headers({ [DIARY_ACCESS_CAPABILITY_HEADER]: capability }))).toBe(capability)
    expect(readDiaryAccessCapability(new Headers())).toBeUndefined()
  })

  it('starts uninitialized, stores only wrapped key material, and unlocks with an in-memory capability', async () => {
    const db = new Database(':memory:')
    applyMigrations(db)
    const service = makeService(db)

    expect(service.status(7)).toEqual({ state: 'UNINITIALIZED' })
    const setup = await service.setup(7, PASSWORD)
    expect(setup.state).toBe('UNLOCKED')
    expect(setup.capability).not.toContain(PASSWORD)
    expect(service.status(7, setup.capability).state).toBe('UNLOCKED')
    expect(service.isCapabilityValid(7, setup.capability)).toBe(true)
    expect(service.isCapabilityValid(8, setup.capability)).toBe(false)

    const row = db.prepare('SELECT * FROM diary_access_config WHERE id = 1').get() as Record<string, unknown>
    expect(row).toBeTruthy()
    expect(row.password).toBeUndefined()
    expect(row.kek).toBeUndefined()
    expect(row.dek).toBeUndefined()
    expect(row.wrapped_dek).toBeTruthy()

    await service.lock(7)
    expect(service.status(7, setup.capability).state).toBe('LOCKED')
    db.close()
  })

  it('rejects a wrong password and loses unlocked state on a new process owner', async () => {
    const db = new Database(':memory:')
    applyMigrations(db)
    const first = makeService(db)
    await first.setup(7, PASSWORD)

    await expect(first.unlock(7, 'wrong-diary-password')).rejects.toMatchObject({
      code: 'diary-access-invalid-password',
      status: 401,
    })

    const restarted = makeService(db)
    expect(restarted.status(7).state).toBe('LOCKED')
    const unlocked = await restarted.unlock(7, PASSWORD)
    expect(restarted.status(7, unlocked.capability).state).toBe('UNLOCKED')
    db.close()
  })

  it('keeps the persisted cryptographic identity authoritative after Vault relocation', async () => {
    const db = new Database(':memory:')
    applyMigrations(db)
    const oldVaultId = '08b028093bdd'
    const relocatedVaultId = 'dfd3fdaaacda'
    const context = {
      documentId: 'relocated-diary-document',
      logicalPath: 'diary/2026-09-17',
    }
    const original = makeService(db, 1_700_000_000_000, oldVaultId)
    const setup = await original.setup(7, PASSWORD)
    let originalBody!: Buffer
    await original.withBodyOperation(7, setup.capability, (operation) => {
      originalBody = operation.encrypt('# before relocation\n', context)
    })
    await original.lock(7)

    const relocated = makeService(db, 1_700_000_000_000, relocatedVaultId)
    expect(relocated.status(7)).toEqual({ state: 'LOCKED' })
    const unlocked = await relocated.unlock(7, PASSWORD)
    expect(unlocked.state).toBe('UNLOCKED')

    const restored = await relocated.withBodyOperation(7, unlocked.capability, (operation) =>
      operation.decrypt(originalBody, context))
    expect(restored).toMatchObject({ raw: '# before relocation\n', encrypted: true })

    const writtenAfterRelocation = await relocated.withBodyOperation(7, unlocked.capability, (operation) => {
      const encrypted = operation.encrypt('# after relocation\n', context)
      return operation.decrypt(encrypted, context)
    })
    expect(writtenAfterRelocation).toMatchObject({ raw: '# after relocation\n', encrypted: true })
    expect(db.prepare('SELECT vault_id FROM diary_access_config WHERE id = 1').get()).toEqual({ vault_id: oldVaultId })
    db.close()
  })

  it('does not overwrite a concurrently initialized singleton', async () => {
    const db = new Database(':memory:')
    applyMigrations(db)
    const first = makeService(db)
    const second = makeService(db)
    const [a, b] = await Promise.allSettled([
      first.setup(7, PASSWORD),
      second.setup(8, `${PASSWORD}-other`),
    ])
    expect([a.status, b.status].filter((status) => status === 'fulfilled')).toHaveLength(1)
    expect([a.status, b.status].filter((status) => status === 'rejected')).toHaveLength(1)
    expect(db.prepare('SELECT COUNT(*) AS count FROM diary_access_config').get()).toEqual({ count: 1 })
    db.close()
  })

  it('fails closed for malformed KDF, format, and persisted vault identity', async () => {
    const db = new Database(':memory:')
    applyMigrations(db)
    const service = makeService(db)
    await service.setup(7, PASSWORD)

    db.prepare('UPDATE diary_access_config SET kdf_n = ? WHERE id = 1').run(1)
    expect(() => service.status(7)).toThrowError(expect.objectContaining({
      code: 'diary-access-unavailable',
      status: 503,
    }))

    db.prepare('UPDATE diary_access_config SET kdf_n = ?, format_version = ? WHERE id = 1')
      .run(32_768, 99)
    expect(() => service.status(7)).toThrowError(expect.objectContaining({
      code: 'diary-access-unavailable',
      status: 503,
    }))

    db.prepare('UPDATE diary_access_config SET format_version = ?, vault_id = ? WHERE id = 1')
      .run(1, '')
    expect(() => service.status(7)).toThrowError(expect.objectContaining({
      code: 'diary-access-unavailable',
      status: 503,
    }))

    db.prepare('UPDATE diary_access_config SET vault_id = ?, wrapped_dek = ? WHERE id = 1')
      .run(VAULT_ID, Buffer.alloc(1))
    expect(() => service.status(7)).toThrowError(expect.objectContaining({
      code: 'diary-access-unavailable',
      status: 503,
    }))
    db.close()
  })

  it('uses a fresh random wrapping nonce for each key-wrap operation', () => {
    const kek = randomBytes(SCRYPT_KEY_BYTES)
    const dek = randomBytes(SCRYPT_KEY_BYTES)
    const first = wrapDiaryDek(kek, dek, VAULT_ID)
    const second = wrapDiaryDek(kek, dek, VAULT_ID)
    expect(first.nonce).toHaveLength(12)
    expect(second.nonce).toHaveLength(12)
    expect(second.nonce.equals(first.nonce)).toBe(false)
    kek.fill(0)
    dek.fill(0)
  })

  it('waits for an active body lease before reporting a successful lock', async () => {
    const db = new Database(':memory:')
    applyMigrations(db)
    const service = makeService(db)
    const unlocked = await service.setup(7, PASSWORD)
    let release!: () => void
    const hold = new Promise<void>((resolve) => { release = resolve })
    const operation = service.withBodyOperation(7, unlocked.capability, async (body) => {
      body.assertCurrent()
      await hold
      body.assertCurrent()
      return 'completed'
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    let lockSettled = false
    const lock = Promise.resolve(service.lock(7)).then((result) => {
      lockSettled = true
      return result
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(lockSettled).toBe(false)
    release()
    await expect(operation).resolves.toBe('completed')
    await expect(lock).resolves.toEqual({ state: 'LOCKED' })
    expect(service.isCapabilityValid(7, unlocked.capability)).toBe(false)
    db.close()
  })

  it('waits for logout quiescence while allowing the current body response to finish', async () => {
    const db = new Database(':memory:')
    applyMigrations(db)
    const service = makeService(db)
    const unlocked = await service.setup(7, PASSWORD)
    let release!: () => void
    const hold = new Promise<void>((resolve) => { release = resolve })
    const bodyResponse = service.withBodyOperation(7, unlocked.capability, async (body) => {
      body.assertCurrent()
      await hold
      body.assertCurrent()
      return 'plaintext-conflict-or-body-response'
    })
    await new Promise<void>((resolve) => setImmediate(resolve))

    let logoutSettled = false
    const logout = service.invalidateAuthSession(7).then(() => {
      logoutSettled = true
    })
    expect(service.isCapabilityValid(7, unlocked.capability)).toBe(false)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(logoutSettled).toBe(false)

    release()
    await expect(bodyResponse).resolves.toBe('plaintext-conflict-or-body-response')
    await logout
    expect(logoutSettled).toBe(true)
    expect(service.isCapabilityValid(7, unlocked.capability)).toBe(false)
    db.close()
  })

  it('keeps capability replacement behind the same-session body lease boundary', async () => {
    const db = new Database(':memory:')
    applyMigrations(db)
    const service = makeService(db)
    const unlocked = await service.setup(7, PASSWORD)
    let release!: () => void
    const hold = new Promise<void>((resolve) => { release = resolve })
    const active = service.withBodyOperation(7, unlocked.capability, async (body) => {
      await hold
      body.assertCurrent()
      return 'completed'
    })
    await new Promise<void>((resolve) => setImmediate(resolve))

    let replacementSettled = false
    const replacement = service.unlock(7, PASSWORD).then((result) => {
      replacementSettled = true
      return result
    })
    await vi.waitFor(() => {
      expect(service.isCapabilityValid(7, unlocked.capability)).toBe(false)
    }, { timeout: 5_000 })
    expect(replacementSettled).toBe(false)

    release()
    await expect(active).resolves.toBe('completed')
    const next = await replacement
    expect(next.capability).not.toBe(unlocked.capability)
    expect(next.epoch).toBeGreaterThan(unlocked.epoch)
    expect(service.isCapabilityValid(7, next.capability)).toBe(true)
    db.close()
  })

  it('quiesces an active lease when capability expiry is observed', async () => {
    const db = new Database(':memory:')
    applyMigrations(db)
    let now = 1_700_000_000_000
    const service = new DiaryAccessService({
      db,
      kdfGuard: new KdfGuard({ concurrency: 1, maxQueue: 2, maxQueueWaitMs: 10_000 }),
      now: () => now,
      getVaultId: () => VAULT_ID,
      resolveAuthSession: () => ({ valid: true, expiresAt: now + 10_000 }),
    })
    const unlocked = await service.setup(7, PASSWORD)
    let release!: () => void
    const hold = new Promise<void>((resolve) => { release = resolve })
    const active = service.withBodyOperation(7, unlocked.capability, async (body) => {
      await hold
      body.assertCurrent()
      return 'completed-before-expiry-finalization'
    })
    await new Promise<void>((resolve) => setImmediate(resolve))

    now = 1_700_000_000_001
    expect(service.isCapabilityValid(7, unlocked.capability)).toBe(true)
    now = 1_700_000_010_000
    expect(service.isCapabilityValid(7, unlocked.capability)).toBe(false)
    release()
    await expect(active).resolves.toBe('completed-before-expiry-finalization')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(service.isCapabilityValid(7, unlocked.capability)).toBe(false)
    db.close()
  })

  it('does not allow a captured body operation to outlive its callback', async () => {
    const db = new Database(':memory:')
    applyMigrations(db)
    const service = makeService(db)
    const unlocked = await service.setup(7, PASSWORD)
    let captured!: DiaryBodyOperation
    await expect(service.withBodyOperation(7, unlocked.capability, (body) => {
      captured = body
      body.assertCurrent()
      return 'done'
    })).resolves.toBe('done')

    expect(captured.isCurrent()).toBe(false)
    expect(() => captured.assertCurrent()).toThrowError(expect.objectContaining({
      code: 'diary-access-invalid-state',
    }))
    db.close()
  })

  it('keeps session quiescence isolated between sessions', async () => {
    const db = new Database(':memory:')
    applyMigrations(db)
    const service = makeService(db)
    const first = await service.setup(7, PASSWORD)
    const second = await service.unlock(8, PASSWORD)
    let release!: () => void
    const hold = new Promise<void>((resolve) => { release = resolve })
    const active = service.withBodyOperation(7, first.capability, async (body) => {
      await hold
      body.assertCurrent()
      return 'session-a'
    })
    await new Promise<void>((resolve) => setImmediate(resolve))

    const logoutA = service.invalidateAuthSession(7)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(service.isCapabilityValid(7, first.capability)).toBe(false)
    expect(service.isCapabilityValid(8, second.capability)).toBe(true)
    const sessionB = await service.withBodyOperation(8, second.capability, () => 'session-b')
    expect(sessionB).toBe('session-b')

    release()
    await expect(active).resolves.toBe('session-a')
    await logoutA
    expect(service.isCapabilityValid(8, second.capability)).toBe(true)
    db.close()
  })

  it('fails closed when auth is invalidated during KDF and expires capabilities per session', async () => {
    const db = new Database(':memory:')
    applyMigrations(db)
    let now = 1_700_000_000_000
    const valid = new Map<number, boolean>([[7, true], [8, true]])
    const expiresAt = new Map<number, number>([[7, now + 10_000], [8, now + 20_000]])
    const service = makeService(db, now, VAULT_ID, (sessionId) => ({
      valid: valid.get(sessionId) === true,
      expiresAt: expiresAt.get(sessionId),
    }))
    const first = await service.setup(7, PASSWORD)
    const second = await service.unlock(8, PASSWORD)

    await service.lock(7)
    const pending = service.unlock(7, PASSWORD)
    valid.set(7, false)
    await expect(pending).rejects.toMatchObject({
      code: 'diary-access-auth-session-invalid',
      status: 401,
    })
    expect(service.isCapabilityValid(7, first.capability)).toBe(false)
    expect(service.isCapabilityValid(8, second.capability)).toBe(true)

    now += 20_001
    // The service clock is captured by makeService, so create a second owner
    // over the same config to prove absolute auth-session expiry cleanup.
    const expiring = new DiaryAccessService({
      db,
      kdfGuard: new KdfGuard({ concurrency: 1, maxQueue: 2, maxQueueWaitMs: 10_000 }),
      now: () => now,
      getVaultId: () => VAULT_ID,
      resolveAuthSession: (sessionId) => ({
        valid: valid.get(sessionId) === true,
        expiresAt: expiresAt.get(sessionId),
      }),
    })
    await expect(expiring.unlock(8, PASSWORD)).rejects.toMatchObject({
      code: 'diary-access-auth-session-invalid',
    })
    db.close()
  })

  it('does not publish a paused unlock after an explicit lock and zeroizes its unpublished DEK', async () => {
    const db = new Database(':memory:')
    applyMigrations(db)
    const paused = deferred<Buffer>()
    const unwrap = vi.fn<typeof unwrapDiaryDek>(() => paused.promise)
    const service = makeService(db, 1_700_000_000_000, VAULT_ID, undefined, { unwrapDek: unwrap })
    await service.setup(7, PASSWORD)
    await service.lock(7)

    const pending = service.unlock(7, PASSWORD)
    await vi.waitFor(() => expect(unwrap).toHaveBeenCalledOnce())

    const lock = service.lock(7)
    const unpublishedDek = randomBytes(SCRYPT_KEY_BYTES)
    paused.resolve(unpublishedDek)

    await expect(pending).rejects.toMatchObject({
      code: 'diary-access-issuance-invalidated',
      status: 409,
    })
    await expect(lock).resolves.toEqual({ state: 'LOCKED' })
    expect(unpublishedDek.every((byte) => byte === 0)).toBe(true)
    expect(service.status(7).state).toBe('LOCKED')
    db.close()
  })

  it('does not republish a paused unlock after auth logout invalidates its session', async () => {
    const db = new Database(':memory:')
    applyMigrations(db)
    const paused = deferred<Buffer>()
    const unwrap = vi.fn<typeof unwrapDiaryDek>(() => paused.promise)
    const service = makeService(db, 1_700_000_000_000, VAULT_ID, undefined, { unwrapDek: unwrap })
    await service.setup(7, PASSWORD)
    await service.lock(7)

    const pending = service.unlock(7, PASSWORD)
    await vi.waitFor(() => expect(unwrap).toHaveBeenCalledOnce())

    const logout = service.invalidateAuthSession(7)
    const unpublishedDek = randomBytes(SCRYPT_KEY_BYTES)
    paused.resolve(unpublishedDek)

    await expect(pending).rejects.toMatchObject({
      code: 'diary-access-issuance-invalidated',
      status: 409,
    })
    await expect(logout).resolves.toBeUndefined()
    expect(unpublishedDek.every((byte) => byte === 0)).toBe(true)
    expect(service.status(7).state).toBe('LOCKED')
    db.close()
  })

  it('does not republish a paused unlock after capability expiry invalidates its session', async () => {
    const db = new Database(':memory:')
    applyMigrations(db)
    let now = 1_700_000_000_000
    const paused = deferred<Buffer>()
    const unwrap = vi.fn<typeof unwrapDiaryDek>(() => paused.promise)
    const service = new DiaryAccessService({
      db,
      kdfGuard: new KdfGuard({ concurrency: 1, maxQueue: 2, maxQueueWaitMs: 10_000 }),
      now: () => now,
      getVaultId: () => VAULT_ID,
      resolveAuthSession: () => ({ valid: true, expiresAt: now + 60_000 }),
      unwrapDek: unwrap,
    })
    const initial = await service.setup(7, PASSWORD)
    const pending = service.unlock(7, PASSWORD)
    await vi.waitFor(() => expect(unwrap).toHaveBeenCalledOnce())

    now += 60_000
    expect(service.isCapabilityValid(7, initial.capability)).toBe(false)
    const unpublishedDek = randomBytes(SCRYPT_KEY_BYTES)
    paused.resolve(unpublishedDek)

    await expect(pending).rejects.toMatchObject({
      code: 'diary-access-issuance-invalidated',
      status: 409,
    })
    expect(unpublishedDek.every((byte) => byte === 0)).toBe(true)
    expect(service.status(7).state).toBe('LOCKED')
    db.close()
  })

  it('makes concurrent same-session unlocks deterministic: the newest issuance wins', async () => {
    const db = new Database(':memory:')
    applyMigrations(db)
    const older = deferred<Buffer>()
    const newer = deferred<Buffer>()
    const unwrap = vi.fn<typeof unwrapDiaryDek>()
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise)
    const service = makeService(db, 1_700_000_000_000, VAULT_ID, undefined, { unwrapDek: unwrap })
    const initial = await service.setup(7, PASSWORD)

    const olderUnlock = service.unlock(7, PASSWORD)
    const newerUnlock = service.unlock(7, PASSWORD)
    await vi.waitFor(() => expect(unwrap).toHaveBeenCalledTimes(2))

    const newerDek = randomBytes(SCRYPT_KEY_BYTES)
    newer.resolve(newerDek)
    const current = await newerUnlock
    expect(current.capability).not.toBe(initial.capability)
    expect(service.isCapabilityValid(7, current.capability)).toBe(true)

    const olderDek = randomBytes(SCRYPT_KEY_BYTES)
    older.resolve(olderDek)
    await expect(olderUnlock).rejects.toMatchObject({
      code: 'diary-access-issuance-invalidated',
      status: 409,
    })
    expect(olderDek.every((byte) => byte === 0)).toBe(true)
    expect(service.isCapabilityValid(7, current.capability)).toBe(true)
    db.close()
  })
})

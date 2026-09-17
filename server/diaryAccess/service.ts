import { randomBytes } from 'node:crypto'
import type { Database as DatabaseT } from 'better-sqlite3'
import { getVaultId } from '../vaultIdentity.js'
import { isValidPassword } from '../auth/password.js'
import type { KdfGuard } from '../auth/kdfGuard.js'
import type { AuthRateLimiter } from '../auth/rateLimit.js'
import {
  SCRYPT_KEY_BYTES,
  SCRYPT_MAXMEM,
  SCRYPT_N,
  SCRYPT_P,
  SCRYPT_R,
  SCRYPT_SALT_BYTES,
} from '../auth/password.js'
import {
  DIARY_ACCESS_FORMAT_VERSION,
  DIARY_ACCESS_KDF_ALGORITHM,
  DIARY_ACCESS_KDF_VERSION,
  DIARY_ACCESS_NONCE_BYTES,
  DIARY_ACCESS_TAG_BYTES,
  DIARY_ACCESS_WRAP_ALGORITHM,
  DIARY_ACCESS_WRAP_VERSION,
  DiaryAccessCryptoError,
  deriveDiaryKek,
  unwrapDiaryDek,
  wrapDiaryDek,
} from './crypto.js'
import {
  decryptDiaryBody,
  encryptDiaryBody,
  readDiaryBody,
  type BodyContext,
  type DiaryDocumentContext,
  type DiaryBodyRead,
} from './body.js'
import { NUVYN_DIARY_ACCESS_CAPABILITY_HEADER } from '../../shared/technicalNamespace.js'

export const DIARY_ACCESS_CAPABILITY_HEADER = NUVYN_DIARY_ACCESS_CAPABILITY_HEADER

export function readDiaryAccessCapability(headers: Headers): string | undefined {
  return headers.get(DIARY_ACCESS_CAPABILITY_HEADER) ?? undefined
}

export type DiaryAccessState = 'UNINITIALIZED' | 'LOCKED' | 'UNLOCKED'

export type DiaryAccessErrorCode =
  | 'diary-access-invalid-password'
  | 'diary-access-invalid-state'
  | 'diary-access-unavailable'
  | 'diary-access-invalid-input'
  | 'diary-access-rate-limited'
  | 'diary-access-auth-session-invalid'
  | 'diary-access-issuance-invalidated'

export class DiaryAccessServiceError extends Error {
  readonly code: DiaryAccessErrorCode
  readonly status: 400 | 401 | 409 | 429 | 503
  readonly retryAfterMs?: number

  constructor(
    code: DiaryAccessErrorCode,
    status: 400 | 401 | 409 | 429 | 503,
    message: string,
    retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'DiaryAccessServiceError'
    this.code = code
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

type DiaryAccessRow = {
  id: number
  format_version: number
  kdf_algorithm: string
  kdf_version: number
  kdf_n: number
  kdf_r: number
  kdf_p: number
  kdf_maxmem: number
  salt: Buffer | Uint8Array
  wrap_algorithm: string
  wrap_version: number
  wrap_nonce: Buffer | Uint8Array
  wrapped_dek: Buffer | Uint8Array
  wrap_tag: Buffer | Uint8Array
  vault_id: string
  created_at: number
  updated_at: number
}

type DiaryAccessConfig = {
  readonly salt: Buffer
  readonly nonce: Buffer
  readonly wrappedDek: Buffer
  readonly tag: Buffer
  readonly vaultId: string
}

type Capability = {
  readonly sessionId: number
  readonly vaultId: string
  readonly epoch: number
  readonly expiresAt: number
  readonly dek: Buffer
  expiryTimer?: ReturnType<typeof setTimeout>
}

type SessionQuiescence = {
  readonly drained: Promise<void>
  readonly resolveDrained: () => void
  readonly completed: Promise<void>
  readonly resolveCompleted: () => void
  finalized: boolean
}

type CapabilityIssuance = {
  readonly sessionId: number
  readonly lifecycleGeneration: number
  readonly sequence: number
}

export type DiaryBodyOperation = {
  readonly assertCurrent: () => void
  readonly isCurrent: () => boolean
  readonly encrypt: (raw: string, context: DiaryDocumentContext) => Buffer
  readonly decrypt: (bytes: Buffer, context: DiaryDocumentContext) => DiaryBodyRead
  readonly read: (absolutePath: string, context: DiaryDocumentContext) => Promise<DiaryBodyRead & { readonly stat: Awaited<ReturnType<typeof import('node:fs/promises').stat>> }>
}

const MAX_CAPABILITY_EXPIRY_TIMER_MS = 2_147_000_000

export type DiaryAccessAuthSession = {
  readonly valid: boolean
  readonly expiresAt?: number
}

function asBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return Buffer.from(value)
  if (value instanceof Uint8Array) return Buffer.from(value)
  return null
}

function isFiniteInteger(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}

function isPersistedVaultId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
}

/**
 * `vault_id` is the Diary cryptographic identity persisted with the wrapped
 * DEK. It is authoritative after setup and must not be recomputed from the
 * current Vault filesystem location.
 */
function configFromRow(row: DiaryAccessRow | undefined): DiaryAccessConfig | null {
  if (!row) return null
  const salt = asBuffer(row.salt)
  const nonce = asBuffer(row.wrap_nonce)
  const wrappedDek = asBuffer(row.wrapped_dek)
  const tag = asBuffer(row.wrap_tag)
  if (
    row.id !== 1
    || row.format_version !== DIARY_ACCESS_FORMAT_VERSION
    || row.kdf_algorithm !== DIARY_ACCESS_KDF_ALGORITHM
    || row.kdf_version !== DIARY_ACCESS_KDF_VERSION
    || row.kdf_n !== SCRYPT_N
    || row.kdf_r !== SCRYPT_R
    || row.kdf_p !== SCRYPT_P
    || row.kdf_maxmem !== SCRYPT_MAXMEM
    || row.wrap_algorithm !== DIARY_ACCESS_WRAP_ALGORITHM
    || row.wrap_version !== DIARY_ACCESS_WRAP_VERSION
    || !salt || salt.length !== SCRYPT_SALT_BYTES
    || !nonce || nonce.length !== DIARY_ACCESS_NONCE_BYTES
    || !wrappedDek || wrappedDek.length !== SCRYPT_KEY_BYTES
    || !tag || tag.length !== DIARY_ACCESS_TAG_BYTES
    || !isPersistedVaultId(row.vault_id)
    || !isFiniteInteger(row.created_at)
    || !isFiniteInteger(row.updated_at)
  ) return null
  return { salt, nonce, wrappedDek, tag, vaultId: row.vault_id }
}

function capabilityToken(): string {
  return randomBytes(32).toString('base64url')
}

export type DiaryAccessServiceOptions = {
  readonly db: DatabaseT
  readonly kdfGuard: KdfGuard
  readonly now?: () => number
  readonly getVaultId?: () => string
  readonly resolveAuthSession?: (sessionId: number) => DiaryAccessAuthSession
  readonly unlockLimiter?: AuthRateLimiter
  /** Test seam for deterministic issuance-race barriers. Production uses the
   *  real unwrap implementation and never supplies this override. */
  readonly unwrapDek?: typeof unwrapDiaryDek
}

export class DiaryAccessService {
  readonly db: DatabaseT
  readonly kdfGuard: KdfGuard
  readonly now: () => number
  readonly getVaultId: () => string
  readonly resolveAuthSession: (sessionId: number) => DiaryAccessAuthSession
  readonly unlockLimiter?: AuthRateLimiter
  readonly unwrapDek: typeof unwrapDiaryDek
  private readonly sessionEpochs = new Map<number, number>()
  private readonly capabilities = new Map<string, Capability>()
  private readonly activeBodyOperations = new Map<number, number>()
  private readonly sessionQuiescences = new Map<number, SessionQuiescence>()
  private readonly sessionLifecycleGenerations = new Map<number, number>()
  private readonly sessionIssuanceSequences = new Map<number, number>()
  private readonly sessionIssuanceTails = new Map<number, Promise<void>>()

  constructor(options: DiaryAccessServiceOptions) {
    this.db = options.db
    this.kdfGuard = options.kdfGuard
    this.now = options.now ?? Date.now
    this.getVaultId = options.getVaultId ?? getVaultId
    this.resolveAuthSession = options.resolveAuthSession ?? (() => ({ valid: true, expiresAt: Number.MAX_SAFE_INTEGER }))
    this.unlockLimiter = options.unlockLimiter
    this.unwrapDek = options.unwrapDek ?? unwrapDiaryDek
  }

  private loadConfig(): DiaryAccessConfig | null {
    const row = this.db.prepare('SELECT * FROM diary_access_config WHERE id = 1 LIMIT 1').get() as DiaryAccessRow | undefined
    if (!row) return null
    const config = configFromRow(row)
    if (!config) throw new DiaryAccessServiceError(
      'diary-access-unavailable',
      503,
      'Diary access configuration is unavailable.',
    )
    return config
  }

  private dropCapability(token: string): void {
    const capability = this.capabilities.get(token)
    if (capability) {
      if (capability.expiryTimer !== undefined) clearTimeout(capability.expiryTimer)
      capability.dek.fill(0)
    }
    this.capabilities.delete(token)
  }

  private scheduleCapabilityExpiry(token: string): void {
    const capability = this.capabilities.get(token)
    if (!capability) return
    const remaining = capability.expiresAt - this.now()
    if (remaining <= 0) {
      this.dropCapability(token)
      return
    }
    capability.expiryTimer = setTimeout(() => {
      const current = this.capabilities.get(token)
      if (!current) return
      current.expiryTimer = undefined
      if (current.expiresAt > this.now()) {
        this.scheduleCapabilityExpiry(token)
        return
      }
      // Expiry follows the same quiescing boundary as explicit lock/logout.
      // New leases are rejected immediately; an already leased operation is
      // allowed to reach its defined callback boundary before the DEK drops.
      void this.invalidateAuthSession(current.sessionId)
    }, Math.min(remaining, MAX_CAPABILITY_EXPIRY_TIMER_MS))
    capability.expiryTimer.unref?.()
  }

  private dropSessionCapabilities(sessionId: number): void {
    for (const [token, capability] of this.capabilities) {
      if (capability.sessionId === sessionId) this.dropCapability(token)
    }
  }

  private dropAllCapabilities(): void {
    for (const token of this.capabilities.keys()) this.dropCapability(token)
  }

  private lifecycleGeneration(sessionId: number): number {
    return this.sessionLifecycleGenerations.get(sessionId) ?? 0
  }

  private bumpLifecycleGeneration(sessionId: number): number {
    const next = this.lifecycleGeneration(sessionId) + 1
    this.sessionLifecycleGenerations.set(sessionId, next)
    return next
  }

  /**
   * Reserve an issuance before the asynchronous KDF starts. The lifecycle
   * generation fences lock/logout/expiry, while the sequence gives
   * same-session concurrent unlocks a deterministic newest-issuance-wins
   * policy. A ticket that loses either boundary can never publish a DEK.
   */
  private beginCapabilityIssuance(sessionId: number): CapabilityIssuance {
    this.requireCurrentAuthSession(sessionId)
    if (this.sessionQuiescences.has(sessionId)) {
      throw new DiaryAccessServiceError(
        'diary-access-issuance-invalidated',
        409,
        'Diary access issuance was invalidated.',
      )
    }
    const sequence = (this.sessionIssuanceSequences.get(sessionId) ?? 0) + 1
    this.sessionIssuanceSequences.set(sessionId, sequence)
    return {
      sessionId,
      lifecycleGeneration: this.lifecycleGeneration(sessionId),
      sequence,
    }
  }

  private assertCapabilityIssuanceCurrent(
    issuance: CapabilityIssuance,
    lifecycleGeneration = issuance.lifecycleGeneration,
  ): void {
    if (
      this.sessionQuiescences.has(issuance.sessionId)
      || this.lifecycleGeneration(issuance.sessionId) !== lifecycleGeneration
      || this.sessionIssuanceSequences.get(issuance.sessionId) !== issuance.sequence
    ) {
      throw new DiaryAccessServiceError(
        'diary-access-issuance-invalidated',
        409,
        'Diary access issuance was invalidated.',
      )
    }
    this.requireCurrentAuthSession(issuance.sessionId)
  }

  /** Serialize capability publication/replacement for one auth session. */
  private async withIssuanceLock<T>(sessionId: number, callback: () => Promise<T>): Promise<T> {
    const previous = this.sessionIssuanceTails.get(sessionId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => current)
    this.sessionIssuanceTails.set(sessionId, tail)
    await previous
    try {
      return await callback()
    } finally {
      release()
      if (this.sessionIssuanceTails.get(sessionId) === tail) {
        this.sessionIssuanceTails.delete(sessionId)
      }
    }
  }

  private async issueCapability(
    issuance: CapabilityIssuance,
    vaultId: string,
    dek: Buffer,
  ): Promise<{ capability: string; epoch: number }> {
    return this.withIssuanceLock(issuance.sessionId, async () => {
      this.assertCapabilityIssuanceCurrent(issuance)
      const hasExistingCapability = this.hasSessionCapability(issuance.sessionId)
      let permittedGeneration = issuance.lifecycleGeneration
      if (hasExistingCapability) {
        // Repeated unlock is a capability replacement boundary. It must not
        // revoke the old DEK while an existing body operation still owns it.
        // This issuance owns this replacement generation; any independent
        // lock/logout/expiry that joins the wait advances the generation again
        // and invalidates this ticket before publication.
        const replacement = this.beginSessionInvalidation(issuance.sessionId)
        permittedGeneration = replacement.lifecycleGeneration
        await this.finishQuiescence(issuance.sessionId, replacement.quiescence)
        this.assertCapabilityIssuanceCurrent(issuance, permittedGeneration)
      }

      // Keep this authority check immediately adjacent to publication. There
      // is no async yield between the final check and the capability map write,
      // so a lock/logout/expiry transition cannot reopen this boundary.
      this.assertCapabilityIssuanceCurrent(issuance, permittedGeneration)
      const currentAuthSession = this.requireCurrentAuthSession(issuance.sessionId)
      const epoch = (this.sessionEpochs.get(issuance.sessionId) ?? 0) + 1
      this.sessionEpochs.set(issuance.sessionId, epoch)
      const capability = capabilityToken()
      this.capabilities.set(capability, {
        sessionId: issuance.sessionId,
        vaultId,
        epoch,
        expiresAt: currentAuthSession.expiresAt!,
        dek,
      })
      this.scheduleCapabilityExpiry(capability)
      return { capability, epoch }
    })
  }

  private requireCurrentAuthSession(sessionId: number): Required<DiaryAccessAuthSession> {
    const resolved = this.resolveAuthSession(sessionId)
    if (!resolved.valid || !Number.isFinite(resolved.expiresAt) || resolved.expiresAt! <= this.now()) {
      void this.invalidateAuthSession(sessionId)
      throw new DiaryAccessServiceError(
        'diary-access-auth-session-invalid',
        401,
        'Authentication session is no longer valid.',
      )
    }
    return { valid: true, expiresAt: resolved.expiresAt! }
  }

  private limiterKey(sessionId: number, vaultId: string): string {
    return `${vaultId}:${sessionId}`
  }

  private assertSessionId(sessionId: number): void {
    if (!Number.isSafeInteger(sessionId) || sessionId < 1) {
      throw new DiaryAccessServiceError('diary-access-invalid-input', 400, 'Invalid authentication session.')
    }
  }

  status(sessionId: number, presentedCapability?: string | null): { state: DiaryAccessState; epoch?: number } {
    this.assertSessionId(sessionId)
    const config = this.loadConfig()
    if (!config) return { state: 'UNINITIALIZED' }
    if (presentedCapability && this.isCapabilityValid(sessionId, presentedCapability, config)) {
      return { state: 'UNLOCKED', epoch: this.capabilities.get(presentedCapability)?.epoch }
    }
    return { state: 'LOCKED' }
  }

  isCapabilityValid(sessionId: number, presentedCapability: unknown, config?: DiaryAccessConfig | null): boolean {
    // A quiescing session rejects new leases immediately. Existing leases do
    // not call this method; their operation-local lease remains current until
    // the quiescing transition drains and drops the capability.
    if (this.sessionQuiescences.has(sessionId)) return false
    let resolvedConfig: DiaryAccessConfig | null
    try {
      resolvedConfig = config === undefined ? this.loadConfig() : config
    } catch {
      return false
    }
    if (!resolvedConfig || typeof presentedCapability !== 'string' || presentedCapability.length < 32 || presentedCapability.length > 128) return false
    const capability = this.capabilities.get(presentedCapability)
    if (capability && (
      capability.expiresAt <= this.now()
      || !this.resolveAuthSession(capability.sessionId).valid
    )) {
      void this.invalidateAuthSession(capability.sessionId)
      return false
    }
    return Boolean(
      capability
      && capability.sessionId === sessionId
      && capability.vaultId === resolvedConfig.vaultId
      && capability.epoch === this.sessionEpochs.get(sessionId)
      && capability.dek.length === SCRYPT_KEY_BYTES,
    )
  }

  private releaseBodyOperation(sessionId: number): void {
    const remaining = (this.activeBodyOperations.get(sessionId) ?? 1) - 1
    if (remaining > 0) {
      this.activeBodyOperations.set(sessionId, remaining)
      return
    }
    this.activeBodyOperations.delete(sessionId)
    const quiescence = this.sessionQuiescences.get(sessionId)
    if (quiescence) quiescence.resolveDrained()
  }

  private beginQuiescence(sessionId: number): SessionQuiescence {
    const existing = this.sessionQuiescences.get(sessionId)
    if (existing) return existing

    let resolveDrained!: () => void
    let resolveCompleted!: () => void
    const quiescence: SessionQuiescence = {
      drained: new Promise<void>((resolve) => { resolveDrained = resolve }),
      resolveDrained: () => resolveDrained(),
      completed: new Promise<void>((resolve) => { resolveCompleted = resolve }),
      resolveCompleted: () => resolveCompleted(),
      finalized: false,
    }
    this.sessionQuiescences.set(sessionId, quiescence)
    if ((this.activeBodyOperations.get(sessionId) ?? 0) === 0) quiescence.resolveDrained()
    return quiescence
  }

  private beginSessionInvalidation(sessionId: number): {
    lifecycleGeneration: number
    quiescence: SessionQuiescence
  } {
    // Advance synchronously, before the first await. Every operation that
    // started before this boundary is now barred from capability publication,
    // even if its KDF is still running or an older body lease is draining.
    return {
      lifecycleGeneration: this.bumpLifecycleGeneration(sessionId),
      quiescence: this.beginQuiescence(sessionId),
    }
  }

  private async finishQuiescence(sessionId: number, quiescence: SessionQuiescence): Promise<void> {
    await quiescence.drained
    if (this.sessionQuiescences.get(sessionId) === quiescence && !quiescence.finalized) {
      quiescence.finalized = true
      this.dropSessionCapabilities(sessionId)
      this.sessionEpochs.set(sessionId, (this.sessionEpochs.get(sessionId) ?? 0) + 1)
      this.sessionQuiescences.delete(sessionId)
      quiescence.resolveCompleted()
    }
    await quiescence.completed
  }

  private hasSessionCapability(sessionId: number): boolean {
    return [...this.capabilities.values()].some((entry) => entry.sessionId === sessionId)
  }

  /**
   * Execute one bounded body operation. Routes receive capability-scoped
   * crypto methods, never a DEK. A lock waits for this callback to finish,
   * so a successful lock cannot race an active decrypt or durable write.
   */
  async withBodyOperation<T>(
    sessionId: number,
    presentedCapability: unknown,
    callback: (operation: DiaryBodyOperation) => Promise<T> | T,
  ): Promise<T | null> {
    if (this.sessionQuiescences.has(sessionId) || !this.isCapabilityValid(sessionId, presentedCapability)) return null
    const token = String(presentedCapability)
    const capability = this.capabilities.get(token)
    if (!capability) return null
    const epoch = capability.epoch
    let leaseOpen = true
    this.activeBodyOperations.set(sessionId, (this.activeBodyOperations.get(sessionId) ?? 0) + 1)
    const isCurrent = () => (
      leaseOpen
      && !this.sessionQuiescences.get(sessionId)?.finalized
      &&
      this.capabilities.get(token) === capability
      && capability.epoch === epoch
    )
    const operation: DiaryBodyOperation = {
      isCurrent,
      assertCurrent: () => {
        if (!isCurrent()) throw new DiaryAccessServiceError(
          'diary-access-invalid-state',
          409,
          'Diary body operation is no longer current.',
        )
      },
      encrypt: (raw, context) => {
        operation.assertCurrent()
        const cryptoContext: BodyContext = {
          vaultId: capability.vaultId,
          documentId: context.documentId,
          logicalPath: context.logicalPath,
        }
        const result = encryptDiaryBody(raw, cryptoContext, capability.dek)
        operation.assertCurrent()
        return result
      },
      decrypt: (bytes, context) => {
        operation.assertCurrent()
        const cryptoContext: BodyContext = {
          vaultId: capability.vaultId,
          documentId: context.documentId,
          logicalPath: context.logicalPath,
        }
        const result = decryptDiaryBody(bytes, cryptoContext, capability.dek)
        operation.assertCurrent()
        return result
      },
      read: async (absolutePath, context) => {
        operation.assertCurrent()
        const cryptoContext: BodyContext = {
          vaultId: capability.vaultId,
          documentId: context.documentId,
          logicalPath: context.logicalPath,
        }
        const result = await readDiaryBody(absolutePath, cryptoContext, capability.dek)
        operation.assertCurrent()
        return result
      },
    }
    try {
      return await callback(operation)
    } finally {
      leaseOpen = false
      this.releaseBodyOperation(sessionId)
    }
  }

  async setup(sessionId: number, password: unknown, signal?: AbortSignal): Promise<{ state: 'UNLOCKED'; capability: string; epoch: number }> {
    this.assertSessionId(sessionId)
    if (!isValidPassword(password)) {
      throw new DiaryAccessServiceError('diary-access-invalid-input', 400, 'Diary access password is invalid.')
    }
    if (this.loadConfig()) {
      throw new DiaryAccessServiceError('diary-access-invalid-state', 409, 'Diary access is already initialized.')
    }

    const issuance = this.beginCapabilityIssuance(sessionId)
    const vaultId = this.getVaultId()
    const salt = randomBytes(SCRYPT_SALT_BYTES)
    const dek = randomBytes(SCRYPT_KEY_BYTES)
    let kek: Buffer | null = null
    try {
      kek = await deriveDiaryKek(password, salt, this.kdfGuard, signal)
      const wrapped = wrapDiaryDek(kek, dek, vaultId)
      this.assertCapabilityIssuanceCurrent(issuance)
      const now = this.now()
      try {
        const transaction = this.db.transaction(() => {
          const existing = this.db.prepare('SELECT id FROM diary_access_config WHERE id = 1 LIMIT 1').get()
          if (existing) throw new DiaryAccessServiceError('diary-access-invalid-state', 409, 'Diary access is already initialized.')
          this.db.prepare(`
            INSERT INTO diary_access_config (
              id, format_version, kdf_algorithm, kdf_version,
              kdf_n, kdf_r, kdf_p, kdf_maxmem, salt,
              wrap_algorithm, wrap_version, wrap_nonce, wrapped_dek,
              wrap_tag, vault_id, created_at, updated_at
            ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            DIARY_ACCESS_FORMAT_VERSION,
            DIARY_ACCESS_KDF_ALGORITHM,
            DIARY_ACCESS_KDF_VERSION,
            SCRYPT_N,
            SCRYPT_R,
            SCRYPT_P,
            SCRYPT_MAXMEM,
            salt,
            DIARY_ACCESS_WRAP_ALGORITHM,
            DIARY_ACCESS_WRAP_VERSION,
            wrapped.nonce,
            wrapped.wrappedDek,
            wrapped.tag,
            vaultId,
            now,
            now,
          )
        })
        transaction.immediate()
      } catch (error) {
        if (error instanceof DiaryAccessServiceError) throw error
        throw new DiaryAccessServiceError('diary-access-unavailable', 503, 'Diary access setup could not be saved.')
      }
      const issued = await this.issueCapability(issuance, vaultId, dek)
      return { state: 'UNLOCKED', ...issued }
    } catch (error) {
      if (error instanceof DiaryAccessServiceError) throw error
      if (error instanceof DiaryAccessCryptoError && error.code === 'invalid-password') {
        throw new DiaryAccessServiceError('diary-access-invalid-password', 401, 'Diary access password is invalid.')
      }
      throw new DiaryAccessServiceError('diary-access-unavailable', 503, 'Diary access setup is unavailable.')
    } finally {
      kek?.fill(0)
      // The issued capability owns this Buffer after a successful setup. On
      // failure there is no owner, so clear it before returning.
      if (![...this.capabilities.values()].some((entry) => entry.dek === dek)) dek.fill(0)
    }
  }

  async unlock(sessionId: number, password: unknown, signal?: AbortSignal): Promise<{ state: 'UNLOCKED'; capability: string; epoch: number }> {
    this.assertSessionId(sessionId)
    if (!isValidPassword(password)) {
      throw new DiaryAccessServiceError('diary-access-invalid-password', 401, 'Diary access password is invalid.')
    }
    const config = this.loadConfig()
    if (!config) throw new DiaryAccessServiceError('diary-access-invalid-state', 409, 'Diary access is not initialized.')
    const limiterKey = this.limiterKey(sessionId, config.vaultId)
    const retryAfterMs = this.unlockLimiter?.retryAfter(limiterKey, this.now()) ?? 0
    if (retryAfterMs > 0) {
      throw new DiaryAccessServiceError(
        'diary-access-rate-limited',
        429,
        'Too many Diary unlock attempts. Please try again later.',
        retryAfterMs,
      )
    }
    let dek: Buffer | null = null
    const issuance = this.beginCapabilityIssuance(sessionId)
    try {
      dek = await this.unwrapDek(password, config, this.kdfGuard, signal)
      if (dek.length !== SCRYPT_KEY_BYTES) {
        dek.fill(0)
        throw new DiaryAccessServiceError('diary-access-unavailable', 503, 'Diary access configuration is unavailable.')
      }
      const issued = await this.issueCapability(issuance, config.vaultId, dek)
      this.unlockLimiter?.reset(limiterKey)
      return { state: 'UNLOCKED', ...issued }
    } catch (error) {
      if (error instanceof DiaryAccessServiceError) throw error
      if (error instanceof DiaryAccessCryptoError && error.code === 'invalid-password') {
        const failure = this.unlockLimiter?.recordFailure(limiterKey, this.now())
        if (failure && failure.retryAfterMs > 0) {
          throw new DiaryAccessServiceError(
            'diary-access-rate-limited',
            429,
            'Too many Diary unlock attempts. Please try again later.',
            failure.retryAfterMs,
          )
        }
        throw new DiaryAccessServiceError('diary-access-invalid-password', 401, 'Diary access password is invalid.')
      }
      throw new DiaryAccessServiceError('diary-access-unavailable', 503, 'Diary access is unavailable.')
    } finally {
      if (dek && ![...this.capabilities.values()].some((entry) => entry.dek === dek)) dek.fill(0)
    }
  }

  lock(sessionId: number): Promise<{ state: 'LOCKED' }> {
    this.assertSessionId(sessionId)
    return this.invalidateAuthSession(sessionId).then(() => ({ state: 'LOCKED' as const }))
  }

  invalidateAuthSession(sessionId: number): Promise<void> {
    if (!Number.isSafeInteger(sessionId) || sessionId < 1) return Promise.resolve()
    const invalidation = this.beginSessionInvalidation(sessionId)
    return this.finishQuiescence(sessionId, invalidation.quiescence)
  }

  resetForTesting(): void {
    this.dropAllCapabilities()
    this.sessionEpochs.clear()
    this.sessionQuiescences.clear()
    this.activeBodyOperations.clear()
    this.sessionLifecycleGenerations.clear()
    this.sessionIssuanceSequences.clear()
    this.sessionIssuanceTails.clear()
  }
}

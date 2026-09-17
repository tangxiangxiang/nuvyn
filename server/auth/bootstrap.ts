import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Database as DatabaseT } from 'better-sqlite3'

export const MIN_EXPLICIT_BOOTSTRAP_TOKEN_BYTES = 32

export type AuthLogger = (message: string) => void

export type BootstrapStateOptions = {
  readonly db: DatabaseT
  readonly explicitToken?: string
  readonly logger?: AuthLogger
  readonly randomTokenBytes?: number
}

/**
 * Process-local first-run setup capability.
 *
 * The explicit operator token is never logged. When no explicit token is
 * configured, the generated fallback is printed exactly once and retained
 * only in this object until the owner transaction commits.
 */
export class BootstrapState {
  private token: string | null
  private closed: boolean
  private readonly logger: AuthLogger
  private loggedFallback = false

  private constructor(token: string | null, logger: AuthLogger) {
    this.token = token
    this.closed = token === null
    this.logger = logger
  }

  static create(options: BootstrapStateOptions): BootstrapState {
    const ownerExists = Boolean(
      options.db.prepare('SELECT 1 FROM auth_instance WHERE id = 1 LIMIT 1').get(),
    )
    if (ownerExists) return new BootstrapState(null, options.logger ?? console.log)

    const explicit = options.explicitToken
    if (typeof explicit === 'string' && explicit.length > 0) {
      if (Buffer.byteLength(explicit, 'utf8') < MIN_EXPLICIT_BOOTSTRAP_TOKEN_BYTES) {
        throw new RangeError('NUVYN_SETUP_TOKEN must contain at least 32 UTF-8 bytes.')
      }
      return new BootstrapState(explicit, options.logger ?? console.log)
    }

    const bytes = options.randomTokenBytes ?? 32
    if (!Number.isInteger(bytes) || bytes < MIN_EXPLICIT_BOOTSTRAP_TOKEN_BYTES) {
      throw new RangeError(
        `fallback bootstrap token must contain at least ${MIN_EXPLICIT_BOOTSTRAP_TOKEN_BYTES} random bytes`,
      )
    }
    const fallback = randomBytes(bytes).toString('base64url')
    const state = new BootstrapState(fallback, options.logger ?? console.log)
    state.logFallbackOnce()
    return state
  }

  get setupRequired(): boolean {
    return !this.closed
  }

  /** Verify a submitted token without exposing length-dependent timing. */
  verify(provided: unknown): boolean {
    if (this.closed || typeof provided !== 'string' || this.token === null) return false
    const expectedDigest = createHash('sha256').update(this.token, 'utf8').digest()
    const providedDigest = createHash('sha256').update(provided, 'utf8').digest()
    return timingSafeEqual(expectedDigest, providedDigest)
  }

  /** Close setup permanently after the owner transaction has committed. */
  markOwnerCommitted(): void {
    this.token = null
    this.closed = true
  }

  /** Test/runtime introspection without returning the secret itself. */
  hasGeneratedFallback(): boolean {
    return this.loggedFallback
  }

  private logFallbackOnce(): void {
    if (this.loggedFallback || this.token === null) return
    this.loggedFallback = true
    this.logger(`[nuvyn] generated one-time setup token: ${this.token}`)
  }
}

export function createBootstrapState(options: BootstrapStateOptions): BootstrapState {
  return BootstrapState.create(options)
}

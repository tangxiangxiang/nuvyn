import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import {
  defaultKdfGuard,
  type KdfGuard,
} from './kdfGuard.js'

export const SCRYPT_N = 32_768
export const SCRYPT_R = 8
export const SCRYPT_P = 1
export const SCRYPT_MAXMEM = 64 * 1024 * 1024
export const SCRYPT_SALT_BYTES = 16
export const SCRYPT_KEY_BYTES = 32

export const USERNAME_MIN_LENGTH = 3
export const USERNAME_MAX_LENGTH = 32
export const PASSWORD_MIN_LENGTH = 12
export const PASSWORD_MAX_LENGTH = 256

const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])?$/
const PASSWORD_HASH_PREFIX = 'scrypt$v1$'

export type PasswordValidationCode = 'invalid-username' | 'invalid-password'

export class PasswordValidationError extends Error {
  readonly code: PasswordValidationCode

  constructor(code: PasswordValidationCode, message: string) {
    super(message)
    this.name = 'PasswordValidationError'
    this.code = code
  }
}

export class PasswordHashParseError extends Error {
  readonly code = 'invalid-password-hash'

  constructor(message = 'invalid password hash encoding') {
    super(message)
    this.name = 'PasswordHashParseError'
  }
}

export type ParsedPasswordHash = {
  readonly algorithm: 'scrypt'
  readonly version: 1
  readonly N: typeof SCRYPT_N
  readonly r: typeof SCRYPT_R
  readonly p: typeof SCRYPT_P
  readonly salt: Buffer
  readonly derivedKey: Buffer
}

export type PasswordKdfOptions = {
  signal?: AbortSignal
  guard?: KdfGuard
}

function codePointLength(value: string): number {
  return Array.from(value).length
}

/** Return the canonical lowercase username or throw a narrow validation error. */
export function normalizeUsername(value: string): string {
  if (typeof value !== 'string') {
    throw new PasswordValidationError('invalid-username', 'username must be a string')
  }
  const normalized = value.trim().toLowerCase()
  if (
    codePointLength(normalized) < USERNAME_MIN_LENGTH
    || codePointLength(normalized) > USERNAME_MAX_LENGTH
    || !USERNAME_PATTERN.test(normalized)
  ) {
    throw new PasswordValidationError('invalid-username', 'username must be 3–32 ASCII characters')
  }
  return normalized
}

export const canonicalizeUsername = normalizeUsername

export function isValidUsername(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    normalizeUsername(value)
    return true
  } catch {
    return false
  }
}

/** Validate password length without changing the password bytes. */
export function validatePassword(value: string): void {
  if (typeof value !== 'string') {
    throw new PasswordValidationError('invalid-password', 'password must be a string')
  }
  const length = codePointLength(value)
  if (length < PASSWORD_MIN_LENGTH || length > PASSWORD_MAX_LENGTH) {
    throw new PasswordValidationError('invalid-password', 'password must be 12–256 Unicode code points')
  }
}

export function isValidPassword(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    validatePassword(value)
    return true
  } catch {
    return false
  }
}

function deriveScrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(
      Buffer.from(password, 'utf8'),
      salt,
      SCRYPT_KEY_BYTES,
      {
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
        maxmem: SCRYPT_MAXMEM,
      },
      (error, derivedKey) => {
        if (error) {
          reject(error)
          return
        }
        resolve(Buffer.from(derivedKey))
      },
    )
  })
}

function encodeBase64Url(value: Buffer): string {
  return value.toString('base64url')
}

function decodeBase64Url(value: string, expectedBytes: number): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new PasswordHashParseError()
  }
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.length !== expectedBytes || encodeBase64Url(decoded) !== value) {
    throw new PasswordHashParseError()
  }
  return decoded
}

/**
 * Parse only the approved v1 scrypt parameters. Stored values are untrusted;
 * rejecting unknown/expensive parameters prevents a database edit from
 * turning login verification into an arbitrary-cost KDF operation.
 */
export function parsePasswordHash(encoded: string): ParsedPasswordHash {
  if (typeof encoded !== 'string') throw new PasswordHashParseError()
  const parts = encoded.split('$')
  if (parts.length !== 5 || parts[0] !== 'scrypt' || parts[1] !== 'v1') {
    throw new PasswordHashParseError()
  }

  const parameters = /^N=(\d+),r=(\d+),p=(\d+)$/.exec(parts[2] ?? '')
  if (!parameters) throw new PasswordHashParseError()
  const N = Number(parameters[1])
  const r = Number(parameters[2])
  const p = Number(parameters[3])
  if (N !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) {
    throw new PasswordHashParseError()
  }

  return {
    algorithm: 'scrypt',
    version: 1,
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    salt: decodeBase64Url(parts[3] ?? '', SCRYPT_SALT_BYTES),
    derivedKey: decodeBase64Url(parts[4] ?? '', SCRYPT_KEY_BYTES),
  }
}

function encodePasswordHash(salt: Buffer, derivedKey: Buffer): string {
  return `${PASSWORD_HASH_PREFIX}N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}$${encodeBase64Url(salt)}$${encodeBase64Url(derivedKey)}`
}

function isKdfGuard(value: PasswordKdfOptions | KdfGuard): value is KdfGuard {
  return typeof value === 'object'
    && value !== null
    && 'run' in value
    && typeof value.run === 'function'
}

function resolveKdfOptions(optionsOrGuard?: PasswordKdfOptions | KdfGuard, signal?: AbortSignal): PasswordKdfOptions {
  if (optionsOrGuard && isKdfGuard(optionsOrGuard)) {
    return { guard: optionsOrGuard, signal }
  }
  if (!optionsOrGuard) return { signal }
  return {
    ...optionsOrGuard,
    signal: optionsOrGuard.signal ?? signal,
  }
}

/** Hash a valid owner password with the shared asynchronous scrypt budget. */
export function hashPassword(
  password: string,
  options?: PasswordKdfOptions | KdfGuard,
  signal?: AbortSignal,
): Promise<string> {
  validatePassword(password)
  const resolved = resolveKdfOptions(options, signal)
  const guard = resolved.guard ?? defaultKdfGuard
  const salt = randomBytes(SCRYPT_SALT_BYTES)
  return guard.run(
    resolved.signal,
    () => deriveScrypt(password, salt),
  ).then((derivedKey) => encodePasswordHash(salt, derivedKey))
}

/**
 * Verify a candidate password. Malformed/unsupported stored hashes are a safe
 * false result; only a valid parsed hash reaches the asynchronous KDF.
 */
export function verifyPassword(
  password: string,
  encodedHash: string,
  options?: PasswordKdfOptions | KdfGuard,
  signal?: AbortSignal,
): Promise<boolean> {
  // Keep the low-level verifier safe for callers outside AuthService too. The
  // route/service boundary maps this false result to generic credentials, and
  // no malformed-length input should ever schedule a memory-hard KDF.
  if (!isValidPassword(password) || typeof encodedHash !== 'string') {
    return Promise.resolve(false)
  }

  let parsed: ParsedPasswordHash
  try {
    parsed = parsePasswordHash(encodedHash)
  } catch {
    return Promise.resolve(false)
  }

  const resolved = resolveKdfOptions(options, signal)
  const guard = resolved.guard ?? defaultKdfGuard
  return guard.run(
    resolved.signal,
    () => deriveScrypt(password, parsed.salt),
  ).then((candidate) => {
    if (candidate.length !== parsed.derivedKey.length) return false
    return timingSafeEqual(candidate, parsed.derivedKey)
  })
}

/** Alternate argument order for low-level callers that keep hash first. */
export function verifyPasswordHash(
  encodedHash: string,
  password: string,
  options?: PasswordKdfOptions | KdfGuard,
  signal?: AbortSignal,
): Promise<boolean> {
  return verifyPassword(password, encodedHash, options, signal)
}

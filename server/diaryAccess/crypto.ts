import { createCipheriv, createDecipheriv, createHmac, randomBytes, scrypt } from 'node:crypto'
import {
  SCRYPT_KEY_BYTES,
  SCRYPT_MAXMEM,
  SCRYPT_N,
  SCRYPT_P,
  SCRYPT_R,
  SCRYPT_SALT_BYTES,
  validatePassword,
} from '../auth/password.js'
import type { KdfGuard } from '../auth/kdfGuard.js'

export const DIARY_ACCESS_FORMAT_VERSION = 1 as const
export const DIARY_ACCESS_KDF_ALGORITHM = 'scrypt' as const
export const DIARY_ACCESS_KDF_VERSION = 1 as const
export const DIARY_ACCESS_WRAP_ALGORITHM = 'aes-256-gcm' as const
export const DIARY_ACCESS_WRAP_VERSION = 1 as const
export const DIARY_ACCESS_NONCE_BYTES = 12
export const DIARY_ACCESS_TAG_BYTES = 16
export const DIARY_KEK_CONTEXT = 'nuvyn/diary-access/kek/v1'

export type DiaryAccessCiphertext = {
  readonly nonce: Buffer
  readonly wrappedDek: Buffer
  readonly tag: Buffer
}

export class DiaryAccessCryptoError extends Error {
  readonly code: 'invalid-password' | 'invalid-config' | 'invalid-key'

  constructor(
    code: 'invalid-password' | 'invalid-config' | 'invalid-key',
    message = 'Diary access cryptographic operation failed',
  ) {
    super(message)
    this.name = 'DiaryAccessCryptoError'
    this.code = code
  }
}

function deriveScrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(
      Buffer.from(password, 'utf8'),
      salt,
      SCRYPT_KEY_BYTES,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM },
      (error, derived) => error ? reject(error) : resolve(Buffer.from(derived)),
    )
  })
}

function aadFor(vaultId: string, context = DIARY_KEK_CONTEXT): Buffer {
  return Buffer.from(
    `${context}\u0000${vaultId}\u0000${DIARY_ACCESS_FORMAT_VERSION}`,
    'utf8',
  )
}

/**
 * Derive a Diary-only KEK. Password bytes are passed to scrypt unchanged;
 * the independent salt and context-bound HMAC keep this hierarchy separate
 * from the owner-login password hash and from any future body key.
 */
async function deriveDiaryKekForContext(
  password: string,
  salt: Buffer,
  guard: KdfGuard,
  context: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  validatePassword(password)
  if (salt.length !== SCRYPT_SALT_BYTES) {
    throw new DiaryAccessCryptoError('invalid-config')
  }
  const intermediate = await guard.run(signal, () => deriveScrypt(password, salt))
  try {
    return createHmac('sha256', intermediate).update(context, 'utf8').digest()
  } finally {
    intermediate.fill(0)
  }
}

export async function deriveDiaryKek(
  password: string,
  salt: Buffer,
  guard: KdfGuard,
  signal?: AbortSignal,
): Promise<Buffer> {
  return deriveDiaryKekForContext(password, salt, guard, DIARY_KEK_CONTEXT, signal)
}

export function wrapDiaryDek(kek: Buffer, dek: Buffer, vaultId: string): DiaryAccessCiphertext {
  if (kek.length !== SCRYPT_KEY_BYTES || dek.length !== SCRYPT_KEY_BYTES) {
    throw new DiaryAccessCryptoError('invalid-key')
  }
  const nonce = randomBytes(DIARY_ACCESS_NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', kek, nonce)
  cipher.setAAD(aadFor(vaultId))
  const wrappedDek = Buffer.concat([cipher.update(dek), cipher.final()])
  const tag = cipher.getAuthTag()
  if (tag.length !== DIARY_ACCESS_TAG_BYTES) throw new DiaryAccessCryptoError('invalid-key')
  return { nonce, wrappedDek, tag }
}

export async function unwrapDiaryDek(
  password: string,
  config: {
    salt: Buffer
    nonce: Buffer
    wrappedDek: Buffer
    tag: Buffer
    vaultId: string
  },
  guard: KdfGuard,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (
    config.salt.length !== SCRYPT_SALT_BYTES
    || config.nonce.length !== DIARY_ACCESS_NONCE_BYTES
    || config.wrappedDek.length !== SCRYPT_KEY_BYTES
    || config.tag.length !== DIARY_ACCESS_TAG_BYTES
  ) throw new DiaryAccessCryptoError('invalid-config')

  const tryUnwrap = (kek: Buffer): Buffer | null => {
    try {
      const decipher = createDecipheriv('aes-256-gcm', kek, config.nonce)
      decipher.setAAD(aadFor(config.vaultId))
      decipher.setAuthTag(config.tag)
      return Buffer.concat([decipher.update(config.wrappedDek), decipher.final()])
    } catch {
      return null
    }
  }

  const canonicalKek = await deriveDiaryKekForContext(password, config.salt, guard, DIARY_KEK_CONTEXT, signal)
  try {
    const canonicalDek = tryUnwrap(canonicalKek)
    if (canonicalDek) return canonicalDek
  } finally {
    canonicalKek.fill(0)
  }

  throw new DiaryAccessCryptoError('invalid-password', 'Diary access password is invalid')
}

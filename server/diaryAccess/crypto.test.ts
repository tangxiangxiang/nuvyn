import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { KdfGuard } from '../auth/kdfGuard.js'
import { SCRYPT_KEY_BYTES, SCRYPT_SALT_BYTES } from '../auth/password.js'
import {
  deriveDiaryKek,
  DIARY_ACCESS_NONCE_BYTES,
  DIARY_ACCESS_TAG_BYTES,
  unwrapDiaryDek,
  wrapDiaryDek,
} from './crypto.js'

const PASSWORD = 'nuvyn-diary-access-password'
const VAULT_ID = '08b028093bdd'

describe('Diary access crypto', () => {
  it('round-trips the canonical wrapped data-encryption key', async () => {
    const salt = randomBytes(SCRYPT_SALT_BYTES)
    const dek = randomBytes(SCRYPT_KEY_BYTES)
    const guard = new KdfGuard({ concurrency: 1, maxQueue: 2, maxQueueWaitMs: 10_000 })
    const kek = await deriveDiaryKek(PASSWORD, salt, guard)
    const wrapped = wrapDiaryDek(kek, dek, VAULT_ID)
    kek.fill(0)

    const recovered = await unwrapDiaryDek(
      PASSWORD,
      { salt, ...wrapped, vaultId: VAULT_ID },
      guard,
    )
    expect(wrapped.nonce).toHaveLength(DIARY_ACCESS_NONCE_BYTES)
    expect(wrapped.tag).toHaveLength(DIARY_ACCESS_TAG_BYTES)
    expect(recovered.equals(dek)).toBe(true)
    recovered.fill(0)
    dek.fill(0)
  })
})

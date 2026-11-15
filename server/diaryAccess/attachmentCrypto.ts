import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'

export type DiaryAttachmentCryptoContext = {
  readonly owner: number
  readonly date: string
  readonly id: string
}

const DOMAIN = 'nuvyn/diary-attachments/v1'
const NONCE_BYTES = 12
const TAG_BYTES = 16
const HEADER_BYTES = 1 + NONCE_BYTES + TAG_BYTES
const MAX_CIPHERTEXT_BYTES = 20 * 1024 * 1024 + HEADER_BYTES

export function diaryAttachmentCrypto(
  dek: Buffer,
  vaultId: string,
  assertCurrent: () => void,
) {
  function withKey<T>(
    context: DiaryAttachmentCryptoContext,
    purpose: 'metadata' | 'file',
    run: (key: Buffer, aad: Buffer) => T,
  ): T {
    assertCurrent()
    const key = createHmac('sha256', dek).update(DOMAIN).digest()
    const aad = Buffer.from(JSON.stringify([DOMAIN, 1, vaultId, context.owner, context.date, context.id, purpose]))
    try {
      const result = run(key, aad)
      assertCurrent()
      return result
    } finally {
      key.fill(0)
    }
  }

  function encrypt(bytes: Uint8Array, context: DiaryAttachmentCryptoContext, purpose: 'metadata' | 'file'): Buffer {
    return withKey(context, purpose, (key, aad) => {
      const nonce = randomBytes(NONCE_BYTES)
      const cipher = createCipheriv('aes-256-gcm', key, nonce)
      cipher.setAAD(aad)
      const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()])
      return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), ciphertext])
    })
  }

  function decrypt(bytes: Uint8Array, context: DiaryAttachmentCryptoContext, purpose: 'metadata' | 'file'): Buffer {
    if (bytes.byteLength < HEADER_BYTES || bytes.byteLength > MAX_CIPHERTEXT_BYTES || bytes[0] !== 1) {
      throw new Error('Invalid Diary attachment payload')
    }
    return withKey(context, purpose, (key, aad) => {
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(1, 1 + NONCE_BYTES))
      decipher.setAAD(aad)
      decipher.setAuthTag(bytes.subarray(1 + NONCE_BYTES, HEADER_BYTES))
      // Do not return or emit update() plaintext until GCM final() authenticates.
      const plaintext = Buffer.concat([
        decipher.update(bytes.subarray(HEADER_BYTES)),
        decipher.final(),
      ])
      return plaintext
    })
  }

  return {
    encryptFile(bytes: Uint8Array, context: DiaryAttachmentCryptoContext) {
      return encrypt(bytes, context, 'file')
    },
    decryptFile(bytes: Uint8Array, context: DiaryAttachmentCryptoContext) {
      return decrypt(bytes, context, 'file')
    },
    encryptMetadata(value: unknown, context: DiaryAttachmentCryptoContext) {
      const bytes = Buffer.from(JSON.stringify(value), 'utf8')
      try { return encrypt(bytes, context, 'metadata') } finally { bytes.fill(0) }
    },
    decryptMetadata(bytes: Uint8Array, context: DiaryAttachmentCryptoContext): unknown {
      const plaintext = decrypt(bytes, context, 'metadata')
      try { return JSON.parse(plaintext.toString('utf8')) as unknown } finally { plaintext.fill(0) }
    },
  }
}

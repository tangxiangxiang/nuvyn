import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'
import { parseDiaryPlanFields, type DiaryPlanFields } from '../../shared/diaryPlan.js'

export type DiaryPlanCryptoContext = {
  ownerId: number
  id: string
  date: string
}

const contextLabel = 'nuvyn/diary-plan/fields/v1'
const nonceSize = 12
const tagSize = 16

export class DiaryPlanCryptoError extends Error {
  constructor() { super('Diary plan payload could not be authenticated') }
}

export function diaryPlanCrypto(dek: Buffer, vaultId: string, assertCurrent: () => void) {
  function withKey<T>(context: DiaryPlanCryptoContext, run: (key: Buffer, aad: Buffer) => T): T {
    assertCurrent()
    const key = createHmac('sha256', dek).update(contextLabel).digest()
    try {
      const aad = Buffer.from(JSON.stringify([contextLabel, vaultId, context.ownerId, context.id, context.date]))
      return run(key, aad)
    } finally {
      key.fill(0)
    }
  }

  return {
    encrypt(fields: DiaryPlanFields, context: DiaryPlanCryptoContext): Buffer {
      return withKey(context, (key, aad) => {
        const nonce = randomBytes(nonceSize)
        const cipher = createCipheriv('aes-256-gcm', key, nonce)
        cipher.setAAD(aad)
        const ciphertext = Buffer.concat([cipher.update(JSON.stringify(fields), 'utf8'), cipher.final()])
        return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), ciphertext])
      })
    },
    decrypt(payload: Buffer, context: DiaryPlanCryptoContext): DiaryPlanFields {
      return withKey(context, (key, aad) => {
        const headerSize = 1 + nonceSize + tagSize
        if (payload[0] !== 1 || payload.length <= headerSize || payload.length > 4096) {
          throw new DiaryPlanCryptoError()
        }
        try {
          const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(1, 1 + nonceSize))
          decipher.setAAD(aad)
          decipher.setAuthTag(payload.subarray(1 + nonceSize, headerSize))
          const raw = Buffer.concat([decipher.update(payload.subarray(headerSize)), decipher.final()])
          const fields = parseDiaryPlanFields(JSON.parse(raw.toString('utf8')))
          if (fields) return fields
        } catch {
          throw new DiaryPlanCryptoError()
        }
        throw new DiaryPlanCryptoError()
      })
    },
  }
}

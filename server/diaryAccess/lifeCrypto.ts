import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'

export function diaryLifeCrypto(dek: Buffer, vaultId: string, assertCurrent: () => void) {
  function keyFor<T>(identity: string, run: (key: Buffer, aad: Buffer) => T): T {
    assertCurrent()
    const key = createHmac('sha256', dek).update('nuvyn/diary-life/v1').digest()
    try { return run(key, Buffer.from(JSON.stringify([vaultId, identity]))) } finally { key.fill(0) }
  }
  return {
    encrypt(value: unknown, identity: string): Buffer {
      return keyFor(identity, (key, aad) => {
        const nonce = randomBytes(12)
        const cipher = createCipheriv('aes-256-gcm', key, nonce)
        cipher.setAAD(aad)
        const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
        return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), body])
      })
    },
    decrypt(bytes: Buffer, identity: string): unknown {
      return keyFor(identity, (key, aad) => {
        if (bytes[0] !== 1 || bytes.length < 30 || bytes.length > 65536) throw new Error('Invalid Diary payload')
        const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(1, 13))
        decipher.setAAD(aad)
        decipher.setAuthTag(bytes.subarray(13, 29))
        return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(29)), decipher.final()]).toString('utf8'))
      })
    },
  }
}

import { describe, expect, it } from 'vitest'
import { diaryAttachmentCrypto } from '../diaryAccess/attachmentCrypto.js'

describe('Diary attachment encryption', () => {
  it('authenticates file and metadata with the vault, owner, date, identity, and purpose', () => {
    const dek = Buffer.alloc(32, 7)
    const crypto = diaryAttachmentCrypto(dek, 'vault-test', () => {})
    const context = { owner: 17, date: '2026-11-15', id: 'ebd8cb16-9121-4b57-a62e-3065d00ad22a' }
    const cleartext = Buffer.from('private attachment bytes')
    const encryptedFile = crypto.encryptFile(cleartext, context)
    const encryptedMetadata = crypto.encryptMetadata({ name: 'private.png', mimeType: 'image/png', size: cleartext.length }, context)

    expect(encryptedFile).not.toEqual(cleartext)
    expect(crypto.decryptFile(encryptedFile, context)).toEqual(cleartext)
    expect(crypto.decryptMetadata(encryptedMetadata, context)).toEqual({ name: 'private.png', mimeType: 'image/png', size: cleartext.length })

    for (const changedContext of [
      { ...context, owner: context.owner + 1 },
      { ...context, date: '2026-11-16' },
      { ...context, id: 'a2c59f0a-2434-4abd-bc99-1314ef5c2756' },
    ]) {
      expect(() => crypto.decryptFile(encryptedFile, changedContext)).toThrow()
      expect(() => crypto.decryptMetadata(encryptedMetadata, changedContext)).toThrow()
    }

    const tampered = Buffer.from(encryptedFile)
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1
    expect(() => crypto.decryptFile(tampered, context)).toThrow()

    encryptedFile.fill(0)
    encryptedMetadata.fill(0)
    tampered.fill(0)
    cleartext.fill(0)
    dek.fill(0)
  })

  it('does not return plaintext from invalid or unsupported envelope headers', () => {
    const crypto = diaryAttachmentCrypto(Buffer.alloc(32, 3), 'vault-test', () => {})
    const context = { owner: 1, date: '2026-11-15', id: 'ebd8cb16-9121-4b57-a62e-3065d00ad22a' }
    expect(() => crypto.decryptFile(Buffer.alloc(20), context)).toThrow()
    const unsupported = Buffer.alloc(30)
    unsupported[0] = 2
    expect(() => crypto.decryptFile(unsupported, context)).toThrow()
  })
})

import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  DiaryBodyCryptoError,
  DIARY_BODY_ENVELOPE_MAGIC,
  DIARY_BODY_KIND,
  DIARY_BODY_MAX_PLAINTEXT_BYTES,
  decryptDiaryBody,
  encryptDiaryBody,
} from './body.js'

const context = {
  vaultId: 'vault-test',
  documentId: 'document-test',
  logicalPath: 'diary/2026-08-29',
}

describe('D8.2 Diary body envelope', () => {
  it('round-trips plaintext with a fresh authenticated envelope', () => {
    const key = randomBytes(32)
    const first = encryptDiaryBody('# private\n', context, key)
    const second = encryptDiaryBody('# private\n', context, key)

    expect(first.toString('utf8')).not.toContain('# private')
    expect(second.equals(first)).toBe(false)
    expect(decryptDiaryBody(first, context, key)).toMatchObject({
      raw: '# private\n', encrypted: true,
    })
    key.fill(0)
  })

  it('fails closed for tampering, identity mismatch, and unknown versions', () => {
    const key = randomBytes(32)
    const encrypted = encryptDiaryBody('secret', context, key)
    const envelope = JSON.parse(encrypted.toString('utf8').slice(DIARY_BODY_ENVELOPE_MAGIC.length)) as Record<string, unknown>
    const tampered = Buffer.from(DIARY_BODY_ENVELOPE_MAGIC + JSON.stringify({ ...envelope, ciphertext: 'dGFtcGVyZWQ=' }))
    expect(() => decryptDiaryBody(tampered, context, key)).toThrowError(
      expect.objectContaining<Partial<DiaryBodyCryptoError>>({ code: 'authentication-failed' }),
    )
    expect(() => decryptDiaryBody(Buffer.from(DIARY_BODY_ENVELOPE_MAGIC + JSON.stringify(envelope)), { ...context, logicalPath: 'diary/2026-08-28' }, key))
      .toThrowError(expect.objectContaining({ code: 'identity-mismatch' }))
    expect(() => decryptDiaryBody(Buffer.from(DIARY_BODY_ENVELOPE_MAGIC + JSON.stringify({ ...envelope, version: 99 })), context, key))
      .toThrowError(expect.objectContaining({ code: 'unsupported-envelope' }))
    expect(() => decryptDiaryBody(Buffer.from(DIARY_BODY_ENVELOPE_MAGIC + '{broken'), context, key))
      .toThrowError(expect.objectContaining({ code: 'invalid-envelope' }))
    key.fill(0)
  })

  it('keeps plaintext readable for the explicit migration phase', () => {
    const key = randomBytes(32)
    expect(decryptDiaryBody(Buffer.from('# legacy\n'), context, key)).toMatchObject({
      raw: '# legacy\n', encrypted: false,
    })
    key.fill(0)
  })

  it('never downgrades a marked envelope to legacy plaintext', () => {
    const key = randomBytes(32)
    const marked = Buffer.from(`${DIARY_BODY_ENVELOPE_MAGIC}{"kind":"${DIARY_BODY_KIND}"`)
    expect(() => decryptDiaryBody(marked, context, key)).toThrowError(
      expect.objectContaining({ code: 'invalid-envelope' }),
    )
    const ordinaryJson = Buffer.from('{"kind":"ordinary-json","body":"legacy markdown"}')
    expect(decryptDiaryBody(ordinaryJson, context, key)).toMatchObject({
      raw: ordinaryJson.toString('utf8'), encrypted: false,
    })
    key.fill(0)
  })

  it('rejects non-canonical payloads and oversized plaintext before persistence', () => {
    const key = randomBytes(32)
    const encrypted = encryptDiaryBody('secret', context, key)
    const envelope = JSON.parse(encrypted.toString('utf8').slice(DIARY_BODY_ENVELOPE_MAGIC.length)) as Record<string, unknown>
    expect(() => decryptDiaryBody(
      Buffer.from(DIARY_BODY_ENVELOPE_MAGIC + JSON.stringify({ ...envelope, nonce: `${envelope.nonce}0` })),
      context,
      key,
    )).toThrowError(expect.objectContaining({ code: 'invalid-envelope' }))
    expect(() => encryptDiaryBody('x'.repeat(DIARY_BODY_MAX_PLAINTEXT_BYTES + 1), context, key))
      .toThrowError(expect.objectContaining({ code: 'invalid-envelope' }))
    key.fill(0)
  })
})

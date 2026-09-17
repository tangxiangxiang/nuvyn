import { describe, expect, it } from 'vitest'
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  SCRYPT_N,
  SCRYPT_P,
  SCRYPT_R,
  hashPassword,
  isValidPassword,
  isValidUsername,
  normalizeUsername,
  parsePasswordHash,
  validatePassword,
  verifyPassword,
} from '../auth/password'
import type { KdfGuard } from '../auth/kdfGuard'

describe('authentication username and password primitives', () => {
  it('normalizes usernames by trimming and lowercasing the frozen ASCII contract', () => {
    expect(normalizeUsername('  Admin_01  ')).toBe('admin_01')
    expect(normalizeUsername('a.b')).toBe('a.b')
    expect(isValidUsername('ADMIN')).toBe(true)
    expect(isValidUsername('ab')).toBe(false)
    expect(isValidUsername('a b')).toBe(false)
    expect(isValidUsername('管理员')).toBe(false)
    expect(isValidUsername('a'.repeat(33))).toBe(false)
  })

  it('counts password Unicode code points without trimming or normalization', () => {
    const twelveEmoji = '🙂'.repeat(PASSWORD_MIN_LENGTH)
    const elevenEmoji = '🙂'.repeat(PASSWORD_MIN_LENGTH - 1)
    const maxPassword = 'x'.repeat(PASSWORD_MAX_LENGTH)
    const tooLong = 'x'.repeat(PASSWORD_MAX_LENGTH + 1)

    expect(() => validatePassword(twelveEmoji)).not.toThrow()
    expect(() => validatePassword(elevenEmoji)).toThrow()
    expect(() => validatePassword(maxPassword)).not.toThrow()
    expect(() => validatePassword(tooLong)).toThrow()
    expect(isValidPassword('  twelve chars  ')).toBe(true)
    expect(isValidPassword('short')).toBe(false)
  })

  it('hashes and verifies with the versioned production scrypt encoding', async () => {
    const password = 'correct horse battery staple'
    const encoded = await hashPassword(password)
    const parsed = parsePasswordHash(encoded)

    expect(encoded).toMatch(/^scrypt\$v1\$N=32768,r=8,p=1\$/)
    expect(parsed.N).toBe(SCRYPT_N)
    expect(parsed.r).toBe(SCRYPT_R)
    expect(parsed.p).toBe(SCRYPT_P)
    expect(parsed.salt).toHaveLength(16)
    expect(parsed.derivedKey).toHaveLength(32)
    await expect(verifyPassword(password, encoded)).resolves.toBe(true)
    await expect(verifyPassword('wrong password that is long enough', encoded)).resolves.toBe(false)
  })

  it('uses a fresh random salt for each hash', async () => {
    const password = 'another sufficiently long password'
    const first = await hashPassword(password)
    const second = await hashPassword(password)
    expect(second).not.toBe(first)
    await expect(verifyPassword(password, first)).resolves.toBe(true)
    await expect(verifyPassword(password, second)).resolves.toBe(true)
  })

  it('treats malformed, unknown-version, and unapproved-cost hashes as safe failures', async () => {
    await expect(verifyPassword('any sufficiently long password', 'not-a-hash')).resolves.toBe(false)
    await expect(verifyPassword('any sufficiently long password', 'scrypt$v2$N=32768,r=8,p=1$AA$AA')).resolves.toBe(false)
    await expect(verifyPassword('any sufficiently long password', 'scrypt$v1$N=1048576,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).resolves.toBe(false)
    expect(() => parsePasswordHash('scrypt$v1$N=32768,r=8,p=1$invalid$invalid')).toThrow()
  })

  it('does not schedule the KDF for an overlong verifier input', async () => {
    const encoded = await hashPassword('a valid password for this test')
    let calls = 0
    const guard = {
      run: (..._args: unknown[]) => {
        calls += 1
        return Promise.resolve(Buffer.alloc(32))
      },
    } as unknown as KdfGuard

    await expect(verifyPassword('x'.repeat(PASSWORD_MAX_LENGTH + 1), encoded, { guard })).resolves.toBe(false)
    expect(calls).toBe(0)
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { hashDraftBaseline } from '../draftHash'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('hashDraftBaseline', () => {
  it('returns a deterministic lowercase SHA-256 hash', async () => {
    await expect(hashDraftBaseline('hello')).resolves.toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    )
    await expect(hashDraftBaseline('hello')).resolves.toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    )
  })

  it('hashes empty and different content distinctly', async () => {
    await expect(hashDraftBaseline('')).resolves.toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    expect(await hashDraftBaseline('a')).not.toBe(await hashDraftBaseline('b'))
  })

  it('returns null when Web Crypto is unavailable or rejects', async () => {
    vi.stubGlobal('crypto', undefined)
    await expect(hashDraftBaseline('content')).resolves.toBeNull()

    vi.stubGlobal('crypto', {
      subtle: { digest: vi.fn().mockRejectedValue(new Error('unavailable')) },
    })
    await expect(hashDraftBaseline('content')).resolves.toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import { draftKey, isDraftIdentity } from '../draftKey'

describe('draftKey', () => {
  it('creates stable collision-free keys across vaults and documents', () => {
    expect(draftKey('vault-a', 'document-a')).toEqual(['vault-a', 'document-a'])
    expect(draftKey('vault-a', 'document-b')).not.toEqual(
      draftKey('vault-a', 'document-a'),
    )
    expect(draftKey('vault-b', 'document-a')).not.toEqual(
      draftKey('vault-a', 'document-a'),
    )
  })

  it('rejects empty draft identities', () => {
    expect(isDraftIdentity('vault-a', 'document-a')).toBe(true)
    expect(isDraftIdentity('', 'document-a')).toBe(false)
    expect(isDraftIdentity('vault-a', '   ')).toBe(false)
  })
})


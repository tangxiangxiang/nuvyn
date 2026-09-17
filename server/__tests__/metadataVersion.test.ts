import { describe, expect, it } from 'vitest'
import {
  nextMetadataBatchUpdatedAt,
  nextMetadataUpdatedAt,
} from '../metadataVersion'

describe('metadata version generation', () => {
  it('advances strictly when wall time is equal to or behind the current version', () => {
    expect(nextMetadataUpdatedAt(1000, 1000)).toBe(1001)
    expect(nextMetadataUpdatedAt(1001, 1000)).toBe(1002)
    expect(nextMetadataUpdatedAt(1000, 2000)).toBe(2000)
  })

  it('mints a batch timestamp strictly above every current row', () => {
    expect(nextMetadataBatchUpdatedAt([100, 200, 150], 200)).toBe(201)
    expect(nextMetadataBatchUpdatedAt([], 200)).toBe(200)
  })

  it('rejects safe-integer overflow', () => {
    expect(() => nextMetadataUpdatedAt(Number.MAX_SAFE_INTEGER, 0)).toThrow(/cannot advance/)
    expect(() => nextMetadataBatchUpdatedAt([Number.MAX_SAFE_INTEGER], 0)).toThrow(/cannot advance/)
  })
})

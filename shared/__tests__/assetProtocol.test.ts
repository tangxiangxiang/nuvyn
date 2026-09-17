import { describe, expect, it } from 'vitest'
import { isBoardAssetMimeType } from '../assetProtocol'

describe('Board Asset MIME protocol', () => {
  it('accepts SVG as a first-class Board image MIME type', () => {
    expect(isBoardAssetMimeType('image/svg+xml')).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'
import { normalizeBoardScene } from './validation.js'

const ASSET_A = '11111111-1111-4111-8111-111111111111'
const ASSET_B = '22222222-2222-4222-8222-222222222222'

function scene(assetRefs: readonly string[] = [ASSET_A]) {
  const fileMap = Object.fromEntries(assetRefs.map((assetId, index) => [`file-${index}`, assetId]))
  return {
    engineData: {
      elements: assetRefs.map((_, index) => ({
        id: `image-${index}`,
        type: 'image',
        fileId: `file-${index}`,
        isDeleted: false,
      })),
      fileMap,
    },
    persistentAppState: {},
    assetRefs: [...assetRefs],
  }
}

describe('Board Scene Asset integrity validation', () => {
  it('accepts a valid image scene', () => {
    expect(normalizeBoardScene(scene())).toMatchObject({ assetRefs: [ASSET_A] })
  })

  it('accepts multiple image file IDs that share one Asset', () => {
    const value = scene([ASSET_A, ASSET_A])
    value.assetRefs = [ASSET_A]
    value.engineData.fileMap = { 'file-0': ASSET_A, 'file-1': ASSET_A }
    expect(normalizeBoardScene(value).assetRefs).toEqual([ASSET_A])
  })

  it('rejects an active image without a fileMap entry', () => {
    expect(() => normalizeBoardScene({
      ...scene([]),
      engineData: { elements: [{ type: 'image', fileId: 'file-a', isDeleted: false }], fileMap: {} },
    })).toThrow('has no fileMap asset mapping')
  })

  it('rejects an unused fileMap entry', () => {
    expect(() => normalizeBoardScene({
      ...scene([]),
      engineData: { elements: [], fileMap: { 'file-a': ASSET_A } },
    })).toThrow('unused Excalidraw file ID')
  })

  it('rejects missing, extra, invalid, and duplicate assetRefs', () => {
    const valid = scene()
    expect(() => normalizeBoardScene({ ...valid, assetRefs: [] })).toThrow('assetRefs must equal')
    expect(() => normalizeBoardScene({ ...valid, assetRefs: [ASSET_A, ASSET_B] })).toThrow('assetRefs must equal')
    expect(() => normalizeBoardScene({
      ...scene([]),
      engineData: { elements: [{ type: 'image', fileId: 'file-a', isDeleted: false }], fileMap: { 'file-a': ASSET_A } },
      assetRefs: ['not-a-uuid'],
    })).toThrow('assetRefs must contain UUID Asset IDs')
    expect(() => normalizeBoardScene({
      ...scene([]),
      engineData: { elements: [{ type: 'image', fileId: 'file-a', isDeleted: false }], fileMap: { 'file-a': 'not-a-uuid' } },
      assetRefs: ['not-a-uuid'],
    })).toThrow('fileMap.file-a must be a UUID Asset ID')
    expect(() => normalizeBoardScene({
      ...valid,
      assetRefs: [ASSET_A, ASSET_A],
    })).toThrow('assetRefs must be unique')
  })

  it('does not require a fileMap entry for a deleted image', () => {
    expect(normalizeBoardScene({
      engineData: { elements: [{ type: 'image', isDeleted: true }], fileMap: {} },
      persistentAppState: {},
      assetRefs: [],
    })).toMatchObject({ assetRefs: [] })
  })
})

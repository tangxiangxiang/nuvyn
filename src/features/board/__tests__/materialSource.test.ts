import { describe, expect, it, vi } from 'vitest'
import type { BoardMaterial } from '../../../../shared/boardMaterialProtocol'
import { createBoardMaterialSource } from '../materialSource'

function material(id: string, archived = false, updatedAt = 1): BoardMaterial {
  return { id, name: id, kind: 'svg', svg: '<svg></svg>', archived, createdAt: 1, updatedAt }
}

describe('Board Material source', () => {
  it('loads active and archived materials once and keeps them sorted', async () => {
    const fetchMaterials = vi.fn(async (archived: boolean) => archived
      ? [material('archived', true, 2)]
      : [material('active-a', false, 4), material('active-b', false, 3)])
    const source = createBoardMaterialSource(fetchMaterials)

    await source.ensureLoaded()
    await source.ensureLoaded()
    expect(fetchMaterials).toHaveBeenCalledTimes(2)
    expect(source.getSnapshot().map((item) => item.id)).toEqual(['active-a', 'active-b', 'archived'])
  })

  it('updates and invalidates its snapshot without leaking stale records', async () => {
    const source = createBoardMaterialSource(async () => [])
    const next = material('next', false, 8)
    source.upsert(next)
    expect(source.getSnapshot()).toEqual([next])
    source.remove(next.id)
    expect(source.getSnapshot()).toEqual([])
    source.upsert(next)
    source.invalidate()
    expect(source.getSnapshot()).toEqual([])
  })
})

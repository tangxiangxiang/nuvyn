import { readonly, shallowRef, type ShallowRef } from 'vue'
import type { BoardMaterial } from '../../../shared/boardMaterialProtocol'
import { listBoardMaterials } from './api'

export interface BoardMaterialSource {
  readonly snapshot: Readonly<ShallowRef<readonly BoardMaterial[]>>
  getSnapshot(): readonly BoardMaterial[]
  ensureLoaded(): Promise<void>
  refresh(): Promise<void>
  upsert(material: BoardMaterial): void
  remove(materialId: string): void
  invalidate(): void
}

type MaterialFetcher = (archived: boolean) => Promise<readonly BoardMaterial[]>

function compareMaterials(left: BoardMaterial, right: BoardMaterial): number {
  return right.updatedAt - left.updatedAt || right.id.localeCompare(left.id)
}

function normalizeMaterials(materials: readonly BoardMaterial[]): readonly BoardMaterial[] {
  return [...materials].sort(compareMaterials)
}

export function createBoardMaterialSource(
  fetchMaterials: MaterialFetcher = listBoardMaterials,
): BoardMaterialSource {
  const snapshot = shallowRef<readonly BoardMaterial[]>([])
  let loaded = false
  let generation = 0
  let inFlight: Promise<void> | null = null

  function startLoad(): Promise<void> {
    const requestGeneration = generation
    let pending: Promise<void>
    pending = Promise.all([fetchMaterials(false), fetchMaterials(true)]).then(([active, archived]) => {
      if (requestGeneration !== generation) return
      snapshot.value = normalizeMaterials([...active, ...archived])
      loaded = true
    }).finally(() => {
      if (inFlight === pending) inFlight = null
    })
    inFlight = pending
    return pending
  }

  function ensureLoaded(): Promise<void> {
    if (loaded) return Promise.resolve()
    return inFlight ?? startLoad()
  }

  function refresh(): Promise<void> {
    loaded = false
    return inFlight ?? startLoad()
  }

  function upsert(material: BoardMaterial): void {
    snapshot.value = normalizeMaterials([
      ...snapshot.value.filter((item) => item.id !== material.id),
      material,
    ])
  }

  function remove(materialId: string): void {
    snapshot.value = snapshot.value.filter((material) => material.id !== materialId)
  }

  function invalidate(): void {
    generation += 1
    loaded = false
    inFlight = null
    snapshot.value = []
  }

  return {
    snapshot: readonly(snapshot),
    getSnapshot: () => snapshot.value,
    ensureLoaded,
    refresh,
    upsert,
    remove,
    invalidate,
  }
}

export const boardMaterialSource = createBoardMaterialSource()

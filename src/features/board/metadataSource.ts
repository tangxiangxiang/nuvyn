import { readonly, shallowRef, type ShallowRef } from 'vue'
import type { BoardMetadata } from '../../../shared/boardProtocol'
import { listBoards } from './api'

export interface BoardMetadataSource {
  readonly snapshot: Readonly<ShallowRef<readonly BoardMetadata[]>>
  getSnapshot(): readonly BoardMetadata[]
  ensureLoaded(): Promise<void>
  refresh(): Promise<void>
  upsert(metadata: BoardMetadata): void
  remove(boardId: string): void
  invalidate(): void
}

type BoardFetcher = () => Promise<readonly BoardMetadata[]>

function compareBoards(left: BoardMetadata, right: BoardMetadata): number {
  const leftOpenedAt = left.lastOpenedAt ?? left.updatedAt ?? left.createdAt
  const rightOpenedAt = right.lastOpenedAt ?? right.updatedAt ?? right.createdAt
  return rightOpenedAt - leftOpenedAt || right.id.localeCompare(left.id)
}

function normalizeBoards(boards: readonly BoardMetadata[]): readonly BoardMetadata[] {
  return [...boards].sort(compareBoards)
}

export function createBoardMetadataSource(fetchBoards: BoardFetcher = listBoards): BoardMetadataSource {
  const snapshot = shallowRef<readonly BoardMetadata[]>([])
  let loaded = false
  let generation = 0
  let inFlight: Promise<void> | null = null

  function startLoad(): Promise<void> {
    const requestGeneration = generation
    let pending: Promise<void>
    pending = fetchBoards().then((boards) => {
      if (requestGeneration !== generation) return
      snapshot.value = normalizeBoards(boards)
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

  function upsert(metadata: BoardMetadata): void {
    snapshot.value = normalizeBoards([
      ...snapshot.value.filter((board) => board.id !== metadata.id),
      metadata,
    ])
  }

  function remove(boardId: string): void {
    snapshot.value = snapshot.value.filter((board) => board.id !== boardId)
  }

  function invalidate(): void {
    generation += 1
    loaded = false
    // Do not let a request started for the previous auth session block the
    // first load in the next session. Its generation check still prevents a
    // late response from repopulating this source.
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

export const boardMetadataSource = createBoardMetadataSource()

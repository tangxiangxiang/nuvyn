import { readonly, shallowRef, type ShallowRef } from 'vue'
import type { BoardFolderSummary } from '../../../shared/boardProtocol'
import { listBoardFolders } from './api'

export interface BoardFolderSource {
  readonly snapshot: Readonly<ShallowRef<readonly BoardFolderSummary[]>>
  getSnapshot(): readonly BoardFolderSummary[]
  ensureLoaded(): Promise<void>
  refresh(): Promise<void>
  upsert(folder: BoardFolderSummary): void
  remove(folderId: string): void
  invalidate(): void
}

type FolderFetcher = () => Promise<readonly BoardFolderSummary[]>

function compareFolders(left: BoardFolderSummary, right: BoardFolderSummary): number {
  return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
    || left.id.localeCompare(right.id)
}

function normalizeFolders(folders: readonly BoardFolderSummary[]): readonly BoardFolderSummary[] {
  return [...folders].sort(compareFolders)
}

export function createBoardFolderSource(fetchFolders: FolderFetcher = listBoardFolders): BoardFolderSource {
  const snapshot = shallowRef<readonly BoardFolderSummary[]>([])
  let loaded = false
  let generation = 0
  let inFlight: Promise<void> | null = null

  function startLoad(): Promise<void> {
    const requestGeneration = generation
    let pending: Promise<void>
    pending = fetchFolders().then((folders) => {
      if (requestGeneration !== generation) return
      snapshot.value = normalizeFolders(folders)
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

  function upsert(folder: BoardFolderSummary): void {
    snapshot.value = normalizeFolders([
      ...snapshot.value.filter((item) => item.id !== folder.id),
      folder,
    ])
  }

  function remove(folderId: string): void {
    snapshot.value = snapshot.value.filter((folder) => folder.id !== folderId)
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

export const boardFolderSource = createBoardFolderSource()

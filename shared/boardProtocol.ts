/**
 * Framework-independent Board contracts shared by the server and browser.
 *
 * Engine-specific data stays opaque at this boundary.  The Board domain owns
 * the surrounding scene shape while the engine adapter owns the contents of
 * `engineData`.
 */

export const BOARD_ENGINE_EXCALIDRAW = 'excalidraw' as const
export type BoardEngine = typeof BOARD_ENGINE_EXCALIDRAW

export const CURRENT_BOARD_SCENE_VERSION = 1 as const
export const DEFAULT_BOARD_TITLE = 'Untitled Board' as const

export interface BoardMetadata {
  id: string
  title: string
  thumbnailAssetId: string | null
  folderId: string | null
  createdAt: number
  updatedAt: number
  /** Last time the user opened this Board; null for a Board that has never been opened. */
  lastOpenedAt: number | null
}

export interface BoardFolder {
  id: string
  name: string
  parentId: string | null
  createdAt: number
  updatedAt: number
}

export interface BoardFolderSummary extends BoardFolder {
  boardCount: number
}

export interface BoardPersistentAppState {
  zoom?: number
  scrollX?: number
  scrollY?: number
  gridSize?: number | null
  viewBackgroundColor?: string
}

export interface BoardScene {
  engineData: unknown
  persistentAppState: BoardPersistentAppState
  assetRefs: readonly string[]
}

export interface BoardSceneRecord {
  boardId: string
  engine: BoardEngine
  sceneVersion: number
  revision: number
  scene: BoardScene
}

/** The single canonical empty engine payload used by Board V1. */
export const CANONICAL_EMPTY_ENGINE_DATA = Object.freeze({
  elements: Object.freeze([]),
  fileMap: Object.freeze({}),
})

/** Read-only reference value for documentation/tests; use the factory for writes. */
export const CANONICAL_EMPTY_SCENE = Object.freeze({
  engineData: CANONICAL_EMPTY_ENGINE_DATA,
  persistentAppState: Object.freeze({}),
  assetRefs: Object.freeze([]),
}) satisfies BoardScene

/**
 * Return a fresh canonical empty scene so callers cannot mutate the shared
 * constant and accidentally change the default used by another operation.
 */
export function createCanonicalEmptyBoardScene(): BoardScene {
  const engineData = CANONICAL_EMPTY_SCENE.engineData as {
    readonly elements: readonly unknown[]
    readonly fileMap: Readonly<Record<string, unknown>>
  }
  return {
    engineData: {
      elements: [...engineData.elements],
      fileMap: { ...engineData.fileMap },
    },
    persistentAppState: { ...CANONICAL_EMPTY_SCENE.persistentAppState },
    assetRefs: [...CANONICAL_EMPTY_SCENE.assetRefs],
  }
}

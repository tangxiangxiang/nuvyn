import type {
  BoardFolderSummary,
  BoardMetadata,
  BoardScene,
  BoardSceneRecord,
} from '../../shared/boardProtocol.js'

export const BOARD_REFERENCE_OWNER_TYPE = 'board' as const
export const BOARD_SCENE_REFERENCE_PURPOSE = 'scene' as const
export const BOARD_THUMBNAIL_REFERENCE_PURPOSE = 'thumbnail' as const

export interface BoardAggregate {
  readonly metadata: BoardMetadata
  readonly sceneRecord: BoardSceneRecord
}

export interface SaveBoardSceneInput {
  readonly boardId: string
  readonly expectedRevision: number
  readonly engine: string
  readonly sceneVersion: number
  readonly scene: BoardScene
}

export interface SaveBoardSceneResult {
  readonly revision: number
  readonly updatedAt: number
  readonly removedAssetIds: readonly string[]
}

export interface BoardMutationResult {
  readonly deleted: true
  readonly cleanupFailures: readonly unknown[]
}

export interface BoardFolderMutationResult {
  readonly deleted: true
}

export type { BoardFolderSummary }

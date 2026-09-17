import type { BoardScene } from '../../../../shared/boardProtocol'

/** Engine runtime data kept outside Vue's deep reactivity graph. */
export interface ExcalidrawRuntimeScene {
  readonly elements: readonly unknown[]
  readonly appState: Readonly<Record<string, unknown>>
  readonly files: Readonly<Record<string, unknown>>
}

/** Runtime asset data exchanged across the engine boundary. */
export interface BoardRuntimeAsset {
  readonly engineFileId: string
  readonly mimeType: string
  readonly blob: Blob
}

/** Resolved binary data supplied to an engine adapter during hydration. */
export interface ResolvedBoardAsset {
  readonly assetId: string
  readonly engineFileId: string
  readonly mimeType: string
  readonly blob: Blob
}

export interface BoardEngineAdapter<TRuntimeScene = unknown> {
  validate(scene: BoardScene): void
  hydrate(scene: BoardScene, resolvedAssets?: readonly ResolvedBoardAsset[]): Promise<TRuntimeScene>
  serialize(runtime: TRuntimeScene, fileMap?: Readonly<Record<string, string>>): BoardScene
  generateThumbnail(runtime: TRuntimeScene): Promise<Blob | null>
  exportPng(runtime: TRuntimeScene): Promise<Blob>
  exportSvg(runtime: TRuntimeScene): Promise<string | Blob>
}

export type BoardEngineCompatibilityCode =
  | 'BOARD_ENGINE_UNSUPPORTED'
  | 'BOARD_SCENE_VERSION_UNSUPPORTED'
  | 'BOARD_SCENE_INVALID'

export class BoardEngineCompatibilityError extends Error {
  readonly code: BoardEngineCompatibilityCode

  constructor(code: BoardEngineCompatibilityCode, message: string) {
    super(message)
    this.name = 'BoardEngineCompatibilityError'
    this.code = code
  }
}

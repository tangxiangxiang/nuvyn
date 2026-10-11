import { getBoardPreview } from './api'
import { fetchAssetBlob } from './assetClient'
import { assertSupportedExcalidrawScene, excalidrawAdapter } from './engine/excalidrawAdapter'
import type { ResolvedBoardAsset } from './engine/types'
import type { BoardMetadata } from '../../../shared/boardProtocol'

export interface BoardPreview {
  metadata: BoardMetadata
  revision: number
  image: Blob | null
}

/** Render only the confirmed server scene, never a local recovery draft. */
export async function loadBoardPreview(boardId: string, signal?: AbortSignal): Promise<BoardPreview> {
  const { metadata, sceneRecord } = await getBoardPreview(boardId, signal)
  signal?.throwIfAborted()
  assertSupportedExcalidrawScene(sceneRecord.engine, sceneRecord.sceneVersion)
  const scene = sceneRecord.scene
  excalidrawAdapter.validate(scene)
  const engineData = scene.engineData as { elements: Array<{ isDeleted?: boolean }>; fileMap: Record<string, string> }
  if (engineData.elements.every((element) => element?.isDeleted === true)) {
    return { metadata, revision: sceneRecord.revision, image: null }
  }

  // Multiple engine files may share one immutable server asset.
  const blobs = new Map(await Promise.all(scene.assetRefs.map(async (id) => (
    [id, await fetchAssetBlob(id, signal)] as const
  ))))
  signal?.throwIfAborted()
  const assets: ResolvedBoardAsset[] = Object.entries(engineData.fileMap).map(([engineFileId, assetId]) => {
    const blob = blobs.get(assetId)!
    return { engineFileId, assetId, blob, mimeType: blob.type }
  })
  const runtime = await excalidrawAdapter.hydrate(scene, assets)
  signal?.throwIfAborted()
  const output = await excalidrawAdapter.exportSvg(runtime)
  signal?.throwIfAborted()
  // SVG is loaded as an image, not injected as author-controlled inline HTML.
  const image = typeof output === 'string' ? new Blob([output], { type: 'image/svg+xml' }) : output
  return { metadata, revision: sceneRecord.revision, image }
}

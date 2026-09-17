import { authFetch } from '../../lib/auth-session'
import { jsonOrThrow } from '../../lib/api'
import type { BoardFolderSummary, BoardMetadata, BoardScene, BoardSceneRecord } from '../../../shared/boardProtocol'
import type { BoardMaterial } from '../../../shared/boardMaterialProtocol'

export interface BoardAggregate {
  metadata: BoardMetadata
  sceneRecord: BoardSceneRecord
}

export interface CreateBoardOptions {
  title?: string
  folderId?: string | null
}

export interface SaveBoardSceneRequest {
  expectedRevision: number
  engine: 'excalidraw'
  sceneVersion: number
  scene: BoardScene
}

export interface SaveBoardSceneResponse {
  revision: number
  updatedAt: number
}

export interface SaveBoardThumbnailResponse {
  thumbnailAssetId: string | null
}

export class BoardApiError extends Error {
  readonly status: number
  readonly code: string
  readonly uncertain: boolean

  constructor(message: string, status = 500, code = 'BOARD_API_ERROR', uncertain = true) {
    super(message)
    this.name = 'BoardApiError'
    this.status = status
    this.code = code
    this.uncertain = uncertain
  }
}

function asBoardApiError(error: unknown, uncertain = true): BoardApiError {
  if (error instanceof BoardApiError) return error
  const source = error as { message?: unknown; status?: unknown; code?: unknown } | null
  return new BoardApiError(
    typeof source?.message === 'string' && source.message.trim()
      ? source.message
      : 'Board request failed.',
    typeof source?.status === 'number' && Number.isFinite(source.status) ? source.status : 500,
    typeof source?.code === 'string' && source.code.trim() ? source.code : 'BOARD_API_ERROR',
    uncertain,
  )
}

async function readJson<T>(response: Response): Promise<T> {
  let definiteError = false
  if (!response.ok) {
    try {
      await response.clone().json()
      definiteError = true
    } catch {
      // An unreadable error response leaves the mutation outcome unknown.
    }
  }
  try {
    return await jsonOrThrow<T>(response)
  } catch (error) {
    throw asBoardApiError(error, !response.ok ? !definiteError : true)
  }
}

async function requestJson<T>(
  path: string,
  method: 'POST' | 'PATCH' | 'PUT',
  body: object,
): Promise<T> {
  try {
    const response = await authFetch(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return await readJson<T>(response)
  } catch (error) {
    throw asBoardApiError(error)
  }
}

export async function listBoards(): Promise<BoardMetadata[]> {
  try {
    return await readJson<BoardMetadata[]>(await authFetch('/api/board'))
  } catch (error) {
    throw asBoardApiError(error)
  }
}

export async function getBoard(boardId: string): Promise<BoardAggregate> {
  try {
    return await readJson<BoardAggregate>(await authFetch(`/api/board/${encodeURIComponent(boardId)}`))
  } catch (error) {
    throw asBoardApiError(error)
  }
}

export async function getBoardMetadata(boardId: string): Promise<BoardMetadata> {
  try {
    return await readJson<BoardMetadata>(await authFetch(`/api/board/${encodeURIComponent(boardId)}/metadata`))
  } catch (error) {
    throw asBoardApiError(error)
  }
}

export async function createBoard(input?: string | CreateBoardOptions): Promise<BoardAggregate> {
  const body = typeof input === 'string' ? { title: input } : input ?? {}
  return requestJson<BoardAggregate>('/api/board', 'POST', body)
}

export async function listBoardFolders(): Promise<BoardFolderSummary[]> {
  try {
    return await readJson<BoardFolderSummary[]>(await authFetch('/api/board-folders'))
  } catch (error) {
    throw asBoardApiError(error)
  }
}

export async function createBoardFolder(name: string): Promise<BoardFolderSummary> {
  return requestJson<BoardFolderSummary>('/api/board-folders', 'POST', { name })
}

export async function renameBoardFolder(folderId: string, name: string): Promise<BoardFolderSummary> {
  return requestJson<BoardFolderSummary>(
    `/api/board-folders/${encodeURIComponent(folderId)}`,
    'PATCH',
    { name },
  )
}

export async function deleteBoardFolder(folderId: string): Promise<void> {
  try {
    const response = await authFetch(`/api/board-folders/${encodeURIComponent(folderId)}`, { method: 'DELETE' })
    if (response.ok) return
    await readJson<never>(response)
  } catch (error) {
    throw asBoardApiError(error)
  }
}

export async function moveBoard(boardId: string, folderId: string | null): Promise<BoardMetadata> {
  return requestJson<BoardMetadata>(
    `/api/board/${encodeURIComponent(boardId)}/folder`,
    'PATCH',
    { folderId },
  )
}

export async function renameBoard(boardId: string, title: string): Promise<BoardMetadata> {
  return requestJson<BoardMetadata>(
    `/api/board/${encodeURIComponent(boardId)}`,
    'PATCH',
    { title },
  )
}

export async function deleteBoard(boardId: string): Promise<void> {
  try {
    const response = await authFetch(`/api/board/${encodeURIComponent(boardId)}`, { method: 'DELETE' })
    if (response.ok) return
    await readJson<never>(response)
  } catch (error) {
    throw asBoardApiError(error)
  }
}

export async function listBoardMaterials(archived = false): Promise<BoardMaterial[]> {
  try {
    const suffix = archived ? '?archived=true' : ''
    return await readJson<BoardMaterial[]>(await authFetch(`/api/board-materials${suffix}`))
  } catch (error) {
    throw asBoardApiError(error)
  }
}

export async function createBoardMaterial(name: string, svg: string): Promise<BoardMaterial> {
  return requestJson<BoardMaterial>('/api/board-materials', 'POST', { name, svg })
}

export async function renameBoardMaterial(materialId: string, name: string): Promise<BoardMaterial> {
  return requestJson<BoardMaterial>(
    `/api/board-materials/${encodeURIComponent(materialId)}`,
    'PATCH',
    { name },
  )
}

export async function archiveBoardMaterial(materialId: string): Promise<BoardMaterial> {
  return requestJson<BoardMaterial>(
    `/api/board-materials/${encodeURIComponent(materialId)}/archive`,
    'POST',
    {},
  )
}

export async function restoreBoardMaterial(materialId: string): Promise<BoardMaterial> {
  return requestJson<BoardMaterial>(
    `/api/board-materials/${encodeURIComponent(materialId)}/restore`,
    'POST',
    {},
  )
}

export async function deleteBoardMaterial(materialId: string): Promise<void> {
  try {
    const response = await authFetch(`/api/board-materials/${encodeURIComponent(materialId)}`, { method: 'DELETE' })
    if (response.ok) return
    await readJson<never>(response)
  } catch (error) {
    throw asBoardApiError(error)
  }
}

export async function saveBoardScene(
  boardId: string,
  request: SaveBoardSceneRequest,
): Promise<SaveBoardSceneResponse> {
  return requestJson<SaveBoardSceneResponse>(
    `/api/board/${encodeURIComponent(boardId)}/scene`,
    'PUT',
    request,
  )
}

export async function setBoardThumbnail(
  boardId: string,
  assetId: string | null,
): Promise<SaveBoardThumbnailResponse> {
  return requestJson<SaveBoardThumbnailResponse>(
    `/api/board/${encodeURIComponent(boardId)}/thumbnail`,
    'PUT',
    { assetId },
  )
}

export function boardAssetUrl(assetId: string): string {
  return `/api/assets/${encodeURIComponent(assetId)}`
}

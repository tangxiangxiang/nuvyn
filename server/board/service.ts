import { randomUUID } from 'node:crypto'
import type { Database as DatabaseT } from 'better-sqlite3'
import {
  BOARD_ENGINE_EXCALIDRAW,
  CURRENT_BOARD_SCENE_VERSION,
  DEFAULT_BOARD_TITLE,
  type BoardFolderSummary,
  type BoardMetadata,
} from '../../shared/boardProtocol.js'
import type { BoardSearchItem } from '../../shared/boardSearchProtocol.js'
import { AssetService } from '../assets/service.js'
import { assertAssetId } from '../assets/validation.js'
import type { AssetServiceDependencies } from '../assets/types.js'
import { BoardError } from './errors.js'
import { createBoardRepository, type BoardRepository, type BoardSearchRecord } from './repository.js'
import { notifyAttachmentReferencesChanged } from '../attachmentReferenceEvents.js'
import {
  assertBoardId,
  assertBoardFolderId,
  assertExpectedRevision,
  assertSupportedBoardSceneContract,
  normalizeBoardFolderName,
  normalizeBoardScene,
  normalizeNullableBoardFolderId,
  normalizeBoardTitle,
  normalizeBoardSearchLimit,
  normalizeBoardSearchQuery,
} from './validation.js'
import { extractBoardSearchText } from './searchText.js'
import type {
  BoardAggregate,
  BoardFolderMutationResult,
  BoardMutationResult,
  SaveBoardSceneInput,
  SaveBoardSceneResult,
} from './types.js'

export interface BoardServiceDependencies {
  readonly now?: () => number
  readonly storage?: AssetServiceDependencies['storage']
  readonly assetRepository?: AssetServiceDependencies['repository']
  readonly createId?: () => string
  readonly repository?: BoardRepository
}

export type CreateBoardInput = {
  readonly title?: unknown
  readonly folderId?: unknown
} | string

export type CreateBoardFolderInput = {
  readonly name?: unknown
  readonly parentId?: unknown
} | string

export class BoardService {
  readonly repository: BoardRepository
  readonly assets: AssetService
  private readonly now: () => number
  private readonly createId: () => string

  constructor(db: DatabaseT, dependencies: BoardServiceDependencies = {}) {
    this.repository = dependencies.repository ?? createBoardRepository(db)
    this.assets = new AssetService(db, {
      now: dependencies.now,
      storage: dependencies.storage,
      repository: dependencies.assetRepository,
    })
    this.now = dependencies.now ?? Date.now
    this.createId = dependencies.createId ?? randomUUID
  }

  createBoard(input: CreateBoardInput = {}): BoardAggregate {
    const requestedTitle = typeof input === 'string' ? input : input.title
    const folderId = typeof input === 'string' ? null : normalizeNullableBoardFolderId(input.folderId)
    const title = requestedTitle === undefined
      ? DEFAULT_BOARD_TITLE
      : normalizeBoardTitle(requestedTitle)
    const id = assertBoardId(this.createId())
    const now = this.now()
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new BoardError('BOARD_STORAGE_ERROR', 500, 'Board timestamp is not a safe millisecond value')
    }
    this.repository.createBoard(id, title, now, folderId)
    notifyAttachmentReferencesChanged()
    const board = this.repository.getBoard(id)
    if (!board) throw new BoardError('BOARD_STORAGE_ERROR', 500, 'Board disappeared after creation')
    return board
  }

  getBoardMetadata(boardId: string): BoardMetadata {
    const metadata = this.repository.getBoardMetadata(assertBoardId(boardId))
    if (!metadata) throw new BoardError('BOARD_NOT_FOUND', 404, 'Board was not found')
    return metadata
  }

  listBoards(): BoardMetadata[] {
    return this.repository.listBoards()
  }

  search(query: unknown, limit?: unknown): BoardSearchItem[] {
    const normalizedQuery = normalizeBoardSearchQuery(query)
    const resultLimit = normalizeBoardSearchLimit(limit)
    if (!normalizedQuery) return []

    const needle = normalizeSearchText(normalizedQuery).toLocaleLowerCase()
    const candidates: Array<{ priority: number; item: BoardSearchItem }> = []
    for (const record of this.repository.listBoardSearchRecords()) {
      const foldedTitle = normalizeSearchText(record.title).toLocaleLowerCase()
      const revision = Number.isSafeInteger(record.revision) && (record.revision ?? -1) >= 0
        ? record.revision!
        : 0
      if (foldedTitle === needle) {
        candidates.push({ priority: 0, item: searchItem(record, revision, 'title') })
        continue
      }
      if (foldedTitle.includes(needle)) {
        candidates.push({ priority: 1, item: searchItem(record, revision, 'title') })
        continue
      }

      const bodyMatch = findBodyMatch(record, needle)
      if (bodyMatch) {
        candidates.push({
          priority: 2,
          item: {
            ...searchItem(record, revision, 'body'),
            snippet: makeSearchSnippet(bodyMatch.text, needle),
            elementId: bodyMatch.elementId,
          },
        })
      }
    }

    candidates.sort((left, right) => left.priority - right.priority
      || right.item.updatedAt - left.item.updatedAt
      || right.item.boardId.localeCompare(left.item.boardId))
    return candidates.slice(0, resultLimit).map(({ item }) => item)
  }

  listBoardFolders(): BoardFolderSummary[] {
    return this.repository.listBoardFolders()
  }

  createBoardFolder(input: CreateBoardFolderInput): BoardFolderSummary {
    const requestedName = typeof input === 'string' ? input : input.name
    const parentId = typeof input === 'string' ? null : normalizeNullableBoardFolderId(input.parentId)
    if (parentId !== null) {
      throw new BoardError('BOARD_VALIDATION_ERROR', 400, 'Nested Board folders are not supported')
    }
    return this.repository.createBoardFolder(
      assertBoardFolderId(this.createId()),
      normalizeBoardFolderName(requestedName),
      null,
      this.nextTimestamp(),
    )
  }

  renameBoardFolder(folderId: string, name: unknown): BoardFolderSummary {
    return this.repository.renameBoardFolder(
      assertBoardFolderId(folderId),
      normalizeBoardFolderName(name),
      this.nextTimestamp(),
    )
  }

  deleteBoardFolder(folderId: string): BoardFolderMutationResult {
    const id = assertBoardFolderId(folderId)
    if (!this.repository.deleteBoardFolder(id)) {
      throw new BoardError('BOARD_FOLDER_NOT_FOUND', 404, 'Board folder was not found')
    }
    return { deleted: true }
  }

  moveBoardToFolder(boardId: string, folderId: unknown): BoardMetadata {
    return this.repository.moveBoardToFolder(
      assertBoardId(boardId),
      normalizeNullableBoardFolderId(folderId),
    )
  }

  async getBoardPreview(boardId: string): Promise<BoardAggregate> {
    const id = assertBoardId(boardId)
    const board = this.repository.getBoard(id)
    if (!board) throw new BoardError('BOARD_NOT_FOUND', 404, 'Board was not found')
    await this.assets.assertAssetReferencesReadable(board.sceneRecord.scene.assetRefs)
    return board
  }

  async getBoard(boardId: string): Promise<BoardAggregate> {
    const id = assertBoardId(boardId)
    const board = await this.getBoardPreview(id)
    // Opening a Board is activity metadata, not a content mutation. Keep
    // updatedAt untouched so recent access cannot masquerade as an edit.
    const metadata = this.repository.markBoardOpened(id, this.nextTimestamp())
    return { ...board, metadata }
  }

  renameBoard(boardId: string, title: unknown): BoardMetadata {
    return this.repository.renameBoard(assertBoardId(boardId), normalizeBoardTitle(title), this.nextTimestamp())
  }

  async saveBoardScene(input: SaveBoardSceneInput): Promise<SaveBoardSceneResult & { readonly cleanupFailures: readonly unknown[] }> {
    const boardId = assertBoardId(input.boardId)
    const expectedRevision = assertExpectedRevision(input.expectedRevision)
    assertSupportedBoardSceneContract(input.engine, input.sceneVersion)
    const scene = normalizeBoardScene(input.scene)
    await this.assets.assertAssetReferencesReadable(scene.assetRefs)

    const saved = this.repository.saveBoardScene({
      ...input,
      boardId,
      expectedRevision,
      engine: BOARD_ENGINE_EXCALIDRAW,
      sceneVersion: CURRENT_BOARD_SCENE_VERSION,
      scene,
    }, this.nextTimestamp())
    const cleanupFailures = await this.cleanupAssetIds(saved.removedAssetIds)
    return { ...saved, cleanupFailures }
  }

  async setThumbnailAsset(boardId: string, assetId: string | null): Promise<{ readonly thumbnailAssetId: string | null; readonly cleanupFailures: readonly unknown[] }> {
    const id = assertBoardId(boardId)
    const normalizedAssetId = assetId === null ? null : assertAssetId(assetId)
    if (normalizedAssetId) await this.assets.assertAssetReferencesReadable([normalizedAssetId])
    const oldAssetIds = this.repository.replaceThumbnailReference(id, normalizedAssetId, this.nextTimestamp())
    const cleanupFailures = await this.cleanupAssetIds(oldAssetIds)
    return { thumbnailAssetId: normalizedAssetId, cleanupFailures }
  }

  async deleteBoard(boardId: string): Promise<BoardMutationResult> {
    const id = assertBoardId(boardId)
    const candidateAssetIds = this.repository.deleteBoard(id)
    if (!candidateAssetIds) throw new BoardError('BOARD_NOT_FOUND', 404, 'Board was not found')
    notifyAttachmentReferencesChanged()
    const cleanupFailures = await this.cleanupAssetIds(candidateAssetIds)
    return { deleted: true, cleanupFailures }
  }

  private nextTimestamp(): number {
    const timestamp = this.now()
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
      throw new BoardError('BOARD_STORAGE_ERROR', 500, 'Board timestamp is not a safe millisecond value')
    }
    return timestamp
  }

  private async cleanupAssetIds(assetIds: readonly string[]): Promise<unknown[]> {
    const failures: unknown[] = []
    for (const assetId of new Set(assetIds)) {
      const result = await this.assets.tryClaimUnreferencedAssetForDeletion(assetId)
      if (result.error !== undefined) failures.push({ assetId, error: result.error })
    }
    return failures
  }
}

function normalizeSearchText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

function searchItem(record: BoardSearchRecord, revision: number, match: 'title' | 'body'): BoardSearchItem {
  return {
    boardId: record.id,
    title: record.title,
    match,
    revision,
    updatedAt: record.updatedAt,
  }
}

function findBodyMatch(record: BoardSearchRecord, needle: string): { elementId: string; text: string } | null {
  if (record.engine !== BOARD_ENGINE_EXCALIDRAW
    || record.sceneVersion === null
    || record.sceneVersion < 1
    || record.sceneVersion > CURRENT_BOARD_SCENE_VERSION
    || !record.engineDataJson) return null

  try {
    const engineData: unknown = JSON.parse(record.engineDataJson)
    for (const element of extractBoardSearchText(engineData)) {
      const text = normalizeSearchText(element.text)
      if (text.toLocaleLowerCase().includes(needle)) return { elementId: element.elementId, text }
    }
  } catch {
    // A damaged or unsupported scene should not hide a matching Board title
    // or prevent other saved Boards from being searched.
  }
  return null
}

function makeSearchSnippet(text: string, needle: string): string {
  const characters = Array.from(text)
  const hitStart = Array.from(text.slice(0, text.toLocaleLowerCase().indexOf(needle))).length
  const hitLength = Array.from(needle).length
  const hitEnd = Math.min(characters.length, hitStart + hitLength)
  const context = Math.max(0, 160 - hitLength)
  let before = Math.min(hitStart, Math.ceil(context / 2))
  let after = Math.min(characters.length - hitEnd, context - before)
  before = Math.min(hitStart, context - after)
  return characters.slice(hitStart - before, hitEnd + after).join('')
}

export function createBoardService(
  db: DatabaseT,
  dependencies: BoardServiceDependencies = {},
): BoardService {
  return new BoardService(db, dependencies)
}

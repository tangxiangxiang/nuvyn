import { Hono } from 'hono'
import { readBoundedJson } from '../apiBody.js'
import { apiErrorResponse } from '../apiErrors.js'
import { getDb } from '../db.js'
import { BoardError } from './errors.js'
import { createBoardService, type BoardService } from './service.js'
import type { BoardScene } from '../../shared/boardProtocol.js'

export const BOARD_SCENE_MAX_JSON_BYTES = 5 * 1024 * 1024

export type BoardServiceFactory = () => BoardService

let boardServiceOverride: BoardService | null = null

/** Test-only service injection; production routes always resolve the current DB. */
export function __setBoardServiceForTesting(service: BoardService | null): void {
  boardServiceOverride = service
}

export function boardServiceForRequest(): BoardService {
  return boardServiceOverride ?? createBoardService(getDb())
}

function parseObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BoardError('BOARD_VALIDATION_ERROR', 400, 'Request body must be a JSON object')
  }
  return value as Record<string, unknown>
}

async function readBoardObject(request: Request, tooLargeCode: string, tooLargeMessage: string): Promise<Record<string, unknown>> {
  return parseObject(await readBoundedJson(
    request,
    BOARD_SCENE_MAX_JSON_BYTES,
    tooLargeCode,
    tooLargeMessage,
  ))
}

export function createBoardRoutes(getService: BoardServiceFactory = boardServiceForRequest): Hono {
  const routes = new Hono()

  routes.get('/', (c) => {
    try {
      return c.json(getService().listBoards())
    } catch (error) {
      return apiErrorResponse(c, error, {
        code: 'BOARD_INTERNAL_ERROR',
        message: 'Board request failed.',
      })
    }
  })

  routes.post('/', async (c) => {
    try {
      const body = await readBoardObject(
        c.req.raw,
        'BOARD_REQUEST_TOO_LARGE',
        'Board request body exceeds the size limit',
      )
      const board = getService().createBoard({
        title: Object.hasOwn(body, 'title') ? body.title : undefined,
        folderId: Object.hasOwn(body, 'folderId') ? body.folderId : null,
      })
      return c.json(board, 201)
    } catch (error) {
      return apiErrorResponse(c, error, {
        code: 'BOARD_INTERNAL_ERROR',
        message: 'Board could not be created.',
      })
    }
  })

  // Keep the metadata fallback available when a Board scene is damaged. It
  // deliberately does not mark the Board as opened.
  routes.get('/:boardId/metadata', (c) => {
    try {
      return c.json(getService().getBoardMetadata(c.req.param('boardId')))
    } catch (error) {
      return apiErrorResponse(c, error, {
        code: 'BOARD_INTERNAL_ERROR',
        message: 'Board metadata could not be loaded.',
      })
    }
  })

  routes.get('/:boardId', async (c) => {
    try {
      return c.json(await getService().getBoard(c.req.param('boardId')))
    } catch (error) {
      return apiErrorResponse(c, error, {
        code: 'BOARD_INTERNAL_ERROR',
        message: 'Board could not be loaded.',
      })
    }
  })

  routes.patch('/:boardId', async (c) => {
    try {
      const body = await readBoardObject(
        c.req.raw,
        'BOARD_REQUEST_TOO_LARGE',
        'Board request body exceeds the size limit',
      )
      const metadata = getService().renameBoard(c.req.param('boardId'), body.title)
      return c.json(metadata)
    } catch (error) {
      return apiErrorResponse(c, error, {
        code: 'BOARD_INTERNAL_ERROR',
        message: 'Board could not be renamed.',
      })
    }
  })

  routes.patch('/:boardId/folder', async (c) => {
    try {
      const body = await readBoardObject(
        c.req.raw,
        'BOARD_REQUEST_TOO_LARGE',
        'Board request body exceeds the size limit',
      )
      if (!Object.hasOwn(body, 'folderId')
        || (body.folderId !== null && typeof body.folderId !== 'string')) {
        throw new BoardError('BOARD_VALIDATION_ERROR', 400, 'Board folderId must be a string or null')
      }
      return c.json(getService().moveBoardToFolder(c.req.param('boardId'), body.folderId))
    } catch (error) {
      return apiErrorResponse(c, error, {
        code: 'BOARD_INTERNAL_ERROR',
        message: 'Board folder could not be updated.',
      })
    }
  })

  routes.put('/:boardId/scene', async (c) => {
    try {
      const body = await readBoardObject(
        c.req.raw,
        'BOARD_SCENE_TOO_LARGE',
        'Board scene body exceeds the size limit',
      )
      if (typeof body.engine !== 'string') {
        throw new BoardError('BOARD_VALIDATION_ERROR', 400, 'Board scene engine must be a string')
      }
      const result = await getService().saveBoardScene({
        boardId: c.req.param('boardId'),
        expectedRevision: body.expectedRevision as number,
        engine: body.engine,
        sceneVersion: body.sceneVersion as number,
        scene: body.scene as BoardScene,
      })
      return c.json({ revision: result.revision, updatedAt: result.updatedAt })
    } catch (error) {
      return apiErrorResponse(c, error, {
        code: 'BOARD_INTERNAL_ERROR',
        message: 'Board scene could not be saved.',
      })
    }
  })

  routes.put('/:boardId/thumbnail', async (c) => {
    try {
      const body = await readBoardObject(
        c.req.raw,
        'BOARD_REQUEST_TOO_LARGE',
        'Board request body exceeds the size limit',
      )
      if (!Object.hasOwn(body, 'assetId')
        || (body.assetId !== null && typeof body.assetId !== 'string')) {
        throw new BoardError('BOARD_VALIDATION_ERROR', 400, 'Thumbnail assetId must be a UUID or null')
      }
      const result = await getService().setThumbnailAsset(
        c.req.param('boardId'),
        body.assetId as string | null,
      )
      return c.json({ thumbnailAssetId: result.thumbnailAssetId })
    } catch (error) {
      return apiErrorResponse(c, error, {
        code: 'BOARD_INTERNAL_ERROR',
        message: 'Board thumbnail could not be updated.',
      })
    }
  })

  routes.delete('/:boardId', async (c) => {
    try {
      await getService().deleteBoard(c.req.param('boardId'))
      return c.body(null, 204)
    } catch (error) {
      return apiErrorResponse(c, error, {
        code: 'BOARD_INTERNAL_ERROR',
        message: 'Board could not be deleted.',
      })
    }
  })

  return routes
}

export default createBoardRoutes()

import { Hono } from 'hono'
import { readBoundedJson } from '../apiBody.js'
import { apiErrorResponse } from '../apiErrors.js'
import { BoardError } from './errors.js'
import { boardServiceForRequest, type BoardServiceFactory } from './routes.js'

const BOARD_FOLDER_MAX_JSON_BYTES = 64 * 1024

function parseObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BoardError('BOARD_VALIDATION_ERROR', 400, 'Request body must be a JSON object')
  }
  return value as Record<string, unknown>
}

async function readFolderObject(request: Request): Promise<Record<string, unknown>> {
  return parseObject(await readBoundedJson(
    request,
    BOARD_FOLDER_MAX_JSON_BYTES,
    'BOARD_REQUEST_TOO_LARGE',
    'Board folder request body exceeds the size limit',
  ))
}

export function createBoardFolderRoutes(getService: BoardServiceFactory = boardServiceForRequest): Hono {
  const routes = new Hono()

  routes.get('/', (c) => {
    try {
      return c.json(getService().listBoardFolders())
    } catch (error) {
      return apiErrorResponse(c, error, {
        code: 'BOARD_INTERNAL_ERROR',
        message: 'Board folders could not be loaded.',
      })
    }
  })

  routes.post('/', async (c) => {
    try {
      const body = await readFolderObject(c.req.raw)
      return c.json(getService().createBoardFolder({
        name: Object.hasOwn(body, 'name') ? body.name : undefined,
        parentId: Object.hasOwn(body, 'parentId') ? body.parentId : null,
      }), 201)
    } catch (error) {
      return apiErrorResponse(c, error, {
        code: 'BOARD_INTERNAL_ERROR',
        message: 'Board folder could not be created.',
      })
    }
  })

  routes.patch('/:folderId', async (c) => {
    try {
      const body = await readFolderObject(c.req.raw)
      return c.json(getService().renameBoardFolder(c.req.param('folderId'), body.name))
    } catch (error) {
      return apiErrorResponse(c, error, {
        code: 'BOARD_INTERNAL_ERROR',
        message: 'Board folder could not be renamed.',
      })
    }
  })

  routes.delete('/:folderId', (c) => {
    try {
      getService().deleteBoardFolder(c.req.param('folderId'))
      return c.body(null, 204)
    } catch (error) {
      return apiErrorResponse(c, error, {
        code: 'BOARD_INTERNAL_ERROR',
        message: 'Board folder could not be deleted.',
      })
    }
  })

  return routes
}

export default createBoardFolderRoutes()

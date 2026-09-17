import { Hono } from 'hono'
import { readBoundedJson } from '../apiBody.js'
import { apiErrorResponse } from '../apiErrors.js'
import { getDb } from '../db.js'
import { BoardMaterialError } from './materialErrors.js'
import { createBoardMaterialService, type BoardMaterialService } from './materialService.js'

const BOARD_MATERIAL_MAX_JSON_BYTES = 3 * 1024 * 1024

export type BoardMaterialServiceFactory = () => BoardMaterialService

let boardMaterialServiceOverride: BoardMaterialService | null = null

/** Test-only service injection; production routes always resolve the current DB. */
export function __setBoardMaterialServiceForTesting(service: BoardMaterialService | null): void {
  boardMaterialServiceOverride = service
}

function boardMaterialServiceForRequest(): BoardMaterialService {
  return boardMaterialServiceOverride ?? createBoardMaterialService(getDb())
}

function parseObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BoardMaterialError('BOARD_MATERIAL_VALIDATION_ERROR', 400, 'Request body must be a JSON object')
  }
  return value as Record<string, unknown>
}

async function readMaterialObject(request: Request): Promise<Record<string, unknown>> {
  return parseObject(await readBoundedJson(
    request,
    BOARD_MATERIAL_MAX_JSON_BYTES,
    'BOARD_MATERIAL_REQUEST_TOO_LARGE',
    'Board material request body exceeds the size limit',
  ))
}

function parseArchived(value: string | undefined): boolean {
  if (value === undefined || value === 'false') return false
  if (value === 'true') return true
  throw new BoardMaterialError('BOARD_MATERIAL_VALIDATION_ERROR', 400, 'archived must be true or false')
}

export function createBoardMaterialRoutes(
  getService: BoardMaterialServiceFactory = boardMaterialServiceForRequest,
): Hono {
  const routes = new Hono()

  routes.get('/', (c) => {
    try {
      return c.json(getService().list(parseArchived(c.req.query('archived'))))
    } catch (error) {
      return apiErrorResponse(c, error, {
        code: 'BOARD_MATERIAL_INTERNAL_ERROR',
        message: 'Board materials could not be loaded.',
      })
    }
  })

  routes.post('/', async (c) => {
    try {
      const body = await readMaterialObject(c.req.raw)
      return c.json(getService().create({ name: body.name, svg: body.svg }), 201)
    } catch (error) {
      return apiErrorResponse(c, error, {
        code: 'BOARD_MATERIAL_INTERNAL_ERROR',
        message: 'Board material could not be created.',
      })
    }
  })

  routes.patch('/:materialId', async (c) => {
    try {
      const body = await readMaterialObject(c.req.raw)
      return c.json(getService().rename(c.req.param('materialId'), body.name))
    } catch (error) {
      return apiErrorResponse(c, error, {
        code: 'BOARD_MATERIAL_INTERNAL_ERROR',
        message: 'Board material could not be renamed.',
      })
    }
  })

  routes.post('/:materialId/archive', (c) => {
    try {
      return c.json(getService().archive(c.req.param('materialId')))
    } catch (error) {
      return apiErrorResponse(c, error, {
        code: 'BOARD_MATERIAL_INTERNAL_ERROR',
        message: 'Board material could not be archived.',
      })
    }
  })

  routes.post('/:materialId/restore', (c) => {
    try {
      return c.json(getService().restore(c.req.param('materialId')))
    } catch (error) {
      return apiErrorResponse(c, error, {
        code: 'BOARD_MATERIAL_INTERNAL_ERROR',
        message: 'Board material could not be restored.',
      })
    }
  })

  routes.delete('/:materialId', (c) => {
    try {
      getService().delete(c.req.param('materialId'))
      return c.body(null, 204)
    } catch (error) {
      return apiErrorResponse(c, error, {
        code: 'BOARD_MATERIAL_INTERNAL_ERROR',
        message: 'Board material could not be deleted.',
      })
    }
  })

  return routes
}

export default createBoardMaterialRoutes()

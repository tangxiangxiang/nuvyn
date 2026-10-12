import type { Database as DatabaseT } from 'better-sqlite3'
import { Hono } from 'hono'
import type { AttachmentCatalogAdapter, AttachmentCatalogAdapters, AttachmentCatalogReferenceProjection } from './catalog.js'
import { AttachmentCatalog, isAttachmentReferenceStatus, isAttachmentSource, isAttachmentType } from './catalog.js'
import { listBoardAssetCatalog } from './adapters/boardAssets.js'
import { listBoardMaterialCatalog } from './adapters/boardMaterials.js'
import { scanVaultAttachments } from './adapters/vaultFiles.js'
import { CONTENT_DIR } from '../paths.js'
import { getDb } from '../db.js'
import { ApiRequestError, apiErrorResponse } from '../apiErrors.js'
import { readBoundedJson } from '../apiBody.js'
import {
  getAttachmentReferenceIndex,
  isAttachmentResourceKey,
  attachmentResourceStableKey,
  type AttachmentReferenceIndex,
} from './references.js'
import type { AttachmentResourceKey } from '../../shared/attachmentProtocol.js'

let defaultCatalog: { db: DatabaseT; contentDir: string; catalog: AttachmentCatalog } | null = null
let catalogOverride: AttachmentCatalog | null = null
let referenceIndexOverride: AttachmentReferenceIndex | null = null

function createDatabaseAdapter(
  source: AttachmentCatalogAdapter['source'],
  scan: AttachmentCatalogAdapter['scan'],
): AttachmentCatalogAdapter {
  return { source, scan }
}

function createDefaultCatalog(db: DatabaseT): AttachmentCatalog {
  const adapters: AttachmentCatalogAdapters = {
    boardAssets: createDatabaseAdapter('board-asset', async () => ({
      items: listBoardAssetCatalog(db),
      complete: true,
    })),
    vaultFiles: createDatabaseAdapter('vault-file', async (signal) => scanVaultAttachments(CONTENT_DIR, signal)),
    boardMaterials: createDatabaseAdapter('board-material', async () => ({
      items: listBoardMaterialCatalog(db),
      complete: true,
    })),
  }
  return new AttachmentCatalog(adapters)
}

function getCatalog(): AttachmentCatalog {
  if (catalogOverride) return catalogOverride
  const db = getDb()
  if (!defaultCatalog || defaultCatalog.db !== db || defaultCatalog.contentDir !== CONTENT_DIR) {
    defaultCatalog = { db, contentDir: CONTENT_DIR, catalog: createDefaultCatalog(db) }
  }
  return defaultCatalog.catalog
}

export function __setAttachmentCatalogForTesting(catalog: AttachmentCatalog | null): void {
  catalogOverride = catalog
  if (catalog === null) defaultCatalog = null
}

export function __setAttachmentReferenceIndexForRoutesTesting(index: AttachmentReferenceIndex | null): void {
  referenceIndexOverride = index
}

function parseInteger(value: string | undefined, fallback: number, maximum: number, name: string): number {
  if (value === undefined) return fallback
  if (!/^\d+$/.test(value)) throw new ApiRequestError('ATTACHMENT_QUERY_INVALID', 400, `${name} must be a non-negative integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new ApiRequestError('ATTACHMENT_QUERY_INVALID', 400, `${name} is outside the supported range`)
  }
  return parsed
}

function parseListQuery(url: URL) {
  const search = url.searchParams.get('search') ?? undefined
  if (search !== undefined && search.length > 200) {
    throw new ApiRequestError('ATTACHMENT_QUERY_INVALID', 400, 'search must be at most 200 characters')
  }
  const type = url.searchParams.get('type') ?? undefined
  const source = url.searchParams.get('source') ?? undefined
  const referenceStatus = url.searchParams.get('referenceStatus') ?? undefined
  if (type !== undefined && !isAttachmentType(type)) {
    throw new ApiRequestError('ATTACHMENT_QUERY_INVALID', 400, 'type is not supported')
  }
  if (source !== undefined && !isAttachmentSource(source)) {
    throw new ApiRequestError('ATTACHMENT_QUERY_INVALID', 400, 'source is not supported')
  }
  if (referenceStatus !== undefined && !isAttachmentReferenceStatus(referenceStatus)) {
    throw new ApiRequestError('ATTACHMENT_QUERY_INVALID', 400, 'referenceStatus is not supported')
  }
  const limit = parseInteger(url.searchParams.get('limit') ?? undefined, 30, 100, 'limit')
  if (limit < 1) throw new ApiRequestError('ATTACHMENT_QUERY_INVALID', 400, 'limit must be at least 1')
  return {
    search,
    type: type as 'image' | 'file' | 'material' | undefined,
    source: source as 'board-asset' | 'vault-file' | 'board-material' | undefined,
    referenceStatus: referenceStatus as 'referenced' | 'unreferenced' | 'unknown' | undefined,
    offset: parseInteger(url.searchParams.get('offset') ?? undefined, 0, 1_000_000, 'offset'),
    limit,
  }
}

function getReferenceIndex(): AttachmentReferenceIndex {
  return referenceIndexOverride ?? getAttachmentReferenceIndex(getDb(), CONTENT_DIR)
}

function parseResourceKey(value: unknown): AttachmentResourceKey {
  if (!isAttachmentResourceKey(value)) {
    throw new ApiRequestError('ATTACHMENT_RESOURCE_INVALID', 400, 'Resource identity is invalid')
  }
  if (value.kind === 'vault-file') return { kind: 'vault-file', path: value.path }
  return { kind: value.kind, id: value.id }
}

function parseReferenceQuery(value: unknown): { resource: AttachmentResourceKey; offset: number; limit: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiRequestError('ATTACHMENT_QUERY_INVALID', 400, 'Request body must be an object')
  }
  const input = value as Record<string, unknown>
  const resource = parseResourceKey(input.resource)
  const offset = input.offset === undefined ? 0 : input.offset
  const limit = input.limit === undefined ? 30 : input.limit
  if (!Number.isSafeInteger(offset) || Number(offset) < 0 || Number(offset) > 1_000_000) {
    throw new ApiRequestError('ATTACHMENT_QUERY_INVALID', 400, 'offset is outside the supported range')
  }
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100) {
    throw new ApiRequestError('ATTACHMENT_QUERY_INVALID', 400, 'limit is outside the supported range')
  }
  return { resource, offset: Number(offset), limit: Number(limit) }
}

async function readReferenceRequest(request: Request): Promise<Record<string, unknown>> {
  const value = await readBoundedJson(request, 4096, 'ATTACHMENT_REQUEST_TOO_LARGE', 'Attachment reference request is too large')
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiRequestError('ATTACHMENT_QUERY_INVALID', 400, 'Request body must be an object')
  }
  return value as Record<string, unknown>
}

export function createAttachmentRoutes(
  resolveCatalog: () => AttachmentCatalog = getCatalog,
  resolveIndex: () => AttachmentReferenceIndex = getReferenceIndex,
): Hono {
  const routes = new Hono()

  routes.get('/', async (c) => {
    try {
      const index = resolveIndex()
      const projection = index.getCatalogProjection() as AttachmentCatalogReferenceProjection | null
      const result = await resolveCatalog().list(parseListQuery(new URL(c.req.url)), projection ?? undefined)
      c.header('Cache-Control', 'no-store')
      return c.json(result)
    } catch (error) {
      return apiErrorResponse(c, error, {
        code: 'ATTACHMENT_CATALOG_UNAVAILABLE',
        message: 'Attachment catalog could not be loaded.',
      })
    }
  })

  routes.get('/summary', async (c) => {
    try {
      const projection = resolveIndex().getCatalogProjection() as AttachmentCatalogReferenceProjection | null
      const summary = await resolveCatalog().getSummary(projection ?? undefined)
      c.header('Cache-Control', 'no-store')
      return c.json(summary)
    } catch (error) {
      return apiErrorResponse(c, error, {
        code: 'ATTACHMENT_CATALOG_UNAVAILABLE',
        message: 'Attachment summary could not be loaded.',
      })
    }
  })

  routes.get('/index-status', (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(resolveCatalog().getIndexStatus())
  })

  routes.post('/refresh', async (c) => {
    try {
      const catalog = resolveCatalog()
      await catalog.refresh(true)
      c.header('Cache-Control', 'no-store')
      return c.json({
        indexStatus: catalog.getIndexStatus(),
        summary: await catalog.getSummary(),
      })
    } catch (error) {
      return apiErrorResponse(c, error, {
        code: 'ATTACHMENT_CATALOG_UNAVAILABLE',
        message: 'Attachment catalog could not be refreshed.',
      })
    }
  })

  routes.get('/references/status', (c) => {
    const index = resolveIndex()
    if (index.getStatus().state === 'pending') void index.refresh().catch(() => {})
    c.header('Cache-Control', 'no-store')
    return c.json(index.getStatus())
  })

  routes.post('/references/refresh', async (c) => {
    try {
      const index = resolveIndex()
      await index.refresh(true)
      c.header('Cache-Control', 'no-store')
      return c.json(index.getStatus())
    } catch (error) {
      return apiErrorResponse(c, error, {
        code: 'ATTACHMENT_REFERENCES_UNAVAILABLE',
        message: 'Attachment references could not be refreshed.',
      })
    }
  })

  routes.post('/references/query', async (c) => {
    try {
      const input = parseReferenceQuery(await readReferenceRequest(c.req.raw))
      const index = resolveIndex()
      if (
        !await resolveCatalog().hasResourceKey(attachmentResourceStableKey(input.resource))
        || !await index.hasResource(input.resource)
      ) {
        throw new ApiRequestError('ATTACHMENT_RESOURCE_NOT_FOUND', 404, 'Attachment resource is unavailable')
      }
      const result = await index.query(input.resource, input.offset, input.limit)
      c.header('Cache-Control', 'no-store')
      return c.json(result)
    } catch (error) {
      return apiErrorResponse(c, error, {
        code: 'ATTACHMENT_REFERENCES_UNAVAILABLE',
        message: 'Attachment references could not be loaded.',
      })
    }
  })

  routes.post('/cleanup-preview', async (c) => {
    try {
      const body = await readReferenceRequest(c.req.raw)
      const resource = parseResourceKey(body.resource)
      const index = resolveIndex()
      if (
        !await resolveCatalog().hasResourceKey(attachmentResourceStableKey(resource))
        || !await index.hasResource(resource)
      ) {
        throw new ApiRequestError('ATTACHMENT_RESOURCE_NOT_FOUND', 404, 'Attachment resource is unavailable')
      }
      const result = await index.preview(resource)
      c.header('Cache-Control', 'no-store')
      return c.json(result)
    } catch (error) {
      return apiErrorResponse(c, error, {
        code: 'ATTACHMENT_PREVIEW_UNAVAILABLE',
        message: 'Attachment cleanup risk could not be checked.',
      })
    }
  })

  return routes
}

export default createAttachmentRoutes()

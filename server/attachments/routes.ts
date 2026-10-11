import type { Database as DatabaseT } from 'better-sqlite3'
import { Hono } from 'hono'
import type { AttachmentCatalogAdapter, AttachmentCatalogAdapters } from './catalog.js'
import { AttachmentCatalog, isAttachmentReferenceStatus, isAttachmentSource, isAttachmentType } from './catalog.js'
import { listBoardAssetCatalog } from './adapters/boardAssets.js'
import { listBoardMaterialCatalog } from './adapters/boardMaterials.js'
import { scanVaultAttachments } from './adapters/vaultFiles.js'
import { CONTENT_DIR } from '../paths.js'
import { getDb } from '../db.js'
import { ApiRequestError, apiErrorResponse } from '../apiErrors.js'

let defaultCatalog: { db: DatabaseT; contentDir: string; catalog: AttachmentCatalog } | null = null
let catalogOverride: AttachmentCatalog | null = null

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

export function createAttachmentRoutes(resolveCatalog: () => AttachmentCatalog = getCatalog): Hono {
  const routes = new Hono()

  routes.get('/', async (c) => {
    try {
      const result = await resolveCatalog().list(parseListQuery(new URL(c.req.url)))
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
      const summary = await resolveCatalog().getSummary()
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
      return c.json({ indexStatus: catalog.getIndexStatus(), summary: await catalog.getSummary() })
    } catch (error) {
      return apiErrorResponse(c, error, {
        code: 'ATTACHMENT_CATALOG_UNAVAILABLE',
        message: 'Attachment catalog could not be refreshed.',
      })
    }
  })

  return routes
}

export default createAttachmentRoutes()

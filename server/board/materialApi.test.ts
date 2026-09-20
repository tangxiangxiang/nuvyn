import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../db.js'
import { BoardMaterialService } from './materialService.js'
import { createBoardMaterialRoutes } from './materialRoutes.js'

const SVG = '\uFEFF \n<?xml version="1.0"?>\n<!-- material -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><rect width="20" height="10" /></svg>'

type Fixture = {
  db: Database.Database
  service: BoardMaterialService
  routes: ReturnType<typeof createBoardMaterialRoutes>
}

function createFixture(): Fixture {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  const service = new BoardMaterialService(db, { now: () => 1_700_000_000_000 })
  return { db, service, routes: createBoardMaterialRoutes(() => service) }
}

async function request(fixture: Fixture, path: string, init: RequestInit = {}): Promise<Response> {
  return fixture.routes.fetch(new Request(`http://localhost${path}`, init))
}

async function json<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>
}

describe('Board Material API', () => {
  let fixture: Fixture

  beforeEach(() => { fixture = createFixture() })
  afterEach(() => { fixture.db.close() })

  it('migrates the material table to the next schema version', () => {
    const legacy = new Database(':memory:')
    applyMigrations(legacy, 33)
    expect((legacy.prepare('SELECT version FROM schema_version').get() as { version: number }).version).toBe(33)
    applyMigrations(legacy)
    expect((legacy.prepare('SELECT version FROM schema_version').get() as { version: number }).version).toBe(35)
    expect(legacy.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'board_materials'").get()).toEqual({ name: 'board_materials' })
    legacy.close()
  })

  it('creates and lists active SVG materials, preserving the original text', async () => {
    const created = await request(fixture, '/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '  Flow  ', svg: SVG }),
    })
    expect(created.status).toBe(201)
    const material = await json<{ id: string; name: string; kind: string; svg: string; archived: boolean }>(created)
    expect(material).toMatchObject({ name: 'Flow', kind: 'svg', svg: SVG, archived: false })
    expect(material.id).toMatch(/^[0-9a-f-]{36}$/)

    const listed = await request(fixture, '/')
    expect(await json<typeof material[]>(listed)).toEqual([material])
    expect(await request(fixture, '/?archived=true').then(json)).toEqual([])
  })

  it.each([
    ['empty', ''],
    ['fake html', '<html><body>not svg</body></html>'],
    ['plain text', 'hello'],
    ['json', '{"svg":true}'],
  ])('rejects %s SVG content', async (_label, svg) => {
    const response = await request(fixture, '/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Invalid', svg }),
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(await json<{ code: string }>(response)).toMatchObject({ code: 'BOARD_MATERIAL_SVG_INVALID' })
  })

  it('rejects an oversized SVG before persistence', async () => {
    const oversized = `<svg>${'x'.repeat(2 * 1024 * 1024)}</svg>`
    const response = await request(fixture, '/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Large', svg: oversized }),
    })
    expect(response.status).toBe(413)
    expect(await json<{ code: string }>(response)).toMatchObject({ code: 'BOARD_MATERIAL_SVG_TOO_LARGE' })
    expect(fixture.service.list()).toEqual([])
  })

  it('supports rename, archive, archived listing, restore, and permanent delete', async () => {
    const material = fixture.service.create({ name: 'Original', svg: SVG })
    const renamed = await request(fixture, `/${material.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed' }),
    })
    expect(await json<{ name: string }>(renamed)).toMatchObject({ name: 'Renamed' })

    const archived = await request(fixture, `/${material.id}/archive`, { method: 'POST' })
    expect(await json<{ archived: boolean }>(archived)).toMatchObject({ archived: true })
    expect(await request(fixture, '/').then(json)).toEqual([])
    expect(await request(fixture, '/?archived=true').then(json)).toHaveLength(1)

    const restored = await request(fixture, `/${material.id}/restore`, { method: 'POST' })
    expect(await json<{ archived: boolean }>(restored)).toMatchObject({ archived: false })
    const archivedAgain = await request(fixture, `/${material.id}/archive`, { method: 'POST' })
    expect((await json<{ archived: boolean }>(archivedAgain)).archived).toBe(true)
    const deleted = await request(fixture, `/${material.id}`, { method: 'DELETE' })
    expect(deleted.status).toBe(204)
    expect(fixture.service.list(true)).toEqual([])
  })

  it('does not allow permanent deletion of an active material and reports missing IDs', async () => {
    const material = fixture.service.create({ name: 'Active', svg: SVG })
    const activeDelete = await request(fixture, `/${material.id}`, { method: 'DELETE' })
    expect(activeDelete.status).toBe(409)
    expect(await json<{ code: string }>(activeDelete)).toMatchObject({ code: 'BOARD_MATERIAL_NOT_ARCHIVED' })

    const missing = await request(fixture, '/00000000-0000-4000-8000-000000000000/archive', { method: 'POST' })
    expect(missing.status).toBe(404)
    expect(await json<{ code: string }>(missing)).toMatchObject({ code: 'BOARD_MATERIAL_NOT_FOUND' })
  })
})

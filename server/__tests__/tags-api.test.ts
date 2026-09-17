import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import app from '../index'
import { applyMigrations } from '../db'
import {
  resetTagIdentityHealthForTesting,
  runTagIdentityMigrationForTesting,
} from '../tagIdentityMigration'
import { __setMetadataDbForTesting } from '../routes/shared'
import { closeAuthTestContext, createAuthenticatedTestContext, type AuthenticatedTestContext } from './helpers/auth'

const mockPathState = vi.hoisted(() => ({ root: '' }))
let root: string
const db = new Database(':memory:')
db.pragma('foreign_keys = ON')
applyMigrations(db)
let auth: AuthenticatedTestContext

vi.mock('../paths.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../paths.js')>()
  return {
    ...original,
    get CONTENT_DIR() { return mockPathState.root || original.CONTENT_DIR },
  }
})

beforeAll(() => {
  __setMetadataDbForTesting(db)
  auth = createAuthenticatedTestContext({ db })
})

afterAll(() => {
  closeAuthTestContext(auth)
  __setMetadataDbForTesting(null)
  db.close()
})

beforeEach(async () => {
  db.exec('DELETE FROM metadata_migrations; DELETE FROM document_tags; DELETE FROM documents; DELETE FROM tags;')
  db.prepare('DELETE FROM settings WHERE key LIKE ?').run('internal.tags.identity.%')
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-tags-api-'))
  mockPathState.root = root
})

afterEach(async () => {
  resetTagIdentityHealthForTesting(db)
  await fs.rm(root, { recursive: true, force: true })
})

function seedHealthyTagGraph(): void {
  db.prepare('INSERT INTO tags (id, name, normalized_name) VALUES (?, ?, ?)').run(7, 'Java', 'java')
  db.prepare(`
    INSERT INTO documents (id, path, title, summary, created_at, updated_at)
    VALUES ('doc', 'doc/note', 'Note', 'Summary', 1, 1)
  `).run()
  db.prepare('INSERT INTO document_tags (document_id, tag_id) VALUES (?, ?)').run('doc', 7)
  expect(runTagIdentityMigrationForTesting(db).complete).toBe(true)
}

async function request(
  urlPath: string,
  init: { method?: string; body?: unknown; cookie?: string; contentType?: string; origin?: string } = {},
): Promise<Response> {
  const headers = new Headers()
  const body = init.body === undefined ? undefined : JSON.stringify(init.body)
  if (init.cookie !== undefined) headers.set('Cookie', init.cookie)
  if (body !== undefined) {
    headers.set('Content-Length', String(Buffer.byteLength(body)))
  }
  if (body !== undefined && init.contentType !== '') {
    headers.set('Content-Type', init.contentType ?? 'application/json')
  }
  if (init.origin !== undefined) headers.set('Origin', init.origin)
  return app.fetch(new Request(`http://localhost${urlPath}`, {
    method: init.method ?? 'GET',
    headers,
    body,
  }))
}

async function authenticated(
  urlPath: string,
  init: Omit<Parameters<typeof request>[1], 'cookie'> = {},
): Promise<Response> {
  return request(urlPath, { ...init, cookie: auth.cookie })
}

describe('Tag Management API auth and health gate', () => {
  it('rejects unauthenticated list, Preview, and Apply requests before domain work', async () => {
    const list = await request('/api/tags')
    expect(list.status).toBe(401)
    expect(list.headers.get('cache-control')).toBe('no-store')

    const preview = await request('/api/tags/operations/preview', {
      method: 'POST', body: { kind: 'remove', sourceTagId: 7 },
    })
    expect(preview.status).toBe(401)

    const apply = await request('/api/tags/operations/apply', {
      method: 'POST', body: {
        operation: { kind: 'remove', sourceTagId: 7 },
        planFingerprint: 'a'.repeat(64),
      },
    })
    expect(apply.status).toBe(401)
  })

  it('returns 503 while identity migration health is unavailable', async () => {
    const response = await authenticated('/api/tags')
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ code: 'TAG_MANAGEMENT_UNAVAILABLE' })

    const preview = await authenticated('/api/tags/operations/preview', {
      method: 'POST', body: { kind: 'remove', sourceTagId: 7 },
    })
    expect(preview.status).toBe(503)
  })

  it('detects a live Markdown file added after startup', async () => {
    seedHealthyTagGraph()
    await fs.writeFile(path.join(root, 'external.md'), '# External\n', 'utf8')

    const response = await authenticated('/api/tags')
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ code: 'TAG_MANAGEMENT_UNAVAILABLE' })

    db.prepare(`
      INSERT INTO documents (id, path, title, summary, created_at, updated_at)
      VALUES ('external', 'external', 'External', '', 1, 1)
    `).run()
    const repaired = await authenticated('/api/tags')
    expect(repaired.status).toBe(200)
  })

})

describe('Tag Management API read model and Preview', () => {
  beforeEach(() => seedHealthyTagGraph())

  it('returns stable managed tags with no-store and bounded Preview fields', async () => {
    const list = await authenticated('/api/tags')
    expect(list.status).toBe(200)
    expect(await list.json()).toEqual([
      { id: 7, normalizedName: 'java', displayName: 'Java', documentCount: 1 },
    ])
    expect(list.headers.get('cache-control')).toBe('no-store')

    const preview = await authenticated('/api/tags/operations/preview', {
      method: 'POST', body: { kind: 'rename', sourceTagId: 7, destinationName: 'Backend' },
    })
    expect(preview.status).toBe(200)
    const body = await preview.json()
    expect(body).toMatchObject({
      operation: { kind: 'rename', sourceTagId: 7, destinationName: 'Backend' },
      sourceTag: { id: 7, normalizedName: 'java', displayName: 'Java' },
      affectedCount: 1,
      sample: [{ id: 'doc', path: 'doc/note', title: 'Note' }],
      allowedToApply: true,
      healthContractVersion: 'tag-identity-v1',
    })
    expect(body.planFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(body.sample[0].summary).toBeUndefined()
    expect(body.affectedDocuments).toBeUndefined()
  })

  it('maps business conflicts to reviewable 200 Previews', async () => {
    db.prepare('INSERT INTO tags (id, name, normalized_name) VALUES (?, ?, ?)').run(9, 'Backend', 'backend')
    const response = await authenticated('/api/tags/operations/preview', {
      method: 'POST', body: { kind: 'rename', sourceTagId: 7, destinationName: 'backend' },
    })
    expect(response.status).toBe(200)
    const preview = await response.json()
    expect(preview).toMatchObject({
      allowedToApply: false,
      conflictCode: 'DESTINATION_EXISTS',
      destinationTag: { id: 9, displayName: 'Backend' },
    })

    const apply = await authenticated('/api/tags/operations/apply', {
      method: 'POST', body: {
        operation: { kind: 'rename', sourceTagId: 7, destinationName: 'backend' },
        planFingerprint: preview.planFingerprint,
      },
    })
    expect(apply.status).toBe(409)
    expect(await apply.json()).toMatchObject({ code: 'DESTINATION_EXISTS', details: { destinationTagId: 9 } })
  })

  it('maps malformed, missing, and security-sensitive requests without SQL leakage', async () => {
    const invalid = await authenticated('/api/tags/operations/preview', {
      method: 'POST', body: { kind: 'remove', sourceTagId: '7' },
    })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ code: 'INVALID_OPERATION' })

    const missing = await authenticated('/api/tags/operations/preview', {
      method: 'POST', body: { kind: 'remove', sourceTagId: 999 },
    })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ code: 'TAG_NOT_FOUND' })

    const unknownField = await authenticated('/api/tags/operations/preview', {
      method: 'POST', body: { kind: 'remove', sourceTagId: 7, clientAffectedDocuments: [] },
    })
    expect(unknownField.status).toBe(400)

    const unsafeName = await authenticated('/api/tags/operations/preview', {
      method: 'POST', body: { kind: 'rename', sourceTagId: 7, destinationName: "x'; DROP TABLE tags;--" },
    })
    expect(unsafeName.status).toBe(200)
    expect(await unsafeName.json()).toMatchObject({ allowedToApply: true })
    expect(db.prepare("SELECT name FROM tags WHERE id = 7").get()).toEqual({ name: 'Java' })
  })

  it('fails closed for unsafe IDs, fingerprints, and persistent tag names', async () => {
    for (const sourceTagId of [0, -1, 1.5, null, '7', Number.MAX_SAFE_INTEGER + 1]) {
      const response = await authenticated('/api/tags/operations/preview', {
        method: 'POST', body: { kind: 'remove', sourceTagId },
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: 'INVALID_OPERATION' })
    }

    const invalidFingerprints: unknown[] = [
      undefined,
      null,
      42,
      '',
      'a'.repeat(63),
      'a'.repeat(65),
      'A'.repeat(64),
      'g'.repeat(64),
      ` ${'a'.repeat(64)} `,
    ]
    for (const planFingerprint of invalidFingerprints) {
      const body = planFingerprint === undefined
        ? { operation: { kind: 'remove', sourceTagId: 7 } }
        : { operation: { kind: 'remove', sourceTagId: 7 }, planFingerprint }
      const response = await authenticated('/api/tags/operations/apply', { method: 'POST', body })
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ code: 'PREVIEW_REQUIRED' })
    }

    for (const destinationName of ['', 'bad\u0000name', 'bad\u0001name', 'x'.repeat(101)]) {
      const response = await authenticated('/api/tags/operations/preview', {
        method: 'POST', body: { kind: 'rename', sourceTagId: 7, destinationName },
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: 'INVALID_TAG_NAME' })
    }

    const unicode = await authenticated('/api/tags/operations/preview', {
      method: 'POST', body: { kind: 'rename', sourceTagId: 7, destinationName: '数据/后端' },
    })
    expect(unicode.status).toBe(200)
    expect(await unicode.json()).toMatchObject({ allowedToApply: true })
  })

  it('correlates unexpected server failures without exposing internal error text', async () => {
    const throwingDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== 'prepare') return Reflect.get(target, property, receiver)
        return (sql: string) => {
          if (sql.includes('COUNT(DISTINCT dt.document_id)')) {
            throw new Error('SELECT secret_sql; stack=should-not-reach-client')
          }
          return target.prepare(sql)
        }
      },
    }) as Database.Database
    __setMetadataDbForTesting(throwingDb)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const response = await authenticated('/api/tags')
      expect(response.status).toBe(500)
      const body = await response.json() as {
        code: string
        details?: { correlationId?: string }
      }
      expect(body.code).toBe('TRANSACTION_FAILED')
      expect(body.details?.correlationId).toMatch(/^[0-9a-f-]{36}$/)
      const correlationId = body.details!.correlationId!
      expect(errorSpy.mock.calls.flat().join(' ')).toContain(correlationId)
      const serialized = JSON.stringify(body)
      expect(serialized).not.toContain('secret_sql')
      expect(serialized).not.toContain('stack=')
    } finally {
      errorSpy.mockRestore()
      __setMetadataDbForTesting(db)
    }
  })

  it('enforces JSON content type and same-origin CSRF on Preview', async () => {
    const missingType = await authenticated('/api/tags/operations/preview', {
      method: 'POST', body: { kind: 'remove', sourceTagId: 7 }, contentType: '',
    })
    expect(missingType.status).toBe(415)

    const crossOrigin = await authenticated('/api/tags/operations/preview', {
      method: 'POST', body: { kind: 'remove', sourceTagId: 7 }, origin: 'https://evil.example',
    })
    expect(crossOrigin.status).toBe(403)
  })
})

describe('Tag Management API pagination', () => {
  beforeEach(() => {
    seedHealthyTagGraph()
    db.prepare('DELETE FROM document_tags WHERE document_id = ?').run('doc')
    db.prepare('DELETE FROM documents WHERE id = ?').run('doc')
    const insertDocument = db.prepare(`
      INSERT INTO documents (id, path, title, summary, created_at, updated_at)
      VALUES (?, ?, ?, '', 1, 1)
    `)
    const insertAssociation = db.prepare('INSERT INTO document_tags (document_id, tag_id) VALUES (?, 7)')
    for (let i = 0; i < 22; i++) {
      const id = `doc-${String(i).padStart(2, '0')}`
      insertDocument.run(id, id, id)
      insertAssociation.run(id)
    }
  })

  it('recomputes fingerprint-bound pages and rejects stale/tampered cursors', async () => {
    const initial = await authenticated('/api/tags/operations/preview', {
      method: 'POST', body: { kind: 'remove', sourceTagId: 7 },
    })
    const preview = await initial.json()
    expect(preview.nextAfterDocumentId).toBe('doc-19')

    const page = await authenticated('/api/tags/operations/preview/page', {
      method: 'POST', body: {
        operation: { kind: 'remove', sourceTagId: 7 },
        planFingerprint: preview.planFingerprint,
        afterDocumentId: preview.nextAfterDocumentId,
        limit: 2,
      },
    })
    expect(page.status).toBe(200)
    expect((await page.json()).sample.map((document: { id: string }) => document.id)).toEqual(['doc-20', 'doc-21'])

    db.prepare(`
      INSERT INTO documents (id, path, title, summary, created_at, updated_at)
      VALUES ('unrelated', 'unrelated', 'Unrelated', '', 1, 1)
    `).run()
    const unrelatedPage = await authenticated('/api/tags/operations/preview/page', {
      method: 'POST', body: {
        operation: { kind: 'remove', sourceTagId: 7 },
        planFingerprint: preview.planFingerprint,
        afterDocumentId: 'doc-19',
        limit: 2,
      },
    })
    expect(unrelatedPage.status).toBe(200)

    const tampered = await authenticated('/api/tags/operations/preview/page', {
      method: 'POST', body: {
        operation: { kind: 'remove', sourceTagId: 7 },
        planFingerprint: preview.planFingerprint,
        afterDocumentId: 'not-affected',
      },
    })
    expect(tampered.status).toBe(400)
    expect(await tampered.json()).toMatchObject({ code: 'INVALID_OPERATION' })

    db.prepare('UPDATE documents SET summary = ? WHERE id = ?').run('changed', 'doc-20')
    const stale = await authenticated('/api/tags/operations/preview/page', {
      method: 'POST', body: {
        operation: { kind: 'remove', sourceTagId: 7 },
        planFingerprint: preview.planFingerprint,
        afterDocumentId: 'doc-19',
      },
    })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ code: 'PREVIEW_STALE' })
  })

  it('applies a current Preview through the authenticated Apply endpoint', async () => {
    const previewResponse = await authenticated('/api/tags/operations/preview', {
      method: 'POST', body: { kind: 'remove', sourceTagId: 7 },
    })
    expect(previewResponse.status).toBe(200)
    const preview = await previewResponse.json()
    const response = await authenticated('/api/tags/operations/apply', {
      method: 'POST', body: {
        operation: { kind: 'remove', sourceTagId: 7 },
        planFingerprint: preview.planFingerprint,
      },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      kind: 'remove',
      sourceTagId: 7,
      sourceDeleted: true,
      affectedCount: 22,
      versionUpdateCount: 22,
      appliedFingerprint: preview.planFingerprint,
    })
  })

  it('requires a current Preview and preserves Apply auth/CSRF/content boundaries', async () => {
    const missing = await authenticated('/api/tags/operations/apply', {
      method: 'POST', body: { operation: { kind: 'remove', sourceTagId: 7 } },
    })
    expect(missing.status).toBe(409)
    expect(await missing.json()).toMatchObject({ code: 'PREVIEW_REQUIRED' })

    const extra = await authenticated('/api/tags/operations/apply', {
      method: 'POST', body: {
        operation: { kind: 'remove', sourceTagId: 7 },
        planFingerprint: 'a'.repeat(64),
        affectedDocuments: [],
      },
    })
    expect(extra.status).toBe(400)
    expect(await extra.json()).toMatchObject({ code: 'INVALID_OPERATION' })

    const missingType = await authenticated('/api/tags/operations/apply', {
      method: 'POST', body: { operation: { kind: 'remove', sourceTagId: 7 }, planFingerprint: 'a'.repeat(64) }, contentType: '',
    })
    expect(missingType.status).toBe(415)

    const crossOrigin = await authenticated('/api/tags/operations/apply', {
      method: 'POST', body: { operation: { kind: 'remove', sourceTagId: 7 }, planFingerprint: 'a'.repeat(64) }, origin: 'https://evil.example',
    })
    expect(crossOrigin.status).toBe(403)
  })
})

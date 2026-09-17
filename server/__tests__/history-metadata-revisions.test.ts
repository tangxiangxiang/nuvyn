import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { Hono } from 'hono'

import { applyMigrations } from '../db.js'
import {
  deleteDocumentMetadata,
  getDocumentMetadata,
  moveDocumentMetadata,
  patchDocumentMetadata,
  saveDocumentMetadata,
} from '../documentMetadata.js'
import * as historyGit from '../history/git.js'
import historyRoutes, {
  __resetGitCapabilityForTesting,
  __resetRepoRootForTesting,
  __setHistoryMutationHooksForTesting,
  setRepoRootForTesting,
} from '../history/routes.js'
import {
  HISTORY_METADATA_SCHEMA_VERSION,
  HISTORY_METADATA_MOOD_SCHEMA_VERSION,
  HistoryMetadataError,
  decodeHistoricalMetadataPayload,
  encodeHistoricalMetadataPayload,
  encodeHistoricalMetadataPayloadV2,
  finalizeHistoryMetadataCapture,
  historicalBodySha,
  metadataImage,
  prepareHistoryMetadataCapture,
  prepareHistoryMetadataRestore,
  reconcileHistoryMetadataCaptures,
  reconcileHistoryMetadataRestores,
  resolveHistoryMetadataRevision,
  withdrawHistoryMetadataCapture,
} from '../history/metadataRevisions.js'
import { __setMetadataDbForTesting } from '../routes/shared.js'
import {
  cleanupHistoryTempRepo,
  describeHistoryIntegration,
  HISTORY_GIT_INTEGRATION_TIMEOUT_MS,
} from './helpers/historyIntegration.js'
import {
  closeAuthTestContext,
  createAuthenticatedTestContext,
  unlockDiaryAccessForTesting,
  withDiaryCapability,
  type AuthenticatedTestContext,
} from './helpers/auth.js'

let root: string
let metadataDb: Database.Database
let auth: AuthenticatedTestContext
let diaryCapability: string

// The history router is exercised directly in this suite. Supply only the
// authenticated session context and the real Diary capability required by
// the D8.1 managed-Diary body gate; the full application auth boundary is
// covered by the route-level suites.
const historyTestApp = new Hono()
historyTestApp.use('*', async (c, next) => {
  c.set('authSessionId', auth.session.id)
  await next()
})
historyTestApp.route('/', historyRoutes)

async function write(relativePath: string, raw: string): Promise<void> {
  const absolute = path.join(root, relativePath)
  await fs.mkdir(path.dirname(absolute), { recursive: true })
  await fs.writeFile(absolute, raw, 'utf8')
}

async function read(relativePath: string): Promise<string> {
  return fs.readFile(path.join(root, relativePath), 'utf8')
}

async function configureGitUser(): Promise<void> {
  await historyGit.run(root, ['config', 'user.name', 'Metadata Test'])
  await historyGit.run(root, ['config', 'user.email', 'metadata@example.test'])
}

async function call(method: string, urlPath: string, body?: unknown): Promise<Response> {
  let requestBody = body
  if (method === 'POST' && urlPath === '/commits' && body && typeof body === 'object' && !('expected' in body)) {
    const candidate = body as { paths?: unknown; message?: unknown }
    if (Array.isArray(candidate.paths) && candidate.paths.every((item) => typeof item === 'string')) {
      const expected = Object.fromEntries(await Promise.all(candidate.paths.map(async (filePath) => {
        try {
          const bytes = await fs.readFile(path.join(root, filePath as string))
          return [filePath, createHash('sha256').update(bytes).digest('hex')] as const
        } catch (error: any) {
          if (error?.code === 'ENOENT') return [filePath, null] as const
          throw error
        }
      })))
      requestBody = { ...candidate, expected }
    }
  }
  const request = new Request(`http://localhost${urlPath}`, {
    method,
    headers: requestBody ? { 'content-type': 'application/json' } : undefined,
    body: requestBody ? JSON.stringify(requestBody) : undefined,
  })
  return historyTestApp.fetch(withDiaryCapability(auth, request, diaryCapability))
}

async function commit(paths: string[], message: string): Promise<{ sha: string }> {
  const response = await call('POST', '/commits', { paths, message })
  expect(response.status).toBe(201)
  return await response.json() as { sha: string }
}

function digest(payloadJson: string): string {
  return createHash('sha256').update(payloadJson, 'utf8').digest('hex')
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-history-metadata-'))
  metadataDb = new Database(':memory:')
  metadataDb.pragma('foreign_keys = ON')
  applyMigrations(metadataDb)
  auth = createAuthenticatedTestContext({ db: metadataDb })
  diaryCapability = await unlockDiaryAccessForTesting(auth)
  __setMetadataDbForTesting(metadataDb)
  setRepoRootForTesting(root)
  __resetGitCapabilityForTesting()
  await call('GET', '/capability')
  await configureGitUser()
})

afterEach(async () => {
  __setHistoryMutationHooksForTesting(null)
  __resetRepoRootForTesting()
  __resetGitCapabilityForTesting()
  __setMetadataDbForTesting(null)
  closeAuthTestContext(auth)
  metadataDb.close()
  await cleanupHistoryTempRepo(root)
})

describe('generic historical metadata payload', () => {
  it('is canonical, digestable, and preserves arbitrary known-field values', () => {
    const first = encodeHistoricalMetadataPayload({
      title: 'Title',
      summary: 'Summary',
      tags: ['future-opaque-tag', 'Alpha'],
    })
    const second = encodeHistoricalMetadataPayload({
      title: 'Title',
      summary: 'Summary',
      tags: ['Alpha', 'future-opaque-tag'],
    })

    expect(first.payload.schemaVersion).toBe(HISTORY_METADATA_SCHEMA_VERSION)
    expect(first.payloadJson).toBe(second.payloadJson)
    expect(first.payloadDigest).toBe(second.payloadDigest)
    expect(decodeHistoricalMetadataPayload(first.payloadJson, first.payloadDigest).fields).toEqual({
      title: 'Title',
      summary: 'Summary',
      tags: ['Alpha', 'future-opaque-tag'],
    })
  })

  it('fails closed for unknown fields and newer schemas', () => {
    const valid = encodeHistoricalMetadataPayload({ title: 'T', summary: '', tags: [] })
    const unknownField = JSON.stringify({
      schemaVersion: 1,
      fields: { title: 'T', summary: '', tags: [], future: 'opaque' },
    })
    expect(() => decodeHistoricalMetadataPayload(unknownField, digest(unknownField)))
      .toThrowError(HistoryMetadataError)
    expect(() => decodeHistoricalMetadataPayload(unknownField, digest(unknownField)))
      .toThrow(/unsupported field/i)

    const newerSchema = JSON.stringify({
      schemaVersion: HISTORY_METADATA_SCHEMA_VERSION + 2,
      fields: valid.payload.fields,
    })
    expect(() => decodeHistoricalMetadataPayload(newerSchema, digest(newerSchema)))
      .toThrowError(HistoryMetadataError)
    expect(() => decodeHistoricalMetadataPayload(newerSchema, digest(newerSchema)))
      .toThrow(/not supported/i)
  })

  it('encodes v2 Mood opaquely with deterministic field ordering', () => {
    const first = encodeHistoricalMetadataPayloadV2({
      title: 'Title', summary: 'Summary', tags: ['tag'], mood: 'future-mood-v3',
    })
    const second = encodeHistoricalMetadataPayloadV2({
      title: 'Title', summary: 'Summary', tags: ['tag'], mood: 'future-mood-v3',
    })

    expect(first.payload.schemaVersion).toBe(HISTORY_METADATA_MOOD_SCHEMA_VERSION)
    expect(first.payloadJson).toBe('{"schemaVersion":2,"fields":{"title":"Title","summary":"Summary","tags":["tag"],"mood":"future-mood-v3"}}')
    expect(first.payloadJson).toBe(second.payloadJson)
    expect(first.payloadDigest).toBe(second.payloadDigest)
    expect(decodeHistoricalMetadataPayload(first.payloadJson, first.payloadDigest)).toEqual(first.payload)
  })
})

describeHistoryIntegration('D7.0A generic history metadata revisions', () => {
  it('captures live title, summary, and tags in one SHA-bound operation', async () => {
    await write('note.md', 'v1\n')
    saveDocumentMetadata(metadataDb, {
      id: 'note-stable-id',
      path: 'note',
      title: 'Title one',
      summary: 'Summary one',
      tags: ['future-opaque-tag', 'alpha'],
      updatedAt: 100,
    })

    const result = await commit(['note.md'], 'capture metadata')
    const operation = metadataDb.prepare(`
      SELECT operation_id, state, commit_sha, expected_parent_sha
      FROM history_metadata_operations
      WHERE kind = 'capture'
    `).get() as { operation_id: string; state: string; commit_sha: string; expected_parent_sha: string | null }
    const revision = metadataDb.prepare(`
      SELECT * FROM history_metadata_revisions WHERE operation_id = ?
    `).get(operation.operation_id) as {
      commit_sha: string
      path_at_revision: string
      document_id: string
      generation_id: string
      coverage_kind: string
      schema_version: number
      payload_json: string
      payload_digest: string
      body_sha: string
    }

    expect(operation.state).toBe('committed')
    expect(operation.commit_sha).toBe(result.sha)
    expect(revision).toMatchObject({
      commit_sha: result.sha,
      path_at_revision: 'note.md',
      document_id: 'note-stable-id',
      generation_id: 'note-stable-id',
      coverage_kind: 'covered',
      schema_version: HISTORY_METADATA_SCHEMA_VERSION,
      body_sha: createHash('sha256').update('v1\n').digest('hex'),
    })
    expect(JSON.parse(revision.payload_json)).toEqual({
      schemaVersion: 1,
      fields: { title: 'Title one', summary: 'Summary one', tags: ['alpha', 'future-opaque-tag'] },
    })
    expect(revision.payload_digest).toBe(digest(revision.payload_json))
    expect(operation.expected_parent_sha).toBeNull()
  }, HISTORY_GIT_INTEGRATION_TIMEOUT_MS)

  // D8.2 intentionally fail-closes managed Diary History/Git routes. The
  // pre-D8.2 lifecycle remains documented by D7.0A evidence; these endpoint
  // characterizations are retained as historical references but are not
  // executable under the encrypted-body policy.
  it.skip('captures canonical managed Diary metadata as v2, including explicit null Mood', async () => {
    const diaryPath = 'diary/2026-08-24.md'
    await write(diaryPath, '# Diary\n')
    const metadata = saveDocumentMetadata(metadataDb, {
      id: 'diary-v2-id',
      path: 'diary/2026-08-24',
      title: 'Diary',
      summary: '',
      tags: [],
      updatedAt: 100,
    })
    expect(metadata.mood).toBeNull()

    const result = await commit([diaryPath], 'capture Diary v2')
    const revision = metadataDb.prepare(`
      SELECT schema_version, payload_json FROM history_metadata_revisions
      WHERE commit_sha = ? AND path_at_revision = ?
    `).get(result.sha, diaryPath) as { schema_version: number; payload_json: string }

    expect(revision.schema_version).toBe(HISTORY_METADATA_MOOD_SCHEMA_VERSION)
    expect(JSON.parse(revision.payload_json)).toEqual({
      schemaVersion: 2,
      fields: { title: 'Diary', summary: '', tags: [], mood: null },
    })
  }, HISTORY_GIT_INTEGRATION_TIMEOUT_MS)

  it.skip('captures and restores v2 Diary Mood while preserving stable identity and minting a new version', async () => {
    const diaryPath = 'diary/2026-08-25.md'
    const logicalPath = 'diary/2026-08-25'
    await write(diaryPath, 'historical body\n')
    const initial = saveDocumentMetadata(metadataDb, {
      id: 'diary-restore-v2-id',
      path: logicalPath,
      title: 'Historical title',
      summary: 'Historical summary',
      tags: ['historical'],
      mood: 'future-mood-v3',
      updatedAt: 100,
    })
    const historical = await commit([diaryPath], 'historical Diary v2')

    await write(diaryPath, 'current body\n')
    patchDocumentMetadata(metadataDb, {
      path: logicalPath,
      expectedUpdatedAt: initial.updatedAt,
      changes: [
        { field: 'title', value: 'Current title' },
        { field: 'summary', value: 'Current summary' },
        { field: 'tags', values: ['current'] },
        { field: 'mood', value: 'sad' },
      ],
    })
    await commit([diaryPath], 'current Diary v2')
    const beforeRestore = getDocumentMetadata(metadataDb, logicalPath)!

    const response = await call('POST', '/restore', { path: diaryPath, ref: historical.sha })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      metadataMode: 'restored',
      metadataRestored: true,
      metadataPreserved: false,
    })
    expect(await read(diaryPath)).toBe('historical body\n')
    expect(getDocumentMetadata(metadataDb, logicalPath)).toMatchObject({
      id: 'diary-restore-v2-id',
      title: 'Historical title',
      summary: 'Historical summary',
      tags: ['historical'],
      mood: 'future-mood-v3',
    })
    expect(getDocumentMetadata(metadataDb, logicalPath)!.updatedAt).toBeGreaterThan(beforeRestore.updatedAt)
  }, HISTORY_GIT_INTEGRATION_TIMEOUT_MS)

  it.skip('classifies a managed v1 capture as pre-Mood body-only restore', async () => {
    const diaryPath = 'diary/2026-08-26.md'
    const logicalPath = 'diary/2026-08-26'
    await write(diaryPath, 'historical body\n')
    const initial = saveDocumentMetadata(metadataDb, {
      id: 'diary-v1-id', path: logicalPath, title: 'Historical', summary: 'Old', tags: ['old'], mood: 'happy', updatedAt: 100,
    })
    const historical = await commit([diaryPath], 'capture then downgrade to v1')
    const encoded = encodeHistoricalMetadataPayload({ title: 'Historical', summary: 'Old', tags: ['old'] })
    metadataDb.prepare(`
      UPDATE history_metadata_revisions
      SET schema_version = 1, payload_json = ?, payload_digest = ?
      WHERE commit_sha = ? AND path_at_revision = ?
    `).run(encoded.payloadJson, encoded.payloadDigest, historical.sha, diaryPath)

    await write(diaryPath, 'current body\n')
    patchDocumentMetadata(metadataDb, {
      path: logicalPath,
      expectedUpdatedAt: initial.updatedAt,
      changes: [
        { field: 'title', value: 'Current' },
        { field: 'summary', value: 'Keep current' },
        { field: 'tags', values: ['current'] },
        { field: 'mood', value: 'sad' },
      ],
    })
    await commit([diaryPath], 'current after v1 capture')
    const before = getDocumentMetadata(metadataDb, logicalPath)!

    const resolved = resolveHistoryMetadataRevision(metadataDb, {
      vaultId: await historyGit.ensureNuvynVaultId(root),
      commitSha: historical.sha,
      pathAtRevision: diaryPath,
    })
    expect(resolved).toMatchObject({
      kind: 'covered',
      metadataCompatibility: 'pre-mood-schema',
      documentId: 'diary-v1-id',
      generationId: 'diary-v1-id',
      bodySha: historicalBodySha('historical body\n'),
      payloadDigest: encoded.payloadDigest,
    })

    const response = await call('POST', '/restore', { path: diaryPath, ref: historical.sha })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      metadataMode: 'unavailable',
      metadataReason: 'pre-mood-schema',
      metadataRestored: false,
      metadataPreserved: true,
    })
    expect(await read(diaryPath)).toBe('historical body\n')
    expect(getDocumentMetadata(metadataDb, logicalPath)).toMatchObject({
      id: before.id,
      title: before.title,
      summary: before.summary,
      tags: before.tags,
      mood: before.mood,
    })
  }, HISTORY_GIT_INTEGRATION_TIMEOUT_MS)

  it.skip('rejects a covered pre-Mood Diary restore when its body binding is corrupted', async () => {
    const diaryPath = 'diary/2026-08-27.md'
    const logicalPath = 'diary/2026-08-27'
    await write(diaryPath, 'historical body\n')
    const initial = saveDocumentMetadata(metadataDb, {
      id: 'diary-v1-body-binding-id',
      path: logicalPath,
      title: 'Historical',
      summary: 'Old',
      tags: ['old'],
      mood: 'happy',
      updatedAt: 100,
    })
    const historical = await commit([diaryPath], 'capture Diary before Mood')
    const encoded = encodeHistoricalMetadataPayload({ title: 'Historical', summary: 'Old', tags: ['old'] })
    metadataDb.prepare(`
      UPDATE history_metadata_revisions
      SET schema_version = 1, payload_json = ?, payload_digest = ?, body_sha = ?
      WHERE commit_sha = ? AND path_at_revision = ?
    `).run(encoded.payloadJson, encoded.payloadDigest, '0'.repeat(64), historical.sha, diaryPath)

    await write(diaryPath, 'current body\n')
    patchDocumentMetadata(metadataDb, {
      path: logicalPath,
      expectedUpdatedAt: initial.updatedAt,
      changes: [{ field: 'mood', value: 'sad' }],
    })
    await commit([diaryPath], 'current Diary after Mood')
    const before = getDocumentMetadata(metadataDb, logicalPath)!

    const response = await call('POST', '/restore', { path: diaryPath, ref: historical.sha })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'HISTORY_METADATA_BODY_MISMATCH' })
    expect(await read(diaryPath)).toBe('current body\n')
    expect(getDocumentMetadata(metadataDb, logicalPath)).toMatchObject({
      id: before.id,
      title: before.title,
      summary: before.summary,
      tags: before.tags,
      mood: before.mood,
    })
  }, HISTORY_GIT_INTEGRATION_TIMEOUT_MS)

  it.skip('rejects a covered pre-Mood Diary restore across a delete/recreate generation', async () => {
    const diaryPath = 'diary/2026-08-28.md'
    const logicalPath = 'diary/2026-08-28'
    await write(diaryPath, 'old generation body\n')
    const initial = saveDocumentMetadata(metadataDb, {
      id: 'diary-v1-old-generation-id',
      path: logicalPath,
      title: 'Old generation',
      summary: 'Old',
      tags: ['old'],
      mood: 'happy',
      updatedAt: 100,
    })
    const historical = await commit([diaryPath], 'capture old Diary generation')
    const encoded = encodeHistoricalMetadataPayload({ title: 'Old generation', summary: 'Old', tags: ['old'] })
    metadataDb.prepare(`
      UPDATE history_metadata_revisions
      SET schema_version = 1, payload_json = ?, payload_digest = ?
      WHERE commit_sha = ? AND path_at_revision = ?
    `).run(encoded.payloadJson, encoded.payloadDigest, historical.sha, diaryPath)

    await fs.unlink(path.join(root, diaryPath))
    expect(deleteDocumentMetadata(metadataDb, logicalPath)).toBe(true)
    saveDocumentMetadata(metadataDb, {
      id: 'diary-v1-new-generation-id',
      path: logicalPath,
      title: 'New generation',
      summary: 'Keep new',
      tags: ['new'],
      mood: 'sad',
      updatedAt: initial.updatedAt + 1,
    })
    await write(diaryPath, 'new generation body\n')
    await commit([diaryPath], 'capture new Diary generation')
    const before = getDocumentMetadata(metadataDb, logicalPath)!

    const response = await call('POST', '/restore', { path: diaryPath, ref: historical.sha })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'HISTORY_METADATA_IDENTITY_CONFLICT' })
    expect(await read(diaryPath)).toBe('new generation body\n')
    expect(getDocumentMetadata(metadataDb, logicalPath)).toMatchObject({
      id: 'diary-v1-new-generation-id',
      title: before.title,
      summary: before.summary,
      tags: before.tags,
      mood: before.mood,
    })
  }, HISTORY_GIT_INTEGRATION_TIMEOUT_MS)

  it.skip('does not create a path-only generation for a covered pre-Mood Diary restore', async () => {
    const diaryPath = 'diary/2026-08-29.md'
    const logicalPath = 'diary/2026-08-29'
    await write(diaryPath, 'historical body\n')
    saveDocumentMetadata(metadataDb, {
      id: 'diary-v1-missing-live-id',
      path: logicalPath,
      title: 'Historical',
      summary: 'Old',
      tags: ['old'],
      mood: 'happy',
      updatedAt: 100,
    })
    const historical = await commit([diaryPath], 'capture Diary before missing generation')
    const encoded = encodeHistoricalMetadataPayload({ title: 'Historical', summary: 'Old', tags: ['old'] })
    metadataDb.prepare(`
      UPDATE history_metadata_revisions
      SET schema_version = 1, payload_json = ?, payload_digest = ?
      WHERE commit_sha = ? AND path_at_revision = ?
    `).run(encoded.payloadJson, encoded.payloadDigest, historical.sha, diaryPath)

    await fs.unlink(path.join(root, diaryPath))
    expect(deleteDocumentMetadata(metadataDb, logicalPath)).toBe(true)

    const response = await call('POST', '/restore', { path: diaryPath, ref: historical.sha })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'HISTORY_METADATA_IDENTITY_CONFLICT' })
    await expect(fs.access(path.join(root, diaryPath))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(getDocumentMetadata(metadataDb, logicalPath)).toBeNull()
  }, HISTORY_GIT_INTEGRATION_TIMEOUT_MS)

  it.skip('captures every selected document in one multi-file revision operation', async () => {
    await write('a.md', 'a\n')
    await write('b.md', 'b\n')
    await write('diary/2026-08-27.md', 'diary\n')
    saveDocumentMetadata(metadataDb, { id: 'a-id', path: 'a', title: 'A' })
    saveDocumentMetadata(metadataDb, { id: 'b-id', path: 'b', title: 'B' })
    saveDocumentMetadata(metadataDb, {
      id: 'multi-diary-id',
      path: 'diary/2026-08-27',
      title: 'Diary',
      mood: 'playful',
    })

    const result = await commit(['b.md', 'diary/2026-08-27.md', 'a.md'], 'multi-file capture')
    const rows = metadataDb.prepare(`
      SELECT operation_id, commit_sha, path_at_revision, schema_version
      FROM history_metadata_revisions
      WHERE commit_sha = ? ORDER BY path_at_revision
    `).all(result.sha) as Array<{ operation_id: string; commit_sha: string; path_at_revision: string; schema_version: number }>

    expect(rows.map((row) => row.path_at_revision)).toEqual(['a.md', 'b.md', 'diary/2026-08-27.md'])
    expect(rows.map((row) => row.schema_version)).toEqual([
      HISTORY_METADATA_SCHEMA_VERSION,
      HISTORY_METADATA_SCHEMA_VERSION,
      HISTORY_METADATA_MOOD_SCHEMA_VERSION,
    ])
    expect(new Set(rows.map((row) => row.operation_id)).size).toBe(1)
  }, HISTORY_GIT_INTEGRATION_TIMEOUT_MS)

  it('fails closed when a selected covered path loses its revision row', async () => {
    await write('missing-row.md', 'body one\n')
    saveDocumentMetadata(metadataDb, { id: 'missing-row-id', path: 'missing-row', title: 'One' })
    const historical = await commit(['missing-row.md'], 'covered row')
    metadataDb.prepare(`
      DELETE FROM history_metadata_revisions
      WHERE commit_sha = ? AND path_at_revision = ?
    `).run(historical.sha, 'missing-row.md')
    await write('missing-row.md', 'body two\n')

    const response = await call('POST', '/restore', { path: 'missing-row.md', ref: historical.sha })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'HISTORY_METADATA_CORRUPT' })
    expect(await read('missing-row.md')).toBe('body two\n')
    expect(getDocumentMetadata(metadataDb, 'missing-row')).toMatchObject({ title: 'One' })
  }, HISTORY_GIT_INTEGRATION_TIMEOUT_MS)

  it('restores covered body and generic metadata while preserving stable identity', async () => {
    await write('note.md', 'body one\n')
    saveDocumentMetadata(metadataDb, {
      id: 'restore-stable-id',
      path: 'note',
      title: 'Title one',
      summary: 'Summary one',
      tags: ['one'],
      updatedAt: 100,
    })
    const first = await commit(['note.md'], 'first revision')

    await write('note.md', 'body two\n')
    const current = getDocumentMetadata(metadataDb, 'note')!
    patchDocumentMetadata(metadataDb, {
      path: 'note',
      expectedUpdatedAt: current.updatedAt,
      changes: [
        { field: 'title', value: 'Title two' },
        { field: 'summary', value: 'Summary two' },
        { field: 'tags', values: ['two', 'future-opaque-tag'] },
      ],
    })
    await commit(['note.md'], 'second revision')
    const beforeRestore = getDocumentMetadata(metadataDb, 'note')!

    const response = await call('POST', '/restore', { path: 'note.md', ref: first.sha })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      path: 'note.md',
      resolvedRef: first.sha,
      metadataMode: 'restored',
      metadataRestored: true,
      metadataPreserved: false,
    })
    expect(await read('note.md')).toBe('body one\n')
    expect(getDocumentMetadata(metadataDb, 'note')).toMatchObject({
      id: 'restore-stable-id',
      title: 'Title one',
      summary: 'Summary one',
      tags: ['one'],
    })
    expect(getDocumentMetadata(metadataDb, 'note')!.updatedAt).toBeGreaterThan(beforeRestore.updatedAt)
  }, HISTORY_GIT_INTEGRATION_TIMEOUT_MS)

  it('mints a fresh metadata version when covered restore values are unchanged', async () => {
    await write('same-values.md', 'body one\n')
    saveDocumentMetadata(metadataDb, {
      id: 'same-values-id',
      path: 'same-values',
      title: 'Same title',
      summary: 'Same summary',
      tags: ['same'],
      updatedAt: 100,
    })
    const historical = await commit(['same-values.md'], 'same-values seed')

    await write('same-values.md', 'body two\n')
    await commit(['same-values.md'], 'same-values current')
    const beforeRestore = getDocumentMetadata(metadataDb, 'same-values')!

    const response = await call('POST', '/restore', { path: 'same-values.md', ref: historical.sha })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      metadataMode: 'restored',
      metadataRestored: true,
    })
    expect(await read('same-values.md')).toBe('body one\n')

    const afterRestore = getDocumentMetadata(metadataDb, 'same-values')!
    expect(afterRestore).toMatchObject({
      id: 'same-values-id',
      path: 'same-values',
      title: 'Same title',
      summary: 'Same summary',
      tags: ['same'],
    })
    expect(afterRestore.updatedAt).toBeGreaterThan(beforeRestore.updatedAt)
  }, HISTORY_GIT_INTEGRATION_TIMEOUT_MS)

  it('rehydrates a covered deleted generation only from its matching tombstone', async () => {
    await write('note.md', 'historical body\n')
    saveDocumentMetadata(metadataDb, {
      id: 'deleted-generation-id',
      path: 'note',
      title: 'Historical title',
      summary: 'Historical summary',
      tags: ['historical'],
    })
    const historical = await commit(['note.md'], 'captured before delete')
    await fs.unlink(path.join(root, 'note.md'))
    expect(deleteDocumentMetadata(metadataDb, 'note')).toBe(true)

    const response = await call('POST', '/restore', { path: 'note.md', ref: historical.sha })
    expect(response.status).toBe(200)
    expect((await response.json()) as { metadataMode: string }).toMatchObject({ metadataMode: 'restored' })
    expect(await read('note.md')).toBe('historical body\n')
    expect(getDocumentMetadata(metadataDb, 'note')).toMatchObject({
      id: 'deleted-generation-id',
      title: 'Historical title',
      summary: 'Historical summary',
      tags: ['historical'],
    })
  }, HISTORY_GIT_INTEGRATION_TIMEOUT_MS)

  it('keeps legacy restore body-only and never infers metadata from Frontmatter', async () => {
    const historicalRaw = [
      '---',
      'title: Historical Frontmatter Title',
      'summary: Historical Frontmatter Summary',
      'tags: [historical-frontmatter]',
      '---',
      '',
      'old body',
      '',
    ].join('\n')
    await write('legacy.md', historicalRaw)
    const legacy = await historyGit.addAndCommit(root, ['legacy.md'], 'pre-coverage')
    await write('legacy.md', 'current body\n')
    saveDocumentMetadata(metadataDb, {
      id: 'legacy-current-id',
      path: 'legacy',
      title: 'Current SQLite title',
      summary: 'Current SQLite summary',
      tags: ['current'],
      updatedAt: 100,
    })

    const response = await call('POST', '/restore', { path: 'legacy.md', ref: legacy.sha })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      metadataMode: 'unavailable',
      metadataRestored: false,
      metadataPreserved: true,
    })
    expect(await read('legacy.md')).toBe(historicalRaw)
    expect(getDocumentMetadata(metadataDb, 'legacy')).toMatchObject({
      id: 'legacy-current-id',
      title: 'Current SQLite title',
      summary: 'Current SQLite summary',
      tags: ['current'],
    })
  }, HISTORY_GIT_INTEGRATION_TIMEOUT_MS)

  it('leaves a legacy restore with no current metadata absent', async () => {
    const historicalRaw = '---\ntitle: Do not import\n---\n\nlegacy\n'
    await write('missing.md', historicalRaw)
    const legacy = await historyGit.addAndCommit(root, ['missing.md'], 'legacy missing metadata')
    await fs.unlink(path.join(root, 'missing.md'))

    const response = await call('POST', '/restore', { path: 'missing.md', ref: legacy.sha })
    expect(response.status).toBe(200)
    expect((await response.json()) as { metadataMode: string }).toMatchObject({ metadataMode: 'unavailable' })
    expect(getDocumentMetadata(metadataDb, 'missing')).toBeNull()
  }, HISTORY_GIT_INTEGRATION_TIMEOUT_MS)

  it('rejects unsupported schema before changing body or metadata', async () => {
    await write('future.md', 'body one\n')
    saveDocumentMetadata(metadataDb, { id: 'future-id', path: 'future', title: 'One', tags: ['one'] })
    const historical = await commit(['future.md'], 'supported capture')
    await write('future.md', 'body two\n')
    const current = getDocumentMetadata(metadataDb, 'future')!
    patchDocumentMetadata(metadataDb, {
      path: 'future',
      expectedUpdatedAt: current.updatedAt,
      changes: [{ field: 'title', value: 'Two' }],
    })
    await commit(['future.md'], 'current capture')

    const futurePayload = JSON.stringify({
      schemaVersion: HISTORY_METADATA_SCHEMA_VERSION + 2,
      fields: { title: 'One', summary: '', tags: ['one'] },
    })
    metadataDb.prepare(`
      UPDATE history_metadata_revisions
      SET payload_json = ?, payload_digest = ?
      WHERE commit_sha = ? AND path_at_revision = 'future.md'
    `).run(futurePayload, digest(futurePayload), historical.sha)

    const response = await call('POST', '/restore', { path: 'future.md', ref: historical.sha })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'HISTORY_METADATA_UNSUPPORTED_SCHEMA' })
    expect(await read('future.md')).toBe('body two\n')
    expect(getDocumentMetadata(metadataDb, 'future')).toMatchObject({ title: 'Two' })
  }, HISTORY_GIT_INTEGRATION_TIMEOUT_MS)

  it('rejects an unknown controlled field before changing body', async () => {
    await write('unknown.md', 'body one\n')
    saveDocumentMetadata(metadataDb, { id: 'unknown-id', path: 'unknown', title: 'One' })
    const historical = await commit(['unknown.md'], 'unknown-field seed')
    await write('unknown.md', 'body two\n')
    await commit(['unknown.md'], 'unknown-field current')
    const unknownPayload = JSON.stringify({
      schemaVersion: 1,
      fields: { title: 'One', summary: '', tags: [], unknownControlledField: 'x' },
    })
    metadataDb.prepare(`
      UPDATE history_metadata_revisions
      SET payload_json = ?, payload_digest = ?
      WHERE commit_sha = ? AND path_at_revision = 'unknown.md'
    `).run(unknownPayload, digest(unknownPayload), historical.sha)

    const response = await call('POST', '/restore', { path: 'unknown.md', ref: historical.sha })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'HISTORY_METADATA_UNKNOWN_FIELD' })
    expect(await read('unknown.md')).toBe('body two\n')
  }, HISTORY_GIT_INTEGRATION_TIMEOUT_MS)

  it('rolls the body back when a concurrent metadata writer wins restore CAS', async () => {
    await write('conflict.md', 'body one\n')
    saveDocumentMetadata(metadataDb, { id: 'conflict-id', path: 'conflict', title: 'One', tags: ['one'] })
    const historical = await commit(['conflict.md'], 'conflict seed')
    await write('conflict.md', 'body two\n')
    const current = getDocumentMetadata(metadataDb, 'conflict')!
    patchDocumentMetadata(metadataDb, {
      path: 'conflict',
      expectedUpdatedAt: current.updatedAt,
      changes: [{ field: 'title', value: 'Two' }],
    })
    await commit(['conflict.md'], 'conflict current')
    __setHistoryMutationHooksForTesting({
      afterRestoreCommit: () => {
        saveDocumentMetadata(metadataDb, {
          id: 'conflict-id',
          path: 'conflict',
          title: 'External winner',
          summary: '',
          tags: ['external'],
        })
      },
    })

    const response = await call('POST', '/restore', { path: 'conflict.md', ref: historical.sha })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'HISTORY_METADATA_CONFLICT' })
    expect(await read('conflict.md')).toBe('body two\n')
    expect(getDocumentMetadata(metadataDb, 'conflict')).toMatchObject({
      id: 'conflict-id',
      title: 'External winner',
      tags: ['external'],
    })
  }, HISTORY_GIT_INTEGRATION_TIMEOUT_MS)

  it('rejects a covered restore when the body binding no longer matches', async () => {
    await write('body-binding.md', 'body one\n')
    saveDocumentMetadata(metadataDb, { id: 'body-binding-id', path: 'body-binding', title: 'One' })
    const historical = await commit(['body-binding.md'], 'body binding seed')
    await write('body-binding.md', 'body two\n')
    await commit(['body-binding.md'], 'body binding current')
    metadataDb.prepare(`
      UPDATE history_metadata_revisions
      SET body_sha = ?
      WHERE commit_sha = ? AND path_at_revision = 'body-binding.md'
    `).run('0'.repeat(64), historical.sha)

    const response = await call('POST', '/restore', { path: 'body-binding.md', ref: historical.sha })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'HISTORY_METADATA_BODY_MISMATCH' })
    expect(await read('body-binding.md')).toBe('body two\n')
  }, HISTORY_GIT_INTEGRATION_TIMEOUT_MS)

  it('does not mutate the body when an external writer wins before restore', async () => {
    await write('body-race.md', 'body one\n')
    saveDocumentMetadata(metadataDb, { id: 'body-race-id', path: 'body-race', title: 'One' })
    const historical = await commit(['body-race.md'], 'body race seed')
    await write('body-race.md', 'body two\n')
    await commit(['body-race.md'], 'body race current')
    __setHistoryMutationHooksForTesting({
      beforeRestoreCommit: async () => {
        await write('body-race.md', 'external body\n')
      },
    })

    const response = await call('POST', '/restore', { path: 'body-race.md', ref: historical.sha })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'HISTORY_CONTENT_CHANGED' })
    expect(await read('body-race.md')).toBe('external body\n')
    expect(getDocumentMetadata(metadataDb, 'body-race')).toMatchObject({ id: 'body-race-id', title: 'One' })
  }, HISTORY_GIT_INTEGRATION_TIMEOUT_MS)

  it('keeps rename identity and isolates delete/recreate generations', async () => {
    await write('old.md', 'old body\n')
    saveDocumentMetadata(metadataDb, { id: 'rename-id', path: 'old', title: 'Old' })
    await commit(['old.md'], 'old identity')

    await fs.rename(path.join(root, 'old.md'), path.join(root, 'new.md'))
    expect(moveDocumentMetadata(metadataDb, 'old', 'new')).toBe(true)
    const renamed = await commit(['old.md', 'new.md'], 'rename identity')
    const renamedRevision = metadataDb.prepare(`
      SELECT document_id FROM history_metadata_revisions
      WHERE commit_sha = ? AND path_at_revision = 'new.md'
    `).get(renamed.sha) as { document_id: string }
    expect(renamedRevision.document_id).toBe('rename-id')

    expect(deleteDocumentMetadata(metadataDb, 'new')).toBe(true)
    saveDocumentMetadata(metadataDb, { id: 'recreated-id', path: 'new', title: 'Recreated' })
    await write('new.md', 'recreated body\n')
    const recreated = await commit(['new.md'], 'new generation')
    const recreatedRevision = metadataDb.prepare(`
      SELECT document_id FROM history_metadata_revisions
      WHERE commit_sha = ? AND path_at_revision = 'new.md'
    `).get(recreated.sha) as { document_id: string }
    expect(recreatedRevision.document_id).toBe('recreated-id')
    expect(recreatedRevision.document_id).not.toBe(renamedRevision.document_id)

    const response = await call('POST', '/restore', { path: 'new.md', ref: renamed.sha })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'HISTORY_METADATA_IDENTITY_CONFLICT' })
    expect(await read('new.md')).toBe('recreated body\n')
  }, HISTORY_GIT_INTEGRATION_TIMEOUT_MS)

  it('does not publish a Git ref when metadata finalization fails before update-ref', async () => {
    await write('unpublished.md', 'body\n')
    saveDocumentMetadata(metadataDb, { id: 'unpublished-id', path: 'unpublished', title: 'Unpublished' })
    const expected = { unpublished: null } as Record<string, string | null>
    expected['unpublished.md'] = createHash('sha256').update('body\n').digest('hex')
    const prepared = prepareHistoryMetadataCapture({
      db: metadataDb,
      vaultId: await historyGit.ensureNuvynVaultId(root),
      expectedParentSha: await historyGit.currentHead(root),
      paths: ['unpublished.md'],
      expectedHashes: expected,
    })

    await expect(historyGit.addAndCommit(root, ['unpublished.md'], 'must not publish', {
      expected,
      afterCommitObjectCreatedBeforeRefUpdate: async () => {
        throw new Error('simulated metadata finalization failure')
      },
    })).rejects.toThrow(/simulated metadata finalization failure/)
    expect(await historyGit.currentHead(root)).toBeNull()
    expect((metadataDb.prepare(`SELECT state FROM history_metadata_operations WHERE operation_id = ?`)
      .get(prepared.operationId) as { state: string }).state).toBe('prepared')
  }, HISTORY_GIT_INTEGRATION_TIMEOUT_MS)

  it('leaves no published revision when SQLite capture preparation fails', async () => {
    await write('sqlite-failure.md', 'body\n')
    saveDocumentMetadata(metadataDb, { id: 'sqlite-failure-id', path: 'sqlite-failure', title: 'Stable' })
    metadataDb.exec('DROP TABLE history_metadata_revisions')

    const response = await call('POST', '/commits', { paths: ['sqlite-failure.md'], message: 'must not commit' })
    expect(response.status).toBe(500)
    expect(await historyGit.currentHead(root)).toBeNull()
    expect(await read('sqlite-failure.md')).toBe('body\n')
    expect(getDocumentMetadata(metadataDb, 'sqlite-failure')).toMatchObject({ title: 'Stable' })
    expect((metadataDb.prepare('SELECT COUNT(*) AS count FROM history_metadata_operations').get() as { count: number }).count)
      .toBe(0)
  }, HISTORY_GIT_INTEGRATION_TIMEOUT_MS)

  it('aborts a prepared capture journal during deterministic reconciliation', async () => {
    await write('pending.md', 'pending\n')
    saveDocumentMetadata(metadataDb, { id: 'pending-id', path: 'pending', title: 'Pending' })
    const prepared = prepareHistoryMetadataCapture({
      db: metadataDb,
      vaultId: await historyGit.ensureNuvynVaultId(root),
      expectedParentSha: await historyGit.currentHead(root),
      paths: ['pending.md'],
      expectedHashes: { 'pending.md': createHash('sha256').update('pending\n').digest('hex') },
    })

    await expect(reconcileHistoryMetadataCaptures(metadataDb, root)).resolves.toBeUndefined()
    expect((metadataDb.prepare(`
      SELECT state, commit_sha FROM history_metadata_operations WHERE operation_id = ?
    `).get(prepared.operationId) as { state: string; commit_sha: string | null })).toEqual({
      state: 'aborted',
      commit_sha: null,
    })
  }, HISTORY_GIT_INTEGRATION_TIMEOUT_MS)

  it('aborts a commit-tree failure without publishing or claiming coverage', async () => {
    await write('commit-tree-failure.md', 'body\n')
    saveDocumentMetadata(metadataDb, { id: 'commit-tree-failure-id', path: 'commit-tree-failure', title: 'Failure' })
    const expected = { 'commit-tree-failure.md': createHash('sha256').update('body\n').digest('hex') }
    const prepared = prepareHistoryMetadataCapture({
      db: metadataDb,
      vaultId: await historyGit.ensureNuvynVaultId(root),
      expectedParentSha: await historyGit.currentHead(root),
      paths: ['commit-tree-failure.md'],
      expectedHashes: expected,
    })

    await expect(historyGit.addAndCommit(root, ['commit-tree-failure.md'], 'commit-tree failure', {
      expected,
      beforeCommitTreeForTesting: async () => {
        throw new Error('simulated commit-tree failure')
      },
    })).rejects.toThrow(/simulated commit-tree failure/)
    expect(await historyGit.currentHead(root)).toBeNull()
    expect((metadataDb.prepare(`
      SELECT state FROM history_metadata_operations WHERE operation_id = ?
    `).get(prepared.operationId) as { state: string }).state).toBe('prepared')
    await expect(reconcileHistoryMetadataCaptures(metadataDb, root)).resolves.toBeUndefined()
    expect((metadataDb.prepare(`
      SELECT state FROM history_metadata_operations WHERE operation_id = ?
    `).get(prepared.operationId) as { state: string }).state).toBe('aborted')
  }, HISTORY_GIT_INTEGRATION_TIMEOUT_MS)

  it('aborts a bound capture when update-ref never publishes it', async () => {
    await write('ambiguous.md', 'body\n')
    saveDocumentMetadata(metadataDb, { id: 'ambiguous-id', path: 'ambiguous', title: 'Ambiguous' })
    const expected = { 'ambiguous.md': createHash('sha256').update('body\n').digest('hex') }
    const prepared = prepareHistoryMetadataCapture({
      db: metadataDb,
      vaultId: await historyGit.ensureNuvynVaultId(root),
      expectedParentSha: await historyGit.currentHead(root),
      paths: ['ambiguous.md'],
      expectedHashes: expected,
    })

    await expect(historyGit.addAndCommit(root, ['ambiguous.md'], 'ambiguous update', {
      expected,
      afterCommitObjectCreatedBeforeRefUpdate: async ({ commitSha, parentSha, treeSha }) => {
        await finalizeHistoryMetadataCapture({
          db: metadataDb,
          repoRoot: root,
          operationId: prepared.operationId,
          commitSha,
          parentSha,
          treeSha,
        })
      },
      beforeUpdateRefForTesting: async () => {
        throw new Error('simulated update-ref failure')
      },
    })).rejects.toThrow(/simulated update-ref failure/)

    expect((metadataDb.prepare(`SELECT state, commit_sha FROM history_metadata_operations WHERE operation_id = ?`)
      .get(prepared.operationId) as { state: string; commit_sha: string }).state).toBe('prepared')
    await expect(reconcileHistoryMetadataCaptures(metadataDb, root)).resolves.toBeUndefined()
    expect((metadataDb.prepare(`SELECT state FROM history_metadata_operations WHERE operation_id = ?`)
      .get(prepared.operationId) as { state: string }).state).toBe('aborted')
  }, HISTORY_GIT_INTEGRATION_TIMEOUT_MS)

  it('reconciles a reachable bound capture after publication before the committed mark', async () => {
    await write('reachable-after-crash.md', 'body\n')
    saveDocumentMetadata(metadataDb, {
      id: 'reachable-after-crash-id',
      path: 'reachable-after-crash',
      title: 'Reachable',
    })
    const expected = { 'reachable-after-crash.md': createHash('sha256').update('body\n').digest('hex') }
    const prepared = prepareHistoryMetadataCapture({
      db: metadataDb,
      vaultId: await historyGit.ensureNuvynVaultId(root),
      expectedParentSha: await historyGit.currentHead(root),
      paths: ['reachable-after-crash.md'],
      expectedHashes: expected,
    })

    const result = await historyGit.addAndCommit(root, ['reachable-after-crash.md'], 'published before mark', {
      expected,
      afterCommitObjectCreatedBeforeRefUpdate: async ({ commitSha, parentSha, treeSha }) => {
        await finalizeHistoryMetadataCapture({
          db: metadataDb,
          repoRoot: root,
          operationId: prepared.operationId,
          commitSha,
          parentSha,
          treeSha,
        })
      },
      // No afterRefUpdated callback simulates a process stopping immediately
      // after update-ref and before SQLite can mark the capture committed.
    })

    expect(result.sha).toMatch(/^[0-9a-f]{40}$/)
    expect((metadataDb.prepare(`SELECT state, commit_sha FROM history_metadata_operations WHERE operation_id = ?`)
      .get(prepared.operationId) as { state: string; commit_sha: string }).state).toBe('prepared')
    await expect(reconcileHistoryMetadataCaptures(metadataDb, root)).resolves.toBeUndefined()
    expect((metadataDb.prepare(`SELECT state FROM history_metadata_operations WHERE operation_id = ?`)
      .get(prepared.operationId) as { state: string }).state).toBe('committed')
  }, HISTORY_GIT_INTEGRATION_TIMEOUT_MS)

  it('recovers the route after a known update-ref failure and allows the next commit', async () => {
    let failBeforeUpdate = true
    __setHistoryMutationHooksForTesting({
      beforeUpdateRefForTesting: async () => {
        if (failBeforeUpdate) {
          failBeforeUpdate = false
          throw new Error('simulated update-ref failure')
        }
      },
    })
    await write('retry-after-ref-failure.md', 'first\n')
    saveDocumentMetadata(metadataDb, {
      id: 'retry-after-ref-failure-id',
      path: 'retry-after-ref-failure',
      title: 'Retry',
    })

    const failed = await call('POST', '/commits', {
      paths: ['retry-after-ref-failure.md'],
      message: 'known update-ref failure',
    })
    expect(failed.status).toBe(500)
    const failedOperation = metadataDb.prepare(`
      SELECT state, commit_sha FROM history_metadata_operations
      WHERE kind = 'capture' ORDER BY created_at DESC LIMIT 1
    `).get() as { state: string; commit_sha: string }
    expect(failedOperation.state).toBe('aborted')
    expect(failedOperation.commit_sha).toMatch(/^[0-9a-f]{40}$/)
    await expect(reconcileHistoryMetadataCaptures(metadataDb, root)).resolves.toBeUndefined()

    await write('retry-after-ref-failure.md', 'second\n')
    const retried = await call('POST', '/commits', {
      paths: ['retry-after-ref-failure.md'],
      message: 'retry after update-ref failure',
    })
    expect(retried.status).toBe(201)
    const states = metadataDb.prepare(`
      SELECT state FROM history_metadata_operations
      WHERE kind = 'capture' ORDER BY created_at
    `).all() as Array<{ state: string }>
    expect(states.map((row) => row.state)).toEqual(['aborted', 'committed'])
  }, HISTORY_GIT_INTEGRATION_TIMEOUT_MS)

  it('keeps a truly unprovable bound capture ambiguous', async () => {
    await write('unprovable.md', 'bound body\n')
    saveDocumentMetadata(metadataDb, { id: 'unprovable-id', path: 'unprovable', title: 'Unprovable' })
    const expected = { 'unprovable.md': createHash('sha256').update('bound body\n').digest('hex') }
    const prepared = prepareHistoryMetadataCapture({
      db: metadataDb,
      vaultId: await historyGit.ensureNuvynVaultId(root),
      expectedParentSha: await historyGit.currentHead(root),
      paths: ['unprovable.md'],
      expectedHashes: expected,
    })

    await expect(historyGit.addAndCommit(root, ['unprovable.md'], 'unpublished bound object', {
      expected,
      afterCommitObjectCreatedBeforeRefUpdate: async ({ commitSha, parentSha, treeSha }) => {
        await finalizeHistoryMetadataCapture({
          db: metadataDb,
          repoRoot: root,
          operationId: prepared.operationId,
          commitSha,
          parentSha,
          treeSha,
        })
      },
      beforeUpdateRefForTesting: async () => {
        throw new Error('simulated publication interruption')
      },
    })).rejects.toThrow(/simulated publication interruption/)

    await write('unrelated.md', 'unrelated\n')
    await historyGit.addAndCommit(root, ['unrelated.md'], 'unrelated published commit')

    await expect(reconcileHistoryMetadataCaptures(metadataDb, root))
      .rejects.toMatchObject({ code: 'HISTORY_METADATA_JOURNAL_AMBIGUOUS' })
    expect((metadataDb.prepare(`SELECT state FROM history_metadata_operations WHERE operation_id = ?`)
      .get(prepared.operationId) as { state: string }).state).toBe('ambiguous')
  }, HISTORY_GIT_INTEGRATION_TIMEOUT_MS)

  it('retires a captured revision when the existing History withdrawal removes it from HEAD', async () => {
    await write('withdraw.md', 'body\n')
    saveDocumentMetadata(metadataDb, { id: 'withdraw-id', path: 'withdraw', title: 'Withdraw' })
    const captured = await commit(['withdraw.md'], 'captured then withdrawn')
    const vaultId = await historyGit.ensureNuvynVaultId(root)

    const dropped = await call('POST', '/drop', { sha: captured.sha })
    expect(dropped.status).toBe(200)
    expect((metadataDb.prepare(`
      SELECT state, error_code FROM history_metadata_operations
      WHERE vault_id = ? AND kind = 'capture' AND commit_sha = ?
    `).get(vaultId, captured.sha) as { state: string; error_code: string })).toEqual({
      state: 'aborted',
      error_code: 'HISTORY_METADATA_REVISION_WITHDRAWN',
    })
    await expect(reconcileHistoryMetadataCaptures(metadataDb, root)).resolves.toBeUndefined()

    // Keep the helper's public state transition covered independently of the
    // route's integration assertion; a repeated withdrawal is idempotent.
    withdrawHistoryMetadataCapture(metadataDb, vaultId, captured.sha)
  }, HISTORY_GIT_INTEGRATION_TIMEOUT_MS)

  it('reconciles a prepared restore by rolling back a body-only partial state', async () => {
    await write('restore-body-reconcile.md', 'before\n')
    saveDocumentMetadata(metadataDb, { id: 'restore-body-reconcile-id', path: 'restore-body-reconcile', title: 'Before' })
    const beforeMetadata = metadataImage(getDocumentMetadata(metadataDb, 'restore-body-reconcile'))!
    const targetMetadata = {
      id: beforeMetadata.id,
      path: beforeMetadata.path,
      title: 'After',
      summary: '',
      tags: ['after'],
    }
    const journal = prepareHistoryMetadataRestore({
      db: metadataDb,
      vaultId: await historyGit.ensureNuvynVaultId(root),
      commitSha: '1'.repeat(40),
      pathAtRevision: 'restore-body-reconcile.md',
      documentId: beforeMetadata.id,
      generationId: beforeMetadata.id,
      beforeRaw: 'before\n',
      beforeMetadata,
      targetRaw: 'after\n',
      targetMetadata,
      targetDigest: 'digest',
    })
    await write('restore-body-reconcile.md', 'after\n')

    await expect(reconcileHistoryMetadataRestores(metadataDb, root)).resolves.toBeUndefined()
    expect(await read('restore-body-reconcile.md')).toBe('before\n')
    expect((metadataDb.prepare(`
      SELECT state FROM history_metadata_operations WHERE operation_id = ?
    `).get(journal.operationId) as { state: string }).state).toBe('aborted')
  }, HISTORY_GIT_INTEGRATION_TIMEOUT_MS)

  it('reconciles a prepared restore by rolling back a metadata-only partial state', async () => {
    await write('restore-metadata-reconcile.md', 'before\n')
    saveDocumentMetadata(metadataDb, { id: 'restore-metadata-reconcile-id', path: 'restore-metadata-reconcile', title: 'Before', tags: ['before'] })
    const beforeMetadata = metadataImage(getDocumentMetadata(metadataDb, 'restore-metadata-reconcile'))!
    const targetMetadata = {
      id: beforeMetadata.id,
      path: beforeMetadata.path,
      title: 'After',
      summary: '',
      tags: ['after'],
    }
    const journal = prepareHistoryMetadataRestore({
      db: metadataDb,
      vaultId: await historyGit.ensureNuvynVaultId(root),
      commitSha: '2'.repeat(40),
      pathAtRevision: 'restore-metadata-reconcile.md',
      documentId: beforeMetadata.id,
      generationId: beforeMetadata.id,
      beforeRaw: 'before\n',
      beforeMetadata,
      targetRaw: 'after\n',
      targetMetadata,
      targetDigest: 'digest',
    })
    const current = getDocumentMetadata(metadataDb, 'restore-metadata-reconcile')!
    patchDocumentMetadata(metadataDb, {
      path: 'restore-metadata-reconcile',
      expectedUpdatedAt: current.updatedAt,
      changes: [{ field: 'title', value: 'After' }, { field: 'tags', values: ['after'] }],
    })

    await expect(reconcileHistoryMetadataRestores(metadataDb, root)).resolves.toBeUndefined()
    expect(getDocumentMetadata(metadataDb, 'restore-metadata-reconcile')).toMatchObject({
      id: beforeMetadata.id,
      title: 'Before',
      summary: '',
      tags: ['before'],
    })
    expect((metadataDb.prepare(`
      SELECT state FROM history_metadata_operations WHERE operation_id = ?
    `).get(journal.operationId) as { state: string }).state).toBe('aborted')
  }, HISTORY_GIT_INTEGRATION_TIMEOUT_MS)
})

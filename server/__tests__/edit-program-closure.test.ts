// Nuvyn Edit Program — Final Closure: cross-Edit contract tests.
//
// NOT a re-test of any single Edit's suite. These tests pin the
// SEAMS between sealed Edits, end to end through the REAL server
// (full Hono app, real routes, real temp vault on disk, real SQLite
// metadata DB, real git history repo):
//
//   T1 — Journey 8 (delete / path reuse / stale actors):
//     Edit-03 delete  ×  metadata identity  ×  Edit-06 baseRaw CAS
//     ×  Edit-10 verify-clean identity gate.
//     A deleted-then-recreated path is a DIFFERENT document. A stale
//     writer holding the old baseRaw gets a real 409 from the CAS
//     (Edit-06). A stale AI snapshot holding the old documentId is
//     blocked as active-context-identity-mismatch (Edit-10) EVEN when
//     its raw is byte-identical to the new document's disk — and the
//     block leaves disk and DB untouched (no identity minted during
//     verification). The correct-identity snapshot for the same bytes
//     is then allowed — the block is identity-specific, not a blanket
//     refusal.
//
//   T2 — Journey 5 (rename / identity / history):
//     Edit-03 rename  ×  metadata identity  ×  History (git per-path
//     timelines). documentId survives the rename; the new path serves
//     the same bytes; the old path is gone; a document recreated at
//     the old path gets a NEW identity; pre-rename revisions remain
//     retrievable at the old git path while the new path carries the
//     post-rename timeline (sealed per-path git contract: no
//     --follow, git.ts:273 — identity continuity is the metadata
//     row's job, not the git log's).
//
// Sentinels are synthetic; no real user bodies anywhere. Console is
// spied so any sentinel reaching a server log fails the run (§5.8 /
// §10: sensitive raw never logged).
import { it, expect, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import app, { __setMetadataDbForTesting } from '../index'
import { applyMigrations } from '../db'
import { setContentDir, CONTENT_DIR } from '../paths'
import { getDocumentMetadata } from '../documentMetadata'
import { __resetRepoRootForTesting, __resetGitCapabilityForTesting, setRepoRootForTesting } from '../history/routes.js'
import { runChat, type ChatContext, type ChatEvent } from '../ai/chat'
import { parseAiLiveContext } from '../ai/live-context'
import { streamClaude, type StreamResult } from '../ai/llm'
import {
  cleanupHistoryTempRepo,
  describeHistoryIntegration,
  HISTORY_GIT_INTEGRATION_TIMEOUT_MS,
} from './helpers/historyIntegration.js'
import { closeAuthTestContext, createAuthenticatedTestContext, type AuthenticatedTestContext } from './helpers/auth.js'

// runChat now dispatches through ChatBackend. Tests don't need the
// real AnthropicBackend — a stub that re-implements the small
// translation in streamRound keeps the test surface minimal. The
// mock function is created in the hoisted scope so the factory can
// reference the initialized value after vi.mock hoists.
const mockStreamClaude = vi.hoisted(() => vi.fn(async ({ onToken }: { onToken: (t: string) => void }) => {
    onToken('ok')
    const finalMessage = { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }
    return { text: 'ok', finalMessage }
  }))
vi.mock('../ai/llm', () => ({
  streamClaude: mockStreamClaude,
  clearChatBackendCache: vi.fn(),
  getChatBackend: vi.fn(() => ({
    name: 'anthropic' as const,
    streamRound: vi.fn(async ({ system, messages, model, onToken, signal, tools }: {
      system: string; messages: unknown[]; model: string; onToken: (t: string) => void; signal?: AbortSignal; tools?: unknown[]
    }) => {
      const r = await mockStreamClaude({ system, messages, model, onToken, signal, tools })
      const toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = []
      let text = ''
      for (const b of r.finalMessage.content as Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>) {
        if (b.type === 'text' && b.text) text += b.text
        else if (b.type === 'tool_use' && b.id && b.name) {
          toolCalls.push({ id: b.id, name: b.name, input: b.input ?? {} })
        }
      }
      return {
        text,
        toolCalls,
        finishReason: r.finalMessage.stop_reason === 'tool_use' ? 'tool_calls' as const
          : r.finalMessage.stop_reason === 'max_tokens' ? 'length' as const
          : 'stop' as const,
      }
    }),
  })),
}))

const RUN = String(Date.now())
const ORIGINAL_CONTENT_DIR = CONTENT_DIR
// Track every real route request so afterEach can wait for any in-flight
// requests to settle BEFORE we close the metadata DB, reset globals, or
// remove the temporary vault. On Windows a leftover request holding a
// file handle causes EBUSY in fs.rm and cross-test contamination.
const inFlightRequests = new Set<Promise<unknown>>()

function trackRequest<T>(request: Promise<T>): Promise<T> {
  inFlightRequests.add(request)
  request.finally(() => {
    inFlightRequests.delete(request)
  })
  return request
}

// Stale-body sentinels: T1 moves these between the old and the new
// document so the identity gate is probed at BYTE-IDENTICAL raw.
const STALE_BODY = `EPC_STALE_BODY_${RUN}\n`
const STALE_WRITER_BODY = `EPC_STALE_WRITER_${RUN}\n`
const AI_BODY = `EPC_AI_WRITTEN_${RUN}\n`
const R1 = `EPC_RENAME_R1_${RUN}\n`
const R2 = `EPC_RENAME_R2_${RUN}\n`

let contentDir: string
let db: InstanceType<typeof Database>
let auth: AuthenticatedTestContext
let consoleSpies: ReturnType<typeof vi.spyOn>[]

function allSentinels(): string[] {
  return [STALE_BODY, STALE_WRITER_BODY, AI_BODY, R1, R2]
}

async function call(method: string, urlPath: string, body?: unknown) {
  const req = new Request(`http://localhost${urlPath}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      Cookie: auth.cookie,
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  return trackRequest(app.fetch(req))
}

async function getDetail(slug: string): Promise<{ raw: string; id: string; mtime: number }> {
  const res = await call('GET', `/api/posts/${slug}`)
  expect(res.status).toBe(200)
  const detail = await res.json() as { raw: string; mtime: number; metadata: { id: string } }
  return { raw: detail.raw, id: detail.metadata.id, mtime: detail.mtime }
}

async function createDoc(slug: string): Promise<string> {
  const name = slug.split('/').pop()!
  const created = await call('POST', '/api/posts', { path: slug, title: name })
  expect([200, 201]).toContain(created.status)
  const initial = await getDetail(slug)
  return initial.raw // the create-time baseRaw
}

async function putRaw(slug: string, raw: string, baseRaw: string) {
  return call('PUT', `/api/posts/${slug}`, { raw, baseRaw })
}

async function commitHistory(slug: string, message: string, diskBytes: string): Promise<string> {
  // The sealed Create-Version contract: the client sends the content
  // hash it observed; the server commits only if the file still
  // matches (hash CAS, 409 otherwise). History routes speak git-relative
  // paths — the logical path PLUS the .md extension (validation.ts
  // FILE_RE), the shape `git status --porcelain` reports.
  const gitPath = `${slug}.md`
  const expected = createHash('sha256').update(Buffer.from(diskBytes, 'utf8')).digest('hex')
  const res = await call('POST', '/api/history/commits', { paths: [gitPath], message, expected: { [gitPath]: expected } })
  expect(res.status).toBe(201)
  const body = await res.json() as { sha: string }
  expect(body.sha).toMatch(/^[0-9a-f]{40,64}$/)
  return body.sha
}

// The sealed client Document wire shape (v: 1), byte-for-byte what a
// browser captureAiLiveContext produces for a clean document.
function cleanDocumentSnapshot(raw: string, documentId: string, docPath: string): Record<string, unknown> {
  return {
    v: 1,
    kind: 'document',
    capturedAt: 1_750_000_000_000,
    vaultId: 'vault-epc',
    workspaceTabId: docPath,
    identity: { documentId, path: docPath },
    title: 'EPC',
    raw,
    revision: 2,
    savedRevision: 2,
    dirty: false,
    saveStatus: 'idle',
  }
}

function liveCtx(snapshot: Record<string, unknown>): ChatContext {
  // Through the REAL parser — the only door — not a hand-built
  // server-side object.
  const parsed = parseAiLiveContext(JSON.parse(JSON.stringify(snapshot)))
  if (!parsed.ok) throw new Error(`program-closure fixture rejected by parser: ${parsed.reason}`)
  return { kind: 'live', liveContext: parsed.value }
}

function mockProviderWithSamePathWrite(targetPath: string, content: string) {
  vi.mocked(streamClaude)
    .mockImplementationOnce(async () => ({
      text: '',
      finalMessage: {
        content: [
          { type: 'tool_use', id: 'toolu_epc_1', name: 'write_file', input: { path: targetPath, content } },
        ],
        stop_reason: 'tool_use',
      } as unknown as StreamResult['finalMessage'],
    }))
    .mockImplementationOnce(async ({ onToken }: { onToken: (t: string) => void }) => {
      onToken('done')
      return {
        text: 'done',
        finalMessage: { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } as unknown as StreamResult['finalMessage'],
      }
    })
}

function makeSession(): number {
  const s = db.prepare('INSERT INTO sessions (title, created_at, updated_at) VALUES (?, ?, ?)').run('', 1, 1)
  return Number(s.lastInsertRowid)
}

beforeEach(async () => {
  contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-epc-'))
  await fs.mkdir(path.join(contentDir, 'inbox'), { recursive: true })
  setContentDir(contentDir)
  setRepoRootForTesting(contentDir)
  __resetGitCapabilityForTesting()
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  auth = createAuthenticatedTestContext({ db })
  __setMetadataDbForTesting(db)
  vi.mocked(streamClaude).mockClear()
  consoleSpies = [
    vi.spyOn(console, 'log').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'error').mockImplementation(() => {}),
    vi.spyOn(console, 'info').mockImplementation(() => {}),
  ]
  // The history routes call ensureRepo() themselves; give the fresh
  // repo a git identity so Create-Version commits succeed.
  const capability = await call('GET', '/api/history/capability')
  expect(capability.status).toBe(200)
  const { run } = await import('../history/git.js')
  await run(contentDir, ['config', 'user.name', 'EPC Test'])
  await run(contentDir, ['config', 'user.email', 'epc@example.com'])
})

afterEach(async () => {
  // Wait for every in-flight route request to settle BEFORE we close
  // the metadata DB, reset globals, or remove the temporary vault.
  // On Windows a leftover request holding a file handle causes EBUSY
  // in fs.rm and cross-test contamination.
  await Promise.allSettled([...inFlightRequests])
  inFlightRequests.clear()

  for (const spy of consoleSpies) spy.mockRestore()
  closeAuthTestContext(auth)
  __setMetadataDbForTesting(null)
  __resetRepoRootForTesting()
  __resetGitCapabilityForTesting()
  setContentDir(ORIGINAL_CONTENT_DIR)
  db.close()
  await cleanupHistoryTempRepo(contentDir)
}, HISTORY_GIT_INTEGRATION_TIMEOUT_MS)

describeHistoryIntegration('Nuvyn Edit Program closure: cross-Edit contracts', () => {
  it('Journey 8 — path reuse never inherits the old identity: stale baseRaw 409s, a stale AI documentId is blocked even at byte-identical raw, the correct identity passes', async () => {
    const slug = `inbox/epc-reuse-${RUN}`
    const abs = path.join(contentDir, `${slug}.md`)

    // ── Document A exists with a real identity and a saved body ────
    const baseAtCreate = await createDoc(slug)
    const saveA = await putRaw(slug, STALE_BODY, baseAtCreate)
    expect(saveA.status).toBeLessThan(300)
    const docA = await getDetail(slug)
    expect(docA.raw).toBe(STALE_BODY)
    const idA = docA.id
    expect(typeof idA).toBe('string')
    expect(idA.length).toBeGreaterThan(0)

    // ── Edit-03 delete: file AND identity row are gone ─────────────
    const deleted = await call('DELETE', `/api/posts/${slug}`)
    expect(deleted.status).toBeLessThan(300)
    await expect(fs.access(abs)).rejects.toThrow()
    expect(getDocumentMetadata(db, slug)).toBeNull()

    // ── Recreate the SAME path: a NEW document, a NEW identity ─────
    const baseOfB = await createDoc(slug)
    const docB0 = await getDetail(slug)
    expect(docB0.id).not.toBe(idA)
    const idB = docB0.id

    // The new document legitimately takes the exact bytes A had.
    const saveB = await putRaw(slug, STALE_BODY, baseOfB)
    expect(saveB.status).toBeLessThan(300)
    expect((await getDetail(slug)).raw).toBe(STALE_BODY)

    // ── Stale editor writer (holds A's pre-delete baseRaw): the
    //    Edit-06 CAS answers 409 and writes nothing ─────────────────
    const stalePut = await putRaw(slug, STALE_WRITER_BODY, baseAtCreate)
    expect(stalePut.status).toBe(409)
    expect((await getDetail(slug)).raw).toBe(STALE_BODY) // B untouched

    // ── Stale AI snapshot (holds A's documentId, but its raw is now
    //    BYTE-IDENTICAL to B's disk): Edit-10 verify-clean blocks on
    //    identity, not bytes ────────────────────────────────────────
    const ctxStale = liveCtx(cleanDocumentSnapshot(STALE_BODY, idA, slug))
    mockProviderWithSamePathWrite(slug, AI_BODY)
    const staleEvents: ChatEvent[] = []
    await runChat({
      db, sessionId: makeSession(), userContent: 'rewrite my note', ctx: ctxStale, model: 'm',
      signal: undefined, onEvent: (e) => { staleEvents.push(e) },
    })
    const staleResult = staleEvents.find((e) => e.type === 'tool_result')
    expect(staleResult).toMatchObject({ is_error: true })
    expect((staleResult as any).content).toContain('active-context-identity-mismatch')
    expect((staleResult as any).content).toContain(slug)
    // Blocked verification writes NOTHING: no AI body on disk, and
    // still exactly B's identity row (nothing minted during verify).
    expect((await getDetail(slug)).raw).toBe(STALE_BODY)
    expect((await getDetail(slug)).id).toBe(idB)
    expect(staleEvents.filter((e) => e.type === 'file_changed')).toHaveLength(0)

    // ── Control: the CORRECT identity over the SAME bytes passes
    //    verify-clean and the write executes ────────────────────────
    const ctxFresh = liveCtx(cleanDocumentSnapshot(STALE_BODY, idB, slug))
    mockProviderWithSamePathWrite(slug, AI_BODY)
    const freshEvents: ChatEvent[] = []
    await runChat({
      db, sessionId: makeSession(), userContent: 'rewrite my note', ctx: ctxFresh, model: 'm',
      signal: undefined, onEvent: (e) => { freshEvents.push(e) },
    })
    const freshResult = freshEvents.find((e) => e.type === 'tool_result')
    expect(freshResult).toMatchObject({ is_error: false })
    expect((await getDetail(slug)).raw).toBe(AI_BODY)
    expect((await getDetail(slug)).id).toBe(idB) // identity stable
    const fileChanged = freshEvents.filter((e) => e.type === 'file_changed')
    expect(fileChanged).toHaveLength(1)
    expect(fileChanged[0]).toMatchObject({ path: slug, kind: 'write', newRaw: AI_BODY })

    // ── No sentinel raw ever reached a server log ──────────────────
    for (const spy of consoleSpies) {
      for (const spyCall of spy.mock.calls) {
        const text = JSON.stringify(spyCall)
        for (const sentinel of allSentinels()) {
          expect(text).not.toContain(sentinel.trim())
        }
      }
    }
  }, HISTORY_GIT_INTEGRATION_TIMEOUT_MS)

  it('Journey 5 — rename keeps documentId; the new path serves the same bytes; pre-rename revisions stay retrievable at the old git path; reusing the old path mints a new identity', async () => {
    const slug = `inbox/epc-rename-${RUN}`
    const renamedSlug = `inbox/epc-renamed-${RUN}`

    // ── A with revision R1 committed to its history ────────────────
    const baseAtCreate = await createDoc(slug)
    const saveR1 = await putRaw(slug, R1, baseAtCreate)
    expect(saveR1.status).toBeLessThan(300)
    const docA = await getDetail(slug)
    expect(docA.raw).toBe(R1)
    const idA = docA.id
    const commitR1 = await commitHistory(slug, `epc-r1-${RUN}`, R1)
    expect(commitR1.length).toBeGreaterThan(0)

    // ── Edit-03 rename through the real route ──────────────────────
    const renamed = await call('PATCH', `/api/posts/${slug}`, { name: `epc-renamed-${RUN}`, updateReferences: false })
    expect(renamed.status).toBe(200)

    // ── Identity survives; bytes survive; old path is gone ─────────
    const docC = await getDetail(renamedSlug)
    expect(docC.id).toBe(idA)
    expect(docC.raw).toBe(R1)
    const gone = await call('GET', `/api/posts/${slug}`)
    expect(gone.status).toBe(404)

    // ── Post-rename revision R2 on the new path; the new timeline
    //    carries it ─────────────────────────────────────────────────
    const saveR2 = await putRaw(renamedSlug, R2, docC.raw)
    expect(saveR2.status).toBeLessThan(300)
    const commitR2 = await commitHistory(renamedSlug, `epc-r2-${RUN}`, R2)
    expect(commitR2.length).toBeGreaterThan(0)
    const newLog = await (await call('GET', `/api/history/log?path=${encodeURIComponent(`${renamedSlug}.md`)}`)).json() as { commits: Array<{ message?: string; subject?: string }> }
    const newMessages = JSON.stringify(newLog.commits)
    expect(newMessages).toContain(`epc-r2-${RUN}`)

    // Sealed per-path git contract (git.ts:273 — deliberately no
    // --follow): the PRE-rename revision remains retrievable at the
    // OLD git path; the renamed file's timeline starts fresh at its
    // first post-rename commit (the rename itself is a metadata-row
    // move, not a git commit). Identity continuity across the rename
    // is the metadata row's job (asserted above), not the git log's.
    const oldLog = await (await call('GET', `/api/history/log?path=${encodeURIComponent(`${slug}.md`)}`)).json() as { commits: Array<unknown> }
    expect(JSON.stringify(oldLog.commits)).toContain(`epc-r1-${RUN}`)
    const oldFile = await call('GET', `/api/history/file?path=${encodeURIComponent(`${slug}.md`)}&ref=${encodeURIComponent(commitR1)}`)
    expect(oldFile.status).toBe(200)
    expect(((await oldFile.json()) as { content: string }).content).toBe(R1)

    // ── A stale writer from the pre-rename life cannot write the
    //    renamed document: its old baseRaw no longer matches the
    //    renamed file's bytes, so the Edit-06 CAS answers 409 ───────
    const stalePut = await putRaw(renamedSlug, STALE_WRITER_BODY, baseAtCreate)
    expect(stalePut.status).toBe(409)
    expect((await getDetail(renamedSlug)).raw).toBe(R2) // renamed doc untouched
    expect((await getDetail(renamedSlug)).id).toBe(idA) // identity untouched

    // ── Recreating the OLD path yields a NEW identity — never the
    //    renamed document's (in SQLite and in the served detail) ────
    await createDoc(slug)
    const docD = await getDetail(slug)
    expect(docD.id).not.toBe(idA)
    const rowD = getDocumentMetadata(db, slug)
    expect(rowD?.id).toBe(docD.id)
    expect(rowD?.id).not.toBe(idA)

    // ── No sentinel raw ever reached a server log ──────────────────
    for (const spy of consoleSpies) {
      for (const spyCall of spy.mock.calls) {
        const text = JSON.stringify(spyCall)
        for (const sentinel of allSentinels()) {
          expect(text).not.toContain(sentinel.trim())
        }
      }
    }
  }, HISTORY_GIT_INTEGRATION_TIMEOUT_MS)
})

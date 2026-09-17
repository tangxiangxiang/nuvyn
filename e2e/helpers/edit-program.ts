// Shared E2E helpers for the Edit Program closure suite.
//
// ONE set of semantics: the sealed ai-live-context specs (E2E-1..10),
// the Edit-10.5 residual-race spec, and the Edit Program long-flow
// specs all import from here. No spec may fork its own snapshot
// builder, route interceptor, or doc-creation helper — a behavior
// difference between specs would silently mean two different products
// under test (§7: "长链路可以复用现有 E2E helper，但不得复制一套不同语义的
// snapshot builder").
//
// Everything here runs against the REAL embedded server (posts, files,
// health) with test documents under inbox/ carrying per-run slugs.
// Only two layers are substituted, at the BROWSER layer, exactly like
// the sealed harness:
//   - /api/ai/**  — no real Anthropic round-trip (no key needed); the
//     request body is captured verbatim for send-time assertions and
//     answered with a controlled SSE stream.
//   - /api/history/** (opt-in per test) — a pinned fake timeline so
//     History/Diff assertions are deterministic without writing commits
//     into the real vault repo.
import { promises as fs } from 'node:fs'
import path from 'node:path'

const E2E_VAULT = process.env.NUVYN_DRAFT_E2E_VAULT ?? path.join('src', 'content')
import { expect, type APIRequestContext, type Page } from '@playwright/test'

export const DATABASE_NAME = 'nuvyn-draft-recovery'
const VAULT_READY_TIMEOUT_MS = 15_000

export type AnyRecord = Record<string, any>

export function jsonResponse(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) }
}

export function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

export const MINIMAL_SSE = [
  sse('user', { id: 1 }),
  sse('token', { text: 'ok' }),
  sse('done', { userId: 1, assistantId: 2 }),
].join('')

// The AI turn's SSE stream for a same-path write_file round: the
// STANDARD file_changed descriptor (the exact shape server/ai/routes.ts
// emits, pinned by the server closure suite) carrying the REAL
// newRaw/newMtime of the REST write the test performed, then close-out.
export function raceSse(slug: string, aiBody: string, newMtime: number): string {
  return [
    sse('user', { id: 1 }),
    sse('tool_use', { id: 'toolu_e2e_fc', name: 'write_file', input: { path: slug, content: aiBody } }),
    sse('tool_result', { tool_use_id: 'toolu_e2e_fc', content: `Wrote ${slug}`, is_error: false }),
    sse('file_changed', { path: slug, kind: 'write', newMtime, newRaw: aiBody }),
    sse('token', { text: 'Done.' }),
    sse('done', { userId: 1, assistantId: 2 }),
  ].join('')
}

// Browser-level /api/ai/** intercept: every chat request body lands in
// `chatBodies`; chats answer immediately with MINIMAL_SSE.
export async function interceptAiChat(page: Page, chatBodies: AnyRecord[]) {
  await page.route('**/api/ai/**', (route) => {
    const url = new URL(route.request().url())
    const method = route.request().method()
    if (url.pathname === '/api/ai/active') {
      if (method === 'PUT') return route.fulfill(jsonResponse({ sessionId: 1 }))
      return route.fulfill(jsonResponse({ activeId: null, configured: true }))
    }
    if (url.pathname === '/api/ai/sessions') {
      if (method === 'POST') {
        return route.fulfill(jsonResponse({ id: 1, title: '', createdAt: 1, updatedAt: 1 }, 201))
      }
      return route.fulfill(jsonResponse([]))
    }
    if (url.pathname === '/api/ai/settings') {
      return route.fulfill(jsonResponse({ hasKey: true, baseURL: '', model: '' }))
    }
    if (url.pathname === '/api/ai/chat') {
      chatBodies.push(JSON.parse(route.request().postData() ?? '{}'))
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: MINIMAL_SSE })
    }
    return route.fulfill(jsonResponse({}))
  })
}

// Gated variant: the FIRST chat stream is held open on `gate` — the
// AI is "thinking" until the test releases the mutation — then answered
// with raceBody(); later chats answer immediately with MINIMAL_SSE.
export async function interceptAiChatGated(
  page: Page,
  chatBodies: AnyRecord[],
  gate: Promise<void>,
  raceBody: () => string,
) {
  await page.route('**/api/ai/**', async (route) => {
    const url = new URL(route.request().url())
    const method = route.request().method()
    if (url.pathname === '/api/ai/active') {
      if (method === 'PUT') return route.fulfill(jsonResponse({ sessionId: 1 }))
      return route.fulfill(jsonResponse({ activeId: null, configured: true }))
    }
    if (url.pathname === '/api/ai/sessions') {
      if (method === 'POST') {
        return route.fulfill(jsonResponse({ id: 1, title: '', createdAt: 1, updatedAt: 1 }, 201))
      }
      return route.fulfill(jsonResponse([]))
    }
    if (url.pathname === '/api/ai/settings') {
      return route.fulfill(jsonResponse({ hasKey: true, baseURL: '', model: '' }))
    }
    if (url.pathname === '/api/ai/chat') {
      chatBodies.push(JSON.parse(route.request().postData() ?? '{}'))
      if (chatBodies.length === 1) {
        await gate // deterministic hold: released by the test
        return route.fulfill({ status: 200, contentType: 'text/event-stream', body: raceBody() })
      }
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: MINIMAL_SSE })
    }
    return route.fulfill(jsonResponse({}))
  })
}

// Holds the browser's debounced autosave PUT for `slug` at the network
// boundary: the request is recorded (state.seen) and parked until the
// test releases `gate`, then REALLY sent to the server (route.fetch) so
// the browser receives the genuine server response — e.g. the 409
// conflict — and its real status is captured for assertion.
// APIRequestContext writes from the test bypass page.route entirely, so
// a real server mutation never touches this gate.
export async function interceptAutosaveHeld(
  page: Page,
  slug: string,
  state: { seen: boolean; statuses: number[] },
  gate: Promise<void>,
) {
  await page.route(`**/api/posts/${slug}`, async (route) => {
    if (route.request().method() !== 'PUT') return route.continue()
    state.seen = true
    await gate
    const response = await route.fetch()
    state.statuses.push(response.status())
    await route.fulfill({ response })
  })
}

// Aborts the browser's autosave PUTs for `slug` (GETs pass through).
// Models the only situation in which a browser draft outlives the
// editing session: the save never completes (crash/offline). Without
// the hold, the 800ms autosave and the draft debounce finish within
// ~1s of each other and markClean() removes the draft again, leaving
// nothing to recover (the sealed draft-store pattern).
export async function interceptAutosaveAborted(page: Page, slug: string) {
  await page.route(`**/api/posts/${slug}`, (route) =>
    route.request().method() === 'PUT' ? route.abort() : route.continue())
}

// Deterministic history: one fake commit touching `files`, whose file
// content is `raw`. IMPORTANT: install this BEFORE the app boot
// (reloadApp / page.goto / page.reload) that follows — the History
// composable fetches status/timeline at boot (it drives the
// activity-bar badge), so a post-boot install loses the race and the
// panel shows the real repo timeline. Routes survive navigation;
// registering a second intercept later overrides the earlier one
// (LIFO), so tests can re-pin the timeline after a rename — again
// BEFORE the next boot.
export async function interceptHistory(
  page: Page,
  opts: { files: string[]; raw: string; sha: string; subject?: string; parents?: string[] },
) {
  await page.route('**/api/history/**', (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/capability')) {
      return route.fulfill(jsonResponse({ gitAvailable: true, repoInitialized: true }))
    }
    if (url.pathname.endsWith('/status')) {
      return route.fulfill(jsonResponse({ dirty: [], available: true }))
    }
    if (url.pathname.endsWith('/log')) {
      return route.fulfill(jsonResponse({
        commits: [{
          sha: opts.sha,
          parents: opts.parents ?? [],
          author: 'E2E',
          date: '2026-07-21T08:00:00.000Z',
          subject: opts.subject ?? 'E2E pinned revision',
          body: '',
          files: opts.files,
        }],
      }))
    }
    if (url.pathname.endsWith('/file')) {
      return route.fulfill(jsonResponse({
        path: url.searchParams.get('path') ?? '',
        ref: url.searchParams.get('ref') ?? '',
        content: opts.raw,
      }))
    }
    if (url.pathname.endsWith('/diff')) {
      return route.fulfill(jsonResponse({
        path: url.searchParams.get('path') ?? '',
        oldRef: url.searchParams.get('old') ?? '',
        newRef: url.searchParams.get('new') ?? '',
        diff: { ops: [], stats: { added: 0, removed: 0, equal: 0 } },
      }))
    }
    // Array/object shapes the History panel's commit composer reads on
    // mount — the generic {} fallback would crash its computeds.
    if (url.pathname.endsWith('/repair-status')) {
      return route.fulfill(jsonResponse({ transactions: [] }))
    }
    if (url.pathname.endsWith('/content-hashes')) {
      return route.fulfill(jsonResponse({ hashes: {} }))
    }
    return route.fulfill(jsonResponse({}))
  })
}

// Create + seed a document through the REAL server REST API. The
// per-run slug keeps parallel runs disjoint; every created path is
// pushed to `createdPaths` for afterAll cleanup (untracked files under
// src/content would fail the git-status gate).
export async function createDoc(
  request: APIRequestContext,
  slug: string,
  body: string,
  createdPaths: string[],
): Promise<{ raw: string; documentId: string }> {
  const name = slug.split('/').pop()!
  const create = await request.post('/api/posts', { data: { path: slug, title: name } })
  expect([200, 201, 409]).toContain(create.status())
  createdPaths.push(slug)
  const initial = await (await request.get(`/api/posts/${slug}`)).json()
  const put = await request.put(`/api/posts/${slug}`, {
    data: { raw: body, baseRaw: initial.raw },
  })
  expect(put.status()).toBeLessThan(300)
  const detail = await (await request.get(`/api/posts/${slug}`)).json()
  return { raw: detail.raw as string, documentId: detail.metadata.id as string }
}

/**
 * Wait for the Vault shell and its initial workspace snapshot to be ready.
 *
 * The activity-bar button used to be the readiness signal here. It only
 * proves that the Vue shell mounted, though; on a busy Windows runner the
 * tree/posts fetches could still be in flight when the test started. The
 * initial tree and posts responses are the actual startup prerequisites for
 * opening documents, so wait for those requests and then verify the shell.
 */
export async function waitForVaultReady(page: Page) {
  await expect(page.locator('.vault')).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS })
  await expect(page.locator('.activity-bar .ab-btn').first()).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS })
}

/**
 * Navigate to the Vault and wait for its first workspace snapshot. The
 * response listeners are installed before navigation so fast local requests
 * cannot race past the readiness gate.
 */
export async function gotoVaultReady(page: Page) {
  const treeResponse = page.waitForResponse(
    (response) => response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/tree',
    { timeout: VAULT_READY_TIMEOUT_MS },
  )
  const postsResponse = page.waitForResponse(
    (response) => response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/posts',
    { timeout: VAULT_READY_TIMEOUT_MS },
  )
  await page.goto('/')
  const [tree, posts] = await Promise.all([treeResponse, postsResponse])
  expect(tree.ok(), `Vault tree request failed: ${tree.status()}`).toBe(true)
  expect(posts.ok(), `Vault posts request failed: ${posts.status()}`).toBe(true)
  await waitForVaultReady(page)
}

// The file tree is fetched at mount time; documents created through the REST
// API after page load are invisible to it until the next load. Reload before
// opening freshly created documents.
export async function reloadApp(page: Page) {
  await gotoVaultReady(page)
}

export async function openDoc(page: Page, slug: string) {
  // data-tree-key is exact (kind:path) — a hasText match on .tree-row
  // would also match the folder row, whose descendants include the
  // file rows.
  const row = page.locator(`[data-tree-key="file:${slug}"]`)
  if (!(await row.isVisible().catch(() => false))) {
    // Children of a collapsed folder are not rendered: expand first.
    const folder = slug.split('/')[0]
    await page.locator(`[data-tree-key="folder:${folder}"]`).click()
    await expect(row).toBeVisible({ timeout: 5000 })
  }
  await row.click()
  await page.locator(`[data-tab-id="${slug}"]`).waitFor({ state: 'visible' })
  await page.locator('.editor-pane .monaco-editor .view-lines').first().waitFor({ state: 'visible' })
}

export async function setEditorContent(page: Page, text: string) {
  const editor = page.locator('.editor-pane .monaco-editor').first()
  await editor.locator('.view-lines').click({ position: { x: 40, y: 12 } })
  await page.keyboard.press('Control+a')
  await page.keyboard.insertText(text)
  await expect(page.locator('.editor-pane .monaco-editor .view-lines').first()).toContainText(text)
}

export async function appendEditorText(page: Page, text: string) {
  const editor = page.locator('.editor-pane .monaco-editor').first()
  await editor.locator('.view-lines').click({ position: { x: 40, y: 12 } })
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.insertText(text)
}

export async function openAiRail(page: Page) {
  const toggle = page.locator('button.right-rail-toggle')
  await expect(toggle).toBeVisible()
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') {
    await toggle.click()
  }
  const aiTab = page.locator('.sidebar-tabs button[data-tab="ai"]')
  await expect(aiTab).toBeVisible()
  await aiTab.click()
  await expect(page.locator('textarea.ai-input')).toBeVisible()
}

export async function sendAi(page: Page, message: string) {
  const input = page.locator('textarea.ai-input')
  await input.fill(message)
  // AiPanel loads settings/active-session state asynchronously. The
  // composer is visible before that request resolves, but onSend
  // intentionally ignores input while `configured` is still false.
  // Gate sends on the same readiness signal a user sees.
  await expect(page.locator('button.ai-send')).toBeEnabled()
  await input.press('Enter')
}

export async function waitForChat(chatBodies: AnyRecord[], count: number): Promise<AnyRecord> {
  await expect.poll(() => chatBodies.length, { timeout: 15000 }).toBe(count)
  return chatBodies[chatBodies.length - 1]
}

// The Edit-10.3 wire contract: liveContext present, and none of the
// legacy/forbidden transport keys anywhere on the wire.
export function expectLiveOnly(body: AnyRecord): AnyRecord {
  expect(body.liveContext, 'chat request must carry liveContext').toBeTruthy()
  expect(body.currentNotePath).toBeUndefined()
  const wire = JSON.stringify(body)
  for (const forbidden of ['currentNotePath', 'currentNoteContent', 'attachments', 'filesystemPath', 'absolutePath']) {
    expect(wire, `wire must not mention ${forbidden}`).not.toContain(forbidden)
  }
  return body.liveContext
}

// Delete the Draft/Recovery IndexedDB (clean slate per test).
export async function clearDraftDatabase(page: Page) {
  await page.evaluate(async (databaseName) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(databaseName)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error('Draft database deletion blocked'))
    })
  }, DATABASE_NAME)
}

// Count draft rows whose content contains `marker` — via a raw
// IndexedDB read inside the browser. Only the COUNT crosses the
// evaluate boundary: draft bodies never enter the test process (never
// logged, snapshotted, or serialized).
export async function draftRowCount(page: Page, marker: string): Promise<number> {
  return page.evaluate((target) => new Promise<number>((resolve) => {
    const request = indexedDB.open(target.databaseName)
    const fail = () => resolve(0)
    request.onsuccess = () => {
      const db = request.result
      try {
        const all = db.transaction('drafts', 'readonly').objectStore('drafts').getAll()
        all.onsuccess = () => {
          resolve((all.result as Array<{ content?: string }>)
            .filter((row) => row.content?.includes(target.marker) ?? false).length)
          db.close()
        }
        all.onerror = () => { db.close(); fail() }
      } catch {
        db.close()
        fail()
      }
    }
    request.onerror = fail
    request.onblocked = fail
  }), { databaseName: DATABASE_NAME, marker })
}

// Seed a primary recovery draft through the production store module
// (real schema, real keyPath). baseContentHash: null classifies as
// 'unknown', which offers "Open Recovered Content" + "View Diff".
export async function seedRecoveryDraft(
  page: Page,
  draft: { vaultId: string; documentId: string; documentPath: string; content: string },
) {
  await page.evaluate(async (draftRecord) => {
    const { createDraftStore } = await import(
      '/src/composables/vault/draft-recovery/draftStore.ts'
    )
    await createDraftStore().saveDraft({
      version: 1,
      vaultId: draftRecord.vaultId,
      documentId: draftRecord.documentId,
      documentPath: draftRecord.documentPath,
      content: draftRecord.content,
      baseContentHash: null,
      baseModifiedAt: null,
      createdAt: 10,
      updatedAt: 20,
    })
  }, draft)
}

export async function openRecoveryDialog(page: Page) {
  const dialog = page.locator('.draft-recovery-dialog')
  await expect(dialog).toBeVisible({ timeout: 15000 })
  // Wait for classification (loading → ready): the action buttons render
  // only when status is 'ready'.
  await expect(dialog.getByRole('button', { name: 'Open Recovered Content' })).toBeVisible({ timeout: 15000 })
  return dialog
}

// afterAll cleanup: remove every document a spec created (server row +
// metadata + file) so the vault tree and git status stay clean.
export async function cleanupCreatedPaths(request: APIRequestContext, createdPaths: string[]) {
  for (const slug of createdPaths) {
    await request.delete(`/api/posts/${slug}`).catch(() => {})
    await fs.rm(path.join(E2E_VAULT, `${slug}.md`), { force: true }).catch(() => {})
  }
}

// Edit-10.3 E2E: the send-time live workspace snapshot travels from the
// browser to /api/ai/chat verbatim, for every context kind.
//
// Hermetic by construction:
//   - /api/ai/* is intercepted at the browser level: no Anthropic key is
//     needed; POST /api/ai/chat is answered with a minimal SSE stream and
//     its request body is captured for assertions.
//   - /api/history/* is intercepted in the History/Diff tests so the
//     pinned revision content is deterministic.
//   - Everything else (posts, files, health) is served by the real
//     embedded server. Test documents live under inbox/ with a per-run
//     slug and are removed in afterAll (untracked files under
//     src/content would fail the git-status gate).
//
// Helpers live in ./helpers/edit-program.ts — ONE shared semantics for
// every Edit Program spec (see that module's header).
import { expect, test } from './fixtures/auth'
import {
  type AnyRecord,
  clearDraftDatabase,
  cleanupCreatedPaths,
  createDoc,
  expectLiveOnly,
  interceptAiChat,
  interceptHistory,
  openAiRail,
  openDoc,
  gotoVaultReady,
  reloadApp,
  sendAi,
  setEditorContent,
  waitForChat,
} from './helpers/edit-program'

const RUN_ID = String(Date.now())
const createdPaths: string[] = []

let chatBodies: AnyRecord[] = []

test.beforeEach(async ({ page }) => {
  chatBodies = []
  await interceptAiChat(page, chatBodies)
  // Clear IndexedDB before mounting VaultView so Draft Store startup cannot
  // race the database deletion. The preview route is same-origin but does
  // not mount the Vault/Draft Store.
  await page.goto('/__markdown-test?mode=reading')
  await clearDraftDatabase(page)
  await gotoVaultReady(page)
})

test.afterAll(async ({ request }) => {
  await cleanupCreatedPaths(request, createdPaths)
})

test('E2E-1 dirty buffer: the full send-time snapshot travels verbatim', async ({ page, request }) => {
  const slug = `inbox/e2e-ai-d1-${RUN_ID}`
  const name = slug.split('/').pop()!
  const { documentId } = await createDoc(request, slug, `${name} on disk.\n`, createdPaths)
  await reloadApp(page)
  await openDoc(page, slug)
  // Open the AI rail BEFORE editing so the send happens inside the
  // 800ms autosave window: the snapshot must still be dirty.
  await openAiRail(page)

  const dirtyBody = `E2E1_DIRTY_BODY_${RUN_ID}`
  await setEditorContent(page, dirtyBody)
  await sendAi(page, 'read my dirty buffer')
  const body = await waitForChat(chatBodies, 1)

  const ctx = expectLiveOnly(body)
  expect(ctx.v).toBe(1)
  expect(ctx.kind).toBe('document')
  expect(ctx.raw).toBe(dirtyBody) // byte-exact buffer, not the disk version
  expect(ctx.dirty).toBe(true)
  expect(ctx.saveStatus).toBe('dirty')
  expect(ctx.revision).toBeGreaterThan(ctx.savedRevision)
  expect(ctx.identity).toEqual({ documentId, path: slug })
  expect(ctx.workspaceTabId).toBe(slug)
  expect(ctx.title).toBe(name)
  expect(ctx.vaultId).toBeTruthy()
  expect(typeof ctx.capturedAt).toBe('number')
  expect('external' in ctx).toBe(false)
})
test('E2E-2 two open documents: only the active tab is captured', async ({ page, request }) => {
  const slugA = `inbox/e2e-ai-d2a-${RUN_ID}`
  const slugB = `inbox/e2e-ai-d2b-${RUN_ID}`
  const markerA = `E2E2_A_BODY_${RUN_ID}`
  await createDoc(request, slugA, `${markerA}\n`, createdPaths)
  const docB = await createDoc(request, slugB, `${slugB.split('/').pop()} on disk.\n`, createdPaths)
  await reloadApp(page)
  await openDoc(page, slugA)
  await openDoc(page, slugB) // B is the active tab
  await openAiRail(page)

  const markerB = `E2E2_B_BODY_${RUN_ID}`
  await setEditorContent(page, markerB)
  await sendAi(page, 'which document am I?')
  const body = await waitForChat(chatBodies, 1)

  const ctx = expectLiveOnly(body)
  expect(ctx.kind).toBe('document')
  expect(ctx.identity).toEqual({ documentId: docB.documentId, path: slugB })
  expect(ctx.raw).toBe(markerB)
  expect(JSON.stringify(body)).not.toContain(markerA) // A never leaked in
})
test('E2E-3 history snapshot: read-only revision raw, not the disk version', async ({ page, request }) => {
  const slug = `inbox/e2e-ai-h3-${RUN_ID}`
  const name = slug.split('/').pop()!
  await createDoc(request, slug, `${name} current disk.\n`, createdPaths)
  const sha = `e2e3sha${RUN_ID}`
  const revisionRaw = `E2E3_HISTORY_RAW_${RUN_ID}`
  // Install the fake history BEFORE the reload: routes survive
  // navigation, and the panel's log fetch happens on open either way.
  await interceptHistory(page, { files: [`${slug}.md`], raw: revisionRaw, sha })
  await reloadApp(page)
  await openDoc(page, slug)

  await page.locator('button.ab-btn[aria-label="History"]').click()
  const dayRow = page.locator('.history-timeline-group-header').first()
  await expect(dayRow).toBeVisible({ timeout: 10000 })
  await dayRow.click()
  await page.locator('.history-commit-row').first().click()
  await page.locator('.history-file-row', { hasText: name }).click()
  await expect(page.locator('.history-comparison-pane')).toBeVisible({ timeout: 10000 })

  await openAiRail(page)
  await sendAi(page, 'summarize this revision')
  const body = await waitForChat(chatBodies, 1)

  const ctx = expectLiveOnly(body)
  // The current history UI opens a read-only commit comparison directly;
  // its selected revision is the comparison's after side in commit-change
  // mode, rather than a separate history snapshot workspace.
  expect(ctx.kind).toBe('diff')
  expect(ctx.readOnly).toBe(true)
  expect(ctx.before.source).toBe('history')
  expect(ctx.after.source).toBe('comparison-snapshot')
  expect(ctx.after.raw).toBe(revisionRaw)
  expect(ctx.after.dirty).toBe(false)
  expect(ctx.identity).toEqual({
    path: slug,
    revisionId: sha,
    revisionTime: expect.any(Number),
    currentDocumentId: null,
  })
})
test('E2E-4 history diff: before is the revision, after is the live buffer', async ({ page, request }) => {
  const slug = `inbox/e2e-ai-h4-${RUN_ID}`
  const name = slug.split('/').pop()!
  const doc = await createDoc(request, slug, `${name} current disk.\n`, createdPaths)
  const sha = `e2e4sha${RUN_ID}`
  const revisionRaw = `E2E4_HISTORY_RAW_${RUN_ID}`
  await interceptHistory(page, { files: [`${slug}.md`], raw: revisionRaw, sha })
  await reloadApp(page)
  await openDoc(page, slug) // the document editor stays open behind the diff

  await page.locator('button.ab-btn[aria-label="History"]').click()
  const dayRow = page.locator('.history-timeline-group-header').first()
  await expect(dayRow).toBeVisible({ timeout: 10000 })
  await dayRow.click()
  await page.locator('.history-commit-row').first().click()
  await page.locator('.history-file-row', { hasText: name }).click()
  await expect(page.locator('.history-comparison-pane')).toBeVisible({ timeout: 10000 })
  await page.locator('.history-pane-menu-trigger').click()
  await page.getByRole('menuitem', { name: 'Compare with Working Tree' }).click()
  await expect(page.locator('.history-comparison-pane')).toBeVisible({ timeout: 10000 })

  await openAiRail(page)
  await sendAi(page, 'explain this diff')
  const body = await waitForChat(chatBodies, 1)

  const ctx = expectLiveOnly(body)
  expect(ctx.kind).toBe('diff')
  expect(ctx.readOnly).toBe(true)
  expect(ctx.before.source).toBe('history')
  expect(ctx.before.raw).toBe(revisionRaw)
  expect(ctx.after.source).toBe('live-editor')
  expect(ctx.after.raw).toBe(doc.raw) // untouched buffer == canonical disk
  expect(ctx.after.dirty).toBe(false)
  expect(ctx.identity).toEqual({
    path: slug,
    revisionId: sha,
    revisionTime: expect.any(Number),
    currentDocumentId: doc.documentId,
  })
})
test('E2E-8 capture-then-switch: the send-time snapshot survives a tab switch', async ({ page, request }) => {
  const slugA = `inbox/e2e-ai-s8a-${RUN_ID}`
  const slugB = `inbox/e2e-ai-s8b-${RUN_ID}`
  await createDoc(request, slugA, `${slugA.split('/').pop()} on disk.\n`, createdPaths)
  await createDoc(request, slugB, `${slugB.split('/').pop()} on disk.\n`, createdPaths)
  await reloadApp(page)
  await openDoc(page, slugA)
  await openDoc(page, slugB)
  await page.locator(`[data-tab-id="${slugA}"]`).click() // A is active again
  await openAiRail(page)

  const bodyA = `E2E8_A_${RUN_ID}`
  await setEditorContent(page, bodyA)
  await sendAi(page, 'hi from A')
  // Immediately switch away: the request must still carry A's snapshot.
  await page.locator(`[data-tab-id="${slugB}"]`).click()
  const body = await waitForChat(chatBodies, 1)

  const ctx = expectLiveOnly(body)
  expect(ctx.kind).toBe('document')
  expect(ctx.identity.path).toBe(slugA)
  expect(ctx.raw).toBe(bodyA)
  expect(JSON.stringify(body)).not.toContain(slugB)
})

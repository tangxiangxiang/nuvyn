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
import { expect, test } from '../fixtures/auth'
import {
  type AnyRecord,
  appendEditorText,
  clearDraftDatabase,
  cleanupCreatedPaths,
  createDoc,
  expectLiveOnly,
  interceptAiChat,
  openAiRail,
  openDoc,
  openRecoveryDialog,
  gotoVaultReady,
  reloadApp,
  seedRecoveryDraft,
  sendAi,
  setEditorContent,
  waitForChat,
} from '../helpers/edit-program'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const E2E_VAULT = process.env.NUVYN_DRAFT_E2E_VAULT ?? path.join('src', 'content')

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

test('E2E-5 recovery content view: browser-local draft with no disk block', async ({ page, request }) => {
  const slug = `inbox/e2e-ai-r5-${RUN_ID}`
  const name = slug.split('/').pop()!
  const { documentId } = await createDoc(request, slug, `${name} on disk.\n`, createdPaths)
  const identity = await (await request.get('/api/vault/identity')).json()
  const draftBody = `E2E5_DRAFT_${RUN_ID}`
  await seedRecoveryDraft(page, {
    vaultId: identity.vaultId,
    documentId,
    documentPath: slug,
    content: draftBody,
  })
  await page.reload()

  const dialog = await openRecoveryDialog(page)
  await dialog.getByRole('button', { name: 'Open Recovered Content' }).click()
  await expect(page.locator('.draft-recovery-pane')).toBeVisible({ timeout: 10000 })

  await openAiRail(page)
  await sendAi(page, 'help me with this recovered draft')
  const body = await waitForChat(chatBodies, 1)

  const ctx = expectLiveOnly(body)
  expect(ctx.kind).toBe('recovery')
  expect(ctx.readOnly).toBe(true)
  expect(ctx.view).toBe('content')
  expect(ctx.draft.raw).toBe(draftBody)
  expect('disk' in ctx, 'content view must not carry a disk block').toBe(false)
  expect(ctx.decisionKind).toBe('unknown')
  expect(ctx.identity).toEqual({
    recoveryId: expect.any(String),
    documentId,
    path: slug,
    source: 'primary',
  })
})
test('E2E-6 recovery diff view: draft and disk sides from one snapshot', async ({ page, request }) => {
  const slug = `inbox/e2e-ai-r6-${RUN_ID}`
  const name = slug.split('/').pop()!
  const doc = await createDoc(request, slug, `${name} on disk.\n`, createdPaths)
  const identity = await (await request.get('/api/vault/identity')).json()
  const draftBody = `E2E6_DRAFT_${RUN_ID}`
  await seedRecoveryDraft(page, {
    vaultId: identity.vaultId,
    documentId: doc.documentId,
    documentPath: slug,
    content: draftBody,
  })
  await page.reload()

  const dialog = await openRecoveryDialog(page)
  await dialog.getByRole('button', { name: 'View Diff' }).click()
  await expect(page.locator('.draft-recovery-pane')).toBeVisible({ timeout: 10000 })

  await openAiRail(page)
  await sendAi(page, 'what changed in this draft')
  const body = await waitForChat(chatBodies, 1)

  const ctx = expectLiveOnly(body)
  expect(ctx.kind).toBe('recovery')
  expect(ctx.readOnly).toBe(true)
  expect(ctx.view).toBe('diff')
  expect(ctx.draft.raw).toBe(draftBody)
  expect(ctx.disk.raw).toBe(doc.raw)
  expect(ctx.disk.documentId).toBe(doc.documentId)
  expect(ctx.identity).toEqual({
    recoveryId: expect.any(String),
    documentId: doc.documentId,
    path: slug,
    source: 'primary',
  })
})
test('E2E-7 recovery beats the route: deep-linked document does not win', async ({ page, request }) => {
  const slug = `inbox/e2e-ai-r7-${RUN_ID}`
  const name = slug.split('/').pop()!
  const { documentId } = await createDoc(request, slug, `${name} on disk.\n`, createdPaths)
  const identity = await (await request.get('/api/vault/identity')).json()
  const draftBody = `E2E7_DRAFT_${RUN_ID}`
  await seedRecoveryDraft(page, {
    vaultId: identity.vaultId,
    documentId,
    documentPath: slug,
    content: draftBody,
  })

  // Deep link straight to the document: the route opens a document tab,
  // and the recovery prompt appears on top of it. Recovery must win.
  await page.goto(`/vault/${slug}`)
  const dialog = await openRecoveryDialog(page)
  await dialog.getByRole('button', { name: 'Open Recovered Content' }).click()
  await expect(page.locator('.draft-recovery-pane')).toBeVisible({ timeout: 10000 })

  await openAiRail(page)
  await sendAi(page, 'which context is this')
  const body = await waitForChat(chatBodies, 1)

  const ctx = expectLiveOnly(body)
  expect(ctx.kind).toBe('recovery') // NOT 'document'
  expect(ctx.view).toBe('content')
  expect(ctx.draft.raw).toBe(draftBody)
  expect(ctx.identity.path).toBe(slug)
  expect(ctx.identity.documentId).toBe(documentId)
})
test('E2E-9 rename: the stable documentId survives a path change', async ({ page, request }) => {
  const slug = `inbox/e2e-ai-n9-${RUN_ID}`
  const name = slug.split('/').pop()!
  const { documentId } = await createDoc(request, slug, `${name} on disk.\n`, createdPaths)
  await reloadApp(page)
  await openDoc(page, slug)

  await page.locator(`[data-tree-key="file:${slug}"]`).click({ button: 'right' })
  await page.locator('.tree-context-menu button', { hasText: 'Rename' }).click()
  const newName = `e2e-ai-ren9-${RUN_ID}`
  const promptDialog = page.locator('.n-dialog[role="dialog"]')
  const input = promptDialog.getByRole('textbox')
  await expect(input).toBeVisible()
  await input.fill(newName)
  await promptDialog.getByRole('button', { name: 'Confirm', exact: true }).click()

  const newSlug = `inbox/${newName}`
  createdPaths.push(newSlug)
  await expect(page.locator(`[data-tab-id="${newSlug}"]`)).toBeVisible({ timeout: 10000 })

  await openAiRail(page)
  await sendAi(page, 'still the same document?')
  const body = await waitForChat(chatBodies, 1)

  const ctx = expectLiveOnly(body)
  expect(ctx.kind).toBe('document')
  // New path, same stable identity.
  expect(ctx.identity).toEqual({ documentId, path: newSlug })
})
test('E2E-10 external conflict: buffer and disk version travel together', async ({ page, request }) => {
  const slug = `inbox/e2e-ai-x10-${RUN_ID}`
  const { documentId } = await createDoc(request, slug, `${slug.split('/').pop()} on disk.\n`, createdPaths)
  await reloadApp(page)
  await openDoc(page, slug)
  await openAiRail(page)

  // Baseline: type, let the 800ms-debounced autosave land (disk == buffer,
  // clean). A CLEAN buffer silently adopts disk changes, so the external
  // state only surfaces while the buffer is dirty — append a tail and
  // change the disk before the next autosave fires.
  const buffer = `E2E10_BUFFER_${RUN_ID}`
  await setEditorContent(page, buffer)
  await expect(page.locator(`[data-tab-id="${slug}"][data-save-status="saved"]`)).toBeVisible({ timeout: 10000 })

  const tail = `E2E10_DIRTY_TAIL_${RUN_ID}`
  await appendEditorText(page, tail) // buffer is dirty again
  const diskBody = `E2E10_DISK_${RUN_ID} changed externally\n`
  await fs.writeFile(path.join(E2E_VAULT, `${slug}.md`), diskBody, 'utf8')
  // The debounced autosave's baseRaw now mismatches the disk: the 409
  // conflict path flips the tab to 'external' with the disk side attached.
  await expect(page.locator(`[data-tab-id="${slug}"][data-save-status="external"]`)).toBeVisible({ timeout: 20000 })

  await sendAi(page, 'what changed on disk?')
  const body = await waitForChat(chatBodies, 1)

  const ctx = expectLiveOnly(body)
  expect(ctx.kind).toBe('document')
  expect(ctx.raw).toBe(`${buffer}\n${tail}`) // the buffer is preserved, not reloaded
  expect(ctx.saveStatus).toBe('external')
  expect(ctx.external).toEqual({ kind: 'modified', raw: diskBody })
  expect(ctx.identity).toEqual({ documentId, path: slug })
})

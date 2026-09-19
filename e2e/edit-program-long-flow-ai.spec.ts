// Nuvyn Edit Program — Final Closure: cross-Edit long user journeys.
// Each independent chain lives in its own spec so file-level sharding can
// distribute the two expensive flows without changing their fixtures.

import { expect, test } from './fixtures/auth'
import {
  type AnyRecord,
  appendEditorText,
  cleanupCreatedPaths,
  clearDraftDatabase,
  createDoc,
  draftRowCount,
  expectLiveOnly,
  interceptAiChatGated,
  interceptAutosaveAborted,
  interceptAutosaveHeld,
  openAiRail,
  openDoc,
  raceSse,
  gotoVaultReady,
  reloadApp,
  sendAi,
  setEditorContent,
} from './helpers/edit-program'

const RUN_ID = String(Date.now())
const createdPaths: string[] = []

test.beforeEach(async ({ page }) => {
  await page.goto('/__markdown-test?mode=reading')
  await clearDraftDatabase(page)
  await gotoVaultReady(page)
})

test.afterAll(async ({ request }) => {
  await cleanupCreatedPaths(request, createdPaths)
})

test('Long Flow B — AI live context, external conflict, and multi-tab authority in one chain', async ({ page, request }) => {
  const slugA = `inbox/e2e-lfb-a-${RUN_ID}`
  const slugB = `inbox/e2e-lfb-b-${RUN_ID}`
  const bodyA = `E2ELFB_A_${RUN_ID}\n`
  const bodyB = `E2ELFB_B_${RUN_ID}\n`
  const markerA2 = `E2ELFB_A2_${RUN_ID}`
  const tailB = `E2ELFB_TB_${RUN_ID}`
  const aiBodyB = `E2ELFB_AI_${RUN_ID}\n`

  const docA = await createDoc(request, slugA, bodyA, createdPaths)
  const docB = await createDoc(request, slugB, bodyB, createdPaths)

  // Install the AI route before boot: AiPanel loads /api/ai/settings
  // eagerly, so a post-boot interceptor can miss that request and
  // leave the composer correctly disabled on a clean CI machine with
  // no real API key.
  const chatBodies: AnyRecord[] = []
  let releaseRace = () => {}
  const raceGate = new Promise<void>((resolve) => { releaseRace = resolve })
  let descriptor: { mtime: number } | null = null
  await interceptAiChatGated(page, chatBodies, raceGate, () => raceSse(slugB, aiBodyB, descriptor?.mtime ?? 0))

  await reloadApp(page)
  await openDoc(page, slugA)
  await openDoc(page, slugB) // both tabs open; B is active

  // ── 1. A is dirty (its save is held like a crash window); B is
  //    clean and saved ───────────────────────────────────────────────
  await interceptAutosaveAborted(page, slugA)
  await page.locator(`[data-tab-id="${slugA}"]`).click()
  await setEditorContent(page, markerA2)
  await expect(page.locator(`[data-tab-id="${slugA}"][data-save-status="dirty"]`)).toBeVisible({ timeout: 15000 })
  await expect.poll(() => draftRowCount(page, markerA2), { timeout: 15000 }).toBeGreaterThanOrEqual(1)
  await page.locator(`[data-tab-id="${slugB}"]`).click() // B active again

  // ── 2. Send on CLEAN B: the snapshot carries B's identity and B's
  //    bytes only ────────────────────────────────────────────────────
  const autosave = { seen: false, statuses: [] as number[] }
  let releaseAutosave = () => {}
  const autosaveGate = new Promise<void>((resolve) => { releaseAutosave = resolve })
  await interceptAutosaveHeld(page, slugB, autosave, autosaveGate)

  await openAiRail(page)
  await sendAi(page, 'please rewrite my note')
  await expect.poll(() => chatBodies.length, { timeout: 15000 }).toBe(1)
  const ctx1 = expectLiveOnly(chatBodies[0])
  expect(ctx1.kind).toBe('document')
  expect(ctx1.dirty).toBe(false)
  expect(ctx1.raw).toBe(bodyB) // send-time clean: buffer == disk
  expect(ctx1.identity).toEqual({ documentId: docB.documentId, path: slugB })

  // ── 3. The user keeps typing on B while the AI turn is open; the
  //    debounced autosave leaves the app and is HELD — nothing has
  //    reached the server ────────────────────────────────────────────
  await appendEditorText(page, tailB)
  await expect(page.locator(`[data-tab-id="${slugB}"][data-save-status="dirty"]`)).toBeVisible({ timeout: 15000 })
  await expect.poll(() => autosave.seen, { timeout: 15000 }).toBe(true)
  expect((await (await request.get(`/api/posts/${slugB}`)).json()).raw).toBe(bodyB) // server still clean

  // ── 4. The same-path mutation lands through the REAL server CAS
  //    (APIRequestContext bypasses page.route — the held autosave is
  //    untouched). It succeeds BECAUSE the disk still equals the
  //    send-time snapshot ────────────────────────────────────────────
  const mutation = await request.put(`/api/posts/${slugB}`, { data: { raw: aiBodyB, baseRaw: bodyB } })
  expect(mutation.status()).toBeLessThan(300)
  const afterMutation = await (await request.get(`/api/posts/${slugB}`)).json()
  expect(afterMutation.raw).toBe(aiBodyB)
  expect(afterMutation.metadata.id).toBe(docB.documentId)
  descriptor = { mtime: afterMutation.mtime as number }

  // ── 5. Release the held autosave: its baseRaw no longer matches the
  //    AI-written disk → REAL 409 → B flips external ─────────────────
  releaseAutosave()
  await expect.poll(() => autosave.statuses.length, { timeout: 15000 }).toBe(1)
  expect(autosave.statuses[0]).toBe(409)
  await expect(page.locator(`[data-tab-id="${slugB}"][data-save-status="external"]`)).toBeVisible({ timeout: 15000 })

  // ── 6. Release the AI turn: the SSE file_changed reaches the real
  //    client chain; the buffer is dirty and the save is done, so the
  //    overwrite confirm appears once — Cancel keeps the local bytes ─
  releaseRace()
  const confirmDialog = page.locator('.n-dialog[role="dialog"]')
  await expect(confirmDialog).toBeVisible({ timeout: 15000 })
  await expect(confirmDialog).toContainText(slugB)
  await confirmDialog.getByRole('button', { name: 'Cancel', exact: true }).click() // Cancel = keep local
  await expect(confirmDialog).not.toBeVisible()

  await expect(page.locator('.editor-pane .monaco-editor .view-lines').first()).toContainText(tailB)
  expect((await (await request.get(`/api/posts/${slugB}`)).json()).raw).toBe(aiBodyB) // no auto-save of local
  await expect(page.locator('[data-tab-id]')).toHaveCount(2) // no wrong tab / recovery tab
  await expect(page.locator('.draft-recovery-backdrop')).toHaveCount(0)
  expect(autosave.statuses).toEqual([409]) // exactly one autosave, the real 409

  // ── 7. Multi-tab authority: switch to A and Send — the request
  //    carries A's dirty identity and A's bytes; B never leaks in ────
  await page.locator(`[data-tab-id="${slugA}"]`).click()
  await sendAi(page, 'and which document is this?')
  await expect.poll(() => chatBodies.length, { timeout: 15000 }).toBe(2)
  const ctx2 = expectLiveOnly(chatBodies[1])
  expect(ctx2.kind).toBe('document')
  expect(ctx2.identity).toEqual({ documentId: docA.documentId, path: slugA })
  expect(ctx2.raw).toBe(markerA2) // A's unsaved buffer
  expect(ctx2.dirty).toBe(true)
  const wire2 = JSON.stringify(chatBodies[1])
  expect(wire2).not.toContain(slugB)
  expect(wire2).not.toContain(aiBodyB.trim())

  // ── 8. Back to B: the conflict is the user's to resolve — "keep
  //    local version" writes the buffer through the real save path ──
  await page.locator(`[data-tab-id="${slugB}"]`).click()
  const keepLocal = page.locator('button[aria-label="Keep local version and overwrite disk"]')
  await expect(keepLocal).toBeVisible({ timeout: 15000 })
  await keepLocal.click()
  await expect(page.locator(`[data-tab-id="${slugB}"][data-save-status="saved"]`)).toBeVisible({ timeout: 15000 })
  const resolved = await (await request.get(`/api/posts/${slugB}`)).json()
  expect(resolved.raw).toBe(`${bodyB}\n${tailB}`) // the local buffer, byte-exact
  expect(resolved.metadata.id).toBe(docB.documentId)
  await page.unroute(`**/api/posts/${slugB}`)

  // ── 9. Refresh: B reopens clean and consistent; A's unsaved buffer
  //    is re-adopted by startup Recovery (its save was still held) ──
  await page.reload()
  await expect(page.locator('.draft-recovery-backdrop')).toHaveCount(0)
  await openDoc(page, slugB)
  await expect(page.locator('.editor-pane .monaco-editor .view-lines').first())
    .toContainText(tailB, { timeout: 15000 })
  const finalB = await (await request.get(`/api/posts/${slugB}`)).json()
  expect(finalB.raw).toBe(`${bodyB}\n${tailB}`)
  expect(finalB.metadata.id).toBe(docB.documentId)
  expect(await draftRowCount(page, tailB)).toBe(0) // B's draft cleaned on its save

  await expect(page.locator(`[data-tab-id="${slugA}"]`)).toBeVisible({ timeout: 15000 })
  await page.locator(`[data-tab-id="${slugA}"]`).click()
  await expect(page.locator('.editor-pane .monaco-editor .view-lines').first())
    .toContainText(markerA2, { timeout: 15000 }) // A's unsaved input survived the refresh
  await expect(page.locator(`[data-tab-id="${slugA}"][data-save-status="dirty"]`)).toBeVisible({ timeout: 15000 })
})

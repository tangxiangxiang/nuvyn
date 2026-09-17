// Nuvyn Edit Program — Final Closure: cross-Edit long user journeys.
//
// Two real-browser chains that cross EVERY sealed Edit in a single
// user story each (§7). Each step is gated on a network or DOM
// condition — no waitForTimeout sequencing anywhere.
//
// ── Long Flow A — Recovery / History / Rename ──────────────────────
//    create → save rev A → save rev B → dirty C → refresh (Recovery
//    adopts C into the dirty buffer — the product's keep-your-input
//    path) → save → divergent recovery (external disk change while
//    dirty D → refresh → prompt → View Diff both sides → Open
//    Recovered Content → explicit Use Disk Version → correct draft
//    cleanup, no merge) → History rev A → Diff A-vs-live (read-only,
//    zero autosave, buffer untouched) → rename (documentId survives,
//    backlinks rewritten) → refresh → reopen (body/identity intact,
//    no stale Recovery, History reachable under the new path).
//
//    §7's literal order "refresh → Recovery → diff → keep C → save"
//    maps to TWO product branches, both covered in this chain:
//    baseline-match recovery silently adopts the unsaved buffer (the
//    keep-C path — divergent records are NEVER auto-adopted, by
//    design), and the divergent branch surfaces the prompt + diff +
//    explicit decision. One doc cannot hit both in one refresh, so
//    the flow runs them back to back on the same identity.
//
// ── Long Flow B — AI / External / Multi-tab ────────────────────────
//    open A+B → A dirty / B clean → Send on B (clean snapshot, B's
//    identity only) → type on B while the AI turn is held → real
//    same-path server mutation through the CAS write path → held
//    autosave 409s → B flips external → SSE file_changed through the
//    real client chain → overwrite confirm → Cancel keeps the local
//    buffer → switch to A → Send (A's dirty identity only, B never
//    leaks) → back to B → resolve external "keep local" → save →
//    refresh → A's unsaved buffer re-adopted, B clean and consistent,
//    identities/raw/metadata stable.
//
// Hermetic exactly like the sealed harness: /api/ai/** intercepted at
// the browser layer (no Anthropic round-trip), /api/history/** pinned
// fake timeline where History is exercised, everything else served by
// the real embedded server. The same-path mutation is a REAL REST CAS
// PUT via APIRequestContext (bypasses page.route, so the held
// browser autosave is untouched) — interlocking with the server
// closure suite, which proves the same write executes/blocks through
// the real runChat chain.
import { promises as fs } from 'node:fs'
import path from 'node:path'

const E2E_VAULT = process.env.NUVYN_DRAFT_E2E_VAULT ?? path.join('src', 'content')
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
  interceptHistory,
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

test('Long Flow A — Recovery → History/Diff → Rename across one document life', async ({ page, request }) => {
  const name = `e2e-lfa-${RUN_ID}`
  const slug = `inbox/${name}`
  const refName = `e2e-lfa-ref-${RUN_ID}`
  const refSlug = `inbox/${refName}`
  const bodyA = `E2ELFA_REVA_${RUN_ID}\n`
  const revB = `E2ELFA_REVB_${RUN_ID}`
  const markerC = `E2ELFA_C_${RUN_ID}`
  const markerD = `E2ELFA_D_${RUN_ID}`
  const markerX = `E2ELFA_X_${RUN_ID}`

  // ── P0: rev A on disk + a backlink source document ────────────────
  const doc = await createDoc(request, slug, bodyA, createdPaths)
  const documentId = doc.documentId
  await createDoc(request, refSlug, `See [[${name}]] here.\n`, createdPaths)

  // ── P1: edit to rev B (real autosave), then the crash path: dirty C
  //    persisted, refresh, baseline-match Recovery adopts C into the
  //    dirty buffer WITHOUT a prompt, then the user's next edit lands
  //    the save; the draft is cleaned exactly on that successful save ─
  await reloadApp(page)
  await openDoc(page, slug)
  await setEditorContent(page, revB)
  await expect(page.locator(`[data-tab-id="${slug}"][data-save-status="saved"]`)).toBeVisible({ timeout: 15000 })

  await interceptAutosaveAborted(page, slug) // crash model: saves never complete
  await appendEditorText(page, markerC)
  await expect.poll(() => draftRowCount(page, markerC), { timeout: 15000 }).toBeGreaterThanOrEqual(1)
  await page.reload()

  const editorLines = page.locator('.editor-pane .monaco-editor .view-lines').first()
  await expect(editorLines).toContainText(markerC, { timeout: 15000 }) // adopted
  await expect(page.locator('.draft-recovery-backdrop')).toHaveCount(0) // never prompted

  await page.unroute(`**/api/posts/${slug}`)
  await appendEditorText(page, '.') // the user keeps working; this edit autosaves
  await expect(page.locator(`[data-tab-id="${slug}"][data-save-status="saved"]`)).toBeVisible({ timeout: 15000 })
  const E1 = `${revB}\n${markerC}\n.`
  let serverDoc = await (await request.get(`/api/posts/${slug}`)).json()
  expect(serverDoc.raw).toBe(E1) // byte-exact reload contract
  expect(serverDoc.metadata.id).toBe(documentId)
  await expect.poll(() => draftRowCount(page, markerC), { timeout: 15000 }).toBe(0) // cleaned on save

  // ── P2: dirty D + an external disk change → refresh → DIVERGENT
  //    recovery: prompt → View Diff shows BOTH sides → Open Recovered
  //    Content → explicit "Use Disk Version" → draft discarded, buffer
  //    is the disk version, nothing merged ────────────────────────────
  await interceptAutosaveAborted(page, slug)
  await appendEditorText(page, markerD)
  await expect.poll(() => draftRowCount(page, markerD), { timeout: 15000 }).toBeGreaterThanOrEqual(1)
  await fs.appendFile(path.join(E2E_VAULT, `${slug}.md`), `\n${markerX}\n`)

  // Pin the fake timeline BEFORE this reload: the History composable
  // fetches status/timeline at app boot (it drives the activity-bar
  // badge), so a post-boot install loses the race and the panel shows
  // the real repo timeline — the same reason the sealed E2E-3 installs
  // its intercept before reloadApp.
  const sha = `e2elfasha${RUN_ID}`
  await interceptHistory(page, { files: [`${slug}.md`], raw: bodyA, sha })
  await page.reload()

  const dialog = page.locator('.draft-recovery-dialog')
  await expect(dialog).toBeVisible({ timeout: 15000 })
  await expect(dialog).toContainText('The draft and disk version may both have changed.')
  await dialog.getByRole('button', { name: 'View Diff' }).click()

  const pane = page.locator('.draft-recovery-pane')
  await expect(pane).toBeVisible({ timeout: 10000 })
  await expect(pane).toContainText(markerD) // the unsaved draft side
  await expect(pane).toContainText(markerX) // the divergent disk side
  await pane.getByRole('button', { name: 'Open Recovered Content' }).click()
  await expect(pane).toContainText(markerD)
  await pane.getByRole('button', { name: 'Use Disk Version' }).click()

  await expect(pane).toHaveCount(0)
  await expect(dialog).toHaveCount(0)
  await expect.poll(() => draftRowCount(page, markerD), { timeout: 15000 }).toBe(0) // discard cleaned it
  const editorLines2 = page.locator('.editor-pane .monaco-editor .view-lines').first()
  await expect(editorLines2).toContainText(markerX, { timeout: 15000 })
  await expect(editorLines2).not.toContainText(markerD) // no merge of the draft
  await page.unroute(`**/api/posts/${slug}`)
  const Ef = `${E1}\n${markerX}\n`
  serverDoc = await (await request.get(`/api/posts/${slug}`)).json()
  expect(serverDoc.raw).toBe(Ef) // disk won, byte-exact
  expect(serverDoc.metadata.id).toBe(documentId)

  // ── P3: History rev A → Diff A-vs-live → close: the read-only panes
  //    never mutate the document (zero PUTs), the live buffer is
  //    untouched, no overwrite confirm ever appears ──────────────────
  let putCount = 0
  await page.route(`**/api/posts/${slug}`, (route) => {
    if (route.request().method() === 'PUT') putCount += 1
    return route.continue()
  })

  await page.locator('button.ab-btn[aria-label="History"]').click()
  const dayRow = page.locator('.history-timeline-group-header').first()
  await expect(dayRow).toBeVisible({ timeout: 10000 })
  await dayRow.click()
  await page.locator('.history-commit-row').first().click()
  await page.locator('.history-file-row', { hasText: name }).click()
  const comparison = page.locator('.history-comparison-pane')
  await expect(comparison).toBeVisible({ timeout: 10000 })
  await comparison.getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('menuitem', { name: 'Compare with Working Tree' }).click()
  await expect(comparison).toContainText(bodyA.trim()) // before = rev A
  await expect(comparison).toContainText(markerX) // after = the live buffer

  expect(putCount).toBe(0) // History/Diff never autosaved the document
  await expect(page.locator('.n-dialog[role="dialog"]')).toHaveCount(0)

  // Close Diff returns to the read-only revision viewer (its own
  // "(History)" tab), NOT to the live document — leave the History
  // tab, switch back to Explorer + the live document, and the buffer
  // must be exactly what it was before the panes opened. (A hidden
  // Monaco virtualizes to its first visible line, so the document tab
  // must be the active pane before view-lines is read.)
  await page.getByRole('button', { name: /Explorer/ }).click()
  await page.locator(`[data-tab-id="${slug}"]`).click()
  await expect(page.locator('.editor-pane .monaco-editor .view-lines').first()).toContainText(markerX)
  await page.unroute(`**/api/posts/${slug}`)

  // ── P4: rename — documentId survives the path change, bytes travel
  //    with it, the old path dies, and the backlink source is rewritten
  const newName = `e2e-lfa-ren-${RUN_ID}`
  await page.locator(`[data-tree-key="file:${slug}"]`).click({ button: 'right' })
  await page.locator('.tree-context-menu button', { hasText: 'Rename' }).click()
  const promptDialog = page.locator('.n-dialog[role="dialog"]')
  const promptInput = promptDialog.getByRole('textbox')
  await expect(promptInput).toBeVisible()
  await promptInput.fill(newName)
  await promptDialog.getByRole('button', { name: 'Confirm', exact: true }).click()

  const refsConfirm = page.getByRole('dialog', { name: /link to this note/i })
  await expect(refsConfirm).toBeVisible({ timeout: 10000 })
  await expect(refsConfirm).toContainText('link to this note')
  await refsConfirm.getByRole('button').last().click()

  const newSlug = `inbox/${newName}`
  createdPaths.push(newSlug)
  await expect(page.locator(`[data-tab-id="${newSlug}"]`)).toBeVisible({ timeout: 10000 })

  const renamedDoc = await (await request.get(`/api/posts/${newSlug}`)).json()
  expect(renamedDoc.raw).toBe(Ef) // bytes preserved across the rename
  expect(renamedDoc.metadata.id).toBe(documentId) // identity preserved
  expect((await request.get(`/api/posts/${slug}`)).status()).toBe(404) // old path dead
  const refDoc = await (await request.get(`/api/posts/${refSlug}`)).json()
  // The rewriter's canonical link form is vault-root-relative.
  expect(refDoc.raw).toContain(`[[inbox/${newName}]]`) // backlink rewritten
  expect(refDoc.raw).not.toContain(`[[${name}]]`) // old target gone
  expect(refDoc.raw).not.toContain(`[[inbox/${name}]]`)

  // ── P5: refresh → reopen — body and identity intact, NO stale
  //    Recovery re-popup, and History is reachable under the new path.
  //    Re-pin the timeline under the NEW path BEFORE the reload
  //    (boot-time fetch again; LIFO overrides the pre-rename pin),
  //    with a DISTINCT commit subject so the drill-down below proves
  //    the post-rename pin — not the pre-rename one — was served ─────
  await interceptHistory(page, { files: [`${newSlug}.md`], raw: bodyA, sha, subject: 'E2E pinned after rename' })
  await page.reload()
  await expect(page.locator('.draft-recovery-backdrop')).toHaveCount(0)
  await expect(page.locator('.draft-recovery-dialog')).toHaveCount(0)
  await openDoc(page, newSlug)
  const editorLines3 = page.locator('.editor-pane .monaco-editor .view-lines').first()
  await expect(editorLines3).toContainText(markerX, { timeout: 15000 })
  await expect(editorLines3).toContainText(markerC) // the full saved body survived
  await expect(page.locator(`[data-tree-key="file:${slug}"]`)).toHaveCount(0) // old row gone

  const reopened = await (await request.get(`/api/posts/${newSlug}`)).json()
  expect(reopened.raw).toBe(Ef)
  expect(reopened.metadata.id).toBe(documentId)
  expect(await draftRowCount(page, markerC)).toBe(0) // no stale drafts
  expect(await draftRowCount(page, markerD)).toBe(0)

  await page.locator('button.ab-btn[aria-label="History"]').click()
  // The fake timeline carries exactly one commit. Expand the current
  // date, then its commit and file, and verify the post-rename subject.
  const renamedDay = page.locator('.history-timeline-group-header').first()
  await expect(renamedDay).toBeVisible({ timeout: 10000 })
  await renamedDay.click()
  const renamedCommit = page.locator('.history-commit-row').first()
  await expect(renamedCommit).toContainText('E2E pinned after rename')
  await renamedCommit.click()
  // The display title remains the document's content title across rename;
  // the commit row itself proves that this is the post-rename pin.
  await page.locator('.history-file-row', { hasText: name }).click()
  await expect(page.locator('.history-comparison-pane')).toBeVisible({ timeout: 10000 })
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

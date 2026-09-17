// Edit-10.5 Final Closure — real-browser residual race regression.
//
// The accepted residual race from the Edit-10.4 design doc, proven in
// a REAL browser in the REQUIRED causal order:
//
//   Document clean at Send → clean liveContext captured and sent
//   → user keeps typing while the AI turn is open (buffer dirty,
//     unsaved; its debounced autosave is in flight, held at the
//     network boundary by the test)
//   → WHILE the buffer is dirty and the server still holds the
//     send-time clean bytes, the same-path server mutation lands
//     through the real CAS write path (exactly what the send-time
//     clean verify-clean policy allows)
//   → the held autosave is released and gets a REAL 409 (its baseRaw
//     no longer matches the AI-written disk) → tab flips 'external'
//     with the AI body as externalRaw
//   → the AI turn's SSE file_changed then reaches the browser through
//     the REAL client chain (sendAndStream → useAiHistory → file
//     change bus → useExternalFileChanges) — the save is no longer
//     in flight, the buffer is still dirty, so the in-app overwrite
//     confirm appears exactly once
//   → cancel keeps the local bytes: no silent overwrite, no
//     auto-merge, no auto-save of the local buffer, no lost input,
//     no duplicate conflict, no Recovery record.
//
// Why the autosave is released BEFORE the SSE event: production
// useDocumentSave sets tab.savingRevision BEFORE the PUT is in
// flight, and useExternalFileChanges drops any file_changed that
// arrives while savingRevision !== null. Releasing the SSE while the
// autosave is still held would make the real client discard the
// event — the sealed production contract is: the 409 establishes the
// external state, the following file_changed confirms it through the
// dirty-buffer path. §6 of the closure spec accepts either sub-order
// of (autosave 409, file_changed) as long as the final state is:
// local body preserved, server body = the AI write, tab external,
// unsaved input not lost — all asserted below.
//
// Interlocking evidence (§6.3 split, used because the sealed vite
// plugin loads host environment settings before the webServer process —
// the server-side provider cannot be pointed at a fake endpoint in this
// environment without a production change, which is forbidden):
//
//   A. SERVER INTEGRATION — server/__tests__/edit10-final-closure.test.ts:
//      the real chain parseAiLiveContext → buildSystemPrompt → runChat
//      → deriveToolSafetyPolicy → executeToolCall (real temp vault,
//      real DB) with the provider mocked at the standard module seam
//      (same vi.mock('../ai/llm') as the existing chat suite) proves
//      the send-time CLEAN policy lets the same-path write execute
//      after documentId+raw re-verification and emits the STANDARD
//      file_changed descriptor {path, kind:'write', newRaw, newMtime};
//      the DIRTY policy blocks the same write as an is_error tool
//      result with zero side effects.
//
//   B. THIS SPEC — the browser half of the chain, end to end: real
//      VaultView/Monaco, real send-time captureAiLiveContext, real
//      debounced autosave (held at the network boundary, then really
//      409'd by the server), real sendAndStream SSE parsing, real
//      file-change bus, real confirm dialog. The mutation is REAL: a
//      production REST PUT through the server's compare-and-swap
//      write path — issued via APIRequestContext, which does NOT pass
//      through page.route, so it never interferes with the held
//      browser autosave — and the file_changed descriptor carries
//      the REAL newRaw/newMtime of that write. Only the LLM
//      orchestration layer (Anthropic round-trip + runChat loop) is
//      substituted, at the browser layer exactly like the sealed
//      E2E-1..10 harness; that layer is what evidence A covers with
//      the real server code. The two pieces interlock on the
//      descriptor shape A emits and B consumes.
//
// Sequence control (§6.4): no arbitrary sleeps — every wait is a
// network or DOM condition. The chat stream is held on a test gate;
// the autosave PUT is held on a second test gate; the mutation and
// the SSE release happen only after the deterministic preconditions
// (buffer dirty + server still clean + autosave in flight) are all
// observed. Ordering violations cannot pass silently: if the local
// buffer were ever overwritten, the Monaco/raw assertions fail; if
// the autosave did not really 409, its captured status fails; if the
// confirm never fired, its visibility assertion fails.
import { expect, test } from './fixtures/auth'
import {
  type AnyRecord,
  appendEditorText,
  cleanupCreatedPaths,
  clearDraftDatabase,
  createDoc,
  interceptAiChatGated,
  interceptAutosaveHeld,
  openAiRail,
  openDoc,
  raceSse,
  gotoVaultReady,
  reloadApp,
  sendAi,
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

test('residual race: send clean → type while the AI turn is open → same-path server mutation while dirty → the dirty buffer survives as an external conflict', async ({ page, request }) => {
  const slug = `inbox/e2e-ai-fc-${RUN_ID}`
  const name = slug.split('/').pop()!
  const cleanRaw = `${name} clean send-time body`
  const doc = await createDoc(request, slug, `${cleanRaw}\n`, createdPaths)
  // GET returns the on-disk bytes verbatim — the createDoc PUT seeded
  // `${cleanRaw}\n`, so the clean snapshot raw is exactly that.
  expect(doc.raw).toBe(`${cleanRaw}\n`)
  const aiBody = `EDIT10_FC_AI_WRITTEN_${RUN_ID}\n`

  // Gate 1: the held AI chat stream. Gate 2: the held autosave PUT.
  const chatBodies: AnyRecord[] = []
  let releaseRace = () => {}
  const raceGate = new Promise<void>((resolve) => { releaseRace = resolve })
  let descriptor: { mtime: number } | null = null
  await interceptAiChatGated(
    page,
    chatBodies,
    raceGate,
    () => raceSse(slug, aiBody, descriptor?.mtime ?? 0),
  )
  const autosave = { seen: false, statuses: [] as number[] }
  let releaseAutosave = () => {}
  const autosaveGate = new Promise<void>((resolve) => { releaseAutosave = resolve })
  await interceptAutosaveHeld(page, slug, autosave, autosaveGate)

  await reloadApp(page)
  await openDoc(page, slug)
  await openAiRail(page)

  // ── 1. Send while CLEAN ────────────────────────────────────────────
  await sendAi(page, 'please rewrite my note')
  await expect.poll(() => chatBodies.length, { timeout: 15000 }).toBe(1)
  const body1 = chatBodies[0]
  // The Edit-10.3 wire contract: liveContext only, no legacy keys.
  const wire1 = JSON.stringify(body1)
  for (const forbidden of ['currentNotePath', 'currentNoteContent', 'attachments', 'filesystemPath', 'absolutePath']) {
    expect(wire1, `wire must not mention ${forbidden}`).not.toContain(forbidden)
  }
  const ctx = body1.liveContext
  expect(ctx, 'send-time request must carry liveContext').toBeTruthy()
  expect(ctx.v).toBe(1)
  expect(ctx.kind).toBe('document')
  expect(ctx.dirty).toBe(false)
  expect(ctx.raw).toBe(`${cleanRaw}\n`) // send-time clean: buffer == disk
  expect(ctx.identity).toEqual({ documentId: doc.documentId, path: slug })
  expect(ctx.workspaceTabId).toBe(slug)

  // ── 2. The user keeps typing WHILE THE AI TURN IS OPEN: the buffer
  //    is dirty and its debounced autosave leaves the app ────────────
  const localTail = `EDIT10_FC_LOCAL_TAIL_${RUN_ID}`
  await appendEditorText(page, localTail)
  await expect(page.locator(`[data-tab-id="${slug}"][data-save-status="dirty"]`)).toBeVisible({ timeout: 5000 })
  // The autosave PUT arrives at the network boundary and is HELD:
  // the buffer is dirty and unsaved, and — decisively — NOTHING has
  // reached the server yet.
  await expect.poll(() => autosave.seen, { timeout: 15000 }).toBe(true)

  // ── 3. At mutation time the server STILL holds the send-time clean
  //    bytes — the exact precondition the verify-clean policy checks
  //    in the real race ──────────────────────────────────────────────
  const serverBeforeMutation = await (await request.get(`/api/posts/${slug}`)).json()
  expect(serverBeforeMutation.raw).toBe(`${cleanRaw}\n`)

  // ── 4. The same-path mutation lands through the REAL server CAS
  //    write path (APIRequestContext bypasses page.route — the held
  //    autosave is untouched). It succeeds BECAUSE the disk still
  //    equals the send-time snapshot ─────────────────────────────────
  const mutation = await request.put(`/api/posts/${slug}`, {
    data: { raw: aiBody, baseRaw: doc.raw },
  })
  expect(mutation.status()).toBeLessThan(300)
  const serverAfterMutation = await (await request.get(`/api/posts/${slug}`)).json()
  expect(serverAfterMutation.raw).toBe(aiBody)
  expect(serverAfterMutation.metadata.id).toBe(doc.documentId)
  descriptor = { mtime: serverAfterMutation.mtime as number }
  expect(typeof descriptor.mtime).toBe('number')

  // ── 5. Release the held autosave: its baseRaw (the clean send-time
  //    bytes) no longer matches the AI-written disk, so the REAL
  //    server answers 409 and the tab flips to external with the AI
  //    body as externalRaw ───────────────────────────────────────────
  releaseAutosave()
  await expect.poll(() => autosave.statuses.length, { timeout: 15000 }).toBe(1)
  expect(autosave.statuses[0]).toBe(409)
  await expect(page.locator(`[data-tab-id="${slug}"][data-save-status="external"]`)).toBeVisible({ timeout: 15000 })

  // ── 6. Release the AI turn: the SSE stream delivers the standard
  //    file_changed descriptor into the REAL client chain. The save
  //    is no longer in flight and the buffer is still dirty (raw ≠
  //    originalRaw), so the overwrite confirm appears — exactly once
  //    (disk-poll events carry source 'editor-lifecycle' and are
  //    dropped before the conflict logic) ────────────────────────────
  releaseRace()
  const confirmDialog = page.locator('.n-dialog[role="dialog"]')
  await expect(confirmDialog).toBeVisible({ timeout: 15000 })
  const confirmMessage = (await confirmDialog.textContent()) ?? ''
  expect(confirmMessage).toContain(slug)
  // Cancel is the focused safe action: keep the local changes.
  await confirmDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(confirmDialog).not.toBeVisible()

  // ── 7. Monaco still shows the user's post-Send typing — the buffer
  //    was NOT overwritten; the server still holds the AI write — the
  //    local buffer was NOT auto-saved ───────────────────────────────
  await expect(page.locator('.editor-pane .monaco-editor .view-lines').first()).toContainText(localTail)
  const serverDoc = await (await request.get(`/api/posts/${slug}`)).json()
  expect(serverDoc.raw).toBe(aiBody)
  expect(serverDoc.raw).not.toContain(localTail)
  expect(serverDoc.metadata.id).toBe(doc.documentId) // identity stable
  // No wrong-path tab, no Recovery/duplicate tab was opened.
  await expect(page.locator('[data-tab-id]')).toHaveCount(1)
  await expect(page.locator('.draft-recovery-dialog')).toBeHidden()
  await expect(page.locator('.draft-recovery-pane')).toHaveCount(0)

  // ── 8. The next send-time snapshot carries BOTH sides: the local
  //    buffer as raw (byte-exact — no merge, not the AI body), the AI
  //    write as externalRaw; identity unchanged ──────────────────────
  await sendAi(page, 'what changed?')
  await expect.poll(() => chatBodies.length, { timeout: 15000 }).toBe(2)
  const ctx2 = chatBodies[1].liveContext
  expect(ctx2.kind).toBe('document')
  expect(ctx2.raw).toBe(`${cleanRaw}\n\n${localTail}`) // local buffer, NOT the AI body
  expect(ctx2.raw).not.toContain(aiBody.trim())
  expect(ctx2.dirty).toBe(true)
  expect(ctx2.saveStatus).toBe('external')
  expect(ctx2.external).toEqual({ kind: 'modified', raw: aiBody })
  expect(ctx2.identity).toEqual({ documentId: doc.documentId, path: slug })

  // ── 9. The conflict stays user-owned: no duplicate confirm ever
  //    re-appeared, the autosave was never silently re-sent, nothing
  //    resolved the external state silently ──────────────────────────
  await expect(page.locator('.n-dialog[role="dialog"]')).not.toBeVisible()
  expect(autosave.statuses).toEqual([409]) // exactly one autosave, the real 409
  await expect(page.locator(`[data-tab-id="${slug}"][data-save-status="external"]`)).toBeVisible()
})

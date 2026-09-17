import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import nodePath from 'node:path'
import { expect, test, type APIRequestContext, type Page } from './fixtures/diary'
import {
  appendEditorText,
  clearDraftDatabase,
  draftRowCount,
  gotoVaultReady,
  interceptAutosaveAborted,
  interceptAutosaveHeld,
  interceptHistory,
  reloadApp,
  setEditorContent,
} from './helpers/edit-program'
import { CALENDAR_TEST_DATE, CALENDAR_TEST_TIME_ZONE, calendarDay } from './helpers/calendar-clock'

const TEST_TIME_ZONE = CALENDAR_TEST_TIME_ZONE
const RUN_ID = String(Date.now())

test.use({ timezoneId: TEST_TIME_ZONE, trace: 'off', screenshot: 'only-on-failure' })

const E2E_VAULT = process.env.NUVYN_DRAFT_E2E_VAULT ?? nodePath.join('src', 'content')

function localCivilDate(): string {
  return CALENDAR_TEST_DATE
}

function diaryPath(date: string): string {
  return `diary/${date}`
}

function normalizeLineEndings(raw: string): string {
  return raw.replace(/\r\n?/g, '\n')
}

async function deleteDiaryDate(request: APIRequestContext, date: string): Promise<void> {
  await deletePost(request, diaryPath(date))
}

async function deletePost(request: APIRequestContext, path: string): Promise<void> {
  const response = await request.delete(`/api/posts/${path}`)
  expect(path.startsWith('diary/') ? [200, 404, 422] : [200, 404]).toContain(response.status())
}

async function seedDiary(
  request: APIRequestContext,
  date: string,
  raw: string,
): Promise<{ documentId: string; raw: string }> {
  await deleteDiaryDate(request, date)
  const created = await request.post('/api/diary/dates', {
    data: { date, timeZone: TEST_TIME_ZONE },
  })
  expect(created.status(), await created.text()).toBe(201)

  const initialResponse = await request.get(`/api/posts/${diaryPath(date)}`)
  expect(initialResponse.status()).toBe(200)
  const initial = await initialResponse.json()
  const saved = await request.put(`/api/posts/${diaryPath(date)}`, {
    data: { raw, baseRaw: initial.raw },
  })
  expect(saved.status(), await saved.text()).toBe(200)

  const detailResponse = await request.get(`/api/posts/${diaryPath(date)}`)
  expect(detailResponse.status()).toBe(200)
  const detail = await detailResponse.json()
  return {
    documentId: detail.metadata.id as string,
    raw: detail.raw as string,
  }
}

async function seedOrdinaryNote(request: APIRequestContext, path: string): Promise<void> {
  await deletePost(request, path)
  const created = await request.post('/api/posts', {
    data: { path, title: path.split('/').at(-1) },
  })
  expect([200, 201]).toContain(created.status())
}

async function commitDiaryRevision(
  request: APIRequestContext,
  date: string,
  raw: string,
  subject: string,
): Promise<string> {
  const historyPath = `${diaryPath(date)}.md`
  const response = await request.post('/api/history/commits', {
    data: {
      paths: [historyPath],
      message: subject,
      expected: {
        [historyPath]: createHash('sha256').update(raw).digest('hex'),
      },
    },
  })
  const body = await response.text()
  expect(response.status(), body).toBe(201)
  const result = JSON.parse(body) as { sha?: unknown }
  expect(result.sha).toEqual(expect.stringMatching(/^[0-9a-f]{40}$/))
  return result.sha as string
}

async function openDiaryHome(page: Page): Promise<void> {
  await page.goto('/vault')
  const diaryChip = page.locator('.scope-chip').filter({ hasText: 'diary' })
  if (await diaryChip.getAttribute('aria-pressed') !== 'true') await diaryChip.click()
  await expect(page.getByTestId('diary-calendar-surface')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('diary-calendar')).toBeVisible()
}

async function ensureExplorerVisible(page: Page): Promise<void> {
  const fileTree = page.locator('.file-tree')
  if (!(await fileTree.isVisible())) {
    const explorer = page.locator('button.ab-btn[aria-label^="Explorer"], button.ab-btn[aria-label^="文件资源管理器"]').first()
    await expect(explorer).toBeVisible()
    if (await explorer.getAttribute('aria-pressed') !== 'true') await explorer.click()
  }
  await expect(fileTree).toBeVisible({ timeout: 15_000 })
}

async function moveToMonth(page: Page, date: string): Promise<void> {
  const targetMonth = date.slice(0, 7)
  const calendar = page.getByTestId('diary-calendar')
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const currentMonth = await calendar.getAttribute('data-month')
    if (currentMonth === targetMonth) return
    if (!currentMonth) throw new Error('Calendar did not expose its current month')
    await page.getByTestId(currentMonth < targetMonth ? 'diary-calendar-next' : 'diary-calendar-previous').click()
  }
  throw new Error(`Calendar did not reach ${targetMonth}`)
}

async function clickDiaryDate(page: Page, date: string): Promise<void> {
  await moveToMonth(page, date)
  const button = calendarDay(page.getByTestId('diary-calendar'), date)
  await expect(button).toBeVisible()
  await button.click()
}

function diagnostics(page: Page, ignoredConsoleFragments: string[] = []): { pageErrors: string[]; consoleErrors: string[] } {
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    if (ignoredConsoleFragments.some((fragment) => message.text().includes(fragment))) return
    consoleErrors.push(message.text())
  })
  return { pageErrors, consoleErrors }
}

async function assertNativeReader(page: Page, date: string): Promise<void> {
  const path = diaryPath(date)
  await expect(page).toHaveURL(new RegExp(`/vault/${path.replace('/', '\\/')}(?:[?#]|$)`))
  await expect(page.getByTestId('diary-reader-dialog')).toHaveCount(0)
  await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.reading-pane')).toHaveCount(1)
  await expect(page.locator('.reading-pane')).toBeVisible()
  await ensureExplorerVisible(page)
  await expect(page.locator('.search-input')).toHaveValue(date)
  await expect(page.locator(`[data-tree-key="file:${path}"]`)).toHaveCount(1)
  await expect(page.getByTestId('diary-calendar')).toBeAttached()
  await expect(page.getByTestId('diary-calendar')).toBeHidden()
}

async function enterEditor(page: Page): Promise<void> {
  const toggle = page.getByTestId('view-toggle')
  const label = await toggle.getAttribute('aria-label')
  if (/edit|编辑/i.test(label ?? '')) await toggle.click()
  await expect(page.getByRole('textbox', { name: 'Editor content' })).toBeVisible()
  await expect(page.locator('.editor-pane .monaco-editor')).toHaveCount(1)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/__markdown-test?mode=reading')
  await clearDraftDatabase(page)
  await gotoVaultReady(page)
})

test('Native Editor dirty lifecycle preserves identity and reveals Calendar only after final tab close', async ({ page, request }) => {
  const date = localCivilDate()
  const path = diaryPath(date)
  const baseRaw = `# D6.4 Native Editor ${RUN_ID} — Initial body ${RUN_ID}`
  const savedRaw = `# D6.4 Native Editor ${RUN_ID} — Saved body ${RUN_ID}`
  const dirtyMarker = `DIRTY_${RUN_ID}`
  const closeMarker = `CLOSE_${RUN_ID}`
  const state = diagnostics(page, ['net::ERR_FAILED'])
  let browserAutosaveInstalled = false

  try {
    const document = await seedDiary(request, date, baseRaw)
    await openDiaryHome(page)
    await clickDiaryDate(page, date)
    await assertNativeReader(page, date)
    await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveCount(1)

    await enterEditor(page)
    await setEditorContent(page, savedRaw)
    await expect(page.locator(`[data-tab-id="${path}"][data-save-status="saved"]`)).toBeVisible({ timeout: 15_000 })

    await interceptAutosaveAborted(page, path)
    browserAutosaveInstalled = true
    await appendEditorText(page, dirtyMarker)
    const dirtyRaw = `${savedRaw}\n${dirtyMarker}`
    await expect(page.locator(`[data-tab-id="${path}"][data-save-status="dirty"]`)).toBeVisible({ timeout: 15_000 })
    // D8.3 disables managed-Diary persistent Draft Store writes; the dirty
    // body remains only in the authorized editor tab until explicit save.
    await expect.poll(() => draftRowCount(page, dirtyMarker), { timeout: 15_000 }).toBe(0)

    const calendar = page.getByTestId('diary-calendar')
    await expect(calendar).toBeHidden()
    await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveCount(1)
    await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.n-dialog[role="dialog"]')).toHaveCount(0)

    // Calendar Home remains hidden while a managed Diary tab is open. A real
    // dirty tab close continues to use the existing confirmation policy.
    await page.locator('.vault').focus()
    await page.keyboard.press('ControlOrMeta+W')
    const calendarCloseConfirmation = page.locator('.n-dialog[role="dialog"]')
    await expect(calendarCloseConfirmation).toBeVisible()
    await calendarCloseConfirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveCount(1)
    await expect(calendarCloseConfirmation).not.toBeVisible()

    const readToggle = page.getByTestId('view-toggle')
    if (/read|阅读/i.test(await readToggle.getAttribute('aria-label') ?? '')) await readToggle.click()
    await expect(page.locator('.reading-pane')).toBeVisible()
    await expect(page.locator('.reading-pane article')).toContainText(dirtyMarker)
    const reopened = await (await request.get(`/api/posts/${path}`)).json()
    expect(reopened.metadata.id).toBe(document.documentId)
    expect(reopened.raw).toBe(savedRaw)

    await enterEditor(page)
    await page.unroute(`**/api/posts/${path}`)
    browserAutosaveInstalled = false
    await page.locator('.vault').focus()
    await page.keyboard.press('Control+s')
    await expect(page.locator(`[data-tab-id="${path}"][data-save-status="saved"]`)).toBeVisible({ timeout: 15_000 })
    const saved = await (await request.get(`/api/posts/${path}`)).json()
    expect(normalizeLineEndings(saved.raw)).toBe(dirtyRaw)
    expect(saved.metadata.id).toBe(document.documentId)
    await expect.poll(() => draftRowCount(page, dirtyMarker), { timeout: 15_000 }).toBe(0)

    // A real document close still uses the existing dirty confirmation. The
    // presentation-only Calendar close above did not invoke it.
    await interceptAutosaveAborted(page, path)
    browserAutosaveInstalled = true
    await appendEditorText(page, closeMarker)
    await expect(page.locator(`[data-tab-id="${path}"][data-save-status="dirty"]`)).toBeVisible({ timeout: 15_000 })
    await page.locator(`[data-tab-id="${path}"] .tab-close`).click()
    const confirmation = page.locator('.n-dialog[role="dialog"]')
    await expect(confirmation).toBeVisible()
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(confirmation).not.toBeVisible()
    await expect(page.locator(`[data-tab-id="${path}"][data-save-status="dirty"]`)).toBeVisible()
    await page.locator(`[data-tab-id="${path}"] .tab-close`).click()
    await expect(confirmation).toBeVisible()
    await confirmation.getByRole('button').last().click()
    await expect(page.locator(`[data-tab-id="${path}"]`)).toHaveCount(0)
    await expect(page.getByTestId('diary-calendar')).toBeVisible()
  } finally {
    if (browserAutosaveInstalled) await page.unroute(`**/api/posts/${path}`)
    await deleteDiaryDate(request, date)
  }

  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([])
})

test.skip('D8.2: managed Diary History Comparison waits for an adapter-aware owner', async ({ page, request }) => {
  const date = localCivilDate()
  const path = diaryPath(date)
  const liveRaw = `# D6.4 History ${RUN_ID} — Live body ${RUN_ID}`
  const revisionRaw = `# D6.4 History ${RUN_ID} — Historical body ${RUN_ID}`
  const dirtyMarker = `DIRTY_HISTORY_${RUN_ID}`
  const state = diagnostics(page, ['net::ERR_FAILED'])
  let putCount = 0
  let historyActive = false
  let autosaveInstalled = false

  try {
    const document = await seedDiary(request, date, liveRaw)
    await interceptHistory(page, {
      files: [`${path}.md`],
      raw: revisionRaw,
      sha: `d64history${RUN_ID}`,
      parents: [`d64parent${RUN_ID}`],
    })
    await page.reload()
    await openDiaryHome(page)
    await clickDiaryDate(page, date)
    await assertNativeReader(page, date)

    await enterEditor(page)
    await page.route(`**/api/posts/${path}`, (route) => {
      if (route.request().method() === 'PUT') {
        if (historyActive) putCount += 1
        return route.abort()
      }
      return route.continue()
    })
    autosaveInstalled = true
    await setEditorContent(page, liveRaw)
    await appendEditorText(page, dirtyMarker)
    await expect(page.locator(`[data-tab-id="${path}"][data-save-status="dirty"]`)).toBeVisible({ timeout: 15_000 })
    await expect.poll(() => draftRowCount(page, dirtyMarker), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)

    historyActive = true
    await page.locator('button.ab-btn[aria-label="History"], button.ab-btn[aria-label="历史"]').first().click()
    const history = page.locator('.history-panel')
    await expect(history).toBeVisible()

    const day = history.locator('.history-timeline-group-header').first()
    await expect(day).toBeVisible({ timeout: 15_000 })
    if (await day.getAttribute('aria-expanded') !== 'true') await day.click()
    const commit = history.locator('.history-commit-row').first()
    await expect(commit).toBeVisible()
    if (await commit.getAttribute('aria-expanded') !== 'true') await commit.click()
    const file = history.locator('.history-file-row').first()
    await expect(file).toBeVisible()
    await file.click()

    await expect(page.locator('.history-comparison-pane')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('diary-calendar')).toBeAttached()
    await expect(page.getByTestId('diary-calendar')).toBeHidden()
    await expect(page.locator('.editor-tabs-context-actions')).toHaveCount(0)
    expect(putCount).toBe(0)
    await expect(page.locator(`[data-tab-id="${path}"]`)).toHaveCount(1)
    await expect(page.locator(`[data-tab-id="${path}"] .tab-dirty-indicator`)).toHaveCount(1)

    const diffTab = page.locator(`[data-tab-id="diff:${path}"]`)
    await expect(diffTab).toBeVisible()
    await diffTab.locator('.tab-close').click()
    await expect(page.locator('.history-comparison-pane')).toHaveCount(0)
    await expect(page.getByTestId('diary-calendar')).toBeHidden()
    await expect(page.locator('.reading-pane')).toHaveCount(0)

    const readToggle = page.getByTestId('view-toggle')
    if (/read|阅读/i.test(await readToggle.getAttribute('aria-label') ?? '')) await readToggle.click()
    await expect(page.locator('.reading-pane')).toBeVisible()
    await expect(page.locator('.reading-pane article')).toContainText(dirtyMarker)
    const reopened = await (await request.get(`/api/posts/${path}`)).json()
    expect(reopened.metadata.id).toBe(document.documentId)
    expect(reopened.raw).toBe(liveRaw)
  } finally {
    if (autosaveInstalled) await page.unroute(`**/api/posts/${path}`)
    await deleteDiaryDate(request, date)
  }

  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([])
})

test.skip('D8.2: managed Diary Recovery waits for an encrypted recovery adapter', async ({ page, request }) => {
  const date = localCivilDate()
  const path = diaryPath(date)
  const baseRaw = `# D6.4 Divergent Recovery ${RUN_ID} — Base body ${RUN_ID}`
  const draftMarker = `DIVERGENT_DRAFT_${RUN_ID}`
  const diskMarker = `DIVERGENT_DISK_${RUN_ID}`
  const state = diagnostics(page, ['net::ERR_FAILED'])
  let autosaveInstalled = false

  try {
    const document = await seedDiary(request, date, baseRaw)
    await openDiaryHome(page)
    await clickDiaryDate(page, date)
    await assertNativeReader(page, date)
    await enterEditor(page)
    await interceptAutosaveAborted(page, path)
    autosaveInstalled = true
    await setEditorContent(page, baseRaw)
    await appendEditorText(page, draftMarker)
    await expect(page.locator(`[data-tab-id="${path}"][data-save-status="dirty"]`)).toBeVisible({ timeout: 15_000 })
    await expect.poll(() => draftRowCount(page, draftMarker), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)

    await fs.appendFile(
      nodePath.join(E2E_VAULT, `${path}.md`),
      `\n${diskMarker}\n`,
      'utf8',
    )
    await page.reload()

    const dialog = page.locator('.draft-recovery-dialog')
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    await expect(dialog).toContainText('The draft and disk version may both have changed.')
    await expect(page.getByTestId('diary-calendar')).toBeAttached()

    await dialog.getByRole('button', { name: 'View Diff' }).click()
    const pane = page.locator('.draft-recovery-pane')
    await expect(pane).toBeVisible({ timeout: 15_000 })
    await expect(pane).toContainText(draftMarker)
    await expect(pane).toContainText(diskMarker)
    await expect(page.getByTestId('diary-calendar')).toBeAttached()
    await expect(page.getByTestId('diary-calendar')).toBeHidden()
    await expect(page.locator('.editor-tabs-context-actions')).toHaveCount(0)
    await expect(page.locator(`[data-tab-id="${path}"]`)).toHaveCount(1)

    await pane.getByRole('button', { name: 'Open Recovered Content' }).click()
    await expect(pane).toContainText(draftMarker)
    await pane.getByRole('button', { name: 'Use Disk Version' }).click()
    await expect(pane).toHaveCount(0)
    await expect.poll(() => draftRowCount(page, draftMarker), { timeout: 15_000 }).toBe(0)
    await expect(page.getByTestId('diary-calendar')).toBeHidden()
    await expect(page.locator('.editor-tabs-context-actions')).toHaveCount(0)

    const resolved = await (await request.get(`/api/posts/${path}`)).json()
    expect(resolved.metadata.id).toBe(document.documentId)
    expect(resolved.raw).toBe(`${baseRaw}\n${diskMarker}\n`)

    // Reboot through the existing Vault lifecycle. The resolution discarded
    // only the draft; the next native load reads the authoritative disk
    // winner into the existing tab/model while Calendar remains hidden for
    // the still-open managed Diary tab.
    await reloadApp(page)
    await expect(page.getByTestId('diary-calendar')).toBeHidden()
    await expect(page.locator(`[data-tab-id="${path}"]`)).toHaveCount(1)
    const readToggle = page.getByTestId('view-toggle')
    if (/read|阅读/i.test(await readToggle.getAttribute('aria-label') ?? '')) await readToggle.click()
    await expect(page.locator('.reading-pane')).toBeVisible()
    await expect(page.locator('.reading-pane article')).toContainText(diskMarker)
    const reopened = await (await request.get(`/api/posts/${path}`)).json()
    expect(reopened.metadata.id).toBe(document.documentId)
    expect(reopened.raw).toBe(`${baseRaw}\n${diskMarker}\n`)
  } finally {
    if (autosaveInstalled) await page.unroute(`**/api/posts/${path}`)
    await deleteDiaryDate(request, date)
  }

  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([])
})

test.skip('D8.2: managed Diary History restore waits for an adapter-aware owner', async ({ page, request }) => {
  const date = localCivilDate()
  const path = diaryPath(date)
  const baseRaw = `# D6.4 Restore ${RUN_ID} — Historical body ${RUN_ID}`
  const liveRaw = `# D6.4 Restore ${RUN_ID} — Current body ${RUN_ID}`
  const subject = `D6.4 Diary restore ${RUN_ID}`
  const state = diagnostics(page)

  try {
    const document = await seedDiary(request, date, baseRaw)
    const revisionId = await commitDiaryRevision(request, date, baseRaw, subject)
    const changed = await request.put(`/api/posts/${path}`, {
      data: { raw: liveRaw, baseRaw },
    })
    expect(changed.status(), await changed.text()).toBe(200)

    await reloadApp(page)
    await openDiaryHome(page)
    await clickDiaryDate(page, date)
    await assertNativeReader(page, date)

    await page.locator('button.ab-btn[aria-label="History"], button.ab-btn[aria-label="历史"]').first().click()
    const history = page.locator('.history-panel')
    await expect(history).toBeVisible()
    const day = history.locator('.history-timeline-group-header').first()
    await expect(day).toBeVisible({ timeout: 15_000 })
    if (await day.getAttribute('aria-expanded') !== 'true') await day.click()
    const commit = history.locator('.history-commit-row').filter({ hasText: subject })
    await expect(commit).toBeVisible({ timeout: 15_000 })
    if (await commit.getAttribute('aria-expanded') !== 'true') await commit.click()
    const file = history.locator('.history-file-row').filter({ hasText: date }).first()
    await expect(file).toBeVisible({ timeout: 15_000 })
    await file.click()

    const comparison = page.locator('.history-comparison-pane')
    await expect(comparison).toBeVisible({ timeout: 15_000 })
    await expect(comparison).toContainText(baseRaw)
    await expect(page.getByTestId('diary-calendar')).toBeAttached()
    await expect(page.getByTestId('diary-calendar')).toBeHidden()
    await expect(page.locator(`[data-tab-id="${path}"]`)).toHaveCount(1)

    await comparison.getByRole('button', { name: 'More actions' }).click()
    const restoreAction = page.getByRole('menuitem', { name: /Restore to this version/ })
    await expect(restoreAction).toBeVisible()
    await restoreAction.click()
    const confirmation = page.locator('.n-dialog[role="dialog"]')
    await expect(confirmation).toBeVisible()
    await confirmation.getByRole('button').last().click()

    await expect.poll(async () => (
      await (await request.get(`/api/posts/${path}`)).json()
    ).raw).toBe(baseRaw)
    const restored = await (await request.get(`/api/posts/${path}`)).json()
    expect(restored.metadata.id).toBe(document.documentId)
    expect(restored.raw).toBe(baseRaw)
    expect(revisionId).toMatch(/^[0-9a-f]{40}$/)

    const diffTab = page.locator(`[data-tab-id="diff:${path}"]`)
    await expect(diffTab).toHaveCount(1)
    await diffTab.locator('.tab-close').click()
    await expect(page.getByTestId('diary-calendar')).toBeHidden()
    await expect(page.locator(`[data-tab-id="${path}"]`)).toHaveCount(1)

    const readToggle = page.getByTestId('view-toggle')
    if (/read|阅读/i.test(await readToggle.getAttribute('aria-label') ?? '')) await readToggle.click()
    await expect(page.locator('.reading-pane')).toBeVisible()
    await expect(page.locator('.reading-pane article')).toContainText(baseRaw.slice(2))
    await expect(page.locator('.reading-pane article')).not.toContainText(liveRaw)
    const reopened = await (await request.get(`/api/posts/${path}`)).json()
    expect(reopened.metadata.id).toBe(document.documentId)
    expect(reopened.raw).toBe(baseRaw)
  } finally {
    await deleteDiaryDate(request, date)
  }

  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([])
})

test.skip('D8.2: managed Diary baseline Recovery waits for an encrypted recovery adapter', async ({ page, request }) => {
  const date = localCivilDate()
  const path = diaryPath(date)
  const baseRaw = `# D6.4 Recovery ${RUN_ID} — Baseline body ${RUN_ID}`
  const recoveredMarker = `RECOVERED_${RUN_ID}`
  const recoveredRaw = `${baseRaw} — ${recoveredMarker}`
  const state = diagnostics(page, ['net::ERR_FAILED'])
  let browserAutosaveInstalled = false

  try {
    const document = await seedDiary(request, date, baseRaw)
    await openDiaryHome(page)
    await clickDiaryDate(page, date)
    await assertNativeReader(page, date)
    await enterEditor(page)
    await interceptAutosaveAborted(page, path)
    browserAutosaveInstalled = true
    await setEditorContent(page, recoveredRaw)
    await expect(page.locator(`[data-tab-id="${path}"][data-save-status="dirty"]`)).toBeVisible({ timeout: 15_000 })
    await expect.poll(() => draftRowCount(page, recoveredMarker), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)

    await page.reload()
    await expect(page.getByTestId('diary-calendar')).toBeHidden({ timeout: 15_000 })
    await expect(page.locator('.draft-recovery-backdrop')).toHaveCount(0)
    await expect(page.locator('.editor-pane .monaco-editor .view-lines').first()).toContainText(recoveredMarker, { timeout: 15_000 })
    await expect(page.locator(`[data-tab-id="${path}"][data-save-status="dirty"]`)).toHaveCount(1)

    const readToggle = page.getByTestId('view-toggle')
    if (/read|阅读/i.test(await readToggle.getAttribute('aria-label') ?? '')) await readToggle.click()
    await expect(page.locator('.reading-pane')).toBeVisible()
    await expect(page.locator('.reading-pane article')).toContainText(recoveredMarker)
    const adopted = await (await request.get(`/api/posts/${path}`)).json()
    expect(adopted.metadata.id).toBe(document.documentId)
    expect(adopted.raw).toBe(baseRaw)

    await enterEditor(page)
    await page.unroute(`**/api/posts/${path}`)
    browserAutosaveInstalled = false
    await page.locator('.vault').focus()
    await page.keyboard.press('Control+s')
    await expect(page.locator(`[data-tab-id="${path}"][data-save-status="saved"]`)).toBeVisible({ timeout: 15_000 })
    const saved = await (await request.get(`/api/posts/${path}`)).json()
    expect(saved.raw).toBe(recoveredRaw)
    expect(saved.metadata.id).toBe(document.documentId)
    await expect.poll(() => draftRowCount(page, recoveredMarker), { timeout: 15_000 }).toBe(0)
  } finally {
    if (browserAutosaveInstalled) await page.unroute(`**/api/posts/${path}`)
    await deleteDiaryDate(request, date)
  }

  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([])
})

test('external conflict stays on the native Diary tab and resolves via the existing save owner', async ({ page, request }) => {
  const date = localCivilDate()
  const path = diaryPath(date)
  const baseRaw = `# D6.4 External ${RUN_ID} — Base body ${RUN_ID}`
  const localMarker = `LOCAL_${RUN_ID}`
  const localRaw = `${baseRaw}\n${localMarker}`
  const externalRaw = `# D6.4 External ${RUN_ID} — External body ${RUN_ID}`
  const state = diagnostics(page, ['status of 409 (Conflict)'])
  const autosave = { seen: false, statuses: [] as number[] }
  let releaseAutosave: () => void = () => {}
  let browserAutosaveInstalled = false

  try {
    const document = await seedDiary(request, date, baseRaw)
    await openDiaryHome(page)
    await clickDiaryDate(page, date)
    await assertNativeReader(page, date)
    await enterEditor(page)

    const gate = new Promise<void>((resolve) => { releaseAutosave = resolve })
    await interceptAutosaveHeld(page, path, autosave, gate)
    browserAutosaveInstalled = true
    await appendEditorText(page, localMarker)
    await expect(page.locator(`[data-tab-id="${path}"][data-save-status="dirty"]`)).toBeVisible({ timeout: 15_000 })
    await expect.poll(() => autosave.seen, { timeout: 15_000 }).toBe(true)

    const externalWrite = await request.put(`/api/posts/${path}`, {
      data: { raw: externalRaw, baseRaw },
    })
    expect(externalWrite.status(), await externalWrite.text()).toBe(200)
    const external = await (await request.get(`/api/posts/${path}`)).json()
    expect(external.metadata.id).toBe(document.documentId)
    releaseAutosave()
    await expect.poll(() => autosave.statuses.length, { timeout: 15_000 }).toBe(1)
    expect(autosave.statuses[0]).toBe(409)
    await expect(page.locator(`[data-tab-id="${path}"][data-save-status="external"]`)).toBeVisible({ timeout: 15_000 })

    await expect(page.getByTestId('diary-calendar')).toBeHidden()
    await expect(page.locator(`[data-tab-id="${path}"][data-save-status="external"]`)).toHaveCount(1)
    const readToggle = page.getByTestId('view-toggle')
    if (/read|阅读/i.test(await readToggle.getAttribute('aria-label') ?? '')) await readToggle.click()
    await expect(page.locator('.reading-pane')).toBeVisible()
    await expect(page.locator('.reading-pane article')).toContainText(localMarker)

    await enterEditor(page)
    const keepLocal = page.locator('button[aria-label="Keep local version and overwrite disk"]')
    await expect(keepLocal).toBeVisible({ timeout: 15_000 })
    await keepLocal.click()
    await expect(page.locator(`[data-tab-id="${path}"][data-save-status="saved"]`)).toBeVisible({ timeout: 15_000 })
    const resolved = await (await request.get(`/api/posts/${path}`)).json()
    expect(normalizeLineEndings(resolved.raw)).toBe(localRaw)
    expect(resolved.metadata.id).toBe(document.documentId)
  } finally {
    if (browserAutosaveInstalled) await page.unroute(`**/api/posts/${path}`)
    await deleteDiaryDate(request, date)
  }

  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([])
})

test('Native Diary does not expose a separate Mood context action', async ({ page, request }) => {
  const date = localCivilDate()
  const path = diaryPath(date)
  const state = diagnostics(page)

  try {
    await seedDiary(request, date, `# Native Diary ${RUN_ID}\n`)
    await openDiaryHome(page)
    await clickDiaryDate(page, date)
    await assertNativeReader(page, date)

    await expect(page.getByTestId('diary-native-mood-context')).toHaveCount(0)
    await expect(page.getByTestId('diary-mood-trigger')).toHaveCount(0)
    await enterEditor(page)
    await expect(page.getByTestId('diary-native-mood-context')).toHaveCount(0)
    await expect(page.getByTestId('diary-mood-trigger')).toHaveCount(0)
  } finally {
    await deleteDiaryDate(request, date)
  }

  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([])
})

test('ordinary Note does not expose the native Diary mood context', async ({ page, request }) => {
  const path = `inbox/d7-2-mood-note-${RUN_ID}`
  const state = diagnostics(page, ['net::ERR_FAILED'])

  try {
    await seedOrdinaryNote(request, path)
    await page.goto(`/vault/${path}`)
    await expect(page).toHaveURL(new RegExp(`/vault/${path.replace('/', '\\/')}(?:[?#]|$)`))
    await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('diary-native-mood-context')).toHaveCount(0)
    await expect(page.getByTestId('diary-mood-picker')).toHaveCount(0)
    await expect(page.locator('.editor-tabs-context-actions')).toHaveCount(0)
  } finally {
    await deletePost(request, path)
  }

  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([])
})

test('Calendar Mood picker remains fully usable at 320/375px', async ({ page, request }) => {
  const date = localCivilDate()
  const state = diagnostics(page)

  async function assertPickerGeometry(width: number, height: number, context: string): Promise<void> {
    const picker = page.getByTestId('diary-mood-picker')
    await expect(picker).toBeVisible()
    const metrics = await picker.evaluate((element) => {
      const pickerRect = element.getBoundingClientRect()
      const grid = element.querySelector<HTMLElement>('.diary-mood-picker-grid')
      const radios = Array.from(element.querySelectorAll<HTMLElement>('[role="radio"]'))
      const rects = radios.map((radio) => {
        const rect = radio.getBoundingClientRect()
        return {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
          visibility: getComputedStyle(radio).visibility,
        }
      })
      return {
        picker: {
          left: pickerRect.left,
          right: pickerRect.right,
          top: pickerRect.top,
          bottom: pickerRect.bottom,
          width: pickerRect.width,
          height: pickerRect.height,
        },
        columns: grid ? getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length : 0,
        rects,
      }
    })

    expect(metrics.picker.left, `${width}px ${context} picker left`).toBeGreaterThanOrEqual(0)
    expect(metrics.picker.right, `${width}px ${context} picker right`).toBeLessThanOrEqual(width)
    expect(metrics.picker.top, `${width}px ${context} picker top`).toBeGreaterThanOrEqual(0)
    expect(metrics.picker.bottom, `${width}px ${context} picker bottom`).toBeLessThanOrEqual(height)
    expect(metrics.picker.width).toBeGreaterThan(0)
    expect(metrics.picker.height).toBeGreaterThan(0)
    expect(metrics.columns, `${width}px ${context} columns`).toBe(4)
    expect(metrics.rects).toHaveLength(24)
    expect(metrics.rects.every((rect) => (
      rect.width >= 44
      && rect.height >= 44
      && rect.visibility !== 'hidden'
      && rect.left >= metrics.picker.left - 1
      && rect.right <= metrics.picker.right + 1
      && rect.top >= metrics.picker.top - 1
      && rect.bottom <= metrics.picker.bottom + 1
    ))).toBe(true)
  }

  try {
    await seedDiary(request, date, `# D7.2 mobile picker ${RUN_ID}`)
    await openDiaryHome(page)
    for (const viewport of [
      { width: 320, height: 700 },
      { width: 375, height: 812 },
    ]) {
      await page.setViewportSize(viewport)
      const calendar = page.getByTestId('diary-calendar')
      await expect(calendar).toBeVisible()
      const trigger = page.locator(`[data-testid="diary-calendar-mood"][data-date="${date}"]`)
      await expect(trigger).toBeVisible()
      await trigger.click()
      await assertPickerGeometry(viewport.width, viewport.height, 'Calendar Home')

      const picker = page.getByTestId('diary-mood-picker')
      await picker.getByRole('radio', { name: /喜欢 \/ Like|喜欢/ }).click()
      await expect(picker).toHaveCount(0)
    }
  } finally {
    await deleteDiaryDate(request, date)
  }

  expect(state.pageErrors).toEqual([])
  expect(state.consoleErrors).toEqual([])
})

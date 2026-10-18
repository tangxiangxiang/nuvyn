import { readFile } from 'node:fs/promises'
import { expect, test } from './fixtures/diary'
import { CALENDAR_TEST_TIME_ZONE } from './helpers/calendar-clock'

test('managed Diary keeps only authorized PDF export and no Markdown format chooser', async ({ page, request }, testInfo) => {
  const date = '2026-08-12'
  const path = `diary/${date}`
  const created = await request.post('/api/diary/dates', { data: { date, timeZone: CALENDAR_TEST_TIME_ZONE } })
  expect(created.status(), await created.text()).toBe(201)
  const original = await (await request.get(`/api/posts/${path}`)).json()
  await request.put(`/api/posts/${path}`, { data: { raw: '# Diary PDF\n\nAUTHORIZED_DIARY_CONTENT', baseRaw: original.raw } })
  await page.goto(`/vault/${path}`)
  const row = page.locator(`[data-tree-key="file:${path}"]`)
  await expect(row).toBeVisible()
  await row.locator(':scope > .row-line').click({ button: 'right' })
  await expect(page.locator('.tree-context-menu')).not.toContainText('Markdown')
  const downloadPromise = page.waitForEvent('download')
  await page.locator('.tree-context-menu').getByRole('button', { name: /^(Export PDF|导出 PDF)$/u }).click()
  await expect(page.getByRole('radio', { name: 'Markdown (.md)' })).toHaveCount(0)
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('Diary PDF.pdf')
  await download.saveAs(testInfo.outputPath('diary-authorized.pdf'))
  const bytes = await readFile((await download.path())!)
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
  await expect(page.locator('.pdf-export-surface')).toHaveCount(0)

  // Existing Diary lifecycle removes its document/model on lock.
  await page.reload()
  await expect(row).toBeVisible()
  await page.getByTestId('account-button').click()
  await page.getByTestId('account-lock-diary').click()
  await expect(row).toHaveCount(0)
  await expect(page.getByRole('radio', { name: 'Markdown (.md)' })).toHaveCount(0)
})

test('locking Diary cancels an unopened-document PDF source read before it can publish', async ({ page, request }) => {
  for (const date of ['2026-08-13', '2026-08-14']) {
    const created = await request.post('/api/diary/dates', { data: { date, timeZone: CALENDAR_TEST_TIME_ZONE } })
    expect(created.status(), await created.text()).toBe(201)
  }
  await page.goto('/vault/diary/2026-08-13')
  const path = 'diary/2026-08-14'
  const row = page.locator(`[data-tree-key="file:${path}"]`)
  await expect(row).toBeVisible()
  let release!: () => void
  let seen!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const requested = new Promise<void>((resolve) => { seen = resolve })
  await page.route(`**/api/posts/${path}`, async (route) => {
    seen()
    await gate
    await route.continue()
  })
  let downloads = 0
  page.on('download', () => { downloads += 1 })
  await row.locator(':scope > .row-line').click({ button: 'right' })
  await page.locator('.tree-context-menu').getByRole('button', { name: /^(Export PDF|导出 PDF)$/u }).click()
  await requested
  await page.getByTestId('account-button').click()
  await page.getByTestId('account-lock-diary').click()
  await expect(row).toHaveCount(0)
  const response = page.waitForResponse((value) => new URL(value.url()).pathname === `/api/posts/${path}`)
  release()
  expect((await response).status()).toBe(423)
  await expect(page.locator('.pdf-export-surface')).toHaveCount(0)
  expect(downloads).toBe(0)
})

test('Diary lock during PDF canvas generation prevents the final browser download', async ({ page, request }) => {
  const date = '2026-08-15'
  const created = await request.post('/api/diary/dates', { data: { date, timeZone: CALENDAR_TEST_TIME_ZONE } })
  expect(created.status(), await created.text()).toBe(201)
  await page.goto(`/vault/diary/${date}`)
  const row = page.locator(`[data-tree-key="file:diary/${date}"]`)
  await expect(row).toBeVisible()
  await page.evaluate(async () => {
    const { __testing__ } = await import('/src/lib/pdfExport.ts')
    const { useDiaryAccessSession } = await import('/src/composables/diary/useDiaryAccessSession.ts')
    const state = window as typeof window & { diaryLockedDuringPdf?: boolean }
    state.diaryLockedDuringPdf = false
    // Existing PDF clone seam: exercise the real session teardown while the
    // asynchronous renderer is active, not before export starts.
    __testing__.setPdfCloneObserver(() => {
      void useDiaryAccessSession().lock()
      state.diaryLockedDuringPdf = true
    })
  })
  let downloads = 0
  page.on('download', () => { downloads += 1 })
  await row.locator(':scope > .row-line').click({ button: 'right' })
  await page.locator('.tree-context-menu').getByRole('button', { name: /^(Export PDF|导出 PDF)$/u }).click()
  await page.waitForFunction(() => (window as typeof window & { diaryLockedDuringPdf?: boolean }).diaryLockedDuringPdf)
  await expect(row).toHaveCount(0)
  await expect(page.locator('.pdf-download-host')).toHaveCount(0)
  expect(downloads).toBe(0)
})

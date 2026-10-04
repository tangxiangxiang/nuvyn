import { readFile } from 'node:fs/promises'
import type { Page } from '@playwright/test'
import type { LedgerAccountDto, LedgerCategoryDto, LedgerSettingsDto, LedgerTransactionDto, LedgerTransactionPageDto } from '../shared/ledgerProtocol'
import type { LedgerAnalysisExportDto } from '../src/features/ledger/ledgerAnalysisExport'
import { expect, test } from './fixtures/auth'
import { ensureLedgerDashboardFixtures } from './helpers/ledger-live'

test.beforeEach(async ({ request }) => {
  await ensureLedgerDashboardFixtures(request)
})

async function openDashboard(page: Page): Promise<void> {
  await page.goto('/ledger')
  await expect(page.getByTestId('ledger-dashboard')).toBeVisible()
}

async function hoverLedgerNav(page: Page): Promise<void> {
  await page.locator('.scope-chip').filter({ hasText: 'ledger' }).hover()
}

test('active Ledger nav hover + E downloads complete active facts without changing UI, even at a narrow fine-pointer width', async ({ page, request }) => {
  const accountsResponse = await request.get('/api/ledger/accounts?includeArchived=true')
  const accounts = await accountsResponse.json() as LedgerAccountDto[]
  const account = accounts.find(({ archivedAt }) => archivedAt === null)!
  const categoriesResponse = await request.get('/api/ledger/categories?includeArchived=true')
  const categories = await categoriesResponse.json() as LedgerCategoryDto[]
  const category = categories.find(({ kind, archivedAt }) => kind === 'expense' && archivedAt === null)!
  const created = await request.post('/api/ledger/transactions', {
    data: { type: 'expense', accountId: account.id, categoryId: category.id, amountMinor: 1, occurredAt: Date.now(), payee: '分析导出测试', note: '' },
    headers: { 'Idempotency-Key': `ledger-analysis-expense-${Date.now()}` },
  })
  expect(created.status(), await created.text()).toBe(201)
  const transaction = await created.json() as { id: string }
  const excluded = await request.put(`/api/ledger/transactions/${transaction.id}/statistics-exclusion`, { data: {} })
  expect(excluded.status()).toBe(200)
  const createdForDeletion = await request.post('/api/ledger/transactions', {
    data: { type: 'expense', accountId: account.id, categoryId: category.id, amountMinor: 2, occurredAt: Date.now(), payee: '已删除分析导出测试', note: '' },
    headers: { 'Idempotency-Key': `ledger-analysis-deleted-expense-${Date.now()}` },
  })
  expect(createdForDeletion.status(), await createdForDeletion.text()).toBe(201)
  const deletedTransaction = await createdForDeletion.json() as { id: string; version: number }
  const deleted = await request.delete(`/api/ledger/transactions/${deletedTransaction.id}`, { data: { expectedVersion: deletedTransaction.version } })
  expect(deleted.status(), await deleted.text()).toBe(200)
  expect(await deleted.json()).toMatchObject({ id: deletedTransaction.id, deletedAt: expect.any(Number) })
  const settings = await (await request.get('/api/ledger/settings')).json() as LedgerSettingsDto
  const allTransactions: LedgerTransactionDto[] = []
  let cursor: string | null = null
  do {
    const response = await request.get('/api/ledger/transactions', { params: { limit: 200, includeDeleted: true, ...(cursor === null ? {} : { cursor }) } })
    expect(response.status()).toBe(200)
    const result = await response.json() as LedgerTransactionPageDto
    allTransactions.push(...result.transactions)
    cursor = result.page.nextCursor
  } while (cursor !== null)
  expect(allTransactions.find(({ id }) => id === deletedTransaction.id)).toMatchObject({ deletedAt: expect.any(Number) })
  const expectedIds = allTransactions.filter(({ deletedAt }) => deletedAt === null).map(({ id }) => id)

  await page.setViewportSize({ width: 390, height: 844 })
  await openDashboard(page)
  expect(await page.evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches)).toBe(true)
  const eyebrow = page.locator('.ledger-eyebrow')
  await expect(eyebrow).toHaveText('Ledger')
  await expect(eyebrow.locator('span')).toHaveCount(0)
  const chip = page.locator('.scope-chip').filter({ hasText: 'ledger' })
  await expect(chip).toHaveAttribute('aria-pressed', 'true')

  let downloadCount = 0
  page.on('download', () => { downloadCount += 1 })
  await page.keyboard.press('e')
  expect(downloadCount).toBe(0)
  await eyebrow.hover()
  await page.keyboard.press('e')
  expect(downloadCount).toBe(0)
  await hoverLedgerNav(page)
  expect(downloadCount).toBe(0)
  await chip.evaluate(async (element) => {
    getComputedStyle(element).color
    await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {})))
  })
  const appearance = await chip.evaluate((element) => {
    const style = getComputedStyle(element)
    return { className: element.className, title: element.getAttribute('title'), cursor: style.cursor, padding: style.padding, font: style.font, border: style.border, color: style.color }
  })
  const downloadPromise = page.waitForEvent('download')
  await page.keyboard.down('e')
  const download = await downloadPromise
  const file = await download.path()
  expect(file).toBeTruthy()
  const json = await readFile(file!, 'utf8')
  const data = JSON.parse(json) as LedgerAnalysisExportDto
  expect(json).toBe(JSON.stringify(data, null, 2))
  expect(Object.keys(data)).toEqual(['version', 'exportedAt', 'currency', 'timezone', 'accounts', 'transactions'])
  expect(data).toMatchObject({ version: 1, currency: settings.baseCurrency, timezone: settings.timezone })
  expect(data.accounts.map(({ id }) => id)).toEqual(accounts.map(({ id }) => id))
  expect(data.transactions.map(({ id }) => id)).toEqual(expectedIds)
  expect(data.transactions.every(({ deletedAt }) => deletedAt === null)).toBe(true)
  expect(data.transactions.find(({ id }) => id === deletedTransaction.id)).toBeUndefined()
  expect(data.transactions.find(({ id }) => id === transaction.id)).toMatchObject({
    type: 'expense', amountMinor: 1, excludedFromStatistics: true, categoryId: category.id, categoryName: category.name,
  })
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: settings.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(data.exportedAt)).map(({ type, value }) => [type, value]))
  expect(download.suggestedFilename()).toBe(`nuvyn-ledger-${parts.year}-${parts.month}-${parts.day}_${parts.hour}-${parts.minute}-${parts.second}.json`)
  await expect(page.locator('a[download]')).toHaveCount(0)
  await page.keyboard.down('e')
  await page.keyboard.up('e')
  expect(downloadCount).toBe(1)
  expect(await chip.evaluate((element) => {
    const style = getComputedStyle(element)
    return { className: element.className, title: element.getAttribute('title'), cursor: style.cursor, padding: style.padding, font: style.font, border: style.border, color: style.color }
  })).toEqual(appearance)
  await expect(eyebrow).toHaveText('Ledger')
  await expect(page.getByTestId('ledger-record-button')).toBeVisible()

  await page.mouse.move(0, 0)
  await page.keyboard.press('e')
  expect(downloadCount).toBe(1)
  await hoverLedgerNav(page)
  const input = page.getByTestId('ledger-period-date').locator('input').first()
  const originalDate = await input.inputValue()
  await input.evaluate((node: HTMLInputElement) => node.focus())
  await page.keyboard.press('e')
  expect(downloadCount).toBe(1)
  await input.fill(originalDate)
  await input.evaluate((node: HTMLInputElement) => node.blur())
  await hoverLedgerNav(page)
  const secondDownload = page.waitForEvent('download')
  await page.keyboard.press('Shift+E')
  await secondDownload
  expect(downloadCount).toBe(2)
})

test('the Ledger command remains available on accounts, account detail and filtered transactions', async ({ page, request }) => {
  const accounts = await (await request.get('/api/ledger/accounts?includeArchived=true')).json() as LedgerAccountDto[]
  const account = accounts.find(({ archivedAt }) => archivedAt === null)!
  const allTransactions: LedgerTransactionDto[] = []
  let cursor: string | null = null
  do {
    const response = await request.get('/api/ledger/transactions', { params: { limit: 200, includeDeleted: true, ...(cursor === null ? {} : { cursor }) } })
    expect(response.status()).toBe(200)
    const result = await response.json() as LedgerTransactionPageDto
    allTransactions.push(...result.transactions)
    cursor = result.page.nextCursor
  } while (cursor !== null)
  const expectedIds = allTransactions.filter(({ deletedAt }) => deletedAt === null).map(({ id }) => id)
  for (const [path, testId] of [
    ['/ledger/accounts', 'ledger-accounts-page'],
    [`/ledger/accounts/${account.id}`, 'ledger-account-page'],
    [`/ledger/transactions?accountId=${account.id}`, 'ledger-transactions-page'],
  ]) {
    await page.goto(path!)
    await expect(page.getByTestId(testId!)).toBeVisible()
    const route = page.url()
    const pending = page.waitForEvent('download')
    await hoverLedgerNav(page)
    await page.keyboard.press('e')
    const download = await pending
    const data = JSON.parse(await readFile((await download.path())!, 'utf8')) as LedgerAnalysisExportDto
    expect(data.accounts.map(({ id }) => id)).toEqual(accounts.map(({ id }) => id))
    expect(data.transactions.map(({ id }) => id)).toEqual(expectedIds)
    expect(page.url()).toBe(route)
  }
})

test('leaving Ledger invalidates a pending export even if Ledger is reopened before the read completes', async ({ page }) => {
  await openDashboard(page)
  let downloads = 0
  page.on('download', () => { downloads += 1 })
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let started!: () => void
  const readStarted = new Promise<void>((resolve) => { started = resolve })
  let intercepted = false
  await page.route('**/api/ledger/transactions?**', async (route) => {
    const query = new URL(route.request().url()).searchParams
    if (intercepted || query.get('limit') !== '200' || query.get('includeDeleted') !== 'true') {
      await route.continue()
      return
    }
    intercepted = true
    const response = await route.fetch()
    started()
    await held
    await route.fulfill({ response })
  })
  try {
    await hoverLedgerNav(page)
    await page.keyboard.press('e')
    await readStarted
    await page.locator('.scope-chip').filter({ hasText: 'note' }).click()
    await expect(page.locator('.vault')).toBeVisible()
    await page.locator('.scope-chip').filter({ hasText: 'ledger' }).click()
    await expect(page.getByTestId('ledger-dashboard')).toBeVisible()
    release()
    await page.waitForLoadState('networkidle')
    expect(downloads).toBe(0)
    const pending = page.waitForEvent('download')
    await hoverLedgerNav(page)
    await page.keyboard.press('e')
    await pending
    expect(downloads).toBe(1)
  } finally {
    release()
    await page.unroute('**/api/ledger/transactions?**')
  }
})

test.describe('touch pointer', () => {
  test.use({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } })

  test('does not enable the keyboard shortcut on touch devices', async ({ page }) => {
    await openDashboard(page)
    expect(await page.evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches)).toBe(false)
    let downloadCount = 0
    let transactionReads = 0
    page.on('download', () => { downloadCount += 1 })
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/ledger/transactions') transactionReads += 1
    })
    const target = page.locator('.scope-chip').filter({ hasText: 'ledger' })
    await target.dispatchEvent('mouseenter')
    await target.dispatchEvent('touchstart')
    await page.keyboard.press('e')
    expect(downloadCount).toBe(0)
    expect(transactionReads).toBe(0)
    await expect(page.locator('.ledger-eyebrow')).toHaveText('Ledger')
    await expect(page.getByTestId('ledger-record-button')).toBeVisible()
  })
})

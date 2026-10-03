import { readFile } from 'node:fs/promises'
import type { Page } from '@playwright/test'
import type { LedgerAccountDto, LedgerCategoryDto, LedgerSettingsDto, LedgerTransactionDto, LedgerTransactionPageDto } from '../shared/ledgerProtocol'
import type { LedgerAnalysisExportDto } from '../src/features/ledger/ledgerAnalysisExport'
import { openingDateInputFromInstant } from '../src/features/ledger/time'
import { expect, test } from './fixtures/auth'
import { ensureLedgerDashboardFixtures } from './helpers/ledger-live'

test.beforeEach(async ({ request }) => {
  await ensureLedgerDashboardFixtures(request)
})

async function openDashboard(page: Page): Promise<void> {
  await page.goto('/ledger')
  await expect(page.getByTestId('ledger-dashboard')).toBeVisible()
}

async function hoverLedgerEyebrow(page: Page): Promise<void> {
  const target = page.locator('.ledger-eyebrow span')
  await target.scrollIntoViewIfNeeded()
  const box = await target.boundingBox()
  if (!box) throw new Error('Ledger eyebrow is not visible')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
}

test('fine-pointer LEDGER hover + E downloads complete active facts without changing the eyebrow, even at a narrow width', async ({ page, request }) => {
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
  const appearance = await eyebrow.evaluate((element) => {
    const target = element.querySelector('span')!
    const before = document.createRange()
    before.selectNodeContents(element)
    const plain = element.cloneNode(false) as HTMLElement
    plain.textContent = 'Ledger'
    plain.style.position = 'absolute'
    plain.style.visibility = 'hidden'
    element.after(plain)
    try {
      const after = document.createRange()
      after.selectNodeContents(plain)
      const properties = ['font-family', 'font-size', 'font-weight', 'letter-spacing', 'line-height', 'color', 'cursor', 'text-decoration-line']
      const style = (node: Element) => properties.map((name) => getComputedStyle(node).getPropertyValue(name))
      return { width: before.getBoundingClientRect().width, plainWidth: after.getBoundingClientRect().width, target: style(target), parent: style(element) }
    } finally {
      plain.remove()
    }
  })
  expect(appearance.target).toEqual(appearance.parent)
  expect(Math.abs(appearance.width - appearance.plainWidth)).toBeLessThanOrEqual(0.25)

  let downloadCount = 0
  page.on('download', () => { downloadCount += 1 })
  await page.keyboard.press('e')
  expect(downloadCount).toBe(0)
  await hoverLedgerEyebrow(page)
  expect(downloadCount).toBe(0)
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
  expect(download.suggestedFilename()).toBe(`nuvyn-ledger-${openingDateInputFromInstant(Date.parse(data.exportedAt), settings.timezone)}.json`)
  await expect(page.locator('a[download]')).toHaveCount(0)
  await page.keyboard.down('e')
  await page.keyboard.up('e')
  expect(downloadCount).toBe(1)
  await expect(eyebrow).toHaveText('Ledger')
  await expect(page.getByTestId('ledger-record-button')).toBeVisible()

  await page.mouse.move(0, 0)
  await page.keyboard.press('e')
  expect(downloadCount).toBe(1)
  await hoverLedgerEyebrow(page)
  const input = page.getByTestId('ledger-period-date').locator('input').first()
  const originalDate = await input.inputValue()
  await input.evaluate((node: HTMLInputElement) => node.focus())
  await page.keyboard.press('e')
  expect(downloadCount).toBe(1)
  await input.fill(originalDate)
  await input.evaluate((node: HTMLInputElement) => node.blur())
  await hoverLedgerEyebrow(page)
  const secondDownload = page.waitForEvent('download')
  await page.keyboard.press('Shift+E')
  await secondDownload
  expect(downloadCount).toBe(2)
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
    const target = page.locator('.ledger-eyebrow span')
    await target.dispatchEvent('mouseenter')
    await target.dispatchEvent('touchstart')
    await page.keyboard.press('e')
    expect(downloadCount).toBe(0)
    expect(transactionReads).toBe(0)
    await expect(page.locator('.ledger-eyebrow')).toHaveText('Ledger')
    await expect(page.getByTestId('ledger-record-button')).toBeVisible()
  })
})

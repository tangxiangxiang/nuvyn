import { expect, test, type APIRequestContext } from './fixtures/auth'
import { instantFromLocalDateTime } from '../src/features/ledger/time'

type LedgerSettings = {
  baseCurrency: string
  timezone: string
}

type LedgerAccount = {
  id: string
}

type LedgerCategory = {
  id: string
  archivedAt: number | null
}

type LedgerTransaction = {
  id: string
  type: 'income' | 'expense' | 'transfer' | 'adjustment'
}

type Viewport = {
  width: number
  height: number
}

async function ensureLedgerFixture(request: APIRequestContext): Promise<LedgerTransaction> {
  const fixtureId = crypto.randomUUID()
  const openingDate = '2026-01-01'

  let settingsResponse = await request.get('/api/ledger/settings')
  if (settingsResponse.status() === 404) {
    const initialize = await request.post('/api/ledger/settings', {
      data: { baseCurrency: 'CNY', timezone: 'Asia/Shanghai' },
      headers: { 'Idempotency-Key': `closure-settings-${fixtureId}` },
    })
    if (initialize.status() === 409) settingsResponse = await request.get('/api/ledger/settings')
    else {
      expect(initialize.status()).toBe(201)
      settingsResponse = await request.get('/api/ledger/settings')
    }
  }
  expect(settingsResponse.status()).toBe(200)
  const settings = await settingsResponse.json() as LedgerSettings

  const createAccount = await request.post('/api/ledger/accounts', {
    data: {
      name: `Closure geometry account ${fixtureId}`,
      type: 'bank',
      nature: 'asset',
      openingBalanceMinor: 0,
      openingDate,
      currency: settings.baseCurrency,
      note: '',
    },
    headers: { 'Idempotency-Key': `closure-account-${fixtureId}` },
  })
  if (createAccount.status() !== 201) {
    throw new Error(
      `Failed to create geometry fixture account: ${createAccount.status()} ${await createAccount.text()}`,
    )
  }
  const account = await createAccount.json() as LedgerAccount

  const categoriesResponse = await request.get('/api/ledger/categories?kind=expense&includeArchived=true')
  expect(categoriesResponse.status()).toBe(200)
  const categories = await categoriesResponse.json() as LedgerCategory[]
  let category = categories.find((candidate) => candidate.archivedAt === null)
  if (!category) {
    const createCategory = await request.post('/api/ledger/categories', {
      data: { kind: 'expense', name: `Closure geometry category ${fixtureId}` },
      headers: { 'Idempotency-Key': `closure-category-${fixtureId}` },
    })
    expect(createCategory.status()).toBe(201)
    category = await createCategory.json() as LedgerCategory
  }

  const createTransaction = await request.post('/api/ledger/transactions', {
    data: {
      type: 'expense',
      amountMinor: 123,
      accountId: account.id,
      categoryId: category.id,
      occurredAt: instantFromLocalDateTime(`${openingDate}T12:00`, settings.timezone),
      payee: 'Closure geometry fixture',
      note: '',
    },
    headers: { 'Idempotency-Key': `closure-transaction-${fixtureId}` },
  })
  if (createTransaction.status() !== 201) {
    throw new Error(
      `Failed to create geometry fixture transaction: ${createTransaction.status()} ${await createTransaction.text()}`,
    )
  }
  return await createTransaction.json() as LedgerTransaction
}

async function assertDesktopGeometry(sheet: import('@playwright/test').Locator, viewport: Viewport): Promise<void> {
  const box = await sheet.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return

  expect(box.width).toBeLessThanOrEqual(622)
  expect(box.width).toBeLessThan(viewport.width)
  expect(box.y).toBeGreaterThan(0)
  expect(Math.abs((box.y + box.height / 2) - viewport.height / 2)).toBeLessThanOrEqual(3)
  expect(Math.abs((box.x + box.width / 2) - viewport.width / 2)).toBeLessThanOrEqual(3)
}

async function assertMobileGeometry(sheet: import('@playwright/test').Locator, viewport: Viewport): Promise<void> {
  const box = await sheet.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return

  expect(box.width).toBeGreaterThanOrEqual(viewport.width - 2)
  expect(box.width).toBeLessThanOrEqual(viewport.width + 1)
  expect(Math.abs(box.x)).toBeLessThanOrEqual(1)
  expect(box.height).toBeLessThanOrEqual(viewport.height + 1)
  expect(Math.abs(viewport.height - (box.y + box.height))).toBeLessThanOrEqual(2)
}

async function openCreateSheet(page: import('@playwright/test').Page, request: APIRequestContext): Promise<import('@playwright/test').Locator> {
  await ensureLedgerFixture(request)
  await page.goto('/ledger')
  await expect(page.getByTestId('ledger-dashboard')).toBeVisible()
  await page.getByTestId('ledger-record-button').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toHaveCount(1)
  await expect(dialog).toBeVisible()
  return dialog
}

test('Ledger create sheet keeps centered desktop geometry and one labelled dialog', async ({ page, request }) => {
  const viewport = { width: 1280, height: 800 }
  await page.setViewportSize(viewport)
  const dialog = await openCreateSheet(page, request)

  await expect(dialog).toHaveAccessibleName('记一笔支出')
  await expect(page.getByTestId('ledger-transaction-sheet')).toBeVisible()
  await expect(page.locator('#ledger-transaction-amount')).toBeFocused()
  await assertDesktopGeometry(page.getByTestId('ledger-transaction-sheet'), viewport)

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(page.getByTestId('ledger-record-button')).toBeFocused()
})

test('Ledger create sheet keeps full-width bottom-anchored mobile geometry', async ({ page, request }) => {
  const viewport = { width: 390, height: 844 }
  await page.setViewportSize(viewport)
  const dialog = await openCreateSheet(page, request)

  await expect(dialog).toHaveAccessibleName('记一笔支出')
  await assertMobileGeometry(page.getByTestId('ledger-transaction-sheet'), viewport)
  await dialog.getByRole('button', { name: '取消' }).click()
  await expect(dialog).toBeHidden()
})

test('Ledger detail sheet keeps centered desktop geometry and one labelled dialog', async ({ page, request }) => {
  const viewport = { width: 1280, height: 800 }
  await page.setViewportSize(viewport)
  const transaction = await ensureLedgerFixture(request)

  await page.goto('/ledger/transactions')
  const row = page.getByTestId(`ledger-transaction-row-${transaction.id}`)
  await expect(row).toBeVisible()
  await row.click()

  const dialog = page.getByRole('dialog')
  await expect(dialog).toHaveCount(1)
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveAccessibleName('支出')
  await expect(page.getByTestId('ledger-transaction-detail-sheet')).toBeVisible()
  await expect(page.locator('.ledger-detail-content')).toBeFocused()
  await assertDesktopGeometry(page.getByTestId('ledger-transaction-detail-sheet'), viewport)

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(row).toBeFocused()
})

test('Ledger detail sheet keeps full-width bottom-anchored mobile geometry', async ({ page, request }) => {
  const viewport = { width: 390, height: 844 }
  await page.setViewportSize(viewport)
  const transaction = await ensureLedgerFixture(request)

  await page.goto('/ledger/transactions')
  const row = page.getByTestId(`ledger-transaction-row-${transaction.id}`)
  await expect(row).toBeVisible()
  await row.click()

  const dialog = page.getByRole('dialog')
  await expect(dialog).toHaveCount(1)
  await expect(dialog).toHaveAccessibleName('支出')
  await assertMobileGeometry(page.getByTestId('ledger-transaction-detail-sheet'), viewport)
  await dialog.getByRole('button', { name: '关闭交易详情' }).click()
  await expect(dialog).toBeHidden()
})

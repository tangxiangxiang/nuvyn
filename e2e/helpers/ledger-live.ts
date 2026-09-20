import { expect, type APIRequestContext } from '../fixtures/auth'
import type { Page } from '@playwright/test'

type LedgerTransaction = {
  id: string
  type: string
  amountMinor: number
  deletedAt: number | null
  excludedFromStatistics: boolean
}

type LedgerTransactionPage = {
  transactions: LedgerTransaction[]
  page: {
    nextCursor: string | null
    total?: number
    statisticsExcludedCount?: number
  }
}

type LedgerAccount = {
  id: string
  name: string
  currentBalanceMinor: number
  archivedAt: number | null
}

type LedgerCategory = {
  id: string
  archivedAt: number | null
}

export async function getTransactions(request: APIRequestContext): Promise<LedgerTransactionPage> {
  const response = await request.get('/api/ledger/transactions?limit=100&includeDeleted=true')
  expect(response.status()).toBe(200)
  return await response.json() as LedgerTransactionPage
}

export async function getAccounts(request: APIRequestContext): Promise<LedgerAccount[]> {
  const response = await request.get('/api/ledger/accounts?includeArchived=true')
  expect(response.status()).toBe(200)
  return await response.json() as LedgerAccount[]
}

export async function ensurePeriodNavigationFixtures(request: APIRequestContext): Promise<{
  categoryId: string
  timezone: string
  currency: string
}> {
  let settingsResponse = await request.get('/api/ledger/settings')
  let timezone = 'Asia/Shanghai'
  expect(settingsResponse.status()).toBe(200)
  let settings = await settingsResponse.json() as { timezone: string; baseCurrency: string } | null
  if (settings === null) {
    const initialize = await request.post('/api/ledger/settings', {
      data: { baseCurrency: 'CNY', timezone },
      headers: { 'Idempotency-Key': `period-settings-${Date.now()}` },
    })
    expect(initialize.status(), await initialize.text()).toBe(201)
    settingsResponse = await request.get('/api/ledger/settings')
    expect(settingsResponse.status()).toBe(200)
    settings = await settingsResponse.json() as { timezone: string; baseCurrency: string }
  }
  expect(settings).not.toBeNull()
  if (settings === null) throw new Error('Ledger Settings remained uninitialized after setup')
  timezone = settings.timezone

  const categoriesResponse = await request.get('/api/ledger/categories?kind=expense')
  expect(categoriesResponse.status()).toBe(200)
  let categories = await categoriesResponse.json() as LedgerCategory[]
  let category = categories.find((candidate) => candidate.archivedAt === null)
  if (!category) {
    const createCategory = await request.post('/api/ledger/categories', {
      data: { kind: 'expense', name: `期间导航分类-${Date.now()}` },
      headers: { 'Idempotency-Key': `period-category-${Date.now()}` },
    })
    expect(createCategory.status(), await createCategory.text()).toBe(201)
    const refreshedCategories = await request.get('/api/ledger/categories?kind=expense')
    expect(refreshedCategories.status()).toBe(200)
    categories = await refreshedCategories.json() as LedgerCategory[]
    category = categories.find((candidate) => candidate.archivedAt === null)
  }
  expect(category).toBeTruthy()
  return { categoryId: category!.id, timezone, currency: settings.baseCurrency }
}

export async function createPeriodExpense(
  request: APIRequestContext,
  input: { accountId: string; categoryId: string; amountMinor: number; occurredAt: number; payee: string; key: string },
): Promise<void> {
  const response = await request.post('/api/ledger/transactions', {
    data: {
      type: 'expense',
      amountMinor: input.amountMinor,
      accountId: input.accountId,
      categoryId: input.categoryId,
      occurredAt: input.occurredAt,
      payee: input.payee,
      note: '',
    },
    headers: { 'Idempotency-Key': input.key },
  })
  expect(response.status(), await response.text()).toBe(201)
}

export async function selectOptionContaining(page: Page, label: string, text: string): Promise<void> {
  const control = page.getByRole('combobox', { name: label }).first()
  await expect(control).toHaveCount(1)
  const trigger = control.locator('[tabindex="0"]').first()
  await trigger.click()
  const option = page.getByRole('option').filter({ hasText: text }).first()
  for (let index = 0; index < 300 && !await option.isVisible().catch(() => false); index += 1) {
    // NSelect virtualizes long lists such as ISO currency metadata. Moving
    // through the public keyboard path scrolls the option into view.
    await trigger.press('ArrowDown')
  }
  await expect(option).toBeVisible()
  // The option is virtualized and can be replaced between the visibility
  // check and a stability-based click. Dispatch the public option click on
  // the currently rendered node instead of depending on a private class or
  // virtual-list timing.
  await option.dispatchEvent('click')
}

export function ledgerDateInput(page: Page, testId: string) {
  return page.getByTestId(testId).locator('input').first()
}

export async function ensureLedgerDashboardFixtures(request: APIRequestContext): Promise<void> {
  let settingsResponse = await request.get('/api/ledger/settings')
  expect(settingsResponse.status()).toBe(200)
  let settings = await settingsResponse.json() as { timezone: string; baseCurrency: string } | null
  if (settings === null) {
    const initialize = await request.post('/api/ledger/settings', {
      data: { baseCurrency: 'CNY', timezone: 'Asia/Shanghai' },
      headers: { 'Idempotency-Key': `ledger-live-settings-${Date.now()}` },
    })
    if (initialize.status() === 409) {
      settingsResponse = await request.get('/api/ledger/settings')
    } else {
      expect(initialize.status(), await initialize.text()).toBe(201)
      settingsResponse = await request.get('/api/ledger/settings')
    }
    expect(settingsResponse.status()).toBe(200)
    settings = await settingsResponse.json() as { timezone: string; baseCurrency: string }
  }
  expect(settings).not.toBeNull()
  if (settings === null) throw new Error('Ledger Settings remained uninitialized after setup')

  const accounts = await getAccounts(request)
  if (accounts.some((account) => account.archivedAt === null)) return

  const openingDate = '2026-01-01'
  const createAccount = await request.post('/api/ledger/accounts', {
    data: {
      name: `Ledger live fixture account-${Date.now()}`,
      type: 'bank',
      nature: 'asset',
      openingBalanceMinor: 0,
      openingDate,
      currency: settings.baseCurrency,
      note: '',
    },
    headers: { 'Idempotency-Key': `ledger-live-account-${Date.now()}` },
  })
  expect(createAccount.status(), await createAccount.text()).toBe(201)
}

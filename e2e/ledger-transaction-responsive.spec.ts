import { expect, test, type APIRequestContext } from './fixtures/auth'
import { ensureLedgerDashboardFixtures, getAccounts } from './helpers/ledger-live'

type LedgerCategory = {
  id: string
  archivedAt: number | null
}

async function ensureTransactionHistoryFixture(request: APIRequestContext): Promise<void> {
  await ensureLedgerDashboardFixtures(request)

  const accounts = await getAccounts(request)
  const account = accounts.find((candidate) => candidate.archivedAt === null)
  expect(account).toBeTruthy()
  if (!account) throw new Error('No active Ledger account available for the responsive fixture')

  const categoriesResponse = await request.get('/api/ledger/categories?kind=expense&includeArchived=true')
  expect(categoriesResponse.status(), await categoriesResponse.text()).toBe(200)
  const categories = await categoriesResponse.json() as LedgerCategory[]
  let category = categories.find((candidate) => candidate.archivedAt === null)
  if (!category) {
    const createCategory = await request.post('/api/ledger/categories', {
      data: { kind: 'expense', name: `Responsive layout category-${Date.now()}` },
      headers: { 'Idempotency-Key': `responsive-layout-category-${Date.now()}` },
    })
    expect(createCategory.status(), await createCategory.text()).toBe(201)
    category = await createCategory.json() as LedgerCategory
  }
  expect(category).toBeTruthy()
  if (!category) throw new Error('No expense category available for the responsive fixture')

  const createTransaction = await request.post('/api/ledger/transactions', {
    data: {
      type: 'expense',
      amountMinor: 123,
      accountId: account.id,
      categoryId: category.id,
      occurredAt: Date.now(),
      payee: 'Responsive layout fixture',
      note: '',
    },
    headers: { 'Idempotency-Key': `responsive-layout-transaction-${Date.now()}` },
  })
  expect(createTransaction.status(), await createTransaction.text()).toBe(201)
}

type LayoutMetrics = {
  cardHeight: number
  tableHeight: number
  bodyHeight: number
  paginationTop: number
  paginationBottom: number
  cardBottom: number
  tableBottom: number
}

async function readLayoutMetrics(page: import('@playwright/test').Page): Promise<LayoutMetrics> {
  return await page.evaluate(() => {
    const card = document.querySelector<HTMLElement>('.ledger-transaction-history')
    const table = document.querySelector<HTMLElement>('.ledger-transaction-table')
    const body = document.querySelector<HTMLElement>('.ledger-transaction-table .n-data-table-base-table-body')
    const pagination = document.querySelector<HTMLElement>('.ledger-transaction-pagination')
    if (!card || !table || !body || !pagination) throw new Error('Transaction history layout nodes are missing')

    const cardBox = card.getBoundingClientRect()
    const tableBox = table.getBoundingClientRect()
    const bodyBox = body.getBoundingClientRect()
    const paginationBox = pagination.getBoundingClientRect()
    return {
      cardHeight: cardBox.height,
      tableHeight: tableBox.height,
      bodyHeight: bodyBox.height,
      paginationTop: paginationBox.top,
      paginationBottom: paginationBox.bottom,
      cardBottom: cardBox.bottom,
      tableBottom: tableBox.bottom,
    }
  })
}

test('transaction table grows with desktop viewport height and keeps pagination at the card bottom', async ({ page, request }) => {
  await ensureTransactionHistoryFixture(request)

  const viewports = [
    { width: 1280, height: 720 },
    { width: 1920, height: 1080 },
    { width: 2560, height: 1440 },
  ]
  const metrics: LayoutMetrics[] = []

  for (const viewport of viewports) {
    await page.setViewportSize(viewport)
    await page.goto('/ledger/transactions')
    await expect(page.getByTestId('ledger-transaction-list')).toBeVisible()
    metrics.push(await readLayoutMetrics(page))
  }

  for (const layout of metrics) {
    expect(layout.bodyHeight).toBeGreaterThan(0)
    expect(Math.abs(layout.paginationBottom - layout.cardBottom)).toBeLessThanOrEqual(2)
    expect(layout.tableBottom).toBeLessThanOrEqual(layout.paginationTop + 2)
  }

  expect(metrics[1]!.tableHeight).toBeGreaterThan(metrics[0]!.tableHeight + 200)
  expect(metrics[2]!.tableHeight).toBeGreaterThan(metrics[1]!.tableHeight + 200)
  expect(metrics[1]!.bodyHeight).toBeGreaterThan(metrics[0]!.bodyHeight + 200)
  expect(metrics[2]!.bodyHeight).toBeGreaterThan(metrics[1]!.bodyHeight + 200)
})

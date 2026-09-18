import { expect, test, type APIRequestContext } from './fixtures/auth'
import type { Page } from '@playwright/test'
import { Temporal } from '@js-temporal/polyfill'

type LedgerTransaction = {
  id: string
  type: string
  amountMinor: number
  deletedAt: number | null
}

type LedgerTransactionPage = {
  transactions: LedgerTransaction[]
  page: { nextCursor: string | null }
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

async function getTransactions(request: APIRequestContext): Promise<LedgerTransactionPage> {
  const response = await request.get('/api/ledger/transactions?limit=100&includeDeleted=true')
  expect(response.status()).toBe(200)
  return await response.json() as LedgerTransactionPage
}

async function getAccounts(request: APIRequestContext): Promise<LedgerAccount[]> {
  const response = await request.get('/api/ledger/accounts?includeArchived=true')
  expect(response.status()).toBe(200)
  return await response.json() as LedgerAccount[]
}

async function ensurePeriodNavigationFixtures(request: APIRequestContext): Promise<{
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

async function createPeriodExpense(
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

async function selectOptionContaining(page: Page, label: string, text: string): Promise<void> {
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

function ledgerDateInput(page: Page, testId: string) {
  return page.getByTestId(testId).locator('input').first()
}

test('real Ledger onboarding and expense survive dashboard refresh', async ({ page, request }) => {
  const settingsResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return response.request().method() === 'GET'
      && url.pathname === '/api/ledger/settings'
  })
  await page.goto('/ledger')

  const settingsResponse = await settingsResponsePromise
  expect(settingsResponse.status()).toBe(200)
  expect(settingsResponse.headers()['content-type']).toContain('application/json')
  expect(settingsResponse.headers()['cache-control']).toBe('no-store')
  expect(await settingsResponse.json()).toBeNull()
  await expect(page.getByTestId('ledger-settings-form')).toBeVisible()
  await selectOptionContaining(page, '基础货币', 'CNY')
  await page.locator('#ledger-timezone').fill('Asia/Shanghai')
  await page.getByRole('button', { name: '保存设置并继续' }).click()

  await expect(page.getByTestId('ledger-account-form')).toBeVisible()
  await page.locator('#ledger-account-card-number').fill('6222021234567890')
  await page.locator('#ledger-account-name').fill('招商银行')
  await page.locator('#ledger-account-opening-balance').fill('10000')
  await expect(page.getByTestId('ledger-account-form')).toContainText('CNY · Asia/Shanghai')
  await page.getByRole('button', { name: '继续' }).click()

  await expect(page.getByTestId('ledger-dashboard')).toBeVisible()
  await expect(page.locator('.ledger-dashboard-actions')).toHaveCount(1)
  await expect(page.getByTestId('ledger-record-button')).toHaveCount(1)
  await expect(page.locator('.ledger-metric-card')).toHaveCount(3)
  await expect(page.getByRole('heading', { name: '本月收支' })).toBeVisible()
  await expect(ledgerDateInput(page, 'ledger-period-date')).toHaveValue(Temporal.Now.plainDateISO('Asia/Shanghai').toString())
  await expect(page.locator('[aria-label="选择收支期间"]')).toContainText('本月')
  const periodDateControl = page.getByTestId('ledger-period-date-control-today')
  await expect(periodDateControl.locator('.ledger-period-date-label')).toBeVisible()
  await expect(periodDateControl.locator('.ledger-period-date-editor')).toHaveCSS('opacity', '0')
  for (const period of ['today', 'week', 'month', 'year']) {
    const control = page.getByTestId(`ledger-period-date-control-${period}`)
    await control.hover()
    await expect(control.locator('.ledger-period-date-editor')).toHaveCSS('opacity', '1')
  }
  await periodDateControl.hover()
  const periodDateBox = await page.getByTestId('ledger-period-date').locator('.n-input').boundingBox()
  const periodScopeBox = await page.locator('.ledger-period-scope .n-base-selection').boundingBox()
  if (!periodDateBox || !periodScopeBox) throw new Error('收支期间控件不可测量')
  expect(periodDateBox.width).toBeCloseTo(148, 0)
  expect(periodScopeBox.width).toBeCloseTo(96, 0)
  expect(Math.abs(periodDateBox.height - periodScopeBox.height)).toBeLessThanOrEqual(1)
  await expect(page.locator('.ledger-period-navigation')).toHaveCount(0)
  await expect(page.getByTestId('ledger-dashboard-accounts')).toContainText('招商银行')
  await expect(page.getByTestId('ledger-dashboard-account-viewport')).toBeVisible()
  await expect(page.getByTestId('ledger-dashboard-assets-viewport')).toBeVisible()
  await expect(page.getByTestId('ledger-dashboard-assets-viewport')).toHaveCSS('max-height', '280px')
  await expect(page.getByTestId('ledger-dashboard-assets-viewport')).toHaveCSS('overflow-y', 'auto')
  await expect(page.getByTestId('ledger-total-assets')).toContainText('¥10,000.00')
  await expect(page.getByTestId('ledger-net-worth')).toContainText('¥10,000.00')

  await page.getByTestId('ledger-record-button').click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.locator('#ledger-transaction-amount').fill('38')
  await selectOptionContaining(page, '账户', '招商银行')
  await selectOptionContaining(page, '分类', '餐饮')
  await page.getByRole('button', { name: '保存' }).click()

  await expect(page.getByRole('dialog')).toBeHidden()
  await expect(page.getByTestId('ledger-recent-transactions')).toContainText('餐饮')
  await expect(page.getByTestId('ledger-recent-transactions')).toContainText('-¥38.00')
  const recentRow = page.locator('.ledger-recent-row').first()
  await expect(recentRow).toHaveCSS('display', 'grid')
  const recentRowBox = await recentRow.boundingBox()
  const recentIconBox = await recentRow.locator('.ledger-recent-icon').boundingBox()
  const recentInfoBox = await recentRow.locator('.ledger-recent-info').boundingBox()
  const recentAmountBox = await recentRow.locator('.ledger-recent-amount').boundingBox()
  if (!recentRowBox || !recentIconBox || !recentInfoBox || !recentAmountBox) {
    throw new Error('最近交易行布局节点不可测量')
  }
  expect(recentRowBox.height).toBeLessThan(72)
  expect(recentIconBox.x).toBeLessThan(recentInfoBox.x)
  expect(recentInfoBox.x).toBeLessThan(recentAmountBox.x)
  const rowCenterY = recentRowBox.y + recentRowBox.height / 2
  expect(Math.abs(recentIconBox.y + recentIconBox.height / 2 - rowCenterY)).toBeLessThan(4)
  expect(Math.abs(recentInfoBox.y + recentInfoBox.height / 2 - rowCenterY)).toBeLessThan(4)
  expect(Math.abs(recentAmountBox.y + recentAmountBox.height / 2 - rowCenterY)).toBeLessThan(4)
  await expect(page.locator('.ledger-breakdown-columns > div')).toHaveCount(2)
  await expect(page.getByRole('heading', { name: '收入分类' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '支出分类' })).toBeVisible()
  await expect(page.getByTestId('ledger-total-assets')).toContainText('¥9,962.00')
  await expect(page.getByTestId('ledger-net-worth')).toContainText('¥9,962.00')
  for (const period of ['today', 'week', 'month', 'year']) {
    await expect(page.getByTestId(`ledger-period-${period}`)).toContainText('¥38.00')
  }

  const pageAfterCreate = await getTransactions(request)
  expect(pageAfterCreate.transactions).toHaveLength(1)
  expect(pageAfterCreate.transactions[0]).toMatchObject({ type: 'expense', amountMinor: 3800, deletedAt: null })

  // The trend section is a chart now. Assert the container and the
  // screen-reader table, never anything inside the canvas.
  await expect(page.getByTestId('ledger-cashflow-trend-canvas')).toBeVisible()
  await expect(page.getByTestId('ledger-cashflow-trend-table').locator('tbody tr')).toHaveCount(12)
  await expect(page.getByTestId('ledger-cashflow-trend-table')).toContainText('¥38.00')

  await page.reload()
  await expect(page.getByTestId('ledger-dashboard')).toBeVisible()
  await expect(page.getByTestId('ledger-total-assets')).toContainText('¥9,962.00')
  await expect(page.getByTestId('ledger-net-worth')).toContainText('¥9,962.00')
  await expect(page.getByTestId('ledger-recent-transactions')).toContainText('¥38.00')
  await expect(page.getByTestId('ledger-cashflow-trend-canvas')).toBeVisible()
  await expect(page.locator('body')).not.toContainText('billsMockData')
})

test('response loss recovers one real transaction with the original intent key', async ({ page, request }) => {
  await page.goto('/ledger')
  await expect(page.getByTestId('ledger-dashboard')).toBeVisible()

  const before = await getTransactions(request)
  const accountsBefore = await getAccounts(request)
  const account = accountsBefore.find((candidate) => candidate.archivedAt === null)
  expect(account).toBeTruthy()

  let shouldDropResponse = true
  let droppedKey = ''
  let droppedPayload = ''
  await page.route('**/api/ledger/transactions', async (route) => {
    const intercepted = route.request()
    if (intercepted.method() !== 'POST' || !shouldDropResponse) {
      await route.continue()
      return
    }
    shouldDropResponse = false
    droppedKey = intercepted.headers()['idempotency-key'] ?? ''
    droppedPayload = intercepted.postData() ?? ''
    const response = await route.fetch()
    await response.body()
    await route.abort('connectionreset')
  })

  await page.getByTestId('ledger-record-button').click()
  await page.locator('#ledger-transaction-amount').fill('12')
  await selectOptionContaining(page, '账户', account!.name)
  await selectOptionContaining(page, '分类', '餐饮')
  await page.getByRole('button', { name: '保存' }).click()

  await expect(page.getByTestId('ledger-recovery')).toBeVisible()
  expect(droppedKey).not.toBe('')
  expect(droppedPayload).toContain('"amountMinor":1200')
  const pendingBeforeReload = await page.evaluate(() => sessionStorage.getItem('nuvyn.ledger.pending-create'))
  expect(pendingBeforeReload).toContain(droppedKey)

  await page.reload()
  await expect(page.getByTestId('ledger-recovery')).toBeVisible()
  await expect(page.getByText('上一次交易保存结果未知')).toBeVisible()
  await page.getByRole('button', { name: '用同一内容重试' }).click()

  await expect(page.getByTestId('ledger-dashboard')).toBeVisible()
  await expect(page.getByTestId('ledger-recovery')).toBeHidden()
  await expect.poll(async () => (await getTransactions(request)).transactions.length).toBe(before.transactions.length + 1)

  const after = await getTransactions(request)
  const created = after.transactions.filter((transaction) => transaction.amountMinor === 1200 && transaction.type === 'expense')
  expect(created).toHaveLength(1)
  expect(await page.evaluate(() => sessionStorage.getItem('nuvyn.ledger.pending-create'))).toBeNull()

})

test('an unreadable successful transaction response replays the same committed intent once', async ({ page, request }) => {
  await page.goto('/ledger')
  await expect(page.getByTestId('ledger-dashboard')).toBeVisible()

  const before = await getTransactions(request)
  const accountsBefore = await getAccounts(request)
  const account = accountsBefore.find((candidate) => candidate.archivedAt === null)
  expect(account).toBeTruthy()

  let shouldBreakBody = true
  let droppedKey = ''
  let droppedPayload = ''
  await page.route('**/api/ledger/transactions**', async (route) => {
    const intercepted = route.request()
    if (intercepted.method() !== 'POST' || !shouldBreakBody) {
      await route.continue()
      return
    }
    shouldBreakBody = false
    droppedKey = intercepted.headers()['idempotency-key'] ?? ''
    droppedPayload = intercepted.postData() ?? ''
    const response = await route.fetch()
    const status = response.status()
    await response.body()
    await route.fulfill({
      status,
      headers: { 'content-type': 'application/json' },
      body: '{broken-success-body',
    })
  })

  await page.getByTestId('ledger-record-button').click()
  await page.locator('#ledger-transaction-amount').fill('13')
  await selectOptionContaining(page, '账户', account!.name)
  await selectOptionContaining(page, '分类', '餐饮')
  await page.getByRole('button', { name: '保存' }).click()

  await expect(page.getByTestId('ledger-recovery')).toBeVisible()
  expect(droppedKey).not.toBe('')
  expect(droppedPayload).toContain('"amountMinor":1300')
  await page.reload()
  await expect(page.getByTestId('ledger-recovery')).toBeVisible()
  await page.getByRole('button', { name: '用同一内容重试' }).click()

  await expect(page.getByTestId('ledger-dashboard')).toBeVisible()
  await expect(page.getByTestId('ledger-recovery')).toBeHidden()
  await expect.poll(async () => (await getTransactions(request)).transactions.length).toBe(before.transactions.length + 1)

  const after = await getTransactions(request)
  const created = after.transactions.filter((transaction) => transaction.amountMinor === 1300 && transaction.type === 'expense')
  expect(created).toHaveLength(1)
  expect((await getAccounts(request)).find((candidate) => candidate.id === account!.id)?.currentBalanceMinor)
    .toBe(account!.currentBalanceMinor - 1300)
  expect(await page.evaluate(() => sessionStorage.getItem('nuvyn.ledger.pending-create'))).toBeNull()
})

test('an account response loss remains gated after reload and creates one account on replay', async ({ page, request }) => {
  await page.goto('/ledger/accounts')
  await expect(page.getByTestId('ledger-accounts-page')).toBeVisible()

  const uniqueName = `回放账户-${Date.now()}`
  let shouldDropResponse = true
  let droppedKey = ''
  let droppedPayload = ''
  await page.route('**/api/ledger/accounts**', async (route) => {
    const intercepted = route.request()
    if (intercepted.method() !== 'POST' || !shouldDropResponse) {
      await route.continue()
      return
    }
    shouldDropResponse = false
    droppedKey = intercepted.headers()['idempotency-key'] ?? ''
    droppedPayload = intercepted.postData() ?? ''
    const response = await route.fetch()
    await response.body()
    await route.abort('connectionreset')
  })

  await page.getByRole('button', { name: '新增账户' }).click()
  await expect(page.getByTestId('ledger-account-form')).toBeVisible()
  await page.locator('#ledger-account-card-number').fill('6222021234567890')
  await page.locator('#ledger-account-name').fill(uniqueName)
  await page.getByRole('button', { name: '创建' }).click()

  await expect(page.getByTestId('ledger-recovery')).toBeVisible()
  expect(droppedKey).not.toBe('')
  expect(droppedPayload).toContain(uniqueName)
  await page.reload()
  await expect(page.getByTestId('ledger-recovery')).toBeVisible()
  await page.getByRole('button', { name: '用同一内容重试' }).click()

  await expect(page.getByTestId('ledger-accounts-page')).toBeVisible()
  await expect(page.getByTestId('ledger-recovery')).toBeHidden()
  await expect.poll(async () => (await getAccounts(request)).filter((account) => account.name === uniqueName).length).toBe(1)
  expect(await page.evaluate(() => sessionStorage.getItem('nuvyn.ledger.pending-create'))).toBeNull()
})

test('Ledger transaction entry remains keyboard-usable in a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 844 })
  await page.goto('/ledger')
  await expect(page.getByTestId('ledger-dashboard')).toBeVisible()
  await expect(page.getByTestId('ledger-dashboard-account-viewport')).toBeVisible()
  await expect(page.getByTestId('ledger-dashboard-assets-viewport')).toBeVisible()
  await expect(page.getByTestId('ledger-cashflow-trend-canvas')).toBeVisible()

  // A canvas chart is easy to let escape its column. Measure real scrollable
  // overflow rather than layout boxes, so the clipped screen-reader table does
  // not read as a false positive. The site header overflows this viewport on
  // its own, so the guard is scoped to the Dashboard subtree.
  const dashboardWidth = await page.evaluate(() => {
    const dashboard = document.querySelector('[data-testid="ledger-dashboard"]')
    if (dashboard === null) return null
    return { scroll: dashboard.scrollWidth, client: dashboard.clientWidth }
  })
  expect(dashboardWidth).not.toBeNull()
  expect(dashboardWidth!.scroll).toBeLessThanOrEqual(dashboardWidth!.client)

  const recordButton = page.getByTestId('ledger-record-button')
  await recordButton.focus()
  await expect(recordButton).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.locator('#ledger-transaction-amount')).toBeFocused()

  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeHidden()
})

test('historical period navigation keeps the route anchor while period cards refresh independently', async ({ page, request }) => {
  const fixtures = await ensurePeriodNavigationFixtures(request)
  const today = Temporal.Now.plainDateISO(fixtures.timezone)
  const anchor = today.with({ day: 1 }).subtract({ months: 1 }).add({ days: 10 })
  const afterAnchor = anchor.add({ days: 3 })
  const laterDate = anchor.add({ days: 5 })
  const atLedgerNoon = (date: Temporal.PlainDate): number => date.toZonedDateTime({
    timeZone: fixtures.timezone,
    plainTime: Temporal.PlainTime.from('12:00'),
  }).toInstant().epochMilliseconds
  const anchorDate = anchor.toString()
  const afterAnchorDate = afterAnchor.toString()
  const laterDateValue = laterDate.toString()
  const anchorPayee = `期间锚点-${Date.now()}`
  const afterAnchorPayee = `锚点之后-${Date.now()}`
  const createAccount = await request.post('/api/ledger/accounts', {
    data: {
      name: `历史期间账户-${Date.now()}`,
      type: 'bank',
      nature: 'asset',
      openingBalanceMinor: 0,
      openingDate: anchorDate,
      currency: fixtures.currency,
      note: '',
    },
    headers: { 'Idempotency-Key': `period-account-${anchorDate}-${Date.now()}` },
  })
  expect(createAccount.status()).toBe(201)
  const account = await createAccount.json() as { id: string }

  await createPeriodExpense(request, {
    accountId: account.id,
    categoryId: fixtures.categoryId,
    amountMinor: 4100,
    occurredAt: atLedgerNoon(anchor),
    payee: anchorPayee,
    key: `period-anchor-${anchorDate}-${Date.now()}`,
  })
  await createPeriodExpense(request, {
    accountId: account.id,
    categoryId: fixtures.categoryId,
    amountMinor: 7300,
    occurredAt: atLedgerNoon(afterAnchor),
    payee: afterAnchorPayee,
    key: `period-after-${afterAnchorDate}-${Date.now()}`,
  })

  await page.goto(`/ledger?date=${anchorDate}`)
  await expect(page).toHaveURL(new RegExp(`/ledger\\?date=${anchorDate}$`))
  await expect(page.getByTestId('ledger-dashboard')).toBeVisible()
  await expect(page.getByRole('heading', { name: '所在月收支' })).toBeVisible()
  await expect(ledgerDateInput(page, 'ledger-period-date')).toHaveValue(anchorDate)
  await expect(page.getByTestId('ledger-period-month')).toContainText(`${anchor.year}-${String(anchor.month).padStart(2, '0')}`)
  await expect(page.getByTestId('ledger-period-month')).toContainText('¥114.00')
  await expect(page.getByTestId('ledger-recent-transactions')).toContainText(anchorPayee)
  await expect(page.getByTestId('ledger-recent-transactions')).not.toContainText(afterAnchorPayee)
  await expect(page.getByTestId('ledger-return-today')).toHaveCount(0)

  // The trend follows the same anchor as the rest of the Overview: twelve
  // months ending with the anchor month, so the current month is outside the window.
  const trendRows = page.getByTestId('ledger-cashflow-trend-table').locator('tbody tr')
  await expect(page.getByTestId('ledger-cashflow-trend-canvas')).toBeVisible()
  await expect(trendRows).toHaveCount(12)
  await expect(trendRows.last()).toContainText(`${anchor.year}年${anchor.month}月`)
  await expect(page.getByTestId('ledger-cashflow-trend-table')).not.toContainText(`${today.year}年${today.month}月`)

  await page.reload()
  await expect(page).toHaveURL(new RegExp(`/ledger\\?date=${anchorDate}$`))
  await expect(ledgerDateInput(page, 'ledger-period-date')).toHaveValue(anchorDate)
  await expect(page.getByTestId('ledger-period-month')).toContainText('¥114.00')
  await expect(page.getByTestId('ledger-recent-transactions')).not.toContainText(afterAnchorPayee)

  const periodDate = ledgerDateInput(page, 'ledger-period-date')
  await page.getByTestId('ledger-period-date-control-today').hover()
  await periodDate.fill(laterDateValue)
  await periodDate.press('Tab')
  await expect(page).toHaveURL(new RegExp(`/ledger\\?date=${anchorDate}$`))
  await expect(ledgerDateInput(page, 'ledger-period-date')).toHaveValue(laterDateValue)
  await expect(page.getByTestId('ledger-recent-transactions')).not.toContainText(afterAnchorPayee)

  await page.getByTestId('ledger-period-date-control-today').hover()
  await periodDate.fill(today.toString())
  await periodDate.press('Tab')
  await expect(page).toHaveURL(new RegExp(`/ledger\\?date=${anchorDate}$`))
  await expect(page.getByTestId('ledger-return-today')).toHaveCount(0)
  await expect(page.getByTestId('ledger-cashflow-trend-canvas')).toBeVisible()
  await expect(trendRows.last()).toContainText(`${anchor.year}年${anchor.month}月`)
})

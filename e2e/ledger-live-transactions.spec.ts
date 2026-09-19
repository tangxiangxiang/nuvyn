import { expect, test } from './fixtures/auth'
import {
  ensureLedgerDashboardFixtures,
  getAccounts,
  getTransactions,
  ledgerDateInput,
  selectOptionContaining,
} from './helpers/ledger-live'
import { Temporal } from '@js-temporal/polyfill'

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

test.describe(() => {
  test.beforeEach(async ({ request }) => {
    await ensureLedgerDashboardFixtures(request)
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
})

import { expect, test } from './fixtures/auth'
import { Temporal } from '@js-temporal/polyfill'
import {
  createPeriodExpense,
  ensureLedgerDashboardFixtures,
  ensurePeriodNavigationFixtures,
  ledgerDateInput,
} from './helpers/ledger-live'

test.beforeEach(async ({ request }) => {
  await ensureLedgerDashboardFixtures(request)
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
  await expect(page.getByRole('heading', { name: '所在月概览' })).toBeVisible()
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

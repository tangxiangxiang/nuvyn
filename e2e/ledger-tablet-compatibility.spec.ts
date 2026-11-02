import { expect, test } from './fixtures/auth'
import { ensureLedgerDashboardFixtures, ensurePeriodNavigationFixtures, createPeriodExpense, getAccounts } from './helpers/ledger-live'

test.use({ hasTouch: true })

const viewports = [
  { width: 601, height: 962 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1024, height: 600 },
  { width: 1180, height: 820 },
]

test('tablet Ledger pages keep navigation, table rows and pagination inside their viewport', async ({ page, request }) => {
  await ensureLedgerDashboardFixtures(request)
  const account = (await getAccounts(request)).find((item) => item.archivedAt === null)!
  const { categoryId } = await ensurePeriodNavigationFixtures(request)
  for (let index = 0; index < 8; index++) {
    await createPeriodExpense(request, {
      accountId: account.id, categoryId, amountMinor: 12345, occurredAt: Date.now(),
      payee: 'Tablet audit', key: `tablet-audit-${Date.now()}-${index}`,
    })
  }
  for (const viewport of viewports) {
    await page.setViewportSize(viewport)
    for (const route of ['/ledger', '/ledger/accounts', `/ledger/accounts/${account.id}`, '/ledger/transactions']) {
      await page.goto(route)
      await expect(page.locator('main.ledger-page')).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `${route} at ${viewport.width}x${viewport.height}`).toBeLessThanOrEqual(1)
      const navbar = (await page.locator('.navbar').boundingBox())!
      expect(navbar.x + navbar.width).toBeLessThanOrEqual(viewport.width + 1)
      if (route === '/ledger/transactions') {
        await expect(page.getByTestId('ledger-transaction-list')).toBeVisible()
        const body = (await page.locator('.n-data-table-base-table-body').boundingBox())!
        expect(body.height, `${viewport.width}x${viewport.height} usable transaction body`).toBeGreaterThan(60)
        const pagination = (await page.locator('.ledger-transaction-pagination').boundingBox())!
        if (viewport.width >= 651) expect(pagination.y + pagination.height).toBeLessThanOrEqual(viewport.height + 1)
      }
    }
  }
})

test('tablet touch controls remain hidden at rest and accessible by tapping', async ({ page, request }) => {
  await ensureLedgerDashboardFixtures(request)
  const account = (await getAccounts(request)).find((item) => item.archivedAt === null)!
  await page.setViewportSize({ width: 768, height: 1024 })
  await page.goto('/ledger')

  const heading = page.getByTestId('ledger-dashboard').locator('h1')
  for (const period of ['today', 'week', 'month', 'year']) {
    const control = page.getByTestId(`ledger-period-date-control-${period}`)
    await expect(control.locator('.ledger-period-date-label')).toHaveCSS('visibility', 'visible')
    await expect(control.locator('.ledger-period-date-editor')).toHaveCSS('opacity', '0')
    await expect(control.locator('.ledger-period-date-editor')).toHaveCSS('pointer-events', 'auto')
  }
  const date = page.getByTestId('ledger-period-date-control-today').locator('.ledger-period-date-editor')
  await date.locator('input').tap()
  await expect(date).toHaveCSS('opacity', '1')
  await expect(page.locator('.n-date-panel').first()).toBeVisible()
  await heading.tap()
  await expect(date).toHaveCSS('opacity', '0')

  for (const [selector, triggerSelector] of [
    ['.ledger-period-scope', '.n-base-selection'],
    ['.ledger-category-scope', '.n-base-selection'],
    ['.ledger-category-date', 'input'],
    ['.ledger-trend-date', 'input'],
  ] as const) {
    const control = page.locator(selector).first()
    await expect(control).toHaveCSS('opacity', '0')
    await expect(control).toHaveCSS('pointer-events', 'auto')
    await control.locator(triggerSelector).tap()
    await expect(control).toHaveCSS('opacity', '1')
    await heading.tap()
    await expect(control).toHaveCSS('opacity', '0')
  }

  await page.goto('/ledger/accounts')
  const filter = page.locator('.ledger-account-type-filter').first()
  await expect(filter).toHaveCSS('opacity', '0')
  await filter.locator('.n-base-selection').tap()
  await expect(filter).toHaveCSS('opacity', '1')

  await page.goto(`/ledger/accounts/${account.id}`)
  const trendRange = page.locator('.ledger-trend-range')
  await expect(trendRange).toHaveCSS('visibility', 'visible')
  await expect(trendRange).toHaveCSS('opacity', '0')
  const trend = trendRange.locator('.n-base-selection')
  await trend.tap()
  await expect(trendRange).toHaveCSS('opacity', '1')
  const week = page.locator('.n-base-select-option').filter({ hasText: '近7天' })
  await expect(week).toBeVisible()
  await week.tap()
  await expect(trend).toContainText('近7天')
})

test('tablet creation, transaction details and account editing remain within portrait and short landscape viewports', async ({ page, request }) => {
  await ensureLedgerDashboardFixtures(request)
  const account = (await getAccounts(request)).find((item) => item.archivedAt === null)!
  for (const viewport of [{ width: 768, height: 1024 }, { width: 1024, height: 600 }]) {
    await page.setViewportSize(viewport)
    await page.goto('/ledger')
    await page.getByTestId('ledger-record-button').tap()
    const create = page.getByTestId('ledger-transaction-sheet')
    await expect(create).toBeVisible()
    const createBox = (await create.boundingBox())!
    expect(createBox.x).toBeGreaterThanOrEqual(0)
    expect(createBox.y).toBeGreaterThanOrEqual(0)
    expect(createBox.y + createBox.height).toBeLessThanOrEqual(viewport.height + 1)
    const cancel = create.getByRole('button', { name: '取消', exact: true })
    await cancel.scrollIntoViewIfNeeded()
    await cancel.tap()
    await expect(create).toBeHidden()

    await page.goto('/ledger/transactions')
    await page.locator('.ledger-transaction-row').first().tap()
    const detail = page.getByTestId('ledger-transaction-detail-sheet')
    await expect(detail).toBeVisible()
    const detailBox = (await detail.boundingBox())!
    expect(detailBox.x).toBeGreaterThanOrEqual(0)
    expect(detailBox.y).toBeGreaterThanOrEqual(0)
    expect(detailBox.y + detailBox.height).toBeLessThanOrEqual(viewport.height + 1)

    await page.goto(`/ledger/accounts/${account.id}`)
    await page.getByRole('button', { name: '编辑账户', exact: true }).tap()
    const edit = page.locator('.ledger-account-edit-modal-card')
    await expect(edit).toBeVisible()
    const editBox = (await edit.boundingBox())!
    expect(editBox.x).toBeGreaterThanOrEqual(0)
    expect(editBox.y).toBeGreaterThanOrEqual(0)
    expect(editBox.y + editBox.height).toBeLessThanOrEqual(viewport.height + 1)
    const cancelEdit = edit.getByRole('button', { name: '取消', exact: true })
    await cancelEdit.scrollIntoViewIfNeeded()
    await cancelEdit.tap()
    await expect(edit).toBeHidden()
  }
})

import { Temporal } from '@js-temporal/polyfill'
import { expect, test } from './fixtures/auth'
import { getTransactions, ledgerDateInput, selectOptionContaining } from './helpers/ledger-live'

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
  await expect(page.getByRole('heading', { name: '本月概览' })).toBeVisible()
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
  await expect(page.getByTestId('ledger-dashboard-assets-viewport')).toHaveCSS('scrollbar-gutter', 'stable')
  await expect(page.locator('[data-testid="ledger-dashboard-assets"] h3')).toHaveCSS('scrollbar-gutter', 'stable')
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
  await expect(page.locator('.ledger-breakdown-list-viewport')).toHaveCount(1)
  await expect(page.locator('.ledger-breakdown-list-viewport')).toHaveCSS('max-height', '280px')
  await expect(page.locator('.ledger-breakdown-list-viewport')).toHaveCSS('overflow-y', 'auto')
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

  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  await expect(page.getByTestId('ledger-dashboard')).toBeVisible()
  const mobileListMetrics = await page.locator(
    '.ledger-dashboard-account-list-viewport, .ledger-breakdown-list-viewport',
  ).evaluateAll((elements) => elements.map((element) => {
    const style = getComputedStyle(element)
    return {
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      maxHeight: style.maxHeight,
      overflowY: style.overflowY,
    }
  }))
  expect(mobileListMetrics.length).toBeGreaterThan(0)
  for (const metrics of mobileListMetrics) {
    expect(metrics.maxHeight).toBe('none')
    expect(metrics.overflowY).toBe('visible')
    expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.clientHeight)
  }

  for (const width of [320, 375, 390, 430, 440, 441, 600, 760, 761, 1280]) {
    await page.setViewportSize({ width, height: 844 })
    await page.locator('.ledger-period-scope').hover()
    await expect(page.locator('.ledger-period-scope')).toHaveCSS('opacity', '1')
    const alignment = await page.locator('.ledger-period-toolbar').evaluate((toolbar) => {
      const heading = toolbar.closest<HTMLElement>('.ledger-period-heading')
      const title = heading?.querySelector<HTMLElement>('h2')
      const selection = toolbar.querySelector<HTMLElement>('.ledger-period-scope .n-base-selection')
      if (!heading || !title || !selection) throw new Error('收支期间标题或选择器不存在')

      const titleRect = title.getBoundingClientRect()
      const selectionRect = selection.getBoundingClientRect()

      return {
        headingRight: heading.getBoundingClientRect().right,
        toolbarRight: toolbar.getBoundingClientRect().right,
        selectionRight: selectionRect.right,
        titleBeforeSelection: titleRect.right <= selectionRect.left,
        sameRow: titleRect.top < selectionRect.bottom && selectionRect.top < titleRect.bottom,
      }
    })
    expect(Math.abs(alignment.toolbarRight - alignment.selectionRight), `${width}px selector right edge`)
      .toBeLessThanOrEqual(1)
    expect(Math.abs(alignment.headingRight - alignment.selectionRight), `${width}px selector aligned to heading right`)
      .toBeLessThanOrEqual(1)
    expect(alignment.titleBeforeSelection, `${width}px title and selector do not overlap`).toBe(true)
    expect(alignment.sameRow, `${width}px title and selector share one row`).toBe(true)
  }
})

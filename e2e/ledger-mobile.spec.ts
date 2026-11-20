import { expect, test } from './fixtures/auth'
import { ensureLedgerDashboardFixtures, ensurePeriodNavigationFixtures } from './helpers/ledger-live'

const phoneViewports = [
  { width: 320, height: 700 },
  { width: 360, height: 800 },
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 430, height: 844 },
  { width: 600, height: 844 },
]

test.use({ hasTouch: true })

test('mobile account and category selectors open on touch and retain selected IDs', async ({ page, request }) => {
  await ensureLedgerDashboardFixtures(request)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/ledger')
  await page.getByTestId('ledger-record-button').tap()

  const sheet = page.getByTestId('ledger-transaction-sheet')
  const account = sheet.getByRole('combobox', { name: '账户' })
  await account.click()
  const accountDialog = page.getByRole('dialog', { name: '选择账户' })
  await expect(accountDialog).toBeVisible()
  await expect(accountDialog.locator('.ledger-option-picker-option').first()).toContainText('¥')
  const accountOption = accountDialog.locator('.ledger-option-picker-option').first()
  const accountId = await accountOption.getAttribute('data-ledger-option')
  expect(accountId).toBeTruthy()
  await accountOption.tap()
  await expect(accountDialog).toBeHidden()

  await account.tap()
  await expect(accountDialog.locator(`[data-ledger-option="${accountId}"]`)).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Escape')
  await expect(accountDialog).toBeHidden()

  await account.tap()
  await expect(accountDialog.locator(`[data-ledger-option="${accountId}"]`)).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('button', { name: '关闭账户选择' }).tap()

  const category = sheet.getByRole('combobox', { name: '分类' })
  await category.tap()
  const categoryDialog = page.getByRole('dialog', { name: '选择分类' })
  await expect(categoryDialog).toBeVisible()
  const categoryOption = categoryDialog.locator('.ledger-option-picker-option').first()
  const categoryId = await categoryOption.getAttribute('data-ledger-option')
  expect(categoryId).toBeTruthy()
  await categoryOption.tap()
  await expect(categoryDialog).toBeHidden()
  await category.tap()
  await expect(categoryDialog.locator(`[data-ledger-option="${categoryId}"]`)).toHaveAttribute('aria-selected', 'true')
})

test('phone history shows the category label and source account for each transfer kind', async ({ page, request }) => {
  await ensureLedgerDashboardFixtures(request)
  const { currency } = await ensurePeriodNavigationFixtures(request)
  const id = crypto.randomUUID()
  const [bank, wallet, credit] = await Promise.all([
    { type: 'bank', nature: 'asset' },
    { type: 'wallet', nature: 'asset' },
    { type: 'credit_card', nature: 'liability' },
  ].map(async (account) => {
    const name = `${account.type}-${id}`
    const response = await request.post('/api/ledger/accounts', {
      data: { ...account, name, openingBalanceMinor: 0, openingDate: '2026-01-01', currency, note: '' },
      headers: { 'Idempotency-Key': `mobile-transfer-account-${account.type}-${id}` },
    })
    expect(response.status(), await response.text()).toBe(201)
    return { id: (await response.json() as { id: string }).id, name }
  }))

  await page.setViewportSize(phoneViewports[0]!)
  const transfers = []
  for (const [transferKind, label, from, to] of [
    ['general', '转账', bank, wallet],
    ['repayment', '还款', bank, credit],
    ['withdrawal', '提现', wallet, bank],
  ] as const) {
    const response = await request.post('/api/ledger/transactions', {
      data: { type: 'transfer', transferKind, fromAccountId: from.id, toAccountId: to.id, amountMinor: 100, occurredAt: Date.now(), payee: '', note: '' },
      headers: { 'Idempotency-Key': `mobile-transfer-${transferKind}-${id}` },
    })
    expect(response.status(), await response.text()).toBe(201)
    transfers.push({ id: (await response.json() as { id: string }).id, label, sourceName: from.name })
  }
  await page.goto('/ledger/transactions')
  const list = page.getByTestId('ledger-compact-transaction-list')
  for (const transfer of transfers) {
    const row = list.getByTestId(`ledger-transaction-row-${transfer.id}`)
    await expect(row.locator('.ledger-phone-transaction-category')).toHaveText(transfer.label)
    await expect(row.locator('.ledger-phone-transaction-account')).toHaveText(`· ${transfer.sourceName}`)
  }
})

test('phone history fits long names and can exclude and restore statistics from the detail sheet', async ({ page, request }) => {
  await ensureLedgerDashboardFixtures(request)
  const { categoryId, timezone } = await ensurePeriodNavigationFixtures(request)
  const categories = await (await request.get('/api/ledger/categories?kind=expense')).json() as { id: string; name: string }[]
  const category = categories.find((item) => item.id === categoryId)!
  const id = crypto.randomUUID()
  const longAccount = '这是一条很长的银行卡账户名称'.repeat(4)
  const longPayee = '这是一条很长的交易对象名称'.repeat(4)
  const account = await request.post('/api/ledger/accounts', {
    data: { name: longAccount, type: 'bank', nature: 'asset', openingBalanceMinor: 0, openingDate: '2026-01-01', currency: 'CNY', note: '' },
    headers: { 'Idempotency-Key': `mobile-account-${id}` },
  })
  expect(account.status(), await account.text()).toBe(201)
  const occurredAt = Date.now()
  const created = await request.post('/api/ledger/transactions', {
    data: { type: 'expense', accountId: (await account.json()).id, categoryId, amountMinor: 3500, occurredAt, payee: longPayee, note: '' },
    headers: { 'Idempotency-Key': `mobile-expense-${id}` },
  })
  expect(created.status(), await created.text()).toBe(201)
  const transaction = await created.json() as { id: string }
  await page.setViewportSize(phoneViewports[3]!)
  await page.goto('/ledger/transactions')
  const compact = page.getByTestId('ledger-compact-transaction-list')
  const row = compact.getByTestId(`ledger-transaction-row-${transaction.id}`)
  const timestamp = row.locator('time')
  const categoryLabel = row.locator('.ledger-phone-transaction-category')
  const expectedTime = new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone,
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(occurredAt).replaceAll('-', '/')
  await expect(row).toContainText(longPayee)
  await expect(row).toContainText(longAccount)
  await expect(categoryLabel).toHaveText(category.name)
  await expect(row.locator('.ledger-transaction-type')).toHaveCount(0)
  await expect(timestamp).toHaveText(expectedTime)
  for (const viewport of phoneViewports) {
    await page.setViewportSize(viewport)
    const filters = page.getByTestId('ledger-filters-form').getByRole('combobox')
    await expect(filters).toHaveCount(3)
    const bounds = await filters.evaluateAll((controls) => controls.map((control) => {
      const { x, y, right } = control.getBoundingClientRect()
      return { x, y, right }
    }))
    expect(bounds.map(({ y }) => y)).toEqual([bounds[0]!.y, bounds[0]!.y, bounds[0]!.y])
    expect(bounds[0]!.right).toBeLessThan(bounds[1]!.x)
    expect(bounds[1]!.right).toBeLessThan(bounds[2]!.x)
    expect(bounds[2]!.right).toBeLessThanOrEqual(viewport.width)
    await expect(compact).toBeVisible()
    await expect(page.getByTestId('ledger-transaction-list')).toHaveCount(0)
    const amount = (await row.locator('.ledger-transaction-amount').boundingBox())!
    expect(amount.x + amount.width).toBeLessThanOrEqual(viewport.width)
    expect(await categoryLabel.evaluate((element) => element.getBoundingClientRect().right)).toBeLessThan(
      await timestamp.evaluate((element) => element.getBoundingClientRect().left),
    )
    expect(await timestamp.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    expect(await row.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
  }

  const accountFilter = page.getByRole('combobox', { name: '账户', exact: true })
  for (const viewport of [phoneViewports[0]!, phoneViewports[4]!]) {
    await page.setViewportSize(viewport)
    await accountFilter.tap()
    const option = page.getByRole('option').filter({ hasText: longAccount })
    const label = option.locator('.ledger-account-select-label')
    const balance = option.locator('.ledger-account-select-balance')
    await expect(label).toBeVisible()
    await expect(balance).toBeVisible()
    const menu = page.locator('.n-base-select-menu').filter({ has: option })
    const menuBounds = (await menu.boundingBox())!
    const filterBounds = (await accountFilter.boundingBox())!
    expect(menuBounds.width).toBeGreaterThan(filterBounds.width)
    expect(menuBounds.x).toBeGreaterThanOrEqual(0)
    expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(viewport.width)
    expect((await label.boundingBox())!.width).toBeGreaterThanOrEqual(80)
    expect(await balance.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    await option.tap()
    await expect(accountFilter).toContainText(longAccount)
    await accountFilter.tap()
    await page.getByRole('option', { name: '全部账户' }).tap()
    await expect(accountFilter).toContainText('全部账户')
  }

  await page.setViewportSize(phoneViewports[3]!)
  const sortButton = page.getByRole('button', { name: '交易排序' })
  const sortMenu = page.getByRole('menu', { name: '交易排序' })
  await expect(sortButton).toHaveText('')
  await expect(sortButton).toHaveAttribute('aria-expanded', 'false')
  await expect(sortMenu).toBeHidden()
  await sortButton.tap()
  await expect(sortButton).toHaveAttribute('aria-expanded', 'true')
  await expect(sortMenu.getByRole('menuitemradio')).toHaveCount(4)
  await expect(sortMenu.getByRole('menuitemradio', { name: '时间从新到旧' })).toBeChecked()
  const sorted = page.waitForRequest((req) => {
    const url = new URL(req.url())
    return url.pathname === '/api/ledger/transactions'
      && url.searchParams.get('sortBy') === 'amount' && url.searchParams.get('sortDirection') === 'asc'
  })
  await sortMenu.getByRole('menuitemradio', { name: '金额从低到高' }).tap()
  await sorted
  await expect(sortMenu).toBeHidden()
  await sortButton.tap()
  await expect(sortMenu.getByRole('menuitemradio', { name: '金额从低到高' })).toBeChecked()
  await sortButton.press('Escape')
  await expect(sortMenu).toBeHidden()
  await page.getByRole('tab', { name: '支出', exact: true }).tap()
  await page.getByRole('textbox', { name: '搜索交易' }).fill(longPayee)
  await expect(compact.locator('li')).toHaveCount(1)
  await expect(page.locator('.ledger-history-summary')).toContainText('支出 ¥35')
  await row.tap()
  const detail = page.getByTestId('ledger-transaction-detail-sheet')
  const failExclusion = (route: import('@playwright/test').Route) => route.fulfill({
    status: 503,
    json: { error: 'busy', code: 'ledger-write-busy' },
  })
  const exclusionUrl = `**/api/ledger/transactions/${transaction.id}/statistics-exclusion`
  await page.route(exclusionUrl, failExclusion)
  await detail.getByRole('button', { name: '不计入统计', exact: true }).tap()
  await expect(detail.getByRole('alert')).toBeVisible()
  await expect(row).not.toHaveClass(/is-statistics-excluded/)
  await page.unroute(exclusionUrl, failExclusion)
  await detail.getByRole('button', { name: '不计入统计', exact: true }).tap()
  await expect(detail.getByTestId('ledger-statistics-exclusion-hint')).toBeVisible()
  await expect(row).toHaveClass(/is-statistics-excluded/)
  await expect(page.locator('.ledger-history-summary')).toContainText('支出 ¥0')
  await detail.getByRole('button', { name: '关闭交易详情' }).tap()
  await row.press('Space')
  await detail.getByRole('button', { name: '恢复计入统计', exact: true }).tap()
  await expect(detail.getByTestId('ledger-statistics-exclusion-hint')).toHaveCount(0)
  await expect(row).not.toHaveClass(/is-statistics-excluded/)

  for (const viewport of [{ width: 601, height: 962 }, { width: 768, height: 1024 }, { width: 1024, height: 600 }, { width: 1180, height: 820 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(viewport)
    await page.goto('/ledger/transactions')
    await expect(page.getByTestId('ledger-transaction-list')).toBeVisible()
    await expect(compact).toHaveCount(0)
    await expect(sortButton).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
  }
})

test('the create sheet focuses amount only on wider screens', async ({ page, request }) => {
  await ensureLedgerDashboardFixtures(request)
  const sheet = page.getByTestId('ledger-transaction-sheet')
  const amount = sheet.locator('input[name="amount"]')
  for (const width of [390, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 })
    await page.goto('/ledger')
    await page.getByTestId('ledger-record-button').tap()
    await expect(sheet).toBeVisible()
    if (width > 600) {
      await expect(amount).toBeFocused()
      continue
    }
    await expect(sheet).toHaveCSS('opacity', '1')
    await expect(amount).not.toBeFocused()
    await amount.tap()
    await amount.fill('12.50')
    await expect(amount).toHaveValue('12.50')
    const save = sheet.getByRole('button', { name: '保存', exact: true })
    const cancel = sheet.getByRole('button', { name: '取消', exact: true })
    await save.tap({ trial: true })
    await cancel.tap({ trial: true })
  }
})

const dateTimeViewports = [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 844, height: 390 },
  { width: 768, height: 1024 },
  { width: 1024, height: 650 },
  { width: 1440, height: 700 },
]

for (const viewport of dateTimeViewports) {
  test(`DateTime dialog stays usable at ${viewport.width}×${viewport.height}`, async ({ page, request }) => {
    await ensureLedgerDashboardFixtures(request)
    await page.setViewportSize(viewport)
    await page.goto('/ledger')
    await page.getByTestId('ledger-record-button').tap()
    const sheet = page.getByTestId('ledger-transaction-sheet')
    const trigger = sheet.getByTestId('ledger-transaction-occurred-at').locator('input')
    const openDateTime = sheet.getByRole('button', { name: '选择发生时间' })
    const initial = await trigger.inputValue()
    await openDateTime.tap()
    const dialog = page.getByRole('dialog', { name: '发生时间' })
    const panel = dialog.locator('.n-date-panel')
    await expect(dialog).toBeVisible()
    const bounds = (await dialog.boundingBox())!
    expect(bounds.x).toBeGreaterThanOrEqual(-1)
    expect(bounds.y).toBeGreaterThanOrEqual(-1)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1)
    // The outer panel can fit while Naive UI's intrinsic grid track still
    // squeezes the calendar and its inputs into the left side.
    const calendarLayout = await panel.evaluate(element => {
      const header = element.querySelector('.n-date-panel-header')!
      const calendar = element.querySelector('.n-date-panel-calendar')!
      const days = element.querySelector('.n-date-panel-dates')!
      const month = element.querySelector('.n-date-panel-month')!
      const title = element.querySelector('.n-date-panel-month__text')!
      const range = document.createRange()
      range.selectNodeContents(title)
      const titleText = range.getBoundingClientRect()
      const monthBounds = month.getBoundingClientRect()
      const calendarStyle = getComputedStyle(calendar)
      const dateInput = element.querySelector<HTMLInputElement>('.n-date-panel-date-input input')!
      const dateStyle = getComputedStyle(dateInput)
      const textMeasure = document.createElement('canvas').getContext('2d')!
      textMeasure.font = dateStyle.font
      return {
        unusedHeaderWidth: element.clientWidth - header.clientWidth,
        unusedGridWidth: calendar.clientWidth - parseFloat(calendarStyle.paddingLeft)
          - parseFloat(calendarStyle.paddingRight) - days.clientWidth,
        titleWithinMonthRow: titleText.top >= monthBounds.top && titleText.bottom <= monthBounds.bottom,
        dateInputFits: textMeasure.measureText(dateInput.value).width <= dateInput.clientWidth
          - parseFloat(dateStyle.paddingLeft) - parseFloat(dateStyle.paddingRight),
      }
    })
    expect(calendarLayout.unusedHeaderWidth).toBeLessThanOrEqual(1)
    expect(calendarLayout.unusedGridWidth).toBeLessThanOrEqual(1)
    expect(calendarLayout.titleWithinMonthRow).toBe(true)
    expect(calendarLayout.dateInputFits).toBe(true)
    await panel.locator('.n-date-panel-date:not(.n-date-panel-date--excluded):not(.n-date-panel-date--selected) .n-date-panel-date__trigger').first().tap()
    await dialog.getByRole('button', { name: '取消' }).tap()
    await expect(dialog).toBeHidden()
    await expect(trigger).toHaveValue(initial)
    await openDateTime.tap()
    await panel.locator('.n-date-panel-date:not(.n-date-panel-date--excluded):not(.n-date-panel-date--selected) .n-date-panel-date__trigger').first().tap()
    const dateInput = panel.locator('.n-date-panel-date-input input')
    await expect(dateInput).not.toHaveValue(initial.slice(0, 10))
    const timeInput = panel.getByRole('textbox', { name: 'Select Time' })
    await timeInput.tap()
    const timePanel = panel.locator('.n-time-picker-panel')
    await expect(timePanel).toBeVisible()
    await expect(timePanel).not.toHaveClass(/fade-in-scale-up-transition-enter-active/)
    const hour = initial.slice(11, 13) === '08' ? '09' : '08'
    const hourColumn = timePanel.locator('.n-time-picker-cols > .n-time-picker-col').first()
    await hourColumn.getByText(hour, { exact: true }).tap()
    await expect(timeInput).toHaveValue(new RegExp(`^${hour}:`))
    await expect(trigger).toHaveValue(initial)
    await dialog.getByRole('button', { name: '确认' }).tap()
    await expect(dialog).toBeHidden()
    const selected = await trigger.inputValue()
    expect(selected.slice(0, 10)).not.toBe(initial.slice(0, 10))
    expect(selected.slice(11, 13)).toBe(hour)
    await sheet.locator('textarea[name="note"]').tap()
    await sheet.getByRole('button', { name: '保存', exact: true }).tap({ trial: true })
    await sheet.getByRole('button', { name: '取消', exact: true }).tap({ trial: true })
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
  })
}

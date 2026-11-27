import { Temporal } from '@js-temporal/polyfill'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures/auth'
import { ensureLedgerDashboardFixtures, getTransactions, ledgerDateInput, selectOptionContaining } from './helpers/ledger-live'

type LedgerModuleLabelStyle = {
  color: string
  fontSize: string
  fontWeight: string
  letterSpacing: string
  marginBottom: string
  textTransform: string
}

const expectedModuleLabelStyleByTheme: Record<'light' | 'dark', LedgerModuleLabelStyle> = {
  light: {
    color: 'rgb(99, 102, 241)',
    fontSize: '11.2px',
    fontWeight: '750',
    letterSpacing: '1.12px',
    marginBottom: '7px',
    textTransform: 'uppercase',
  },
  dark: {
    color: 'rgb(129, 140, 248)',
    fontSize: '11.2px',
    fontWeight: '750',
    letterSpacing: '1.12px',
    marginBottom: '7px',
    textTransform: 'uppercase',
  },
}

const moduleLabelViewports = [
  { width: 1280, height: 900 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
]

test.describe.configure({ mode: 'serial' })

async function applyTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  const html = page.locator('html')
  await expect(html).toHaveAttribute('data-theme', /^(light|dark)$/)
  if (await html.getAttribute('data-theme') !== theme) {
    await page.locator('.theme-toggle').click()
  }
  await expect(html).toHaveAttribute('data-theme', theme)
}

async function readModuleLabelStyle(
  page: Page,
  theme: 'light' | 'dark',
  expectedCount: number,
): Promise<LedgerModuleLabelStyle> {
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
  const labels = page.getByTestId('ledger-module-label')
  await expect(labels).toHaveCount(expectedCount)
  await expect(labels.first()).toBeVisible()

  const styles = await labels.evaluateAll((elements) => elements.map((element) => {
    const style = getComputedStyle(element)
    return {
      text: element.textContent?.trim() ?? '',
      color: style.color,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      letterSpacing: style.letterSpacing,
      marginBottom: style.marginBottom,
      textTransform: style.textTransform,
    }
  }))
  const [first, ...remaining] = styles
  if (!first) throw new Error('Ledger module label is missing')
  expect(first).toMatchObject({
    text: 'LEDGER',
    ...expectedModuleLabelStyleByTheme[theme],
  })
  for (const style of remaining) expect(style).toEqual(first)

  const colorMatchesAccent = await labels.evaluateAll((elements) => {
    const probe = document.createElement('span')
    probe.style.color = 'var(--accent)'
    document.body.append(probe)
    const accent = getComputedStyle(probe).color
    probe.remove()
    return elements.every((element) => getComputedStyle(element).color === accent)
  })
  expect(colorMatchesAccent).toBe(true)

  return {
    color: first.color,
    fontSize: first.fontSize,
    fontWeight: first.fontWeight,
    letterSpacing: first.letterSpacing,
    marginBottom: first.marginBottom,
    textTransform: first.textTransform,
  }
}

async function verifyModuleLabelsAcrossViewports(
  page: Page,
  theme: 'light' | 'dark',
  expectedCount: number,
): Promise<LedgerModuleLabelStyle> {
  let expectedStyle: LedgerModuleLabelStyle | null = null
  for (const viewport of moduleLabelViewports) {
    await page.setViewportSize(viewport)
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    const style = await readModuleLabelStyle(page, theme, expectedCount)
    if (expectedStyle) expect(style).toEqual(expectedStyle)
    else expectedStyle = style
  }
  if (!expectedStyle) throw new Error(`No module label styles were measured for ${theme}`)
  return expectedStyle
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
  await expect(page.getByTestId('ledger-onboarding')).toBeVisible()
  await expect(page.getByTestId('ledger-settings-form')).toBeVisible()
  await expect(page.getByTestId('ledger-onboarding').locator('> .ledger-onboarding-heading [data-testid="ledger-module-label"]')).toBeVisible()
  await expect(page.getByTestId('ledger-settings-form').getByTestId('ledger-module-label')).toBeVisible()
  await page.setViewportSize(moduleLabelViewports[0]!)
  await applyTheme(page, 'light')
  const onboardingStyleByTheme = new Map<'light' | 'dark', LedgerModuleLabelStyle>()
  for (const theme of ['light', 'dark'] as const) {
    await page.setViewportSize(moduleLabelViewports[0]!)
    await applyTheme(page, theme)
    onboardingStyleByTheme.set(theme, await verifyModuleLabelsAcrossViewports(page, theme, 2))
  }
  expect(onboardingStyleByTheme.get('light')!.color).not.toBe(onboardingStyleByTheme.get('dark')!.color)
  await page.setViewportSize({ width: 1280, height: 900 })
  await applyTheme(page, 'light')
  await selectOptionContaining(page, '基础货币', 'CNY')
  await page.locator('#ledger-timezone').fill('Asia/Shanghai')
  await page.locator('#ledger-onboarding-title').click()
  await page.getByRole('button', { name: '保存设置并继续' }).click()

  await expect(page.getByTestId('ledger-account-form')).toBeVisible()
  await page.locator('#ledger-account-card-number').fill('6222021234567890')
  await page.locator('#ledger-account-name').fill('招商银行')
  await page.locator('#ledger-account-opening-balance').fill('10000')
  await expect(page.getByTestId('ledger-account-form')).toContainText('CNY · Asia/Shanghai')
  await page.getByRole('button', { name: '继续' }).click()

  await expect(page.getByTestId('ledger-dashboard')).toBeVisible()
  for (const theme of ['light', 'dark'] as const) {
    await applyTheme(page, theme)
    expect(await readModuleLabelStyle(page, theme, 1)).toEqual(onboardingStyleByTheme.get(theme))
  }
  await applyTheme(page, 'light')
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

test('Ledger module labels stay consistent across pages, themes, and viewports', async ({ page, request }) => {
  await ensureLedgerDashboardFixtures(request)
  const moduleViews = [
    { path: '/ledger', pageTestId: 'ledger-dashboard', title: '财务概览' },
    { path: '/ledger/accounts', pageTestId: 'ledger-accounts-page', title: '账户' },
    { path: '/ledger/transactions', pageTestId: 'ledger-transactions-page', title: '交易记录' },
  ]

  await page.setViewportSize(moduleLabelViewports[0]!)
  await page.goto('/ledger')
  await expect(page.getByTestId('ledger-dashboard')).toBeVisible()

  const styleByTheme = new Map<'light' | 'dark', LedgerModuleLabelStyle>()
  for (const theme of ['light', 'dark'] as const) {
    await page.setViewportSize(moduleLabelViewports[0]!)
    await applyTheme(page, theme)
    let expectedStyle: LedgerModuleLabelStyle | null = null
    for (const view of moduleViews) {
      await page.goto(view.path)
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      await expect(page.getByTestId(view.pageTestId)).toBeVisible()
      await expect(page.locator('h1').first()).toHaveText(view.title)
      const style = await verifyModuleLabelsAcrossViewports(page, theme, 1)
      if (expectedStyle) expect(style).toEqual(expectedStyle)
      else expectedStyle = style
    }
    if (!expectedStyle) throw new Error(`No module label styles were measured for ${theme}`)
    styleByTheme.set(theme, expectedStyle)
  }
  expect(styleByTheme.get('light')!.color).not.toBe(styleByTheme.get('dark')!.color)
})

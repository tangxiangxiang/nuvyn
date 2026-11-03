import { expect, test } from './fixtures/auth'
import { ensureLedgerDashboardFixtures } from './helpers/ledger-live'

test.use({ hasTouch: true })

for (const viewport of [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
]) {
  test(`Board gallery pull refresh reloads metadata and folders at ${viewport.width}px without replacing navigation`, async ({ page, context }) => {
    await page.setViewportSize(viewport)
    await page.goto('/board')
    const home = page.getByTestId('board-home')
    await expect(home).toBeVisible()
    await expect(page.locator('.board-loading')).toHaveCount(0)
    await expect(home).toHaveClass(/page-pull-refresh-root/)
    const initial = (await home.boundingBox())!
    const title = page.locator('.board-home-header h1')
    const box = (await title.boundingBox())!
    let metadataRequests = 0
    let folderRequests = 0
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname
      if (request.method() !== 'GET') return
      if (path === '/api/board') metadataRequests++
      if (path === '/api/board-folders') folderRequests++
    })
    const session = await context.newCDPSession(page)
    const x = Math.max(28, box.x + box.width / 2)
    const y = box.y + box.height / 2
    try {
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchStart', touchPoints: [{ x, y }],
      })
      for (let step = 1; step <= 10; step++) {
        await session.send('Input.dispatchTouchEvent', {
          type: 'touchMove', touchPoints: [{ x, y: y + 14 * step }],
        })
      }
      await expect(page.locator('.page-pull-refresh-indicator.is-armed')).toBeVisible()
      expect((await home.boundingBox())!.y - initial.y).toBeGreaterThan(25)
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchEnd', touchPoints: [],
      })
      await expect.poll(() => metadataRequests).toBe(1)
      await expect.poll(() => folderRequests).toBe(1)
      await expect(page.locator('.page-pull-refresh-indicator')).toHaveCount(0)
      await expect.poll(async () => Math.abs((await home.boundingBox())!.y - initial.y)).toBeLessThan(1)
      await expect(page).toHaveURL(/\/board$/)
    } finally {
      await session.detach()
    }
  })
}

test('Ledger dashboard refreshes the live snapshot without changing routes on a phone', async ({ page, request, context }) => {
  await ensureLedgerDashboardFixtures(request)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/ledger')
  const root = page.getByTestId('ledger-page')
  await expect(page.getByTestId('ledger-dashboard')).toBeVisible()
  await expect(root).toHaveClass(/page-pull-refresh-root/)
  const before = (await root.boundingBox())!
  const heading = (await page.locator('.ledger-dashboard-header h1').boundingBox())!
  const x = Math.max(30, Math.min(350, heading.x + heading.width / 2))
  const y = heading.y + heading.height / 2
  let accountsRequests = 0
  let overviewRequests = 0
  page.on('request', (req) => {
    if (req.method() !== 'GET') return
    const path = new URL(req.url()).pathname
    if (path === '/api/ledger/accounts') accountsRequests++
    if (path === '/api/ledger/overview') overviewRequests++
  })
  const session = await context.newCDPSession(page)
  try {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    for (let step = 1; step <= 10; step++) {
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchMove', touchPoints: [{ x, y: y + 14 * step }],
      })
    }
    await expect(page.locator('.page-pull-refresh-indicator.is-armed')).toBeVisible()
    expect((await root.boundingBox())!.y - before.y).toBeGreaterThan(25)
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect.poll(() => accountsRequests).toBeGreaterThan(0)
    await expect.poll(() => overviewRequests).toBeGreaterThan(0)
    await expect(page.locator('.page-pull-refresh-indicator')).toHaveCount(0)
    await expect.poll(async () => Math.abs((await root.boundingBox())!.y - before.y)).toBeLessThan(1)
    await expect(page).toHaveURL(/\/ledger$/)
  } finally {
    await session.detach()
  }
})

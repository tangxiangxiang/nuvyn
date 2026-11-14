import { expect, test } from './fixtures/auth'
import { deleteBoardIfExists, uniqueBoardTitle, waitForEditorReady } from './helpers/board'
import { ensureLedgerDashboardFixtures } from './helpers/ledger-live'

test.use({ hasTouch: true })

for (const viewport of [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
]) {
  test(`Board gallery pull refresh reloads the page once at ${viewport.width}px`, async ({ page, context }) => {
    await page.setViewportSize(viewport)
    await page.goto('/board')
    const home = page.getByTestId('board-home')
    await expect(home).toBeVisible()
    await expect(page.locator('.board-loading')).toHaveCount(0)
    await expect(home).toHaveClass(/page-pull-refresh-root/)
    await expect(page.locator('html')).toHaveCSS('overscroll-behavior-y', 'none')
    const initial = (await home.boundingBox())!
    const title = page.locator('.board-home-header h1')
    const box = (await title.boundingBox())!
    let metadataRequests = 0
    let folderRequests = 0
    let documentRequests = 0
    page.on('request', (request) => {
      if (request.resourceType() === 'document') documentRequests++
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
      await Promise.all([
        page.waitForEvent('request', (request) => request.resourceType() === 'document'),
        session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }),
      ])
      await expect.poll(() => metadataRequests).toBe(1)
      await expect.poll(() => folderRequests).toBe(1)
      expect(documentRequests).toBe(1)
      await expect(page.locator('.page-pull-refresh-indicator')).toHaveCount(0)
      await expect.poll(async () => Math.abs((await home.boundingBox())!.y - initial.y)).toBeLessThan(1)
      await expect(page).toHaveURL(/\/board$/)
    } finally {
      await session.detach()
    }
  })
}

test('Ledger dashboard pull refresh reloads the page once and loads a fresh snapshot', async ({ page, request, context }) => {
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
  let documentRequests = 0
  page.on('request', (req) => {
    if (req.resourceType() === 'document') documentRequests++
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
    await Promise.all([
      page.waitForEvent('request', (request) => request.resourceType() === 'document'),
      session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }),
    ])
    await expect.poll(() => accountsRequests).toBeGreaterThan(0)
    await expect.poll(() => overviewRequests).toBeGreaterThan(0)
    await expect(page.locator('.page-pull-refresh-indicator')).toHaveCount(0)
    await expect.poll(async () => Math.abs((await root.boundingBox())!.y - before.y)).toBeLessThan(1)
    await expect(page).toHaveURL(/\/ledger$/)
    expect(documentRequests).toBe(1)
  } finally {
    await session.detach()
  }
})

test('Ledger and Board block native downward pulls in the navbar and release the block in the canvas', async ({ page, request }) => {
  await ensureLedgerDashboardFixtures(request)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/ledger/transactions')
  await expect(page.getByTestId('ledger-transactions-page')).toBeVisible()
  await expect(page.locator('html')).toHaveCSS('overscroll-behavior-y', 'none')

  const pullFromNavbar = (deltaX: number, deltaY: number) => page.locator('.navbar').evaluate((target, [dx, dy]) => {
    const dispatch = (type: string, clientX: number, clientY: number) => target.dispatchEvent(new TouchEvent(type, {
      bubbles: true,
      cancelable: true,
      touches: type === 'touchend' ? [] : [new Touch({ identifier: 1, target, clientX, clientY })],
    }))
    dispatch('touchstart', 50, 10)
    const allowed = dispatch('touchmove', 50 + dx!, 10 + dy!)
    dispatch('touchend', 50 + dx!, 10 + dy!)
    return allowed
  }, [deltaX, deltaY])

  expect(await pullFromNavbar(0, 8)).toBe(false)
  expect(await pullFromNavbar(0, -8)).toBe(true)
  expect(await pullFromNavbar(12, 4)).toBe(true)
  await expect(page.locator('.page-pull-refresh-indicator')).toHaveCount(0)

  await page.locator('.workspace-board-link').click()
  await expect(page.getByTestId('board-home')).toBeVisible()
  await expect(page.locator('html')).toHaveCSS('overscroll-behavior-y', 'none')
  expect(await pullFromNavbar(0, 8)).toBe(false)

  const folderResponse = await request.post('/api/board-folders', { data: { name: uniqueBoardTitle('Pull refresh folder') } })
  expect(folderResponse.ok(), await folderResponse.text()).toBe(true)
  const { id: folderId } = await folderResponse.json() as { id: string }
  let boardId: string | undefined
  try {
    const boardResponse = await request.post('/api/board', { data: { title: uniqueBoardTitle('Pull refresh canvas'), folderId } })
    expect(boardResponse.ok(), await boardResponse.text()).toBe(true)
    const { metadata } = await boardResponse.json() as { metadata: { id: string } }
    boardId = metadata.id
    await page.goto(`/board/folder/${folderId}`)
    await expect(page.locator('html')).toHaveCSS('overscroll-behavior-y', 'none')
    expect(await pullFromNavbar(0, 8)).toBe(false)

    await page.locator(`[data-board-id="${boardId}"]`).click()
    await waitForEditorReady(page)
    await expect(page.locator('html')).toHaveCSS('overscroll-behavior-y', 'auto')
    const canvas = page.locator('.excalidraw').first()
    const allowed = await canvas.evaluate((target) => {
      const touch = (type: string, clientY: number) => target.dispatchEvent(new TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        touches: type === 'touchend' ? [] : [new Touch({ identifier: 1, target, clientX: 80, clientY })],
      }))
      touch('touchstart', 80)
      const allowed = touch('touchmove', 100)
      touch('touchend', 100)
      return allowed
    })
    expect(allowed).toBe(true)
  } finally {
    if (boardId) await deleteBoardIfExists(request, boardId)
    await request.delete(`/api/board-folders/${folderId}`)
  }
})

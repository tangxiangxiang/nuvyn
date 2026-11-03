import { expect, test } from './fixtures/diary'

test.use({ hasTouch: true })

for (const viewport of [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
]) {
  test(`Diary calendar supports pull-to-refresh at ${viewport.width}px without changing the selected scope`, async ({ page, context }) => {
    await page.setViewportSize(viewport)
    await page.goto('/vault')
    const diary = page.locator('.scope-chip').filter({ hasText: 'diary' })
    if (await diary.getAttribute('aria-pressed') !== 'true') await diary.click()
    await expect(page.getByTestId('diary-calendar')).toBeVisible()
    const vault = page.locator('.vault')
    await expect(vault).toHaveClass(/has-tablet-pull-refresh/)
    const area = page.locator('.editor-area')
    const before = (await area.boundingBox())!
    const surface = page.locator('.diary-calendar-content')
    const box = (await surface.boundingBox())!
    const x = box.x + box.width / 2
    const y = box.y + 60
    let treeRequests = 0
    page.on('request', (req) => {
      if (req.method() === 'GET' && new URL(req.url()).pathname === '/api/tree') treeRequests++
    })
    const session = await context.newCDPSession(page)
    try {
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
      for (let step = 1; step <= 10; step++) {
        await session.send('Input.dispatchTouchEvent', {
          type: 'touchMove', touchPoints: [{ x, y: y + step * 14 }],
        })
      }
      await expect(page.locator('.vault-tablet-refresh-indicator.is-armed')).toBeVisible()
      expect((await area.boundingBox())!.y - before.y).toBeGreaterThan(25)
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await expect.poll(() => treeRequests).toBeGreaterThan(0)
      await expect(page.locator('.vault-tablet-refresh-indicator')).toHaveCount(0)
      await expect(page.getByTestId('diary-calendar')).toBeVisible()
      await expect.poll(async () => Math.abs((await area.boundingBox())!.y - before.y)).toBeLessThan(1)
      await expect(diary).toHaveAttribute('aria-pressed', 'true')
      await expect(page).toHaveURL(/\/vault$/)
    } finally {
      await session.detach()
    }
  })
}

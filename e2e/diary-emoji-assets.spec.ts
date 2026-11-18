import { test, expect } from './fixtures/auth'
import { createHash } from 'node:crypto'

test('Fluent Bomb APNG loads and advances frames in Chromium', async ({ page }) => {
  await page.goto('/diary')
  await page.evaluate(async () => {
    const image = document.createElement('img')
    image.dataset.testid = 'bomb-apng-probe'
    image.src = '/emoji/bomb-animated.png'
    Object.assign(image.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: '256px',
      height: '256px',
      zIndex: '99999',
    })
    document.body.append(image)
    await image.decode()
  })

  const image = page.getByTestId('bomb-apng-probe')
  await expect(image).toHaveJSProperty('naturalWidth', 256)
  await expect(image).toHaveJSProperty('naturalHeight', 256)
  const renderedFrameHash = async () => createHash('sha256').update(await image.screenshot({ animations: 'allow' })).digest('hex')
  const firstFrameHash = await renderedFrameHash()
  await expect.poll(renderedFrameHash).not.toBe(firstFrameHash)
})

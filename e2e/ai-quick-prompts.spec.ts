import { expect, test } from './fixtures/auth'
import { cleanupCreatedPaths, createDoc, openDoc, waitForVaultReady } from './helpers/edit-program'

test('quick prompt previews and fills the composer without sending', async ({ page, request }) => {
  const slug = `inbox/e2e-quick-prompt-${Date.now()}`
  const created: string[] = []
  let chatRequests = 0
  page.on('request', req => {
    if (new URL(req.url()).pathname === '/api/ai/chat' && req.method() === 'POST') chatRequests++
  })
  try {
    await createDoc(request, slug, '# Example\n\nA note about component design.', created)
    await page.goto('/vault')
    await waitForVaultReady(page)
    await openDoc(page, slug)
    await page.locator('.right-rail').getByRole('tab', { name: 'AI', exact: true }).click()
    const panel = page.locator('.ai-panel')
    const prompts = panel.locator('.ai-quick-prompt')
    await expect(prompts).toHaveText(['Key takeaways', 'Find related notes', 'Improve this note'])
    const prompt = prompts.last()
    const text = await prompt.getAttribute('title')
    expect(text).toContain('do not edit, rename, move, or delete files')
    await prompt.click()
    await expect(panel.locator('.ai-composer textarea')).toHaveValue(text!)
    const input = panel.locator('.ai-composer textarea')
    const inputSurface = panel.locator('.ai-input-control')
    await input.focus()
    await expect(inputSurface).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(inputSurface).toHaveCSS('border-radius', '0px')
    await input.blur()
    await expect(inputSurface).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await input.fill('/')
    await expect(panel.getByRole('listbox', { name: 'Prompt templates' })).toBeVisible()
    await expect(panel.getByRole('option')).toHaveText(['Key takeaways', 'Find related notes', 'Improve this note'])
    await input.press('ArrowDown')
    await input.press('Enter')
    await expect(input).toHaveValue(await prompts.nth(1).getAttribute('title') as string)
    await input.fill('/improve')
    await expect(panel.getByRole('option')).toHaveText(['Improve this note'])
    await panel.getByRole('option').click()
    await expect(input).toHaveValue(text!)
    await input.fill('/')
    await input.press('Escape')
    await expect(panel.getByRole('listbox')).toHaveCount(0)
    await input.fill('Short question')
    const shortHeight = await input.evaluate(el => el.getBoundingClientRect().height)
    await input.fill(Array.from({ length: 12 }, (_, index) => `Question ${index}`).join('\n'))
    await expect.poll(() => input.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true)
    const longHeight = await input.evaluate(el => el.getBoundingClientRect().height)
    expect(longHeight).toBeGreaterThan(shortHeight)
    expect(longHeight).toBeLessThan(150)
    await input.fill(Array.from({ length: 24 }, (_, index) => `Question ${index}`).join('\n'))
    await expect.poll(() => input.evaluate(el => el.getBoundingClientRect().height)).toBe(longHeight)
    expect(chatRequests).toBe(0)
  } finally {
    await cleanupCreatedPaths(request, created)
  }
})

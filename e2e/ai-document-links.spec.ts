import { expect, test } from './fixtures/auth'
import { cleanupCreatedPaths, createDoc, gotoVaultReady, interceptAiChat, openAiRail, openDoc, sendAi, sse } from './helpers/edit-program'

test('assistant note links open workspace tabs without reloading the application', async ({ page, request }) => {
  const run = Date.now()
  const source = `inbox/e2e-ai-link-source-${run}`
  const target = `inbox/e2e-ai-link-target-${run}`
  const created: string[] = []
  try {
    await createDoc(request, source, '# Source', created)
    await createDoc(request, target, '# Target\n\n## Section\n\nTarget body', created)
    await interceptAiChat(page, [])
    await page.route('**/api/ai/chat', route => route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: [
        sse('user', { id: 1 }),
        sse('token', { text: `[Recommended note](${target}.md#section)` }),
        sse('done', { userId: 1, assistantId: 2 }),
      ].join(''),
    }))
    await gotoVaultReady(page)
    await openDoc(page, source)
    await openAiRail(page)
    await sendAi(page, 'Recommend a note')
    const link = page.locator('.ai-markdown').getByRole('link', { name: 'Recommended note' })
    await expect(link).toHaveAttribute('href', `/vault/${target}#section`)
    await page.evaluate(() => { (window as unknown as { aiLinkNavigationMarker: boolean }).aiLinkNavigationMarker = true })
    await link.click()
    await expect(page.locator(`[data-tab-id="${target}"]`)).toHaveAttribute('aria-selected', 'true')
    expect(await page.evaluate(() => (window as unknown as { aiLinkNavigationMarker?: boolean }).aiLinkNavigationMarker)).toBe(true)
    await expect(page.locator(`[data-tab-id="${source}"]`)).toBeVisible()
  } finally {
    await cleanupCreatedPaths(request, created)
  }
})

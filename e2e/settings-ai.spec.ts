import { expect, test } from './fixtures/auth'

test('AI provider menu is clickable above Settings and restores each provider configuration', async ({ page }) => {
  const configurations = {
    anthropic: { provider: 'anthropic', configured: true, maskedKey: 'sk-ant-***1234', baseURL: 'https://anthropic.example.test', model: 'anthropic-custom' },
    openai: { provider: 'openai', configured: true, maskedKey: 'sk-***5678', baseURL: 'https://openai.example.test/v1', model: 'openai-custom' },
  }
  let active: keyof typeof configurations = 'anthropic'
  await page.route('**/api/ai/settings', async (route) => {
    if (route.request().method() === 'PUT') {
      const input = route.request().postDataJSON()
      expect(Object.keys(input)).toEqual(['provider'])
      expect(['anthropic', 'openai']).toContain(input.provider)
      active = input.provider
    }
    await route.fulfill({ json: configurations[active] })
  })
  await page.goto('/vault')
  await page.getByTestId('account-button').click()
  await page.getByTestId('account-settings').click()
  const settings = page.locator('.settings-modal')
  await expect(settings).toBeVisible()
  const provider = settings.getByTestId('settings-provider')
  for (const [value, label] of [['openai', 'OpenAI'], ['anthropic', 'Anthropic']] as const) {
    await provider.click()
    const option = page.locator('.n-base-select-option').filter({ hasText: new RegExp(`^${label}$`) })
    await expect(option).toBeVisible()
    await expect.poll(() => option.evaluate((el) => {
      const rect = el.getBoundingClientRect()
      return el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
    })).toBe(true)
    // A visible teleported option can still be covered by the modal backdrop.
    // A normal click must pass Playwright's actual hit-target check.
    await option.click()
    await expect(provider).toContainText(label)
    await expect(settings.locator('input[type="url"]')).toHaveValue(configurations[value].baseURL)
    await expect(settings.getByPlaceholder(value === 'openai' ? 'gpt-4o' : 'claude-sonnet-4-6')).toHaveValue(configurations[value].model)
    await expect(settings.locator('input[type="password"]')).toHaveAttribute('placeholder', configurations[value].maskedKey)
  }
})

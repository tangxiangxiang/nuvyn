import { expect, test } from './fixtures/auth'
import type { Page } from '@playwright/test'

async function openSettings(page: Page) {
  await page.goto('/vault')
  await page.getByTestId('account-button').click()
  await page.getByTestId('account-settings').click()
  const settings = page.locator('.settings-modal')
  await expect(settings).toBeVisible()
  return settings
}
const fields = (page: Page) => ({
  name: page.getByRole('textbox', { name: /^(名称|Name)/ }),
  key: page.locator('input[type="password"]'),
  url: page.locator('input[type="url"]'),
  model: page.getByPlaceholder('claude-sonnet-4-6'),
})
// Only this isolated E2E server is mutated. Track IDs, not global deletions.
let ids: string[] = []
let previousDefault: string | null

test.beforeEach(async ({ request }) => {
  const response = await request.get('/api/ai/profiles')
  expect(response.ok()).toBe(true)
  previousDefault = (await response.json()).activeProfileId
  ids = []
})
test.afterEach(async ({ request }) => {
  for (const id of ids) {
    const result = await request.delete(`/api/ai/profiles/${id}`, { data: { disableDefault: true } })
    expect([200, 404]).toContain(result.status())
  }
  if (previousDefault) expect((await request.put(`/api/ai/profiles/${previousDefault}/activate`)).ok()).toBe(true)
})

test('creates same-protocol profiles, explicitly selects default, and keeps profiles after reopening and refreshing', async ({ page, request }) => {
  const settings = await openSettings(page)
  for (const [name, model] of [['E2E Profile A', 'model-a'], ['E2E Profile B', 'model-b']]) {
    await settings.getByRole('button', { name: /新增配置|Add profile/ }).click()
    await fields(page).name.fill(name!)
    await fields(page).key.fill(`sk-e2e-${model}-not-a-real-key`)
    await fields(page).url.fill(`https://${model}.example.test`)
    await fields(page).model.fill(model!)
    const saved = page.waitForResponse((r) => r.url().endsWith('/api/ai/profiles') && r.request().method() === 'POST')
    await settings.getByRole('button', { name: /^(保存|Save)$/ }).click()
    const result = await saved
    expect(result.status()).toBe(201)
    ids.push((await result.json()).id)
    await expect(settings.locator('.settings-ai-profile.is-selected')).toContainText(name!)
    await expect(fields(page).key).toHaveValue('')
    await expect(fields(page).key).toHaveAttribute('placeholder', '••••••••')
  }
  const data = await (await request.get('/api/ai/profiles')).json()
  expect(data.activeProfileId).toBe(previousDefault)
  expect(JSON.stringify(data)).not.toContain('not-a-real-key')
  await settings.getByRole('button', { name: /设为默认|Set as default/ }).click()
  await expect(settings.locator('.settings-ai-profile.is-selected .settings-ai-profile-default')).toBeVisible()
  await settings.getByRole('button', { name: /关闭|Close/, exact: true }).click()
  await expect(settings).toHaveCount(0)
  await page.getByTestId('account-button').click()
  await page.getByTestId('account-settings').click()
  await expect(fields(page).model).toHaveValue('model-b')
  await page.reload()
  await page.getByTestId('account-button').click()
  await page.getByTestId('account-settings').click()
  await expect(fields(page).model).toHaveValue('model-b')
  await page.locator('.settings-ai-profile').filter({ hasText: 'E2E Profile A' }).click()
  await expect(fields(page).model).toHaveValue('model-a')
  await expect(fields(page).url).toHaveValue('https://model-a.example.test')
})

test('protocol menu supports real pointer and keyboard selection, Escape, and Settings focus trap', async ({ page }) => {
  const settings = await openSettings(page)
  await settings.getByRole('button', { name: /新增配置|Add profile/ }).click()
  const provider = page.getByTestId('settings-provider')
  await provider.click()
  const option = page.locator('.n-base-select-option').filter({ hasText: /^OpenAI$/ })
  await expect(option).toBeVisible()
  await expect.poll(() => option.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
  })).toBe(true)
  await option.click()
  await expect(provider).toContainText('OpenAI')
  await provider.click()
  await page.keyboard.press('Escape')
  await expect(page.locator('.n-base-select-menu:visible')).toHaveCount(0)
  await expect(settings).toBeVisible()
  await provider.locator('[tabindex="0"]').focus()
  await page.keyboard.press('Enter')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Enter')
  await expect(provider).toContainText('Anthropic')
  await expect(settings).toBeVisible()
  const close = settings.getByRole('button', { name: /关闭|Close/, exact: true })
  await close.focus()
  await page.keyboard.press('Shift+Tab')
  await expect.poll(() => settings.evaluate((el) => el.contains(document.activeElement))).toBe(true)
  await page.keyboard.press('Tab')
  await expect(close).toBeFocused()
})

test('protects unsaved fields and failed saves, tests only the selected profile, and confirms deleting the default', async ({ page, request }) => {
  for (const name of ['E2E Saved A', 'E2E Saved B']) {
    const r = await request.post('/api/ai/profiles', { data: { name, provider: 'anthropic', apiKey: 'sk-e2e-only-not-real', model: 'model-saved' } })
    expect(r.status()).toBe(201)
    ids.push((await r.json()).id)
  }
  expect((await request.put(`/api/ai/profiles/${ids[0]}/activate`)).ok()).toBe(true)
  const settings = await openSettings(page)
  const current = fields(page)
  await current.model.fill('unsaved-model')
  await settings.locator('.settings-ai-profile').filter({ hasText: 'E2E Saved B' }).click()
  // The shared confirmation host uses a dialog role across themes.
  const discard = page.getByRole('dialog').filter({ hasText: /放弃尚未保存|Discard unsaved/ })
  await expect(discard).toBeVisible()
  await discard.getByRole('button', { name: /取消|Cancel/ }).click()
  await expect(current.model).toHaveValue('unsaved-model')
  await page.route(`**/api/ai/profiles/${ids[0]}`, (route) => route.request().method() === 'PATCH'
    ? route.fulfill({ status: 500, json: { error: 'Fixture save failure' } }) : route.continue())
  await current.key.fill('sk-unsaved-test')
  await settings.getByRole('button', { name: /^(保存|Save)$/ }).click()
  await expect(page.getByText(/Fixture save failure/)).toBeVisible()
  await expect(current.model).toHaveValue('unsaved-model')
  await expect(current.key).toHaveValue('sk-unsaved-test')
  await page.route(`**/api/ai/profiles/${ids[0]}/test-connection`, async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({ name: 'E2E Saved A', model: 'unsaved-model', apiKey: 'sk-unsaved-test' })
    await route.fulfill({ json: { ok: true, provider: 'anthropic', model: 'unsaved-model', checkedAt: 1, latencyMs: 12 } })
  })
  await settings.getByRole('button', { name: /测试连接|Test connection/ }).click()
  await expect(settings.locator('.settings-connection-status')).toContainText(/已连接|Connected/)
  expect((await (await request.get('/api/ai/profiles')).json()).profiles.find((p: { id: string }) => p.id === ids[0]).model).toBe('model-saved')
  await current.model.fill('changed-again')
  await expect(settings.locator('.settings-connection-status')).toContainText(/未检测|Not tested/)
  await settings.getByRole('button', { name: /^(删除|Delete)$/ }).click()
  await discard.getByRole('button', { name: /确定|Confirm/ }).click()
  const deletion = page.getByRole('dialog').filter({ hasText: /删除配置|Delete profile/ })
  await expect(deletion).toContainText('E2E Saved A')
  await expect(deletion).toContainText(/禁用 AI|disables AI/)
  await deletion.getByRole('button', { name: /确定|Confirm/ }).click()
  await expect(settings.locator('.settings-ai-profile').filter({ hasText: 'E2E Saved A' })).toHaveCount(0)
  expect((await (await request.get('/api/ai/profiles')).json()).activeProfileId).toBeNull()
  expect((await (await request.get('/api/ai/profiles')).json()).profiles.some((p: { id: string }) => p.id === ids[1])).toBe(true)
})

test.describe('tablet touch', () => {
  test.use({ hasTouch: true, viewport: { width: 820, height: 1180 } })
  test('opens protocol options and selects a protocol by touch', async ({ page }) => {
    const settings = await openSettings(page)
    await settings.getByRole('button', { name: /新增配置|Add profile/ }).tap()
    await page.getByTestId('settings-provider').tap()
    await page.locator('.n-base-select-option').filter({ hasText: /^OpenAI$/ }).tap()
    await expect(page.getByTestId('settings-provider')).toContainText('OpenAI')
    await expect.poll(() => settings.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  })
})

import { expect, test } from '@playwright/test'
import {
  clearDraftDatabase,
  createDoc,
  draftRowCount,
  interceptAutosaveAborted,
  openDoc,
  reloadApp,
  setEditorContent,
} from './helpers/edit-program'
import {
  createAdditionalOwnerSession,
  readSessionRevokedAt,
  revokeCurrentBrowserSession,
} from './helpers/auth-session'

const SETUP_TOKEN = 'nuvyn-auth-browser-setup-token-0123456789'
const OWNER_USERNAME = 'browser-owner'
const OWNER_PASSWORD = 'browser-owner-password-strong-123'

async function ensureAuthenticatedOwner(
  page: import('@playwright/test').Page,
  route: string,
): Promise<void> {
  await page.goto(route)
  await expect(page).toHaveURL(/\/(?:setup|login|vault)(?:[/?]|$)/)
  if (page.url().includes('/setup')) {
    await page.locator('#setup-token').fill(SETUP_TOKEN)
    await page.locator('#setup-username').fill(OWNER_USERNAME)
    await page.locator('#setup-password').fill(OWNER_PASSWORD)
    await page.locator('#setup-confirm-password').fill(OWNER_PASSWORD)
    await page.locator('.auth-submit').click()
  } else if (page.url().includes('/login')) {
    await page.locator('#login-username').fill(OWNER_USERNAME)
    await page.locator('#login-password').fill(OWNER_PASSWORD)
    await page.locator('.auth-submit').click()
  }
  await expect(page).toHaveURL(new RegExp(`${route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[?#]|$)`))
  await expect(page.locator('.vault')).toBeVisible({ timeout: 15_000 })
}

test('real setup, logout, and login UI paths establish the session', async ({ page }) => {
  let setupBody: Record<string, unknown> | null = null
  let loginBody: Record<string, unknown> | null = null
  page.on('request', (request) => {
    if (request.url().endsWith('/api/auth/setup')) setupBody = request.postDataJSON() as Record<string, unknown>
    if (request.url().endsWith('/api/auth/login')) loginBody = request.postDataJSON() as Record<string, unknown>
  })
  await page.goto('/vault')
  await expect(page).toHaveURL(/\/setup(?:\?|$)/)
  await expect(page.locator('.navbar')).toHaveCount(0)
  await expect(page.locator('#setup-token')).toBeFocused()
  await expect(page.locator('#setup-token-help')).toContainText('NUVYN_SETUP_TOKEN')
  await expect(page.getByRole('button', { name: /logout|sign out/i })).toHaveCount(0)
  await expect(page.getByRole('link', { name: /logout|sign out/i })).toHaveCount(0)

  await page.locator('#setup-token').fill(SETUP_TOKEN)
  await page.locator('#setup-username').fill(OWNER_USERNAME)
  await page.locator('#setup-password').fill(OWNER_PASSWORD)
  await page.locator('#setup-confirm-password').fill('different-password')
  await page.locator('#setup-confirm-password').press('Enter')
  await expect(page.locator('#setup-confirm-error')).toBeVisible()
  await expect(page.locator('#setup-confirm-password')).toBeFocused()
  expect(setupBody).toBeNull()

  await page.locator('#setup-confirm-password').fill(OWNER_PASSWORD)
  await page.locator('.auth-submit').click()
  expect(setupBody).toEqual({
    bootstrapToken: SETUP_TOKEN,
    username: OWNER_USERNAME,
    password: OWNER_PASSWORD,
  })

  await expect(page).toHaveURL(/\/vault(?:$|\?)/)
  await expect(page.locator('.vault')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.activity-bar [data-testid="account-button"]')).toHaveCount(0)
  await expect(page.locator('.activity-bar .ab-btn-settings')).toHaveCount(0)
  const identityAfterSetup = await page.request.get('/api/vault/identity')
  expect(identityAfterSetup.status()).toBe(200)
  expect((await identityAfterSetup.json()).vaultId).toMatch(/^[0-9a-f]{12}$/)
  expect((await page.request.get('/api/tree')).status()).toBe(200)
  const health = await page.request.get('/api/health')
  expect(await health.json()).toEqual({ ok: true })

  const browserStorage = await page.evaluate(() => ({
    local: { ...localStorage },
    session: { ...sessionStorage },
  }))
  expect(JSON.stringify(browserStorage)).not.toContain(SETUP_TOKEN)
  expect(JSON.stringify(browserStorage)).not.toContain('browser-owner-password-strong-123')

  await expect(page.locator('.nav-logout')).toHaveCount(0)
  const accountButton = page.locator('.navbar [data-testid="account-button"]')
  await expect(accountButton).toBeVisible()
  await accountButton.click()
  const accountMenu = page.locator('[data-testid="account-menu"]')
  await expect(accountMenu).toBeVisible()
  await expect(accountMenu).toContainText(OWNER_USERNAME)
  const accountBox = await accountButton.boundingBox()
  const menuBox = await accountMenu.boundingBox()
  expect(accountBox).not.toBeNull()
  expect(menuBox).not.toBeNull()
  expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(accountBox!.x + accountBox!.width + 1)
  expect(menuBox!.y).toBeGreaterThanOrEqual(accountBox!.y + accountBox!.height - 1)
  await expect(page.locator('[data-testid="account-settings"]')).toBeVisible()
  await accountMenu.locator('[data-testid="account-logout"]').click()
  await expect(page).toHaveURL(/\/login(?:\?|$)/)
  expect((await page.request.get('/api/vault/identity')).status()).toBe(401)
  await expect(page.locator('.navbar')).toHaveCount(0)
  await expect(page.locator('#login-username')).toBeFocused()
  await expect(page.getByRole('button', { name: /logout|sign out/i })).toHaveCount(0)
  await expect(page.getByRole('link', { name: /logout|sign out/i })).toHaveCount(0)

  await page.locator('#login-username').fill(OWNER_USERNAME)
  await page.locator('#login-password').fill('wrong-password')
  await page.locator('.auth-submit').click()
  await expect(page.locator('[role="alert"]')).toContainText(/Invalid username or password\.|用户名或密码错误。?/)
  await expect(page.locator('#login-username')).toBeFocused()

  await page.locator('#login-username').fill(OWNER_USERNAME)
  await page.locator('#login-password').fill(OWNER_PASSWORD)
  await page.locator('.auth-submit').click()
  expect(loginBody).toEqual({ username: OWNER_USERNAME, password: OWNER_PASSWORD })
  await expect(page).toHaveURL(/\/vault(?:$|\?)/)
  await expect(page.locator('.vault')).toBeVisible({ timeout: 15_000 })
  expect((await page.request.get('/api/vault/identity')).status()).toBe(200)
  expect((await page.request.get('/api/tree')).status()).toBe(200)

  await page.reload()
  await expect(page).toHaveURL(/\/vault(?:$|\?)/)
  await expect(page.locator('.auth-page')).toHaveCount(0)
  await expect(page.locator('.vault')).toBeVisible({ timeout: 15_000 })

  await page.goto('/login?redirect=https%3A%2F%2Fevil.example')
  await expect(page).toHaveURL(/\/vault(?:$|\?)/)
  await expect(page).not.toHaveURL(/evil\.example/)
  await expect(page.locator('.auth-page')).toHaveCount(0)
  await page.goto('/setup?redirect=%2Fvault%2Finbox%2Fnote')
  await expect(page).toHaveURL(/\/vault\/inbox\/note(?:$|\?)/)
  await expect(page.locator('.auth-page')).toHaveCount(0)
})

test('real revoked session preserves a browser draft through expiry, login, and recovery', async ({
  page,
  context,
}) => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const documentPath = `inbox/phase7-expiry-${suffix}`
  const originalBody = `# Phase 7 expiry ${suffix}\n\nSaved before expiry.\n`
  const dirtyMarker = `PHASE7_EXPIRY_DRAFT_${suffix}`
  const originalRoute = `/vault/${documentPath}`

  // Start with a clean browser recovery database while keeping the isolated
  // server's real auth database available to the test-side session helper.
  await page.goto('/__markdown-test?mode=reading')
  await clearDraftDatabase(page)
  await ensureAuthenticatedOwner(page, originalRoute)

  await createDoc(page.request, documentPath, originalBody, [])
  await reloadApp(page)
  await openDoc(page, documentPath)
  const serverBefore = await (await page.request.get(`/api/posts/${documentPath}`)).json() as { raw: string }
  expect(serverBefore.raw).toBe(originalBody)

  let saveRequests = 0
  let expiryObserved = false
  let postExpirySaveRequests = 0
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (request.method() !== 'PUT' || url.pathname !== `/api/posts/${documentPath}`) return
    saveRequests += 1
    if (expiryObserved) postExpirySaveRequests += 1
  })
  await interceptAutosaveAborted(page, documentPath)
  await setEditorContent(page, dirtyMarker)
  await expect(page.locator('.editor-pane .monaco-editor .view-lines').first())
    .toContainText(dirtyMarker)
  await expect.poll(() => draftRowCount(page, dirtyMarker), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(1)

  const cookiesBeforeRevoke = await context.cookies()
  const activeCookie = cookiesBeforeRevoke.find((cookie) => (
    cookie.name === 'nuvyn_session' || cookie.name === '__Host-nuvyn_session'
  ))
  expect(activeCookie?.value).toBeTruthy()
  const unaffectedSessionId = createAdditionalOwnerSession()
  const { sessionId } = await revokeCurrentBrowserSession(context)
  expect(sessionId).toBeGreaterThan(0)
  expect(readSessionRevokedAt(sessionId)).not.toBeNull()
  expect(readSessionRevokedAt(unaffectedSessionId)).toBeNull()
  // The browser keeps the HttpOnly cookie; the next protected request must
  // be rejected because its server-side row is now revoked.
  const cookiesAfterRevoke = await context.cookies()
  expect(cookiesAfterRevoke.some((cookie) => cookie.name === activeCookie?.name
    && cookie.value === activeCookie.value)).toBe(true)

  const protectedResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return response.request().method() === 'GET' && url.pathname === '/api/ai/settings'
  })
  await page.locator('.navbar [data-testid="account-button"]').click()
  await page.locator('[data-testid="account-settings"]').click()
  const protectedResponse = await protectedResponsePromise
  expect(protectedResponse.status()).toBe(401)
  const protectedBody = await protectedResponse.json() as { code?: string }
  expect(protectedBody.code).toBe('auth-session-required')
  expiryObserved = true
  const savesAtExpiry = saveRequests

  await expect(page).toHaveURL(/\/login\?reason=expired&redirect=/, { timeout: 15_000 })
  const loginUrl = new URL(page.url())
  expect(loginUrl.searchParams.get('reason')).toBe('expired')
  expect(loginUrl.searchParams.get('redirect')).toBe(originalRoute)
  await expect(page.locator('.auth-notice[role="status"]')).toContainText(/session expired/i)

  // Read the persistent recovery record while the workspace is gone. This
  // proves the transition flushed IndexedDB rather than merely leaving text
  // in the unmounted Monaco buffer.
  await expect.poll(() => draftRowCount(page, dirtyMarker), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(1)
  expect(postExpirySaveRequests).toBe(0)
  expect(saveRequests).toBe(savesAtExpiry)

  await page.locator('#login-username').fill(OWNER_USERNAME)
  await page.locator('#login-password').fill(OWNER_PASSWORD)
  await page.locator('.auth-submit').click()
  await expect(page).toHaveURL(new RegExp(`${originalRoute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[?#]|$)`), {
    timeout: 15_000,
  })
  await expect(page.locator('.vault')).toBeVisible({ timeout: 15_000 })
  const identityAfterRelogin = await page.request.get('/api/vault/identity')
  expect(identityAfterRelogin.status()).toBe(200)
  expect((await identityAfterRelogin.json()).vaultId).toMatch(/^[0-9a-f]{12}$/)
  await expect(page.locator('.editor-pane .monaco-editor .view-lines').first())
    .toContainText(dirtyMarker, { timeout: 15_000 })

  const serverAfter = await (await page.request.get(`/api/posts/${documentPath}`)).json() as { raw: string }
  expect(serverAfter.raw).toBe(originalBody)
  expect(postExpirySaveRequests).toBe(0)
})

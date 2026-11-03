import { expect, goBackFromDiaryDocument, test, DIARY_ACCESS_CAPABILITY_HEADER } from './fixtures/diary'

// Diary fixtures carry a live capability in memory. Do not let the
// repository-wide retain-on-failure setting serialize request headers into a
// trace artifact; screenshots and error context remain enabled.
test.use({ trace: 'off', screenshot: 'only-on-failure' })

const BASE_URL = 'http://127.0.0.1:4174'
const UNPUBLISHED_DIARY_PATH = 'diary/2099-01-01'

function originFor(baseURL: string | undefined): string {
  return baseURL ?? process.env.NUVYN_PUBLIC_ORIGIN ?? BASE_URL
}

async function openDiaryScope(page: import('@playwright/test').Page): Promise<void> {
  const diaryChip = page.locator('.scope-chip').filter({ hasText: 'diary' })
  if (await diaryChip.getAttribute('aria-pressed') !== 'true') await diaryChip.click()
  await expect(page.getByTestId('diary-calendar-surface')).toBeVisible({ timeout: 15_000 })
}

async function readJson(response: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>
}

test('an authenticated client without capability stays locked and capability is not persisted', async ({
  page,
  playwright,
  request,
  baseURL,
}) => {
  const origin = originFor(baseURL)
  await page.goto('/vault')
  await openDiaryScope(page)

  const storageState = await page.context().storageState()
  const serializedState = JSON.stringify(storageState)
  expect(serializedState).not.toContain(DIARY_ACCESS_CAPABILITY_HEADER)
  expect(serializedState).not.toContain('e2e-diary-access-password-strong-123')

  const browserStorage = await page.evaluate(async () => ({
    localStorage: Object.fromEntries(Object.entries(localStorage)),
    sessionStorage: Object.fromEntries(Object.entries(sessionStorage)),
    cookies: document.cookie,
    indexedDbNames: typeof indexedDB.databases === 'function'
      ? (await indexedDB.databases()).map((database) => database.name ?? '')
      : [],
  }))
  const serializedBrowserStorage = JSON.stringify(browserStorage)
  expect(serializedBrowserStorage).not.toMatch(/capability/i)
  expect(serializedBrowserStorage).not.toContain('e2e-diary-access-password-strong-123')

  // Reuse only the authenticated cookie in a fresh API client. The
  // process-local browser capability cannot cross this boundary.
  const withoutCapability = await playwright.request.newContext({
    baseURL: origin,
    storageState,
    extraHTTPHeaders: { Origin: origin },
  })
  try {
    const locked = await withoutCapability.get(`/api/posts/${UNPUBLISHED_DIARY_PATH}`)
    expect(locked.status(), await locked.text()).toBe(423)
    expect(await readJson(locked)).toMatchObject({ code: 'diary-locked' })
  } finally {
    await withoutCapability.dispose()
  }

  // The fixture's explicit capability-bearing API client can pass the same
  // guard. The date is intentionally absent, so a successful authorization
  // reaches the normal 404 rather than reading or creating a body.
  const authorized = await request.get(`/api/posts/${UNPUBLISHED_DIARY_PATH}`)
  expect(authorized.status(), await authorized.text()).toBe(404)
})

test('D8.2 keeps unsupported managed Diary History and generic Recovery fail-closed', async ({ request }) => {
  const historyPath = `${UNPUBLISHED_DIARY_PATH}.md`
  const query = new URLSearchParams({ path: historyPath })
  const historyRequests = [
    request.get(`/api/history/log?${query}`),
    request.get(`/api/history/file?${query}&ref=HEAD`),
    request.get(`/api/history/diff?${query}&old=HEAD&new=HEAD`),
    request.post('/api/history/content-hashes', {
      data: { paths: [historyPath] },
    }),
    request.post('/api/history/commits', {
      data: {
        paths: [historyPath],
        message: 'D8.2 unsupported Diary History probe',
        expected: { [historyPath]: '0'.repeat(64) },
      },
    }),
  ]

  for (const response of await Promise.all(historyRequests)) {
    expect(response.status(), await response.text()).toBe(422)
    expect(await readJson(response)).toMatchObject({
      code: 'diary-history-encrypted-unsupported',
    })
  }

  const recovery = await request.put(`/api/recover/${UNPUBLISHED_DIARY_PATH}`, {
    data: { raw: '# unsupported managed Diary recovery\n' },
  })
  expect(recovery.status(), await recovery.text()).toBe(422)
  expect(await readJson(recovery)).toMatchObject({
    code: 'diary-recovery-identity-required',
  })
})

test('a page-session lock does not invalidate a separate Diary API session', async ({ page, request }) => {
  await page.goto('/vault')
  await openDiaryScope(page)

  await page.getByTestId('account-button').click()
  await page.getByTestId('account-lock-diary').click()
  await expect(page.locator('.scope-chip').filter({ hasText: 'note' }))
    .toHaveAttribute('aria-pressed', 'true')

  // This request owns a different authenticated session and a different
  // in-memory capability. A lock in the browser session must not revoke it.
  const stillAuthorized = await request.get(`/api/posts/${UNPUBLISHED_DIARY_PATH}`)
  expect(stillAuthorized.status(), await stillAuthorized.text()).toBe(404)

  // Re-entering Diary uses the supported UI unlock path again rather than
  // reusing a token from the first page session.
  await page.goto('/vault')
  await openDiaryScope(page)
})

test('full Diary navigation waits for route-led workspace hydration', async ({ page, request }) => {
  const date = '2026-08-30'
  const path = `diary/${date}`
  const existing = await request.get(`/api/posts/${path}`)
  let created = false
  if (existing.status() === 404) {
    const response = await request.post('/api/diary/dates', {
      data: { date, timeZone: 'Asia/Shanghai' },
    })
    expect(response.status(), await response.text()).toBe(201)
    created = true
  } else {
    expect(existing.status(), await existing.text()).toBe(200)
  }

  const hydrationApi = '**/api/tree'
  let releaseHydration!: () => void
  const hydrationGate = new Promise<void>((resolve) => { releaseHydration = resolve })
  let hydrationBlocked!: () => void
  const hydrationWasBlocked = new Promise<void>((resolve) => { hydrationBlocked = resolve })
  await page.route(hydrationApi, async (route) => {
    hydrationBlocked()
    await hydrationGate
    await route.continue()
  })

  const navigation = page.goto(`/vault/${path}`)
  try {
    // Initial workspace hydration owns route-led tab creation. Hold that
    // exact request without sleeping, then verify the wrapped navigation does
    // not resolve until production has naturally selected the target tab.
    await hydrationWasBlocked
    releaseHydration()
    await navigation
    expect(await page.locator(`[role="tab"][data-tab-id="${path}"]`)
      .getAttribute('aria-selected')).toBe('true')
  } finally {
    releaseHydration()
    await navigation
    await page.unroute(hydrationApi)
    if (created) {
      // Use Diary's Back command because the ordinary tab strip is hidden.
      await goBackFromDiaryDocument(page)
      await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toHaveCount(0)
      const deleted = await request.delete(`/api/posts/${path}`)
      expect(deleted.status(), await deleted.text()).toBe(200)
      expect(await deleted.json()).toEqual({ ok: true })
      expect((await request.get(`/api/posts/${path}`)).status()).toBe(404)
    }
  }
})


test('remembered Diary Calendar survives native browser reload without reopening Diary', async ({ page }) => {
  await page.goto('/vault')
  const diary = page.locator('.scope-chip').filter({ hasText: 'diary' })
  const note = page.locator('.scope-chip').filter({ hasText: 'note' })
  if (await diary.getAttribute('aria-pressed') !== 'true') await diary.click()
  await expect(page.getByTestId('diary-calendar-surface')).toBeVisible()

  // Re-unlock via the actual password dialog and opt in to device memory.
  // This exercises the real HttpOnly remembered-device grant, not a fake
  // browser-stored capability or an API fixture with a different session.
  await page.getByTestId('account-button').click()
  await page.getByTestId('account-lock-diary').click()
  await expect(note).toHaveAttribute('aria-pressed', 'true')
  await diary.click()
  await expect(page.locator('#diary-access-password')).toBeVisible()
  await page.locator('#diary-access-password').fill('e2e-diary-access-password-strong-123')
  await page.getByTestId('diary-remember-device').click()
  await page.locator('.diary-access-dialog button[type="submit"]').click()
  await expect(page.getByTestId('diary-calendar-surface')).toBeVisible()
  await expect(diary).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('nuvyn.vault.activeScope')))
    .toBe('diary')

  // Bypass the Diary fixture's page.reload override, which automatically
  // enters Diary and could mask the real application startup regression.
  const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded' })
  await page.evaluate(() => window.location.reload())
  await navigation
  await expect(page.getByTestId('diary-calendar-surface')).toBeVisible({ timeout: 15_000 })
  await expect(diary).toHaveAttribute('aria-pressed', 'true')
  await expect(note).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('#diary-access-password')).toHaveCount(0)
  expect(new URL(page.url()).pathname).toBe('/vault')
  expect(await page.evaluate(() => localStorage.getItem('nuvyn.vault.activeScope'))).toBe('diary')
})

test('opt-in remembered Diary access resumes in the same auth session and is revoked by lock', async ({ request }) => {
  const password = 'e2e-diary-access-password-strong-123'
  const unlockedResponse = await request.post('/api/diary/access/unlock', {
    data: { password, rememberDevice: true },
  })
  expect(unlockedResponse.status(), await unlockedResponse.text()).toBe(200)
  const unlocked = await readJson(unlockedResponse)
  expect(unlocked.state).toBe('UNLOCKED')
  const cookie = unlockedResponse.headers()['set-cookie'] ?? ''
  expect(cookie).toContain('nuvyn_diary_device_local_v1=')
  expect(cookie.toLowerCase()).toContain('httponly')
  expect(cookie.toLowerCase()).toContain('samesite=strict')
  expect(cookie).toContain('Path=/api/diary/access')
  expect(cookie).not.toContain(password)
  expect(unlocked).not.toHaveProperty('rememberToken')

  const restoredResponse = await request.post('/api/diary/access/resume')
  expect(restoredResponse.status(), await restoredResponse.text()).toBe(200)
  expect(await readJson(restoredResponse)).toMatchObject({
    state: 'UNLOCKED',
    capability: unlocked.capability,
    epoch: unlocked.epoch,
  })

  const lockedResponse = await request.post('/api/diary/access/lock')
  expect(lockedResponse.status(), await lockedResponse.text()).toBe(200)
  expect(lockedResponse.headers()['set-cookie']).toContain('nuvyn_diary_device_local_v1=')
  const postLock = await request.post('/api/diary/access/resume')
  expect(postLock.status(), await postLock.text()).toBe(200)
  expect(await readJson(postLock)).toEqual({ state: 'LOCKED' })
})

// The browser navigation fixture normally opens Diary after a full navigation.
// Reload through the browser itself here so no fixture access bootstrap can
// conceal a stale navbar icon on an ordinary Note workspace refresh.
test('remembered Diary access restores the unlocked navbar icon on a Note refresh', async ({ page }) => {
  await page.goto('/vault')
  const diaryChip = page.locator('.scope-chip').filter({ hasText: 'diary' })
  const noteChip = page.locator('.scope-chip').filter({ hasText: 'note' })
  await expect(noteChip).toHaveAttribute('aria-pressed', 'true')
  const icon = diaryChip.locator('.scope-chip-icon svg')
  await expect(icon).toBeVisible()
  const unlockedIcon = await icon.evaluate((node) => node.innerHTML)

  // Use the authenticated browser context, not the separate API fixture
  // session. The response sets only the server-owned HttpOnly remember cookie.
  const remember = await page.context().request.post('/api/diary/access/unlock', {
    data: { password: 'e2e-diary-access-password-strong-123', rememberDevice: true },
  })
  expect(remember.status(), await remember.text()).toBe(200)

  const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded' })
  await page.evaluate(() => { window.location.reload() })
  await navigation
  await expect(diaryChip).toBeVisible()
  await expect(noteChip).toHaveAttribute('aria-pressed', 'true')
  // Both the access state and the glyph must resolve before Diary is clicked.
  await expect.poll(() => page.evaluate(async () => {
    const { useDiaryAccessSession } = await import('/src/composables/diary/useDiaryAccessSession.ts')
    return useDiaryAccessSession().state.value
  })).toBe('UNLOCKED')
  await expect.poll(() => icon.evaluate((node) => node.innerHTML)).toBe(unlockedIcon)
  await expect(page.locator('#diary-access-password')).toHaveCount(0)
})

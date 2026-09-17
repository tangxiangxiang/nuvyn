import { expect, test, DIARY_ACCESS_CAPABILITY_HEADER } from './fixtures/diary'

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
      await page.locator(`[role="tab"][data-tab-id="${path}"] .tab-close`).click()
      const deleted = await request.delete(`/api/posts/${path}`)
      expect(deleted.status(), await deleted.text()).toBe(200)
      expect(await deleted.json()).toEqual({ ok: true })
      expect((await request.get(`/api/posts/${path}`)).status()).toBe(404)
    }
  }
})

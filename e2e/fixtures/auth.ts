import {
  test as base,
  expect,
  type APIRequestContext,
  type BrowserContext,
} from '@playwright/test'

type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>

const DEFAULT_BASE_URL = 'http://127.0.0.1:4174'
const SETUP_TOKEN = process.env.NUVYN_SETUP_TOKEN
  ?? 'nuvyn-e2e-setup-token-0123456789abcdef'

/**
 * Playwright fixture for Phase 3 application tests.
 *
 * The worker performs one real Phase 2 setup request against the freshly
 * started E2E server. Browser contexts and APIRequestContext instances then
 * receive the resulting HttpOnly-style session through the same storageState;
 * no localStorage token or auth bypass is involved.
 */
export const test = base.extend<{}, { authStorageState: StorageState }>({
  authStorageState: [async ({ playwright }, use) => {
    const baseURL = process.env.NUVYN_PUBLIC_ORIGIN
      ?? DEFAULT_BASE_URL
    const api = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: { Origin: baseURL },
    })
    try {
      const setup = await api.post('/api/auth/setup', {
        data: {
          bootstrapToken: SETUP_TOKEN,
          username: 'e2e-owner',
          password: 'e2e-owner-password-strong-123',
        },
      })
      if (setup.status() === 409) {
        // Dedicated multi-project PDF configs reuse one isolated server. A
        // later project must establish its own session without treating the
        // already-created singleton owner as a test failure.
        const login = await api.post('/api/auth/login', {
          data: {
            username: 'e2e-owner',
            password: 'e2e-owner-password-strong-123',
          },
        })
        expect(login.status(), await login.text()).toBe(200)
      } else {
        expect(setup.status(), await setup.text()).toBe(201)
      }
      const status = await api.get('/api/auth/status')
      expect(status.status(), await status.text()).toBe(200)
      expect(await status.json()).toMatchObject({ authenticated: true })
      await use(await api.storageState())
    } finally {
      await api.dispose()
    }
  }, { scope: 'worker' }],

  // Built-in browser contexts consume the worker-owned real session.
  storageState: ({ authStorageState }, use) => use(authStorageState),

  // Playwright's standalone request fixture does not inherit browser context
  // cookies. Recreate it with the same storage state so helpers using
  // request.post/get/put/delete are authenticated too.
  request: async ({ playwright, baseURL, storageState }, use) => {
    const api = await playwright.request.newContext({ baseURL, storageState })
    try {
      await use(api)
    } finally {
      await api.dispose()
    }
  },
})

export { expect }
export type { APIRequestContext }

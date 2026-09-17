import { defineConfig, devices } from '@playwright/test'
import os from 'node:os'
import path from 'node:path'

const port = 4176
const tempRoot = os.tmpdir()
process.env.NUVYN_DRAFT_E2E_VAULT = path.join(tempRoot, 'nuvyn-auth-browser-vault-4176')
process.env.NUVYN_E2E_DB_PATH = path.join(tempRoot, 'nuvyn-auth-browser-db-4176', 'data', 'nuvyn.db')
process.env.NUVYN_PUBLIC_ORIGIN = `http://127.0.0.1:${port}`
process.env.NUVYN_SETUP_TOKEN = 'nuvyn-auth-browser-setup-token-0123456789'

export default defineConfig({
  testDir: './e2e',
  testMatch: 'auth-browser.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `"${process.execPath}" scripts/start-draft-e2e.mjs ${port}`,
    url: `http://127.0.0.1:${port}/__markdown-test?mode=reading`,
    reuseExistingServer: false,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})

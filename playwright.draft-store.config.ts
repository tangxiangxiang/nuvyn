import { defineConfig, devices } from '@playwright/test'
import os from 'node:os'
import path from 'node:path'

process.env.NUVYN_DRAFT_E2E_VAULT = path.join(os.tmpdir(), 'nuvyn-e2e-vault-4175')
process.env.NUVYN_E2E_DB_PATH = path.join(os.tmpdir(), 'nuvyn-e2e-db-4175', 'data', 'nuvyn.db')
process.env.NUVYN_PUBLIC_ORIGIN = 'http://127.0.0.1:4175'
process.env.NUVYN_SETUP_TOKEN = 'nuvyn-e2e-setup-token-0123456789abcdef'

export default defineConfig({
  testDir: './e2e',
  testMatch: ['draft-store.spec.ts', 'draft-file-transactions.spec.ts'],
  fullyParallel: false,
  // One isolated server owns one singleton auth owner/session for the whole
  // lane; separate workers would race POST /api/auth/setup against the same
  // SQLite database.
  workers: 1,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:4175',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `"${process.execPath}" scripts/start-draft-e2e.mjs`,
    url: 'http://127.0.0.1:4175/',
    reuseExistingServer: false,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})

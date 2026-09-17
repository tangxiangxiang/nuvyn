import { defineConfig, devices } from '@playwright/test'
import os from 'node:os'
import path from 'node:path'

process.env.NUVYN_DRAFT_E2E_VAULT = path.join(os.tmpdir(), 'nuvyn-e2e-vault-4174')
process.env.NUVYN_E2E_DB_PATH = path.join(os.tmpdir(), 'nuvyn-e2e-db-4174', 'data', 'nuvyn.db')
process.env.NUVYN_PUBLIC_ORIGIN = 'http://127.0.0.1:4174'
process.env.NUVYN_SETUP_TOKEN = 'nuvyn-e2e-setup-token-0123456789abcdef'

export default defineConfig({
  testDir: './e2e',
  testIgnore: [
    'draft-store.spec.ts',
    'draft-file-transactions.spec.ts',
    // The auth browser smoke owns a fresh singleton-owner database and runs
    // in its dedicated config. Shared-fixture suites must not race it.
    'auth-browser.spec.ts',
    // Pixel baselines are verified in the dedicated macOS visual job.
    'markdown-visual.spec.ts',
  ],
  fullyParallel: false,
  // These integration flows mutate one shared Vault and browser-side
  // persistence. File-level Playwright workers would make otherwise
  // independent specs race through the same server generation.
  workers: 1,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:4174',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `"${process.execPath}" scripts/start-draft-e2e.mjs 4174`,
    url: 'http://127.0.0.1:4174/__markdown-test?mode=reading',
    reuseExistingServer: false,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})

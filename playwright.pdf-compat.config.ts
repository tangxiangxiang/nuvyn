import { defineConfig, devices } from '@playwright/test'
import os from 'node:os'
import path from 'node:path'

const port = 4177
process.env.NUVYN_DRAFT_E2E_VAULT = path.join(os.tmpdir(), 'nuvyn-e2e-vault-4177')
process.env.NUVYN_E2E_DB_PATH = path.join(os.tmpdir(), 'nuvyn-e2e-db-4177', 'data', 'nuvyn.db')
process.env.NUVYN_PUBLIC_ORIGIN = `http://127.0.0.1:${port}`
process.env.NUVYN_SETUP_TOKEN = 'nuvyn-e2e-compat-setup-token-0123456789'

export default defineConfig({
  testDir: './e2e',
  testMatch: 'pdf-export-compat.spec.ts',
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
  projects: [
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
    {
      name: 'chromium-dpi2',
      use: { ...devices['Desktop Chrome'], deviceScaleFactor: 2 },
    },
  ],
})

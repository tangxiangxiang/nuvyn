import { defineConfig, devices } from '@playwright/test'
import os from 'node:os'
import path from 'node:path'

process.env.NUVYN_DRAFT_E2E_VAULT = path.join(os.tmpdir(), 'nuvyn-e2e-vault-4174')
process.env.NUVYN_E2E_DB_PATH = path.join(os.tmpdir(), 'nuvyn-e2e-db-4174', 'data', 'nuvyn.db')
process.env.NUVYN_PUBLIC_ORIGIN = 'http://127.0.0.1:4174'
process.env.NUVYN_SETUP_TOKEN = 'nuvyn-e2e-setup-token-0123456789abcdef'

export default defineConfig({
  testDir: './e2e',
  // IndexedDB transaction suites use a single dedicated Vite origin/config so
  // they cannot race the visual/view-mode workers over database lifecycle.
  testIgnore: ['draft-store.spec.ts', 'draft-file-transactions.spec.ts', 'auth-browser.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:4174',
    trace: 'retain-on-failure',
  },
  webServer: {
    // `npm exec` resolves vite from the local node_modules/.bin under BOTH
    // npm- and pnpm-managed layouts; `pnpm exec` re-installs per
    // pnpm-lock.yaml on an npm-managed tree, re-laying node_modules out
    // mid-run so the Playwright CLI and the collected specs resolve two
    // distinct physical @playwright/test instances ("did not expect test()
    // to be called here"). Matches the draft-store config's npm exec.
    command: `"${process.execPath}" scripts/start-draft-e2e.mjs 4174`,
    url: 'http://127.0.0.1:4174/__markdown-test?mode=reading',
    // Auth fixture setup mutates the server owner/session state. Never attach
    // it to an arbitrary developer-owned process already listening on 4174.
    reuseExistingServer: false,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})

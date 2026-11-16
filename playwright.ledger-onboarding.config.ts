import { defineConfig, devices } from '@playwright/test'

const port = 4178
const baseURL = `http://127.0.0.1:${port}`
process.env.NUVYN_PUBLIC_ORIGIN = baseURL
process.env.NUVYN_SETUP_TOKEN = 'nuvyn-ledger-onboarding-setup-token-0123456789'

export default defineConfig({
  testDir: './e2e',
  testMatch: 'ledger-onboarding.spec.ts',
  outputDir: 'test-results/ledger-onboarding',
  use: { baseURL, trace: 'retain-on-failure' },
  webServer: {
    command: `"${process.execPath}" scripts/start-draft-e2e.mjs ${port} --fresh`,
    url: `${baseURL}/__markdown-test?mode=reading`,
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})

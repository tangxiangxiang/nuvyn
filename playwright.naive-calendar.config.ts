import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: 'naive-calendar-compatibility.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:4175',
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: `"${process.execPath}" node_modules/vite/bin/vite.js --config vite.naive-calendar.config.ts --host 127.0.0.1 --port 4175`,
    url: 'http://127.0.0.1:4175/',
    reuseExistingServer: false,
  },
})

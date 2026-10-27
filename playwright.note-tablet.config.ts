import { defineConfig, devices } from '@playwright/test'
import base from './playwright.cross-platform.config'

export default defineConfig(base, {
  testMatch: 'note-tablet.spec.ts',
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], hasTouch: true } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], hasTouch: true } },
  ],
})

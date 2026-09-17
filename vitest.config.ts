import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  test: {
    exclude: ['e2e/**', 'node_modules/**', 'dist/**', 'server/__tests__/**/*.scale.test.ts'],
    environment: 'node',
    environmentMatchGlobs: [
      ['src/**/*.test.ts', 'jsdom'],
    ],
  },
})

import { defineConfig, mergeConfig } from 'vitest/config'
import baseConfig from './vitest.config'

/**
 * History tests exercise the real Git CLI and filesystem. Run these files as
 * one bounded integration lane so Windows runners do not schedule several
 * repositories and git.exe processes concurrently with one another.
 */
export default mergeConfig(baseConfig, defineConfig({
  test: {
    include: [
      'server/__tests__/history-git.test.ts',
      'server/__tests__/history-routes.test.ts',
      'server/__tests__/history-folder-coordination.test.ts',
      'server/__tests__/ai-history-commit-message.test.ts',
      'server/__tests__/edit-program-closure.test.ts',
    ],
    testTimeout: 30_000,
    // The long-tail contention is primarily a Windows runner problem. Keep
    // the integration lane isolated there while retaining parallel files on
    // Unix hosts where the existing suite is stable.
    fileParallelism: process.platform !== 'win32',
    maxWorkers: process.platform === 'win32' ? 1 : undefined,
  },
}))

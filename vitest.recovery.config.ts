import { defineConfig, mergeConfig } from 'vitest/config'
import baseConfig from './vitest.config'
import { RECOVERY_INTEGRATION_TIMEOUT_MS } from './server/__tests__/helpers/recoveryIntegration'

/**
 * Crash-recovery tests exercise real filesystem protocols, subprocesses, and
 * SQLite state. Keep them out of the unit lane and serialize them on Windows,
 * where concurrent filesystem-heavy workers create long-tail timing and file
 * handle contention.
 */
export default mergeConfig(baseConfig, defineConfig({
  test: {
    include: [
      'server/__tests__/crashRecovery.test.ts',
      'server/__tests__/crashRecovery.state-machine.test.ts',
      'server/__tests__/atomicTextWrite.test.ts',
      'server/__tests__/documentFileLifecycle.test.ts',
      'server/__tests__/createOnlyMove.test.ts',
    ],
    testTimeout: RECOVERY_INTEGRATION_TIMEOUT_MS,
    fileParallelism: process.platform !== 'win32',
    maxWorkers: process.platform === 'win32' ? 1 : undefined,
  },
}))

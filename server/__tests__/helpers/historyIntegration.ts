import { promises as fs } from 'node:fs'
import { describe } from 'vitest'

/**
 * Real Git integration tests include process, filesystem, and repository
 * cleanup work. Keep their failure ceiling separate from Vitest's 5s unit
 * test default so slow Windows runners do not turn normal tail latency into
 * flaky failures.
 */
export const HISTORY_GIT_INTEGRATION_TIMEOUT_MS = 30_000

export function describeHistoryIntegration(name: string, factory: () => void) {
  return describe(name, { timeout: HISTORY_GIT_INTEGRATION_TIMEOUT_MS }, factory)
}

/**
 * Git can briefly retain an index or pack handle after a child exits on
 * Windows. Retrying cleanup here keeps that OS-specific detail out of every
 * integration suite while preserving immediate cleanup on other platforms.
 */
export async function cleanupHistoryTempRepo(root: string): Promise<void> {
  await fs.rm(root, {
    recursive: true,
    force: true,
    maxRetries: process.platform === 'win32' ? 10 : 3,
    retryDelay: 100,
  })
}

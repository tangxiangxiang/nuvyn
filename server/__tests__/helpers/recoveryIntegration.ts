import { promises as fs } from 'node:fs'

/**
 * Shared boundaries for the real-filesystem crash-recovery integration lane.
 * Keep these values local to recovery tests instead of widening Vitest's
 * default timeout for ordinary unit tests.
 */
export const RECOVERY_INTEGRATION_TIMEOUT_MS = 30_000
export const RECOVERY_MODEL_TIMEOUT_MS = 600_000

export function throwIfRecoveryAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error('recovery test aborted')
}

/** Windows can keep a just-touched file handle open briefly after a test. */
export async function cleanupRecoveryTempDir(dir: string): Promise<void> {
  const maxAttempts = process.platform === 'win32' ? 5 : 1
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await fs.rm(dir, {
        recursive: true,
        force: true,
        maxRetries: process.platform === 'win32' ? 3 : 0,
        retryDelay: 100,
      })
      return
    } catch (error) {
      if (attempt === maxAttempts - 1) throw error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}

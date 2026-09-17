import { createHash } from 'node:crypto'
import { CONTENT_DIR } from './paths.js'

/**
 * Stable per-vault identity used to scope browser-local tabs and recovery
 * records. Keep this algorithm byte-for-byte compatible with the former
 * /api/health response: changing it would orphan existing local state.
 */
export function getVaultId(): string {
  return createHash('sha256').update(CONTENT_DIR).digest('hex').slice(0, 12)
}

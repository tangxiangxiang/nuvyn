/**
 * AI live workspace context access for components (Edit-10.2).
 *
 * The active workspace tab — not the route — decides the AI context.
 * This composable is a thin, stateless reader over `VaultContext.ai`:
 * inside a vault it captures whatever workspace tab is truly active
 * (Document / History / Diff / Recovery); outside a vault it answers
 * the fail-closed `{ status: 'none' }`.
 *
 * Deliberately has: no module state, no route reading, no `getPost`,
 * no `useCurrentNote` fallback. The route is at most one input to the
 * workspace's own `activeWorkspaceTabId`; it is never the AI authority.
 */
import type { AiLiveContextCapture } from './aiLiveContext'
import { useOptionalVaultContext } from './context/useVaultContext'

export interface AiLiveContextApi {
  /**
   * Synchronously capture one immutable snapshot of the active
   * workspace tab. Safe to call at any time — before the workspace
   * viewers exist the vault provider's delegate answers `none`.
   */
  capture(): AiLiveContextCapture
}

export function useAiLiveContext(): AiLiveContextApi {
  const vaultContext = useOptionalVaultContext()
  return {
    capture(): AiLiveContextCapture {
      return vaultContext?.ai.capture() ?? { status: 'none' }
    },
  }
}

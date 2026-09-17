// Vault-scoped reactive state for the reading-mode TOC panel. ReadingPane
// writes it while sibling RightRail and LinksPanel consume it through context.
// Exported refs below are a compatibility fallback for provider-less tests.

import { ref, type Ref } from 'vue'
import type { Heading } from './useMarkdownRender'
import { useOptionalVaultContext } from './context/useVaultContext'

export interface VaultTocState {
  tocHeadings: Ref<Heading[]>
  tocActiveId: Ref<string>
  tocScrollTo: Ref<((id: string) => void) | null>
  linksEmpty: Ref<boolean>
}

export function createVaultTocState(): VaultTocState {
  return {
    tocHeadings: ref([]),
    tocActiveId: ref(''),
    tocScrollTo: ref(null),
    linksEmpty: ref(true),
  }
}

const legacyTocState = createVaultTocState()

export const tocHeadings = legacyTocState.tocHeadings
export const tocActiveId = legacyTocState.tocActiveId
export const tocScrollTo = legacyTocState.tocScrollTo

/* Whether the Links half of the right rail has nothing to show.
   Written by LinksPanel via a watchEffect on its own `isEmpty`
   computed (which depends on the async backlinks fetch + the
   link index), read by RightRail to drive the right-rail collapse
   (when exactly one half is empty, the empty half is hidden and
   the populated one fills the column). */
export const linksEmpty = legacyTocState.linksEmpty

export function useVaultTocState(): VaultTocState {
  return useOptionalVaultContext()?.toc ?? legacyTocState
}

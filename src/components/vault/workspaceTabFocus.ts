import { nextTick } from 'vue'

export function focusedWorkspaceTabId(targetDocument: Document = document): string | null {
  const activeElement = targetDocument.activeElement
  return activeElement instanceof Element
    ? activeElement.closest<HTMLElement>('[data-tab-id]')?.dataset.tabId ?? null
    : null
}

export async function restoreRenamedWorkspaceTabFocus(
  focusedId: string | null,
  mappings: ReadonlyArray<{ from: string; to: string }>,
  focusTab: (id: string) => void,
  expectedFocus?: Element | null,
  targetDocument: Document = document,
): Promise<boolean> {
  if (!focusedId) return false
  const targetId = mappings.find(({ from }) => from === focusedId)?.to
  if (!targetId) return false
  await nextTick()
  if (expectedFocus
      && targetDocument.activeElement !== expectedFocus
      && targetDocument.activeElement !== targetDocument.body) return false
  focusTab(targetId)
  return true
}

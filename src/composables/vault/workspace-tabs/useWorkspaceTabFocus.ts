import type { Ref } from 'vue'

export interface UseWorkspaceTabFocusOptions {
  container: Readonly<Ref<HTMLElement | null>>
}

export function focusConnectedElement(element: HTMLElement | null): boolean {
  if (!element?.isConnected) return false
  element.focus()
  return true
}

export function useWorkspaceTabFocus({
  container,
}: UseWorkspaceTabFocusOptions) {
  function findTabElement(id: string): HTMLElement | null {
    const tabs = container.value?.querySelectorAll<HTMLElement>('[role="tab"]')
    if (!tabs) return null
    return [...tabs].find((tab) => tab.dataset.tabId === id) ?? null
  }

  function focusTab(id: string): boolean {
    return focusConnectedElement(findTabElement(id))
  }

  return {
    findTabElement,
    focusTab,
  }
}

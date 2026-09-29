import { readonly, shallowRef } from 'vue'

export interface LinkNavigationIntent {
  id: number
  path: string
  anchor: string
}

const intentState = shallowRef<LinkNavigationIntent | null>(null)
let nextIntentId = 0

export const linkNavigationIntent = readonly(intentState)

export function requestLinkNavigation(input: Omit<LinkNavigationIntent, 'id'>): LinkNavigationIntent {
  const intent: LinkNavigationIntent = { ...input, id: ++nextIntentId }
  intentState.value = intent
  return intent
}

export function consumeLinkNavigation(id: number): void {
  if (intentState.value?.id === id) intentState.value = null
}

export function clearLinkNavigation(): void {
  intentState.value = null
}

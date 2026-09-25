import { readonly, shallowRef } from 'vue'

export interface SearchRevealIntent {
  id: number
  path: string
  text: string
}

const intentState = shallowRef<SearchRevealIntent | null>(null)
let nextIntentId = 0

export const searchRevealIntent = readonly(intentState)

export function requestSearchReveal(input: Omit<SearchRevealIntent, 'id'>): SearchRevealIntent {
  const intent: SearchRevealIntent = { ...input, id: ++nextIntentId }
  intentState.value = intent
  return intent
}

export function consumeSearchReveal(id: number): void {
  if (intentState.value?.id === id) intentState.value = null
}

export function clearSearchReveal(): void {
  intentState.value = null
}

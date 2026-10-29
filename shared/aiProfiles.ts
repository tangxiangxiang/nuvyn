export type AiProvider = 'anthropic' | 'openai'

export interface AiProfile {
  id: string
  name: string
  provider: AiProvider
  baseURL: string
  model: string
  configured: boolean
  maskedKey: string
  createdAt: number
  updatedAt: number
  credentialError?: string
}

export interface AiProfileList {
  profiles: AiProfile[]
  activeProfileId: string | null
  migrationError?: string
}

export interface AiProfileInput {
  name?: string
  provider?: AiProvider
  apiKey?: string
  clearKey?: boolean
  baseURL?: string
  model?: string
  /** Explicit consent to reuse this profile's key with a different protocol. */
  confirmProviderChange?: boolean
}

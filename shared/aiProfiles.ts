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

export interface AiSpeechSettings {
  profileId: string | null
  privacyConsent: boolean
  voiceId: SpeechVoiceId
}

export const SPEECH_VOICE_IDS = ['audiobook_male_1', 'audiobook_female_1', 'male-qn-qingse', 'male-qn-jingying', 'female-shaonv', 'female-yujie'] as const
export type SpeechVoiceId = typeof SPEECH_VOICE_IDS[number]
export const DEFAULT_SPEECH_VOICE: SpeechVoiceId = 'audiobook_male_1'
export function isSpeechVoiceId(value: unknown): value is SpeechVoiceId {
  return SPEECH_VOICE_IDS.some((id) => id === value)
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

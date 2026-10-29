import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { AiProfile, AiProfileInput, AiProfileList, AiProvider } from '../../shared/aiProfiles.js'
import { decryptApiKey, encryptApiKey, isEncryptedFormat } from './keyEncryption.js'
import {
  AiKeyConfigurationError, DEFAULT_ANTHROPIC_MODEL, DEFAULT_OPENAI_MODEL,
  MAX_AI_API_KEY_LENGTH, MAX_AI_BASE_URL_LENGTH, MAX_AI_MODEL_LENGTH,
  normalizeOpenAiBaseURL, readStoredAiSettingsReadOnly,
  resolveExistingMasterKey, resolveOrCreateMasterKey,
  type AiRuntimeConfig,
  type SaveAiSettingsInput, type StoredAiSettings,
} from './settings.js'

interface ProfileRow {
  id: string
  name: string
  provider: AiProvider
  encrypted_api_key: string
  base_url: string
  model: string
  created_at: number
  updated_at: number
}

export class AiProfileError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

const IMPORTED = 'ai.profiles.imported.v1'
const ACTIVE = 'ai.active.profileId'
const failedImports = new WeakMap<Database, AiKeyConfigurationError>()
function setting(db: Database, key: string): string {
  return (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? ''
}
function putSetting(db: Database, key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value)
}
export function profilesImported(db: Database): boolean { return setting(db, IMPORTED) === '1' }

/** One transactional import. Modern ciphertext is copied verbatim, so missing
 * master keys cannot prevent metadata recovery. Only historical formats need
 * decryption/re-encryption; all keys must be readable before creating a key.
 * Original settings (including ai.encryption.key) are retained, never dual-written.
 */
export function initializeAiProfiles(db: Database, retry = false): void {
  if (profilesImported(db)) return
  const failed = failedImports.get(db)
  if (failed && !retry) throw failed
  try {
    db.transaction(() => {
      if (profilesImported(db)) return
      const providers = (['anthropic', 'openai'] as const).filter((provider) =>
        ['apiKey', 'baseURL', 'model'].some((field) => Boolean(setting(db, `ai.${provider}.${field}`))),
      )
      const hasKeys = providers.some((p) => Boolean(setting(db, `ai.${p}.apiKey`)))
      const requiresConversion = hasKeys && (Boolean(setting(db, 'ai.encryption.key'))
        || providers.some((p) => {
          const key = setting(db, `ai.${p}.apiKey`)
          return key && !isEncryptedFormat(key)
        }))
      const legacy = requiresConversion ? readStoredAiSettingsReadOnly(db) : undefined
      // readStoredAiSettingsReadOnly has already verified *every* ciphertext.
      const key = legacy && hasKeys ? resolveOrCreateMasterKey() : undefined
      const now = Date.now()
      for (const provider of providers) {
        const raw = setting(db, `ai.${provider}.apiKey`)
        const encrypted = legacy && raw ? encryptApiKey(legacy[provider].apiKey, key!) : raw
        db.prepare(`INSERT INTO ai_profiles
          (id, name, provider, encrypted_api_key, base_url, model, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
          `legacy-${provider}`, provider === 'openai' ? 'OpenAI' : 'Anthropic', provider, encrypted,
          setting(db, `ai.${provider}.baseURL`), setting(db, `ai.${provider}.model`), now, now,
        )
      }
      const previous = setting(db, 'ai.active.provider') === 'openai' ? 'openai' : 'anthropic'
      // Do not silently activate the other protocol if the old active slot was empty.
      putSetting(db, ACTIVE, providers.includes(previous) ? `legacy-${previous}` : '')
      putSetting(db, IMPORTED, '1')
    })()
    failedImports.delete(db)
  } catch (error) {
    if (error instanceof AiKeyConfigurationError) failedImports.set(db, error)
    throw error
  }
}

function rows(db: Database): ProfileRow[] {
  return db.prepare('SELECT * FROM ai_profiles ORDER BY created_at, id').all() as ProfileRow[]
}
function row(db: Database, id: string): ProfileRow {
  initializeAiProfiles(db)
  const value = db.prepare('SELECT * FROM ai_profiles WHERE id = ?').get(id) as ProfileRow | undefined
  if (!value) throw new AiProfileError('ai-profile-not-found', 'AI profile not found', 404)
  return value
}
function decrypt(row: ProfileRow): string {
  if (!row.encrypted_api_key) return ''
  if (!isEncryptedFormat(row.encrypted_api_key)) throw new AiKeyConfigurationError('stored-key-invalid', 'The stored AI credential is invalid')
  const key = resolveExistingMasterKey()
  if (!key) throw new AiKeyConfigurationError('master-key-required', 'Restore the original AI master key before using this credential')
  try { return decryptApiKey(row.encrypted_api_key, key) } catch {
    throw new AiKeyConfigurationError('master-key-invalid', 'The AI master key does not match this credential')
  }
}
function view(value: ProfileRow): AiProfile {
  let credentialError: string | undefined
  try { decrypt(value) } catch (error) {
    if (!(error instanceof AiKeyConfigurationError)) throw error
    credentialError = error.code
  }
  return {
    id: value.id, name: value.name, provider: value.provider, baseURL: value.base_url,
    model: value.model, configured: Boolean(value.encrypted_api_key),
    // A fixed mask also works when the master key is unavailable.
    maskedKey: value.encrypted_api_key ? '••••••••' : '',
    createdAt: value.created_at, updatedAt: value.updated_at,
    ...(credentialError ? { credentialError } : {}),
  }
}
export function listAiProfiles(db: Database): AiProfileList {
  try { initializeAiProfiles(db) } catch (error) {
    if (!(error instanceof AiKeyConfigurationError)) throw error
    // Failed historical-format imports remain atomic. Expose only original
    // metadata so explicit credential recovery remains possible without a key.
    const profiles = (['anthropic', 'openai'] as const).flatMap((provider) => {
      if (!['apiKey', 'baseURL', 'model'].some((f) => setting(db, `ai.${provider}.${f}`))) return []
      return [{ id: `legacy-${provider}`, name: provider === 'openai' ? 'OpenAI' : 'Anthropic', provider,
        baseURL: setting(db, `ai.${provider}.baseURL`), model: setting(db, `ai.${provider}.model`),
        configured: Boolean(setting(db, `ai.${provider}.apiKey`)), maskedKey: setting(db, `ai.${provider}.apiKey`) ? '••••••••' : '',
        createdAt: 0, updatedAt: 0, credentialError: error.code }]
    })
    const activeId = `legacy-${setting(db, 'ai.active.provider') === 'openai' ? 'openai' : 'anthropic'}`
    return { profiles, activeProfileId: profiles.some((p) => p.id === activeId) ? activeId : null, migrationError: error.code }
  }
  return { profiles: rows(db).map(view), activeProfileId: setting(db, ACTIVE) || null }
}

function validate(input: AiProfileInput, existing?: ProfileRow): { name: string; provider: AiProvider; baseURL: string; model: string } {
  const name = (input.name ?? existing?.name ?? '').trim()
  const provider = input.provider ?? existing?.provider
  const baseURL = (input.baseURL ?? existing?.base_url ?? '').trim()
  const model = (input.model ?? existing?.model ?? '').trim()
  if (!name || name.length > 100) throw new AiProfileError('ai-profile-invalid', 'Profile name must contain 1–100 characters')
  if (provider !== 'anthropic' && provider !== 'openai') throw new AiProfileError('ai-profile-invalid', 'Unsupported AI protocol')
  if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > MAX_AI_API_KEY_LENGTH)) throw new AiProfileError('ai-profile-invalid', 'Invalid API key length')
  if (model.length > MAX_AI_MODEL_LENGTH || (model && !/^[A-Za-z0-9._:/[\]-]+$/.test(model))) throw new AiProfileError('ai-profile-invalid', 'Invalid model name')
  if (baseURL.length > MAX_AI_BASE_URL_LENGTH) throw new AiProfileError('ai-profile-invalid', 'Base URL is too long')
  if (baseURL) {
    try {
      const url = new URL(baseURL)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error()
    } catch { throw new AiProfileError('ai-profile-invalid', 'Base URL must be an http(s) API root without credentials, query or fragment') }
  }
  return { name, provider, model, baseURL: provider === 'openai' ? normalizeOpenAiBaseURL(baseURL) : baseURL }
}

function newCiphertext(db: Database, input: AiProfileInput, existing?: ProfileRow): string {
  if (input.clearKey) return ''
  const key = input.apiKey?.trim()
  if (!key) return existing?.encrypted_api_key ?? ''
  // Never generate a replacement master key while any stored ciphertext exists.
  const encrypted = rows(db).filter((p) => p.encrypted_api_key)
  for (const profile of encrypted) decrypt(profile)
  return encryptApiKey(key, resolveOrCreateMasterKey())
}
export function createAiProfile(db: Database, input: AiProfileInput): AiProfile {
  initializeAiProfiles(db)
  const values = validate(input)
  const id = randomUUID()
  const now = Date.now()
  db.transaction(() => {
    db.prepare('INSERT INTO ai_profiles VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      id, values.name, values.provider, newCiphertext(db, input), values.baseURL, values.model, now, now,
    )
  })()
  return view(row(db, id))
}
export function updateAiProfile(db: Database, id: string, input: AiProfileInput): AiProfile {
  // Explicit recovery of an original, unimportable historical credential.
  if (!profilesImported(db) && input.clearKey && /^legacy-(anthropic|openai)$/.test(id)) {
    const provider = id.slice(7)
    const exists = ['apiKey', 'baseURL', 'model'].some((f) => setting(db, `ai.${provider}.${f}`))
    if (!exists) throw new AiProfileError('ai-profile-not-found', 'AI profile not found', 404)
    db.transaction(() => {
      db.prepare('DELETE FROM settings WHERE key = ?').run(`ai.${provider}.apiKey`)
      // Preserve an otherwise empty profile identity after explicit key removal.
      if (!setting(db, `ai.${provider}.model`)) putSetting(db, `ai.${provider}.model`, provider === 'openai' ? DEFAULT_OPENAI_MODEL : DEFAULT_ANTHROPIC_MODEL)
    })()
    failedImports.delete(db)
    const result = listAiProfiles(db).profiles.find((p) => p.id === id)
    if (result) return result
  }
  const current = row(db, id)
  const values = validate(input, current)
  if (values.provider !== current.provider && current.encrypted_api_key && !input.clearKey && !input.apiKey?.trim() && !input.confirmProviderChange) {
    throw new AiProfileError('ai-profile-protocol-confirmation-required', 'Confirm credential reuse when changing the protocol', 409)
  }
  db.transaction(() => {
    db.prepare(`UPDATE ai_profiles SET name=?, provider=?, encrypted_api_key=?, base_url=?, model=?, updated_at=? WHERE id=?`).run(
      values.name, values.provider, newCiphertext(db, input, current), values.baseURL, values.model, Date.now(), id,
    )
  })()
  return view(row(db, id))
}
export function profileRuntime(db: Database, id: string): AiRuntimeConfig {
  const profile = row(db, id)
  const apiKey = decrypt(profile)
  return { provider: profile.provider, apiKey: apiKey || undefined, baseURL: profile.base_url || undefined,
    model: profile.model || (profile.provider === 'openai' ? DEFAULT_OPENAI_MODEL : DEFAULT_ANTHROPIC_MODEL), source: apiKey ? 'db' : 'none' }
}
export function profileProbeConfig(db: Database, id: string | undefined, input: AiProfileInput) {
  initializeAiProfiles(db)
  const saved = id ? row(db, id) : undefined
  const values = validate({ ...input, name: input.name?.trim() || saved?.name || 'Connection test' }, saved)
  if (saved && values.provider !== saved.provider && !input.apiKey?.trim() && !input.confirmProviderChange) {
    throw new AiProfileError('ai-profile-protocol-confirmation-required', 'Confirm credential reuse when changing the protocol', 409)
  }
  const apiKey = input.apiKey?.trim() || (saved && !input.clearKey ? decrypt(saved) : '')
  if (!apiKey) throw new AiProfileError('ai-authentication-failed', 'AI API key is not configured', 503)
  return { provider: values.provider, apiKey, baseURL: values.baseURL || undefined,
    model: values.model || (values.provider === 'openai' ? DEFAULT_OPENAI_MODEL : DEFAULT_ANTHROPIC_MODEL) }
}
export function activeProfileRuntime(db: Database): AiRuntimeConfig {
  initializeAiProfiles(db)
  const id = setting(db, ACTIVE)
  return id ? profileRuntime(db, id) : { provider: 'anthropic', model: DEFAULT_ANTHROPIC_MODEL, source: 'none' }
}
export function activateAiProfile(db: Database, id: string): void {
  db.transaction(() => {
    const config = profileRuntime(db, id)
    if (!config.apiKey) throw new AiProfileError('ai-profile-unconfigured', 'Save an API key before setting this profile as default', 409)
    putSetting(db, ACTIVE, id)
  })()
}
export function deleteAiProfile(db: Database, id: string, disableDefault: boolean): void {
  row(db, id)
  db.transaction(() => {
    if (setting(db, ACTIVE) === id) {
      if (!disableDefault) throw new AiProfileError('ai-profile-active', 'Select another default or explicitly disable AI before deleting this profile', 409)
      putSetting(db, ACTIVE, '')
    }
    db.prepare('DELETE FROM ai_profiles WHERE id=?').run(id)
  })()
}

/** The compatibility API can target only one unambiguous profile. */
export function legacyProfileId(db: Database, provider?: AiProvider): string | null {
  initializeAiProfiles(db)
  if (!provider) return setting(db, ACTIVE) || null
  const matches = rows(db).filter((p) => p.provider === provider)
  if (matches.length > 1) throw new AiProfileError('ai-profile-ambiguous', 'Use the profile API to select a specific configuration', 409)
  return matches[0]?.id ?? null
}

export function saveLegacyProfile(db: Database, input: SaveAiSettingsInput): void {
  db.transaction(() => {
    initializeAiProfiles(db)
    const id = legacyProfileId(db, input.provider)
    const provider = input.provider ?? (id ? row(db, id).provider : 'anthropic')
    const profile = id ? updateAiProfile(db, id, { ...input, clearKey: input.apiKey === '' })
      : createAiProfile(db, { ...input, provider, name: provider === 'openai' ? 'OpenAI' : 'Anthropic' })
    // Compatibility writes historically selected the target, including an empty
    // slot. New Profile creation has no such side effect.
    putSetting(db, ACTIVE, profile.id)
  })()
}

export function clearLegacyProfileKey(db: Database, provider?: AiProvider): { cleared: true; provider: AiProvider } {
  const id = legacyProfileId(db, provider)
  const target = provider ?? (id ? row(db, id).provider : 'anthropic')
  if (id) updateAiProfile(db, id, { clearKey: true })
  return { cleared: true, provider: target }
}

/** Older callers have only protocol slots. Never select a random same-protocol
 * profile; metadata status aggregates key presence without decryption. */
export function legacySettingsSnapshot(db: Database, decryptKeys = true): StoredAiSettings {
  initializeAiProfiles(db)
  const active = setting(db, ACTIVE)
  const all = rows(db)
  const provider = all.find((p) => p.id === active)?.provider ?? 'anthropic'
  const config = (protocol: AiProvider) => {
    const matches = all.filter((p) => p.provider === protocol)
    if (!decryptKeys) return { apiKey: matches.some((p) => p.encrypted_api_key) ? 'stored' : '', baseURL: '', model: '' }
    if (matches.length > 1) throw new AiProfileError('ai-profile-ambiguous', 'Use the profile API for same-protocol configurations', 409)
    const value = matches[0]
    return value ? { apiKey: decrypt(value), baseURL: value.base_url,
      model: value.model || (protocol === 'openai' ? DEFAULT_OPENAI_MODEL : DEFAULT_ANTHROPIC_MODEL) }
      : { apiKey: '', baseURL: '', model: protocol === 'openai' ? DEFAULT_OPENAI_MODEL : DEFAULT_ANTHROPIC_MODEL }
  }
  return { provider, anthropic: config('anthropic'), openai: config('openai') }
}

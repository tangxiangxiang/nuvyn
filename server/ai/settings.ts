// AI provider settings stored in SQLite.
//
// API keys are encrypted with AES-256-GCM. SQLite only stores the ciphertext,
// IV and auth tag. An explicitly supplied NUVYN_MASTER_KEY or
// NUVYN_MASTER_KEY_FILE takes precedence; otherwise Nuvyn creates a separate
// local secret file next to the database. The master key is never stored in
// SQLite. Existing databases that contain ai.encryption.key are migrated
// transactionally on first access.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Database as DatabaseT } from 'better-sqlite3'
import {
  decryptApiKey,
  encryptApiKey,
  isEncryptedFormat,
} from './keyEncryption.js'
import { NUVYN_MASTER_KEY_FILE_NAME } from '../technicalNamespace.js'

export const SUPPORTED_PROVIDERS = ['anthropic', 'openai'] as const
export type Provider = typeof SUPPORTED_PROVIDERS[number]
export type AiSettingsSource = 'db' | 'none'

export interface StoredProviderConfig {
  apiKey: string
  baseURL: string
  model: string
}

export interface StoredAiSettings {
  provider: Provider
  anthropic: StoredProviderConfig
  openai: StoredProviderConfig
}

export interface AiRuntimeConfig {
  apiKey?: string
  baseURL?: string
  model: string
  provider: Provider
  source: AiSettingsSource
}

export interface AiSettingsView {
  provider: Provider
  configured: boolean
  source: AiSettingsSource
  maskedKey: string
  baseURL: string
  model: string
}

export interface AiCredentialStatus {
  provider: Provider
  providers: Record<Provider, { stored: boolean }>
}

export type AiKeyConfigurationCode =
  | 'master-key-required'
  | 'master-key-invalid'
  | 'master-key-file-unreadable'
  | 'master-key-file-unwritable'
  | 'stored-key-invalid'

export type AiCompatibilityCode =
  | 'openai-base-url-invalid'
  | 'openai-tools-unsupported'

export type AiErrorCode = AiKeyConfigurationCode | AiCompatibilityCode

/** Safe-to-display configuration errors. Never include key material here. */
export class AiKeyConfigurationError extends Error {
  readonly code: AiKeyConfigurationCode

  constructor(code: AiKeyConfigurationCode, message: string) {
    super(message)
    this.name = 'AiKeyConfigurationError'
    this.code = code
  }
}

/** Validation errors for provider-specific settings. These are safe to
 * expose to clients because they never contain credentials or ciphertext. */
export class AiSettingsValidationError extends Error {
  readonly code: AiCompatibilityCode

  constructor(code: AiCompatibilityCode, message: string) {
    super(message)
    this.name = 'AiSettingsValidationError'
    this.code = code
  }
}

/* Default models per provider. baseURL is intentionally not defaulted
   here — the SDK applies its own sane default when no override is set. */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6'
export const DEFAULT_OPENAI_MODEL = 'gpt-4o'
export const MAX_AI_API_KEY_LENGTH = 256
export const MAX_AI_BASE_URL_LENGTH = 2048
export const MAX_AI_MODEL_LENGTH = 100

const KEY_ACTIVE_PROVIDER = 'ai.active.provider'
const KEY_ENCRYPTION_KEY = 'ai.encryption.key'
const KEY_MASTER_ENV = 'NUVYN_MASTER_KEY'
const KEY_MASTER_FILE_ENV = 'NUVYN_MASTER_KEY_FILE'
function defaultMasterKeyFile(): string {
  return path.resolve(process.cwd(), 'data', NUVYN_MASTER_KEY_FILE_NAME)
}

function keyApiKey(provider: Provider): string { return `ai.${provider}.apiKey` }
function keyBaseURL(provider: Provider): string { return `ai.${provider}.baseURL` }
function keyModel(provider: Provider): string { return `ai.${provider}.model` }

/**
 * OpenAI-compatible endpoints must be configured as an API root. The SDK
 * appends /chat/completions itself, so accepting a complete endpoint would
 * produce /chat/completions/chat/completions at runtime. Keep custom path
 * prefixes intact and only remove harmless trailing slashes.
 */
export function normalizeOpenAiBaseURL(input: string): string {
  const value = input.trim()
  if (!value) return ''
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new AiSettingsValidationError(
      'openai-base-url-invalid',
      'OpenAI Base URL must be an API root such as https://example.com/v1, not a full /chat/completions endpoint',
    )
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AiSettingsValidationError(
      'openai-base-url-invalid',
      'OpenAI Base URL must be an http(s) API root',
    )
  }
  const pathname = parsed.pathname.replace(/\/+$/, '')
  if (pathname === '/chat/completions' || pathname.endsWith('/chat/completions')) {
    throw new AiSettingsValidationError(
      'openai-base-url-invalid',
      'OpenAI Base URL must be the API root, for example https://example.com/v1, not the full /chat/completions endpoint',
    )
  }
  if (parsed.search || parsed.hash) {
    throw new AiSettingsValidationError(
      'openai-base-url-invalid',
      'OpenAI Base URL must not include a query string or fragment',
    )
  }
  return value.replace(/\/+$/, '')
}

function defaultModelFor(provider: Provider): string {
  return provider === 'anthropic' ? DEFAULT_ANTHROPIC_MODEL : DEFAULT_OPENAI_MODEL
}

function getSetting(db: DatabaseT, key: string): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? ''
}

function setSetting(db: DatabaseT, key: string, value: string): void {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value)
}

function deleteSetting(db: DatabaseT, key: string): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key)
}

function decodeKeyMaterial(raw: string, source: string, kind: 'master' | 'stored'): Buffer {
  const value = raw.trim()
  const invalid = () => new AiKeyConfigurationError(
    kind === 'master' ? 'master-key-invalid' : 'stored-key-invalid',
    `${source} must encode exactly 32 bytes as 64 hex characters or base64`,
  )
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, 'hex')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw invalid()
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length !== 32 || decoded.toString('base64') !== value) throw invalid()
  return decoded
}

type FallbackMasterKeyResolution =
  | { kind: 'found'; key: Buffer }
  | { kind: 'missing' }

function readFallbackMasterKey(filePath: string): FallbackMasterKeyResolution {
  let fileValue: string
  try {
    fileValue = readFileSync(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    throw new AiKeyConfigurationError(
      'master-key-file-unreadable',
      'The Nuvyn master key file could not be read',
    )
  }
  return { kind: 'found', key: decodeKeyMaterial(fileValue, filePath, 'master') }
}

function readMasterKeyFile(filePath: string): Buffer {
  const resolved = readFallbackMasterKey(filePath)
  if (resolved.kind === 'found') return resolved.key
  throw new AiKeyConfigurationError(
    'master-key-file-unreadable',
    'The Nuvyn master key file could not be read',
  )
}

function createDefaultMasterKey(filePath: string): Buffer {
  const generated = randomBytes(32)
  try {
    mkdirSync(path.dirname(filePath), { recursive: true })
    writeFileSync(filePath, `${generated.toString('base64')}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    return generated
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const resolved = readFallbackMasterKey(filePath)
      if (resolved.kind === 'found') return resolved.key
      throw new AiKeyConfigurationError(
        'master-key-file-unreadable',
        'The Nuvyn master key file disappeared while it was being created',
      )
    }
    throw new AiKeyConfigurationError(
      'master-key-file-unwritable',
      'The Nuvyn master key file could not be created; check the data directory permissions',
    )
  }
}

/**
 * Read an already-existing master key without creating one. Only a missing
 * fallback file resolves to undefined; explicit-file failures, unreadable
 * fallback files, and invalid key material remain configuration errors.
 */
export function resolveExistingMasterKey(
  env: NodeJS.ProcessEnv = process.env,
  fallbackFile = defaultMasterKeyFile(),
): Buffer | undefined {
  const canonicalConfigured = env[KEY_MASTER_ENV]?.trim()
  if (canonicalConfigured) return decodeKeyMaterial(canonicalConfigured, KEY_MASTER_ENV, 'master')

  const canonicalFile = env[KEY_MASTER_FILE_ENV]?.trim()
  if (canonicalFile) return readMasterKeyFile(canonicalFile)

  const resolved = readFallbackMasterKey(fallbackFile)
  return resolved.kind === 'found' ? resolved.key : undefined
}

/** Resolve a master key for an operation that is explicitly allowed to create
 * the fallback file, such as a first API-key save or a stored-format migration. */
export function resolveOrCreateMasterKey(
  env: NodeJS.ProcessEnv = process.env,
  fallbackFile = defaultMasterKeyFile(),
): Buffer {
  return resolveExistingMasterKey(env, fallbackFile) ?? createDefaultMasterKey(fallbackFile)
}

function requireMasterKey(masterKey: Buffer | undefined): Buffer {
  if (!masterKey) {
    throw new AiKeyConfigurationError(
      'master-key-required',
      'The Nuvyn master key is unavailable. Restore data/.nuvyn-master-key from backup, or configure NUVYN_MASTER_KEY / NUVYN_MASTER_KEY_FILE. The encrypted credentials were not modified.',
    )
  }
  return masterKey
}

function decodeStoredEncryptionKey(value: string): Buffer {
  try {
    return decodeKeyMaterial(value, KEY_ENCRYPTION_KEY, 'stored')
  } catch {
    throw new AiKeyConfigurationError(
      'stored-key-invalid',
      'The legacy database encryption key is invalid; no AI credentials were changed',
    )
  }
}

function storedApiKeyRows(db: DatabaseT): Map<Provider, string> {
  return new Map(SUPPORTED_PROVIDERS.map((provider) => [provider, getSetting(db, keyApiKey(provider))]))
}

/**
 * Resolve and, if needed, migrate every provider key before any settings are
 * exposed. All plaintext/decryption work happens before the write transaction;
 * a failed migration therefore leaves the old rows untouched.
 */
function loadAndMigrateApiKeys(db: DatabaseT, persistMigration = true): Map<Provider, string> {
  const rows = storedApiKeyRows(db)
  const legacyKeyValue = getSetting(db, KEY_ENCRYPTION_KEY)
  const hasStoredMaterial = Boolean(legacyKeyValue) || [...rows.values()].some(Boolean)
  if (!hasStoredMaterial) return new Map(SUPPORTED_PROVIDERS.map((provider) => [provider, '']))

  // First inspect existing key sources without creating anything. A fallback
  // key may be created later only after every stored ciphertext has already
  // been decrypted with an existing key or the legacy database key.
  let masterKey = resolveExistingMasterKey()
  const legacyKey = legacyKeyValue ? decodeStoredEncryptionKey(legacyKeyValue) : undefined
  const plaintext = new Map<Provider, string>()
  const providersToMigrate = new Set<Provider>()

  for (const provider of SUPPORTED_PROVIDERS) {
    const blob = rows.get(provider) ?? ''
    if (!blob) {
      plaintext.set(provider, '')
      continue
    }
    if (!isEncryptedFormat(blob)) {
      plaintext.set(provider, blob)
      if (blob) providersToMigrate.add(provider)
      continue
    }

    let decrypted: string | undefined
    let decryptedWithLegacyKey = false
    const candidates: Array<{ key: Buffer; legacy: boolean }> = []
    if (legacyKey) candidates.push({ key: legacyKey, legacy: true })
    if (masterKey) candidates.push({ key: masterKey, legacy: false })
    for (const candidate of candidates) {
      try {
        decrypted = decryptApiKey(blob, candidate.key)
        decryptedWithLegacyKey = candidate.legacy
        break
      } catch {
        // Try the next known key. No error details contain key material.
      }
    }
    if (decrypted === undefined) {
      if (!masterKey) requireMasterKey(masterKey)
      throw new AiKeyConfigurationError(
        'master-key-invalid',
        'NUVYN_MASTER_KEY does not match the encrypted AI API key',
      )
    }
    plaintext.set(provider, decrypted)
    if (decryptedWithLegacyKey) providersToMigrate.add(provider)
  }

  // A normal read of a ciphertext encrypted with the active master key is
  // deliberately read-only. Only legacy plaintext, legacy-key ciphertext,
  // or the legacy key row itself requires a write transaction.
  if (providersToMigrate.size === 0 && !legacyKeyValue) return plaintext
  if (!persistMigration) return plaintext

  // Plaintext and legacy-key ciphertext are still recoverable without the
  // fallback key, so creating one here is part of their safe migration. This
  // point is reached only after all encrypted rows were successfully read.
  masterKey ??= resolveOrCreateMasterKey()
  const migrationKey = requireMasterKey(masterKey)

  const migrate = db.transaction(() => {
    for (const provider of providersToMigrate) {
      const value = plaintext.get(provider) ?? ''
      if (value) setSetting(db, keyApiKey(provider), encryptApiKey(value, migrationKey))
      else deleteSetting(db, keyApiKey(provider))
    }
    if (legacyKeyValue) deleteSetting(db, KEY_ENCRYPTION_KEY)
  })
  migrate()
  return plaintext
}

function readActiveProvider(db: DatabaseT): Provider {
  return getSetting(db, KEY_ACTIVE_PROVIDER) === 'openai' ? 'openai' : 'anthropic'
}

function readProviderConfig(
  db: DatabaseT,
  provider: Provider,
  apiKeys: Map<Provider, string>,
): StoredProviderConfig {
  return {
    apiKey: apiKeys.get(provider) ?? '',
    baseURL: getSetting(db, keyBaseURL(provider)),
    model: getSetting(db, keyModel(provider)) || defaultModelFor(provider),
  }
}

function readStoredAiSettingsWithMigration(db: DatabaseT, persistMigration: boolean): StoredAiSettings {
  const apiKeys = loadAndMigrateApiKeys(db, persistMigration)
  return {
    provider: readActiveProvider(db),
    anthropic: readProviderConfig(db, 'anthropic', apiKeys),
    openai: readProviderConfig(db, 'openai', apiKeys),
  }
}

export function readStoredAiSettings(db: DatabaseT): StoredAiSettings {
  return readStoredAiSettingsWithMigration(db, true)
}

/** Read provider credentials without performing legacy key migration. */
export function readStoredAiSettingsReadOnly(db: DatabaseT): StoredAiSettings {
  return readStoredAiSettingsWithMigration(db, false)
}

export interface SaveAiSettingsInput {
  provider?: Provider
  apiKey?: string
  baseURL?: string
  model?: string
}

export function saveAiSettings(db: DatabaseT, input: SaveAiSettingsInput): StoredAiSettings {
  // Read/migrate before changing the active provider, so a bad master key
  // cannot leave a partially applied settings update behind.
  const current = readStoredAiSettings(db)
  const target = input.provider ?? current.provider
  const apiKey = input.apiKey?.trim()
  const baseURL = input.baseURL === undefined
    ? undefined
    : target === 'openai'
      ? normalizeOpenAiBaseURL(input.baseURL)
      : input.baseURL.trim()
  const model = input.model?.trim()
  const masterKey = apiKey ? resolveOrCreateMasterKey() : undefined

  const save = db.transaction(() => {
    if (input.provider !== undefined) setSetting(db, KEY_ACTIVE_PROVIDER, input.provider)
    if (apiKey !== undefined) {
      if (apiKey) setSetting(db, keyApiKey(target), encryptApiKey(apiKey, requireMasterKey(masterKey)))
      else deleteSetting(db, keyApiKey(target))
    }
    if (baseURL !== undefined) {
      if (baseURL) setSetting(db, keyBaseURL(target), baseURL)
      else deleteSetting(db, keyBaseURL(target))
    }
    if (model !== undefined) {
      if (model) setSetting(db, keyModel(target), model)
      else deleteSetting(db, keyModel(target))
    }
  })
  save()
  return readStoredAiSettings(db)
}

/**
 * Explicitly forget exactly one provider credential. This is intentionally a
 * raw row deletion: recovery must remain possible even when no master key is
 * available to decrypt another provider's credential (or this one).
 */
export function clearAiApiKey(
  db: DatabaseT,
  provider?: Provider,
): { cleared: true; provider: Provider } {
  const target = provider ?? readActiveProvider(db)
  const clear = db.transaction(() => deleteSetting(db, keyApiKey(target)))
  clear()
  return { cleared: true, provider: target }
}

/**
 * Read non-sensitive credential metadata without resolving or decrypting a
 * master key. This lets the settings UI offer a provider-specific recovery
 * action after a master-key-required response.
 */
export function getAiCredentialStatus(db: DatabaseT): AiCredentialStatus {
  return {
    provider: readActiveProvider(db),
    providers: {
      anthropic: { stored: Boolean(getSetting(db, keyApiKey('anthropic'))) },
      openai: { stored: Boolean(getSetting(db, keyApiKey('openai'))) },
    },
  }
}

export function maskKey(key: string): string {
  if (!key) return ''
  if (key.length <= 16) return '••••••••'
  return `${key.slice(0, 8)}...${key.slice(-8)}`
}

export function getAiRuntimeConfig(db: DatabaseT): AiRuntimeConfig {
  const stored = readStoredAiSettings(db)
  const provider = stored.provider
  const active = stored[provider]
  if (active?.apiKey) {
    return {
      apiKey: active.apiKey,
      baseURL: active.baseURL || undefined,
      model: active.model || defaultModelFor(provider),
      provider,
      source: 'db',
    }
  }
  return {
    baseURL: active?.baseURL || undefined,
    model: active?.model || defaultModelFor(provider),
    provider,
    source: 'none',
  }
}

export function getAiSettingsView(db: DatabaseT): AiSettingsView {
  const stored = readStoredAiSettings(db)
  const active = stored[stored.provider]
  return {
    provider: stored.provider,
    configured: Boolean(active.apiKey),
    source: active.apiKey ? 'db' : 'none',
    maskedKey: maskKey(active.apiKey),
    baseURL: active.baseURL,
    model: active.model,
  }
}

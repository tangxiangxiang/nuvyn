import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyMigrations } from '../db'
import { encryptApiKey, decryptApiKey } from '../ai/keyEncryption'
import { getAiRuntimeConfig, getAiSettingsView, saveAiSettings, getAiCredentialStatus } from '../ai/settings'
import { activateAiProfile, createAiProfile, deleteAiProfile, initializeAiProfiles, legacyProfileId, listAiProfiles, profileProbeConfig, profileRuntime, updateAiProfile } from '../ai/profiles'

const KEY = '44'.repeat(32)
let db: Database.Database
let root: string
const originalEnv = { key: process.env.NUVYN_MASTER_KEY, file: process.env.NUVYN_MASTER_KEY_FILE }
function kv(key: string, value: string) { db.prepare('INSERT OR REPLACE INTO settings VALUES (?, ?)').run(key, value) }
function originals() { return db.prepare("SELECT * FROM settings WHERE key LIKE 'ai.%' AND key NOT IN ('ai.profiles.imported.v1', 'ai.active.profileId') ORDER BY key").all() }
function cipher(id: string): string { return (db.prepare('SELECT encrypted_api_key AS value FROM ai_profiles WHERE id=?').get(id) as { value: string }).value }
function add(provider: 'anthropic' | 'openai' = 'anthropic', name = 'Custom') {
  return createAiProfile(db, { name, provider, apiKey: `sk-${name}-secret`, baseURL: `https://${name.toLowerCase()}.example.test${provider === 'openai' ? '/v1' : ''}`, model: name })
}
beforeEach(() => {
  process.env.NUVYN_MASTER_KEY = KEY
  delete process.env.NUVYN_MASTER_KEY_FILE
  root = mkdtempSync(path.join(os.tmpdir(), 'nuvyn-profile-'))
  vi.spyOn(process, 'cwd').mockReturnValue(root)
  db = new Database(':memory:')
  applyMigrations(db)
})
afterEach(() => {
  db.close()
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
  if (originalEnv.key === undefined) delete process.env.NUVYN_MASTER_KEY
  else process.env.NUVYN_MASTER_KEY = originalEnv.key
  if (originalEnv.file === undefined) delete process.env.NUVYN_MASTER_KEY_FILE
  else process.env.NUVYN_MASTER_KEY_FILE = originalEnv.file
})

describe('AI Profile import', () => {
  it.each([[], ['anthropic'], ['openai'], ['anthropic', 'openai']] as const)('preserves configured slots %j with idempotent restart import', (...args) => {
    const providers = args as unknown as string[]
    // it.each expands array cases into positional arguments.
    for (const provider of providers) {
      kv(`ai.${provider}.apiKey`, encryptApiKey(`sk-${provider}-fixture`, Buffer.from(KEY, 'hex')))
      kv(`ai.${provider}.model`, `${provider}-model`)
      kv(`ai.${provider}.baseURL`, `https://${provider}.example.test`)
    }
    kv('ai.active.provider', providers.includes('openai') ? 'openai' : 'anthropic')
    const before = originals()
    initializeAiProfiles(db)
    const first = listAiProfiles(db)
    expect(first.profiles).toHaveLength(providers.length)
    expect(first.activeProfileId).toBe(providers.length ? `legacy-${providers.includes('openai') ? 'openai' : 'anthropic'}` : null)
    for (const provider of providers) {
      expect(profileRuntime(db, `legacy-${provider}`)).toMatchObject({ apiKey: `sk-${provider}-fixture`, model: `${provider}-model` })
      expect(cipher(`legacy-${provider}`)).toBe((before.find((r: any) => r.key === `ai.${provider}.apiKey`) as any).value)
    }
    initializeAiProfiles(db)
    // Re-open the same isolated SQLite state to avoid in-memory memoization evidence.
    const file = path.join(root, 'restart.db')
    db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`)
    const restarted = new Database(file)
    try { applyMigrations(restarted); initializeAiProfiles(restarted); expect(listAiProfiles(restarted)).toEqual(first) } finally { restarted.close() }
    expect(originals()).toEqual(before)
  })

  it.each(['anthropic', 'openai'] as const)('retains active %s and keyless metadata', (provider) => {
    kv('ai.anthropic.model', 'custom-a')
    kv('ai.openai.baseURL', 'https://custom.test/v1')
    kv('ai.active.provider', provider)
    initializeAiProfiles(db)
    expect(listAiProfiles(db).profiles).toHaveLength(2)
    expect(getAiRuntimeConfig(db).provider).toBe(provider)
    expect(getAiRuntimeConfig(db).apiKey).toBeUndefined()
  })

  it('upgrades a persisted v38 fixture with an existing conversation without changing its original credentials', () => {
    const file = path.join(root, 'v38.db')
    const legacy = new Database(file)
    applyMigrations(legacy, 38)
    const encrypted = encryptApiKey('sk-persisted-original', Buffer.from(KEY, 'hex'))
    legacy.prepare('INSERT INTO settings VALUES (?, ?)').run('ai.openai.apiKey', encrypted)
    legacy.prepare('INSERT INTO settings VALUES (?, ?)').run('ai.active.provider', 'openai')
    legacy.prepare('INSERT INTO sessions (title, created_at, updated_at) VALUES (?, ?, ?)').run('Old conversation', 1, 1)
    const originalSession = legacy.prepare('SELECT * FROM sessions').get()
    legacy.close()
    const reopened = new Database(file)
    try {
      applyMigrations(reopened)
      initializeAiProfiles(reopened)
      expect(profileRuntime(reopened, 'legacy-openai').apiKey).toBe('sk-persisted-original')
      expect(reopened.prepare('SELECT * FROM sessions').get()).toEqual(originalSession)
      expect((reopened.prepare('SELECT value FROM settings WHERE key=?').get('ai.openai.apiKey') as { value: string }).value).toBe(encrypted)
      expect(listAiProfiles(reopened).activeProfileId).toBe('legacy-openai')
    } finally { reopened.close() }
  })

  it('does not silently select an inactive configured protocol', () => {
    kv('ai.openai.model', 'custom')
    initializeAiProfiles(db)
    expect(listAiProfiles(db).activeProfileId).toBeNull()
  })

  it.each(['plaintext', 'legacy-ciphertext'] as const)('safely imports %s without deleting original records', (format) => {
    delete process.env.NUVYN_MASTER_KEY
    const old = Buffer.alloc(32, 0x55)
    if (format === 'legacy-ciphertext') kv('ai.encryption.key', old.toString('base64'))
    kv('ai.anthropic.apiKey', format === 'plaintext' ? 'sk-old-secret' : encryptApiKey('sk-old-secret', old))
    const before = originals()
    initializeAiProfiles(db)
    expect(profileRuntime(db, 'legacy-anthropic').apiKey).toBe('sk-old-secret')
    expect(cipher('legacy-anthropic')).not.toContain('sk-old-secret')
    expect(originals()).toEqual(before)
    expect(existsSync(path.join(root, 'data', '.nuvyn-master-key'))).toBe(true)
  })

  it.each(['missing', 'wrong', 'unreadable'] as const)('exposes metadata with %s master key and preserves every ciphertext', (failure) => {
    kv('ai.anthropic.apiKey', encryptApiKey('sk-original', Buffer.from(KEY, 'hex')))
    kv('ai.anthropic.model', 'original')
    const before = originals()
    if (failure === 'missing') delete process.env.NUVYN_MASTER_KEY
    if (failure === 'wrong') process.env.NUVYN_MASTER_KEY = '66'.repeat(32)
    if (failure === 'unreadable') { delete process.env.NUVYN_MASTER_KEY; process.env.NUVYN_MASTER_KEY_FILE = path.join(root, 'missing') }
    initializeAiProfiles(db)
    expect(listAiProfiles(db).profiles[0]).toMatchObject({ model: 'original', configured: true, credentialError: expect.any(String) })
    expect(() => getAiRuntimeConfig(db)).toThrow()
    expect(() => add()).toThrow()
    expect(originals()).toEqual(before)
    expect(existsSync(path.join(root, 'data', '.nuvyn-master-key'))).toBe(false)
  })

  it('rolls back an interrupted import and can retry without duplicates', () => {
    kv('ai.anthropic.model', 'one')
    kv('ai.openai.model', 'two')
    const before = originals()
    db.exec("CREATE TRIGGER fail_import BEFORE INSERT ON ai_profiles WHEN NEW.provider='openai' BEGIN SELECT RAISE(ABORT, 'fixture interruption'); END")
    expect(() => initializeAiProfiles(db)).toThrow('fixture interruption')
    expect(db.prepare('SELECT * FROM ai_profiles').all()).toEqual([])
    expect(originals()).toEqual(before)
    db.exec('DROP TRIGGER fail_import')
    initializeAiProfiles(db)
    initializeAiProfiles(db)
    expect(listAiProfiles(db).profiles).toHaveLength(2)
  })

  it('does not create a replacement key if one ciphertext cannot be recovered during legacy conversion', () => {
    delete process.env.NUVYN_MASTER_KEY
    kv('ai.anthropic.apiKey', 'sk-plaintext')
    kv('ai.openai.apiKey', encryptApiKey('sk-encrypted', Buffer.from(KEY, 'hex')))
    const before = originals()
    expect(() => initializeAiProfiles(db)).toThrow()
    expect(db.prepare('SELECT * FROM ai_profiles').all()).toEqual([])
    expect(listAiProfiles(db).migrationError).toBe('master-key-required')
    expect(originals()).toEqual(before)
    expect(existsSync(path.join(root, 'data', '.nuvyn-master-key'))).toBe(false)
    // Explicit recovery is targeted and allows import to resume safely.
    updateAiProfile(db, 'legacy-openai', { clearKey: true })
    expect(listAiProfiles(db).migrationError).toBeUndefined()
    expect(profileRuntime(db, 'legacy-anthropic').apiKey).toBe('sk-plaintext')
  })
})

describe('Profile CRUD, runtime and compatibility', () => {
  it('keeps multiple profiles per protocol independent and never auto-activates new profiles', () => {
    const profiles = [add('anthropic', 'A'), add('anthropic', 'B'), add('openai', 'C'), add('openai', 'D')]
    expect(new Set(profiles.map((p) => p.id)).size).toBe(4)
    expect(listAiProfiles(db).activeProfileId).toBeNull()
    for (const profile of profiles) {
      activateAiProfile(db, profile.id)
      expect(getAiRuntimeConfig(db)).toMatchObject({ provider: profile.provider, model: profile.model, apiKey: `sk-${profile.name}-secret` })
    }
    expect(JSON.stringify(listAiProfiles(db))).not.toContain('sk-')
    expect(JSON.stringify(listAiProfiles(db))).not.toContain(cipher(profiles[0]!.id))
    expect(getAiCredentialStatus(db).providers.anthropic.stored).toBe(true)
    expect(() => legacyProfileId(db, 'anthropic')).toThrow('profile API')
  })

  it('renames and edits fields, keeps a blank key, replaces a nonempty key and explicitly clears', () => {
    const a = add()
    const before = cipher(a.id)
    updateAiProfile(db, a.id, { name: 'Renamed', model: 'New', apiKey: '' })
    expect(cipher(a.id)).toBe(before)
    expect(profileRuntime(db, a.id).apiKey).toBe('sk-Custom-secret')
    updateAiProfile(db, a.id, { apiKey: 'sk-replaced' })
    expect(decryptApiKey(cipher(a.id), Buffer.from(KEY, 'hex'))).toBe('sk-replaced')
    updateAiProfile(db, a.id, { clearKey: true })
    expect(profileRuntime(db, a.id).apiKey).toBeUndefined()
    expect(() => activateAiProfile(db, a.id)).toThrow('Save an API key')
  })

  it('requires consent or a new key when changing protocol, including transient probes', () => {
    const a = add()
    expect(() => updateAiProfile(db, a.id, { provider: 'openai' })).toThrow('Confirm credential reuse')
    expect(() => profileProbeConfig(db, a.id, { provider: 'openai' })).toThrow('Confirm credential reuse')
    updateAiProfile(db, a.id, { provider: 'openai', confirmProviderChange: true })
    expect(profileRuntime(db, a.id).provider).toBe('openai')
  })

  it('never silently replaces a deleted default and rejects nonexistent IDs', () => {
    const a = add('anthropic', 'A'), b = add('anthropic', 'B')
    activateAiProfile(db, a.id)
    expect(() => deleteAiProfile(db, a.id, false)).toThrow('Select another default')
    deleteAiProfile(db, b.id, false)
    expect(getAiRuntimeConfig(db).model).toBe('A')
    for (const action of [() => updateAiProfile(db, 'missing', { model: 'X' }), () => activateAiProfile(db, 'missing'), () => deleteAiProfile(db, 'missing', true)]) expect(action).toThrow('not found')
    deleteAiProfile(db, a.id, true)
    expect(listAiProfiles(db).activeProfileId).toBeNull()
    expect(getAiSettingsView(db).configured).toBe(false)
  })

  it('probes only the chosen profile without saving or activating unsaved inputs', () => {
    const a = add('openai', 'A'), b = add('openai', 'B')
    activateAiProfile(db, b.id)
    const before = db.prepare('SELECT * FROM ai_profiles').all()
    expect(profileProbeConfig(db, a.id, { model: 'Unsaved' })).toMatchObject({ apiKey: 'sk-A-secret', model: 'Unsaved', baseURL: 'https://a.example.test/v1' })
    expect(db.prepare('SELECT * FROM ai_profiles').all()).toEqual(before)
    expect(listAiProfiles(db).activeProfileId).toBe(b.id)
    expect(() => profileProbeConfig(db, undefined, { provider: 'openai' })).toThrow('not configured')
  })

  it('makes profiles authoritative and rejects ambiguous legacy writes', () => {
    kv('ai.anthropic.apiKey', encryptApiKey('sk-legacy', Buffer.from(KEY, 'hex')))
    initializeAiProfiles(db)
    const before = originals()
    const old = listAiProfiles(db).profiles[0]!
    updateAiProfile(db, old.id, { model: 'ProfileModel' })
    kv('ai.anthropic.model', 'Stale')
    expect(getAiRuntimeConfig(db).model).toBe('ProfileModel')
    add('anthropic', 'Another')
    expect(() => saveAiSettings(db, { provider: 'anthropic', model: 'Wrong' })).toThrow('profile API')
    expect(profileRuntime(db, old.id).model).toBe('ProfileModel')
    expect(originals()).toEqual([...before, { key: 'ai.anthropic.model', value: 'Stale' }].sort((a: any, b: any) => a.key.localeCompare(b.key)))
  })
})

import { createHash } from 'node:crypto'
import type { Database as DatabaseT } from 'better-sqlite3'
import { BUILTIN_FINANCE_SKILL_NAMES, FINANCE_CUSTOM_SKILL_LIMITS, type CustomFinanceSkillMetadata, type FinanceSkill, type FinanceSkillMetadata } from '../../shared/financeSkills.js'

export { FINANCE_CUSTOM_SKILL_LIMITS }

export type FinanceCustomSkill = Extract<FinanceSkill, { source: 'custom' }> & {
  createdAt: number
  updatedAt: number
}

export type FinanceCustomSkillUsage = { count: number; countLimit: number; contentCharacters: number; contentLimit: number }
export type FinanceCustomSkillError =
  | 'invalid-owner' | 'invalid-name' | 'builtin-name' | 'invalid-title' | 'invalid-description' | 'invalid-content'
  | 'too-long' | 'duplicate' | 'previously-deleted' | 'count-exceeded' | 'capacity-exceeded'
  | 'not-found' | 'invalid-id' | 'stale-instance' | 'stale-revision'

export type FinanceCustomSkillMutation =
  | { ok: true; skill: FinanceCustomSkill; usage: FinanceCustomSkillUsage; duplicate?: true }
  | { ok: false; error: FinanceCustomSkillError; usage?: FinanceCustomSkillUsage }

type CustomSkillRow = {
  id: number
  owner_user_id: number
  name: string
  title: string
  description: string
  content: string
  revision: number
  created_at: number
  updated_at: number
}
type CustomSkillMetadataRow = Pick<CustomSkillRow, 'id' | 'name' | 'title' | 'description' | 'revision'>

type CustomSkillInput = { name: unknown; title: unknown; description: unknown; content: unknown }
type CustomSkillPatch = { title?: unknown; description?: unknown; content?: unknown }

function characterCount(value: string): number {
  return Array.from(value).length
}

function validOwner(ownerId: number): boolean {
  return Number.isSafeInteger(ownerId) && ownerId > 0
}

function normalizeField(value: unknown, allowNewlines: boolean): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.normalize('NFC').trim()
  const invalidControls = allowNewlines
    ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u
    : /[\u0000-\u001F\u007F]/u
  return normalized && !invalidControls.test(normalized) ? normalized : null
}

export function isValidFinanceCustomSkillName(name: unknown): name is string {
  if (typeof name !== 'string' || characterCount(name) > FINANCE_CUSTOM_SKILL_LIMITS.nameCharacters) return false
  if (!/^custom-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) return false
  return !BUILTIN_FINANCE_SKILL_NAMES.some(builtin => builtin.toLowerCase() === name.toLowerCase())
}

function mapRow(row: CustomSkillRow): FinanceCustomSkill {
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    description: row.description,
    content: row.content,
    source: 'custom',
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function metadata(row: CustomSkillMetadataRow): CustomFinanceSkillMetadata {
  return { id: row.id, name: row.name, title: row.title, description: row.description, source: 'custom', revision: row.revision }
}

function rowsFor(db: DatabaseT, ownerId: number): CustomSkillRow[] {
  return db.prepare(`
    SELECT id, owner_user_id, name, title, description, content, revision, created_at, updated_at
    FROM ai_finance_skills WHERE owner_user_id = ? ORDER BY title COLLATE NOCASE, name
  `).all(ownerId) as CustomSkillRow[]
}

function usageFor(rows: Pick<CustomSkillRow, 'content'>[]): FinanceCustomSkillUsage {
  return {
    count: rows.length,
    countLimit: FINANCE_CUSTOM_SKILL_LIMITS.count,
    contentCharacters: rows.reduce((sum, row) => sum + characterCount(row.content), 0),
    contentLimit: FINANCE_CUSTOM_SKILL_LIMITS.totalContentCharacters,
  }
}

function validateInput(input: CustomSkillInput): { ok: true; value: { name: string; title: string; description: string; content: string } } | { ok: false; error: FinanceCustomSkillError } {
  if (!isValidFinanceCustomSkillName(input.name)) {
    const candidateName = input.name
    const isBuiltin = typeof candidateName === 'string' && BUILTIN_FINANCE_SKILL_NAMES.some(name => name.toLowerCase() === candidateName.toLowerCase())
    return { ok: false, error: isBuiltin ? 'builtin-name' : 'invalid-name' }
  }
  const title = normalizeField(input.title, false)
  if (!title) return { ok: false, error: 'invalid-title' }
  if (characterCount(title) > FINANCE_CUSTOM_SKILL_LIMITS.titleCharacters) return { ok: false, error: 'too-long' }
  const description = normalizeField(input.description, false)
  if (!description) return { ok: false, error: 'invalid-description' }
  if (characterCount(description) > FINANCE_CUSTOM_SKILL_LIMITS.descriptionCharacters) return { ok: false, error: 'too-long' }
  const content = normalizeField(input.content, true)
  if (!content) return { ok: false, error: 'invalid-content' }
  if (characterCount(content) > FINANCE_CUSTOM_SKILL_LIMITS.contentCharacters) return { ok: false, error: 'too-long' }
  return { ok: true, value: { name: input.name, title, description, content } }
}

function hasCredentialLikeContent(content: string): boolean {
  return /\b(?:api[ _-]?key|password|passcode|access[ _-]?token|private[ _-]?key|secret)\b\s*(?:is|:|=)\s*\S+/iu.test(content)
    || /(?:密码|验证码|银行卡号|卡号|安全码|CVV)\s*(?:是|为|[:=])\s*\S+/u.test(content)
}

function nameForTitle(title: string): string {
  const ascii = title.normalize('NFKD').replace(/[\u0300-\u036f]/gu, '').toLowerCase()
  const slug = ascii.replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 42).replace(/-+$/u, '')
  const base = slug || `skill-${createHash('sha256').update(title).digest('hex').slice(0, 10)}`
  return `custom-${base}`
}

export function createFinanceCustomSkillRepository(db: DatabaseT) {
  function list(ownerId: number): FinanceCustomSkill[] {
    if (!validOwner(ownerId)) return []
    return rowsFor(db, ownerId).map(mapRow)
  }

  function listMetadata(ownerId: number): FinanceSkillMetadata[] {
    if (!validOwner(ownerId)) return []
    const rows = db.prepare(`
      SELECT id, name, title, description, revision
      FROM ai_finance_skills WHERE owner_user_id = ? ORDER BY title COLLATE NOCASE, name
    `).all(ownerId) as CustomSkillMetadataRow[]
    return rows.map(metadata)
  }

  function usage(ownerId: number): FinanceCustomSkillUsage {
    return usageFor(validOwner(ownerId) ? rowsFor(db, ownerId) : [])
  }

  function get(ownerId: number, name: string): FinanceCustomSkill | null {
    if (!validOwner(ownerId) || !isValidFinanceCustomSkillName(name)) return null
    const row = db.prepare(`
      SELECT id, owner_user_id, name, title, description, content, revision, created_at, updated_at
      FROM ai_finance_skills WHERE owner_user_id = ? AND name = ?
    `).get(ownerId, name) as CustomSkillRow | undefined
    return row ? mapRow(row) : null
  }

  function createValue(ownerId: number, raw: CustomSkillInput, explicit: boolean, now: number): FinanceCustomSkillMutation {
    if (!validOwner(ownerId)) return { ok: false, error: 'invalid-owner' }
    const validated = validateInput(raw)
    if (!validated.ok) return { ok: false, error: validated.error }
    if (hasCredentialLikeContent(validated.value.content)) return { ok: false, error: 'invalid-content' }

    return db.transaction(() => {
      const currentRows = rowsFor(db, ownerId)
      if (currentRows.some(row => row.name === validated.value.name)) return { ok: false, error: 'duplicate', usage: usageFor(currentRows) } as const
      const forgotten = Boolean(db.prepare('SELECT 1 FROM ai_finance_skill_tombstones WHERE owner_user_id = ? AND name = ?').get(ownerId, validated.value.name))
      if (forgotten && !explicit) return { ok: false, error: 'previously-deleted', usage: usageFor(currentRows) } as const
      if (currentRows.length >= FINANCE_CUSTOM_SKILL_LIMITS.count) return { ok: false, error: 'count-exceeded', usage: usageFor(currentRows) } as const
      const total = usageFor(currentRows).contentCharacters + characterCount(validated.value.content)
      if (total > FINANCE_CUSTOM_SKILL_LIMITS.totalContentCharacters) return { ok: false, error: 'capacity-exceeded', usage: usageFor(currentRows) } as const
      db.prepare(`
        INSERT INTO ai_finance_skills (owner_user_id, name, title, description, content, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      `).run(ownerId, validated.value.name, validated.value.title, validated.value.description, validated.value.content, now, now)
      if (explicit && forgotten) {
        db.prepare('DELETE FROM ai_finance_skill_tombstones WHERE owner_user_id = ? AND name = ?').run(ownerId, validated.value.name)
      }
      const skill = get(ownerId, validated.value.name)
      if (!skill) throw new Error('Created finance skill could not be read back')
      return { ok: true, skill, usage: usageFor([...currentRows, { content: skill.content }]) } as const
    })()
  }

  function create(ownerId: number, input: CustomSkillInput, now = Date.now()): FinanceCustomSkillMutation {
    return createValue(ownerId, input, false, now)
  }

  function createExplicitly(ownerId: number, input: CustomSkillInput, now = Date.now()): FinanceCustomSkillMutation {
    return createValue(ownerId, input, true, now)
  }

  function createForUser(ownerId: number, raw: Omit<CustomSkillInput, 'name'>, now = Date.now()): FinanceCustomSkillMutation {
    if (!validOwner(ownerId)) return { ok: false, error: 'invalid-owner' }
    const title = normalizeField(raw.title, false)
    if (!title) return { ok: false, error: 'invalid-title' }
    const restored = db.prepare(`
      SELECT name FROM ai_finance_skill_tombstones
      WHERE owner_user_id = ? AND title = ? ORDER BY deleted_at DESC LIMIT 1
    `).get(ownerId, title) as { name: string } | undefined
    const base = restored?.name ?? nameForTitle(title)
    const existing = new Set(rowsFor(db, ownerId).map(row => row.name))
    let name = base
    let suffix = 2
    while (existing.has(name)) {
      const ending = `-${suffix++}`
      name = `${base.slice(0, FINANCE_CUSTOM_SKILL_LIMITS.nameCharacters - ending.length)}${ending}`
    }
    // A user-initiated create is an explicit request to restore this exact
    // stable slug if it was previously deleted. Agent writes use create().
    return createExplicitly(ownerId, { ...raw, name }, now)
  }

  function update(ownerId: number, name: string, patch: CustomSkillPatch, expectedId: number, expectedRevision: number, now = Date.now()): FinanceCustomSkillMutation {
    if (!validOwner(ownerId)) return { ok: false, error: 'invalid-owner' }
    if (!isValidFinanceCustomSkillName(name)) return { ok: false, error: 'invalid-name' }
    if (!Number.isSafeInteger(expectedId) || expectedId < 1) return { ok: false, error: 'invalid-id' }
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) return { ok: false, error: 'stale-revision' }
    if (!patch || typeof patch !== 'object' || !Object.keys(patch).length || Object.keys(patch).some(key => !['title', 'description', 'content'].includes(key))) {
      return { ok: false, error: 'invalid-content' }
    }
    return db.transaction(() => {
      const currentRows = rowsFor(db, ownerId)
      const existing = currentRows.find(row => row.name === name)
      if (!existing) return { ok: false, error: 'not-found', usage: usageFor(currentRows) } as const
      if (existing.id !== expectedId) return { ok: false, error: 'stale-instance', usage: usageFor(currentRows) } as const
      if (existing.revision !== expectedRevision) return { ok: false, error: 'stale-revision', usage: usageFor(currentRows) } as const
      const title = patch.title === undefined ? existing.title : normalizeField(patch.title, false)
      if (!title) return { ok: false, error: 'invalid-title', usage: usageFor(currentRows) } as const
      if (characterCount(title) > FINANCE_CUSTOM_SKILL_LIMITS.titleCharacters) return { ok: false, error: 'too-long', usage: usageFor(currentRows) } as const
      const description = patch.description === undefined ? existing.description : normalizeField(patch.description, false)
      if (!description) return { ok: false, error: 'invalid-description', usage: usageFor(currentRows) } as const
      if (characterCount(description) > FINANCE_CUSTOM_SKILL_LIMITS.descriptionCharacters) return { ok: false, error: 'too-long', usage: usageFor(currentRows) } as const
      const content = patch.content === undefined ? existing.content : normalizeField(patch.content, true)
      if (!content) return { ok: false, error: 'invalid-content', usage: usageFor(currentRows) } as const
      if (characterCount(content) > FINANCE_CUSTOM_SKILL_LIMITS.contentCharacters) return { ok: false, error: 'too-long', usage: usageFor(currentRows) } as const
      if (hasCredentialLikeContent(content)) return { ok: false, error: 'invalid-content', usage: usageFor(currentRows) } as const
      if (title === existing.title && description === existing.description && content === existing.content) {
        const skill = mapRow(existing)
        return { ok: true, skill, usage: usageFor(currentRows), duplicate: true } as const
      }
      const nextTotal = usageFor(currentRows).contentCharacters - characterCount(existing.content) + characterCount(content)
      if (nextTotal > FINANCE_CUSTOM_SKILL_LIMITS.totalContentCharacters) return { ok: false, error: 'capacity-exceeded', usage: usageFor(currentRows) } as const
      const result = db.prepare(`
        UPDATE ai_finance_skills
        SET title = ?, description = ?, content = ?, revision = revision + 1, updated_at = ?
        WHERE owner_user_id = ? AND name = ? AND id = ? AND revision = ?
      `).run(title, description, content, now, ownerId, name, expectedId, expectedRevision)
      if (result.changes !== 1) {
        const latest = get(ownerId, name)
        const error = !latest ? 'not-found' : latest.id !== expectedId ? 'stale-instance' : 'stale-revision'
        return { ok: false, error, usage: usageFor(rowsFor(db, ownerId)) } as const
      }
      const skill = get(ownerId, name)
      if (!skill) throw new Error('Updated finance skill could not be read back')
      return { ok: true, skill, usage: usageFor(currentRows.map(row => row.name === name ? { content: skill.content } : row)) } as const
    })()
  }

  function remove(ownerId: number, name: string, expectedId: number, expectedRevision: number, now = Date.now()): { ok: true; usage: FinanceCustomSkillUsage } | { ok: false; error: FinanceCustomSkillError; usage?: FinanceCustomSkillUsage } {
    if (!validOwner(ownerId)) return { ok: false, error: 'invalid-owner' }
    if (!isValidFinanceCustomSkillName(name)) return { ok: false, error: 'invalid-name' }
    if (!Number.isSafeInteger(expectedId) || expectedId < 1) return { ok: false, error: 'invalid-id' }
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) return { ok: false, error: 'stale-revision' }
    return db.transaction(() => {
      const currentRows = rowsFor(db, ownerId)
      const existing = currentRows.find(row => row.name === name)
      if (!existing) return { ok: false, error: 'not-found', usage: usageFor(currentRows) } as const
      if (existing.id !== expectedId) return { ok: false, error: 'stale-instance', usage: usageFor(currentRows) } as const
      if (existing.revision !== expectedRevision) return { ok: false, error: 'stale-revision', usage: usageFor(currentRows) } as const
      const result = db.prepare('DELETE FROM ai_finance_skills WHERE owner_user_id = ? AND name = ? AND id = ? AND revision = ?')
        .run(ownerId, name, expectedId, expectedRevision)
      if (result.changes !== 1) {
        const latest = get(ownerId, name)
        const error = !latest ? 'not-found' : latest.id !== expectedId ? 'stale-instance' : 'stale-revision'
        return { ok: false, error, usage: usageFor(rowsFor(db, ownerId)) } as const
      }
      db.prepare(`
        INSERT INTO ai_finance_skill_tombstones (owner_user_id, name, title, deleted_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(owner_user_id, name) DO UPDATE SET title = excluded.title, deleted_at = excluded.deleted_at
      `).run(ownerId, name, existing.title, now)
      return { ok: true, usage: usageFor(currentRows.filter(row => row.name !== name)) } as const
    })()
  }

  return { list, listMetadata, usage, get, create, createExplicitly, createForUser, update, remove }
}

import matter from 'gray-matter'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'

export const FINANCE_SKILL_LIMITS = {
  contentCharacters: 6_000,
  perRequest: 3,
} as const

export type FinanceSkillName =
  | 'monthly-review'
  | 'spending-analysis'
  | 'debt-analysis'
  | 'cashflow-analysis'
  | 'financial-planning'

export type FinanceSkillMetadata = { name: FinanceSkillName; description: string }
export type FinanceSkill = FinanceSkillMetadata & { content: string }
export type FinanceSkillError = 'unknown' | 'invalid' | 'too-large' | 'unavailable'
export type FinanceSkillResult = { ok: true; skill: FinanceSkill } | { ok: false; error: FinanceSkillError }
export type FinanceSkillRegistryEntry = { name: FinanceSkillName; file: string }
export type FinanceSkillRegistryState = {
  available: FinanceSkillMetadata[]
  unavailable: Array<{ name: FinanceSkillName; reason: FinanceSkillError }>
  configurationError: 'empty' | 'duplicate-name' | null
}

const SKILLS_ROOT = path.resolve(import.meta.dirname, 'skills/finance')

const registry: readonly FinanceSkillRegistryEntry[] = [
  { name: 'monthly-review', file: 'monthly-review/SKILL.md' },
  { name: 'spending-analysis', file: 'spending-analysis/SKILL.md' },
  { name: 'debt-analysis', file: 'debt-analysis/SKILL.md' },
  { name: 'cashflow-analysis', file: 'cashflow-analysis/SKILL.md' },
  { name: 'financial-planning', file: 'financial-planning/SKILL.md' },
]

function characterCount(value: string): number {
  return Array.from(value).length
}

export function parseFinanceSkillDocument(expectedName: FinanceSkillName, source: string): FinanceSkillResult {
  try {
    const parsed = matter(source)
    const data = parsed.data as Record<string, unknown>
    const description = typeof data.description === 'string' ? data.description.trim() : ''
    const content = parsed.content.trim()
    if (data.name !== expectedName || !description || characterCount(description) > 240 || !content) {
      return { ok: false, error: 'invalid' }
    }
    if (Object.keys(data).some(key => key !== 'name' && key !== 'description')) return { ok: false, error: 'invalid' }
    if (characterCount(content) > FINANCE_SKILL_LIMITS.contentCharacters) return { ok: false, error: 'too-large' }
    return { ok: true, skill: { name: expectedName, description, content } }
  } catch {
    return { ok: false, error: 'invalid' }
  }
}

function readRegisteredSkill(name: string): FinanceSkillResult {
  const entry = registry.find(item => item.name === name)
  if (!entry) return { ok: false, error: 'unknown' }
  try {
    const root = realpathSync(SKILLS_ROOT)
    const file = path.resolve(root, entry.file)
    if (!file.startsWith(root + path.sep)) return { ok: false, error: 'unknown' }
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink()) return { ok: false, error: 'unavailable' }
    const realFile = realpathSync(file)
    if (!realFile.startsWith(root + path.sep)) return { ok: false, error: 'unavailable' }
    return parseFinanceSkillDocument(entry.name, readFileSync(realFile, 'utf8'))
  } catch {
    return { ok: false, error: 'unavailable' }
  }
}

export function buildFinanceSkillRegistryState(
  entries: readonly FinanceSkillRegistryEntry[],
  load: (name: string) => FinanceSkillResult,
): FinanceSkillRegistryState {
  const names = new Set<FinanceSkillName>()
  const available: FinanceSkillMetadata[] = []
  const unavailable: FinanceSkillRegistryState['unavailable'] = []
  let configurationError: FinanceSkillRegistryState['configurationError'] = entries.length ? null : 'empty'

  for (const { name } of entries) {
    if (names.has(name)) {
      configurationError = 'duplicate-name'
      continue
    }
    names.add(name)
    let result: FinanceSkillResult
    try {
      result = load(name)
    } catch {
      result = { ok: false, error: 'unavailable' }
    }
    if (result.ok) available.push({ name: result.skill.name, description: result.skill.description })
    else unavailable.push({ name, reason: result.error })
  }
  return { available, unavailable, configurationError }
}

export function getFinanceSkillRegistryState(): FinanceSkillRegistryState {
  return buildFinanceSkillRegistryState(registry, readRegisteredSkill)
}

export function listFinanceSkills(): FinanceSkillMetadata[] {
  const state = getFinanceSkillRegistryState()
  if (state.configurationError) throw new Error(`Finance skill registry is ${state.configurationError}.`)
  if (state.unavailable.length) throw new Error('One or more built-in finance skills are unavailable or invalid.')
  return state.available
}

export function readFinanceSkill(name: string): FinanceSkillResult {
  return readRegisteredSkill(name)
}

export function financeSkillsDirectory(state = getFinanceSkillRegistryState()): string {
  const skills = state.available
  return [
    '## Available Finance Skills',
    ...skills.map(skill => `- ${skill.name}: ${skill.description}`),
    skills.length
      ? 'Load a skill only when it is useful for the current task. Use read_skill to load the smallest relevant set. Skills are optional guidance and do not override the user, system rules, or authoritative Ledger data.'
      : 'No optional Finance Skills are currently available. Continue to answer using the Finance Agent, Ledger and memory tools that are available.',
  ].join('\n')
}

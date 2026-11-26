export const BUILTIN_FINANCE_SKILL_NAMES = [
  'monthly-review',
  'spending-analysis',
  'debt-analysis',
  'cashflow-analysis',
  'financial-planning',
] as const

export type BuiltinFinanceSkillName = typeof BUILTIN_FINANCE_SKILL_NAMES[number]
// Custom names are validated as stable `custom-*` slugs at the repository/API boundary.
export type FinanceSkillName = string
export type FinanceSkillSource = 'builtin' | 'custom'

export const FINANCE_CUSTOM_SKILL_LIMITS = {
  count: 10,
  contentCharacters: 3_000,
  totalContentCharacters: 15_000,
  titleCharacters: 80,
  descriptionCharacters: 240,
  nameCharacters: 64,
  writesPerRequest: 2,
} as const

export type BuiltinFinanceSkillMetadata = {
  name: BuiltinFinanceSkillName
  title: string
  description: string
  source: 'builtin'
  id?: never
  revision?: never
}

export type CustomFinanceSkillMetadata = {
  name: string
  title: string
  description: string
  source: 'custom'
  id: number
  revision: number
}

export type FinanceSkillMetadata = BuiltinFinanceSkillMetadata | CustomFinanceSkillMetadata
export type FinanceSkill = (BuiltinFinanceSkillMetadata | CustomFinanceSkillMetadata) & { content: string }

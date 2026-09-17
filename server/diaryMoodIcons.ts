import type { Database as DatabaseT } from 'better-sqlite3'
import {
  DIARY_DEFAULT_MOOD_ICONS,
  isDiaryCustomMoodId,
  isMoodId,
  type DiaryMoodIconConfig,
  type DiaryMoodId,
} from '../shared/diaryMood.js'

const SETTINGS_KEY = 'diary.mood.icons'
const MAX_CUSTOM_ICONS = 128
const MAX_ICON_NAME_LENGTH = 80
const MAX_SVG_LENGTH = 256 * 1024

export type DiaryMoodIconConfigErrorCode = 'INVALID_DIARY_MOOD_ICONS' | 'DIARY_MOOD_ICONS_CONFLICT'

export class DiaryMoodIconConfigError extends Error {
  readonly code: DiaryMoodIconConfigErrorCode

  constructor(code: DiaryMoodIconConfigErrorCode, message: string) {
    super(message)
    this.name = 'DiaryMoodIconConfigError'
    this.code = code
  }
}

function defaultConfig(version = 1): DiaryMoodIconConfig {
  return {
    version,
    availableIcons: [...DIARY_DEFAULT_MOOD_ICONS],
    archivedIcons: [],
    customIcons: {},
    customIconNames: {},
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(message: string): never {
  throw new DiaryMoodIconConfigError('INVALID_DIARY_MOOD_ICONS', message)
}

function readStoredConfig(db: DatabaseT): DiaryMoodIconConfig {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY) as
    | { value: string }
    | undefined
  if (!row) return defaultConfig()

  try {
    const parsed = JSON.parse(row.value) as unknown
    if (!isPlainRecord(parsed)) return defaultConfig()
    const version = typeof parsed.version === 'number' && Number.isSafeInteger(parsed.version) && parsed.version >= 1
      ? parsed.version
      : 1
    return normalizeConfig(parsed, version)
  } catch {
    return defaultConfig()
  }
}

function validMoodId(value: unknown): value is DiaryMoodId {
  return isMoodId(value) || isDiaryCustomMoodId(value)
}

function validSvg(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_SVG_LENGTH
    && /<svg(?:\s|>)/i.test(value)
    && !/<script(?:\s|>)/i.test(value)
}

function normalizeConfig(value: Record<string, unknown>, version: number): DiaryMoodIconConfig {
  const customIconsValue = value.customIcons
  const customNamesValue = value.customIconNames
  const availableValue = value.availableIcons
  const archivedValue = value.archivedIcons

  if (!Array.isArray(availableValue)) invalid('availableIcons must be an array')
  if (archivedValue !== undefined && !Array.isArray(archivedValue)) invalid('archivedIcons must be an array')
  if (!isPlainRecord(customIconsValue)) invalid('customIcons must be an object')
  if (!isPlainRecord(customNamesValue)) invalid('customIconNames must be an object')

  const customEntries = Object.entries(customIconsValue)
  if (customEntries.length > MAX_CUSTOM_ICONS) invalid(`at most ${MAX_CUSTOM_ICONS} custom mood icons are supported`)

  const customIcons: Record<string, string> = {}
  for (const [id, svg] of customEntries) {
    if (!isDiaryCustomMoodId(id)) invalid(`invalid custom mood icon id: ${id}`)
    if (!validSvg(svg)) invalid(`custom mood icon ${id} must be a valid SVG no larger than ${MAX_SVG_LENGTH} bytes`)
    customIcons[id] = svg
  }

  const requestedArchived = new Set<string>()
  for (const id of archivedValue ?? []) {
    if (!isDiaryCustomMoodId(id) || !Object.hasOwn(customIcons, id)) invalid('archivedIcons contains an invalid custom mood icon id')
    requestedArchived.add(id)
  }

  const available = new Set<DiaryMoodId>(DIARY_DEFAULT_MOOD_ICONS)
  for (const id of availableValue) {
    if (!validMoodId(id)) invalid('availableIcons contains an invalid mood icon id')
    if (isMoodId(id) || Object.hasOwn(customIcons, id)) available.add(id)
  }
  for (const id of Object.keys(customIcons)) {
    if (!requestedArchived.has(id)) available.add(id as DiaryMoodId)
  }

  const archivedIcons = [...requestedArchived] as DiaryMoodId[]

  const customIconNames: Record<string, string> = {}
  for (const [id, name] of Object.entries(customNamesValue)) {
    if (!isDiaryCustomMoodId(id) || !Object.hasOwn(customIcons, id)) continue
    if (typeof name !== 'string' || name.trim().length === 0 || name.trim().length > MAX_ICON_NAME_LENGTH) {
      invalid(`custom mood icon ${id} name must be 1-${MAX_ICON_NAME_LENGTH} characters`)
    }
    customIconNames[id] = name.trim()
  }

  return {
    version,
    availableIcons: [...available],
    archivedIcons,
    customIcons,
    customIconNames,
  }
}

export function getDiaryMoodIconConfig(db: DatabaseT): DiaryMoodIconConfig {
  return readStoredConfig(db)
}

export function updateDiaryMoodIconConfig(
  db: DatabaseT,
  value: unknown,
): DiaryMoodIconConfig {
  if (!isPlainRecord(value)) invalid('request body must be an object')
  const expectedVersion = typeof value.expectedVersion === 'number' ? value.expectedVersion : null
  if (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    invalid('expectedVersion must be a positive safe integer')
  }

  const current = readStoredConfig(db)
  if (expectedVersion !== current.version) {
    throw new DiaryMoodIconConfigError('DIARY_MOOD_ICONS_CONFLICT', 'Diary mood icon settings are stale')
  }

  const next = normalizeConfig(value, current.version + 1)
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(SETTINGS_KEY, JSON.stringify(next))
  return next
}

export function isConfiguredDiaryMoodId(db: DatabaseT, value: unknown): value is DiaryMoodId {
  if (isMoodId(value)) return true
  if (!isDiaryCustomMoodId(value)) return false
  const config = readStoredConfig(db)
  return config.availableIcons.includes(value) && Object.hasOwn(config.customIcons, value)
}

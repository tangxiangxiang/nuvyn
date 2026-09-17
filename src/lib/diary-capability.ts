// The Diary capability is intentionally process-local to this browser tab.
// It is never serialized to localStorage, sessionStorage, IndexedDB, URLs,
// logs, or the application database.
let diaryCapability: string | null = null

export function getDiaryCapability(): string | null {
  return diaryCapability
}

export function setDiaryCapability(value: string | null): void {
  diaryCapability = value
}

export function clearDiaryCapability(): void {
  diaryCapability = null
}

export function resetDiaryCapabilityForTesting(): void {
  diaryCapability = null
}

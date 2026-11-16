export interface BoardSearchText {
  elementId: string
  text: string
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Extract only text owned by active Excalidraw text elements. */
export function extractBoardSearchText(engineData: unknown): BoardSearchText[] {
  if (!isRecord(engineData) || !Array.isArray(engineData.elements)) return []

  const results: BoardSearchText[] = []
  const seenElementIds = new Set<string>()

  for (const element of engineData.elements) {
    if (!isRecord(element) || element.type !== 'text' || element.isDeleted === true) continue
    if (typeof element.id !== 'string' || !element.id.trim() || seenElementIds.has(element.id)) continue

    const text = typeof element.text === 'string' && element.text.trim()
      ? element.text
      : typeof element.originalText === 'string'
        ? element.originalText
        : ''
    if (!text.trim()) continue

    seenElementIds.add(element.id)
    results.push({ elementId: element.id, text })
  }

  return results
}

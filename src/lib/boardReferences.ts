const BOARD_REFERENCE_RE = /^board:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu

/** Board references are stable identities, never vault paths or external URLs. */
export function parseBoardReference(source: string): string | null {
  return BOARD_REFERENCE_RE.exec(source)?.[1]?.toLowerCase() ?? null
}

export function createBoardReference(boardId: string, title: string): string {
  const id = parseBoardReference(`board:${boardId}`)
  if (!id) throw new Error('A Board reference requires a valid Board ID.')
  const label = title.replace(/[\r\n]+/gu, ' ').replace(/[\\[\]`*_<>]/gu, '\\$&')
  return `![${label}](board:${id})`
}

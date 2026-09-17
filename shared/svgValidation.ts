/**
 * Recognise the narrow SVG document boundary shared by Board binary assets
 * and user-managed Board Materials. This intentionally validates the root
 * document marker, not arbitrary XML semantics.
 */
export function findMarkupEnd(value: string, start: number): number {
  let quote: '"' | "'" | null = null
  let internalSubsetDepth = 0
  for (let index = start; index < value.length; index += 1) {
    const character = value[index]
    if (quote) {
      if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '[') {
      internalSubsetDepth += 1
      continue
    }
    if (character === ']' && internalSubsetDepth > 0) {
      internalSubsetDepth -= 1
      continue
    }
    if (character === '>' && internalSubsetDepth === 0) return index
  }
  return -1
}

/**
 * SVG has no binary magic header. After an optional XML prolog, comments,
 * doctype and whitespace, the document must start with an SVG root element.
 */
export function matchesSvgText(value: string): boolean {
  if (!value) return false

  let offset = value.charCodeAt(0) === 0xfeff ? 1 : 0
  while (offset < value.length) {
    while (/\s/.test(value[offset] ?? '')) offset += 1
    if (value.startsWith('<?xml', offset)) {
      const afterName = value[offset + 5]
      if (afterName !== '?' && !/\s/.test(afterName ?? '')) return false
      const end = value.indexOf('?>', offset + 5)
      if (end < 0) return false
      offset = end + 2
      continue
    }
    if (value.startsWith('<!--', offset)) {
      const end = value.indexOf('-->', offset + 4)
      if (end < 0) return false
      offset = end + 3
      continue
    }
    if (value.startsWith('<!DOCTYPE', offset)) {
      const afterName = value[offset + 9]
      if (afterName !== '>' && !/\s/.test(afterName ?? '')) return false
      const end = findMarkupEnd(value, offset)
      if (end < 0) return false
      offset = end + 1
      continue
    }
    break
  }

  while (/\s/.test(value[offset] ?? '')) offset += 1
  if (!value.startsWith('<svg', offset)) return false
  const afterName = value[offset + 4]
  if (afterName !== '>' && afterName !== '/' && !/\s/.test(afterName ?? '')) return false
  return findMarkupEnd(value, offset) >= 0
}

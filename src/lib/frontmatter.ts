import YAML from 'yaml'

export interface ParsedDoc {
  raw: string
  frontmatter: Record<string, unknown>
  content: string
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/** 把 .md 源文本拆成 frontmatter(YAML 对象) + 正文。 */
export function parseDoc(raw: string): ParsedDoc {
  const match = raw.match(FRONTMATTER_RE)
  if (!match) {
    return { raw, frontmatter: {}, content: raw }
  }
  const fmText = match[1]
  const content = raw.slice(match[0].length)
  let frontmatter: Record<string, unknown> = {}
  try {
    const parsed = YAML.parse(fmText) ?? {}
    frontmatter = typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    frontmatter = {}
  }
  return { raw, frontmatter, content }
}

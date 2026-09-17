// Repo-wide icon lint. Walks src/**/*.{vue,ts}, finds every <svg ...>
// element, and checks the rules in docs/design/icon-system.md.
//
// Hard rules (exit 1 on any violation):
//   - no <text> elements
//   - no viewBox 1024-style
//   - no color literals in fill/stroke
//   - no class/style on the root <svg>
//
// Soft rules (report, exit 0 unless --strict):
//   - viewBox / width / height / stroke-width should match the shared
//     16x14 grid. MarkMap and Mermaid toolbars carry upstream library
//     SVGs and are exempt via --allow-file.
//
// Usage:
//   tsx scripts/icon-lint.ts
//   tsx scripts/icon-lint.ts --strict
//   tsx scripts/icon-lint.ts --allow-file=src/components/MarkMap.vue

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'src')

const args = new Set(process.argv.slice(2))
const STRICT = args.has('--strict')
const ALLOW_FILES = new Set<string>()
// Files that legitimately contain non-icon SVG sources or SVG fixtures.
// These are always excluded; consumers can add more via --allow-file.
const DEFAULT_ALLOW_FILES = new Set<string>([
  'src/components/NavBar.vue',
  'src/components/__tests__/Mermaid.test.ts',
  'src/lib/__tests__/mermaidRuntime.test.ts',
  'src/lib/__tests__/pdf-readiness.test.ts',
  'src/lib/__tests__/pdfExport.test.ts',
  'src/lib/markmapSecurity.ts',
])
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--allow-file=')) {
    ALLOW_FILES.add(arg.slice('--allow-file='.length))
  } else if (!arg.startsWith('--') && (arg.endsWith('.vue') || arg.endsWith('.ts'))) {
    ALLOW_FILES.add(arg)
  }
}

type Severity = 'hard' | 'soft'

interface Violation {
  file: string
  line: number
  rule: string
  message: string
  severity: Severity
}

const SVG_OPEN = /<svg\b([^>]*)>/gi
const SVG_CLOSE = /<\/svg>/gi
const TEXT_TAG = /<text\b[^>]*>/i
const LARGE_VIEWBOX = /viewBox\s*=\s*"\s*0\s+0\s+(\d{3,})\s+\d{3,}\s*"/i
const COLOR_LITERAL = /(?:fill|stroke)\s*=\s*"(?:#[0-9a-f]{3,8}|rgb\(|rgba\(|hsl\(|hsla\()/i
const ROOT_CLASS_OR_STYLE = /<svg\b[^>]*\s(?:class|style)\s*=/i
const ATTR = /([\w:-]+)\s*=\s*"([^"]*)"/g

const SHARED_ATTRIBUTES: Record<string, string> = {
  viewBox: '0 0 16 16',
  width: '14',
  height: '14',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': '1.5',
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) walk(path, out)
    else if (/\.(vue|ts)$/.test(entry)) out.push(path)
  }
  return out
}

function lineNumber(source: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i++) {
    if (source.charCodeAt(i) === 10) line += 1
  }
  return line
}

function parseAttributes(tag: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const match of tag.matchAll(ATTR)) {
    map.set(match[1], match[2])
  }
  return map
}

function checkFile(filePath: string): { violations: Violation[]; svgCount: number } {
  const rel = relative(ROOT, filePath).replace(/\\/g, '/')
  if (ALLOW_FILES.has(rel) || DEFAULT_ALLOW_FILES.has(rel)) return { violations: [], svgCount: 0 }

  const source = readFileSync(filePath, 'utf8')
  const violations: Violation[] = []
  let svgCount = 0
  for (const openMatch of source.matchAll(SVG_OPEN)) {
    const index = openMatch.index ?? 0
    svgCount += 1
    const openTag = openMatch[0]
    const attrs = openMatch[1] ?? ''
    const line = lineNumber(source, index)
    const attrMap = parseAttributes(attrs)

    if (LARGE_VIEWBOX.test(attrs)) {
      violations.push({
        file: rel,
        line,
        rule: 'large-viewbox',
        message: 'viewBox uses a 3+ digit canvas; icon system is 0 0 16 16',
        severity: 'hard',
      })
    }
    if (COLOR_LITERAL.test(attrs)) {
      violations.push({
        file: rel,
        line,
        rule: 'color-literal',
        message: 'fill/stroke uses a color literal; use currentColor or a CSS variable',
        severity: 'hard',
      })
    }
    if (ROOT_CLASS_OR_STYLE.test(openTag)) {
      violations.push({
        file: rel,
        line,
        rule: 'root-class-style',
        message: 'root <svg> must not carry class/style; style in the consumer',
        severity: 'hard',
      })
    }

    for (const [key, expected] of Object.entries(SHARED_ATTRIBUTES)) {
      const actual = attrMap.get(key)
      if (actual !== undefined && actual !== expected) {
        violations.push({
          file: rel,
          line,
          rule: 'shared-attributes',
          message: `${key}="${actual}" should be "${expected}"`,
          severity: 'soft',
        })
      }
    }

    // Body check: look for <text> between this <svg> and its </svg>.
    const openEnd = index + openTag.length
    const tail = source.slice(openEnd)
    const closeMatch = tail.match(SVG_CLOSE)
    const bodyEnd = closeMatch ? openEnd + (closeMatch.index ?? 0) + closeMatch[0].length : source.length
    const body = source.slice(openEnd, bodyEnd)
    if (TEXT_TAG.test(body)) {
      violations.push({
        file: rel,
        line,
        rule: 'text-element',
        message: '<svg> contains <text>; icon system forbids text glyphs',
        severity: 'hard',
      })
    }
  }

  return { violations, svgCount }
}

function main(): void {
  const files = walk(SRC)
  const allViolations: Violation[] = []
  let fileCount = 0
  let svgCount = 0

  for (const file of files) {
    const { violations, svgCount: count } = checkFile(file)
    if (count > 0) {
      fileCount += 1
      svgCount += count
    }
    allViolations.push(...violations)
  }

  const hard = allViolations.filter((v) => v.severity === 'hard')
  const soft = allViolations.filter((v) => v.severity === 'soft')

  console.log(`Scanned ${fileCount} files, ${svgCount} <svg> elements.`)

  if (allViolations.length === 0) {
    console.log('✓ No violations.')
    process.exit(0)
  }

  const print = (v: Violation) =>
    `  ${v.file}:${v.line}  [${v.severity}] ${v.rule}: ${v.message}`

  if (hard.length > 0) {
    console.log(`\nHard violations (${hard.length}):`)
    for (const v of hard) console.log(print(v))
  }
  if (soft.length > 0) {
    console.log(`\nSoft violations (${soft.length}):`)
    for (const v of soft) console.log(print(v))
  }

  if (STRICT && (hard.length > 0 || soft.length > 0)) process.exit(1)
  if (hard.length > 0) process.exit(1)
}

main()

import postcss from 'postcss'
import { SaxNamespaceParser, XMLNS_NAMESPACE, XML_NAMESPACE, xmlEscape, type QName } from '@federicocarboni/saxe'
import {
  detectNoteImageFormat,
  NOTE_SVG_MAX_BYTES,
} from '../shared/noteImageProtocol.js'

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink'
const SVG_11_PUBLIC_ID = '-//W3C//DTD SVG 1.1//EN'
const SVG_11_SYSTEM_ID = 'http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd'
const MAX_ELEMENTS = 50_000
const MAX_OUTPUT_BYTES = NOTE_SVG_MAX_BYTES
const MAX_ATTRIBUTE_VALUE_LENGTH = 512 * 1024
const MAX_EMBEDDED_IMAGE_BYTES = 4 * 1024 * 1024
const MAX_EMBEDDED_FONT_BYTES = 512 * 1024
const MAX_EMBEDDED_FONT_TOTAL_BYTES = 2 * 1024 * 1024
const MAX_EMBEDDED_FONTS = 16

const ALLOWED_ELEMENTS = new Set([
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'image', 'defs', 'clipPath', 'linearGradient', 'radialGradient',
  'stop', 'style', 'title', 'desc', 'metadata', 'symbol', 'use', 'mask',
])

const CHILDREN: Readonly<Record<string, ReadonlySet<string>>> = {
  // Excalidraw emits an inert, empty top-level mask in otherwise valid SVG exports.
  // Accept the definition shape without treating it as rendered document content.
  svg: new Set(['defs', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'image', 'use', 'mask', 'title', 'desc', 'metadata']),
  defs: new Set(['clipPath', 'linearGradient', 'radialGradient', 'style', 'symbol', 'mask', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']),
  g: new Set(['g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'image', 'use']),
  clipPath: new Set(['g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']),
  symbol: new Set(['g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'image', 'use']),
  mask: new Set(['g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']),
  linearGradient: new Set(['stop']),
  radialGradient: new Set(['stop']),
  text: new Set(['tspan']),
  tspan: new Set(['tspan']),
  title: new Set(),
  desc: new Set(),
  metadata: new Set(),
  style: new Set(),
  image: new Set(),
  path: new Set(),
  rect: new Set(),
  circle: new Set(),
  ellipse: new Set(),
  line: new Set(),
  polyline: new Set(),
  polygon: new Set(),
  stop: new Set(),
  use: new Set(),
}

const GLOBAL_ATTRIBUTES = new Set([
  'id', 'class', 'transform', 'opacity', 'fill', 'fill-opacity', 'fill-rule',
  'stroke', 'stroke-opacity', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'stroke-dasharray', 'stroke-dashoffset', 'clip-path', 'mask', 'color', 'font-family',
  'font-size', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline',
  'direction', 'white-space', 'style',
])

const ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  svg: new Set(['version', 'viewBox', 'width', 'height', 'preserveAspectRatio', 'x', 'y']),
  g: new Set(['xml:space']),
  path: new Set(['d', 'pathLength']),
  rect: new Set(['x', 'y', 'width', 'height', 'rx', 'ry']),
  circle: new Set(['cx', 'cy', 'r']),
  ellipse: new Set(['cx', 'cy', 'rx', 'ry']),
  line: new Set(['x1', 'y1', 'x2', 'y2']),
  polyline: new Set(['points']),
  polygon: new Set(['points']),
  text: new Set(['x', 'y', 'dx', 'dy', 'textLength', 'lengthAdjust', 'xml:space']),
  tspan: new Set(['x', 'y', 'dx', 'dy', 'textLength', 'lengthAdjust', 'xml:space']),
  image: new Set(['x', 'y', 'width', 'height', 'preserveAspectRatio', 'href', 'image-rendering']),
  defs: new Set(),
  clipPath: new Set(['clipPathUnits']),
  symbol: new Set(['viewBox', 'preserveAspectRatio', 'x', 'y', 'width', 'height']),
  use: new Set(['x', 'y', 'width', 'height', 'href']),
  mask: new Set(['x', 'y', 'width', 'height', 'maskUnits', 'maskContentUnits']),
  linearGradient: new Set(['x1', 'y1', 'x2', 'y2', 'gradientUnits', 'gradientTransform', 'spreadMethod']),
  radialGradient: new Set(['cx', 'cy', 'r', 'fx', 'fy', 'fr', 'gradientUnits', 'gradientTransform', 'spreadMethod']),
  stop: new Set(['offset', 'stop-color', 'stop-opacity']),
  style: new Set(),
  title: new Set(),
  desc: new Set(),
  metadata: new Set(),
}

const TEXT_ELEMENTS = new Set(['text', 'tspan', 'title', 'desc', 'metadata'])
const PAINT_PROPERTIES = new Set(['fill', 'stroke', 'color', 'stop-color'])
const OPACITY_PROPERTIES = new Set(['opacity', 'fill-opacity', 'stroke-opacity', 'stop-opacity'])
const GRADIENT_ELEMENTS = new Set(['linearGradient', 'radialGradient'])
const INTERNAL_REFERENCE_CONTEXTS = new Set([
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'image', 'use', 'symbol',
])
const NON_RECURSIVE_REFERENCE_ANCESTORS = new Set(['clipPath', 'mask', 'linearGradient', 'radialGradient'])

export class NoteSvgValidationError extends Error {
  readonly code: 'invalid' | 'too-large'

  constructor(code: 'invalid' | 'too-large') {
    super('SVG image is invalid or unsupported.')
    this.name = 'NoteSvgValidationError'
    this.code = code
  }
}

interface SvgFrame {
  tag: string
  id?: string
  inDefinition: boolean
  hasDrawing: boolean
  symbolUses: string[]
  styleText?: string[]
  styleTextLength?: number
}

interface InternalReference {
  id: string
  expected: 'gradient' | 'clipPath' | 'mask' | 'symbol'
}

function invalid(): never {
  throw new NoteSvgValidationError('invalid')
}

function isPositiveSvgLength(value: string | undefined): boolean {
  if (!value || !/^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:px|pt|pc|em|rem|ex|%|cm|mm|in)?$/iu.test(value.trim())) return false
  return Number.parseFloat(value) > 0
}

function parseSvgLength(value: string | undefined): number | null {
  if (value === undefined || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:px|pt|pc|em|rem|ex|%|cm|mm|in)?$/iu.test(value.trim())) return null
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : null
}

function isPotentialDrawingElement(tag: string, attributes: ReadonlyMap<string, string>): boolean {
  switch (tag) {
    case 'path': return Boolean(attributes.get('d')?.trim())
    case 'rect': return isPositiveSvgLength(attributes.get('width')) && isPositiveSvgLength(attributes.get('height'))
    case 'circle': return isPositiveSvgLength(attributes.get('r'))
    case 'ellipse': return isPositiveSvgLength(attributes.get('rx')) && isPositiveSvgLength(attributes.get('ry'))
    case 'line': {
      const coordinates = ['x1', 'y1', 'x2', 'y2'].map((name) => parseSvgLength(attributes.get(name) ?? '0'))
      return coordinates.every((coordinate) => coordinate !== null)
        && (coordinates[0] !== coordinates[2] || coordinates[1] !== coordinates[3])
    }
    case 'polyline':
    case 'polygon': return Boolean(attributes.get('points')?.trim())
    case 'image': return attributes.has('href')
      && isPositiveSvgLength(attributes.get('width'))
      && isPositiveSvgLength(attributes.get('height'))
    default: return false
  }
}

function resolveRenderableSymbols(symbols: ReadonlyMap<string, Pick<SvgFrame, 'hasDrawing' | 'symbolUses'>>): Map<string, boolean> {
  const remainingDependencies = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const [id, symbol] of symbols) remainingDependencies.set(id, symbol.symbolUses.length)
  for (const [id, symbol] of symbols) {
    for (const dependency of symbol.symbolUses) {
      const parents = dependents.get(dependency) ?? []
      parents.push(id)
      dependents.set(dependency, parents)
    }
  }

  const ready = [...symbols.keys()].filter((id) => remainingDependencies.get(id) === 0)
  const renderable = new Map<string, boolean>()
  while (ready.length > 0) {
    const id = ready.pop()!
    const symbol = symbols.get(id)!
    renderable.set(id, symbol.hasDrawing || symbol.symbolUses.some((dependency) => renderable.get(dependency) === true))
    for (const parent of dependents.get(id) ?? []) {
      const remaining = (remainingDependencies.get(parent) ?? 0) - 1
      remainingDependencies.set(parent, remaining)
      if (remaining === 0) ready.push(parent)
    }
  }

  // A cyclic <use> graph can make SVG renderers recurse indefinitely. Fail
  // closed even when a cycle is currently unreachable from the document root.
  if (renderable.size !== symbols.size) invalid()
  return renderable
}

function tooLarge(): never {
  throw new NoteSvgValidationError('too-large')
}

function isSafeIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/u.test(value)
}

function escapeAttribute(value: string): string {
  return xmlEscape(value)
}

function validateBase64(value: string): Buffer {
  if (!value || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) invalid()
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) invalid()
  return bytes
}

function validateWoff2DataUri(value: string, fontBytes: { total: number; count: number }): string {
  const match = /^url\(data:font\/woff2;base64,([A-Za-z0-9+/]+={0,2})\)$/iu.exec(value.trim())
  if (!match?.[1]) invalid()
  const bytes = validateBase64(match[1])
  if (bytes.byteLength > MAX_EMBEDDED_FONT_BYTES || bytes.byteLength < 48) invalid()
  if (bytes.toString('ascii', 0, 4) !== 'wOF2') invalid()
  if (bytes.readUInt32BE(8) !== bytes.byteLength || bytes.readUInt16BE(14) !== 0) invalid()
  const tableCount = bytes.readUInt16BE(12)
  const sfntSize = bytes.readUInt32BE(16)
  const compressedSize = bytes.readUInt32BE(20)
  if (tableCount < 1 || tableCount > 128 || sfntSize > 8 * 1024 * 1024 || compressedSize > bytes.byteLength - 48) invalid()
  fontBytes.total += bytes.byteLength
  fontBytes.count += 1
  if (fontBytes.total > MAX_EMBEDDED_FONT_TOTAL_BYTES || fontBytes.count > MAX_EMBEDDED_FONTS) tooLarge()
  return `url(data:font/woff2;base64,${match[1]})`
}

function validateEmbeddedImageDataUri(value: string, embeddedImageBytes: { total: number }): string {
  const match = /^data:(image\/(?:png|jpeg|gif|webp|avif));base64,([A-Za-z0-9+/]+={0,2})$/iu.exec(value)
  if (!match?.[1] || !match[2]) invalid()
  const declaredMime = match[1].toLowerCase()
  const bytes = validateBase64(match[2])
  if (bytes.byteLength > MAX_EMBEDDED_IMAGE_BYTES) tooLarge()
  const format = detectNoteImageFormat(bytes)
  if (!format || format.mimeType !== declaredMime) invalid()
  embeddedImageBytes.total += bytes.byteLength
  if (embeddedImageBytes.total > NOTE_SVG_MAX_BYTES / 2) tooLarge()
  return `data:${declaredMime};base64,${match[2]}`
}

function validateFontFamily(value: string): string {
  const families: string[] = []
  let start = 0
  let quote = ''
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? ''
    if (character === '\\' || /[\u0000-\u001f\u007f]/u.test(character)) invalid()
    if (quote) {
      if (character === quote) quote = ''
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (character === ',') {
      families.push(value.slice(start, index).trim())
      start = index + 1
    }
  }
  if (quote) invalid()
  families.push(value.slice(start).trim())
  if (families.length === 0 || families.length > 16) invalid()

  const unquotedName = /^(?:[\p{L}_-][\p{L}\p{N}_-]*)(?:\s+[\p{L}_-][\p{L}\p{N}_-]*)*$/u
  for (const family of families) {
    const quoteCharacter = family.startsWith('"') && family.endsWith('"')
      ? '"'
      : family.startsWith("'") && family.endsWith("'")
        ? "'"
        : ''
    if (quoteCharacter) {
      if (family.length < 3 || family.length > 66) invalid()
      if (family.slice(1, -1).includes(quoteCharacter)) invalid()
      continue
    }
    if (family.length > 64 || !unquotedName.test(family)) invalid()
  }
  return families.join(', ')
}

function safeReference(value: string, expected: InternalReference['expected'], references: InternalReference[]): string {
  const match = /^url\(\s*(?:#([A-Za-z_][A-Za-z0-9_.-]{0,127})|(["'])#([A-Za-z_][A-Za-z0-9_.-]{0,127})\2)\s*\)$/iu.exec(value.trim())
  const id = match?.[1] ?? match?.[3]
  if (!id) invalid()
  references.push({ id, expected })
  return `url(#${id})`
}

function safeFragmentReference(value: string, expected: InternalReference['expected'], references: InternalReference[]): string {
  const id = value.startsWith('#') ? value.slice(1) : ''
  if (!isSafeIdentifier(id)) invalid()
  references.push({ id, expected })
  return `#${id}`
}

function validateColor(value: string, property: string, references: InternalReference[], allowReferences: boolean): string {
  const normalized = value.trim()
  if (normalized.startsWith('url(')) {
    if (!allowReferences) invalid()
    if (property === 'clip-path') return safeReference(normalized, 'clipPath', references)
    if (property === 'fill' || property === 'stroke') return safeReference(normalized, 'gradient', references)
    invalid()
  }
  if (/^(?:none|currentColor|transparent|[A-Za-z]{1,32}|#[\da-f]{3,8}|(?:rgb|rgba|hsl|hsla)\([\d\s.,%+\-/]+\))$/iu.test(normalized)) return normalized
  invalid()
}

function validateOpacity(value: string): string {
  const normalized = value.trim()
  const match = /^(0(?:\.\d+)?|1(?:\.0+)?|(?:0|[1-9]\d?)(?:\.\d+)?%)$/u.exec(normalized)
  if (!match) invalid()
  const numeric = normalized.endsWith('%') ? Number.parseFloat(normalized) / 100 : Number(normalized)
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1) invalid()
  return normalized
}

function validateTransform(value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 4096) invalid()
  const functionPattern = /([A-Za-z]+)\s*\(([^)]*)\)/gu
  let match: RegExpExecArray | null
  let cursor = 0
  const allowed = new Set(['matrix', 'translate', 'translateX', 'translateY', 'scale', 'scaleX', 'scaleY', 'rotate', 'skewX', 'skewY'])
  while ((match = functionPattern.exec(normalized))) {
    if (!allowed.has(match[1] ?? '') || !/^[\d\s.,eE+%-]+$/u.test(match[2] ?? '')) invalid()
    if (normalized.slice(cursor, match.index).trim()) invalid()
    cursor = functionPattern.lastIndex
  }
  if (!cursor || normalized.slice(cursor).trim()) invalid()
  return normalized
}

function validateCssValue(property: string, value: string, references: InternalReference[], allowReferences: boolean): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > MAX_ATTRIBUTE_VALUE_LENGTH || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) invalid()
  if (PAINT_PROPERTIES.has(property)) return validateColor(normalized, property, references, allowReferences)
  if (property === 'clip-path') return validateColor(normalized, property, references, allowReferences)
  if (property === 'mask') {
    if (!allowReferences) invalid()
    return safeReference(normalized, 'mask', references)
  }
  if (OPACITY_PROPERTIES.has(property)) return validateOpacity(normalized)
  if (property === 'font-family') return validateFontFamily(normalized)
  if (property === 'font-size') {
    if (!/^(?:\d+(?:\.\d+)?|\.\d+)(?:px|pt|pc|em|rem|ex|%|cm|mm|in)?$/iu.test(normalized)) invalid()
    return normalized
  }
  if (property === 'font-weight') {
    if (!/^(?:normal|bold|[1-9]00)$/iu.test(normalized)) invalid()
    return normalized
  }
  if (property === 'font-style') {
    if (!/^(?:normal|italic|oblique)$/iu.test(normalized)) invalid()
    return normalized
  }
  if (property === 'stroke-width' || property === 'stroke-dashoffset' || property === 'pathLength') {
    if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)(?:px|pt|pc|em|rem|ex|%|cm|mm|in)?$/iu.test(normalized)) invalid()
    return normalized
  }
  if (property === 'stroke-dasharray') {
    if (normalized === 'none' || /^(?:\d+(?:\.\d+)?|\.\d+)(?:px|pt|pc|em|rem|ex|%|cm|mm|in)?(?:[\s,]+(?:\d+(?:\.\d+)?|\.\d+)(?:px|pt|pc|em|rem|ex|%|cm|mm|in)?)*$/iu.test(normalized)) return normalized
    invalid()
  }
  const enumValues: Readonly<Record<string, ReadonlySet<string>>> = {
    'fill-rule': new Set(['nonzero', 'evenodd']),
    'clip-rule': new Set(['nonzero', 'evenodd']),
    'stroke-linecap': new Set(['butt', 'round', 'square']),
    'stroke-linejoin': new Set(['arcs', 'bevel', 'miter', 'miter-clip', 'round']),
    'text-anchor': new Set(['start', 'middle', 'end']),
    'dominant-baseline': new Set(['auto', 'alphabetic', 'central', 'hanging', 'middle', 'text-after-edge', 'text-before-edge']),
    direction: new Set(['ltr', 'rtl']),
    'white-space': new Set(['normal', 'nowrap', 'pre', 'pre-wrap', 'pre-line']),
    'clipPathUnits': new Set(['userSpaceOnUse', 'objectBoundingBox']),
    maskUnits: new Set(['userSpaceOnUse', 'objectBoundingBox']),
    maskContentUnits: new Set(['userSpaceOnUse', 'objectBoundingBox']),
    gradientUnits: new Set(['userSpaceOnUse', 'objectBoundingBox']),
    spreadMethod: new Set(['pad', 'reflect', 'repeat']),
    lengthAdjust: new Set(['spacing', 'spacingAndGlyphs']),
    'image-rendering': new Set(['auto', 'optimizeSpeed', 'optimizeQuality', 'smooth', 'pixelated']),
  }
  if (enumValues[property]?.has(normalized)) return normalized
  if (property === 'transform' || property === 'gradientTransform') return validateTransform(normalized)
  if (property === 'd') {
    if (normalized.length > MAX_ATTRIBUTE_VALUE_LENGTH || !/^[\d\s,\-.eE+MmLlHhVvCcSsQqTtAaZz]*$/u.test(normalized)) invalid()
    return normalized
  }
  if (property === 'points') {
    if (!/^[\d\s,\-.eE+]*$/u.test(normalized)) invalid()
    return normalized
  }
  if (property === 'viewBox') {
    if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[\s,]+-?(?:\d+(?:\.\d+)?|\.\d+)){3}$/u.test(normalized)) invalid()
    return normalized
  }
  if (property === 'preserveAspectRatio') {
    if (!/^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max))(?:\s+(?:meet|slice))?$/u.test(normalized)) invalid()
    return normalized
  }
  if (property === 'version') {
    if (normalized !== '1.1' && normalized !== '2.0') invalid()
    return normalized
  }
  if (property === 'offset') {
    if (!/^(?:(?:0(?:\.\d+)?|1(?:\.0+)?)|(?:100|(?:0|[1-9]\d?)(?:\.\d+)?)%)$/u.test(normalized)) invalid()
    return normalized
  }
  if (property === 'width' || property === 'height' || property === 'x' || property === 'y'
    || property === 'cx' || property === 'cy' || property === 'r' || property === 'rx' || property === 'ry'
    || property === 'x1' || property === 'x2' || property === 'y1' || property === 'y2'
    || property === 'dx' || property === 'dy' || property === 'fx' || property === 'fy' || property === 'fr'
    || property === 'textLength') {
    if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)(?:px|pt|pc|em|rem|ex|%|cm|mm|in)?$/iu.test(normalized)) invalid()
    return normalized
  }
  if (property === 'id') {
    if (!isSafeIdentifier(normalized)) invalid()
    return normalized
  }
  if (property === 'class') {
    if (!/^[A-Za-z_][A-Za-z0-9 _-]{0,127}$/u.test(normalized)) invalid()
    return normalized
  }
  if (property === 'href') return normalized
  invalid()
}

function sanitizeStyleAttribute(value: string, references: InternalReference[], allowReferences: boolean): string {
  let root: postcss.Root
  try {
    root = postcss.parse(`nuvyn{${value}}`, { from: undefined })
  } catch {
    return invalid()
  }
  if (root.nodes.length !== 1 || root.nodes[0]?.type !== 'rule' || root.nodes[0].selector !== 'nuvyn') invalid()
  const declarations: string[] = []
  for (const node of root.nodes[0].nodes ?? []) {
    if (node.type !== 'decl' || node.important) invalid()
    const property = node.prop.toLowerCase()
    if (!GLOBAL_ATTRIBUTES.has(property) || property === 'style' || property === 'id' || property === 'class') invalid()
    declarations.push(`${property}:${validateCssValue(property, node.value, references, allowReferences)}`)
  }
  if (declarations.length === 0) invalid()
  return declarations.join(';')
}

function sanitizeFontFaceStyle(value: string, fontBytes: { total: number; count: number }): string {
  let root: postcss.Root
  try {
    root = postcss.parse(value, { from: undefined })
  } catch {
    return invalid()
  }
  const rules: string[] = []
  for (const node of root.nodes) {
    if (node.type !== 'atrule' || node.name.toLowerCase() !== 'font-face' || node.params.trim() !== '' || !node.nodes) invalid()
    let family: string | undefined
    let source: string | undefined
    for (const declaration of node.nodes) {
      if (declaration.type !== 'decl' || declaration.important) invalid()
      const property = declaration.prop.toLowerCase()
      if (property === 'font-family' && family === undefined) family = validateFontFamily(declaration.value)
      else if (property === 'src' && source === undefined) source = validateWoff2DataUri(declaration.value, fontBytes)
      else invalid()
    }
    if (!family || !source) invalid()
    rules.push(`@font-face{font-family:${family};src:${source}}`)
  }
  return rules.join('')
}

function serializeStyle(css: string): string {
  return `<style>${xmlEscape(css)}</style>`
}

function attributeAllowed(tag: string, name: string): boolean {
  return GLOBAL_ATTRIBUTES.has(name) || ATTRIBUTES[tag]?.has(name) === true
}

function allowInternalReferences(tag: string, ancestors: SvgFrame[]): boolean {
  return INTERNAL_REFERENCE_CONTEXTS.has(tag)
    && !ancestors.some((frame) => NON_RECURSIVE_REFERENCE_ANCESTORS.has(frame.tag))
}

function validateNamespaceDeclaration(name: QName, value: string, isRoot: boolean): void {
  if (name.prefix === undefined && name.localName === 'xmlns') {
    if (!isRoot || value !== SVG_NAMESPACE) invalid()
    return
  }
  if (name.prefix === 'xmlns' && name.localName === 'xlink' && value === XLINK_NAMESPACE) return
  invalid()
}

/**
 * Strictly validates an SVG image and serializes only the supported static SVG
 * profile. Unknown/active SVG features fail closed rather than being stripped.
 */
export function sanitizeNoteSvg(input: Uint8Array): Buffer {
  if (input.byteLength === 0) invalid()
  if (input.byteLength > NOTE_SVG_MAX_BYTES) tooLarge()

  let source: string
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(input)
  } catch {
    return invalid()
  }

  const output: string[] = []
  let outputBytes = 0
  const append = (chunk: string): void => {
    outputBytes += Buffer.byteLength(chunk, 'utf8')
    if (outputBytes > MAX_OUTPUT_BYTES) tooLarge()
    output.push(chunk)
  }
  const stack: SvgFrame[] = []
  const ids = new Map<string, string>()
  const symbols = new Map<string, Pick<SvgFrame, 'hasDrawing' | 'symbolUses'>>()
  const rootSymbolUses: string[] = []
  const references: InternalReference[] = []
  const fontBytes = { total: 0, count: 0 }
  const embeddedImageBytes = { total: 0 }
  let rootSeen = false
  let rootClosed = false
  let elementCount = 0
  let rootHasDrawing = false

  const parser = new SaxNamespaceParser({
    xmlDecl(declaration) {
      if (declaration.version !== '1.0' || (declaration.encoding && declaration.encoding !== 'utf-8')) invalid()
    },
    doctype(declaration) {
      // Saxe's "ignore" mode never fetches external declarations and ignores
      // internal subset declarations. Accept only the standard SVG 1.1
      // declaration used by common exporters; it is omitted from sanitized output.
      if (declaration.name !== 'svg'
        || declaration.publicId !== SVG_11_PUBLIC_ID
        || declaration.systemId !== SVG_11_SYSTEM_ID) invalid()
    },
    processingInstruction() { invalid() },
    startCDataSection() { /* CDATA text remains inert and is escaped on output. */ },
    startTag(name, attributes) {
      if (name.namespace !== SVG_NAMESPACE || name.prefix !== undefined || !ALLOWED_ELEMENTS.has(name.localName)) invalid()
      if (rootClosed) invalid()
      const parent = stack.at(-1)
      if (parent && !CHILDREN[parent.tag]?.has(name.localName)) invalid()
      const isRoot = !parent
      if (isRoot) {
        if (rootSeen || name.localName !== 'svg') invalid()
        rootSeen = true
      }
      elementCount += 1
      if (elementCount > MAX_ELEMENTS) tooLarge()

      const serializedAttributes = new Map<string, string>()
      for (const [attributeName, rawValue] of attributes.entries()) {
        if (rawValue.length > MAX_ATTRIBUTE_VALUE_LENGTH) tooLarge()
        if (attributeName.namespace === XMLNS_NAMESPACE) {
          validateNamespaceDeclaration(attributeName, rawValue, isRoot)
          continue
        }

        let outputName: string
        if (attributeName.namespace === XLINK_NAMESPACE && attributeName.localName === 'href') {
          outputName = 'href'
        } else if (attributeName.namespace === XML_NAMESPACE && attributeName.localName === 'space') {
          outputName = 'xml:space'
        } else if (attributeName.namespace === undefined && attributeName.prefix === undefined) {
          outputName = attributeName.localName
        } else {
          invalid()
        }

        if (!attributeAllowed(name.localName, outputName) || serializedAttributes.has(outputName)) invalid()
        let safeValue: string
        if (outputName === 'href') {
          if (name.localName === 'image') safeValue = validateEmbeddedImageDataUri(rawValue, embeddedImageBytes)
          else if (name.localName === 'use') safeValue = safeFragmentReference(rawValue, 'symbol', references)
          else invalid()
        } else if (outputName === 'style') {
          if (name.localName === 'style') invalid()
          safeValue = sanitizeStyleAttribute(rawValue, references, allowInternalReferences(name.localName, stack))
        } else if (outputName === 'id') {
          safeValue = validateCssValue(outputName, rawValue, references, false)
          if (ids.has(safeValue)) invalid()
          ids.set(safeValue, name.localName)
        } else if (outputName === 'class') {
          safeValue = validateCssValue(outputName, rawValue, references, false)
          if (name.localName === 'style' && safeValue !== 'style-fonts') invalid()
        } else if (outputName === 'xml:space') {
          if (rawValue !== 'default' && rawValue !== 'preserve') invalid()
          safeValue = rawValue
        } else {
          safeValue = validateCssValue(outputName, rawValue, references, allowInternalReferences(name.localName, stack))
        }
        serializedAttributes.set(outputName, safeValue)
      }

      if (name.localName === 'svg' && serializedAttributes.has('version')) {
        const version = serializedAttributes.get('version')
        if (version !== '1.1' && version !== '2.0') invalid()
      }
      if (name.localName === 'style') {
        if (parent?.tag !== 'defs') invalid()
        const className = serializedAttributes.get('class')
        if (className !== undefined && className !== 'style-fonts') invalid()
        stack.push({
          tag: name.localName,
          inDefinition: true,
          hasDrawing: false,
          symbolUses: [],
          styleText: [],
        })
        return
      }

      const inDefinition = Boolean(parent?.inDefinition)
        || (parent !== undefined && ['defs', 'clipPath', 'mask', 'linearGradient', 'radialGradient', 'symbol'].includes(parent.tag))
      const frame: SvgFrame = {
        tag: name.localName,
        ...(serializedAttributes.has('id') ? { id: serializedAttributes.get('id') } : {}),
        inDefinition,
        hasDrawing: isPotentialDrawingElement(name.localName, serializedAttributes),
        symbolUses: [],
      }
      if (name.localName === 'use') {
        const targetId = (serializedAttributes.get('href') ?? '').slice(1)
        const ownerSymbol = [...stack].reverse().find((ancestor) => ancestor.tag === 'symbol' && ancestor.id)
        if (ownerSymbol) ownerSymbol.symbolUses.push(targetId)
        else if (!inDefinition) rootSymbolUses.push(targetId)
      }

      const attributesText = [...serializedAttributes.entries()]
        .map(([key, value]) => ` ${key}="${escapeAttribute(value)}"`)
        .join('')
      append(`${isRoot ? `<svg xmlns="${SVG_NAMESPACE}"` : `<${name.localName}`}${attributesText}>`)
      stack.push(frame)
    },
    endTag(name) {
      const frame = stack.pop()
      if (!frame || frame.tag !== name.localName) invalid()
      if (frame.tag === 'style') {
        const css = sanitizeFontFaceStyle(frame.styleText?.join('') ?? '', fontBytes)
        if (css) append(serializeStyle(css))
      } else {
        append(`</${frame.tag}>`)
      }
      if (frame.tag === 'symbol' && frame.id) {
        symbols.set(frame.id, { hasDrawing: frame.hasDrawing, symbolUses: frame.symbolUses })
      }
      if (!frame.inDefinition && frame.hasDrawing) rootHasDrawing = true
      const parent = stack.at(-1)
      if (parent && ['g', 'symbol', 'text', 'tspan'].includes(parent.tag)) {
        parent.hasDrawing ||= frame.hasDrawing
      }
      if (frame.tag === 'svg') rootClosed = true
    },
    text(value) {
      const frame = stack.at(-1)
      if (!frame) {
        if (value.trim()) invalid()
        return
      }
      if (frame.tag === 'style') {
        frame.styleText?.push(value)
        frame.styleTextLength = (frame.styleTextLength ?? 0) + value.length
        if (frame.styleTextLength > MAX_ATTRIBUTE_VALUE_LENGTH) tooLarge()
      } else if (TEXT_ELEMENTS.has(frame.tag)) {
        append(xmlEscape(value))
        if ((frame.tag === 'text' || frame.tag === 'tspan') && value.trim()) frame.hasDrawing = true
      } else if (value.trim()) {
        invalid()
      }
    },
  }, {
    dtd: 'ignore',
    maxAttributesLength: 1024 * 1024,
    maxElementDepth: 64,
    maxEntityDepth: 4,
    maxEntityLength: 256,
    maxNameLength: 128,
    maxTextLength: 512 * 1024,
    maxNamespacePrefixes: 4,
    incrementalText: true,
  })

  try {
    parser.parse(source)
  } catch (error) {
    if (error instanceof NoteSvgValidationError) throw error
    return invalid()
  }

  if (!rootSeen || !rootClosed || stack.length > 0) invalid()
  for (const reference of references) {
    const target = ids.get(reference.id)
    if (!target || (reference.expected === 'gradient' && !GRADIENT_ELEMENTS.has(target))
      || (reference.expected === 'clipPath' && target !== 'clipPath')
      || (reference.expected === 'mask' && target !== 'mask')
      || (reference.expected === 'symbol' && target !== 'symbol')) invalid()
  }
  const renderableSymbols = resolveRenderableSymbols(symbols)
  if (!rootHasDrawing && !rootSymbolUses.some((id) => renderableSymbols.get(id) === true)) invalid()
  return Buffer.from(output.join(''), 'utf8')
}

export const __testing__ = {
  MAX_ELEMENTS,
  MAX_OUTPUT_BYTES,
  MAX_ATTRIBUTE_VALUE_LENGTH,
  validateWoff2DataUri,
  validateEmbeddedImageDataUri,
  sanitizeStyleAttribute,
  sanitizeFontFaceStyle,
}

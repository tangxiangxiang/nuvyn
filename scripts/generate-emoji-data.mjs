#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const GENERATOR_VERSION = '1'
const SOURCE = 'https://github.com/delthas/gemoji-json/blob/37dd69790d10d7fcbb5b7f22a1d806e1e457c648/emoji.json'
const SOURCE_URL = 'https://raw.githubusercontent.com/delthas/gemoji-json/37dd69790d10d7fcbb5b7f22a1d806e1e457c648/emoji.json'
const SOURCE_REVISION = '37dd69790d10d7fcbb5b7f22a1d806e1e457c648'
const SOURCE_REVISION_DATE = '2026-04-10'
const LICENSE = 'MIT'
const ALIAS_RE = /^[A-Za-z0-9_+\-]+$/

function usage() {
  console.error('Usage: node scripts/generate-emoji-data.mjs [--input path] [--output path]')
}

function parseArgs(argv) {
  const args = { input: null, output: resolve('src/lib/generated/emojiData.ts') }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--input' || argument === '--output') {
      const value = argv[index + 1]
      if (!value) {
        usage()
        throw new Error(`${argument} requires a path`)
      }
      args[argument.slice(2)] = resolve(value)
      index += 1
    } else if (argument === '--help') {
      usage()
      process.exit(0)
    } else {
      usage()
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  return args
}

async function readSource(input) {
  if (input) return readFile(input, 'utf8')
  const response = await fetch(SOURCE_URL)
  if (!response.ok) throw new Error(`Unable to read pinned source: HTTP ${response.status}`)
  return response.text()
}

function validateSource(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Pinned Emoji source must be a non-empty array')
  }

  const entries = []
  const names = new Set()
  for (const [sourceIndex, item] of value.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Invalid Emoji source entry at index ${sourceIndex}`)
    }
    const emoji = item.emoji
    const aliases = item.aliases
    if (typeof emoji !== 'string' || emoji.length === 0 || !Array.isArray(aliases) || aliases.length === 0) {
      throw new Error(`Invalid Emoji source schema at index ${sourceIndex}`)
    }
    for (const name of aliases) {
      if (typeof name !== 'string' || !ALIAS_RE.test(name)) {
        throw new Error(`Invalid Emoji shortcode at source index ${sourceIndex}: ${String(name)}`)
      }
      if (names.has(name)) {
        throw new Error(`Duplicate Emoji shortcode: ${name}`)
      }
      names.add(name)
      entries.push({ name, glyph: emoji, sourceIndex })
    }
  }

  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : left.sourceIndex - right.sourceIndex)
  return entries.map(({ name, glyph }) => ({ name, glyph }))
}

function render(entries) {
  const body = JSON.stringify(entries, null, 2)
  return `// Generated file — do not edit manually.\n//\n// Source: ${SOURCE}\n// Source revision: ${SOURCE_REVISION}\n// Source revision date: ${SOURCE_REVISION_DATE}\n// Generator version: ${GENERATOR_VERSION}\n// License: ${LICENSE} (gemoji-json)\n//\n// The source data and aliases are MIT-licensed. Runtime consumers must use\n// this committed artifact; they must not fetch Emoji data at runtime.\n\nexport const EMOJI_SOURCE_REVISION = '${SOURCE_REVISION}' as const\nexport const EMOJI_SOURCE_REVISION_DATE = '${SOURCE_REVISION_DATE}' as const\nexport const EMOJI_GENERATOR_VERSION = '${GENERATOR_VERSION}' as const\n\nexport interface GeneratedEmojiEntry {\n  readonly name: string\n  readonly glyph: string\n}\n\nexport const EMOJI_ENTRIES: readonly GeneratedEmojiEntry[] = ${body}\n\n`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const sourceText = await readSource(args.input)
  let source
  try {
    source = JSON.parse(sourceText)
  } catch (error) {
    throw new Error(`Pinned Emoji source is not valid JSON: ${error.message}`)
  }
  const entries = validateSource(source)
  await writeFile(args.output, render(entries), 'utf8')
  console.log(`Generated ${entries.length} Emoji entries at ${args.output}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})

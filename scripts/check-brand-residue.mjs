import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const forbidden = ['do', 'cus'].join('').toLowerCase()
const trackedPaths = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)

const pathMatches = trackedPaths.filter((filePath) => filePath.toLowerCase().includes(forbidden))
const contentMatches = []

for (const filePath of trackedPaths) {
  const content = readFileSync(filePath, 'utf8')
  if (content.toLowerCase().includes(forbidden)) contentMatches.push(filePath)
}

if (pathMatches.length || contentMatches.length) {
  console.error('Brand residue detected in tracked files.')
  for (const filePath of pathMatches) console.error(`path: ${filePath}`)
  for (const filePath of contentMatches) console.error(`content: ${filePath}`)
  process.exitCode = 1
} else {
  console.log(`Brand audit passed: ${trackedPaths.length} tracked files checked.`)
}

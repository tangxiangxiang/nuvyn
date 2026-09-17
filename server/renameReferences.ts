import { resolveWikiTarget } from '../shared/linkResolve.js'
import { isManagedDiaryPath } from '../shared/diaryProtocol.js'

/** Generic reference rewriting has no AAD-aware Diary transaction. Keep the
 *  parser itself fail closed so non-route callers cannot hand an encrypted
 *  Diary source/target to this Markdown mutator. */
export class ManagedDiaryReferenceUnsupportedError extends Error {
  readonly code = 'diary-encrypted-reference-unsupported'

  constructor(path: string) {
    super(`managed Diary reference rewrite is unsupported: ${path}`)
    this.name = 'ManagedDiaryReferenceUnsupportedError'
  }
}

export function rewriteDocumentReferences(raw: string, sourcePath: string, oldPath: string, newPath: string, allPaths: string[]): string {
  const managedPath = [sourcePath, oldPath, newPath]
    .map((value) => value.replace(/\.md$/, ''))
    .find((value) => isManagedDiaryPath(value))
  if (managedPath) throw new ManagedDiaryReferenceUnsupportedError(managedPath)
  return raw.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g).map((segment, index) =>
    index % 2 === 1 ? segment : rewriteTextReferences(segment, sourcePath, oldPath, newPath, allPaths),
  ).join('')
}

function rewriteTextReferences(raw: string, sourcePath: string, oldPath: string, newPath: string, allPaths: string[]): string {
  const wikiUpdated = raw.replace(/\[\[([^\]\n]+)\]\]/g, (whole, inner: string) => {
    const pipe = inner.indexOf('|')
    const target = pipe === -1 ? inner : inner.slice(0, pipe)
    const alias = pipe === -1 ? '' : inner.slice(pipe)
    const hash = target.indexOf('#')
    const ref = (hash === -1 ? target : target.slice(0, hash)).trim()
    const anchor = hash === -1 ? '' : target.slice(hash)
    return resolveWikiTarget(ref, sourcePath, allPaths) === oldPath ? `[[${newPath}${anchor}${alias}]]` : whole
  })
  return wikiUpdated.replace(/(\[[^\]\n]*\]\()([^\s)]+)(\))/g, (whole, prefix: string, href: string, suffix: string) => {
    const hash = href.indexOf('#')
    const pathPart = hash === -1 ? href : href.slice(0, hash)
    const anchor = hash === -1 ? '' : href.slice(hash)
    const ref = pathPart.replace(/\.md$/i, '')
    return resolveWikiTarget(ref, sourcePath, allPaths) === oldPath ? `${prefix}${newPath}.md${anchor}${suffix}` : whole
  })
}

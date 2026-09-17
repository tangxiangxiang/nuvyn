// Isomorphic Obsidian-style wiki link resolution. Used by the server and the
// client. Keep this file Node-free: no `node:*` imports, no `fs`.
//
// The resolution algorithm matches Obsidian's behavior:
//   1. Same-dir: if the source is `notes/a` and the ref is `b`, try `notes/b`
//   2. Root: if 1 misses, try `b` as a top-level path
//   3. Recursive basename match: case-insensitive basename against any
//      known path (returns the first hit)
//
// A `ref` may include a trailing `.md` — it is stripped before matching.
// Any ref that smells like an escape attempt (`..`, `\\`, leading `/`) is
// rejected outright; the resolver only ever returns paths from `allPaths`, so
// it cannot leak anything outside the vault.

/** Returns the directory containing `p`, or '' for a top-level path. */
export function dirname(p: string): string {
  const idx = p.lastIndexOf('/')
  return idx === -1 ? '' : p.slice(0, idx)
}

/** Returns the basename (last path segment) of `p`. */
export function basename(p: string): string {
  const idx = p.lastIndexOf('/')
  return idx === -1 ? p : p.slice(idx + 1)
}

/** Resolve a wiki link target (as written) to an actual vault path.
 *  Returns null if no match. `allPaths` is a list of all known vault
 *  paths (no `.md` extension). */
export function resolveWikiTarget(
  ref: string,
  sourcePath: string,
  allPaths: string[],
): string | null {
  if (!ref) return null
  // Resource-aware Markdown may use source-relative references. Normalize them
  // in the logical vault namespace before the ordinary Nuvyn lookup; no raw
  // traversal syntax is ever passed to a filesystem helper.
  if (/^(?:\.\/|\.\.\/|@\/)/u.test(ref)) {
    if (ref.includes('\\') || ref.startsWith('/')) return null
    const sourceBare = sourcePath.replace(/\.md$/iu, '')
    const base = ref.startsWith('@/')
      ? []
      : dirname(sourceBare).split('/').filter(Boolean)
    const raw = ref.startsWith('@/') ? ref.slice(2) : ref
    const segments = [...base]
    for (const segment of raw.split('/')) {
      if (!segment || segment === '.') continue
      if (segment === '..') {
        if (segments.length === 0) return null
        segments.pop()
        continue
      }
      if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/iu.test(segment)) return null
      segments.push(segment)
    }
    const relative = segments.join('/').replace(/\.md$/iu, '')
    return relative && allPaths.includes(relative) ? relative : null
  }

  // Reject anything else that smells like an escape attempt or non-vault syntax.
  if (ref.includes('..') || ref.includes('\\') || ref.startsWith('/')) return null

  // Strip a trailing .md (case-insensitive) before matching.
  const stripped = ref.replace(/\.md$/i, '')
  if (!stripped) return null

  const sourceDir = dirname(sourcePath)
  const refBasename = basename(stripped)
  // Each segment of the candidate paths must look like a kebab slug; the
  // ref's basename goes through this same gate so we don't try to resolve
  // a ref like `[[#anchor]]` (empty basename) or `[[foo/bar]]` whose
  // embedded `/` would make the basename a path rather than a name.
  if (!isKebabSegment(refBasename)) return null

  // 1. Same-dir: try `<sourceDir>/<ref>` first.
  const sameDir = sourceDir ? `${sourceDir}/${stripped}` : stripped
  if (allPaths.includes(sameDir)) return sameDir

  // 2. Root: only relevant when the source is in a sub-folder.
  if (sourceDir !== '' && allPaths.includes(stripped)) return stripped

  // 3. Recursive basename match (case-insensitive on basename only).
  //    Exact-dir candidates are preferred by checking `sameDir` first
  //    above; here we just take the first basename match.
  const refBaseLower = refBasename.toLowerCase()
  for (const p of allPaths) {
    if (basename(p).toLowerCase() === refBaseLower) return p
  }

  return null
}

// Lowercase kebab slug, same shape as the server's SEGMENT_RE. Inlined
// here to keep the resolver self-contained and isomorphic.
function isKebabSegment(s: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(s)
}

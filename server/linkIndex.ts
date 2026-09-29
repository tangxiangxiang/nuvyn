// In-memory link index. Single source of truth for "which notes link
// to which". Built lazily on the first GET request, kept fresh by the
// write routes (PUT/POST/PATCH/DELETE on /api/posts/* and /api/folders/*).
//
// Storage shape:
//   forward: Map<sourcePath, Link[]>  — every resolved outbound link
//   references: Map<sourcePath, LinkReference[]> — lightweight parsed
//               candidates, including currently broken links
//   paths:   Set<allKnownPaths>        — existence check
//
// We store only the forward map and compute the reverse map on demand.
// Backlinks are the hot read path, but the scan is O(forward.size) and
// the size is bounded by file count — for a dev tool with N < 10k
// notes this is fine. The simpler mutation logic (only forward is
// touched) is worth the trade.
//
// Stale-while-rebuild: failures in the index update are best-effort
// and don't fail the HTTP response. If a write succeeds on disk but
// the index update is skipped, the next cold rebuild (on process
// restart) repairs the index. There is no admin endpoint to force a
// rebuild in v1; the lazy `getIndex()` on first request handles it.

import { promises as fs } from 'node:fs'
import matter from 'gray-matter'
import { listPostsFlat } from './tree.js'
import { CONTENT_DIR, filePathFor } from './paths.js'
import { resolveWikiTarget } from '../shared/linkResolve.js'
import { getDb } from './db.js'
import { classifyDiaryPath, isManagedDiaryPath } from '../shared/diaryProtocol.js'

/** Raised when a body-scanning index build is requested without access to a
 * managed Diary body. */
export class LinkIndexBodyAccessError extends Error {
  readonly path: string

  constructor(path: string) {
    super(`LinkIndex body access is required for ${path}`)
    this.name = 'LinkIndexBodyAccessError'
    this.path = path
  }
}

export interface Link {
  /** Resolved vault path (no .md extension, no #anchor). */
  target: string
  /** Display text: the alias for `[[x|alias]]`, the link text for `[t](x.md)`. */
  alias?: string
  /** Optional `#heading` suffix. */
  anchor?: string
  /** Which syntax produced this link. */
  kind: 'wiki' | 'md'
}

export interface BacklinkRecord {
  source: string
  alias?: string
  anchor?: string
  kind: 'wiki' | 'md'
}

export interface LinkIndexSnapshot {
  /** Every known vault path (no .md). */
  paths: string[]
  /** source -> outbound links */
  outgoing: Record<string, Link[]>
  /** path -> display title (frontmatter.title -> first H1 -> filename). */
  titles: Record<string, string>
}

/** A parsed vault-internal reference before checking whether its target
 * currently exists. Keeping these candidates lets path membership changes
 * restore links without rereading the source Markdown. */
interface LinkReference {
  ref: string
  alias?: string
  anchor?: string
  kind: 'wiki' | 'md'
}

// ---------- extraction ----------

// Wiki link: [[ref]] / [[ref#anchor]] / [[ref|alias]] / [[ref#anchor|alias]]
// `ref` and `anchor` disallow brackets/newlines/pipes (anchor never
// contains pipes; ref might, but then the regex would have to balance
// brackets which we don't bother with for v1).
const WIKI_LINK_RE = /\[\[([^\[\]\n|]+?)(?:#([^\[\]\n|]+?))?(?:\|([^\[\]\n]+?))?\]\]/g

// Standard markdown link: [text](href) with optional "title".
// We don't care about the title for the index; it's stripped later.
const MD_LINK_RE = /\[([^\]]+)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g

/** Strip a leading YAML frontmatter block. Mirrors src/lib/frontmatter.ts
 *  so the server module doesn't pull in a YAML dep just to slice text. */
function stripFrontmatter(raw: string): string {
  return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
}

/** Replace fenced / inline code blocks with empty content so link
 *  regexes don't match inside them. This is a crude approach (it
 *  doesn't preserve line numbers) but the extractor doesn't need
 *  line numbers, only the text content. */
function stripCode(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, '')   // ``` fenced
    .replace(/~~~[\s\S]*?~~~/g, '')   // ~~~ fenced
    .replace(/`[^`\n]+`/g, '')        // inline code
}

function nameFromPath(path: string): string {
  return path.split('/').pop() || path
}

function titleFromRaw(path: string, raw: string): string {
  try {
    const parsed = matter(raw)
    const fmTitle = parsed.data.title
    if (typeof fmTitle === 'string' && fmTitle.trim()) return fmTitle.trim()
    const h1 = /^#\s+(.+)$/m.exec(parsed.content)
    if (h1?.[1]?.trim()) return h1[1].trim()
  } catch {
    const h1 = /^#\s+(.+)$/m.exec(stripFrontmatter(raw))
    if (h1?.[1]?.trim()) return h1[1].trim()
  }
  return nameFromPath(path)
}

function isExternalHref(href: string): boolean {
  // Anything with a scheme (http:, https:, mailto:, ftp:, data:, …) or a
  // protocol-relative `//` or a root-absolute `/` is external/non-vault.
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return true
  if (href.startsWith('//')) return true
  if (href.startsWith('/')) return true
  return false
}

/** Parse vault-internal link syntax without resolving targets. The source
 * order is retained across Wiki and Markdown forms so the resolution stage
 * can apply the existing first-occurrence dedupe contract. */
function extractLinkReferences(raw: string): LinkReference[] {
  const body = stripCode(stripFrontmatter(raw))
  const ordered: Array<{ offset: number; reference: LinkReference }> = []

  // Wiki links
  for (const m of body.matchAll(WIKI_LINK_RE)) {
    const ref = m[1]
    if (!ref) continue
    const anchor = m[2]?.trim() || undefined
    const alias = m[3]?.trim() || undefined
    ordered.push({ offset: m.index, reference: { ref, alias, anchor, kind: 'wiki' } })
  }

  // Standard markdown links — only vault-internal ones count.
  for (const m of body.matchAll(MD_LINK_RE)) {
    const text = m[1]?.trim() || undefined
    const href = m[2]
    if (!href || isExternalHref(href)) continue
    // Split off the fragment for the anchor; query strings are dropped
    // (we don't model them).
    const hashIdx = href.indexOf('#')
    const pathPart = hashIdx === -1 ? href : href.slice(0, hashIdx)
    const anchor = hashIdx === -1 ? undefined : href.slice(hashIdx + 1) || undefined
    const queryIdx = pathPart.indexOf('?')
    const cleanPath = queryIdx === -1 ? pathPart : pathPart.slice(0, queryIdx)
    if (!cleanPath) continue
    ordered.push({ offset: m.index, reference: { ref: cleanPath, alias: text, anchor, kind: 'md' } })
  }

  ordered.sort((a, b) => a.offset - b.offset)
  return ordered.map(({ reference }) => reference)
}

/** Resolve parsed candidates against the current vault path membership.
 * Broken links remain in the source candidate store, but never enter the
 * public relationship projection until they resolve. */
function resolveLinkReferences(
  references: LinkReference[],
  sourcePath: string,
  allPaths: string[],
): Link[] {
  const out: Link[] = []
  const seen = new Set<string>()
  for (const reference of references) {
    const resolved = resolveWikiTarget(reference.ref, sourcePath, allPaths)
    if (!resolved) continue
    const key = resolved + '\0' + (reference.anchor ?? '')
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      target: resolved,
      alias: reference.alias,
      anchor: reference.anchor,
      kind: reference.kind,
    })
  }
  return out
}

/** Extract every currently resolvable inter-note link. The public helper
 * keeps its existing wire-compatible behavior; unresolved references are
 * retained only by LinkIndex's private candidate map. */
export function extractLinks(
  raw: string,
  sourcePath: string,
  allPaths: string[],
): Link[] {
  return resolveLinkReferences(extractLinkReferences(raw), sourcePath, allPaths)
}

// ---------- index ----------

export class LinkIndex {
  private forward = new Map<string, Link[]>()
  private references = new Map<string, LinkReference[]>()
  private paths = new Set<string>()
  private titles = new Map<string, string>()

  /** Full rebuild from disk. Reads every .md file in `rootDir`. When a body
   * access predicate is supplied, all managed Diary paths are authorized
   * after the structural listing and before the first body read. */
  async rebuild(
    rootDir: string = CONTENT_DIR,
    useMetadataDb = false,
    canReadBody?: (path: string) => boolean,
  ): Promise<void> {
    this.forward.clear()
    this.references.clear()
    this.paths.clear()
    this.titles.clear()
    const posts = await listPostsFlat(rootDir, useMetadataDb ? getDb() : null)
    for (const p of posts) {
      this.paths.add(p.path)
      // Structural projections expose only the canonical managed basename;
      // metadata-owned private titles must never enter this process-level
      // index, even transiently during a cold rebuild.
      this.titles.set(p.path, isManagedDiaryPath(p.path) ? nameFromPath(p.path) : p.title)
    }
    if (canReadBody) {
      const denied = posts.find((p) =>
        classifyDiaryPath(p.path) === 'managed' && !canReadBody(p.path))
      if (denied) throw new LinkIndexBodyAccessError(denied.path)
    }
    // Extract ordinary source candidates only after structural listing has
    // completed, and resolve them together against that complete path set.
    for (const p of posts) {
      // Managed Diary bytes are ciphertext envelopes.  Structural listing
      // already registered the path/title above, so deliberately skip the
      // body read and Markdown parser for this class of document.  This is
      // the generic cold-rebuild boundary: even an unlocked session must not
      // turn Diary plaintext into a long-lived process-level index.
      if (isManagedDiaryPath(p.path)) continue
      const abs = filePathFor(p.path)
      let raw: string
      try {
        raw = await fs.readFile(abs, 'utf8')
      } catch {
        // File vanished between listPostsFlat and readFile (e.g. user
        // deleted it via a separate process). Skip — the next rebuild
        // will be consistent.
        continue
      }
      const references = extractLinkReferences(raw)
      if (references.length > 0) this.references.set(p.path, references)
    }
    this.recomputeAllSources()
  }

  /** Add a path to the existence set without extracting. Used by
   *  tests (and any caller that needs to pre-register a target
   *  before writing a file that links to it). */
  registerPath(path: string, title = nameFromPath(path)): void {
    const isNew = !this.paths.has(path)
    this.paths.add(path)
    this.titles.set(path, isManagedDiaryPath(path) ? nameFromPath(path) : title)
    if (isNew) this.recomputeAllSources()
  }

  setTitle(path: string, title: string): void {
    if (this.paths.has(path)) {
      this.titles.set(path, isManagedDiaryPath(path) ? nameFromPath(path) : title)
    }
  }

  /** Re-extract links for a single file. Used after a write or after
   *  a rename (with the new path). */
  applyWrite(path: string, raw: string): void {
    const isNew = !this.paths.has(path)
    this.paths.add(path)
    if (isManagedDiaryPath(path)) {
      // Structural/no-op semantics for managed Diary.  The caller may have
      // an authorized plaintext buffer in memory, but it must never enter
      // this process-wide derived state.
      this.references.delete(path)
      this.forward.delete(path)
      this.titles.set(path, nameFromPath(path))
      if (isNew) this.recomputeAllSources()
      return
    }
    this.titles.set(path, titleFromRaw(path, raw))
    const references = extractLinkReferences(raw)
    if (references.length > 0) this.references.set(path, references)
    else this.references.delete(path)
    if (isNew) this.recomputeAllSources()
    else this.recomputeSource(path)
  }

  /** Remove a file from the index and re-project every retained reference
   * against the new membership. References from remaining sources are kept
   * so deleting and recreating a target restores their relationships. */
  applyDelete(path: string): void {
    this.removePathState(path)
    this.recomputeAllSources()
  }

  /** Rename: change membership, parse the supplied new source at its new
   * path, then re-project all candidates once against the final path set. */
  applyRename(oldPath: string, newPath: string, newRaw: string): void {
    this.removePathState(oldPath)
    this.registerPathWithoutRecompute(newPath, isManagedDiaryPath(newPath)
      ? nameFromPath(newPath)
      : titleFromRaw(newPath, newRaw))
    this.setReferencesFromRaw(newPath, newRaw)
    this.recomputeAllSources()
  }

  /** Cascade delete for a folder subtree. */
  applyFolderDelete(paths: string[]): void {
    for (const p of paths) this.removePathState(p)
    this.recomputeAllSources()
  }

  /** Cascade rename: remove old memberships, install all new paths and
   * candidates, then project once so inter-cascade links resolve against
   * the final tree (including siblings moved in the same operation). */
  applyFolderRename(
    oldToNew: Array<{ oldPath: string; newPath: string; newRaw: string }>,
  ): void {
    for (const { oldPath } of oldToNew) this.removePathState(oldPath)
    for (const { newPath, newRaw } of oldToNew) {
      const title = isManagedDiaryPath(newPath) ? nameFromPath(newPath) : titleFromRaw(newPath, newRaw)
      this.registerPathWithoutRecompute(newPath, title)
      this.setReferencesFromRaw(newPath, newRaw)
    }
    this.recomputeAllSources()
  }

  private registerPathWithoutRecompute(path: string, title = nameFromPath(path)): void {
    this.paths.add(path)
    this.titles.set(path, isManagedDiaryPath(path) ? nameFromPath(path) : title)
  }

  private removePathState(path: string): void {
    this.references.delete(path)
    this.forward.delete(path)
    this.paths.delete(path)
    this.titles.delete(path)
  }

  private setReferencesFromRaw(path: string, raw: string): void {
    if (isManagedDiaryPath(path)) {
      this.references.delete(path)
      this.forward.delete(path)
      return
    }
    const references = extractLinkReferences(raw)
    if (references.length > 0) this.references.set(path, references)
    else this.references.delete(path)
  }

  private recomputeSource(sourcePath: string, allPaths = Array.from(this.paths)): void {
    if (isManagedDiaryPath(sourcePath)) {
      this.references.delete(sourcePath)
      this.forward.delete(sourcePath)
      return
    }
    const references = this.references.get(sourcePath)
    if (!references?.length || !this.paths.has(sourcePath)) {
      this.forward.delete(sourcePath)
      return
    }
    const links = resolveLinkReferences(references, sourcePath, allPaths)
      .filter((link) => !isManagedDiaryPath(link.target))
    if (links.length > 0) this.forward.set(sourcePath, links)
    else this.forward.delete(sourcePath)
  }

  private recomputeAllSources(): void {
    const allPaths = Array.from(this.paths)
    for (const sourcePath of Array.from(this.forward.keys())) {
      if (!this.references.has(sourcePath)) this.forward.delete(sourcePath)
    }
    for (const sourcePath of Array.from(this.references.keys())) this.recomputeSource(sourcePath, allPaths)
  }

  /** Reverse lookup. Returns one record per source file. The forward
   *  map already dedupes on (target, anchor) per source via
   *  resolution projection, so a source that links to the same target twice
   *  appears here only once. */
  getBacklinks(target: string): BacklinkRecord[] {
    // A managed Diary target is private body-derived relation data.  The
    // structural index intentionally exposes no backlinks for it, including
    // Note → Diary edges.  Managed sources are likewise never retained.
    if (isManagedDiaryPath(target)) return []
    const out: BacklinkRecord[] = []
    for (const [source, links] of this.forward) {
      if (isManagedDiaryPath(source)) continue
      for (const l of links) {
        if (!isManagedDiaryPath(l.target) && l.target === target) {
          out.push({ source, alias: l.alias, anchor: l.anchor, kind: l.kind })
          break
        }
      }
    }
    return out
  }

  /** Existence check used by the renderer to mark a wiki link as
   *  missing when the target doesn't exist in the vault. */
  hasPath(p: string): boolean {
    return this.paths.has(p)
  }

  /** Wire shape for `GET /api/links/index`. */
  snapshot(): LinkIndexSnapshot {
    this.purgeManagedDiaryState()
    const outgoing: Record<string, Link[]> = {}
    for (const [k, v] of this.forward) {
      if (isManagedDiaryPath(k)) continue
      const filtered = v.filter((link) => !isManagedDiaryPath(link.target))
      if (filtered.length > 0) outgoing[k] = filtered.slice()
    }
    const titles: Record<string, string> = {}
    for (const p of this.paths) {
      titles[p] = isManagedDiaryPath(p)
        ? nameFromPath(p)
        : this.titles.get(p) ?? nameFromPath(p)
    }
    return { paths: Array.from(this.paths), outgoing, titles }
  }

  /** Remove any legacy managed-Diary body-derived state that may have been
   *  retained by a pre-D8.3 warm index. Filtering only at the response layer
   *  would still leave private links/titles in process memory. */
  purgeManagedDiaryState(): void {
    for (const source of this.references.keys()) {
      if (isManagedDiaryPath(source)) this.references.delete(source)
    }
    for (const [source, links] of this.forward) {
      if (isManagedDiaryPath(source)) {
        this.forward.delete(source)
        continue
      }
      const filtered = links.filter((link) => !isManagedDiaryPath(link.target))
      if (filtered.length === 0) this.forward.delete(source)
      else if (filtered.length !== links.length) this.forward.set(source, filtered)
    }
    for (const path of this.paths) {
      if (isManagedDiaryPath(path)) this.titles.set(path, nameFromPath(path))
    }
  }
}

// ---------- singleton ----------

let _index: LinkIndex | null = null
let _indexPromise: Promise<LinkIndex> | null = null

function startIndexRebuild(canReadBody?: (path: string) => boolean): Promise<LinkIndex> {
  const promise = (async () => {
    const idx = new LinkIndex()
    await idx.rebuild(CONTENT_DIR, true, canReadBody)
    _index = idx
    return idx
  })()
  _indexPromise = promise
  // A failed access preflight must not poison the singleton. A later unlock
  // must be able to retry the cold body operation.
  void promise.catch(() => {
    if (_indexPromise === promise) _indexPromise = null
  })
  return promise
}

/** Lazy singleton. The first call triggers a full rebuild from
 *  CONTENT_DIR; subsequent calls return the cached instance. */
export async function getIndex(): Promise<LinkIndex> {
  if (_index) {
    _index.purgeManagedDiaryState()
    return _index
  }
  if (_indexPromise) return _indexPromise
  return startIndexRebuild()
}

/** Obtain the singleton for a body operation. On a cold rebuild, every
 * managed Diary path is checked before any Markdown body is read. Warm
 * indexes are returned as-is; callers still authorize the candidate bodies
 * they will read. */
export async function getIndexForBodyOperation(
  canReadBody: (path: string) => boolean,
): Promise<LinkIndex> {
  if (_index) {
    _index.purgeManagedDiaryState()
    return _index
  }
  if (_indexPromise) return _indexPromise
  return startIndexRebuild(canReadBody)
}

/** Test-only escape hatch: drop the cached singleton so the next
 *  `getIndex()` rebuilds from the current CONTENT_DIR. Use this in
 *  test `beforeEach` after `setContentDir` so the index picks up the
 *  test fixture. */
export function __resetLinkIndexForTesting(): void {
  _index = null
  _indexPromise = null
}

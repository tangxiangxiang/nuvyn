// Surgical frontmatter editor. Used by the write path (PUT) to bump
// the `updated` field without disturbing the rest of the YAML — we
// want to preserve the user's other field formatting, ordering, and
// any comments. This is intentionally not a full parse + re-emit:
// gray-matter's stringify would normalize quoting and key order, which
// shows up as spurious diffs in `git log -p` for files the user has
// only read.
//
// Line endings: the input is normalized to LF on output. The vast
// majority of Nuvyn users edit in LF environments; if a Windows-only
// file round-trips through PUT, the frontmatter block picks up LF
// while the body is left alone. This is a known simplification; if
// it becomes a problem, capture the original `\r?\n` from the match
// and reuse it in the splice.

// `^---LF<yaml>LF---LF?` — anchored at the start so we don't match
// stray `---` inside the body (the body can contain `---` for setext
// headings or horizontal rules).
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

const FENCE_OPEN = /^---\r?\n/

const UPDATED_LINE = /^updated:.*$/m

/**
 * Bump (or insert) the `updated` field in the file's frontmatter.
 *
 * Behavior:
 *  - File has no frontmatter block → prepend a block with just `updated:`.
 *  - File has frontmatter with an `updated:` line → replace that line.
 *  - File has frontmatter without `updated:` → append it at the end.
 *  - File has an opening `---` but no closing fence (e.g. the user
 *    is mid-edit) → leave the file untouched. Better to skip the
 *    save-time bump than to mangle a half-written file.
 *
 * The function is intentionally tolerant: it never throws on weird
 * input, it just returns a best-effort bumped version. The body is
 * always preserved verbatim.
 */
export function bumpUpdatedInFrontmatter(raw: string, updated: string): string {
  const match = raw.match(FRONTMATTER_RE)
  if (match) {
    const fmText = match[1]!
    const newFm = UPDATED_LINE.test(fmText)
      ? fmText.replace(UPDATED_LINE, `updated: ${updated}`)
      : `${fmText}\nupdated: ${updated}`
    return raw.replace(FRONTMATTER_RE, `---\n${newFm}\n---\n`)
  }

  // No frontmatter block at all → prepend one. The file body keeps
  // its original leading content (e.g. a markdown body that was
  // written before the user started using frontmatter).
  if (!FENCE_OPEN.test(raw)) {
    return `---\nupdated: ${updated}\n---\n\n${raw}`
  }

  // Opening fence with no closing pair → the file is in an
  // inconsistent state. Don't touch it.
  return raw
}

// Initialize the vault as a git repository the first time the history
// feature is touched. Idempotent: if `.git` already exists, this is a
// no-op. Writes `.gitignore` and `.gitattributes` next to `.git`.
//
// Where the files live:
//   repoRoot = the vault root (the directory the user pointed Nuvyn at).
//   For Nuvyn this is `process.cwd()` in dev and the cwd at server
//   start in prod. `git.ts` takes this as a parameter; the routes
//   resolve it once and pass it down so the call site can override
//   for tests.
//
// What goes in .gitignore:
//   - data/    : Nuvyn's own runtime (sqlite, caches) — must NOT be
//                versioned, otherwise two machines racing on the same
//                vault will get merge conflicts on every save.
//   - node_modules/, dist/, .vite/ : standard build artifacts.
//   - .DS_Store, Thumbs.db, desktop.ini : OS junk.
//   - *.log     : log files leak private paths and tend to churn.
//
// What goes in .gitattributes:
//   `* text=auto eol=lf` — make LF canonical regardless of OS, so
//   diffs aren't 100% `\ No newline at end of file` noise. Paired with
//   the `core.autocrlf=false` git config in initRepo().

import { promises as fs } from 'node:fs'
import path from 'node:path'
import * as git from './git.js'
import { withVaultMutation } from '../vaultMutation.js'
import { NUVYN_VAULT_DIRECTORY } from '../technicalNamespace.js'

/**
 * Does `dir` have its OWN `.git/` (or `.git` file, for worktrees
 * and submodules)? `git.isRepo` uses `rev-parse --is-inside-work-tree`
 * which returns true for ANY directory inside an outer repo — we
 * need the stricter "this directory itself is the root" check so
 * nested-in-another-repo detection can fire before we silently
 * `git init` a nested repo.
 */
async function hasOwnGitDir(dir: string): Promise<boolean> {
  try {
    const st = await fs.stat(path.join(dir, '.git'))
    return st.isDirectory() || st.isFile()
  } catch {
    return false
  }
}

/**
 * Is `dir` inside an OUTER git working tree (i.e. an ancestor
 * directory has its own `.git/`, distinct from any `.git/` directly
 * inside `dir`)? Nested repos are legal in git but usually
 * accidental — in our case they mean the user pointed VAULT_DIR
 * at a subfolder of a project that already has its own git
 * history, and silently `git init`-ing inside would split their
 * vault history across two unrelated repos.
 *
 * Returns the outer repo root path if one is found, otherwise
 * null. We walk up the directory tree looking for a `.git/`
 * sibling that is NOT inside `dir` itself.
 */
async function outerRepoRoot(dir: string): Promise<string | null> {
  let cur = path.resolve(dir)
  const start = cur
  while (true) {
    if (cur !== start && await hasOwnGitDir(cur)) return cur
    const parent = path.dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
}

const GITIGNORE_LINES = [
  '# Nuvyn runtime',
  'data/',
  `${NUVYN_VAULT_DIRECTORY}/`,
  '',
  '# Node / build',
  'node_modules/',
  'dist/',
  '.vite/',
  '.cache/',
  '',
  '# OS',
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  '',
  '# Editor',
  '.vscode/',
  '.idea/',
  '',
  '# Logs',
  '*.log',
  '',
]

const GITATTRIBUTES = ''
// Intentionally empty. We rely on `core.autocrlf=false` (set in
// initRepo) for byte-stable storage. Pinning `* text=auto` in
// .gitattributes overrides autocrlf on Windows machines and
// silently strips \r from CRLF files during checkout, breaking
// the round-trip property tested in history-git.test.ts. If we
// ever need to mark specific files as binary, we add explicit
// lines here.

/**
 * Idempotent repo initialization. Steps:
 *   1. If already a git repo, do nothing.
 *   2. If the directory sits inside an OUTER git repo, log a one-
 *      time warning and proceed anyway. Git treats the nested
 *      repo as a self-contained unit (the outer one ignores the
 *      inner `.git/` by default and only sees an untracked
 *      directory at the vault path), so vault history stays
 *      separate from the surrounding project's history. The
 *      warning tells the user about the unusual layout so they
 *      can fix it (move VAULT_DIR outside the project) if they
 *      didn't intend the nesting.
 *   3. Otherwise: ensure `.gitignore` and `.gitattributes` exist
 *      (create if missing, leave existing content alone — the user
 *      may have customized them), then `git init`.
 *
 * The order matters: write the dotfiles first so the very first
 * commit the user makes doesn't accidentally stage the OS junk we
 * were trying to ignore.
 */
export async function ensureRepoWithinVaultMutation(repoRoot: string): Promise<void> {
  // Tight "this directory has its own .git/" check rather than
  // git.isRepo (which uses rev-parse --is-inside-work-tree and
  // returns true for any nested directory of an outer repo).
  if (await hasOwnGitDir(repoRoot)) {
    await git.ensureNuvynVaultId(repoRoot)
    return
  }
  const outer = await outerRepoRoot(repoRoot)
  if (outer) {
    // eslint-disable-next-line no-console
    console.warn(
      `[nuvyn] vault ${repoRoot} is inside another git repository at ${outer}. `
      + 'Creating a nested vault repo. Set VAULT_DIR to a directory '
      + 'outside the surrounding project if this was not intentional.',
    )
  }
  await writeIfMissing(path.join(repoRoot, '.gitignore'), GITIGNORE_LINES.join('\n'))
  await writeIfMissing(path.join(repoRoot, '.gitattributes'), GITATTRIBUTES)
  await git.initRepo(repoRoot)
  await git.ensureNuvynVaultId(repoRoot)
}

/** Bootstrap is itself a Vault mutation. Existing repositories take the
 * read-only fast path; first initialization joins the global mutation order. */
export async function ensureRepo(repoRoot: string): Promise<void> {
  if (await hasOwnGitDir(repoRoot)) return
  return withVaultMutation(repoRoot, () => ensureRepoWithinVaultMutation(repoRoot))
}

async function writeIfMissing(p: string, content: string): Promise<void> {
  try {
    await fs.access(p)
  } catch {
    await fs.writeFile(p, content, 'utf8')
  }
}

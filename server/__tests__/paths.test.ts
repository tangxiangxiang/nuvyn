import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  assertSafePath,
  filePathFor,
  folderPathFor,
  isValidPathSyntax,
  isValidSegment,
  readSafeRelativeFile,
  resolveSafeRelativePath,
  resolveSafeRelativePathDetailed,
  verifySafePathResolution,
} from '../paths.js'

describe('isValidPathSyntax', () => {
  it('accepts top-level post', () => {
    expect(isValidPathSyntax('hello-world')).toBe(true)
  })
  it('accepts nested post', () => {
    expect(isValidPathSyntax('notes/draft')).toBe(true)
  })
  it('accepts deeply nested post', () => {
    expect(isValidPathSyntax('notes/archive/old')).toBe(true)
  })
  it('accepts a bare folder under content', () => {
    expect(isValidPathSyntax('archive')).toBe(true)
  })
  it('rejects empty path', () => {
    expect(isValidPathSyntax('')).toBe(false)
  })
  it('rejects empty segment', () => {
    expect(isValidPathSyntax('notes//draft')).toBe(false)
  })
  it('rejects ..', () => {
    expect(isValidPathSyntax('notes/../etc')).toBe(false)
  })
  it('rejects leading slash', () => {
    expect(isValidPathSyntax('/notes/draft')).toBe(false)
  })
  it('rejects trailing slash', () => {
    expect(isValidPathSyntax('notes/')).toBe(false)
  })
  it('rejects .md extension', () => {
    expect(isValidPathSyntax('notes/draft.md')).toBe(false)
  })
  it('rejects leading hyphen', () => {
    expect(isValidPathSyntax('notes/-draft')).toBe(false)
  })
  it('rejects trailing hyphen', () => {
    expect(isValidPathSyntax('notes/draft-')).toBe(false)
  })

  it('rejects CJK segments', () => {
    expect(isValidPathSyntax('literature/007-思维/001-第一性原理')).toBe(false)
  })
  it('rejects uppercase letters', () => {
    expect(isValidPathSyntax('literature/006-MacOS')).toBe(false)
  })
  it('rejects underscores', () => {
    expect(isValidPathSyntax('literature/draft_v2')).toBe(false)
  })
  it('rejects spaces', () => {
    expect(isValidPathSyntax('literature/draft v2')).toBe(false)
  })
  it('still rejects `..` even with CJK in the rest of the path', () => {
    expect(isValidPathSyntax('literature/007-思维/../etc/passwd')).toBe(false)
  })
  it('still rejects `.md` extension in any segment', () => {
    expect(isValidPathSyntax('literature/007-思维/init.md')).toBe(false)
  })
  it('still rejects leading hyphen', () => {
    expect(isValidPathSyntax('literature/007-思维/-init')).toBe(false)
  })
  it('still rejects trailing hyphen', () => {
    expect(isValidPathSyntax('literature/007-思维/init-')).toBe(false)
  })
})

describe('assertSafePath', () => {
  it('resolves a valid path to a disk path inside content/', () => {
    expect(assertSafePath('hello-world')).toMatch(
      /[\\/]src[\\/]content[\\/]hello-world$/,
    )
  })
  it('resolves a nested path to a disk path inside content/', () => {
    expect(assertSafePath('notes/draft')).toMatch(
      /[\\/]src[\\/]content[\\/]notes[\\/]draft$/,
    )
  })
  it('throws on ..', () => {
    expect(() => assertSafePath('notes/../etc')).toThrow()
  })
  it('throws on absolute injection', () => {
    // regex would already block, but the resolve check is a second line of defense
    expect(() => assertSafePath('..%2Fetc')).toThrow()
  })
})

describe('filePathFor / folderPathFor', () => {
  it('filePathFor adds .md', () => {
    expect(filePathFor('notes/draft')).toMatch(/src[\\/]content[\\/]notes[\\/]draft\.md$/)
  })
  it('folderPathFor does not add .md', () => {
    expect(folderPathFor('notes')).toMatch(/src[\\/]content[\\/]notes$/)
  })
  it('filePathFor rejects a CJK path', () => {
    expect(() => filePathFor('literature/007-思维/001-第一性原理')).toThrow()
  })
})

describe('isValidSegment', () => {
  // Keep path names filesystem- and git-friendly: English lowercase
  // kebab segments only. Human-language titles live in frontmatter.
  it('accepts a kebab segment', () => expect(isValidSegment('init-2026')).toBe(true))
  it('rejects a CJK segment', () => expect(isValidSegment('007-思维')).toBe(false))
  it('rejects a single CJK char', () => expect(isValidSegment('思')).toBe(false))
  it('rejects a mixed-case segment', () => expect(isValidSegment('006-MacOS')).toBe(false))
  it('rejects `.` and `..`', () => {
    expect(isValidSegment('.')).toBe(false)
    expect(isValidSegment('..')).toBe(false)
  })
  it('rejects leading hyphen', () => expect(isValidSegment('-init')).toBe(false))
  it('rejects trailing hyphen', () => expect(isValidSegment('init-')).toBe(false))
  it('rejects `.md` suffix', () => expect(isValidSegment('init.md')).toBe(false))
  it('rejects segment containing `/`', () => expect(isValidSegment('foo/bar')).toBe(false))
  it('rejects empty segment', () => expect(isValidSegment('')).toBe(false))
  it('rejects underscore', () => expect(isValidSegment('draft_v2')).toBe(false))
})

describe('symlink-safe filesystem paths', () => {
  it('rejects symlinked directories and files before reading them', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-safe-path-'))
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-safe-outside-'))
    try {
      await fs.writeFile(path.join(outside, 'secret.md'), 'secret', 'utf8')
      await fs.symlink(outside, path.join(root, 'linked-folder'), 'dir')
      await expect(resolveSafeRelativePath(root, 'linked-folder/secret.md')).rejects.toThrow(/symbolic links/)

      await fs.symlink(path.join(outside, 'secret.md'), path.join(root, 'note.md'), 'file')
      await expect(readSafeRelativeFile(root, 'note.md', 'utf8')).rejects.toThrow(/symbolic links/)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('detects an intermediate directory replacement after resolution', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-safe-path-race-'))
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-safe-outside-race-'))
    try {
      await fs.mkdir(path.join(root, 'folder'), { recursive: true })
      await fs.writeFile(path.join(root, 'folder', 'note.md'), 'safe', 'utf8')
      const resolution = await resolveSafeRelativePathDetailed(root, 'folder/note.md')
      await fs.rename(path.join(root, 'folder'), path.join(root, 'old-folder'))
      await fs.symlink(outside, path.join(root, 'folder'), 'dir')
      await expect(verifySafePathResolution(resolution)).rejects.toThrow(/path changed|symbolic/i)
      await expect(readSafeRelativeFile(root, 'folder/note.md', 'utf8')).rejects.toThrow(/symbolic links/)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  })
})

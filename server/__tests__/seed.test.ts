import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { ensureInitialFolders } from '../seed.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-seed-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('ensureInitialFolders', () => {
  it('creates inbox / literature / archive / diary under an empty content dir', async () => {
    await ensureInitialFolders(tmpDir)
    const entries = await fs.readdir(tmpDir)
    expect(entries.sort()).toEqual(['archive', 'diary', 'inbox', 'literature'])
  })

  it('is idempotent — running twice does not error or delete files', async () => {
    await ensureInitialFolders(tmpDir)
    // Drop a user file into one of the seeded folders.
    const userFile = path.join(tmpDir, 'inbox', 'my-note.md')
    await fs.writeFile(userFile, '# hi', 'utf8')

    await ensureInitialFolders(tmpDir)
    const stillThere = await fs.readFile(userFile, 'utf8')
    expect(stillThere).toBe('# hi')
  })

  it('does not touch existing folders that the user already populated', async () => {
    // User has `inbox` with content but no `literature` or `archive`.
    await fs.mkdir(path.join(tmpDir, 'inbox'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'inbox', 'x.md'), 'x', 'utf8')

    await ensureInitialFolders(tmpDir)
    const inboxFiles = await fs.readdir(path.join(tmpDir, 'inbox'))
    expect(inboxFiles).toEqual(['x.md'])
    expect(await fs.readdir(tmpDir)).toEqual(
      expect.arrayContaining(['inbox', 'literature', 'archive']),
    )
  })

  it('warns and continues when a non-directory file sits in the seed path', async () => {
    // Simulate a user mistake: a file named `inbox` instead of a folder.
    await fs.writeFile(path.join(tmpDir, 'inbox'), 'not a dir', 'utf8')

    // The other two folders should still be created; the colliding one
    // should not crash the server. EEXIST becomes a warning.
    await ensureInitialFolders(tmpDir)
    const entries = await fs.readdir(tmpDir)
    expect(entries).toEqual(expect.arrayContaining(['literature', 'archive', 'diary']))
  })

  it('surfaces a diary file conflict without overwriting it', async () => {
    const diaryFile = path.join(tmpDir, 'diary')
    await fs.writeFile(diaryFile, 'keep this file', 'utf8')

    await ensureInitialFolders(tmpDir)

    await expect(fs.readFile(diaryFile, 'utf8')).resolves.toBe('keep this file')
    await expect(fs.stat(path.join(tmpDir, 'diary', 'unexpected'))).rejects.toThrow()
    await expect(fs.stat(path.join(tmpDir, 'inbox'))).resolves.toBeTruthy()
    await expect(fs.stat(path.join(tmpDir, 'literature'))).resolves.toBeTruthy()
    await expect(fs.stat(path.join(tmpDir, 'archive'))).resolves.toBeTruthy()
  })
})

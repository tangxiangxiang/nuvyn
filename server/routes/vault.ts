import { promises as fs } from 'node:fs'
import { Hono } from 'hono'
import { CONTENT_DIR, filePathFor, isValidPathSyntax } from '../paths.js'
import { buildTree } from '../tree.js'
import { bad, metadataDb } from './shared.js'

const vaultRoutes = new Hono()

vaultRoutes.get('/api/tree', async (c) => {
  const tree = await buildTree(CONTENT_DIR, metadataDb())
  return c.json(tree)
})

vaultRoutes.post('/api/files/state', async (c) => {
  const body = await c.req.json().catch(() => null) as { paths?: unknown } | null
  if (!body || !Array.isArray(body.paths) || body.paths.length > 50) return bad(c, 'paths array required')
  const states: Array<{ path: string; exists: boolean; mtime: number; size: number }> = []
  for (const item of body.paths) {
    if (typeof item !== 'string' || !isValidPathSyntax(item)) return bad(c, 'invalid path')
    try {
      const stat = await fs.stat(filePathFor(item))
      states.push({ path: item, exists: true, mtime: stat.mtimeMs, size: stat.size })
    } catch {
      states.push({ path: item, exists: false, mtime: 0, size: 0 })
    }
  }
  return c.json(states)
})

export default vaultRoutes

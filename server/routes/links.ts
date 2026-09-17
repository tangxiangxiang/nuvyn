import { Hono } from 'hono'
import { getIndex as getLinkIndex } from '../linkIndex.js'
import { isValidPathSyntax } from '../paths.js'
import { bad } from './shared.js'

const linkRoutes = new Hono()

// Link index endpoints. The full snapshot is what the client uses to
// render wiki links (for existence checks) and to power the Links
// panel's outgoing column. Backlinks are computed on demand from the
// forward map.
linkRoutes.get('/api/links/index', async (c) => {
  const idx = await getLinkIndex()
  return c.json(idx.snapshot())
})

linkRoutes.get('/api/backlinks', async (c) => {
  const target = c.req.query('path')
  if (!target) return bad(c, 'path required')
  const idx = await getLinkIndex()
  return c.json(idx.getBacklinks(target))
})

linkRoutes.get('/api/links/rename-impact', async (c) => {
  const target = c.req.query('path')
  if (!target || !isValidPathSyntax(target)) return bad(c, 'valid path required')
  const idx = await getLinkIndex()
  const sources = c.req.query('recursive') === 'true'
    ? Object.entries(idx.snapshot().outgoing)
        .filter(([, links]) => links.some((link) => link.target === target || link.target.startsWith(target + '/')))
        .map(([source]) => source)
    : idx.getBacklinks(target).map((record) => record.source)
  return c.json({ path: target, count: sources.length, sources })
})

export default linkRoutes

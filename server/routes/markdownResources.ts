import { Hono } from 'hono'
import {
  MarkdownResourceError,
  readMarkdownResource,
} from '../markdownResources.js'
import { requireDiaryBodyAccess } from '../diaryAccess/guard.js'

const markdownResourceRoutes = new Hono()

markdownResourceRoutes.get('/api/markdown-resources', async (c) => {
  try {
    const resourcePath = c.req.query('path')
    const sourcePath = c.req.query('source')
    // A managed Diary may render ordinary resources only while its existing
    // body-operation lease is current. This reuses the same guard rather than
    // introducing a second resource authorization model; ordinary Markdown
    // callers remain unchanged when no managed source is supplied.
    if (typeof sourcePath === 'string') {
      const bodyAccess = requireDiaryBodyAccess(c, sourcePath)
      if (bodyAccess) return bodyAccess
    }
    if (typeof resourcePath === 'string') {
      const bodyAccess = requireDiaryBodyAccess(c, resourcePath)
      if (bodyAccess) return bodyAccess
    }
    const result = await readMarkdownResource(
      c.req.query('kind'),
      c.req.query('path'),
      c.req.raw.signal,
    )
    c.header('Cache-Control', 'no-store')
    c.header('X-Content-Type-Options', 'nosniff')
    if (result.kind === 'image') {
      return new Response(result.content, {
        headers: {
          'Cache-Control': 'no-store',
          'Content-Type': result.contentType,
          'X-Content-Type-Options': 'nosniff',
        },
      })
    }
    return c.json({ kind: result.kind, path: result.path, content: result.content })
  } catch (error) {
    const resourceError = error instanceof MarkdownResourceError
      ? error
      : new MarkdownResourceError('resource-unavailable', 404)
    c.header('Cache-Control', 'no-store')
    return c.json({ error: 'Unable to load Markdown resource.', code: resourceError.code }, resourceError.status as 400)
  }
})

export default markdownResourceRoutes

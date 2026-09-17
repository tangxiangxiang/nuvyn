import { expect, test } from './fixtures/auth'

test('authenticated fixture owns a real session for pages and API requests', async ({ page, request, context }) => {
  const status = await request.get('/api/auth/status')
  expect(status.status()).toBe(200)
  expect(await status.json()).toMatchObject({ authenticated: true })

  const tree = await request.get('/api/tree')
  expect(tree.status()).toBe(200)

  const cookies = await context.cookies()
  const sessionCookie = cookies.find((cookie) => cookie.name === 'nuvyn_session')
  expect(sessionCookie).toMatchObject({ httpOnly: true, secure: false, sameSite: 'Lax', path: '/' })

  await page.goto('/__markdown-test?mode=reading')
  const browserStorage = await page.evaluate(() => ({
    local: { ...localStorage },
    session: { ...sessionStorage },
  }))
  expect(JSON.stringify(browserStorage)).not.toContain('e2e-owner')
  expect(JSON.stringify(browserStorage)).not.toContain('nuvyn-e2e-setup-token')
})

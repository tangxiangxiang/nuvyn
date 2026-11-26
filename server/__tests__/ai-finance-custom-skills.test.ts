import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import app from '../index.js'
import { createFinanceAgent, manageSkillTool, readSkillTool } from '../ai/finance-agent.js'
import { createFinanceCustomSkillRepository, FINANCE_CUSTOM_SKILL_LIMITS } from '../ai/finance-custom-skills.js'
import { createFinanceMemoryRepository } from '../ai/finance-memory.js'
import { createLedgerAnalysis } from '../ai/ledger-analysis.js'
import type { LedgerAiContext } from '../ledger/aiContext.js'
import { authenticatedRequest, closeAuthTestContext, createAuthenticatedTestContext, type AuthenticatedTestContext } from './helpers/auth.js'

let db: Database.Database
let auth: AuthenticatedTestContext

beforeEach(() => {
  db = new Database(':memory:')
  auth = createAuthenticatedTestContext({ db })
})

afterEach(() => closeAuthTestContext(auth))

function request(path: string, method = 'GET', body?: unknown) {
  return app.fetch(authenticatedRequest(auth, '/api/ai' + path, {
    method,
    ...(body === undefined ? {} : { body }),
  }))
}

function addAnotherUser(): number {
  const result = db.prepare(`
    INSERT INTO users (username, username_normalized, password_hash, created_at, updated_at)
    VALUES ('other-skill-user', 'other-skill-user', 'hash', 1, 1)
  `).run()
  return Number(result.lastInsertRowid)
}

const input = (name: string, patch: Partial<{ title: string; description: string; content: string }> = {}) => ({
  name,
  title: 'Monthly report',
  description: 'Review the month using the requested order.',
  content: 'Start with income, spending and repayments; compare with the same period last month.',
  ...patch,
})

const ledgerContext = {
  settings: { baseCurrency: 'CNY', timezone: 'UTC' },
  accounts: new Map(), categories: new Map(), transactions: new Map(), excluded: new Set(),
} as unknown as LedgerAiContext

describe('Finance custom skill repository', () => {
  it('persists custom skills by owner and rejects built-in, malformed, duplicate and path-like names', () => {
    const repository = createFinanceCustomSkillRepository(db)
    const created = repository.create(auth.userId, input('custom-monthly-report'), 10)
    expect(created).toMatchObject({ ok: true, skill: { name: 'custom-monthly-report', source: 'custom', revision: 1, createdAt: 10 } })
    if (!created.ok) throw new Error('expected skill to be created')
    expect(repository.get(auth.userId, created.skill.name)?.content).toBe(input('custom-monthly-report').content)
    expect(repository.list(addAnotherUser())).toEqual([])
    expect(repository.create(auth.userId, input('custom-monthly-report'))).toMatchObject({ ok: false, error: 'duplicate' })
    expect(repository.create(auth.userId, input('monthly-review'))).toMatchObject({ ok: false, error: 'builtin-name' })
    expect(repository.create(auth.userId, input('Custom-monthly-report'))).toMatchObject({ ok: false, error: 'invalid-name' })
    expect(repository.create(auth.userId, input('custom-../../package-json'))).toMatchObject({ ok: false, error: 'invalid-name' })
    expect(repository.create(auth.userId, input('custom-bad--slug'))).toMatchObject({ ok: false, error: 'invalid-name' })
  })

  it('enforces skill count, per-skill and total Unicode capacity without truncating', () => {
    const repository = createFinanceCustomSkillRepository(db)
    expect(repository.create(auth.userId, input('custom-too-long', { content: '💰'.repeat(3_001) })))
      .toMatchObject({ ok: false, error: 'too-long' })
    expect(repository.create(auth.userId, input('custom-title-too-long', { title: '界'.repeat(81) })))
      .toMatchObject({ ok: false, error: 'too-long' })

    for (let index = 1; index <= 5; index++) {
      const created = repository.create(auth.userId, input(`custom-capacity-${index}`, { content: '界'.repeat(3_000) }))
      expect(created.ok).toBe(true)
    }
    expect(repository.usage(auth.userId)).toEqual({
      count: 5,
      countLimit: FINANCE_CUSTOM_SKILL_LIMITS.count,
      contentCharacters: 15_000,
      contentLimit: 15_000,
    })
    expect(repository.create(auth.userId, input('custom-capacity-overflow', { content: 'one more' })))
      .toMatchObject({ ok: false, error: 'capacity-exceeded' })
    expect(repository.list(auth.userId)).toHaveLength(5)

  })

  it('uses id plus revision to reject ABA updates and deletes across explicit restoration', () => {
    const repository = createFinanceCustomSkillRepository(db)
    const created = repository.create(auth.userId, input('custom-savings-method'), 10)
    if (!created.ok) throw new Error('expected skill to be created')
    const updated = repository.update(auth.userId, created.skill.name, { content: 'Review savings against the stated goal.' }, created.skill.id, 1, 20)
    expect(updated).toMatchObject({ ok: true, skill: { revision: 2, updatedAt: 20 } })
    expect(repository.update(auth.userId, created.skill.name, { content: 'Stale overwrite.' }, created.skill.id, 1)).toMatchObject({ ok: false, error: 'stale-revision' })
    expect(repository.remove(auth.userId, created.skill.name, created.skill.id, 1)).toMatchObject({ ok: false, error: 'stale-revision' })
    expect(repository.remove(auth.userId, created.skill.name, created.skill.id, 2, 30)).toMatchObject({ ok: true })
    expect(repository.create(auth.userId, input(created.skill.name))).toMatchObject({ ok: false, error: 'previously-deleted' })
    const restored = repository.createExplicitly(auth.userId, input(created.skill.name), 40)
    expect(restored).toMatchObject({ ok: true, skill: { revision: 1 } })
    if (!restored.ok) throw new Error('expected explicit restoration')
    expect(restored.skill.id).not.toBe(created.skill.id)
    expect(repository.update(auth.userId, created.skill.name, { content: 'Old client overwrite.' }, created.skill.id, 2))
      .toMatchObject({ ok: false, error: 'stale-instance' })
    expect(repository.remove(auth.userId, created.skill.name, created.skill.id, 2))
      .toMatchObject({ ok: false, error: 'stale-instance' })
    expect(repository.get(auth.userId, created.skill.name)?.content).toBe(input(created.skill.name).content)
  })

  it('generates an internal slug from the title and reuses a deleted slug only on explicit user creation', () => {
    const repository = createFinanceCustomSkillRepository(db)
    const createInput = { title: 'Monthly review', description: 'Personal review', content: 'Review actual cashflow.' }
    const first = repository.createForUser(auth.userId, createInput)
    expect(first).toMatchObject({ ok: true, skill: { name: 'custom-monthly-review' } })
    if (!first.ok) throw new Error('expected user skill to be created')
    expect(repository.remove(auth.userId, first.skill.name, first.skill.id, 1).ok).toBe(true)
    const restored = repository.createForUser(auth.userId, createInput)
    expect(restored).toMatchObject({ ok: true, skill: { name: 'custom-monthly-review' } })
  })
})

describe('Finance custom skill HTTP API', () => {
  it('lists built-ins with current-owner custom metadata and returns no-store private responses', async () => {
    const repository = createFinanceCustomSkillRepository(db)
    const own = repository.create(auth.userId, input('custom-private-method'))
    const otherUserId = addAnotherUser()
    repository.create(otherUserId, input('custom-other-method'))

    const response = await request('/finance-skills')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.json() as { skills: Array<{ name: string; source: string }> }
    expect(body.skills.filter(skill => skill.source === 'builtin')).toHaveLength(5)
    expect(body.skills.map(skill => skill.name)).toContain('custom-private-method')
    expect(body.skills.map(skill => skill.name)).not.toContain('custom-other-method')
    expect((await request('/finance-skills/custom-other-method')).status).toBe(404)
    if (own.ok) expect((await request(`/finance-skills/${own.skill.name}`)).status).toBe(200)
  })

  it('creates, edits with optimistic revision, deletes and explicitly restores a skill without an AI provider', async () => {
    const create = await request('/finance-skills', 'POST', {
      title: '个人月度回顾', description: '按偏好复盘月度收支', content: '先列收入、支出和还款，再分析结余。',
    })
    expect(create.status).toBe(201)
    const created = await create.json() as { skill: { id: number; name: string; revision: number; source: string } }
    expect(created.skill).toMatchObject({ id: expect.any(Number), name: expect.stringMatching(/^custom-/), revision: 1, source: 'custom' })

    const update = await request(`/finance-skills/${created.skill.name}`, 'PATCH', {
      title: '个人月度财务回顾', description: '按偏好复盘月度收支', content: '先列收入、支出和还款，再比较上月同期。', expectedId: created.skill.id, expectedRevision: 1,
    })
    expect(update.status).toBe(200)
    const changed = await update.json() as { skill: { id: number; revision: number; content: string } }
    expect(changed.skill).toMatchObject({ revision: 2, content: '先列收入、支出和还款，再比较上月同期。' })
    const stale = await request(`/finance-skills/${created.skill.name}`, 'PATCH', {
      content: 'Overwrite stale content.', expectedId: created.skill.id, expectedRevision: 1,
    })
    expect(stale.status).toBe(409)
    expect((await request(`/finance-skills/${created.skill.name}?expectedId=${changed.skill.id}&expectedRevision=2`, 'DELETE')).status).toBe(200)
    expect((await request(`/finance-skills/${created.skill.name}`)).status).toBe(404)

    const restored = await request('/finance-skills', 'POST', {
      title: '个人月度财务回顾', description: '按偏好复盘月度收支', content: '重新创建的分析流程。',
    })
    expect(restored.status).toBe(201)
    const restoredSkill = (await restored.json() as { skill: { id: number; name: string } }).skill
    expect(restoredSkill.name).toBe(created.skill.name)
    expect(restoredSkill.id).not.toBe(created.skill.id)
    const staleRestoreUpdate = await request(`/finance-skills/${created.skill.name}`, 'PATCH', {
      content: 'Stale computer update.', expectedId: created.skill.id, expectedRevision: 1,
    })
    expect(staleRestoreUpdate.status).toBe(409)
    expect(await staleRestoreUpdate.json()).toMatchObject({ code: 'stale-instance' })
    const staleRestoreDelete = await request(`/finance-skills/${created.skill.name}?expectedId=${created.skill.id}&expectedRevision=1`, 'DELETE')
    expect(staleRestoreDelete.status).toBe(409)
    expect(await staleRestoreDelete.json()).toMatchObject({ code: 'stale-instance' })
    expect((await request(`/finance-skills/${created.skill.name}`)).status).toBe(200)
  })

  it('requires instance identity for HTTP edits and deletes', async () => {
    const createdResponse = await request('/finance-skills', 'POST', {
      title: 'Instance check', description: 'Validate instance identity.', content: 'Compare the same periods.',
    })
    const created = (await createdResponse.json() as { skill: { id: number; name: string } }).skill
    expect((await request(`/finance-skills/${created.name}`, 'PATCH', {
      content: 'A revision without identity must not write.', expectedRevision: 1,
    })).status).toBe(400)
    expect((await request(`/finance-skills/${created.name}?expectedRevision=1`, 'DELETE')).status).toBe(400)
    expect((await request(`/finance-skills/${created.name}`)).status).toBe(200)
  })

  it('rejects body-supplied owner ids, built-in mutations, and writes while the finance operation is locked', async () => {
    expect((await request('/finance-skills', 'POST', {
      title: 'Wrong owner', description: 'No client-selected owner', content: 'Procedure only.', ownerId: addAnotherUser(),
    })).status).toBe(400)
    expect((await request('/finance-skills/monthly-review', 'PATCH', {
      title: 'Overwrite built-in', expectedId: 1, expectedRevision: 1,
    })).status).toBe(400)

    const { ensureLedgerAiThread, acquireLedgerAiOperation } = await import('../ai/sessions.js')
    const thread = ensureLedgerAiThread(db, auth.userId)
    const release = acquireLedgerAiOperation(db, thread.session.id)
    expect(release).toBeTypeOf('function')
    try {
      expect((await request('/finance-skills', 'POST', {
        title: 'Busy', description: 'Busy lock', content: 'Procedure.',
      })).status).toBe(409)
    } finally {
      release?.()
    }
  })
})

describe('Finance Agent custom skill learning', () => {
  const evidence = '以后分析月度财务时，先列收入、支出，再比较上月同期。'

  async function callTool(agent: ReturnType<typeof createFinanceAgent>, name: string, inputValue: unknown) {
    expect(agent.beginBatch(1)).toBe(true)
    return agent.execute({ id: name + Math.random(), name, input: inputValue }, 1, 0, async () => {})
  }

  it('rejects stale Agent writes and reloads a recreated same-name skill as a new instance', async () => {
    const repository = createFinanceCustomSkillRepository(db)
    const original = repository.create(auth.userId, input('custom-aba-learning'))
    if (!original.ok) throw new Error('expected initial skill')
    const agent = createFinanceAgent(createLedgerAnalysis(ledgerContext), { db, ownerId: auth.userId }, evidence)
    const firstRead = await callTool(agent, readSkillTool.name, { name: original.skill.name })
    expect(JSON.parse(firstRead.content)).toMatchObject({ id: original.skill.id, revision: 1 })

    expect(repository.remove(auth.userId, original.skill.name, original.skill.id, 1).ok).toBe(true)
    const restored = repository.createExplicitly(auth.userId, input(original.skill.name, {
      title: 'Restored monthly method',
      content: 'The restored instance has its own procedure.',
    }))
    if (!restored.ok) throw new Error('expected explicit restoration')
    expect(restored.skill.id).not.toBe(original.skill.id)

    const secondRead = await callTool(agent, readSkillTool.name, { name: original.skill.name })
    expect(secondRead.status).toBe('success')
    expect(JSON.parse(secondRead.content)).toMatchObject({
      id: restored.skill.id,
      revision: 1,
      content: restored.skill.content,
    })
    const staleWrite = await callTool(agent, manageSkillTool.name, {
      action: 'update', name: original.skill.name, expectedId: original.skill.id, expectedRevision: 1,
      content: 'The stale Agent must not overwrite the restored method.', evidence,
    })
    expect(staleWrite.status).toBe('failed')
    expect(JSON.parse(staleWrite.content)).toMatchObject({ ok: false, error: expect.stringContaining('deleted or recreated') })
    expect(repository.get(auth.userId, original.skill.name)?.content).toBe(restored.skill.content)
    expect(agent.systemPrompt).toContain(`"id":${restored.skill.id}`)
  })

  it('reuses one request metadata snapshot and refreshes it once after a successful write', async () => {
    const prepareSpy = vi.spyOn(db, 'prepare')
    const metadataQueryCount = () => prepareSpy.mock.calls.filter(([sql]) =>
      sql.includes('SELECT id, name, title, description, revision') && sql.includes('FROM ai_finance_skills'),
    ).length
    const agent = createFinanceAgent(createLedgerAnalysis(ledgerContext), { db, ownerId: auth.userId }, evidence)
    void agent.systemPrompt
    void agent.systemPrompt
    agent.availableTools(true)
    agent.availableTools(true)
    expect(metadataQueryCount()).toBe(1)

    const created = await callTool(agent, manageSkillTool.name, {
      action: 'create', name: 'custom-request-snapshot', title: 'Request snapshot',
      description: 'Visible immediately within this request.', content: 'Compare equivalent periods.', evidence,
    })
    expect(created.status).toBe('success')
    expect(agent.systemPrompt).toContain('custom-request-snapshot')
    agent.availableTools(true)
    void agent.systemPrompt
    expect(metadataQueryCount()).toBe(2)
    const nextRequest = createFinanceAgent(createLedgerAnalysis(ledgerContext), { db, ownerId: auth.userId }, evidence)
    expect(nextRequest.systemPrompt).toContain('custom-request-snapshot')
    expect(metadataQueryCount()).toBe(3)
    prepareSpy.mockRestore()
  })

  it('creates, discovers, loads, updates and reloads a user-approved method in one request', async () => {
    const memory = createFinanceMemoryRepository(db)
    const agent = createFinanceAgent(createLedgerAnalysis(ledgerContext), { db, ownerId: auth.userId }, `以后分析月度财务时，先列收入、支出，再比较上月同期。`)
    expect(agent.availableTools(true).map(tool => tool.name)).toEqual(['read_ledger', 'manage_memory', 'read_skill', 'manage_skill'])
    expect(agent.systemPrompt).not.toContain('custom-monthly-report')

    const created = await callTool(agent, manageSkillTool.name, {
      action: 'create', name: 'custom-monthly-report', title: '个人月度回顾', description: '按用户指定顺序整理月度收支。',
      content: '先列收入、支出和还款，再与上月同期比较。', evidence,
    })
    expect(created.status).toBe('success')
    expect(JSON.parse(created.content)).toMatchObject({ ok: true, action: 'create', skill: { name: 'custom-monthly-report', revision: 1 } })
    expect(agent.systemPrompt).toContain('custom-monthly-report')
    expect(agent.systemPrompt).not.toContain('先列收入、支出和还款')
    expect(agent.availableTools(true).find(tool => tool.name === 'read_skill')?.parameters.properties.name.enum).toContain('custom-monthly-report')

    const firstRead = await callTool(agent, readSkillTool.name, { name: 'custom-monthly-report' })
    expect(JSON.parse(firstRead.content)).toMatchObject({ ok: true, source: 'custom', revision: 1, content: expect.stringContaining('上月同期') })

    const updated = await callTool(agent, manageSkillTool.name, {
      action: 'update', name: 'custom-monthly-report', expectedId: JSON.parse(firstRead.content).id, expectedRevision: 1,
      content: '先列收入、支出和还款，再与上月同期比较，最后最多给三条建议。', evidence,
    })
    expect(updated.status).toBe('success')
    expect(JSON.parse(updated.content)).toMatchObject({ ok: true, action: 'update', skill: { revision: 2 } })
    expect(agent.systemPrompt).toContain('"revision":2')
    const secondRead = await callTool(agent, readSkillTool.name, { name: 'custom-monthly-report' })
    expect(JSON.parse(secondRead.content)).toMatchObject({ ok: true, revision: 2, content: expect.stringContaining('最多给三条建议') })
    expect(memory.list(auth.userId)).toEqual([])
  })

  it('requires exact current-user evidence and enforces two writes per request without blocking Ledger reads', async () => {
    const agent = createFinanceAgent(createLedgerAnalysis(ledgerContext), { db, ownerId: auth.userId }, evidence)
    const payload = (name: string) => ({
      action: 'create', name, title: 'Review method', description: 'Review using a reusable method.', content: 'Compare the same periods.',
      evidence: 'A phrase from an old conversation, not the current message.',
    })
    const unsupported = await callTool(agent, manageSkillTool.name, payload('custom-unsupported-method'))
    expect(JSON.parse(unsupported.content)).toMatchObject({ ok: false, error: expect.stringContaining('exact quote') })
    expect(createFinanceCustomSkillRepository(db).list(auth.userId)).toEqual([])

    const valid = (name: string) => ({ ...payload(name), evidence })
    expect((await callTool(agent, manageSkillTool.name, valid('custom-method-one'))).status).toBe('success')
    const secondAttempt = await callTool(agent, manageSkillTool.name, valid('custom-method-two'))
    expect(JSON.parse(secondAttempt.content)).toMatchObject({ ok: false, error: expect.stringContaining('write budget exhausted') })
    const third = await callTool(agent, manageSkillTool.name, valid('custom-method-three'))
    expect(JSON.parse(third.content)).toMatchObject({ ok: false, error: 'Custom skill write budget exhausted. Finish without additional skill changes.' })

    expect(agent.beginBatch(1)).toBe(true)
    const ledger = await agent.execute({ id: 'ledger-read', name: 'read_ledger', input: { kind: 'accounts' } }, 1, 0, async () => {})
    expect(ledger.status).toBe('success')
    expect(JSON.parse(ledger.content)).toHaveProperty('accounts')
    expect(createFinanceCustomSkillRepository(db).list(auth.userId)).toHaveLength(1)

    const twoWriteAgent = createFinanceAgent(createLedgerAnalysis(ledgerContext), { db, ownerId: auth.userId }, evidence)
    expect((await callTool(twoWriteAgent, manageSkillTool.name, valid('custom-method-two'))).status).toBe('success')
    expect((await callTool(twoWriteAgent, manageSkillTool.name, valid('custom-method-three'))).status).toBe('success')
    const thirdWrite = await callTool(twoWriteAgent, manageSkillTool.name, valid('custom-method-four'))
    expect(JSON.parse(thirdWrite.content)).toMatchObject({ ok: false, error: expect.stringContaining('write budget exhausted') })
    expect(createFinanceCustomSkillRepository(db).list(auth.userId)).toHaveLength(3)
  })

  it('checks cancellation before writing and lets Ledger analysis continue if custom storage fails', async () => {
    const repository = createFinanceCustomSkillRepository(db)
    const cancelledAgent = createFinanceAgent(createLedgerAnalysis(ledgerContext), { db, ownerId: auth.userId }, evidence)
    expect(cancelledAgent.beginBatch(1)).toBe(true)
    await expect(cancelledAgent.execute({
      id: 'cancelled-write', name: manageSkillTool.name,
      input: {
        action: 'create', name: 'custom-cancelled-method', title: 'Cancelled method',
        description: 'Must not be written after cancellation.', content: 'Compare the same periods.', evidence,
      },
    }, 1, 0, async () => { throw new Error('request is no longer authorized') })).rejects.toThrow('request is no longer authorized')
    expect(repository.list(auth.userId)).toEqual([])

    db.exec('DROP TABLE ai_finance_skills')
    const degradedAgent = createFinanceAgent(createLedgerAnalysis(ledgerContext), { db, ownerId: auth.userId }, evidence)
    expect(degradedAgent.availableTools(true).map(tool => tool.name)).toContain('read_skill')
    expect(degradedAgent.systemPrompt).toContain('monthly-review')
    const failedWrite = await callTool(degradedAgent, manageSkillTool.name, {
      action: 'create', name: 'custom-storage-failure', title: 'Storage failure',
      description: 'Storage errors should not abort a normal answer.', content: 'Compare the same periods.', evidence,
    })
    expect(failedWrite.status).toBe('failed')
    expect(JSON.parse(failedWrite.content)).toMatchObject({ ok: false, error: expect.stringContaining('unavailable') })

    expect(degradedAgent.beginBatch(1)).toBe(true)
    const ledger = await degradedAgent.execute({ id: 'ledger-after-write-error', name: 'read_ledger', input: { kind: 'accounts' } }, 1, 0, async () => {})
    expect(ledger.status).toBe('success')
    expect(JSON.parse(ledger.content)).toHaveProperty('accounts')
  })

  it('does not expose deletion through the Agent tool and does not recreate deleted skills', async () => {
    const repository = createFinanceCustomSkillRepository(db)
    const skill = repository.create(auth.userId, input('custom-deleted-method'))
    if (!skill.ok) throw new Error('expected custom skill')
    repository.remove(auth.userId, skill.skill.name, skill.skill.id, skill.skill.revision)
    const agent = createFinanceAgent(createLedgerAnalysis(ledgerContext), { db, ownerId: auth.userId }, 'Please use my existing analysis style.')
    expect(manageSkillTool.parameters.properties.action.enum).toEqual(['create', 'update'])
    expect(agent.availableTools(true).find(tool => tool.name === 'manage_skill')).toBeDefined()
    expect(agent.availableTools(true).find(tool => tool.name === 'read_skill')?.parameters.properties.name.enum).not.toContain(skill.skill.name)
    const restoreAttempt = await callTool(agent, manageSkillTool.name, {
      action: 'create', name: skill.skill.name, title: skill.skill.title, description: skill.skill.description,
      content: skill.skill.content, evidence: 'Please use my existing analysis style.',
    })
    expect(JSON.parse(restoreAttempt.content)).toMatchObject({ ok: false, error: expect.stringContaining('explicitly deleted') })
  })
})

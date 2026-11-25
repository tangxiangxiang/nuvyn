import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import app from '../index.js'
import { createFinanceAgent, readSkillTool } from '../ai/finance-agent.js'
import { createLedgerAnalysis } from '../ai/ledger-analysis.js'
import { createFinanceMemoryRepository } from '../ai/finance-memory.js'
import { buildFinanceSkillRegistryState, FINANCE_SKILL_LIMITS, financeSkillsDirectory, listFinanceSkills, parseFinanceSkillDocument, readFinanceSkill, type FinanceSkillName, type FinanceSkillRegistryEntry } from '../ai/finance-skills.js'
import type { LedgerAiContext } from '../ledger/aiContext.js'
import { authenticatedRequest, closeAuthTestContext, createAuthenticatedTestContext, type AuthenticatedTestContext } from './helpers/auth.js'

let db: Database.Database
let auth: AuthenticatedTestContext

beforeEach(() => {
  db = new Database(':memory:')
  auth = createAuthenticatedTestContext({ db })
})

afterEach(() => closeAuthTestContext(auth))

function request(path: string) {
  return app.fetch(authenticatedRequest(auth, '/api/ai' + path))
}

const context = {
  settings: { baseCurrency: 'CNY', timezone: 'UTC' },
  accounts: new Map(), categories: new Map(), transactions: new Map(), excluded: new Set(),
} as unknown as LedgerAiContext

describe('Finance Skills Registry', () => {
  it('registers five valid built-in skills and exposes only metadata in the directory', () => {
    const skills = listFinanceSkills()
    expect(skills.map(skill => skill.name)).toEqual([
      'monthly-review', 'spending-analysis', 'debt-analysis', 'cashflow-analysis', 'financial-planning',
    ])
    for (const skill of skills) expect(skill.description.length).toBeGreaterThan(0)
    const directory = createFinanceAgent(createLedgerAnalysis(context)).systemPrompt
    expect(directory).toContain('Available Finance Skills')
    expect(directory).toContain('monthly-review:')
    expect(directory).not.toContain('本月至今是有效期间')
  })

  it('loads complete Markdown bodies for each registered skill and rejects unsafe names', () => {
    for (const { name } of listFinanceSkills()) {
      const result = readFinanceSkill(name)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.skill.content).toMatch(/^# /u)
        expect(Array.from(result.skill.content).length).toBeLessThanOrEqual(FINANCE_SKILL_LIMITS.contentCharacters)
      }
    }
    expect(readFinanceSkill('unknown')).toEqual({ ok: false, error: 'unknown' })
    expect(readFinanceSkill('../../package.json')).toEqual({ ok: false, error: 'unknown' })
  })

  it('rejects mismatched metadata, unsupported metadata fields and oversized content', () => {
    expect(parseFinanceSkillDocument('monthly-review', `---\nname: spending-analysis\ndescription: Test\n---\n# Body`)).toEqual({ ok: false, error: 'invalid' })
    expect(parseFinanceSkillDocument('monthly-review', `---\nname: monthly-review\ndescription: Test\nversion: 1\n---\n# Body`)).toEqual({ ok: false, error: 'invalid' })
    const oversized = `---\nname: monthly-review\ndescription: Test\n---\n${'界'.repeat(FINANCE_SKILL_LIMITS.contentCharacters + 1)}`
    expect(parseFinanceSkillDocument('monthly-review', oversized)).toEqual({ ok: false, error: 'too-large' })
    expect(() => parseFinanceSkillDocument('monthly-review', '---\nname: monthly-review\nname: monthly-review\ndescription: Test\n---\n# Body')).not.toThrow()
    expect(parseFinanceSkillDocument('monthly-review', '---\nname: monthly-review\nname: monthly-review\ndescription: Test\n---\n# Body').ok).toBe(false)
  })

  it('isolates missing, invalid, oversized and thrown skill reads in the runtime registry', () => {
    const names: FinanceSkillName[] = ['monthly-review', 'spending-analysis', 'debt-analysis', 'cashflow-analysis', 'financial-planning']
    const entries: FinanceSkillRegistryEntry[] = names.map(name => ({ name, file: `${name}/SKILL.md` }))
    const malformed = parseFinanceSkillDocument('spending-analysis', 'not valid frontmatter')
    const oversized = parseFinanceSkillDocument('debt-analysis', `---\nname: debt-analysis\ndescription: Debt analysis\n---\n${'x'.repeat(FINANCE_SKILL_LIMITS.contentCharacters + 1)}`)
    const state = buildFinanceSkillRegistryState(entries, name => {
      if (name === 'monthly-review') return { ok: false, error: 'unavailable' }
      if (name === 'spending-analysis') return malformed
      if (name === 'debt-analysis') return oversized
      if (name === 'cashflow-analysis') throw new Error('private filesystem details')
      return readFinanceSkill(name)
    })
    expect(state.available.map(skill => skill.name)).toEqual(['financial-planning'])
    expect(state.unavailable).toEqual([
      { name: 'monthly-review', reason: 'unavailable' },
      { name: 'spending-analysis', reason: 'invalid' },
      { name: 'debt-analysis', reason: 'too-large' },
      { name: 'cashflow-analysis', reason: 'unavailable' },
    ])
    expect(state.configurationError).toBeNull()
  })

  it('reports registry configuration errors separately from unavailable skills', () => {
    const entries: FinanceSkillRegistryEntry[] = [
      { name: 'monthly-review', file: 'monthly-review/SKILL.md' },
      { name: 'monthly-review', file: 'duplicate/SKILL.md' },
    ]
    const state = buildFinanceSkillRegistryState(entries, () => ({ ok: false, error: 'unavailable' }))
    expect(state.configurationError).toBe('duplicate-name')
    expect(state.available).toEqual([])
    expect(state.unavailable).toEqual([{ name: 'monthly-review', reason: 'unavailable' }])
    expect(buildFinanceSkillRegistryState([], () => ({ ok: false, error: 'unknown' })).configurationError).toBe('empty')
  })

  it('provides a Phase 2A Finance Agent when every optional skill is unavailable', async () => {
    const registry = buildFinanceSkillRegistryState(
      [{ name: 'monthly-review', file: 'missing/SKILL.md' }],
      () => ({ ok: false, error: 'unavailable' }),
    )
    const message = 'Please remember that I prioritize an emergency fund over extra repayments.'
    const agent = createFinanceAgent(createLedgerAnalysis(context), { db, ownerId: auth.userId }, message, registry)
    expect(agent.availableTools(true).map(tool => tool.name)).toEqual(['read_ledger', 'manage_memory'])
    expect(agent.systemPrompt).toContain('Optional Finance Skills are unavailable')
    expect(agent.systemPrompt).not.toContain('monthly-review:')
    expect(agent.systemPrompt).not.toContain('read_skill')

    expect(agent.beginBatch(1)).toBe(true)
    const accounts = await agent.execute({ id: 'accounts', name: 'read_ledger', input: { kind: 'accounts' } }, 1, 0, async () => {})
    expect(accounts.status).toBe('success')
    expect(JSON.parse(accounts.content)).toHaveProperty('accounts')

    expect(agent.beginBatch(1)).toBe(true)
    const memory = await agent.execute({ id: 'remember', name: 'manage_memory', input: {
      action: 'add', target: 'user', content: 'Prioritize an emergency fund over extra repayments.',
      evidence: 'I prioritize an emergency fund over extra repayments.',
    } }, 1, 0, async () => {})
    expect(JSON.parse(memory.content)).toMatchObject({ ok: true, action: 'add' })
    expect(createFinanceMemoryRepository(db).list(auth.userId)).toHaveLength(1)
    expect(financeSkillsDirectory(registry)).toContain('No optional Finance Skills are currently available')
  })

  it('offers only usable skills and does not deduplicate a failed skill load as success', async () => {
    const entries: FinanceSkillRegistryEntry[] = [
      { name: 'monthly-review', file: 'monthly-review/SKILL.md' },
      { name: 'spending-analysis', file: 'spending-analysis/SKILL.md' },
    ]
    const registry = buildFinanceSkillRegistryState(entries, name => name === 'monthly-review'
      ? { ok: false, error: 'unavailable' }
      : readFinanceSkill(name))
    const agent = createFinanceAgent(createLedgerAnalysis(context), undefined, '', registry)
    const tool = agent.availableTools(true).find(({ name }) => name === 'read_skill')
    expect(tool?.parameters.properties.name.enum).toEqual(['spending-analysis'])

    const invalid = { id: 'unavailable', name: readSkillTool.name, input: { name: 'monthly-review' } }
    expect(agent.beginBatch(1)).toBe(true)
    const failed = await agent.execute(invalid, 1, 0, async () => {})
    expect(failed.status).toBe('failed')
    expect(JSON.parse(failed.content)).toMatchObject({ ok: false, error: 'Finance skill could not be loaded.' })
    expect(agent.beginBatch(1)).toBe(true)
    const failedAgain = await agent.execute(invalid, 1, 0, async () => {})
    expect(failedAgain.status).toBe('failed')
    expect(JSON.parse(failedAgain.content)).not.toHaveProperty('reused')
    expect(agent.beginBatch(1)).toBe(true)
    const successful = await agent.execute({ id: 'available', name: readSkillTool.name, input: { name: 'spending-analysis' } }, 1, 0, async () => {})
    expect(successful.status).toBe('success')
  })

  it('serves authenticated metadata and one requested body without calling an AI provider', async () => {
    const list = await request('/finance-skills')
    expect(list.status).toBe(200)
    expect(list.headers.get('cache-control')).toBe('no-store')
    expect((await list.json() as { skills: Array<{ name: string }> }).skills).toHaveLength(5)
    const detail = await request('/finance-skills/monthly-review')
    expect(detail.status).toBe(200)
    expect(await detail.json()).toMatchObject({ name: 'monthly-review', content: expect.stringContaining('# 月度财务回顾') })
    expect((await request('/finance-skills/../../package.json')).status).not.toBe(200)
  })
})

describe('Finance Agent read_skill tool', () => {
  it('offers the skill tool with the Ledger and memory tools and loads a skill only on demand', async () => {
    const agent = createFinanceAgent(createLedgerAnalysis(context))
    expect(agent.availableTools(true).map(tool => tool.name)).toEqual(['read_ledger', 'read_skill'])
    expect(agent.beginBatch(1)).toBe(true)
    const result = await agent.execute({ id: 'skill-1', name: readSkillTool.name, input: { name: 'monthly-review' } }, 1, 0, async () => {})
    expect(result.status).toBe('success')
    expect(JSON.parse(result.content)).toMatchObject({ ok: true, name: 'monthly-review', description: expect.any(String), content: expect.stringContaining('# 月度财务回顾') })
  })

  it('deduplicates successful loads, caps distinct skills per request and checks cancellation', async () => {
    const agent = createFinanceAgent(createLedgerAnalysis(context))
    const call = (name: string) => ({ id: name, name: readSkillTool.name, input: { name } })
    expect(agent.beginBatch(1)).toBe(true)
    const first = await agent.execute(call('monthly-review'), 1, 0, async () => {})
    expect(agent.beginBatch(1)).toBe(true)
    const duplicate = await agent.execute(call('monthly-review'), 1, 0, async () => {})
    expect(duplicate.status).toBe('reused')
    expect(JSON.parse(duplicate.content)).toMatchObject({ ok: true, reused: true })
    expect(JSON.parse(duplicate.content)).not.toHaveProperty('content')

    for (const name of ['spending-analysis', 'debt-analysis']) {
      expect(agent.beginBatch(1)).toBe(true)
      expect((await agent.execute(call(name), 1, 0, async () => {})).status).toBe('success')
    }
    expect(agent.beginBatch(1)).toBe(true)
    expect(JSON.parse((await agent.execute(call('cashflow-analysis'), 1, 0, async () => {})).content)).toMatchObject({ ok: false, error: 'Finance skill load limit reached for this request.' })
    const cancelledAgent = createFinanceAgent(createLedgerAnalysis(context))
    expect(cancelledAgent.beginBatch(1)).toBe(true)
    await expect(cancelledAgent.execute(call('financial-planning'), 1, 0, async () => { throw new Error('cancelled') })).rejects.toThrow('cancelled')
    expect(first.content).toContain('# 月度财务回顾')
  })

  it('does not accept restore flags or stale-context memory evidence as current-user sourcing', async () => {
    const user = db.prepare(`INSERT INTO users (username, username_normalized, password_hash, created_at, updated_at) VALUES ('memory-user', 'memory-user', 'hash', 1, 1)`).run()
    const ownerId = Number(user.lastInsertRowid)
    createFinanceMemoryRepository(db)
    const agent = createFinanceAgent(createLedgerAnalysis(context), { db, ownerId }, 'What did I say about budgeting before?')
    const input = { action: 'add', target: 'user', content: 'Keep an emergency fund.', evidence: 'I want to keep an emergency fund.', restoreDeleted: true }
    expect(agent.beginBatch(1)).toBe(true)
    const result = await agent.execute({ id: 'bad-memory', name: 'manage_memory', input }, 1, 0, async () => {})
    expect(JSON.parse(result.content)).toMatchObject({ ok: false })
    expect(agent.beginBatch(1)).toBe(true)
    const stale = await agent.execute({ id: 'old-context', name: 'manage_memory', input: {
      action: 'add', target: 'user', content: 'Keep an emergency fund.', evidence: 'I want to keep an emergency fund.',
    } }, 1, 0, async () => {})
    expect(JSON.parse(stale.content)).toMatchObject({ ok: false, error: 'Memory writes require an exact quote from the current user message.' })
    expect(db.prepare('SELECT COUNT(*) AS count FROM ai_finance_memory WHERE owner_user_id = ?').get(ownerId)).toEqual({ count: 0 })
  })

  it.each(['user', 'agent'] as const)('does not let the Finance Agent restore forgotten content as %s memory after a negation', async (target) => {
    const user = db.prepare(`INSERT INTO users (username, username_normalized, password_hash, created_at, updated_at) VALUES ('restore-user', 'restore-user', 'hash', 1, 1)`).run()
    const ownerId = Number(user.lastInsertRowid)
    const repository = createFinanceMemoryRepository(db)
    const old = repository.add(ownerId, 'user', 'Prioritize early mortgage repayment.')
    if (!old.ok) throw new Error('expected memory to be added')
    repository.remove(ownerId, 'user', old.memory.id)

    const currentMessage = 'I do not want to prioritize early mortgage repayment anymore; keep emergency cash instead.'
    const agent = createFinanceAgent(createLedgerAnalysis(context), { db, ownerId }, currentMessage)
    expect(agent.beginBatch(1)).toBe(true)
    const rejected = await agent.execute({ id: 'restore', name: 'manage_memory', input: {
      action: 'add', target, content: old.memory.content, evidence: 'I do not want to prioritize early mortgage repayment anymore',
    } }, 1, 0, async () => {})
    expect(JSON.parse(rejected.content)).toMatchObject({ ok: false, error: expect.stringContaining('previously forgotten') })
    expect(rejected.status).toBe('failed')
    expect(repository.list(ownerId)).toEqual([])
    expect(repository.canRestore(ownerId, 'user', old.memory.content)).toBe(true)
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { applyMigrations } from '../db.js'
import { DEFAULT_LEDGER_CATEGORIES_V2 } from '../ledger/defaultCategories.js'

const databases: Database.Database[] = []

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  databases.push(db)
  return db
}

function insertAccount(db: Database.Database, id: string, nature = 'asset'): void {
  db.prepare(`
    INSERT INTO ledger_accounts (
      id, name, type, nature, opening_balance_minor, opening_date, currency,
      note, archived_at, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)
  `).run(id, `Account ${id}`, nature === 'asset' ? 'bank' : 'loan', nature, 0, '2026-01-01', 'CNY', '', 1_000, 1_000)
}

function insertCategory(db: Database.Database, id: string, kind = 'expense'): void {
  db.prepare(`
    INSERT INTO ledger_categories (
      id, kind, name, normalized_name, archived_at, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, NULL, 1, ?, ?)
  `).run(id, kind, `Category ${id}`, `category ${id}`, 1_000, 1_000)
}

function insertIncome(
  db: Database.Database,
  id: string,
  accountId: string,
  categoryId: string,
  overrides: Record<string, unknown> = {},
): void {
  const values = {
    type: 'income',
    amountMinor: 100,
    accountId,
    fromAccountId: null,
    toAccountId: null,
    categoryId,
    occurredAt: 2_000,
    payee: '',
    note: '',
    calculated: null,
    target: null,
    deletedAt: null,
    version: 1,
    createdAt: 2_000,
    updatedAt: 2_000,
    ...overrides,
  }
  db.prepare(`
    INSERT INTO ledger_transactions (
      id, type, amount_minor, account_id, from_account_id, to_account_id,
      category_id, occurred_at, payee, note,
      adjustment_calculated_balance_minor, adjustment_target_balance_minor,
      deleted_at, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    values.type,
    values.amountMinor,
    values.accountId,
    values.fromAccountId,
    values.toAccountId,
    values.categoryId,
    values.occurredAt,
    values.payee,
    values.note,
    values.calculated,
    values.target,
    values.deletedAt,
    values.version,
    values.createdAt,
    values.updatedAt,
  )
}

function insertTransfer(
  db: Database.Database,
  id: string,
  fromAccountId: string,
  toAccountId: string,
  overrides: Record<string, unknown> = {},
): void {
  const values = {
    amountMinor: 100,
    transferKind: 'general',
    groupId: null,
    categoryId: null,
    payee: '',
    ...overrides,
  }
  db.prepare(`
    INSERT INTO ledger_transactions (
      id, type, transfer_kind, group_id, amount_minor, account_id, from_account_id, to_account_id,
      category_id, occurred_at, payee, note,
      adjustment_calculated_balance_minor, adjustment_target_balance_minor,
      deleted_at, version, created_at, updated_at
    ) VALUES (?, 'transfer', ?, ?, ?, NULL, ?, ?, ?, 2_000, ?, '', NULL, NULL, NULL, 1, 2_000, 2_000)
  `).run(id, values.transferKind, values.groupId, values.amountMinor, fromAccountId, toAccountId, values.categoryId, values.payee)
}

function insertGroupedExpense(
  db: Database.Database,
  id: string,
  groupId: string,
  accountId: string,
  categoryId: string,
  payee = '',
  version = 1,
): void {
  db.prepare(`
    INSERT INTO ledger_transactions (
      id, type, group_id, amount_minor, account_id, from_account_id, to_account_id,
      category_id, occurred_at, payee, note,
      adjustment_calculated_balance_minor, adjustment_target_balance_minor,
      deleted_at, version, created_at, updated_at
    ) VALUES (?, 'expense', ?, 100, ?, NULL, NULL, ?, 2_000, ?, '', NULL, NULL, NULL, ?, 2_000, 2_000)
  `).run(id, groupId, accountId, categoryId, payee, version)
}

function insertAdjustment(
  db: Database.Database,
  id: string,
  accountId: string,
  calculated: number,
  target: number,
  overrides: Record<string, unknown> = {},
): void {
  const values = {
    amountMinor: target - calculated,
    payee: '',
    ...overrides,
  }
  db.prepare(`
    INSERT INTO ledger_transactions (
      id, type, amount_minor, account_id, from_account_id, to_account_id,
      category_id, occurred_at, payee, note,
      adjustment_calculated_balance_minor, adjustment_target_balance_minor,
      deleted_at, version, created_at, updated_at
    ) VALUES (?, 'adjustment', ?, ?, NULL, NULL, NULL, 2_000, ?, '', ?, ?, NULL, 1, 2_000, 2_000)
  `).run(id, values.amountMinor, accountId, values.payee, calculated, target)
}

afterEach(() => {
  for (const db of databases.splice(0)) {
    if (db.open) db.close()
  }
})

describe('Ledger 0013 foundation migration', () => {
  it('creates the five schema-only Ledger tables and records the latest version', () => {
    const db = freshDb()
    applyMigrations(db)

    expect((db.prepare('SELECT version FROM schema_version').get() as { version: number }).version).toBe(35)
    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all() as Array<{ name: string }>).map((row) => row.name)
    expect(tables).toEqual(expect.arrayContaining([
      'ledger_settings',
      'ledger_accounts',
      'ledger_categories',
      'ledger_transactions',
      'ledger_idempotency',
      'ledger_transaction_statistics_exclusions',
    ]))
    expect(db.prepare('SELECT COUNT(*) AS count FROM ledger_settings').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM ledger_categories').get()).toEqual({ count: 0 })
    expect((db.prepare("PRAGMA table_info('ledger_transactions')").all() as Array<{ name: string }>).map((column) => column.name)).toContain('location')
    expect((db.prepare("PRAGMA table_info('ledger_transactions')").all() as Array<{ name: string }>).map((column) => column.name)).toContain('transfer_kind')
    expect((db.prepare("PRAGMA table_info('ledger_categories')").all() as Array<{ name: string }>).map((column) => column.name)).toContain('is_default')
    expect((db.prepare("PRAGMA table_info('ledger_categories')").all() as Array<{ name: string }>).map((column) => column.name)).toContain('sort_order')
    expect(tables.some((name) => /ledger_(monthly|balance|summary|cache)/.test(name))).toBe(false)
  })

  it('upgrades a schema through version 12 and is idempotent on repeat application', () => {
    const db = freshDb()
    db.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version (version) VALUES (12);
    `)

    applyMigrations(db)
    const firstTableCount = (db.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'",
    ).get() as { count: number }).count
    applyMigrations(db)

    expect((db.prepare('SELECT version FROM schema_version').get() as { version: number }).version).toBe(35)
    expect((db.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'",
    ).get() as { count: number }).count).toBe(firstTableCount)
  })

  it('adds the statistics sidecar without changing existing transactions or weakening its FK', () => {
    const db = freshDb()
    applyMigrations(db, 34)
    insertAccount(db, 'statistics-migration-account')
    insertCategory(db, 'statistics-migration-category')
    insertIncome(
      db,
      'statistics-migration-transaction',
      'statistics-migration-account',
      'statistics-migration-category',
      { amountMinor: 321, payee: 'preserve me' },
    )
    const before = db.prepare(`
      SELECT id, type, amount_minor, account_id, category_id, payee,
             occurred_at, note, deleted_at, version, created_at, updated_at
      FROM ledger_transactions
      WHERE id = 'statistics-migration-transaction'
    `).get()

    applyMigrations(db)

    expect((db.prepare('SELECT version FROM schema_version').get() as { version: number }).version).toBe(35)
    expect(db.prepare(`
      SELECT id, type, amount_minor, account_id, category_id, payee,
             occurred_at, note, deleted_at, version, created_at, updated_at
      FROM ledger_transactions
      WHERE id = 'statistics-migration-transaction'
    `).get()).toEqual(before)
    expect(db.prepare('SELECT COUNT(*) AS count FROM ledger_transaction_statistics_exclusions').get())
      .toEqual({ count: 0 })
    expect(() => db.prepare(`
      INSERT INTO ledger_transaction_statistics_exclusions (transaction_id, excluded_at)
      VALUES ('missing-transaction', 4_000)
    `).run()).toThrow()
  })

  it('restores legacy archived categories that already have transaction history', () => {
    const db = freshDb()
    applyMigrations(db, 24)
    insertAccount(db, 'legacy-category-account')
    insertCategory(db, 'legacy-used-category')
    insertCategory(db, 'legacy-unused-category')
    db.prepare(`
      UPDATE ledger_categories
      SET archived_at = 3_000
      WHERE id IN ('legacy-used-category', 'legacy-unused-category')
    `).run()
    insertIncome(db, 'legacy-category-transaction', 'legacy-category-account', 'legacy-used-category')

    applyMigrations(db)

    expect(db.prepare(`
      SELECT archived_at AS archivedAt, version, updated_at AS updatedAt
      FROM ledger_categories
      WHERE id = 'legacy-used-category'
    `).get()).toEqual({ archivedAt: null, version: 2, updatedAt: 3_000 })
    expect(db.prepare(`
      SELECT archived_at AS archivedAt, version
      FROM ledger_categories
      WHERE id = 'legacy-unused-category'
    `).get()).toEqual({ archivedAt: 3_000, version: 1 })
  })

  it('removes the legacy transfer payee restriction while preserving existing rows', () => {
    const db = freshDb()
    applyMigrations(db, 27)
    insertAccount(db, 'payee-from')
    insertAccount(db, 'payee-to')
    insertTransfer(db, 'legacy-transfer', 'payee-from', 'payee-to')

    applyMigrations(db)

    expect(db.prepare('SELECT payee FROM ledger_transactions WHERE id = ?').get('legacy-transfer')).toEqual({ payee: '' })
    expect(() => insertTransfer(db, 'transfer-with-payee', 'payee-from', 'payee-to', {
      payee: '招商银行还款',
    })).not.toThrow()
    expect(db.prepare('SELECT payee FROM ledger_transactions WHERE id = ?').get('transfer-with-payee')).toEqual({ payee: '招商银行还款' })
  })

  it('backfills known legacy grouped payees and preserves transaction snapshots', () => {
    const db = freshDb()
    applyMigrations(db, 28)
    insertAccount(db, 'withdrawal-source')
    insertAccount(db, 'withdrawal-destination')
    insertAccount(db, 'repayment-source')
    insertAccount(db, 'repayment-destination', 'liability')
    insertAccount(db, 'preserved-repayment-destination', 'liability')
    insertCategory(db, 'legacy-charge-category')
    db.prepare(`
      UPDATE ledger_accounts
      SET name = CASE id
        WHEN 'withdrawal-source' THEN '微信钱包'
        WHEN 'withdrawal-destination' THEN '招商银行储蓄卡'
        WHEN 'repayment-source' THEN '招商银行储蓄卡'
        WHEN 'repayment-destination' THEN '花呗'
        WHEN 'preserved-repayment-destination' THEN '花呗账单'
      END
      WHERE id IN ('withdrawal-source', 'withdrawal-destination', 'repayment-source', 'repayment-destination', 'preserved-repayment-destination')
    `).run()
    insertTransfer(db, 'legacy-withdrawal', 'withdrawal-source', 'withdrawal-destination', {
      transferKind: 'withdrawal',
      groupId: 'legacy-withdrawal-group',
    })
    insertGroupedExpense(db, 'legacy-withdrawal-fee', 'legacy-withdrawal-group', 'withdrawal-source', 'legacy-charge-category')
    insertTransfer(db, 'legacy-repayment', 'repayment-source', 'repayment-destination', {
      transferKind: 'repayment',
      groupId: 'legacy-repayment-group',
    })
    insertGroupedExpense(
      db,
      'legacy-repayment-interest',
      'legacy-repayment-group',
      'repayment-source',
      'legacy-charge-category',
      '花呗',
    )
    insertTransfer(db, 'preserved-withdrawal', 'withdrawal-source', 'withdrawal-destination', {
      transferKind: 'withdrawal',
      groupId: 'preserved-withdrawal-group',
    })
    insertGroupedExpense(
      db,
      'preserved-withdrawal-fee',
      'preserved-withdrawal-group',
      'withdrawal-source',
      'legacy-charge-category',
      '微信零钱提现手续费',
      7,
    )
    insertTransfer(db, 'preserved-repayment', 'repayment-source', 'repayment-destination', {
      transferKind: 'repayment',
      groupId: 'preserved-repayment-group',
    })
    insertGroupedExpense(
      db,
      'preserved-repayment-interest',
      'preserved-repayment-group',
      'repayment-source',
      'legacy-charge-category',
      '历史花呗还款利息',
      8,
    )
    insertTransfer(db, 'renamed-repayment', 'repayment-source', 'preserved-repayment-destination', {
      transferKind: 'repayment',
      groupId: 'renamed-repayment-group',
    })
    insertGroupedExpense(
      db,
      'renamed-repayment-interest',
      'renamed-repayment-group',
      'repayment-source',
      'legacy-charge-category',
      '花呗还款利息',
      9,
    )

    applyMigrations(db)

    expect(db.prepare('SELECT payee, version FROM ledger_transactions WHERE id = ?').get('legacy-withdrawal-fee')).toEqual({
      payee: '微信钱包提现手续费',
      version: 2,
    })
    expect(db.prepare('SELECT payee, version FROM ledger_transactions WHERE id = ?').get('legacy-repayment-interest')).toEqual({
      payee: '花呗还款利息',
      version: 2,
    })
    expect(db.prepare('SELECT payee, version FROM ledger_transactions WHERE id = ?').get('preserved-withdrawal-fee')).toEqual({
      payee: '微信零钱提现手续费',
      version: 7,
    })
    expect(db.prepare('SELECT payee, version FROM ledger_transactions WHERE id = ?').get('preserved-repayment-interest')).toEqual({
      payee: '历史花呗还款利息',
      version: 8,
    })
    expect(db.prepare('SELECT payee, version FROM ledger_transactions WHERE id = ?').get('renamed-repayment-interest')).toEqual({
      payee: '花呗还款利息',
      version: 9,
    })
    expect(db.prepare('SELECT name FROM ledger_accounts WHERE id = ?').get('preserved-repayment-destination')).toEqual({
      name: '花呗账单',
    })
  })

  it('keeps Account names non-unique and Category identity unique without parent/current-balance columns', () => {
    const db = freshDb()
    applyMigrations(db)
    insertAccount(db, 'same-name-a')
    insertAccount(db, 'same-name-b')
    expect(() => db.prepare(`
      INSERT INTO ledger_accounts (
        id, name, type, nature, opening_balance_minor, opening_date, currency,
        note, version, created_at, updated_at
      ) VALUES ('same-name-c', 'Account same-name-a', 'cash', 'asset', 0, '2026-01-01', 'CNY', '', 1, 1, 1)
    `).run()).not.toThrow()

    insertCategory(db, 'category-a')
    expect(() => db.prepare(`
      INSERT INTO ledger_categories (id, kind, name, normalized_name, version, created_at, updated_at)
      VALUES ('category-b', 'expense', 'Different display', 'category category-a', 1, 1, 1)
    `).run()).toThrow()

    const accountColumns = (db.prepare('PRAGMA table_info(ledger_accounts)').all() as Array<{ name: string }>)
      .map((column) => column.name)
    const categoryColumns = (db.prepare('PRAGMA table_info(ledger_categories)').all() as Array<{ name: string }>)
      .map((column) => column.name)
    expect(accountColumns).not.toContain('current_balance_minor')
    expect(categoryColumns).not.toContain('parent_id')
  })

  it('creates the accepted indexes and enables foreign keys for the test connection', () => {
    const db = freshDb()
    applyMigrations(db)
    const indexes = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_ledger_%' ORDER BY name",
    ).all() as Array<{ name: string }>).map((row) => row.name)
    expect(indexes).toEqual(expect.arrayContaining([
      'idx_ledger_accounts_archived_updated',
      'idx_ledger_categories_kind_archived_name',
      'idx_ledger_transactions_active_order',
      'idx_ledger_transactions_account',
      'idx_ledger_transactions_from_account',
      'idx_ledger_transactions_to_account',
      'idx_ledger_transactions_category',
    ]))
    expect((db.pragma('foreign_keys') as Array<{ foreign_keys: number }>)[0]?.foreign_keys).toBe(1)
  })

  it('enforces singleton, idempotency identity, and row-local transaction shapes', () => {
    const db = freshDb()
    applyMigrations(db)
    expect(() => db.prepare(`
      INSERT INTO ledger_settings (
        singleton_id, base_currency, timezone, created_at, updated_at
      ) VALUES (2, 'CNY', 'Asia/Shanghai', 1, 1)
    `).run()).toThrow()

    db.prepare(`
      INSERT INTO ledger_idempotency (
        operation_scope, idempotency_key, request_fingerprint, response_status,
        response_body_json, result_status, result_type, result_id, created_at
      ) VALUES ('POST:/api/ledger/transactions', 'retry-1', ?, 201, '{}', 'committed', 'transaction', 'tx-1', 1)
    `).run('a'.repeat(64))
    expect(() => db.prepare(`
      INSERT INTO ledger_idempotency (
        operation_scope, idempotency_key, request_fingerprint, response_status,
        response_body_json, result_status, created_at
      ) VALUES ('POST:/api/ledger/transactions', 'retry-1', ?, 201, '{}', 'committed', 2)
    `).run('b'.repeat(64))).toThrow()

    insertAccount(db, 'account-a')
    insertAccount(db, 'account-b')
    insertCategory(db, 'expense-a')
    insertCategory(db, 'income-a', 'income')

    expect(() => insertIncome(db, 'bad-missing-account', 'missing-account', 'expense-a')).toThrow()
    expect(() => insertIncome(db, 'bad-missing-category', 'account-a', 'missing-category')).toThrow()
    expect(() => insertIncome(db, 'bad-transfer-fields', 'account-a', 'expense-a', {
      fromAccountId: 'account-b',
    })).toThrow()
    expect(() => insertTransfer(db, 'bad-same-account', 'account-a', 'account-a')).toThrow()
    expect(() => insertTransfer(db, 'bad-transfer-category', 'account-a', 'account-b', {
      categoryId: 'expense-a',
    })).toThrow()
    expect(() => insertTransfer(db, 'bad-transfer-amount', 'account-a', 'account-b', {
      amountMinor: 0,
    })).toThrow()
    expect(() => insertTransfer(db, 'bad-transfer-kind-missing', 'account-a', 'account-b', {
      transferKind: null,
    })).toThrow()
    expect(() => insertTransfer(db, 'bad-transfer-kind-unknown', 'account-a', 'account-b', {
      transferKind: 'cash-out',
    })).toThrow()
    expect(() => insertAdjustment(db, 'bad-zero-adjustment', 'account-a', 100, 100, {
      amountMinor: 0,
    })).toThrow()
    expect(() => insertAdjustment(db, 'valid-adjustment-shape', 'account-a', 100, 200, {
      amountMinor: 100,
    })).not.toThrow()
    expect(() => db.prepare(`
      INSERT INTO ledger_transactions (
        id, type, amount_minor, account_id, occurred_at, payee, note,
        adjustment_calculated_balance_minor, adjustment_target_balance_minor,
        version, created_at, updated_at
      ) VALUES ('bad-adjustment-missing-values', 'adjustment', 100, 'account-a', 2000, '', '', NULL, 200, 1, 2000, 2000)
    `).run()).toThrow()
    expect(() => insertAdjustment(db, 'bad-adjustment-delta', 'account-a', 100, 200, {
      amountMinor: 99,
    })).toThrow()
    expect(() => insertIncome(db, 'bad-type', 'account-a', 'expense-a', {
      type: 'not-a-transaction',
    })).toThrow()
  })

  it('enforces RESTRICT for both active and soft-deleted transaction history', () => {
    const db = freshDb()
    applyMigrations(db)
    insertAccount(db, 'account-history')
    insertCategory(db, 'category-history')
    insertIncome(db, 'history-row', 'account-history', 'category-history')

    expect(() => db.prepare('DELETE FROM ledger_accounts WHERE id = ?').run('account-history')).toThrow()
    expect(() => db.prepare('DELETE FROM ledger_categories WHERE id = ?').run('category-history')).toThrow()

    db.prepare('UPDATE ledger_transactions SET deleted_at = ? WHERE id = ?').run(3_000, 'history-row')
    expect(() => db.prepare('DELETE FROM ledger_accounts WHERE id = ?').run('account-history')).toThrow()
    expect(() => db.prepare('DELETE FROM ledger_categories WHERE id = ?').run('category-history')).toThrow()
  })

  it('repairs migrated system category icons to the fresh-seed canonical values', () => {
    const db = freshDb()
    applyMigrations(db, 23)
    const systemCategories = DEFAULT_LEDGER_CATEGORIES_V2.filter((category) => category.systemKey !== undefined)
    const insert = db.prepare(`
      INSERT INTO ledger_categories (
        id, kind, name, normalized_name, system_key, icon, archived_at, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'wallet', NULL, 1, 1, 1)
    `)
    for (const category of systemCategories) {
      insert.run(`legacy-${category.systemKey}`, category.kind, category.name, category.name, category.systemKey)
    }

    db.prepare('UPDATE schema_version SET version = 22').run()
    applyMigrations(db, 23)

    const actual = db.prepare(`
      SELECT system_key, icon
      FROM ledger_categories
      WHERE system_key IN ('interest', 'fee')
      ORDER BY system_key
    `).all()
    const expected = systemCategories
      .map((category) => ({ system_key: category.systemKey, icon: category.icon }))
      .sort((left, right) => left.system_key!.localeCompare(right.system_key!))
    expect(actual).toEqual(expected)
    expect((db.prepare('SELECT version FROM schema_version').get() as { version: number }).version).toBe(23)

    applyMigrations(db)
    expect(db.prepare(`
      SELECT system_key, icon
      FROM ledger_categories
      WHERE system_key IN ('interest', 'fee')
      ORDER BY system_key
    `).all()).toEqual(expected)
  })

  it('migrates the default category catalog while preserving renamed identities', () => {
    const db = freshDb()
    applyMigrations(db, 26)
    db.prepare(`
      INSERT INTO ledger_settings (singleton_id, base_currency, timezone, created_at, updated_at)
      VALUES (1, 'CNY', 'Asia/Shanghai', 1, 1)
    `).run()

    const insert = db.prepare(`
      INSERT INTO ledger_categories (
        id, kind, name, normalized_name, system_key, icon, is_default,
        archived_at, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'wallet', 1, NULL, 3, 1, 1)
    `)
    for (const category of DEFAULT_LEDGER_CATEGORIES_V2) {
      if (category.name === '通讯' || category.name === '订阅' || category.name === '保险') continue
      const legacyName = category.name === '红包 / 礼金'
        ? '红包'
        : category.name === '人情往来' ? '人情' : category.name
      insert.run(
        `legacy-${category.kind}-${category.sortOrder}`,
        category.kind,
        legacyName,
        legacyName,
        category.systemKey ?? null,
      )
    }

    applyMigrations(db)

    expect(db.prepare(`
      SELECT id, name, normalized_name AS normalizedName, icon, is_default AS isDefault, sort_order AS sortOrder
      FROM ledger_categories
      WHERE id IN ('legacy-income-5', 'legacy-expense-12')
      ORDER BY kind
    `).all()).toEqual([
      { id: 'legacy-expense-12', name: '人情往来', normalizedName: '人情往来', icon: 'custom_builtin_category_expense_gift', isDefault: 1, sortOrder: 12 },
      { id: 'legacy-income-5', name: '红包 / 礼金', normalizedName: '红包 / 礼金', icon: 'custom_builtin_category_income_red_packet', isDefault: 1, sortOrder: 5 },
    ])

    const catalog = db.prepare(`
      SELECT kind, name, icon, sort_order AS sortOrder, is_default AS isDefault
      FROM ledger_categories
      WHERE is_default = 1
      ORDER BY kind, sort_order
    `).all()
    expect(catalog).toHaveLength(DEFAULT_LEDGER_CATEGORIES_V2.length)
    expect(catalog).toEqual(DEFAULT_LEDGER_CATEGORIES_V2
      .map(({ kind, name, icon, sortOrder }) => ({ kind, name, icon, sortOrder, isDefault: 1 }))
      .sort((left, right) => left.kind.localeCompare(right.kind) || left.sortOrder - right.sortOrder))

    applyMigrations(db)
    expect((db.prepare('SELECT COUNT(*) AS count FROM ledger_categories').get() as { count: number }).count).toBe(DEFAULT_LEDGER_CATEGORIES_V2.length)
  })
})

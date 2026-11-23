import type { Database } from 'better-sqlite3'
import type { LedgerAccount, LedgerCategory, LedgerSettings, LedgerTransaction } from './domain.js'
import { LedgerError } from './errors.js'
import { createLedgerRepository, type LedgerRepository } from './repository.js'

interface Context {
  readonly revision: number
  readonly schemaVersion: number
  readonly settings: LedgerSettings
  readonly accounts: ReadonlyMap<string, LedgerAccount>
  readonly categories: ReadonlyMap<string, LedgerCategory>
  readonly transactions: ReadonlyMap<string, LedgerTransaction>
  readonly excluded: ReadonlySet<string>
}

interface Change {
  revision: number
  entity: 'settings' | 'account' | 'category' | 'transaction'
  entity_id: string
}

const cache = new WeakMap<Database, { userId: number; context: Context }>()
const pageSize = 256

export function clearLedgerAiContext(db: Database): void {
  cache.delete(db)
}

function requireSettings(repository: LedgerRepository): LedgerSettings {
  const settings = repository.getSettings()
  if (!settings) throw new LedgerError('ledger-not-found', 404, 'Ledger Settings was not found')
  return settings
}

function byId<T extends { id: string }>(rows: readonly T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.id, row]))
}

function applyChanges<T>(current: ReadonlyMap<string, T>, ids: Set<string>, get: (id: string) => T | null) {
  if (!ids.size) return current
  const next = new Map(current)
  for (const id of ids) {
    const row = get(id)
    if (row === null) next.delete(id)
    else next.set(id, row)
  }
  return next
}

export function syncLedgerAiContext(db: Database, userId: number): Context {
  const cached = cache.get(db)
  if (cached && cached.userId !== userId) clearLedgerAiContext(db)
  // Ledger is owned by the authenticated instance owner. Keeping this check
  // at the cache boundary prevents accidental reuse by a different caller.
  if (!db.prepare('SELECT 1 FROM auth_instance WHERE id = 1 AND owner_user_id = ?').get(userId)) {
    throw new Error('Ledger AI owner mismatch')
  }
  const previous = cached?.userId === userId ? cached.context : undefined
  try {
    // The first metadata read pins the SQLite snapshot. Baseline reads, paged journal
    // reads, and point lookups all observe that same committed database state.
    const context = db.transaction((): Context => {
      const schemaVersion = db.prepare('SELECT version FROM schema_version').pluck().get() as number
      const revision = (db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'ledger_ai_changes'")
        .pluck().get() ?? 0) as number
      if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid Ledger revision')
      const compatible = previous?.schemaVersion === schemaVersion ? previous : undefined
      if (compatible?.revision === revision) return compatible

      const repository = createLedgerRepository(db)
      if (compatible && compatible.revision < revision) {
        const ids = {
          settings: new Set<string>(),
          account: new Set<string>(),
          category: new Set<string>(),
          transaction: new Set<string>(),
        }
        const page = db.prepare(`
          SELECT revision, entity, entity_id FROM ledger_ai_changes
          WHERE revision > ? AND revision <= ? ORDER BY revision LIMIT ?
        `)
        let cursor = compatible.revision
        journal: while (cursor < revision) {
          const changes = page.all(cursor, revision, pageSize) as Change[]
          if (!changes.length || changes[0].revision !== cursor + 1) break
          for (const change of changes) {
            if (change.revision !== cursor + 1 || !Object.hasOwn(ids, change.entity)) break journal
            ids[change.entity].add(change.entity_id)
            cursor = change.revision
          }
        }
        if (cursor === revision) {
          const excluded = new Set(compatible.excluded)
          const transactions = applyChanges(compatible.transactions, ids.transaction, (id) => {
            const row = repository.getTransaction(id)
            if (row?.deletedAt === null && repository.isTransactionExcludedFromStatistics(id)) excluded.add(id)
            else excluded.delete(id)
            return row?.deletedAt === null ? row : null
          })
          return {
            revision,
            schemaVersion,
            settings: ids.settings.size ? requireSettings(repository) : compatible.settings,
            accounts: applyChanges(compatible.accounts, ids.account, repository.getAccount),
            categories: applyChanges(compatible.categories, ids.category, repository.getCategory),
            transactions,
            excluded,
          }
        }
      }

      const settings = requireSettings(repository)
      const transactions = byId(repository.listActiveTransactions())
      return {
        revision,
        schemaVersion,
        settings,
        accounts: byId(repository.listAccounts({ includeArchived: true })),
        categories: byId(repository.listCategories({ includeArchived: true })),
        transactions,
        excluded: new Set(repository.listStatisticsExcludedTransactionIds().filter((id) => transactions.has(id))),
      }
    })()
    cache.set(db, { userId, context })
    return context
  } catch (error) {
    clearLedgerAiContext(db)
    throw error
  }
}

export type LedgerAiContext = ReturnType<typeof syncLedgerAiContext>

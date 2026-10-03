import type {
  LedgerAccountDto,
  LedgerAdjustmentTransactionDto,
  LedgerExpenseTransactionDto,
  LedgerIncomeTransactionDto,
  LedgerTransactionDto,
  LedgerTransferTransactionDto,
} from '../../../shared/ledgerProtocol'
import { getLedgerSettings, listLedgerAccounts, listLedgerCategories, listLedgerTransactions } from './api'
import { openingDateInputFromInstant } from './time'

export type LedgerAnalysisAccountDto = Pick<LedgerAccountDto,
  | 'id' | 'name' | 'nature' | 'type'
  | 'openingBalanceMinor' | 'openingDate' | 'currentBalanceMinor'
  | 'currency' | 'currencyExponent' | 'note' | 'archivedAt'
>

export type LedgerAnalysisTransactionDto = (
  | LedgerIncomeTransactionDto
  | LedgerExpenseTransactionDto
  | Omit<LedgerTransferTransactionDto, 'bundle'>
  | LedgerAdjustmentTransactionDto
) & {
  readonly categoryName?: string | null
  readonly accountName?: string | null
  readonly fromAccountName?: string | null
  readonly toAccountName?: string | null
}

export interface LedgerAnalysisExportDto {
  readonly version: 1
  readonly exportedAt: string
  readonly currency: string
  readonly timezone: string
  readonly accounts: readonly LedgerAnalysisAccountDto[]
  readonly transactions: readonly LedgerAnalysisTransactionDto[]
}

async function readAllLedgerTransactions(): Promise<LedgerTransactionDto[]> {
  const transactions: LedgerTransactionDto[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  let total: number | undefined

  do {
    const result = await listLedgerTransactions({
      limit: 200,
      includeDeleted: true,
      ...(cursor === undefined ? {} : { cursor }),
    })
    if (cursor === undefined) total = result.page.total
    transactions.push(...result.transactions)

    const nextCursor = result.page.nextCursor
    if (nextCursor === null) break
    if (typeof nextCursor !== 'string' || nextCursor.length === 0 || cursors.has(nextCursor)) {
      throw new Error('Ledger analysis export received an invalid transaction cursor')
    }
    cursors.add(nextCursor)
    cursor = nextCursor
  } while (true)

  if ((total !== undefined && transactions.length !== total)
    || new Set(transactions.map(({ id }) => id)).size !== transactions.length) {
    throw new Error('Ledger analysis export could not read a complete transaction history')
  }
  return transactions
}

export async function loadLedgerAnalysisExport(): Promise<LedgerAnalysisExportDto> {
  const [settings, accounts, categories] = await Promise.all([
    getLedgerSettings(),
    listLedgerAccounts(true),
    listLedgerCategories(undefined, true),
  ])
  if (settings === null) throw new Error('Ledger analysis export requires initialized settings')

  const transactions = await readAllLedgerTransactions()
  const accountNames = new Map(accounts.map(({ id, name }) => [id, name]))
  const categoryNames = new Map(categories.map(({ id, name }) => [id, name]))

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    currency: settings.baseCurrency,
    timezone: settings.timezone,
    accounts: accounts.map((account) => ({
      id: account.id,
      name: account.name,
      nature: account.nature,
      type: account.type,
      openingBalanceMinor: account.openingBalanceMinor,
      openingDate: account.openingDate,
      currentBalanceMinor: account.currentBalanceMinor,
      currency: account.currency,
      currencyExponent: account.currencyExponent,
      note: account.note,
      archivedAt: account.archivedAt,
    })),
    transactions: transactions.filter(({ deletedAt }) => deletedAt === null).map((transaction): LedgerAnalysisTransactionDto => {
      if (transaction.type === 'transfer') {
        // Export each accounting row, not the list's calculated bundle total.
        const { bundle: _bundle, ...principal } = transaction
        return {
          ...principal,
          fromAccountName: accountNames.get(transaction.fromAccountId) ?? null,
          toAccountName: accountNames.get(transaction.toAccountId) ?? null,
        }
      }
      return {
        ...transaction,
        accountName: accountNames.get(transaction.accountId) ?? null,
        ...(transaction.type === 'income' || transaction.type === 'expense'
          ? { categoryName: categoryNames.get(transaction.categoryId) ?? null }
          : {}),
      }
    }),
  }
}

export function downloadLedgerAnalysisExport(data: LedgerAnalysisExportDto): void {
  const date = openingDateInputFromInstant(Date.parse(data.exportedAt), data.timezone)
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const objectUrl = URL.createObjectURL(blob)
  let anchor: HTMLAnchorElement | undefined
  try {
    anchor = document.createElement('a')
    anchor.href = objectUrl
    anchor.download = `nuvyn-ledger-${date}.json`
    anchor.hidden = true
    document.body.appendChild(anchor)
    anchor.click()
  } finally {
    anchor?.remove()
    URL.revokeObjectURL(objectUrl)
  }
}

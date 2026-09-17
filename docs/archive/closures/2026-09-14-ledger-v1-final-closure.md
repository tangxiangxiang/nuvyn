# Ledger V1 Final Closure

**Status:** CLOSED — Maintenance Mode<br>
**Closure Date:** 2026-09-14<br>
**Branch:** `main`<br>
**Closure Baseline:** `cff21074c36e3e051b6198cfd7d9dcb25b8f3de6`<br>
**CI:** [#798](https://github.com/tangxiangxiang/nuvyn/actions/runs/34767552585) — passed

This is a historical closure record, not the authority for current runtime
behavior. The maintained authority remains the [current Ledger Architecture](../../architecture/ledger.md),
[Ledger User Guide](../../user-guide/ledger.md), and [Ledger UI Language](../../design/ledger-ui-language.md).
If this record differs from maintained documentation or the code, the maintained
documentation and runtime take precedence.

## Closure Verdict

Ledger V1 Core satisfies the current closure conditions. Core accounts,
transactions, balances, composite transactions, queries, historical
compatibility, documentation authority, and accounting parity protection are in
place. There is no known P0 or P1 correctness issue blocking closure, and CI
passed on the closure baseline.

Ledger V1 Core therefore moves from active feature development to Maintenance
Mode. “Closed” does not mean the feature is deleted or can never change; it
means the current implementation is the stable V1 baseline. New features, UI
polish, and speculative performance work move to backlog unless the reopen
criteria below are met.

## 1. Closed Scope

### Accounts

- Asset and liability natural-balance model.
- Cash, bank, wallet, credit card, loan, and other account types.
- Opening balance and opening date.
- Optional `cardNumber`, with masked display for existing values.
- Current-balance projection, account detail, running balance, and balance trend.
- Archive, restore, and delete lifecycle.

### Categories

- Income and expense categories.
- Default categories and protected system categories.
- Interest and fee categories.
- Icon support and recycle-bin lifecycle.

### Transactions

- Income, expense, general transfer, repayment, withdrawal, and adjustment.
- Edit, soft delete, pagination, filtering, and search.

### Composite Transactions

Repayment is a Transfer principal plus an optional Interest Expense. Withdrawal
is a Transfer plus an optional Fee Expense. A grouped companion Expense is a
real transaction row visible to the transaction query/list read model, but it
does not have independent mutation ownership. The parent transfer owns grouped
write, patch, and delete behavior atomically.

Withdrawal fee semantics are stable:

| Mode | Request | Persisted transfer | Source effect | Destination effect | Fee Expense |
| --- | ---: | ---: | ---: | ---: | ---: |
| `deducted` | 100 | 98 | -100 | +98 | 2 |
| `extra` | 100 | 100 | -102 | +100 | 2 |

New withdrawals default to `deducted`. For legacy withdrawals with an existing
fee and missing `feeMode`, compatibility interpretation remains `extra`.

### Persisted Companion Payees

Companion payees are persisted in `ledger_transactions.payee` as transaction-time
snapshots:

- Withdrawal fee: `${fromAccount.name}提现手续费`.
- Repayment interest: `${toAccount.name}还款利息`.

Account renames do not rewrite historical snapshots. A real transfer identity
change (`transferKind`, `fromAccountId`, or `toAccountId`) regenerates the
companion snapshot. Server projections and the UI do not invent a replacement
label when the persisted value is available.

Search covers persisted `payee`, `location`, and `note`, together with the
names of structured `accountId`, `fromAccountId`, and `toAccountId` accounts.
Consequently both a transfer and its companion can be found through a related
account name.

## 2. Accounting Correctness Closure

Ledger natural-balance rules are established and shared by all projections:

- For assets, income and transfer-in increase natural balance; expense and
  transfer-out decrease it.
- For liabilities, expense and transfer-out increase debt; income and
  transfer-in decrease debt.
- Repayment from an asset to a liability decreases both natural balances by
  the principal. Interest is a separate Expense on the source asset.
- Withdrawal is an asset-to-asset transfer; its fee is a separate Expense.
- Adjustments apply their signed delta directly.
- Deleted transactions have zero balance effect.

Transfer principal is not income or expense, and repayment principal does not
pollute expense totals.

## 3. Natural-Balance Parity Protection

The TypeScript/domain authority is
`server/ledger/balance.ts:transactionEffectForAccount()`. The repository
maintains the equivalent SQL effect projection
`ACCOUNT_TRANSACTION_EFFECT_SQL` for position-based balance queries.

Before closure, [repository-balance-parity.test.ts](../../../server/ledger/repository-balance-parity.test.ts)
established the contract that the same account, transaction set, and position
produce identical TypeScript and SQL balances. The suite covers:

- Asset and liability income/expense.
- All four general-transfer account-nature combinations.
- Repayment principal and interest companion.
- Withdrawal `extra` and `deducted` persisted rows.
- Positive and negative adjustments.
- Soft deletion.
- Mixed running balances.
- `occurredAt` / `createdAt` / `id` ordering.
- Exclusive balance-before boundaries.
- Batched position balances.

This protection is intended to fail CI if either the TypeScript effect engine or
the repository SQL projection changes without preserving the other side’s
accounting semantics.

## 4. Migration & Compatibility Closure

The current Ledger schema is version 29, with Ledger schema evolution spanning
migrations `0013` through `0029`.

The final payee compatibility work was delivered by:

- `0028_ledger_transfer_payee`: permits persisted transfer payees in the
  current transaction contract.
- `0029_ledger_companion_payees`: backfills known legacy companion payees
  without overwriting existing historical snapshots. Only rows actually
  changed by the backfill increment `version`.

Legacy `/bills` and `/bills/transactions` remain compatibility redirects, not
the current Ledger product surface.

## 5. Reliability Closure

The closed implementation has the following reliability foundations:

- SQLite transaction boundaries and atomic grouped writes.
- Optimistic concurrency through `expectedVersion`.
- Persistent idempotency and request fingerprinting.
- Create replay and uncertain-create recovery.
- Soft deletion and an ordered migration chain.
- Checked minor-unit arithmetic.

## 6. Documentation State

Current authority is intentionally split by purpose:

- [Ledger Architecture](../../architecture/ledger.md) — technical runtime
  authority.
- [Ledger User Guide](../../user-guide/ledger.md) — user behavior authority.
- [Ledger UI Language](../../design/ledger-ui-language.md) — Ledger UI language
  authority.

Historical Ledger PRDs, implementation plans, and closure reports explain
design lineage only. They cannot override current runtime behavior.

Before closure, current documentation was synchronized with the implementation,
including schema 29, `deducted` withdrawal defaults, companion visibility,
persisted payees, historical snapshots, account-name search, and the TS/SQL
balance architecture.

## 7. Verification Evidence

Closure baseline:

`cff21074c36e3e051b6198cfd7d9dcb25b8f3de6` —
`test(ledger): align adjustment parity fixture`

CI [#798](https://github.com/tangxiangxiang/nuvyn/actions/runs/34767552585) passed; the
closure baseline was fully green.

Key traceability commits, listed for lineage rather than as a changelog:

- `e8cd9900` — `fix(ledger): refresh companion payee on identity change`
- `d43e5dc2` — `test(ledger): cover companion identity changes`
- `0acbafd5` — `docs(ledger): sync current transaction semantics`
- `f35a63b4` — `docs(ledger): refine transaction semantics wording`
- `a76598ce` — `test(ledger): lock natural balance SQL parity`
- `cff21074` — `test(ledger): align adjustment parity fixture`

## 8. Deferred Work

The following are explicitly non-blocking for Ledger V1 closure:

### Performance

- Account DTO and history scans may have opportunities to reduce repeated
  queries.
- Overview projections may be optimized further.
- Trend queries may reduce in-memory filtering.
- Repeated scans or N+1 patterns can be addressed when measured production
  demand justifies the work.

### UI and Polish

Minor UI or CSS cleanup may be considered later. Existing accepted product
design choices are not reclassified as bugs by this closure.

### Security and Product

If Nuvyn later expands to cloud or sync scenarios, a full card-PAN security
policy should be evaluated as a separate security/product track. It is not a
Ledger V1 closure blocker.

### Future Features

Reports, budgets, bank synchronization, automatic categorization, and similar
features should begin as new features or epics rather than being treated as
unfinished Ledger V1 scope.

## 9. Maintenance Mode

After closure, Ledger work is allowed for:

- P0 data corruption.
- P0/P1 accounting correctness issues.
- Migration compatibility failures.
- Persistent-data recovery problems.
- Security vulnerabilities.
- Production crashes.
- Confirmed user-facing functional bugs.
- Necessary platform-compatibility fixes.

Cosmetic UI tweaks, speculative refactors, CSS cleanup, premature performance
tuning, “顺手优化”, and unrelated architectural rewrites remain backlog work
by default. Their existence does not reopen active Ledger development.

## 10. Reopen Criteria

Ledger V1 Core may return to active development only when one of these is true:

1. A P0 or P1 correctness issue is found.
2. Account balances, income/expense, transfer, repayment, withdrawal, or
   adjustment semantics are materially wrong.
3. The TS/SQL parity contract exposes real semantic drift.
4. Migration or historical compatibility causes a real user-facing problem.
5. Product explicitly approves a new Ledger epic or V2 scope.
6. A performance issue is measurable, reproducible, and materially affects
   users.

Otherwise, Ledger remains in Maintenance Mode.

## 11. Frozen V1 Invariants

- Transaction records are the source of truth; balances are projections.
- Money uses integer minor units.
- Natural balance depends on account nature.
- Transfer principal does not enter income/expense.
- Repayment principal does not count as expense.
- Fee and interest are Expense rows.
- Withdrawal defaults to `deducted`; `extra` remains supported.
- Companion payees are persisted transaction-time snapshots.
- Account renames do not rewrite historical companion payees.
- Transfer identity changes refresh companion payees.
- Companions are visible in the transaction read model.
- Companions have no independent mutation ownership.
- Grouped writes are atomic.
- Deleted transactions have zero balance effect.
- TypeScript and SQL balance semantics remain in parity.

## 12. Final Verdict

**CLOSED — MAINTENANCE MODE**

Ledger V1 Core has completed the current product scope. Core accounting
semantics, historical compatibility, documentation authority, reliable writes,
and natural-balance parity protection are established.

Closure baseline:
`cff21074c36e3e051b6198cfd7d9dcb25b8f3de6`<br>
CI: [#798](https://github.com/tangxiangxiang/nuvyn/actions/runs/34767552585) — passed

There is no known P0/P1 correctness issue blocking closure. Ledger is no longer
an active feature-development stream; future work follows Maintenance Mode and
the Reopen Criteria above.

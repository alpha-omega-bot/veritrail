# @veritrail/spend-guard

Budget tracking and hard-stop enforcement for AI agents, implemented as a
projection over the Veritrail ledger.

Spend Guard never keeps a separate accounting store. Configured budgets live in
memory (operator configuration), but **spend itself is always re-derived from the
ledger's `budget.charged` events** — so the engine is stateless with respect to
accumulated cost and cannot drift from the system of record. Enforcement
decisions are themselves recorded: every blocked charge appends a
`budget.exceeded` event.

## What it does

- **Budgets** — a spend `limit` over a `scope` (global / per-actor / per-label)
  and a time `window` (`total` / `daily` / `weekly` / `monthly`).
- **Authorize** — check a prospective spend against all matching budgets without
  recording it. Hard-stop budgets block (and record a `budget.exceeded` event);
  soft budgets warn but allow.
- **Charge** — authorize, then append a `budget.charged` event.
- **Status** — window-aware `spent` / `remaining` / `exceeded` per budget.

## Public API

```ts
import {
  SpendGuardModule,
  createSpendGuardModule,
  type SpendStatus,
  type AuthorizeInput,
} from '@veritrail/spend-guard';
```

- `class SpendGuardModule implements VeritrailModule`
  - `setBudget(input: unknown): Result<Budget, VeritrailError>` — validate (Zod
    `BudgetSchema`) and upsert by `id`. An absent `id` is assigned `bud…`.
  - `listBudgets(): Budget[]`
  - `authorize(input: AuthorizeInput): Promise<Result<void, VeritrailError>>`
  - `charge(input: AuthorizeInput): Promise<Result<LedgerRecord, VeritrailError>>`
  - `status(): Promise<SpendStatus[]>`
- `createSpendGuardModule(ctx: ModuleContext): SpendGuardModule`
- `type SpendStatus = { budget; spent; remaining; exceeded }`
- `type AuthorizeInput = { actorId; amount; labels?; actionId? }`

Errors are returned, never thrown: `BUDGET_EXCEEDED` when a hard-stop budget
would be breached, `VALIDATION` for malformed budgets or currency mismatches.

## Matching & scoping

A budget matches an `AuthorizeInput` when it is `enabled`, its currency equals
the amount's currency, and its scope matches:

| scope kind | matches when                                       |
| ---------- | -------------------------------------------------- |
| `global`   | always                                             |
| `actor`    | `scope.value === input.actorId`                    |
| `label`    | `scope.value` is `k=v` and `input.labels[k] === v` |

Each `budget.charged` event records the charge's `actorId` and `labels`. Spend is
attributed to a budget by re-applying the **same** scope match used by
`authorize`, so a single charge accrues against the `global` budget, the actor's
budget, and every `label` budget whose label was present on the charge — all at
once, with no double counting (the projection reads `budget.charged` only).

## Example

```ts
import {
  createInMemoryLedger,
  FixedClock,
  SequentialIdGenerator,
  money,
  isErr,
} from '@veritrail/core';
import { createSpendGuardModule } from '@veritrail/spend-guard';

const clock = new FixedClock(1_700_000_000_000);
const ledger = createInMemoryLedger({ clock, ids: new SequentialIdGenerator() });
const guard = createSpendGuardModule({
  ledger,
  clock,
  ids: new SequentialIdGenerator(),
  logger: noopLogger,
});

guard.setBudget({
  name: 'daily cap',
  scope: { kind: 'global' },
  limit: money(1000),
  window: 'daily',
});

await guard.charge({ actorId: 'agent-1', amount: money(600) }); // ok
const blocked = await guard.charge({ actorId: 'agent-1', amount: money(600) });
if (isErr(blocked)) console.error(blocked.error.code); // 'BUDGET_EXCEEDED'

console.log(await guard.status()); // [{ spent: 600, remaining: 400, exceeded: false }]
```

## Windows (v1 fixed-length approximation)

Windows are **sliding intervals of fixed length ending at `clock.now()`**, not
calendar-aligned boundaries:

| window    | length                                              |
| --------- | --------------------------------------------------- |
| `total`   | all history (no lower bound)                        |
| `daily`   | 86 400 000 ms (24h)                                 |
| `weekly`  | 7 days                                              |
| `monthly` | 30 days (flat, regardless of calendar month length) |

A charge counts toward a budget when its **ledger receipt timestamp** is within
`[now − length, now]`. This keeps the projection deterministic and clock-driven
(advance a `FixedClock` to test window expiry). Calendar-aligned windows and
timezone-aware boundaries are deferred.

## Notes

- The engine reads/writes only ledger events; it owns no parallel store.
- All logging goes through the injected `ctx.logger`; there is no `console.*`.

# @veritrail/rollback

The **rollback engine** for Veritrail: build and execute compensating plans to
reverse recorded actions.

Like every Veritrail capability, rollback is an engine over the single
tamper-evident, hash-chained ledger — it never keeps a parallel store. It reads
an action's recorded history (the `action.proposed` event carries the
[`ActionReversal`](../../core) descriptor; an `action.executed` event confirms
the action actually ran) to build a plan, then records each reversal by
appending an `action.rolled_back` event.

> **Status: SCAFFOLD.** A correct, deterministic baseline is implemented. Saga
> semantics, idempotency, and real executor adapters are deferred — see
> [Phase 1 TODO](#phase-1-todo).

## What it does

- **`planForAction(actionId)`** — finds the proposed action and confirms it was
  executed, then produces a one-step plan. Non-reversible actions (or strategy
  `none`), or actions that were never executed, land in `unreversible`. Returns
  a `NOT_FOUND` error if the action was never proposed.
- **`planForCorrelation(correlationId)`** — collects every executed, reversible
  action in a correlation and emits steps in **reverse chronological order**
  (highest `seq` first), so dependent effects unwind last-in-first-out.
- **`execute(plan, executor?)`** — runs each step. A pluggable
  `CompensationExecutor` performs the real side effect (cancel an order, restore
  a snapshot, …); the default executor is a success no-op that records intent
  only. On success an `action.rolled_back` event is appended (carrying the
  executor's `compensationActionId` when provided); on executor failure the step
  is skipped and nothing is written; `none` strategies are skipped outright.

## Public API

```ts
interface RollbackStep {
  actionId: string;
  strategy: ReversalStrategy; // 'compensate' | 'restore' | 'none'
  inverse?: { type: string; target: string; params: JsonValue };
  snapshotRef?: string;
}
interface RollbackPlan {
  steps: RollbackStep[];
  unreversible: string[];
}
interface RollbackOutcome {
  actionId: string;
  status: 'rolled_back' | 'skipped';
  detail: string;
}
interface RollbackResult {
  outcomes: RollbackOutcome[];
}

type CompensationExecutor = (
  step: RollbackStep,
) => Promise<{ ok: boolean; detail?: string; compensationActionId?: string }>;

interface RollbackProjectionOptions {
  /** Restrict planning to records carrying these exact ledger labels. */
  readonly labels?: Readonly<Record<string, string>>;
}

interface RollbackRecordOptions {
  /** Labels to write onto appended `action.rolled_back` event envelopes. */
  readonly labels?: Readonly<Record<string, string>>;
}

class RollbackModule implements VeritrailModule {
  readonly info: ModuleInfo; // { name, version, capability: 'rollback' }
  constructor(ctx: ModuleContext);
  planForAction(
    actionId: string,
    opts?: RollbackProjectionOptions,
  ): Promise<Result<RollbackPlan, VeritrailError>>;
  planForCorrelation(
    correlationId: string,
    opts?: RollbackProjectionOptions,
  ): Promise<RollbackPlan>;
  execute(
    plan: RollbackPlan,
    executor?: CompensationExecutor,
    opts?: RollbackRecordOptions,
  ): Promise<RollbackResult>;
}

function createRollbackModule(ctx: ModuleContext): RollbackModule;
```

Passing `labels` to a plan read restricts it to records carrying exactly those
labels, so planning another tenant's action returns `NOT_FOUND` and a
correlation plan covers only the in-scope actions. Passing `labels` to `execute`
stamps them onto each appended `action.rolled_back` fact. The server uses these
options to enforce per-tenant API-key label scopes.

## Example

```ts
import {
  createInMemoryLedger,
  FixedClock,
  SequentialIdGenerator,
  noopLogger,
} from '@veritrail/core';
import { createRollbackModule } from '@veritrail/rollback';

const ledger = createInMemoryLedger({
  clock: new FixedClock(1_700_000_000_000),
  ids: new SequentialIdGenerator(),
});
const ctx = {
  ledger,
  clock: new FixedClock(1_700_000_000_000),
  ids: new SequentialIdGenerator(),
  logger: noopLogger,
};

// A reversible action is proposed and executed elsewhere in the system…
await ledger.append({
  type: 'action.proposed',
  actorId: 'agent-1',
  payload: {
    action: {
      id: 'act-1',
      actorId: 'agent-1',
      type: 'http.request',
      reversible: true,
      reversal: {
        strategy: 'compensate',
        inverse: { type: 'http.request', target: '/orders/cancel', params: {} },
      },
    },
  },
});
await ledger.append({
  type: 'action.executed',
  actorId: 'agent-1',
  payload: { actionId: 'act-1', outcome: 'success' },
});

const rollback = createRollbackModule(ctx);
const plan = await rollback.planForAction('act-1');
if (plan.ok) {
  const result = await rollback.execute(plan.value, async (step) => {
    // call the real inverse API here…
    return { ok: true, compensationActionId: 'comp-1' };
  });
  console.log(result.outcomes); // [{ actionId: 'act-1', status: 'rolled_back', detail: '...' }]
}
```

## Phase 1 TODO

- **Idempotency keys** — dedupe re-runs so a step never compensates twice;
  detect an existing `action.rolled_back` for an action and skip it.
- **Saga / partial-failure semantics** — stop-on-first-failure vs.
  best-effort modes, retries with backoff, and a recorded plan-execution
  summary for partially-applied plans.
- **Real executor adapters** — HTTP/inverse-call, snapshot-`restore`, and
  message-queue compensators behind the `CompensationExecutor` interface.
- **Snapshot stores** — resolve `snapshotRef` against a content-addressed store
  for `restore` strategies.

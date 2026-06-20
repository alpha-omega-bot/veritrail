# @veritrail/decision-memory

The **Decision Memory** engine for Veritrail — record _why_ an agent did what
it did, and recall it later.

Like every Veritrail capability, this module is a projection over the single
tamper-evident, hash-chained ledger in `@veritrail/core`. Recording a decision
appends a `decision.recorded` event; reads (`list`, `get`, `recall`) replay
those events. There is **no separate store**.

> Status: **scaffold baseline.** Recall is a simple lexical (token-overlap)
> ranker. See the Phase 1 TODO below.

## What it does

- **`record`** — validate a `Decision` (via `DecisionSchema`) and append a
  `decision.recorded` fact. An `id` is minted with `ids.next('dec')` when
  absent. The decision's `actorId` becomes the ledger envelope actor, so
  decisions stay queryable by actor. Optional record labels are written to the
  ledger envelope for tenant/project-scoped projections.
- **`list` / `get`** — project recorded decisions from the ledger
  (most-recent-first; `get` returns the latest recording for an id), optionally
  filtered by exact ledger labels.
- **`recall`** — rank decisions by lexical overlap with a free-text query.

## Public API

```ts
interface DecisionMatch {
  decision: Decision;
  score: number; // distinctSharedTokens / distinctQueryTokens; 1 for empty-text recall
}

interface RecallQuery {
  text?: string;
  actorId?: string;
  limit?: number; // default 10
  labels?: Readonly<Record<string, string>>;
  recencyHalfLifeMs?: number; // opt-in: decay score by decision age
}

interface DecisionRecordOptions {
  labels?: Readonly<Record<string, string>>;
}

interface DecisionProjectionOptions {
  labels?: Readonly<Record<string, string>>;
}

class DecisionMemoryModule implements VeritrailModule {
  readonly info: {
    name: '@veritrail/decision-memory';
    version: '0.1.0';
    capability: 'decision-memory';
  };
  constructor(ctx: ModuleContext);
  record(
    input: unknown,
    opts?: DecisionRecordOptions,
  ): Promise<Result<LedgerRecord, VeritrailError>>;
  list(opts?: {
    actorId?: string;
    limit?: number;
    labels?: Readonly<Record<string, string>>;
  }): Promise<Decision[]>;
  get(decisionId: string, opts?: DecisionProjectionOptions): Promise<Decision | null>;
  outcomesFor(
    decisionId: string,
    opts?: DecisionProjectionOptions,
  ): Promise<Result<DecisionOutcomeReport, VeritrailError>>;
  recall(query: RecallQuery): Promise<DecisionMatch[]>;
}

function createDecisionMemoryModule(ctx: ModuleContext): DecisionMemoryModule;
```

### Outcome linkage

`outcomesFor(decisionId)` answers "did the decision work?". It looks up the
decision (latest by id), then classifies each `relatedActionId` by replaying its
action lifecycle events into a terminal outcome — `succeeded` | `failed` |
`denied` | `rolled_back`, or `pending` when no terminal event is recorded yet
(precedence on the latest event, so a `rolled_back` after an `executed` reads as
rolled back) — and rolls those into a verdict: `no_actions`, `pending` (in flight,
none bad), `effective` (all succeeded), `failed` (bad, none succeeded), or
`mixed`. Returns `NOT_FOUND` when the decision does not exist. Tenant-scoped: only
in-scope action events count, so an out-of-scope outcome reads as `pending`.

### Scoring

`recall` tokenizes `query.text` (lowercase, split on non-alphanumerics, drop
empties), reduces it to its **distinct** tokens, and scores each decision against
the distinct tokens of `summary + ' ' + rationale + ' ' + chosen`:

```
score = distinctSharedTokenCount / distinctQueryTokenCount
```

So a full match scores `1` regardless of how often a token is repeated in the
query. Results are filtered by `actorId` (when set), sorted by score descending
then most-recent, and truncated to `limit` (default `10`; a non-positive `limit`
returns an empty result). Decisions sharing no query tokens are dropped. When
`query.text` is absent or has no tokens, recall returns the most-recent
decisions, each with `score: 1`.

Set `recencyHalfLifeMs` to a positive number to opt into **recency weighting**:
the lexical score is multiplied by `0.5 ^ (ageMs / recencyHalfLifeMs)`, where age
is measured from the decision's authoritative ledger timestamp to the injected
clock's `now`. A decision's contribution then halves every `recencyHalfLifeMs`,
so a recent weaker match can outrank an old stronger one. The decay also applies
to empty-text (pure recency) recall. Unset (or non-positive) leaves ranking
purely lexical with recency only as a tie-break.

When `labels` are supplied, `list`, `get`, and `recall` only project
`decision.recorded` events whose ledger envelope carries every requested
key/value pair. This is used by the HTTP server for label-scoped tenant views.

## Example

```ts
import { createInMemoryLedger } from '@veritrail/core';
import { createDecisionMemoryModule } from '@veritrail/decision-memory';

const ledger = createInMemoryLedger();
const memory = createDecisionMemoryModule({ ledger, clock, ids, logger });

await memory.record({
  actorId: 'agent-1',
  summary: 'Choose a primary database',
  rationale: 'Need strong consistency and mature tooling',
  chosen: 'postgres',
});

const hits = await memory.recall({ text: 'database consistency' });
// hits[0].decision.summary === 'Choose a primary database'
```

## Phase 1 TODO

- **Vector / semantic recall via embeddings** — replace token overlap with
  embedding similarity so paraphrases and synonyms match.

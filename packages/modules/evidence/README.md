# @veritrail/evidence

Evidence Tracing engine for Veritrail — a **content-addressed provenance graph**
layered over the single tamper-evident ledger.

Attaching evidence appends an `evidence.attached` fact to the shared ledger;
every read is a pure projection over those facts. There is no separate store:
the ledger remains the system of record.

## What it does

- **Attach** validated evidence (document, observation, tool output, citation,
  dataset, artifact) as ledger events, with an optional SHA-256 `contentHash`
  for integrity-over-time. Optional record labels are written to the ledger
  envelope for tenant/project-scoped projections.
- **Project** all attached evidence (`list`, `get`) from `evidence.attached`
  events, optionally filtered by exact ledger labels.
- **Trace** provenance: from a root piece of evidence, walk `links.evidenceIds`
  as `derived_from` edges (depth-first) to build a `ProvenanceGraph`. Includes a
  cycle guard and a depth cap of 100.
- **Verify content**: re-hash supplied content and compare against the stored
  `contentHash` to prove the referenced content has not changed.

## Public API

```ts
interface ProvenanceNode {
  id: string;
  kind: EvidenceKind;
  source: string;
  summary: string;
  contentHash?: string;
}
interface ProvenanceEdge {
  from: string;
  to: string;
  relation: 'derived_from';
}
interface ProvenanceGraph {
  rootId: string;
  nodes: ProvenanceNode[];
  edges: ProvenanceEdge[];
}

class EvidenceModule implements VeritrailModule {
  readonly info: { name: '@veritrail/evidence'; version: '0.1.0'; capability: 'evidence' };
  constructor(ctx: ModuleContext);
  attach(
    input: unknown,
    opts?: { labels?: Readonly<Record<string, string>> },
  ): Promise<Result<LedgerRecord, VeritrailError>>;
  list(opts?: { labels?: Readonly<Record<string, string>> }): Promise<Evidence[]>;
  get(
    evidenceId: string,
    opts?: { labels?: Readonly<Record<string, string>> },
  ): Promise<Evidence | null>;
  trace(
    evidenceId: string,
    opts?: { labels?: Readonly<Record<string, string>> },
  ): Promise<Result<ProvenanceGraph, VeritrailError>>;
  verifyContent(
    evidenceId: string,
    content: string,
    opts?: { labels?: Readonly<Record<string, string>> },
  ): Promise<Result<boolean, VeritrailError>>;
}

function createEvidenceModule(ctx: ModuleContext): EvidenceModule;
```

`attach` expects an object carrying the ledger envelope's `actorId` (required)
and optional `correlationId`, plus the evidence body. The evidence is validated
with `EvidenceSchema`; an `id` is assigned via `ctx.ids.next('evd')` when absent.
When `labels` are supplied, `list`, `get`, `trace`, and `verifyContent` only
project `evidence.attached` events whose ledger envelope carries every requested
key/value pair. Trace edges to out-of-scope upstream evidence remain visible as
dangling references, but the out-of-scope evidence is not loaded as a node.

Failures are returned as `Result` (`VALIDATION` for bad input, `NOT_FOUND` for
missing evidence or a missing `contentHash`) — never thrown.

## Example

```ts
import {
  FixedClock,
  SequentialIdGenerator,
  createInMemoryLedger,
  noopLogger,
  sha256Hex,
  unwrap,
} from '@veritrail/core';
import { createEvidenceModule } from '@veritrail/evidence';

const clock = new FixedClock(1_700_000_000_000);
const ids = new SequentialIdGenerator();
const ledger = createInMemoryLedger({ clock, ids });
const evidence = createEvidenceModule({ ledger, clock, ids, logger: noopLogger });

const content = 'raw tool output';
await evidence.attach({
  actorId: 'agent-1',
  id: 'evd-source',
  kind: 'tool_output',
  summary: 'API call',
  contentHash: sha256Hex(content),
});
await evidence.attach({
  actorId: 'agent-1',
  id: 'evd-claim',
  kind: 'citation',
  summary: 'derived claim',
  links: { evidenceIds: ['evd-source'] },
});

const graph = unwrap(await evidence.trace('evd-claim'));
// graph.nodes -> [evd-claim, evd-source]; graph.edges -> [{ from: 'evd-claim', to: 'evd-source', relation: 'derived_from' }]

const ok = unwrap(await evidence.verifyContent('evd-source', content)); // true
```

## Phase 1 TODO

This is a scaffold with a correct, deterministic baseline. Deferred to Phase 1:

- **External content fetching** — resolve `source` URIs and hash live content
  rather than trusting a caller-supplied `contentHash`.
- **Signed evidence** — attest evidence with the platform `Signer` so provenance
  edges are independently verifiable.
- **Decision ⇄ evidence cross-links** — surface `links.decisionIds` /
  `links.actionIds` in the graph and join against `decision.recorded` /
  `action.*` events.
- **Large-graph pagination** — streaming/windowed traversal and result paging
  for provenance graphs that exceed the depth cap or memory budget.

<div align="center">

# Veritrail

**The trust & control plane for AI agents.**

Audit · Rollback · Permissions · Spend Guard · Incident Forensics · Evidence Tracing · Decision Memory · Vendor Risk
— eight governance capabilities over **one tamper-evident system of record.**

[![CI](https://github.com/veritrail/veritrail/actions/workflows/ci.yml/badge.svg)](https://github.com/veritrail/veritrail/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.11-brightgreen.svg)](./.nvmrc)

</div>

---

## Why Veritrail

Autonomous agents now take consequential actions — calling tools, spending money,
writing to systems, depending on third-party models. When something goes wrong,
teams are left asking: _What did the agent do? Why? Who allowed it? What did it
cost? Can we undo it? Which vendor failed us?_ Today those answers live in
scattered logs, traces, and dashboards that can be edited after the fact.

Veritrail makes agent activity **accountable by construction**. Every consequential
fact is written to a single, append-only, hash-chained ledger that is
**tamper-evident**: you cannot alter, insert, or delete history without it being
detectable. The eight governance capabilities are not eight separate products —
they are **engines and projections over that one ledger.**

```
                       ┌──────────────────────────────────────────┐
   agents / services → │   permissions → SPEND GUARD → execution   │  (control plane)
                       └───────────────────┬──────────────────────┘
                                           │ every fact, validated
                                           ▼
                       ┌──────────────────────────────────────────┐
                       │   Veritrail Ledger  (append-only,         │  (system of record)
                       │   hash-chained, tamper-evident)           │
                       └───────────────────┬──────────────────────┘
                                           │ projections
        ┌──────────────┬──────────────┬────┴─────┬──────────────┬──────────────┐
     Audit         Rollback       Forensics    Evidence    Decision Mem.   Vendor Risk
```

## The eight capabilities

| #   | Capability             | What it does                                                               | v0.1 status |
| --- | ---------------------- | -------------------------------------------------------------------------- | ----------- |
| 1   | **Audit**              | Query, verify, and export the tamper-evident ledger.                       | **GA**      |
| 2   | **Permissions**        | Deny-by-default policy engine that gates agent actions before they run.    | **GA**      |
| 3   | **Spend Guard**        | Budget tracking with hard-stop enforcement over cost events.               | **GA**      |
| 4   | **Rollback**           | Build & execute compensating plans to reverse recorded reversible actions. | Scaffold    |
| 5   | **Incident Forensics** | Reconstruct timelines and causal chains for an incident.                   | Scaffold    |
| 6   | **Evidence Tracing**   | Content-addressed provenance graph linking decisions → evidence → sources. | Scaffold    |
| 7   | **Decision Memory**    | Record and recall agent decisions and their rationale.                     | Scaffold    |
| 8   | **Vendor Risk**        | Inventory third parties and score time-decayed risk signals.               | Scaffold    |

> **GA** capabilities are fully implemented and tested. **Scaffold** capabilities
> ship a working, tested baseline over the same ledger, with their deeper concerns
> tracked on the [roadmap](./ROADMAP.md). Honesty about maturity is a feature.

## Quickstart

```bash
# Requires Node >= 20.11 and pnpm (via corepack: `corepack enable`).
pnpm install
pnpm run verify          # format:check + lint + typecheck + test
```

Use the core ledger directly:

```ts
import { createInMemoryLedger } from '@veritrail/core';
import { createPermissionsModule } from '@veritrail/permissions';
import { createSpendGuardModule } from '@veritrail/spend-guard';
import { createAuditModule } from '@veritrail/audit';

const ledger = createInMemoryLedger();
const ctx = {
  ledger,
  clock: { now: () => Date.now() },
  ids: /* IdGenerator */ undefined!,
  logger: /* Logger */ undefined!,
};

const permissions = createPermissionsModule(ctx); // deny-by-default
permissions.addPolicy({
  name: 'allow safe tools',
  effect: 'allow',
  match: { actionTypes: ['tool.*'] },
});

const decision = permissions.evaluate({ id: 'a1', actorId: 'agent-7', type: 'tool.search' });
// → { effect: 'allow', matchedPolicyId: '…', reason: '…' }

const audit = createAuditModule(ctx);
console.log(await audit.verify()); // { ok: true, head: '…', … }
```

See [`examples/`](./examples) for runnable end-to-end flows, and each package's
README for its full API.

## Repository layout

```
veritrail/
├─ packages/
│  ├─ core/                 @veritrail/core   — ledger, domain schemas, storage, ports (the trust core)
│  ├─ sdk/                  @veritrail/sdk    — typed in-process instrumentation + HTTP client
│  ├─ server/               @veritrail/server — Fastify REST API mounting all modules
│  ├─ cli/                  @veritrail/cli    — operator CLI (ingest, verify, query, policy, budget)
│  └─ modules/
│     ├─ audit/             @veritrail/audit
│     ├─ permissions/       @veritrail/permissions
│     ├─ spend-guard/       @veritrail/spend-guard
│     ├─ rollback/          @veritrail/rollback
│     ├─ forensics/         @veritrail/forensics
│     ├─ evidence/          @veritrail/evidence
│     ├─ decision-memory/   @veritrail/decision-memory
│     └─ vendor-risk/       @veritrail/vendor-risk
├─ apps/console/            @veritrail/console — React/Vite operator dashboard
├─ docs/                    architecture, concepts, ADRs, threat model
└─ scripts/                 maintenance scripts
```

## Design principles

- **Trust is structural, not procedural.** Integrity comes from hash-chaining and
  validation, not from "please don't edit the logs."
- **Safe by default.** Permissions deny when no policy matches; budgets hard-stop
  at their limit; the ledger is tamper-evident out of the box.
- **Correctness over convenience.** Strict TypeScript, runtime validation at every
  boundary (Zod), `Result` types instead of thrown surprises, money as integers.
- **Observable from day one.** Structured logging and injectable clocks/ids make
  behavior reproducible and auditable.
- **Honest maturity.** Scaffolded capabilities say so and ship working baselines.

Read the full [architecture](./ARCHITECTURE.md), the
[roadmap](./ROADMAP.md), and the [security model](./SECURITY.md).

## Contributing & security

- Development setup and conventions: [CONTRIBUTING.md](./CONTRIBUTING.md).
- Reporting a vulnerability: [SECURITY.md](./SECURITY.md) (please do **not** open a
  public issue for security reports).

## License

Apache-2.0 © The Veritrail Authors. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

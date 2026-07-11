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

| #   | Capability             | What it does                                                               | v0.1 status | Builds on it                 |
| --- | ---------------------- | -------------------------------------------------------------------------- | ----------- | ---------------------------- |
| 1   | **Audit**              | Query, verify, and export the tamper-evident ledger.                       | **GA**      | Receipts, Compliance Reports |
| 2   | **Permissions**        | Deny-by-default policy engine that gates agent actions before they run.    | **GA**      | Simulator                    |
| 3   | **Spend Guard**        | Budget tracking with hard-stop enforcement over cost events.               | **GA**      | Cost Optimizer               |
| 4   | **Rollback**           | Build & execute compensating plans to reverse recorded reversible actions. | Scaffold    |                              |
| 5   | **Incident Forensics** | Reconstruct timelines and causal chains for an incident.                   | **GA**      | Auto-RCA                     |
| 6   | **Evidence Tracing**   | Content-addressed provenance graph linking decisions → evidence → sources. | Scaffold    |                              |
| 7   | **Decision Memory**    | Record and recall agent decisions and their rationale.                     | **GA**      |                              |
| 8   | **Vendor Risk**        | Inventory third parties and score time-decayed risk signals.               | Scaffold    |                              |

> **GA** capabilities are fully implemented and tested. **Scaffold** capabilities
> ship a working, tested baseline over the same ledger, with their deeper concerns
> tracked on the [roadmap](./ROADMAP.md). Honesty about maturity is a feature.
>
> The "Builds on it" column points to revolutionary features layered on top of
> the GA primitives — none of them are separate products. **Receipts** sign and
> export Audit entries as portable proofs; **Simulator** replays Permissions
> against historic traffic before you ship a policy; **Auto-RCA** turns
> Forensics timelines into ranked root-cause hypotheses; **Cost Optimizer**
> mines Spend Guard projections for savings; **Compliance Reports** generate
> SOC 2 / ISO / EU AI Act artifacts straight from Audit.

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

## Hosted SaaS or self-host

Veritrail runs the same way whether you point your agents at our managed
endpoint or stand up the stack inside your own VPC. Pick the model that fits
your compliance posture; you can switch later by changing one base URL.

### Hosted (recommended)

Sign in at **[veritrail.io](https://veritrail.io)** with a magic link and start
ingesting events in minutes. The hosted plane runs the same code that ships in
this repo, deployed against a managed Postgres EventStore with regional
isolation.

- Free tier: 10,000 events/month, 7-day retention, unlimited read-only seats.
- Magic-link auth, SSO (SAML/OIDC) on the team plan, scoped API keys per env.
- All eight capabilities plus Receipts, Simulator, Auto-RCA, Cost Optimizer,
  and Compliance Reports — no feature gating between hosted and self-host.
- Stripe-metered billing, status page at [status.veritrail.io](https://status.veritrail.io),
  and a 99.9% uptime SLA on paid tiers.
- Webhook fan-out, audit-log export to S3/GCS, and bring-your-own-KMS for
  ledger signing keys on enterprise tiers.

### Self-host

Follow the [Quickstart](#quickstart) above to run the full stack on your own
infrastructure. `pnpm install && pnpm run verify` brings up an end-to-end
environment; production deployments use the relational EventStore in
`@veritrail/relational-store` against Postgres.

Every capability — including the new revolutionary features — works
self-hosted. The only component that requires external credentials is
**billing**, which expects `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in
the control plane; omit them and the billing routes degrade cleanly while
everything else continues to function.

## Distribution channels

Veritrail ships in the package manager your agents already use.

- **npm** — [`@veritrail/sdk`](./packages/sdk) (in-process + HTTP),
  [`@veritrail/cli`](./packages/cli) (operator CLI),
  [`@veritrail/mcp-server`](./packages/mcp-server) (MCP host integration),
  [`@veritrail/receipt`](./packages/receipt) (signed action receipts).
- **PyPI** — `pip install veritrail`, built from
  [`packages/sdk-python`](./packages/sdk-python). Mirrors the TypeScript SDK's
  surface for Python agents and notebook workflows.
- **Go** — `go get github.com/veritrail/sdk-go`, built from
  [`packages/sdk-go`](./packages/sdk-go). Native client for Go services and
  serverless functions.
- **MCP** — `npx @veritrail/mcp-server` exposes the ledger, policy engine, and
  forensics tools to Claude Desktop, Cursor, and any other MCP host.

## Repository layout

```
veritrail/
├─ packages/
│  ├─ core/                 @veritrail/core   — ledger, domain schemas, storage, ports (the trust core)
│  ├─ sdk/                  @veritrail/sdk    — typed in-process instrumentation + HTTP client
│  ├─ sdk-python/           veritrail         — Python SDK (PyPI)
│  ├─ sdk-go/               github.com/veritrail/sdk-go — Go SDK
│  ├─ server/               @veritrail/server — Fastify REST API mounting all modules
│  ├─ cli/                  @veritrail/cli    — operator CLI (ingest, verify, query, policy, budget)
│  ├─ mcp-server/           @veritrail/mcp-server — MCP host integration (Claude, Cursor, …)
│  ├─ control-plane/        @veritrail/control-plane — tenancy, auth, API keys, Stripe billing
│  ├─ webhook-worker/       @veritrail/webhook-worker — durable webhook fan-out
│  ├─ openapi/              @veritrail/openapi — generated OpenAPI spec + typed clients
│  ├─ integrations/         @veritrail/integrations — Slack, PagerDuty, S3/GCS export
│  ├─ relational-store/     @veritrail/relational-store — SQL EventStore adapter
│  ├─ receipt/              @veritrail/receipt — signed, portable action receipts
│  ├─ policy-simulator/     @veritrail/policy-simulator — replay policies against historic events
│  ├─ auto-rca/             @veritrail/auto-rca — automated root-cause analysis over forensics
│  ├─ cost-optimizer/       @veritrail/cost-optimizer — spend recommendations from ledger projections
│  ├─ compliance/           @veritrail/compliance — SOC 2 / ISO / EU AI Act report generation
│  └─ modules/
│     ├─ audit/             @veritrail/audit
│     ├─ permissions/       @veritrail/permissions
│     ├─ spend-guard/       @veritrail/spend-guard
│     ├─ rollback/          @veritrail/rollback
│     ├─ forensics/         @veritrail/forensics
│     ├─ evidence/          @veritrail/evidence
│     ├─ decision-memory/   @veritrail/decision-memory
│     └─ vendor-risk/       @veritrail/vendor-risk
├─ apps/
│  ├─ console/              @veritrail/console   — React/Vite operator dashboard
│  ├─ marketing/            @veritrail/marketing — veritrail.io site
│  └─ status/               @veritrail/status    — status.veritrail.io page
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

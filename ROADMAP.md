# Veritrail Roadmap

This roadmap is organized into milestones, not dates. Each milestone is a coherent
increment that keeps `main` releasable. Status legend: ✅ done · 🚧 in progress ·
⬜ planned.

> Principle: every new capability **extends the single ledger and projects over
> it**. We do not add parallel sources of truth.

## Milestone 0 — Foundation (v0.1) ✅

The trust core and a coherent, tested platform skeleton.

- ✅ Tamper-evident, hash-chained **ledger** with canonical hashing and
  `verify()` integrity reports (4 tamper classes detected + localization).
- ✅ **Domain model** as Zod schemas with inferred types; safe defaults; money as
  integer minor units.
- ✅ **Storage port** with in-memory and durable append-only JSONL adapters.
- ✅ Runtime **ports**: clock, id generator, logger, signer (HMAC).
- ✅ **Audit**, **Permissions** (deny-by-default), and **Spend Guard** (hard-stop)
  fully implemented and tested.
- ✅ **Rollback, Forensics, Evidence, Decision Memory, Vendor Risk** scaffolded
  with working baselines, locked public contracts, and tests.
- ✅ **CLI**, **HTTP server**, **SDK**, and a **web console** scaffold.
- ✅ Strong CI (Node 20/22, coverage, ledger-integrity gate, CodeQL), strict
  TypeScript, lint/format gates, ADRs, threat model, contributor docs.

## Milestone 1 — Productionize the core 🚧

Make the system durable, secure, and operable for a first real deployment.

- 🚧 **Relational `EventStore`** behind the existing port: dependency-light SQL
  adapter and SQLite/Postgres dialect builders are in place; concrete SQLite
  single-node and Postgres HA driver wrappers remain.
- ⬜ **Asymmetric signing** (Ed25519) via a `Signer` adapter backed by KMS/HSM;
  key rotation and `signerKeyId` chains.
- ⬜ **External anchoring**: periodically publish the chain head (e.g. to a
  transparency log / object store / notary) to detect wholesale rewrites of an
  unsigned chain.
- ⬜ **AuthN/AuthZ** on the server: API keys/OIDC, per-actor scoping, and RBAC for
  operators; signed audit of administrative actions.
- ⬜ **PII handling**: field-level redaction/encryption hooks at the append
  boundary; configurable retention with cryptographic erasure.
- ⬜ **Backpressure & batching** for high-throughput append paths.

## Milestone 2 — Complete the eight engines ⬜

Bring the five scaffolded capabilities to GA depth.

- ⬜ **Rollback**: saga/partial-failure semantics, idempotency keys, real executor
  adapters, snapshot stores for `restore` strategies.
- ⬜ **Forensics**: anomaly detection, blast-radius analysis, root-cause ranking,
  snapshot diffs, and shareable incident bundles.
- ⬜ **Evidence**: external content capture + hashing, signed evidence, full
  decision↔evidence cross-linking, large-graph pagination.
- ⬜ **Decision Memory**: semantic recall via embeddings, outcome linkage (did the
  decision work?), recency/decay weighting.
- ⬜ **Vendor Risk**: real monitor feeds (status pages, CVE, SOC2/cert expiry),
  alert thresholds, SLA tracking, and dependency mapping to affected agents.

## Milestone 3 — Console & real-time ⬜

- ⬜ Web console to GA: full views, filtering, saved queries, and integrity badges
  backed by live verification.
- ⬜ **Streaming**: server-sent events/websocket subscriptions over the ledger tail.
- ⬜ **Alerting/notifications**: budget breaches, policy denials spikes, vendor
  criticals → email/Slack/webhook.
- ⬜ **Reporting**: scheduled audit/spend/vendor reports and exports.

## Milestone 4 — Platform & ecosystem ⬜

- ⬜ **Multi-tenant** control plane: orgs, projects, tenancy isolation, billing.
- ⬜ **Integrations**: drop-in instrumentation for popular agent frameworks and an
  **MCP** server so agents can self-report to Veritrail.
- ⬜ **Policy-as-code**: richer policy language, simulation/"what-if", and policy
  versioning recorded on the ledger.
- ⬜ **Compliance packs**: evidence templates and controls mapping for SOC 2 /
  ISO 27001 / EU AI Act readiness.

## Non-goals (for now)

- Being a general-purpose APM or log aggregator — Veritrail records _governance
  facts_, not all telemetry.
- Executing agent side effects itself — Veritrail gates, prices, records, and
  reverses; the agent runtime still performs the work (via injected executors).

Have a need that isn't here? Open a
[feature request](./.github/ISSUE_TEMPLATE/feature_request.yml).

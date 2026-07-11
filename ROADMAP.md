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
- ✅ Runtime **ports**: clock, id generator, logger, signer (HMAC + Ed25519).
- ✅ **Audit**, **Permissions** (deny-by-default), and **Spend Guard** (hard-stop)
  fully implemented and tested.
- ✅ **Rollback, Forensics, Evidence, Decision Memory, Vendor Risk** scaffolded
  with working baselines, locked public contracts, and tests.
- ✅ **CLI**, **HTTP server**, **SDK**, and a **web console** scaffold.
- ✅ Strong CI (Node 20/22, coverage, ledger-integrity gate, CodeQL), strict
  TypeScript, lint/format gates, ADRs, threat model, contributor docs.

## Milestone 1 — Productionize the core 🚧

Make the system durable, secure, and operable for a first real deployment.

- ✅ **Relational `EventStore`** behind the existing port: dependency-light SQL
  adapter, migrations, SQLite/Postgres dialect builders, and concrete
  SQLite/Postgres driver wrappers with documented writer-safety guarantees.
- ✅ **Asymmetric signing**: local Ed25519 `Signer` adapter with `signerKeyId`
  verification and trusted public keys for key rotation.
- ✅ **KMS/HSM signing interface**: `RemoteEd25519Signer` delegates signing to a
  remote key-custody client while verifying locally; operator runbook documented.
- ✅ **Provider signer package**: dependency-light `@veritrail/provider-signers`
  adapters for AWS KMS, GCP Cloud KMS, Azure Key Vault, and HSM/PKCS#11-shaped
  sessions around the remote signer interface.
- ✅ **External anchoring**: core `AnchorStore` port, in-memory adapter, helpers
  to publish and verify ledger-head checkpoints, and operator runbook for
  transparency-log/object-store/notary deployments.
- 🚧 **AuthN/AuthZ** on the server: API-key auth, OIDC bearer JWTs with static
  JWKS plus discovery/JWKS refresh, route roles/scopes, label-scoped raw ledger
  reads/writes, spend charges and spend read projections, signed administrative
  mutation requests, ledger-recorded policy/budget changes, Decision Memory
  writes/read projections, Evidence writes/read projections, and fail-closed
  scoped access for unpartitioned module projections are implemented;
  tenant-filtered projection semantics for the remaining modules and broader
  policy composition remain.
- 🚧 **PII handling**: append-boundary field redaction hook and path redactor are
  implemented; encryption hooks and configurable retention with cryptographic
  erasure remain.
- 🚧 **Backpressure & batching**: server request body caps, fixed-window rate
  limits, and write-route in-flight backpressure are implemented; append batching
  remains.

## Milestone 2 — Complete the eight engines 🚧

Bring the scaffolded capabilities to GA depth. **Forensics and Decision Memory
have reached GA** (stable contracts, test depth comparable to the M0 GA modules);
the remaining three have advanced baselines with deferred enhancements.

- 🚧 **Rollback**: idempotent/retry-safe `execute` and `best_effort`/
  `stop_on_failure` saga modes are done; real executor adapters and snapshot
  stores for `restore` strategies remain.
- ✅ **Forensics** (**GA**): timeline, incident report, causal chains,
  blast-radius analysis, root-cause ranking, and shareable incident bundles.
  Post-GA: anomaly detection, snapshot diffs.
- 🚧 **Evidence**: corrected provenance traversal, decision→evidence
  cross-linking, and `list` pagination are done; external content capture +
  hashing, signed evidence, and windowed `trace` traversal remain.
- ✅ **Decision Memory** (**GA**): recall (lexical + opt-in semantic via an
  injectable `EmbeddingProvider` port), recency/decay weighting, and outcome
  linkage. Post-GA: a concrete deployment-supplied embedding-model adapter.
- 🚧 **Vendor Risk**: time-decayed scoring and alert thresholds are done; real
  monitor feeds (status pages, CVE, SOC2/cert expiry), SLA tracking, and
  dependency mapping to affected agents remain.

## Milestone 3 — Console & real-time ✅

- ✅ Web console to GA: full views (Overview, Ledger, ApiKeys, Billing,
  Settings, Team, Webhooks, Compliance, Receipts, Simulator, RCA, Usage),
  filtering, saved queries, and integrity badges backed by live verification.
- ✅ **Streaming**: server-sent events at `GET /api/audit/events/stream` tail
  the ledger with heartbeat pings and per-principal label-scope filtering; the
  console LedgerView subscribes for live updates.
- ✅ **Alerting/notifications**: budget breaches, policy denial spikes, and
  vendor criticals fan out to email (Resend), Slack (Block Kit), PagerDuty
  (Events API v2), and HMAC-signed outbound webhooks via
  `@veritrail/webhook-worker` and `@veritrail/integrations`.
- ✅ **Reporting**: auditor-ready compliance reports (SOC 2 CC7, EU AI Act
  Annex IV, HIPAA Security Rule, ISO 42001) and spend/usage exports via
  `@veritrail/compliance` and `@veritrail/cost-optimizer`.

## Milestone 4 — Platform & ecosystem ✅

- ✅ **Multi-tenant control plane** (`@veritrail/control-plane`): orgs,
  projects, users, memberships, hashed API keys, sessions, magic-link tokens,
  Stripe billing with webhook dedup and metered usage, tier-aware quotas, and
  Resend email templates.
- ✅ **Integrations**: drop-in instrumentation via the new
  **`@veritrail/mcp-server`** so agents in Claude Code, Claude Desktop, Cursor,
  or any MCP-compatible host can self-report to Veritrail in two lines of
  config. Multi-language SDKs (`@veritrail/sdk-python`, Go SDK) and the
  `@veritrail/openapi` 3.1 spec with Swagger UI at `/api/docs` round out the
  ecosystem surface.
- ✅ **Policy-as-code with simulation**: `@veritrail/policy-simulator` replays
  a proposed policy set against historical ledger events and reports blast
  radius + per-event diff before shipping. `@veritrail/auto-rca` (with the
  Claude `claude-opus-4-7` 1M-context adapter) proposes a fix that pipes
  straight into the simulator.
- ✅ **Compliance packs**: `@veritrail/compliance` ships SOC 2 CC7, EU AI Act
  Annex IV, HIPAA Security Rule, and ISO 42001 control mappings that cite the
  exact ledger event ids backing each statement.
- ✅ **Portable receipts**: `@veritrail/receipt` produces offline-verifiable
  cryptographic proofs of individual events; the bundled `veritrail-verify`
  CLI lets external auditors verify on a laptop with no backend reachable.

## Milestone 5 — Real-time fanout, AI-native operations, and marketplace ⬜

Build on the SaaS foundation: scale realtime delivery, deepen AI-native
features around the ledger, and open the ecosystem to third-party developers.

### Real-time fanout

- ⬜ **Durable event bus** behind SSE: a Postgres-backed outbox feeding a Redis
  Streams (or NATS JetStream) fanout layer, so SSE/webhook delivery survives
  server restarts and scales horizontally past a single Node process.
- ⬜ **WebSocket transport** alongside SSE for bidirectional control channels
  (subscribe/unsubscribe, server-pushed permission decisions).
- ⬜ **Per-tenant delivery shards** with priority queues so a noisy customer
  cannot starve a quiet one.
- ⬜ **Replay-from-cursor** semantics on the SSE/WS stream so a reconnecting
  client never misses an event and never sees a duplicate.

### AI-native operations

- ⬜ **Conversational ledger console** powered by `claude-opus-4-7` (1M
  context) that answers natural-language questions over the ledger and the
  forensics/audit projections, with every answer citing event ids.
- ⬜ **Auto-RCA v2**: closed-loop incident response that proposes a fix, runs
  it through the simulator, gates on a human approver, then applies it as a
  signed policy change recorded on the ledger.
- ⬜ **Drift detection on policy and spend** using the same robust statistics
  (median + MAD) as the cost optimizer, plus LLM-explained anomalies.
- ⬜ **Embedding-backed decision recall** with a first-party deployment
  adapter (currently a port without a bundled provider).
- ⬜ **Vendor risk monitor feeds** wired to real status pages, CVE feeds, and
  SOC 2 / cert-expiry sources, with LLM-summarized weekly risk briefings.

### Marketplace & integrations

- ⬜ **Public integration marketplace** for community-built MCP servers,
  webhook receivers, signer adapters, and projection plugins, with signed
  manifests and a vetting workflow.
- ⬜ **First-party integrations**: GitHub (PR approvals as ledger events),
  Jira (incidents linked to forensics bundles), Datadog/Honeycomb (export
  ledger events as spans), Snowflake/BigQuery (long-term audit warehouse).
- ⬜ **Terraform provider** for declarative org/project/policy/webhook
  management.
- ⬜ **Self-serve API key marketplace** with usage-based revenue share for
  community plugins.

## Non-goals (for now)

- Being a general-purpose APM or log aggregator — Veritrail records _governance
  facts_, not all telemetry.
- Executing agent side effects itself — Veritrail gates, prices, records, and
  reverses; the agent runtime still performs the work (via injected executors).

Have a need that isn't here? Open a
[feature request](./.github/ISSUE_TEMPLATE/feature_request.yml).

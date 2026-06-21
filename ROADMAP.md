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

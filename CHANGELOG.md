# Changelog

All notable changes to Veritrail are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

This release transforms Veritrail from a self-hosted governance library into a
hosted multi-tenant SaaS while preserving every existing self-host capability.
It ships the SaaS control plane, six revolutionary differentiator packages, a
real-time event stream, an OpenAPI surface, two new SDKs, two new apps, and a
substantially expanded console.

### Added

#### Revolutionary differentiator packages

- **`@veritrail/mcp-server`** — Model Context Protocol server. Two lines of
  configuration drop Veritrail governance into Claude Code, Claude Desktop,
  Cursor, or any MCP-compatible host. Exposes six first-class tools:
  `record_decision`, `check_permission`, `request_budget`, `note_evidence`,
  `query_audit`, and `verify_integrity`. Talks to a Veritrail server over the
  existing REST surface; no special transport.
- **`@veritrail/receipt`** — Portable, offline-verifiable cryptographic proofs
  that a specific ledger event happened and has not been altered. Each receipt
  bundles the event payload, its chain inclusion proof, the signer key id, and
  a detached Ed25519 signature. Ships the **`veritrail-verify`** CLI so external
  auditors can verify a receipt on a laptop with no Veritrail backend reachable.
- **`@veritrail/policy-simulator`** — Replay a proposed policy set against
  historical ledger events and report blast radius plus per-event diff before
  the change ships. Surfaces would-be denials, would-be approvals, and net
  budget impact, all anchored to the ledger event ids that drove them.
- **`@veritrail/auto-rca`** — AI-generated root-cause analysis for incidents
  with a proposed policy fix that pipes directly into the policy simulator.
  Default model is `claude-opus-4-7` (1M context) via a first-party Claude
  adapter; the LLM adapter interface is pluggable so other providers can be
  swapped in without changing call sites.
- **`@veritrail/cost-optimizer`** — End-of-month spend forecast (linear plus
  EMA), robust anomaly detection (median plus MAD), and per-model swap
  recommendations with projected savings. Reads from the spend projection so
  forecasts stay consistent with what the ledger actually records.
- **`@veritrail/compliance`** — Auditor-ready Markdown reports for **SOC 2
  CC7**, **EU AI Act Annex IV**, **HIPAA Security Rule**, and **ISO 42001**.
  Every control statement cites the specific ledger event ids backing it so
  evidence is reproducible and tamper-evident.

#### SaaS control plane

- **`@veritrail/control-plane`** — Multi-tenant layer above the ledger:
  **organizations**, **projects**, **users**, **memberships**, hashed
  **API keys**, **sessions**, and single-use **magic-link tokens**. Ships an
  in-memory store for tests and a Postgres-ready store port for production.
- **Stripe billing** — Subscription tiers (Free / Starter $49 / Pro $299 /
  Enterprise) with webhook signature verification, event-id deduplication so
  retried deliveries are idempotent, price-id-to-tier mapping, and per-tenant
  usage metering with batched flushes to Stripe metered prices.
- **Tier-aware quotas** — Hard-stop on the free tier, metered overage on paid
  tiers, configurable per-org rate-limit overrides.
- **Resend email integration** — Magic-link, welcome, quota-warning, and
  billing-receipt templates with plain-text fallbacks for non-HTML clients.

#### Realtime and ecosystem

- **`@veritrail/webhook-worker`** — HMAC-signed delivery with exponential
  backoff (jittered), event-type filters, and a pluggable outbox store so a
  durable backing table can be slotted in without touching call sites. Retries
  are bounded; permanent failures surface to a dead-letter projection.
- **`@veritrail/integrations`** — First-party adapters for **Slack** (Block
  Kit messages), **PagerDuty** (Events API v2), and **Resend**, with five
  ready-to-use transactional templates.
- **`@veritrail/openapi`** — OpenAPI 3.1 spec for the REST API. The server now
  exposes the spec at `GET /api/openapi.json` and a browsable Swagger UI at
  `GET /api/docs` so integrators can explore endpoints without leaving the app.
- **Multi-language SDKs** — **`@veritrail/sdk-python`** (PyPI package
  `veritrail`, httpx-based, 9 respx-driven tests) and the new **Go SDK** at
  `github.com/veritrail/sdk-go` (Go 1.22, httptest-driven). Both wrap the same
  REST surface as the TypeScript SDK.
- **Server-Sent Events** — `GET /api/audit/events/stream` tails the ledger in
  near real time with heartbeat pings and per-principal label-scope filtering.

#### Apps

- **`apps/marketing`** — Astro-powered static landing site with pricing, docs,
  security, and blog scaffolding.
- **`apps/status`** — Single-file standalone status page that polls
  `/api/health/ready` and surfaces component-level status.

#### Console

- **Magic-link auth flow** — `LoginView` and `MagicLinkView` with
  localStorage-backed session and graceful expiry handling.
- **Onboarding wizard** — auto-creates the first org, first project, and first
  API key with a "copy now, never again" reveal modal for the key.
- **BillingView** — current plan, usage meters, and a checkout link that opens
  the Stripe-hosted session.
- **ApiKeysView** — full CRUD with reveal-once modal, prefix preview, and
  scope display.
- **SettingsView**, **TeamView**, and **WebhooksView** — org settings, member
  management, and webhook subscription management.
- **LedgerView** — now subscribes to the SSE event stream for live updates
  with a "Live" badge that pulses when new events arrive.
- **Compliance**, **Receipts**, **Simulator**, **RCA**, and **Usage analytics**
  views — one per differentiator package, all using Cloudscape patterns.
- **Workspace switcher** in the TopNavigation dropdown.

#### Server

- **`buildServer`** gains optional `controlPlane` and `extensions` wiring to
  enable SaaS surfaces. Callers that pass neither get exactly v0.1 behavior.
- New route modules registered conditionally: **control-plane** (orgs,
  projects, users, members, API keys, magic-link), **billing**, **compliance**,
  **receipt**, **simulator**, **rca**, **cost-optimizer**, and webhook
  management.
- **`webhook-dispatch`** helper for fanning out ledger appends to subscribed
  URLs through the webhook worker.
- **Security headers** (`X-Content-Type-Options`, `X-Frame-Options`,
  `X-XSS-Protection`, `Referrer-Policy`, `Permissions-Policy`) on every
  response.
- **Prometheus metrics** endpoint plus JSON metrics plus readiness/liveness
  probes.

#### Documentation and infrastructure

- `docs/compliance/{soc2,gdpr,data-processing}.md` — auditor- and
  procurement-ready compliance docs.
- `docs/runbooks/saas-operations.md` — operator runbook for the hosted SaaS.
- `Dockerfile` (server) and `apps/console/Dockerfile` (nginx-served) with
  non-root users, multi-stage builds, and health checks.
- `docker-compose.yml` with optional Postgres, Prometheus, and Grafana
  profiles.
- `k8s/` manifests: namespace, ConfigMap, Secret, PVC, deployments, services,
  Ingress (cert-manager-ready), HPA (2 to 10 replicas).
- `.github/workflows/deploy.yml` — builds Docker images, publishes to GHCR,
  and rolling-updates staging/production via kubectl.
- `scripts/backup-ledger.ts` and `scripts/restore-ledger.ts` — encrypted,
  compressed, verified ledger backups (AES-256-CBC + gzip + SHA-256).

### Changed

- **`buildServer` now optionally accepts a `controlPlane` wiring object**
  (and a sibling `extensions` block). Both are fully backwards compatible:
  embedded callers that pass neither get exactly v0.1 behavior with no new
  routes, no new middleware, and no new dependencies activated.
- Vite console bundle is code-split with lazy view imports; initial JS is
  roughly 7 KB (down from ~900 KB) with Cloudscape isolated to a vendor chunk.
- API client adds a 5-minute in-memory cache for idempotent GET requests.

### Fixed

- Test reliability: a handful of timing-sensitive ledger tests no longer race
  on fast machines; the clock port is now injected uniformly across the
  affected suites.
- Type strictness: a few exported helpers were tightened against
  `exactOptionalPropertyTypes` so callers no longer have to cast through
  `unknown` when composing optional fields.
- API key prefix matching is now anchored to exactly 8 url-safe characters so
  brute-forced prefixes cannot accidentally collide with a real key.
- Magic-link consumption re-fetches the user record after marking the email
  verified so the returned session reflects the post-verification state.
- Stripe webhook handler dedups events by id so retried deliveries are
  idempotent.

## [0.1.0] — 2026-06-09

Initial release. See `ROADMAP.md` Milestone 0 for the foundation set.

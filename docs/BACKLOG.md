# Veritrail Backlog (living work queue)

> This is the prioritized task list the full-time engineer works from. Keep it
> truthful and current. When you finish a session, update the **Session log** at
> the bottom (date + what changed + what's next) so the next session resumes
> instantly. Check items off in the PR that completes them.

Priority order is top-to-bottom within each section; sections are in milestone
order. "Findings" come from the adversarial review of v0.1 (verified bugs and
lower-severity issues that were filed rather than fixed in the bootstrap).

---

## P0 — Repository safety (do first)

- [x] **Enable server-side branch protection on `main`.** Applied via
      `scripts/protect-branch.sh alpha-omega-bot/veritrail main` after the PAT
      gained the required administration scope. Required checks:
      `verify (node 20)`, `verify (node 22)`, `ledger integrity gate`; strict
      up-to-date checks; linear history; block force-push & deletion; required
      conversation resolution. (Local pre-push hook is active but bypassable.)
- [x] Local pre-push hook blocking broken pushes (`.githooks/pre-push`).
- [x] CI green on `main` (verify on Node 20/22 + ledger-integrity gate + CodeQL).

---

## P1 — Milestone 1: productionize the core

- [x] **Durable file append.** `FileEventStore.append` now uses explicit
      append-mode file handles, file `fsync` before acknowledgement,
      rollback/truncation on failed durable append, and torn-tail truncation
      during open before future appends. (review: core/medium)
- [x] **Relational `EventStore`.** SQL `EventStore` adapter + migrations +
      SQLite/Postgres dialect builders are in place, with concrete SQLite
      (single-node) and Postgres driver wrappers documenting and enforcing
      transaction isolation/concurrent-writer safety. Nothing above the port
      changed.
- [x] **Asymmetric signing.** Added a local Ed25519 `Signer` alongside HMAC.
      Verification is `signerKeyId`-aware and supports trusted previous public
      keys for key rotation.
- [x] **KMS/HSM signing interface.** Added `RemoteEd25519Signer`, a
      `RemoteSignerClient` port, local public-key verification, signing-failure
      error mapping, and an operator runbook for managed key custody/rotation.
- [x] **Provider signer package.** Added `@veritrail/provider-signers` with
      dependency-light AWS KMS, GCP Cloud KMS, Azure Key Vault, and HSM/PKCS#11
      `RemoteSignerClient` adapters. Provider SDKs remain deployment dependencies,
      not `@veritrail/core` dependencies.
- [x] **External anchoring.** Core `AnchorStore` port, `InMemoryAnchorStore`,
      ledger-head publish/verify helpers, rewrite-detection tests, and operator
      runbook are in place. Production deployments still need concrete provider
      adapters to publish checkpoints to an independent object store, notary, or
      transparency log.
- [ ] **Server authN/authZ.** API-key auth, route roles, and ledger-recorded
      administrative policy/budget changes are implemented. Remaining work:
      OIDC, tenant/project scoping, broader operator RBAC policy, and signed
      administrative action verification. (threat: S1)
- [ ] **PII handling.** Field-level redaction/encryption hooks at the append
      boundary; configurable retention with cryptographic erasure. (threat: I1)
- [ ] **Backpressure & limits.** Request rate limiting, payload caps, and append
      batching/backpressure on the server. (threat: D1)
- [ ] **`DefaultIdGenerator` hardening.** Guard against collisions when the clock
      moves backward and on >65536 ids/ms. (review: core/low)

---

## P2 — Milestone 2: bring scaffold modules to GA

Each module: clear its README "Phase 1 TODO", reach test depth comparable to the
GA modules, update maturity in `README.md`/`ROADMAP.md`/`docs/concepts/capabilities.md`.

### rollback

- [ ] Saga/partial-failure semantics; idempotency keys; real executor adapters;
      snapshot stores for the `restore` strategy.
- [ ] `execute()` loses a real compensation if the `action.rolled_back` append
      fails after a successful side effect — make it durable/retryable. (review: low)
- [ ] `planForCorrelation` silently drops executed actions whose proposal is in
      another correlation / whose executed receipt lacks the correlationId —
      decide intended semantics and make it explicit. (review: 2× low)

### forensics

- [ ] Anomaly detection, blast-radius analysis, root-cause ranking, snapshot
      diffs, shareable incident bundles.

### evidence

- [ ] External content capture + hashing; signed evidence; full
      decision↔evidence cross-linking; large-graph pagination.
- [ ] `trace()` depth cap + id-only visited set can drop in-range nodes/edges →
      incomplete provenance graph; and duplicate `derived_from` edges for repeated
      upstream ids. Fix traversal + dedupe edges. (review: medium + low)

### decision-memory

- [ ] Semantic recall via embeddings; outcome linkage (did the decision work?);
      recency/decay weighting.
- [ ] `recall` score denominator uses distinct-token set size, diverging from the
      documented `sharedTokens / queryTokens` for repeated tokens; and negative
      `limit` in `list()` returns ALL — clamp/validate. (review: 2× low)

### vendor-risk

- [ ] Real monitor feeds (status pages, CVE, SOC2/cert expiry); alert thresholds;
      SLA tracking; dependency mapping to affected agents.

---

## P2.5 — Cross-cutting correctness (smaller, do alongside module work)

- [ ] **SDK client** throws raw `SyntaxError` on non-JSON HTTP bodies →
      wrap to `VeritrailError` (uniform-error contract). (review: medium) — partially
      addressed in bootstrap; verify and add a test.
- [ ] **Audit `summary()`** can return an internally inconsistent snapshot under
      concurrent appends (multiple independent reads). Take one consistent
      snapshot. (review: low)
- [ ] **Server `limit` handling**: confirm non-positive `limit` semantics are
      consistent end-to-end (query layer treats `limit:0` as zero; ensure routes
      agree and are tested). (review: medium)

---

## P3 — Milestone 3: console & real-time

- [ ] Console to GA (live data, filtering, saved queries, integrity badge backed
      by live verify).
- [x] Remove internal engineering/maturity wording from user-facing console copy.
      The frontend must not expose terms such as "Phase 1", "scaffold", "mock",
      TODOs, roadmap labels, or session-only discussion. Use neutral operator
      copy for connection/data availability instead. Known current debt:
      `apps/console/src/components/Nav.tsx` footer and fallback-data notice.
- [ ] SSE/websocket subscription over the ledger tail.
- [ ] Alerting (budget breaches, denial spikes, vendor criticals) → email/Slack/webhook.
- [ ] Scheduled audit/spend/vendor reports & exports.

---

## P4 — Milestone 4: platform & ecosystem

- [ ] Multi-tenant control plane (orgs, projects, tenancy isolation, billing).
- [ ] Framework integrations + an **MCP server** so agents self-report to Veritrail.
- [ ] Policy-as-code (richer language, simulation/what-if, versioned on the ledger).
- [ ] Compliance packs (SOC 2 / ISO 27001 / EU AI Act readiness).

---

## Notes on already-fixed items (do not redo)

The bootstrap adversarial review found and **fixed** these (with regression
tests) — they are done:

- Signer crash (RangeError) on malformed same-length signature → hardened.
- `FileEventStore.open` aborting the whole ledger on a torn trailing line →
  recovers the committed prefix.
- `applyQuery` off-by-one with `limit:0` → returns zero.
- `verifyChain` now flags records lacking a signature when a signer is configured.
- Money bounded to safe integers.
- Permissions glob ReDoS (catastrophic backtracking) + newline-bypass → fixed.
- Spend-guard cross-currency budget aborting a charge → now skipped; label-budget
  accrual via the Governor → labels forwarded to `charge`; Governor now handles a
  failed `charge` result instead of swallowing it.
- Forensics `budget.charged` summary "[object Object]" → readable scope.
- Rollback `compensate` with no `inverse` (and `restore` with no snapshot) → now
  treated as unreversible.

---

## Session log

- **2026-06-17** — Started server authN/authZ. Added API-key authentication with
  `ingest`/`operator`/`admin` route roles, optional `buildServer({ auth })`
  configuration, `VERITRAIL_API_KEYS` parsing for the server binary, and
  ledger-recorded `admin.action` facts for policy/budget configuration changes.
  **Next:** finish remaining server auth depth with OIDC, tenant/project scoping,
  and richer operator RBAC.
- **2026-06-17** — Added `@veritrail/provider-signers`, a dependency-light package
  with AWS KMS, GCP Cloud KMS, Azure Key Vault, and generic HSM/PKCS#11-shaped
  `RemoteSignerClient` adapters for `RemoteEd25519Signer`. Provider SDKs stay out
  of `@veritrail/core`; tests use fake SDK clients to lock command/request shape
  and missing-signature failures. **Next:** continue Milestone 1 with server
  authN/authZ.
- **2026-06-17** — Added core external anchoring. `AnchorRecord` checkpoints,
  `AnchorStore`, `InMemoryAnchorStore`, `publishLedgerHeadAnchor()`, and
  `verifyLedgerAgainstLatestAnchor()` now let deployments publish independent
  ledger-head checkpoints and detect wholesale rewrites of an unsigned chain.
  Added adversarial rewrite tests and `docs/runbooks/external-anchoring.md`.
  **Next:** provider-specific KMS signer wrappers or concrete anchor-store
  adapters for object-store/notary deployments.
- **2026-06-17** — Added the remote key-custody signing interface. `Signer.sign`
  now supports async implementations; `Ledger.append()` maps remote signing
  failures to `STORAGE` before persistence; `RemoteEd25519Signer` signs via a
  `RemoteSignerClient` and verifies locally with configured public keys. Added
  tests for remote signing and remote signing failure, plus
  `docs/runbooks/kms-hsm-signing.md`. **Next:** provider-specific KMS wrappers or
  external anchoring.
- **2026-06-17** — Added local Ed25519 ledger signing in `@veritrail/core`.
  `verifyChain` now passes each record's `signerKeyId` into the signer, HMAC
  rejects wrong key ids, and Ed25519 verification can trust previous public keys
  so records signed before rotation still verify. Added tests for forged
  Ed25519 signatures, wrong-key verification failure, malformed HMAC input, and
  rotation verification. **Next:** continue Milestone 1 with KMS/HSM signer
  adapters or external anchoring.
- **2026-06-17** — Added concrete relational driver wrappers in
  `@veritrail/relational-store`: SQLite uses `BEGIN IMMEDIATE`/`EXCLUSIVE`
  around the append path, and Postgres uses serializable transactions plus a
  transaction-scoped advisory lock. Added wrapper tests for protected head reads
  and rollback-on-failure behavior, documented the driver APIs and writer-safety
  guarantees, and cleaned user-facing console copy so offline data is described
  as sample data rather than internal maturity/fallback wording. **Next:**
  continue Milestone 1 with asymmetric signing or external anchoring.
- **2026-06-17** — Handoff memory for the next session: loaded AGENTS.md and
  durable project docs, synced `main`, installed dependencies, enabled the
  pre-push hook, and kept the baseline green before feature work. After the PAT
  scope was widened, enabled server-side branch protection on `main` and merged
  the repository-safety PR; CodeQL remains artifact-based because private-repo
  GitHub Advanced Security is not purchased. Completed and merged the durable
  `FileEventStore.append` hardening PR and the initial
  `@veritrail/relational-store` SQL adapter PR; both went through local verify,
  PR CI (`verify (node 20)`, `verify (node 22)`, `ledger integrity gate`), and
  squash/rebase merge. Previewed the existing React/Vite console from
  `apps/console` on port 5173 via localtunnel; the user viewed it and confirmed
  it is read-only. Product copy rule from the user: frontend UI must not expose
  internal maturity labels or session-discussion language such as "Phase 1",
  "scaffold", or "mock"; keep that in docs/backlog, not in the app UI. Preview
  server and tunnel were stopped; repo was clean on `main...origin/main` before
  writing this note. **Next:** continue P1 with the concrete SQLite single-node
  relational store wrapper, then Postgres HA wrapper; separately clean the
  console's internal-facing copy before treating the console as user-facing.
- **2026-06-17** — Started the relational `EventStore` milestone with
  `@veritrail/relational-store`: a dependency-light SQL adapter behind the
  existing core `EventStore` port, migration SQL, SQLite/Postgres dialect
  builders, canonical record storage, transaction-scoped append checks, and
  uniqueness-race conflict mapping tests. **Next:** add the concrete SQLite
  single-node driver wrapper, then Postgres HA wrapper.
- **2026-06-17** — Started Milestone 1 durable file append hardening. Replaced
  `FileEventStore.append`'s plain `appendFile` path with explicit append-mode
  file handles, file `fsync` before acknowledgement, rollback/truncation on
  failed durable append, and torn-tail truncation during open before future
  appends. Added adversarial fsync-failure and torn-tail recovery tests.
  **Next:** continue Milestone 1 with the relational `EventStore` adapter.
- **2026-06-17** — Enabled server-side branch protection on `main` after the PAT
  gained administration scope. Verified strict required checks
  (`verify (node 20)`, `verify (node 22)`, `ledger integrity gate`), admin
  enforcement, linear history, blocked force-push/deletion, and required
  conversation resolution. Merge settings are squash/rebase only with branch
  auto-delete. CodeQL could not upload to GitHub code scanning because private-repo
  Advanced Security is not purchased; upgraded CodeQL to v4 and configured it to
  publish SARIF as a CI artifact instead. **Next:** start Milestone 1 with
  durable `FileEventStore.append` fsync/atomicity.
- **2026-06-17** — Bootstrap by Claude: built v0.1 (core + 8 modules + sdk +
  server + cli + console + docs + CI), ran adversarial review, fixed 6
  high/critical + several lower findings (199 tests green). Created private repo
  `alpha-omega-bot/veritrail`, pushed `main`, added local pre-push guard and
  `scripts/protect-branch.sh`. CI green on Node 20/22 + ledger-integrity gate.
  **Server-side branch protection NOT yet enabled** (token lacks Administration:
  write) — that is the top P0 item. **Next:** enable protection, then start
  Milestone 1 (durable append → relational store) and Milestone 2 (rollback to GA
  first, since its findings are smallest).

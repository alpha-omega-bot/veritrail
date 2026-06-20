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
- [ ] **Server authN/authZ.** API-key auth, route roles/scopes, OIDC bearer JWTs
      with static JWKS plus discovery/JWKS refresh, label-scoped raw ledger
      reads/writes, spend charges and spend read projections, signed
      administrative mutation requests, ledger-recorded administrative
      policy/budget changes, Decision Memory writes/read projections, Evidence
      writes/read projections, Vendor Risk writes/read projections, Forensics
      incident/cause-chain read projections, Rollback plan reads + compensating
      writes, tenant-scoped Permissions policies (per ADR-0004), and fail-closed
      scoped access for unpartitioned module projections are implemented. Every
      module projection now has tenant semantics. Remaining work: broader policy
      composition (folded into the M4 policy-as-code item — richer language,
      simulation, versioned on the ledger). (threat: S1)
- [ ] **PII handling.** Append-boundary field redaction (path redactor),
      field-level encryption (`EncryptingEventRedactor` + `FieldCipher` /
      `AesGcmKeyring`), and cryptographic erasure (key destruction preserves the
      hash chain; `verify()` stays green) are implemented per ADR-0005. Remaining
      work: automated retention/erasure jobs on a schedule (mechanism exists;
      scheduling is operator-driven for now). (threat: I1)
- [ ] **Backpressure & limits.** Server request body caps, fixed-window API rate
      limiting, and write-route in-flight backpressure are implemented. Remaining
      work: append batching for high-throughput ingest. (threat: D1)
- [x] **`DefaultIdGenerator` hardening.** Guard against collisions when the clock
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

- [x] **SDK client** throws raw `SyntaxError` on non-JSON HTTP bodies →
      wrap to `VeritrailError` (uniform-error contract). (review: medium) — partially
      addressed in bootstrap; verified with regression tests.
- [x] **Audit `summary()`** can return an internally inconsistent snapshot under
      concurrent appends (multiple independent reads). Take one consistent
      snapshot. (review: low)
- [x] **Server `limit` handling**: confirm non-positive `limit` semantics are
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

- **2026-06-20** — Added P1 PII field-level encryption + cryptographic erasure
  (ADR-0005). New `@veritrail/core` `crypto/field-cipher`: a `FieldCipher` port,
  the `AesGcmKeyring` reference adapter (AES-256-GCM, named keys, `eraseKey`),
  `EncryptingEventRedactor` (an `EventRedactor` that encrypts configured string
  fields to `enc.v1.<keyId>.…` tokens at the append boundary, before
  hashing/signing), and `decryptEventFields` for authorized reads. Because the
  ciphertext is what gets hashed, destroying a key crypto-shreds the field while
  the record bytes — and `verify()` — stay intact; a test asserts exactly that.
  Updated the PII runbook and marked the backlog item; only scheduled
  retention/erasure automation remains. **Next:** the last mechanical P1 item —
  append batching for high-throughput ingest — then Milestone 2 scaffold-module
  GA work (rollback findings first).
  (ADR-0004). Added an optional `tenant` to the core `PolicySchema`: a policy
  with no tenant is global, one with tenant labels applies only to in-scope
  principals. `listPolicies`/`evaluate`/`enforce` take an optional `scope`
  (global + in-scope candidates; deny-by-default preserved), and `enforce` stamps
  the principal's labels onto the `policy.evaluated`/`action.authorized`/
  `action.denied` facts. Server permissions routes are now scoped: a label-scoped
  admin may only create/remove policies in its own scope (the policy's `tenant`
  is forced to the admin's scope; a body naming another tenant is rejected — the
  footgun fix), and only an unscoped admin can write global policies. Added the
  ADR, core schema + module + HTTP scoping tests, and updated the stale
  "denies unpartitioned" test (permissions routes are now partitioned). Every
  module projection now has tenant semantics; broader policy composition is
  folded into the M4 policy-as-code item. **Next:** remaining mechanical P1 items
  — PII field encryption + retention/erasure, append batching — then Milestone 2
  scaffold-module GA work.
  module: `planForAction` and `planForCorrelation` filter to in-scope records
  (planning another tenant's action returns NOT_FOUND — fail-closed), and
  `execute` stamps the principal's labels onto appended `action.rolled_back`
  facts. Wired `/api/rollback/plan/action/:actionId`,
  `/api/rollback/plan/correlation/:correlationId`, and `/api/rollback/execute`
  from unscoped to scoped, updated the stale "denies unpartitioned projections"
  test, and added module + HTTP scoping tests. Permissions is now the only module
  still fail-closed for scoped principals. **Next:** permissions tenant scoping
  (closing the P1 server-auth item), or move to P1 PII encryption/retention or
  append batching; then Milestone 2 scaffold-module GA work.
  Forensics. Added `ForensicsProjectionOptions` to the module: `incident` now
  filters the correlation's events by exact labels (counts/timeline reflect only
  in-scope events), and `causeChain` builds its id-index from in-scope records
  only, so a hop to an out-of-scope link truncates the walk at the tenant
  boundary (a chain rooted at another tenant returns empty — fail-closed). Wired
  `/api/forensics/incident` and `/api/forensics/cause/:causationId` from
  unscoped to scoped reads, updated the stale "denies unpartitioned projections"
  test, and added module + HTTP scoping tests. Rollback and permissions remain
  fail-closed for scoped principals until their tenant model is explicit.
  **Next:** rollback tenant scoping, or move to P1 PII encryption/retention or
  append batching; then Milestone 2 scaffold-module GA work.
  Vendor Risk. Added `VendorRiskRecordOptions`/`VendorRiskProjectionOptions` to
  the vendor-risk module so writes can stamp ledger labels and reads filter by
  exact labels. Scoped `/api/vendors` and `/api/vendors/signals` writes now stamp
  the principal's label scope onto `vendor.registered` / `vendor.signal` facts,
  while the vendor inventory, signal, assessment, and score reads project only
  vendor facts carrying that complete scope. Closed an incoherence in the
  in-flight draft: the `/api/vendors` list read and the `/api/vendors` register
  write were left unscoped, so a label-scoped reader could never see a vendor
  (unlabeled facts never match a scoped query); both are now scoped consistently.
  Added module-level and HTTP-level scoping tests and updated the stale
  "denies unpartitioned projections" test. Forensics incident/cause-chain and
  rollback remain fail-closed for scoped principals until their tenant semantics
  are explicit. **Next:** tenant-filtered projection semantics for forensics
  incident/cause and rollback, or continue P1 with PII encryption/retention or
  append batching.
  onto `evidence.attached` facts, while scoped evidence list, trace, and content
  verification project only evidence carrying that complete scope. Trace edges
  to out-of-scope upstream ids remain visible as dangling provenance references,
  but the out-of-scope evidence is not loaded. Vendor risk, forensics
  incident/cause-chain, and rollback remain fail-closed for scoped principals
  until their tenant semantics are explicit. **Next:** continue tenant-filtered
  projection semantics for vendor/rollback, or continue P1 with PII
  encryption/retention or append batching.
- **2026-06-20** — Continued P1 server auth projection-tenancy semantics with
  Decision Memory. Scoped `/api/decisions` writes now stamp the principal's label
  scope onto `decision.recorded` facts, while scoped `/api/decisions` and
  `/api/decisions/recall` project only decisions carrying that complete scope.
  Evidence, vendor risk, forensics incident/cause-chain, and rollback remain
  fail-closed for scoped principals until their tenant semantics are explicit.
  **Next:** continue tenant-filtered projection semantics for evidence/vendor/
  rollback, or continue P1 with PII encryption/retention or append batching.
- **2026-06-19** — Added tenant-filtered Spend Guard read projections. Scoped
  `/api/spend/budgets` and `/api/spend/status` now return label budgets inside
  the principal's label scope and count only charge records carrying the complete
  configured scope, while budget mutation remains unscoped-only. **Next:**
  continue tenant-filtered projection semantics for decision/evidence/vendor/
  rollback routes, or continue P1 with PII encryption/retention or append
  batching.
- **2026-06-19** — Continued P1 server auth projection-tenancy semantics with a
  fail-closed boundary for unpartitioned module projections. Label-scoped
  principals can still use raw scoped ledger writes/reads and scoped spend
  charges, but permissions policy routes, decision memory, evidence, vendor
  risk, forensics incident/cause-chain, rollback planning/execution, and scoped
  admin/config mutations now require an unscoped key until each module has an
  explicit tenant-filtered projection. **Next:** either add tenant-filtered
  projection semantics route by route, or continue P1 with PII encryption and
  retention / append batching.
- **2026-06-19** — Continued P1 server auth projection-tenancy semantics with a
  focused Spend Guard HTTP-boundary slice. Label-scoped ingest keys can no
  longer append `/api/spend/charge` facts unless the charge labels include the
  configured scope, and label-scoped spend operators are denied whole-deployment
  `/api/spend/budgets` and `/api/spend/status` projections until tenant-filtered
  spend views exist. **Next:** continue projection-specific tenancy for
  decision/evidence/vendor/rollback routes or implement tenant-filtered spend
  read projections.
- **2026-06-19** — Continued P1 server auth with OIDC discovery/JWKS refresh.
  Server OIDC config can now use static JWKS as a seed/fallback, fetch JWKS from
  `jwksUrl`, or resolve `jwks_uri` from a discovery document. JWT verification
  refreshes on unknown `kid` or TTL expiry, validates fetched documents before
  trusting them, preserves cached matching keys during issuer outages, and fails
  closed for unknown keys or malformed remote JWKS. **Next:** continue server
  auth with projection-specific tenancy semantics or broader policy composition.
- **2026-06-19** — Continued P1 server auth with static-JWKS OIDC bearer JWT
  verification. `buildServer({ auth: { oidc } })` now validates RS256 compact
  JWTs against configured issuer/audience/JWKS, maps configured claims into the
  existing Veritrail principal model, and enforces route scopes plus label scopes
  through the same auth path as API keys. The server binary accepts
  `VERITRAIL_OIDC_*` env config. **Next:** continue server auth with OIDC
  discovery/JWKS refresh, projection-specific tenancy semantics, or broader
  policy composition.
- **2026-06-18** — Added opt-in signed administrative mutation verification for
  server policy/budget writes. When configured, admin routes require
  `x-veritrail-admin-*` HMAC headers over method, path, timestamp, nonce, and
  canonical body hash; stale, replayed, or tampered requests fail before
  server-held config changes, and successful mutations record the signature
  receipt in the `admin.action` ledger fact. **Next:** continue server auth with
  OIDC, projection-specific tenancy semantics, or broader policy composition.
- **2026-06-18** — Added the first tenant/project scoping slice for server API
  keys. Keys can now carry `labelScope` constraints; scoped `/api/events` writes
  must include those exact event labels, and raw ledger-query reads force the
  same labels before `limit` is applied. Core `EventQuery` now supports exact
  label filters, with in-memory and relational-store regression tests. **Next:**
  continue the server auth item with projection-specific tenancy semantics,
  signed administrative action verification, or OIDC.
- **2026-06-18** — Deepened server authZ with optional per-capability route
  scopes for API keys. Existing role-only keys keep their current behavior, while
  scoped operator keys can now be narrowed to surfaces such as `audit:read`,
  `spend:read`, or `rollback:execute`; admin keys still satisfy all scopes. Added
  auth-unit and HTTP-route regression tests plus server README documentation.
  **Next:** continue the open server auth item with OIDC or tenant/project
  scoping, or take append batching if staying in P1 backpressure work.
- **2026-06-18** — Completed the P2.5 server `limit` handling item. Audit,
  forensics, and decision-memory read routes now validate `limit` at the HTTP
  boundary as a non-negative integer, preserving `limit=0` as an explicit empty
  result while rejecting negative, fractional, empty, and non-numeric limits with
  `VALIDATION` / HTTP 400. Added route regression tests and documented the server
  query contract. **Next:** choose the next small production-readiness slice:
  append batching, deeper server auth scoping, or the next scaffold-module GA
  hardening task.
- **2026-06-18** — Fixed `Audit.summary()` snapshot consistency. Summary now
  reads the ledger once and verifies that same snapshot via
  `Ledger.verifyRecords()`, preserving signed-ledger integrity checks while
  preventing counts from describing an older moment than the reported head.
  Added concurrent-append and signed-snapshot regression tests. **Next:** finish
  the remaining P2.5 server `limit` handling item, then choose between append
  batching or the next scaffold-module GA slice.
- **2026-06-18** — Verified and documented the SDK HTTP client's uniform-error
  contract. Added regression tests proving non-JSON error and success responses
  are wrapped as `VeritrailError` instead of leaking raw `SyntaxError`, and added
  the missing package README for `@veritrail/sdk`. **Next:** continue small
  correctness items (`Audit.summary()` snapshot consistency or server `limit`
  semantics), or start a larger P1 slice.
- **2026-06-18** — Hardened `DefaultIdGenerator`. It now uses a per-generator
  logical timestamp that never moves backward and a widened sortable counter, so
  ids remain unique and lexicographically ordered when the injected clock moves
  backward or more than 65,536 ids are minted in one millisecond. **Next:** choose
  the next focused P1 slice: append batching, deeper server auth scoping, or PII
  encryption/retention.
- **2026-06-18** — Added server defensive limits. `buildServer({ limits })` now
  configures a Fastify body cap, fixed-window API rate limits keyed by API key or
  IP, and write-route in-flight backpressure that returns `503` before append-like
  handlers pile up. The binary exposes env knobs for body bytes, rate window/max,
  and max in-flight writes. **Next:** finish the remaining P1 append batching
  work, then revisit the remaining server auth depth.
- **2026-06-18** — Added core append-boundary event redaction. `Ledger.append()`
  now can apply an `EventRedactor` after initial validation and before
  hashing/signing/persistence, then re-validates the redacted event. Added
  `PathEventRedactor` with dot paths and `*` wildcards, tests for persisted
  redaction, invalid redaction, and redactor failure, plus
  `docs/runbooks/pii-redaction.md`. **Next:** continue P1 with encryption and
  retention for PII, or backpressure/rate limits if keeping the next PR
  server-focused.
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

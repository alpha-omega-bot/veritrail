# Veritrail Threat Model

A living document. It states what we protect, who we protect it from, and how —
so that design and review decisions can be traced to a stated threat.

## Assets

| Asset                        | Why it matters                                                             |
| ---------------------------- | -------------------------------------------------------------------------- |
| **The ledger (history)**     | The authoritative record of what agents did. Its integrity is the product. |
| **Chain head + signing key** | Anchors integrity; the key authorizes records when signing is on.          |
| **Policies & budgets**       | Define what is allowed and how much may be spent.                          |
| **Decision/evidence data**   | The "why" behind actions; may reference sensitive sources.                 |
| **Operator credentials**     | (Milestone 1) Authority to administer the platform.                        |

## Trust boundaries

```
   [ agent runtime ] ──HTTP/SDK──► [ Veritrail server ] ──port──► [ EventStore ]
        (untrusted               (trusted core +              (trusted storage;
         input source)            validation)                 protect at rest)
```

- Input crossing **agent → server/SDK** is **untrusted**: validated by Zod before
  it touches the ledger.
- The **core** is trusted code with no I/O of its own; it depends only on `zod`
  and Node built-ins.
- The **EventStore** (file/db) is trusted storage; its at-rest protection is the
  deployer's responsibility until field-level encryption ships.

## Threats and mitigations

We use STRIDE as a checklist.

### Tampering (the primary threat)

- **T1 — Edit a past record.** _Mitigation:_ hash-chaining; `verify()` reports
  `hash_mismatch` (or downstream `chain_break` if re-hashed). ✔ implemented +
  tested.
- **T2 — Insert/delete records.** _Mitigation:_ contiguous `seq` + prevHash
  linkage; `verify()` reports `seq_gap`/`chain_break`. ✔ tested.
- **T3 — Rewrite the entire unsigned chain.** _Mitigation:_ enable signing; and/or
  publish external anchors of the head through an independent `AnchorStore`.
  ✔ core port/helper implemented; concrete anchor stores must live outside the
  ledger's own storage/admin boundary. **Residual risk:** unanchored intervals
  remain rewriteable until the next checkpoint is published.
- **T4 — Forge records when signing is on.** _Mitigation:_ signature verification;
  Ed25519 asymmetric signing removes shared-secret verifier exposure.
  `RemoteEd25519Signer` supports KMS/HSM custody while keeping verification local.

### Spoofing

- **S1 — Impersonate an actor/operator.** _Mitigation:_ server authN + per-actor
  scoping. ✔ API-key auth with route roles is implemented for the HTTP server;
  OIDC and multi-tenant scoping remain future platform work.

### Repudiation

- **R1 — "The agent didn't do that."** _Mitigation:_ the ledger is the
  non-repudiable record; signing binds records to a key. ✔ (✔ with signing).

### Information disclosure

- **I1 — Sensitive data in event payloads.** _Mitigation:_ configure
  append-boundary redaction so targeted fields are removed before hashing,
  signing, and persistence. Field-level encryption and retention with
  cryptographic erasure remain Milestone 1 work. Protect the store with
  OS/storage controls. ⚠ **Residual risk.**
- **I2 — Over-broad reads via the API.** _Mitigation:_ authZ + query scoping
  (Milestone 1). ✔ route-level API-key roles now protect read APIs when auth is
  configured; tenant/project query scoping remains future platform work.

### Denial of service

- **D1 — Flood appends / huge payloads.** _Mitigation:_ schema bounds on string
  lengths, server request body caps, fixed-window API rate limits, and write-route
  in-flight backpressure. Append batching remains future throughput work.
- **D2 — Unbounded spend by an agent.** _Mitigation:_ Spend Guard hard-stops at
  budget limits by default. ✔ implemented.

### Elevation of privilege

- **E1 — Bypass permissions.** _Mitigation:_ deny-by-default evaluation; `enforce()`
  records the decision and denies on the ledger. Callers must route actions through
  the permissions engine — the SDK's instrumented path does this. ✔ engine
  implemented; ✔ safe default.

## Abuse cases specific to agents

- **Runaway loops** → Spend Guard budgets + server rate limits bound blast radius.
- **Prompt-injected "delete the logs"** → tamper-evidence makes deletion detectable;
  with signing, an injected agent cannot forge a clean chain.
- **Silent vendor degradation** → Vendor Risk surfaces signals and scores before a
  dependency causes an incident.

## Assumptions

- The host running the core/server is not already fully compromised at the OS level.
- Deployers protect the ledger store and (when used) the signing key with
  appropriate access controls.
- Clocks are roughly monotonic; the authoritative timestamp is the ledger's own.

## Review cadence

Revisit this model whenever a new event type, module, storage adapter, or network
surface is added. Link PRs that change the security posture to the relevant threat
ID above.

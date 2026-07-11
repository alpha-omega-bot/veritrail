# Veritrail SOC 2 Readiness Map

This document maps Veritrail's product features to the AICPA Trust Services Criteria
(TSC, 2017 with 2022 points-of-focus update). It is intended as a starting point for
customers undergoing a SOC 2 Type I or Type II examination, and for procurement and
security teams evaluating Veritrail as a vendor.

Veritrail is engineered as evidence infrastructure: an append-only ledger, tamper-evident
receipts, and a compliance package that exposes the controls auditors expect to see.
The platform provides the technical substrate; the customer organisation provides the
policies, personnel, and review cadence that complete a SOC 2 program.

## 1. Scope

| Item                                | Value                                                                   |
| ----------------------------------- | ----------------------------------------------------------------------- |
| Service description                 | Veritrail provenance, attestation, and audit-ledger platform            |
| Subservice organisations            | Cloud hosting provider, transactional email, payments (see §6)          |
| Trust Services Categories addressed | Security (default), Availability, Confidentiality, Processing Integrity |
| Report type supported               | Type I and Type II                                                      |
| Inclusive vs. carve-out             | Carve-out for subservice organisations                                  |

The Privacy category is addressed separately in `gdpr.md` and `data-processing.md`.

## 2. Trust Service Criteria coverage

The table below summarises how Veritrail evidences each Common Criterion. Each row
points to a concrete product feature or runbook. Per-control test procedures live in
the `@veritrail/compliance` package.

| Criterion                             | How Veritrail evidences it                                                                                                                                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CC1 Control Environment**           | Org-level policies (code of conduct, security policy, acceptable use) are versioned in the docs repo and acknowledged through onboarding; role definitions and segregation of duties are enforced via project RBAC in the control plane.                |
| **CC2 Communication and Information** | All control changes are announced through the changelog, the in-product release notes feed, and the customer-facing status page; internal incidents and reviews are tracked in the engineering knowledge base with read receipts.                       |
| **CC3 Risk Assessment**               | The Veritrail threat model (`docs/THREAT-MODEL.md`) is reviewed quarterly; risk register entries map to mitigations recorded as ADRs; the `@veritrail/compliance` package provides a `risk:assess` command that snapshots the live risk surface.        |
| **CC4 Monitoring Activities**         | The immutable ledger emits an integrity check event on every append; the operations runbook (`docs/runbooks/`) schedules nightly chain-verification jobs; SIEM forwarding hooks ship structured audit events for continuous monitoring.                 |
| **CC5 Control Activities**            | Policy-as-code lives alongside the codebase; deny-by-default access rules are exercised in CI; sensitive actions (key rotation, retention overrides) require dual control via the `compliance:approve` workflow.                                        |
| **CC6 Logical and Physical Access**   | OIDC/OAuth2 for human access, scoped API keys for machine access, hardware-backed signing keys for the receipt issuer, and IP allow-lists per project. Physical access is delegated to the hosting subservice and covered under their SOC 2 report.     |
| **CC7 System Operations**             | Structured logs, metrics, and traces are shipped to the customer's observability stack; incidents follow the runbook in `docs/runbooks/incident-response.md`; on-call schedules and post-mortems are tracked with the audit log itself.                 |
| **CC8 Change Management**             | Every change is a pull request with at least one reviewer, passes CI (lint, type, unit, integration, security), and is recorded on the deployment ledger; database migrations are gated by a separate approval; rollbacks are documented and rehearsed. |
| **CC9 Risk Mitigation**               | Business continuity is exercised quarterly: ledger restore drills, key recovery rehearsal, and vendor failover. Cyber insurance and a written incident response plan close residual risk.                                                               |

Additional category criteria:

| Criterion                    | How Veritrail evidences it                                                                                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A1 Availability**          | Documented RPO of fifteen minutes and RTO of four hours; multi-AZ Postgres; daily backups with monthly restore tests; status page with public uptime history.                                                       |
| **C1 Confidentiality**       | Field-level encryption for sensitive payloads (see ADR-0005), per-project encryption keys, deny-by-default sharing on the Risk Network.                                                                             |
| **PI1 Processing Integrity** | Each append to the ledger emits a tamper-evident receipt signed by `@veritrail/receipt`; chain verification is exposed as a public endpoint and as an offline CLI; inputs are schema-validated at the API boundary. |

## 3. Feature-to-evidence map

Auditors typically request artefacts. The list below tells you where to find them.

| Auditor request                     | Where to find it in Veritrail                                                                                                                        |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Immutable record of system events   | The append-only ledger; every state-changing operation is recorded as a signed entry.                                                                |
| Proof a record has not been altered | Receipts issued by `@veritrail/receipt`; verification is deterministic and offline-capable.                                                          |
| Continuous control monitoring       | The `@veritrail/compliance` package exposes scheduled jobs for chain integrity, access review, retention sweep, and key rotation reminders.          |
| Access review evidence              | `compliance:access-review` produces a signed report of all principals with access at a given timestamp, ready to attach to the auditor's work paper. |
| Change management trail             | The deployment ledger entry for each release links to the PR, the CI artefacts, and the approver.                                                    |
| Backup restore evidence             | The restore drill runbook emits ledger entries on completion, providing a signed timestamp of the drill outcome.                                     |
| Vendor management                   | `@veritrail/compliance` ships a sub-processor manifest that is rendered in the customer DPA (`data-processing.md`).                                  |

## 4. Customer responsibilities (shared-responsibility model)

Veritrail is a tool, not a stamp. The following responsibilities remain with the customer
and are commonly written into the auditor's complementary user-entity controls (CUECs).

- **Sign a Data Processing Agreement** (`data-processing.md`) with Veritrail before
  processing personal data.
- **Configure a retention policy** appropriate for your industry and jurisdiction.
  Veritrail defaults to indefinite retention; the customer must explicitly opt into a
  shorter window via `compliance:set-retention`.
- **Enable encryption at rest at the storage layer.** Veritrail performs field-level
  encryption for sensitive payloads, but disk-level encryption on the customer's
  Postgres host is the customer's responsibility (or the hosting provider's, in the
  SaaS variant).
- **Schedule regular integrity checks.** The `compliance:verify-chain` job should be
  run at least daily; weekly is the minimum acceptable cadence for SOC 2.
- **Maintain an access review cadence** of at least quarterly, using the
  `compliance:access-review` report as input.
- **Maintain written security policies** including acceptable use, incident response,
  vendor management, and a code of conduct. Veritrail provides templates but does not
  publish them on the customer's behalf.
- **Maintain an asset inventory** that includes the Veritrail deployment and any
  integrations.
- **Perform an independent audit.** SOC 2 attestation is issued by a licensed CPA
  firm. Veritrail cannot issue the report on the customer's behalf.

## 5. Limitations

A few things to be explicit about, because they come up in procurement every quarter.

- **Veritrail is not itself SOC 2 attested by virtue of being installed.** The SaaS
  variant pursues its own SOC 2 Type II report; self-hosted deployments inherit none
  of that scope automatically.
- **A tamper-evident receipt is not a substitute for written policy.** Auditors test
  the _operation_ of controls, not only the existence of technical artefacts.
- **Ledger immutability is logical, not physical.** A sufficiently privileged operator
  with database access can drop the table. Veritrail mitigates this with row-level
  security, write-only roles, and off-host receipt witnesses, but the threat model is
  documented in `docs/THREAT-MODEL.md` and customers should review it.
- **The Risk Network shares hashes only.** Cross-customer signal sharing never
  exposes payloads, but customers should still treat hash-based signals as customer
  data under their privacy policy.
- **Subservice organisations are carved out.** The hosting provider, transactional
  email vendor, and payments processor have their own SOC 2 reports; Veritrail does
  not re-attest them.

## 6. Subservice organisations

| Subservice             | Function                                        | Report relied upon      |
| ---------------------- | ----------------------------------------------- | ----------------------- |
| Cloud hosting provider | Compute, storage, networking, physical security | SOC 2 Type II           |
| Transactional email    | Outbound notifications and receipts             | SOC 2 Type II           |
| Payments processor     | Subscription billing for the SaaS variant       | SOC 1 and SOC 2 Type II |

The customer is responsible for reviewing each subservice's report and confirming the
complementary subservice organisation controls (CSOCs) are operating effectively.

## 7. References

- `docs/THREAT-MODEL.md` — adversary model and mitigations
- `docs/adr/0005-field-level-encryption.md` — field cipher design
- `docs/runbooks/` — operational procedures and drills
- `packages/compliance/` — control-monitoring jobs and reports
- `packages/receipt/` — tamper-evident receipt issuer and verifier
- `gdpr.md` — GDPR controller and processor responsibilities
- `data-processing.md` — Data Processing Agreement template

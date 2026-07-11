# Veritrail and the GDPR

This document explains how Veritrail supports customers in meeting their obligations
under Regulation (EU) 2016/679 (the General Data Protection Regulation). It covers the
controller/processor split, the articles most often raised in procurement, and the
sub-processors Veritrail relies on in its SaaS variant.

It is written for the data protection officer (DPO) or counsel reviewing Veritrail as
a vendor. It is not legal advice.

## 1. Roles

| Variant     | Veritrail's role                                                                                   | Customer's role                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Self-hosted | Software provider only. No personal data flows to Veritrail.                                       | Controller and processor (or joint controller, depending on use case).                   |
| SaaS        | Processor (Article 28) for customer-uploaded data; sub-processor for the customer's data subjects. | Controller for end-user data; processor for any data they receive from upstream parties. |

In the SaaS variant, the customer remains the controller for all personal data they
upload, and Veritrail processes that data strictly on documented instructions, namely
the instructions encoded in the API contract and the signed Data Processing Agreement.

## 2. Article 17 — Right to erasure on a hash-chained ledger

Veritrail's ledger is append-only and tamper-evident. Naive deletion would break the
hash chain and invalidate every receipt downstream. The product handles erasure
without compromising integrity by combining two mechanisms.

**Field-level encryption.** All payloads that may contain personal data are encrypted
at the field level before they are hashed and persisted. The cipher implementation
lives at `packages/core/src/crypto/field-cipher.ts` and is specified in
`docs/adr/0005-field-level-encryption.md`. Each project holds a distinct data
encryption key (DEK), itself wrapped by a key encryption key (KEK) under the customer
key-management service.

**Crypto-shredding.** To honour an erasure request, the customer (or Veritrail
acting on the customer's instruction) destroys the DEK for the affected scope. The
ciphertext remains in place — which is what keeps the hash chain valid and every
receipt verifiable — but the plaintext is irrecoverable. From the data subject's
perspective the personal data is gone; from the auditor's perspective the integrity
of every other record is preserved.

Granularity:

| Scope       | Effect of key destruction                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------ |
| Per record  | One subject's data is erased; everything else remains readable.                                  |
| Per project | All records in a project become unreadable; the customer keeps the metadata structure for audit. |
| Per tenant  | All projects for a tenant become unreadable, suitable for full account closure.                  |

The erasure workflow is exposed through the `compliance:erase` command. It records a
signed erasure receipt to the ledger — the record of _what was erased and when_ is
itself audit evidence.

> Note on practical limits: erasure does not extend to system fields used to maintain
> the chain (timestamps, hashes, sequence numbers), which are not personal data, and
> does not extend to backups until they expire under the retention schedule. Both
> exclusions are recognised under EDPB guidance and should be reflected in the
> customer's privacy notice.

## 3. Article 20 — Right to data portability

Veritrail exposes a per-project export endpoint.

```
GET /api/v1/projects/:id/export
Accept: application/jsonl
```

The response is a JSONL bundle of every ledger entry in the project, plus a detached
signature file (`export.sig`) issued by `@veritrail/receipt` so the recipient can
verify the bundle was produced by Veritrail and not modified in transit. The bundle
includes:

- All ledger entries in canonical JSON order
- The chain of receipts witnessing those entries
- The schema version and a manifest describing every field

The export is structured, commonly used, and machine-readable — the three properties
Article 20(1) requires. A customer wishing to migrate to another platform can hand the
bundle to the next vendor; a data subject exercising the right directly receives the
filtered subset that pertains to them, also signed.

The endpoint is rate-limited and access-logged. Authorisation requires either a
project-admin token or a data-subject token issued through the customer's identity
provider.

## 4. Article 25 — Data protection by design and by default

Veritrail ships with the following defaults; they are documented here because Article
25(2) requires the default settings to be the _most_ privacy-preserving available.

- **Deny-by-default access policies.** New projects, new keys, and new external
  shares start with no access. Access must be granted explicitly. The policy engine
  refuses to evaluate an undeclared action.
- **Hash-only Risk Network sharing.** Cross-customer signals on the Risk Network are
  hashes, never payloads. Two customers can co-detect a pattern without either
  learning the other's data.
- **Minimal data collection.** The signup form asks for an email and an organisation
  name. No tracking pixels, no third-party analytics by default.
- **Field-level encryption on by default.** No customer flag is needed to turn it on.
  Turning it off requires an explicit configuration override and is logged.
- **Short default retention for telemetry.** Operational telemetry is purged after
  30 days; the ledger itself follows the customer's retention policy.

## 5. Article 32 — Security of processing

| Measure                     | Implementation                                                                                                                               |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Encryption in transit       | TLS 1.3 mandatory; HSTS with preload; cipher list restricted to AEAD suites.                                                                 |
| Encryption at rest          | AES-256-GCM for field-level encryption; disk-level encryption at the storage layer is the customer's (or hosting provider's) responsibility. |
| Integrity                   | Every record is signed; chain verification is offline-capable; receipts are issued by a hardware-backed key.                                 |
| Pseudonymisation            | Field-level encryption with per-project keys provides pseudonymisation under Recital 28.                                                     |
| Availability and resilience | Multi-AZ Postgres; documented RPO of 15 minutes and RTO of 4 hours; quarterly restore drills.                                                |
| Access control              | OIDC/OAuth2 for humans, scoped API keys for machines, MFA enforced for the SaaS variant, RBAC at the project level.                          |
| Audit log                   | Every state-changing action is recorded on the ledger; the ledger itself is the audit log.                                                   |
| Rate limiting               | Per-tenant and per-endpoint quotas; burst protection on authentication endpoints.                                                            |
| Vulnerability management    | Dependencies scanned daily; CVEs triaged within one business day.                                                                            |
| Personnel                   | Background checks for staff with production access; annual security training; access reviews quarterly.                                      |

## 6. Article 33 — Breach notification

Veritrail will notify the customer of a personal data breach affecting their data
without undue delay and in any case within **72 hours** of becoming aware of it. The
notification will include, to the extent known at the time:

- The nature of the breach, including the categories and approximate number of data
  subjects and records concerned
- The likely consequences
- The measures taken or proposed to address the breach and to mitigate adverse effects
- The name and contact details of Veritrail's DPO or designated contact

Customers are responsible for onward notification to the lead supervisory authority
under Article 33 and, where required, to affected data subjects under Article 34.

Path:

1. Veritrail security on-call detects or is notified of a suspected incident.
2. Incident response runbook (`docs/runbooks/incident-response.md`) is triggered.
3. Within 24 hours of confirmation: initial notification to affected customers via
   the contact channel of record.
4. Within 72 hours of confirmation: written breach notification meeting Article 33(3).
5. Post-incident report with corrective actions within 30 days.

## 7. Where Veritrail is a processor

**Self-hosted.** Veritrail runs entirely inside the customer's infrastructure. No
personal data leaves the customer's environment to reach Veritrail. Veritrail is the
software provider, not a processor. A standard software licence covers the
relationship; no DPA is required from Veritrail.

**SaaS.** Veritrail operates the platform on the customer's behalf. Personal data
the customer uploads is processed by Veritrail under Article 28 instructions. In this
mode Veritrail is the customer's processor, and — because the customer's end users
are the underlying data subjects — Veritrail is functionally a _sub-processor_ of the
customer's data subjects' personal data. The DPA in `data-processing.md` reflects
this.

| Question                                       | Self-hosted                | SaaS                                      |
| ---------------------------------------------- | -------------------------- | ----------------------------------------- |
| Does Veritrail process customer personal data? | No                         | Yes                                       |
| Is a DPA required?                             | No (software licence only) | Yes                                       |
| Are sub-processors involved?                   | None on Veritrail's side   | Yes — see §8                              |
| Cross-border transfer mechanism?               | Customer's responsibility  | SCCs Module Two, plus TIAs where required |

## 8. Sub-processors (SaaS variant)

The current list of sub-processors. This is a template; the live list is published at
`/legal/subprocessors` and changes are notified to customers at least 30 days in
advance.

| Sub-processor                                   | Purpose                                         | Location of processing                 | Transfer mechanism                   |
| ----------------------------------------------- | ----------------------------------------------- | -------------------------------------- | ------------------------------------ |
| Postgres host (e.g., managed database provider) | Primary data store                              | EU (Frankfurt) by default; US optional | SCCs Module Three if outside the EEA |
| Stripe                                          | Subscription billing and invoicing              | EU and US                              | SCCs Module Two                      |
| Resend                                          | Transactional email (receipts, alerts, invites) | EU and US                              | SCCs Module Two                      |

The customer is notified by email and by an entry on the sub-processor page at least
30 days before a new sub-processor begins processing customer personal data. The
customer may object in writing; if the objection cannot be resolved, the customer may
terminate the affected subscription on written notice.

## 9. Contact

For data protection enquiries, exercise of rights, or breach notifications:

- Email: `privacy@veritrail.example` (replace with the live address in production)
- Postal: as set out in the Master Services Agreement
- DPO: contact on the privacy page

## 10. References

- Regulation (EU) 2016/679 (GDPR)
- EDPB Guidelines on the right to erasure
- EDPB Recommendations 01/2020 on transfers (TIAs)
- `docs/adr/0005-field-level-encryption.md`
- `packages/core/src/crypto/field-cipher.ts`
- `soc2.md` — SOC 2 readiness map
- `data-processing.md` — DPA template

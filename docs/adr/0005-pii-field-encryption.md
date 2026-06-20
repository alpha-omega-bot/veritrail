# ADR 0005: Field-level encryption and cryptographic erasure for PII

- **Status:** Accepted
- **Date:** 2026-06-20
- **Deciders:** Veritrail engineering

## Context

The ledger is append-only and tamper-evident: no code path may mutate or delete a
committed record, and the hashed core is `{ seq, id, timestamp, event, prevHash }`
([ADR-0001](./0001-single-ledger-spine.md)). That is exactly the property a
governance system needs — and exactly what makes "delete a user's personal data"
hard. Privacy regimes (GDPR erasure, retention limits) require that PII can be
rendered unrecoverable on request, but we cannot rewrite history to do it.

Veritrail already redacts at the append boundary: `EventRedactor.redact(event)`
runs before hashing/signing, and `PathEventRedactor` replaces configured fields
with a constant (`[REDACTED]`). That removes PII that should _never_ be stored.
It does not cover the case where a field must be **stored and usable for a time,
then provably erased** — redaction is all-or-nothing and irreversible at write
time.

## Decision

Add **field-level encryption at the append boundary** and erase by **destroying
keys** (cryptographic erasure / crypto-shredding), never by mutating records.

1. **Key custody is a port.** `FieldCipher` is an interface:
   `encrypt(plaintext) → token`, `decrypt(token) → Result<plaintext>`, and a
   stable `keyId`. The reference adapter `AesGcmKeyring` holds named AES-256-GCM
   keys in memory and additionally exposes `eraseKey(keyId)`. Production
   deployments implement `FieldCipher` over a KMS/HSM, where erasure is "schedule
   key deletion." Keys live **outside** the ledger.

2. **Encryption runs before hashing.** `EncryptingEventRedactor` implements the
   existing `EventRedactor` interface, configured with dot-path rules and a
   cipher. At append it replaces each targeted **string** field with a compact
   string token `enc.v1.<keyId>.<iv>.<ciphertext>.<tag>` (base64url parts). Because
   the redactor runs before hashing, the **ciphertext is what is hashed and
   signed** — the plaintext never enters the committed record.

3. **Erasure preserves the chain.** To erase, destroy the key (`eraseKey`, or KMS
   deletion). The record bytes are unchanged, so `verifyChain` stays green and the
   chain remains linear and tamper-evident; only the ability to recover the
   plaintext is gone. Decryption of a token whose key has been erased returns a
   `NOT_FOUND` `Result`, never throws.

4. **Reading.** `decryptEventFields(event, cipher, paths)` walks the same paths and
   replaces tokens with recovered plaintext for authorized readers. Tokens carry
   their `keyId`, so a keyring can decrypt across rotations until a key is erased.

Tokens are strings, so an encrypted field stays schema-valid wherever a string is
valid (the common PII shape: email, name, free text). Encrypting a field whose
schema demands a non-string or a constrained string (e.g. an id) is unsupported —
the re-validation after redaction will reject it, exactly as it does for
`PathEventRedactor` replacements today.

## Consequences

### Positive

- **Right-to-erasure without rewriting history.** Destroying a key crypto-shreds
  the field; the ledger stays append-only and `verify()` still passes. This is the
  only erasure model compatible with a tamper-evident chain.
- **Reuses the existing boundary.** `EncryptingEventRedactor` is just another
  `EventRedactor`; no change to `Ledger.append`'s contract.
- **Key custody stays a port**, so KMS/HSM-backed keys and managed deletion drop
  in without touching the core, mirroring the `Signer` design.
- **Granular erasure.** Choosing the `keyId` per subject/tenant lets one key (and
  thus one subject's data across many records) be erased independently.

### Negative / costs

- **Encrypted fields are opaque to projections.** A field encrypted at write time
  cannot be queried/aggregated by the ledger; encrypt only what must be erasable.
- **Key management is now load-bearing.** Losing a key erases data; leaking one
  defeats the protection. That is inherent to crypto-erasure and is why custody is
  a port pointed at real KMS/HSM in production.
- **String-token constraint.** Only fields whose schema accepts a string can be
  encrypted in place. Non-string PII must be modeled as a string field or
  redacted instead.
- **Retention is policy, not yet automation.** This change provides the
  _mechanism_ (erasable fields); scheduled retention/erasure jobs that call
  `eraseKey` on a timetable remain operator-driven (runbook), with automation a
  later increment.

## Alternatives considered

1. **Delete or overwrite the record.** Rejected outright: violates the
   append-only, tamper-evident invariant — the product's foundation.
2. **Encrypt the whole event/record.** Rejected: defeats audit/forensics
   projections entirely and makes integrity opaque. Field-level keeps non-PII
   columns queryable and the chain verifiable.
3. **Tokenize via an external PII vault** (store a token, keep PII in a separate
   mutable store). Rejected as the default: re-introduces a parallel source of
   truth and an external dependency for a library that aims to be self-hostable.
   A `FieldCipher` over a vault remains implementable behind the port.
4. **Encrypt after hashing (store plaintext-hash + ciphertext).** Rejected:
   hashing the plaintext would leave a verifiable fingerprint of the erased data,
   undermining erasure. Hashing the ciphertext is what makes shredding complete.

# PII Redaction Runbook

Veritrail can redact configured event fields before a ledger record is hashed,
signed, and persisted. Redaction is an append-boundary control: it affects new
records only and never mutates existing ledger history.

## When to Use It

Configure redaction for fields that may contain secrets, personal data, access
tokens, prompts, tool responses, or vendor metadata that should not become part
of the tamper-evident record.

Redaction is not a replacement for minimizing payloads at the source. Prefer
recording stable references and hashes over raw sensitive content.

## Configure a Path Redactor

`PathEventRedactor` applies dot-path rules to the validated event object. Use
`*` to match one object or array segment.

```ts
import { PathEventRedactor, createFileLedger } from '@veritrail/core';

const ledger = createFileLedger('/var/lib/veritrail/ledger.jsonl', {
  redactor: new PathEventRedactor([
    { path: 'payload.result.email' },
    { path: 'payload.result.tokens.*.secret', replacement: null },
    { path: 'labels.customerEmail' },
  ]),
});
```

Rules that do not match are no-ops. A missing field should not block appends
because event payloads vary by type and source system.

## Append Behavior

`Ledger.append()` handles redaction in this order:

1. Validate the caller input with `EventInputSchema`.
2. Apply the configured `EventRedactor`.
3. Validate the redacted event with `EventInputSchema` again.
4. Assign sequence, id, timestamp, and previous hash.
5. Hash, sign, and persist the redacted event.

If the redactor throws, `append()` returns `STORAGE` and does not persist a
record. If the redactor returns an event that no longer matches the schema,
`append()` returns `VALIDATION` and does not persist a record.

## Verification

Integrity verification covers the redacted record exactly as persisted. The
unredacted value is not recoverable from the ledger unless it was also stored in
another field or external system.

After changing rules:

1. Append a representative test event in a non-production environment.
2. Confirm the sensitive fields are replaced in the stored record.
3. Run `ledger.verify()` or the audit module integrity check.
4. Publish a fresh external anchor if anchoring is enabled.

## Field-Level Encryption and Cryptographic Erasure

When a field must be **stored and usable for a time, then provably erased** (e.g.
right-to-erasure requests), redaction's all-or-nothing blanking is not enough.
`EncryptingEventRedactor` encrypts configured string fields at the same append
boundary, so only ciphertext is hashed and signed. Erasure is then a matter of
destroying the key — the ledger records are never mutated and `verify()` keeps
passing. See [ADR-0005](../adr/0005-pii-field-encryption.md).

```ts
import { AesGcmKeyring, EncryptingEventRedactor, createFileLedger } from '@veritrail/core';

// In production, implement FieldCipher over a KMS/HSM instead of an in-memory ring.
const keyring = new AesGcmKeyring({ 'subject-42': process.env.SUBJECT_42_KEY! }, 'subject-42');

const ledger = createFileLedger('/var/lib/veritrail/ledger.jsonl', {
  redactor: new EncryptingEventRedactor(keyring, [
    'payload.result.email',
    'payload.result.notes.*',
  ]),
});
```

- Encrypted fields become opaque tokens (`enc.v1.<keyId>.…`); they cannot be
  queried or aggregated by projections. Encrypt only what must be erasable, and
  pick `keyId` per subject/tenant so one subject's data can be erased
  independently.
- Targeted fields must be strings (the token is a string). Encrypting a
  non-string field leaves it unchanged; the post-redaction schema re-validation
  is the backstop.
- Authorized readers recover plaintext with `decryptEventFields(event, cipher,
paths)`. A token whose key was erased surfaces as `[ERASED]`.

### Erasing a Subject's Data

1. Identify the `keyId` used for that subject's encrypted fields.
2. Call `keyring.eraseKey(keyId)` (or schedule key deletion in your KMS).
3. Confirm `decryptEventFields` now returns `[ERASED]` for those fields and that
   `ledger.verify()` still reports `ok: true` — erasure must not break the chain.
4. Re-publish an external anchor if anchoring is enabled; the head is unchanged,
   but record that the erasure occurred in your operational log.

Retention schedules that call `eraseKey` on a timetable are operator-driven for
now; automated retention/erasure jobs are a later increment.

## Remaining Deployment Controls

Append-boundary redaction and encryption protect the record contents. Still
protect the underlying event store with normal deployment controls: disk
encryption, restrictive file/database grants, backup access control, and log
redaction in surrounding infrastructure.

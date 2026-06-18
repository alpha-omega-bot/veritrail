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

## Remaining Controls

Append-boundary redaction is the first PII control. Field-level encryption,
configurable retention, and cryptographic erasure are still separate Milestone 1
work. Until those ship, protect the underlying event store with normal
deployment controls such as disk encryption, restrictive file/database grants,
backups access control, and log redaction in surrounding infrastructure.

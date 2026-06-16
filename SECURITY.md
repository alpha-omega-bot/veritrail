# Security Policy

Veritrail is security infrastructure: it is the system of record teams rely on to
know what their agents did. We hold its own security to a correspondingly high bar.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately via
[GitHub Security Advisories](https://github.com/veritrail/veritrail/security/advisories/new),
or email `security@veritrail.dev` (PGP key available on request).

Please include:

- A description of the issue and its impact.
- Steps to reproduce or a proof of concept.
- Affected version(s) / commit, and any relevant configuration.

We aim to acknowledge within **3 business days**, provide an initial assessment
within **7 days**, and coordinate a fix and disclosure timeline with you. We
credit reporters who wish to be acknowledged.

## Supported versions

Veritrail is pre-1.0. Security fixes target the latest `main` and the most recent
tagged release. Pin a version and watch releases for advisories.

## Security model (what Veritrail does and does not guarantee)

### Guarantees

- **Tamper-evidence.** The ledger is append-only and hash-chained. Any mutation,
  insertion, or deletion of history is detectable by `verify()`. A single altered
  record surfaces as one `hash_mismatch`; a re-hashed record surfaces as a
  downstream `chain_break`; a removed record surfaces as a `seq_gap`.
- **Forgery-resistance (optional).** With a configured `Signer`, every record is
  signed; forging or rewriting records requires the signing key.
- **Validation at the boundary.** All events and inputs are validated with Zod
  before they are accepted; strict schemas reject unknown fields.
- **Safe defaults.** Permissions deny when no policy matches; budgets hard-stop at
  their limit; the ledger is tamper-evident with no configuration.

### Limitations (be aware)

- **An unsigned chain can be wholly rewritten.** A fully recomputed unsigned chain
  is internally consistent. To detect wholesale rewrites, enable signing or compare
  the chain head against an **external anchor** (Milestone 1). Document and monitor
  your anchor.
- **Confidentiality is not yet built in.** v0.1 does not encrypt event payloads or
  redact PII at rest. Do not place secrets/PII in event payloads until field-level
  redaction/encryption lands (Milestone 1). Protect the ledger file/store with
  OS- and storage-level controls.
- **No authN/authZ in the server yet.** The v0.1 server is unauthenticated and
  intended for trusted networks / local use. Do not expose it publicly until
  Milestone 1 auth lands.
- **HMAC signing uses a shared secret.** Verifiers hold the key; use the planned
  asymmetric (Ed25519/KMS) signer for untrusted-verifier scenarios.

## Hardening guidance

- Run the server behind your own authenticated gateway until native auth ships.
- Store the ledger on append-friendly, access-controlled storage; back it up.
- Enable a `Signer` and persist `signerKeyId`; rotate keys deliberately.
- Treat `pnpm verify` and the CI ledger-integrity gate as required checks.
- Keep dependencies current (Dependabot is configured) and review CodeQL alerts.

## Supply chain

- Reproducible installs via a committed lockfile and `--frozen-lockfile` in CI.
- Minimal, well-known runtime dependencies (core depends only on `zod`).
- `CODEOWNERS` requires core-team review for changes to the ledger and core.

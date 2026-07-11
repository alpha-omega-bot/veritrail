# SaaS Operations Runbook

Operational guide for engineers running the Veritrail hosted SaaS.

## Architecture overview

```
                  +-------------------+
                  |   marketing site  |  (apps/marketing — static)
                  +---------+---------+
                            |
                            v
   +----------+      +-------------+      +-------------+
   |  status  |<-----|   console   |----->|   server    |
   | (public) |      | (apps/      |      | (Fastify;   |
   +----------+      |  console)   |      |  ledger,    |
                     +------+------+      |  control    |
                            |             |  plane,     |
                            | API calls   |  webhooks   |
                            +------------>|  outbox)    |
                                          +------+------+
                                                 |
                                       outbox    |
                                                 v
                                        +-----------------+
                                        | webhook worker  |
                                        | (poll + signed  |
                                        |  HTTPS POST)    |
                                        +-----------------+
```

Components:

- **server** (`packages/server`) — Fastify app. Exposes the public Veritrail API,
  embeds the append-only ledger, and mounts the control plane and webhook
  outbox writers when control-plane mode is on.
- **control plane** (`packages/control-plane`) — orgs, members, API keys,
  quotas, usage, billing, invites. Lives in-process with the server when
  `VERITRAIL_CONTROL_PLANE=1`.
- **webhook worker** (`packages/webhook-worker`) — separate process that
  polls the outbox, signs payloads, and delivers them to subscribers.
- **console** (`apps/console`) — operator + tenant UI (Cloudscape).
- **marketing** (`apps/marketing`) — public-facing site.
- **status** (`apps/status`) — public component-health page.

## Environment variables

The server reads only `process.env`. All values are strings.

| Name                                         | Description                                                                             | Example                                                      | Required                                     |
| -------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------- |
| `PORT`                                       | TCP port to bind.                                                                       | `8787`                                                       | No (default `8787`)                          |
| `HOST`                                       | Bind address.                                                                           | `0.0.0.0`                                                    | No (default `0.0.0.0`)                       |
| `VERITRAIL_LEDGER_FILE`                      | Path to the on-disk append-only ledger. Omit for in-memory (tests only).                | `/var/lib/veritrail/ledger.jsonl`                            | No, but required for any non-test deployment |
| `VERITRAIL_SIGNER_SECRET`                    | HMAC secret used to sign ledger records. Rotate via a coordinated re-sign.              | `base64:9f...`                                               | Recommended in production                    |
| `VERITRAIL_API_KEYS`                         | Comma-separated `id:secret:role:scope` API-key entries. Parsed by `parseApiKeyEntries`. | `prod:s3cret:writer:*`                                       | Either this or OIDC                          |
| `VERITRAIL_OIDC_ISSUER`                      | Issuer URL of the IdP.                                                                  | `https://login.example.com`                                  | If using OIDC                                |
| `VERITRAIL_OIDC_AUDIENCE`                    | Comma-separated audience values.                                                        | `veritrail-prod`                                             | If using OIDC                                |
| `VERITRAIL_OIDC_JWKS`                        | Inline JWKS JSON.                                                                       | `{"keys":[...]}`                                             | One of JWKS / JWKS_URL / DISCOVERY_URL       |
| `VERITRAIL_OIDC_JWKS_URL`                    | Direct JWKS endpoint.                                                                   | `https://login.example.com/.well-known/jwks.json`            | One of JWKS / JWKS_URL / DISCOVERY_URL       |
| `VERITRAIL_OIDC_DISCOVERY_URL`               | OIDC discovery doc.                                                                     | `https://login.example.com/.well-known/openid-configuration` | One of JWKS / JWKS_URL / DISCOVERY_URL       |
| `VERITRAIL_OIDC_JWKS_CACHE_TTL_MS`           | JWKS cache TTL.                                                                         | `600000`                                                     | No                                           |
| `VERITRAIL_OIDC_ACTOR_CLAIM`                 | Claim used as actor id.                                                                 | `sub`                                                        | No                                           |
| `VERITRAIL_OIDC_ROLES_CLAIM`                 | Claim carrying roles.                                                                   | `roles`                                                      | No                                           |
| `VERITRAIL_OIDC_SCOPES_CLAIM`                | Claim carrying scopes.                                                                  | `scope`                                                      | No                                           |
| `VERITRAIL_OIDC_LABEL_SCOPE_CLAIM`           | Claim carrying per-label scopes.                                                        | `vt_labels`                                                  | No                                           |
| `VERITRAIL_OIDC_DEFAULT_ROLES`               | Roles assigned when the roles claim is absent.                                          | `reader`                                                     | No                                           |
| `VERITRAIL_OIDC_DEFAULT_SCOPES`              | Scopes assigned when the scopes claim is absent.                                        | `read`                                                       | No                                           |
| `VERITRAIL_OIDC_ROLE_MAPPINGS`               | `external=veritrail` pairs.                                                             | `eng=writer,sec=admin`                                       | No                                           |
| `VERITRAIL_OIDC_SCOPE_MAPPINGS`              | `external=veritrail` pairs.                                                             | `r=read,w=write`                                             | No                                           |
| `VERITRAIL_OIDC_CLOCK_SKEW_SECONDS`          | Allowed clock skew.                                                                     | `60`                                                         | No                                           |
| `VERITRAIL_ADMIN_ACTION_SIGNING_SECRET`      | HMAC secret for signed admin actions. Requires API-key or OIDC auth.                    | `base64:...`                                                 | No                                           |
| `VERITRAIL_ADMIN_ACTION_SIGNING_KEY_ID`      | Key id sent with signed admin actions.                                                  | `kid-2026-q2`                                                | No                                           |
| `VERITRAIL_ADMIN_ACTION_SIGNING_MAX_SKEW_MS` | Max skew for admin-action signatures.                                                   | `30000`                                                      | No                                           |
| `VERITRAIL_RATE_LIMIT_MAX`                   | Max requests per window. `0` disables.                                                  | `120`                                                        | No (default 120)                             |
| `VERITRAIL_RATE_LIMIT_WINDOW_MS`             | Rate-limit window in ms.                                                                | `60000`                                                      | No (default 60000)                           |
| `VERITRAIL_BODY_LIMIT_BYTES`                 | Max request body size.                                                                  | `1048576`                                                    | No                                           |
| `VERITRAIL_MAX_IN_FLIGHT_WRITES`             | Concurrency cap on writes. `0` disables.                                                | `64`                                                         | No                                           |
| `VERITRAIL_CONTROL_PLANE`                    | Set to `1` to enable orgs/quotas/billing.                                               | `1`                                                          | Required for SaaS                            |
| `VERITRAIL_CONSOLE_URL`                      | Console origin used in emails and redirects.                                            | `https://console.veritrail.io`                               | No (default `http://localhost:5173`)         |
| `RESEND_API_KEY`                             | Resend API key. Without it, emails are skipped.                                         | `re_...`                                                     | No (recommended for prod)                    |
| `RESEND_FROM_EMAIL`                          | From address for transactional mail.                                                    | `noreply@veritrail.io`                                       | No (default `noreply@veritrail.io`)          |
| `STRIPE_WEBHOOK_SECRET`                      | Stripe webhook signing secret. Without it, the Stripe handler is not mounted.           | `whsec_...`                                                  | Required for billing                         |
| `STRIPE_PRICE_IDS`                           | `tier=price_id` pairs for `starter`, `pro`, `enterprise`, `free`.                       | `starter=price_abc,pro=price_def`                            | Required for billing                         |

## Bootstrap

Local SaaS-mode boot (server + console):

```bash
export VERITRAIL_CONTROL_PLANE=1
export VERITRAIL_LEDGER_FILE=./.data/ledger.jsonl
export VERITRAIL_SIGNER_SECRET=$(openssl rand -base64 32)
export VERITRAIL_CONSOLE_URL=http://localhost:5173

# Optional billing
# export STRIPE_WEBHOOK_SECRET=whsec_...
# export STRIPE_PRICE_IDS=starter=price_abc,pro=price_def,enterprise=price_xyz

# Optional email
# export RESEND_API_KEY=re_...
# export RESEND_FROM_EMAIL=noreply@veritrail.io

pnpm install
pnpm --filter @veritrail/server start
```

In a second shell:

```bash
pnpm --filter @veritrail/console dev
```

The console connects to the server at the URL configured in `apps/console/src/api.ts`.

## Onboarding a new customer (manual)

When self-serve sign-up is not yet wired or a support engineer needs to
provision an account by hand:

1. Confirm the requested tier (`free`, `starter`, `pro`, `enterprise`).
2. Create the org via the operator console (Orgs view) or the control-plane
   admin route. Capture the returned `orgId`.
3. Add the primary owner as a member with the `owner` role.
4. Assign the tier; the control plane will apply the matching quota.
5. If billing is required, create or attach the Stripe customer and ensure
   the `STRIPE_PRICE_IDS` map covers their tier.
6. Issue an API key in the API Keys view; deliver the secret out-of-band.
7. Send the invite email (Resend) and verify delivery.
8. Spot-check by issuing a sample ingest call from the customer's key.

## Webhook delivery operational notes

The webhook worker (`packages/webhook-worker`) is a separate long-running
process. It polls the outbox on a fixed interval and posts signed payloads
to each subscriber:

- Poll interval: `pollIntervalMs`, default **5000 ms**.
- Batch size: `batchSize`, default **50 entries** per poll.
- Backoff: exponential, `base = 1s`, `factor = 2`, cap **24h**, with ±20%
  deterministic jitter (see `nextAttemptDelay` in
  `packages/webhook-worker/src/retry.ts`). Attempt 1 ≈ 1s, 2 ≈ 2s, 3 ≈ 4s,
  17 ≈ 24h.
- Max attempts: `maxAttempts`, default **16** (≈ 24h of retries before the
  entry is marked permanently failed).
- 2xx → delivered. 4xx → permanently failed (no retry). 5xx or network
  error → retried until `maxAttempts`.

Operational checks:

```bash
# Inspect outbox depth and failed-entry count from the control-plane store.
# Alert when failed-entry count grows steadily; that signals a bad subscriber
# URL or a signing-secret mismatch.
```

## Failure modes and remedies

### Stripe webhook signature failures

Symptom: server logs `stripe webhook signature verification failed` and
returns 400 to Stripe.

Causes and fixes:

- `STRIPE_WEBHOOK_SECRET` does not match the endpoint secret in the Stripe
  dashboard. Rotate the secret in the dashboard, update the env var, and
  restart the server.
- A reverse proxy is rewriting the request body. The raw body must reach
  the handler unmodified — disable body buffering or response transforms
  in front of `/webhooks/stripe`.
- Clock skew on the server is large. Sync NTP.

### Resend deliverability issues

Symptom: invites or notifications do not arrive; server logs Resend errors.

Checks:

- `RESEND_API_KEY` is present and not revoked.
- `RESEND_FROM_EMAIL` is on a verified Resend domain with SPF/DKIM.
- Check the Resend dashboard for bounces or suppression-list hits.
- If Resend is degraded, the server continues to operate; emails are
  retried on the next user-initiated action. There is no built-in
  email-only retry queue.

### Ledger integrity check failures

Symptom: startup or a scheduled verifier reports a chain-hash mismatch on
the ledger file.

Steps:

1. Stop the server. Do **not** restart blindly — a running server will
   append on top of a corrupt tail.
2. Take a copy of the current `VERITRAIL_LEDGER_FILE` (forensic snapshot).
3. Restore from the most recent verified backup (see Backup and restore).
4. Compare the restored head against an external anchor checkpoint if
   anchoring is configured (`docs/runbooks/external-anchoring.md`).
5. Investigate writes between the last good anchor and the failure; replay
   them against the restored ledger only after the chain is reconciled.

### Quota near-cap warnings

Symptom: an org is approaching its tier limit; the control plane emits
near-cap usage events.

Remedies:

- Confirm the spike is real via the Usage view in the console.
- Offer an in-tier burst or a tier upgrade. Update Stripe and reassign the
  tier; the new quota applies on the next usage flush.
- If the cause is misuse, suspend the offending API key from the API Keys
  view and contact the customer.

## Backup and restore

Backups use `scripts/backup-ledger.ts`. The script gzips the ledger and
optionally AES-256-CBC encrypts it with a passphrase from
`VERITRAIL_BACKUP_PASSPHRASE`, then writes a sidecar `.meta` file with the
salt, IV, algorithm, and timestamps.

```bash
export VERITRAIL_BACKUP_PASSPHRASE='<strong-passphrase>'
pnpm exec tsx scripts/backup-ledger.ts \
  /var/lib/veritrail/ledger.jsonl \
  /var/backups/veritrail/ledger-$(date -u +%Y%m%dT%H%M%SZ).jsonl.gz.enc
```

Flags: `--no-encrypt` for plain gzip (only for short-lived local copies);
`--no-verify` to skip post-write integrity checks.

Cadence: hourly snapshots retained 7 days; daily snapshots retained 90
days; offsite copy retained per the compliance policy.

Restore uses the companion `scripts/restore-ledger.ts` (same directory).
Always restore into a staging path and verify the ledger before swapping
it in for the live `VERITRAIL_LEDGER_FILE`.

## Upgrade procedure

1. Announce the maintenance window on the status page.
2. Snapshot the ledger (see Backup and restore).
3. Pull the new release:

   ```bash
   git fetch --tags
   git checkout v<release>
   pnpm install
   pnpm run build
   ```

4. Run any release-specific migration noted in the release notes.
5. Restart the server and webhook worker:

   ```bash
   systemctl restart veritrail-server
   systemctl restart veritrail-webhook-worker
   ```

6. Verify `/healthz` returns 200, the ledger head advances on a smoke
   write, and the console loads against the new build.
7. Close the maintenance window on the status page.

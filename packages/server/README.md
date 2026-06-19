# @veritrail/server

Fastify REST API mounting Veritrail's governance engines over one shared ledger.

## Auth

By default `buildServer()` keeps the local-development behavior: routes are
unauthenticated unless an `auth` config is provided. Production deployments
should configure API keys.

```ts
import { buildServer } from '@veritrail/server';

const app = await buildServer({
  auth: {
    apiKeys: [
      {
        id: 'operator-key',
        actorId: 'operator-1',
        secret: process.env.VERITRAIL_OPERATOR_KEY!,
        roles: ['operator'],
      },
      {
        id: 'admin-key',
        actorId: 'admin-1',
        secret: process.env.VERITRAIL_ADMIN_KEY!,
        roles: ['admin'],
      },
    ],
  },
});
```

Clients send either `Authorization: Bearer <secret>` or
`x-veritrail-api-key: <secret>`.

Roles:

- `ingest` — append events and record agent-produced facts.
- `operator` — read audit/projection APIs and plan operational workflows.
- `admin` — mutate server-held configuration such as policies and budgets;
  `admin` also satisfies lower-privilege route checks.

Operator keys may also include optional route scopes to narrow access after the
role check succeeds. Omitting `scopes` preserves the role-only behavior. Admin
keys satisfy all scopes.

```ts
const app = await buildServer({
  auth: {
    apiKeys: [
      {
        id: 'audit-reader',
        actorId: 'operator-1',
        secret: process.env.VERITRAIL_AUDIT_KEY!,
        roles: ['operator'],
        scopes: ['audit:read'],
      },
    ],
  },
});
```

Supported scopes: `audit:read`, `permissions:read`, `spend:read`,
`decisions:read`, `evidence:read`, `vendor-risk:read`, `forensics:read`,
`rollback:read`, `rollback:execute`.

API keys may also include `labelScope` to constrain raw ledger event writes and
raw ledger-query reads by exact event labels. Scoped writes to `/api/events` must
include the configured labels. Scoped reads on `/api/audit/events` and
`/api/forensics/timeline` force those labels onto the query before `limit` is
applied; `/api/audit/events/:seq` hides records outside the scope. Spend charges
from scoped ingest keys must also carry the configured labels. Whole-chain,
whole-spend, or graph-reconstruction endpoints such as audit summary/verify/export,
spend budgets/status, and forensics incident/cause-chain require an unscoped
operator/admin key.

```ts
const app = await buildServer({
  auth: {
    apiKeys: [
      {
        id: 'tenant-audit',
        actorId: 'operator-1',
        secret: process.env.VERITRAIL_TENANT_KEY!,
        roles: ['operator'],
        scopes: ['audit:read'],
        labelScope: { tenant: 'acme', project: 'alpha' },
      },
    ],
  },
});
```

OIDC bearer JWTs can be enabled alongside API keys or as the only credential
source. The built-in verifier is dependency-light and validates RS256 compact
JWTs against a configured issuer, audience, and JWKS. A static JWKS can be used
alone for fixed keys or as the initial cache/fallback for a remote JWKS endpoint.
`jwksUrl` and `discoveryUrl` enable key refresh without adding provider SDK
dependencies; fetched documents are validated before use, unknown `kid` values
trigger refresh, and cached matching keys remain usable during issuer outages.
Valid tokens are mapped into the same Veritrail principal model used by API keys,
so route roles, route scopes, and label scopes are enforced consistently.

```ts
const app = await buildServer({
  auth: {
    oidc: {
      issuer: 'https://idp.example.com/',
      audience: 'veritrail-server',
      jwks: JSON.parse(process.env.VERITRAIL_OIDC_JWKS!),
      jwksUrl: 'https://idp.example.com/.well-known/jwks.json',
      rolesClaim: 'groups',
      scopesClaim: 'veritrail_scopes',
      labelScopeClaim: 'veritrail_labels',
      roleMappings: { 'veritrail-operators': 'operator' },
    },
  },
});
```

OIDC tokens should carry either Veritrail-native roles/scopes or external claim
values mapped with `roleMappings` / `scopeMappings`. Unlike legacy scope-free API
keys, OIDC principals only receive configured or claim-derived scopes.

Remote JWKS refresh uses a five-minute cache TTL by default. Set
`jwksCacheTtlMs` to tune that interval, or provide `discoveryUrl` to resolve
`jwks_uri` from an OIDC discovery document. The discovery document's `issuer`,
when present, must match the configured issuer.

Administrative policy and budget changes append `admin.action` facts to the same
ledger for operator audit.

Deployments can additionally require signed administrative mutation requests.
When `auth.adminActionSigning` is configured, policy and budget write routes
require these headers before server-held configuration changes:

- `x-veritrail-admin-key-id`
- `x-veritrail-admin-timestamp` (epoch milliseconds)
- `x-veritrail-admin-nonce`
- `x-veritrail-admin-signature` (hex HMAC-SHA256)

The signature is HMAC-SHA256 over canonical JSON containing:
`algorithm`, `keyId`, `timestamp`, `nonce`, uppercase `method`, request `path`,
and the canonical JSON SHA-256 `bodyHash`. Timestamps must be within the
configured freshness window and nonces cannot be reused within that window.
Successful admin mutations record the verified signature receipt in the emitted
`admin.action` event.

```ts
import { hashJson, asJson } from '@veritrail/core';
import { buildServer, signAdminAction } from '@veritrail/server';

const receipt = {
  keyId: 'admin-action',
  timestamp: Date.now(),
  nonce: crypto.randomUUID(),
  method: 'POST',
  path: '/api/permissions/policies',
  bodyHash: hashJson(asJson(policyBody)),
  algorithm: 'hmac-sha256' as const,
};

const signature = signAdminAction(process.env.VERITRAIL_ADMIN_ACTION_SIGNING_SECRET!, receipt);

const app = await buildServer({
  auth: {
    adminActionSigning: {
      secret: process.env.VERITRAIL_ADMIN_ACTION_SIGNING_SECRET!,
      keyId: 'admin-action',
    },
    apiKeys: [
      {
        id: 'admin-key',
        actorId: 'admin-1',
        secret: process.env.VERITRAIL_ADMIN_KEY!,
        roles: ['admin'],
      },
    ],
  },
});
```

The `veritrail-server` binary accepts `VERITRAIL_API_KEYS` as a comma-separated
list of `id:actorId:secret:role1|role2[:scope1|scope2[;labels=k=v|k2=v2]]`
entries. For example,
`audit:operator-1:$SECRET:operator:audit:read|rollback:execute;labels=tenant=acme|project=alpha`
creates an operator key restricted to audit reads, rollback execution, and the
`tenant=acme` / `project=alpha` event-label scope. Invalid role, scope, or label
tokens are rejected at startup.

The binary also accepts:

- `VERITRAIL_ADMIN_ACTION_SIGNING_SECRET`
- `VERITRAIL_ADMIN_ACTION_SIGNING_KEY_ID` (default `admin-action`)
- `VERITRAIL_ADMIN_ACTION_SIGNING_MAX_SKEW_MS` (default 5 minutes)
- `VERITRAIL_OIDC_ISSUER`
- `VERITRAIL_OIDC_AUDIENCE` (comma-separated accepted audiences)
- `VERITRAIL_OIDC_JWKS` (optional JSON object with `keys`, currently RS256
  public keys)
- `VERITRAIL_OIDC_JWKS_URL`
- `VERITRAIL_OIDC_DISCOVERY_URL`
- `VERITRAIL_OIDC_JWKS_CACHE_TTL_MS` (default 5 minutes)
- `VERITRAIL_OIDC_ACTOR_CLAIM` (default `sub`)
- `VERITRAIL_OIDC_ROLES_CLAIM`
- `VERITRAIL_OIDC_SCOPES_CLAIM`
- `VERITRAIL_OIDC_LABEL_SCOPE_CLAIM`
- `VERITRAIL_OIDC_DEFAULT_ROLES` / `VERITRAIL_OIDC_DEFAULT_SCOPES`
- `VERITRAIL_OIDC_ROLE_MAPPINGS` / `VERITRAIL_OIDC_SCOPE_MAPPINGS`
  (comma-separated `external=veritrail` pairs)
- `VERITRAIL_OIDC_CLOCK_SKEW_SECONDS` (default 60)

## Limits

`buildServer()` enables defensive request limits by default:

- request body cap: 1 MiB
- fixed-window API rate limit: 600 requests per minute per API key, or per IP
  when unauthenticated
- write-route backpressure: 32 concurrent write handlers

```ts
const app = await buildServer({
  limits: {
    bodyLimitBytes: 512 * 1024,
    rateLimit: { max: 120, windowMs: 60_000 },
    maxInFlightWrites: 16,
  },
});
```

Set `rateLimit: false` or `maxInFlightWrites: false` only for trusted tests or
when an upstream gateway provides equivalent controls. The binary accepts:

- `VERITRAIL_BODY_LIMIT_BYTES`
- `VERITRAIL_RATE_LIMIT_MAX` (`0` disables server-side rate limiting)
- `VERITRAIL_RATE_LIMIT_WINDOW_MS`
- `VERITRAIL_MAX_IN_FLIGHT_WRITES` (`0` disables write backpressure)

Query endpoints that accept `limit` require a non-negative integer. `limit=0`
is valid and returns zero results; negative, fractional, empty, or non-numeric
limits are rejected with `VALIDATION` / HTTP 400 at the server boundary.
Ledger-query endpoints accept exact label filters as `label.<key>=<value>`.

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
applied; `/api/audit/events/:seq` hides records outside the scope. Whole-chain
or graph-reconstruction endpoints such as audit summary/verify/export and
forensics incident/cause-chain require an unscoped operator/admin key.

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

Administrative policy and budget changes append `admin.action` facts to the same
ledger for operator audit.

The `veritrail-server` binary accepts `VERITRAIL_API_KEYS` as a comma-separated
list of `id:actorId:secret:role1|role2[:scope1|scope2[;labels=k=v|k2=v2]]`
entries. For example,
`audit:operator-1:$SECRET:operator:audit:read|rollback:execute;labels=tenant=acme|project=alpha`
creates an operator key restricted to audit reads, rollback execution, and the
`tenant=acme` / `project=alpha` event-label scope. Invalid role, scope, or label
tokens are rejected at startup.

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

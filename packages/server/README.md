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

Administrative policy and budget changes append `admin.action` facts to the same
ledger for operator audit.

The `veritrail-server` binary accepts `VERITRAIL_API_KEYS` as a comma-separated
list of `id:actorId:secret:role1|role2` entries.

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

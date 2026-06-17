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

# Local Preview Runbook

Run the full Veritrail SaaS stack on your laptop in under five minutes: server, console, control plane, and ledger. No external services required.

## Prerequisites

- Node.js `>= 20.11`
- pnpm via corepack (ships with Node)
- Optional: Stripe CLI if you want to exercise the billing webhooks
- Optional: Postgres `>= 14` if you want a durable control plane (otherwise the in-memory store is used and state is lost on restart)

```bash
node --version   # must print v20.11 or newer
corepack enable
```

## Bootstrap

Clone, install, and build the workspace.

```bash
corepack enable && pnpm install && pnpm run build
```

## Run server

Start the Fastify server with the control plane enabled and the ledger written to a temp file.

```bash
VERITRAIL_CONTROL_PLANE=1 \
VERITRAIL_LEDGER_FILE=/tmp/veritrail.jsonl \
pnpm --filter @veritrail/server start
```

The server listens on `http://localhost:8787`.

## Run console

In a second terminal, start the Vite dev server.

```bash
pnpm --filter @veritrail/console dev
```

Vite serves the console on `http://localhost:5173` and proxies `/api` requests to the server on `8787`.

## Open the console

Open `http://localhost:5173` in your browser. You will land on the login page.

## Sign up

Sign up with any email address. Because no email provider is configured, the server prints the magic link to stdout:

```
[magic-link] http://localhost:5173/login/verify?token=...
```

Copy that URL into your browser to complete login.

## Complete onboarding

The onboarding flow creates your first org, first project, and first API key. Copy the API key shown at the end of onboarding — it is only displayed once.

## Send your first event

Replace `vk_live_xxx` with the API key from the previous step.

```bash
curl -X POST http://localhost:8787/api/events \
  -H "Authorization: Bearer vk_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "llm.completion",
    "payload": {"model": "claude-opus-4-7", "prompt": "hello", "completion": "world"}
  }'
```

## View it live

Open the Ledger tab in the console. The new event appears in real time via the SSE stream.

## Enable the OpenAPI extensions

The compliance, simulator, cost-optimizer, and anchor-store extensions are off by default. To turn them on, edit `packages/server/src/main.ts` and pass them to the server factory:

```ts
import { InMemoryAnchorStore } from '@veritrail/core';

await createServer({
  extensions: {
    complianceEnabled: true,
    simulatorEnabled: true,
    costOptimizerEnabled: true,
    anchorStore: new InMemoryAnchorStore(),
  },
});
```

A future env-driven flag will remove the need to edit `main.ts`; until then this is the documented escape hatch.

## Swagger UI

With the server running, browse the live OpenAPI explorer at `http://localhost:8787/api/docs`.

## Cleanup

```bash
rm /tmp/veritrail.jsonl
```

## Troubleshooting

### Port already in use

If `8787` or `5173` is occupied:

```bash
lsof -i :8787
lsof -i :5173
```

Kill the offending process or change the port:

```bash
PORT=8788 VERITRAIL_CONTROL_PLANE=1 VERITRAIL_LEDGER_FILE=/tmp/veritrail.jsonl \
  pnpm --filter @veritrail/server start
```

### Magic link not appearing in stdout

The link is logged at `info` level. If your Fastify log level is set to `warn` or higher it will be suppressed. Force it back on:

```bash
LOG_LEVEL=info VERITRAIL_CONTROL_PLANE=1 VERITRAIL_LEDGER_FILE=/tmp/veritrail.jsonl \
  pnpm --filter @veritrail/server start
```

### Control plane not enabled

If the console shows `control plane disabled` on login, you forgot to set `VERITRAIL_CONTROL_PLANE=1`. The auth, org, project, and API-key routes are only mounted when that flag is present.

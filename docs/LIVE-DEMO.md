# Veritrail Live Demo

A working hosted preview of the Veritrail SaaS, useful for trying the product
without a local install.

> The tunnel URLs below are ephemeral — they change every time the demo server
> restarts. The latest URLs are always documented here.

## Live URLs

| Surface            | URL                                                                         |
| ------------------ | --------------------------------------------------------------------------- |
| Console (SPA)      | <https://trades-antarctica-chelsea-slip.trycloudflare.com>                  |
| API server         | <https://pricing-xbox-thrown-apps.trycloudflare.com>                        |
| Health probe       | <https://pricing-xbox-thrown-apps.trycloudflare.com/api/health>             |
| OpenAPI spec       | <https://pricing-xbox-thrown-apps.trycloudflare.com/api/openapi.json>       |
| Swagger UI         | <https://pricing-xbox-thrown-apps.trycloudflare.com/api/docs>               |
| Prometheus metrics | <https://pricing-xbox-thrown-apps.trycloudflare.com/api/metrics/prometheus> |

The console deep-links into individual views via the hash router, e.g.
`https://…/#/overview`, `#/ledger`, `#/policies`, `#/simulator`,
`#/receipts`, `#/compliance`, `#/webhooks`, `#/billing`.

## Try It

### 1. Sign up via magic link

```bash
API="https://pricing-xbox-thrown-apps.trycloudflare.com"
curl -s -X POST "$API/api/v1/control/magic-link/request" \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com"}'
```

Because the demo server has no email provider configured, the response includes
a `devLink` you can paste into your browser. The link consumes itself and creates
the session.

### 2. Mint an API key

In the console: complete the onboarding wizard. A copy-once modal will reveal
the key, formatted as `vt_live_<prefix>_<random>`.

Or from the command line, after capturing the session token from
`/api/v1/control/magic-link/consume`:

```bash
BEARER="<the session token returned by /consume>"
PROJECT_ID="<currentProjectId from /consume>"
curl -s -X POST "$API/api/v1/control/api-keys/create" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $BEARER" \
  -d "{\"projectId\":\"$PROJECT_ID\",\"label\":\"demo\"}"
```

### 3. Ingest your first event

The minted API key is accepted by the existing `/api/events` endpoint via the
control-plane auth bridge:

```bash
API_KEY="vt_live_…"
curl -s -X POST "$API/api/events" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $API_KEY" \
  -d '{"type":"note","actorId":"my-agent","payload":{"text":"hello veritrail"}}'
```

The response contains the appended ledger record with its hash, sequence number,
and prev-hash — the foundation of every subsequent receipt.

### 4. See it appear in real time

Open the console at `/#/ledger`. The "Live" badge in the header turns green when
new events arrive over Server-Sent Events.

```bash
# Or stream directly with curl
curl -sN "$API/api/audit/events/stream" | head -20
```

### 5. Verify integrity

```bash
curl -s "$API/api/audit/verify" | python3 -m json.tool
```

### 6. Generate a cryptographic receipt (extension-only)

Receipts require the `extensions.anchorStore` option, which the live demo has
disabled by default to keep deployment simple. To enable: edit
`packages/server/src/main.ts`, instantiate an `InMemoryAnchorStore`, and pass it
in the `extensions` block. Then:

```bash
# Anchor the current head
curl -s -X POST "$API/api/v1/receipt/anchor" | python3 -m json.tool

# Generate a receipt for a past event
curl -s -X POST "$API/api/v1/receipt/generate" \
  -H 'content-type: application/json' \
  -d '{"seq":1}'
```

## Features Accessible in the Demo

- Magic-link auth, automatic org + project bootstrap
- API key minting with project-scoped label-scope
- Ingest events; query audit summary
- Live SSE updates
- All 17 console views: Overview, Ledger, Spend, Vendor Risk, Forensics,
  Policies, Simulator, AI RCA, Receipts, Compliance, Webhooks, Usage, API Keys,
  Team, Billing, Settings, Onboarding

## What's Not Wired in the Demo

- Stripe billing (no secret key)
- Resend email (server prints `devLink` instead)
- Receipts (no AnchorStore by default)
- Auto-RCA (no Anthropic API key)
- Postgres durability (in-memory only — data lost on restart)

Each can be enabled by passing the appropriate option into `buildServer` in
`packages/server/src/main.ts`.

## Self-Host

Skip the demo and run the same stack locally:

```bash
git clone https://github.com/veritrail/veritrail.git
cd veritrail
corepack enable && pnpm install && pnpm run build
VERITRAIL_CONTROL_PLANE=1 pnpm --filter @veritrail/server start
pnpm --filter @veritrail/console dev
# Open http://localhost:5173
```

See `docs/runbooks/saas-operations.md` for the full operator runbook.

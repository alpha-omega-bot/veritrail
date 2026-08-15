# @veritrail/console

Read-only operator dashboard for **Veritrail** — the 8-in-1 trust & control plane
for AI agents. This console gives operators a glance at ledger integrity, audit
events, spend, vendor risk, and incident forensics.

## Run

From the repository root:

```bash
pnpm --filter @veritrail/console dev
```

The dev server starts on <http://localhost:5173>.

## API base & proxy

The console talks to the Veritrail server REST API under `/api`. In development,
Vite proxies `/api/*` to the server (default `http://localhost:8787`). Override
the target with the `VERITRAIL_API` env var:

```bash
VERITRAIL_API=http://localhost:9000 pnpm --filter @veritrail/console dev
```

Endpoints consumed (all `GET`):

| Endpoint                                 | View        |
| ---------------------------------------- | ----------- |
| `/api/health`                            | Overview    |
| `/api/audit/summary`                     | Overview    |
| `/api/audit/events?limit=`               | Ledger      |
| `/api/spend/status`                      | Spend       |
| `/api/vendor-risk/assess`                | Vendor Risk |
| `/api/forensics/incident?correlationId=` | Forensics   |

## Authentication

Every endpoint above except `/api/health` requires an API credential with the
`operator` role and the matching read scope. `/api/audit/summary` additionally
requires an **unscoped** key (one with no `labelScope`).

The console asks for a token at runtime and keeps it in `sessionStorage` for the
duration of the browser session. It is deliberately **never** read from an
env var or baked into the built bundle — a bundled credential would be readable by
anyone who can load the page. If authentication is terminated by a reverse proxy
in front of the API, leave the token field empty and requests will be sent
without an `Authorization` header.

## No fallback data

This console shows only what the API actually returned. There is no sample-data or
offline mode: if a request fails, the affected view renders an explicit error with
a retry action and displays no figures at all.

That is a deliberate constraint rather than an omission. The console reports on a
tamper-evident audit ledger, so "integrity: verified" has to mean the server said
so. Substituting placeholder values on failure — or leaving a stale reading on
screen after a failed refresh — would make the display untrustworthy in exactly
the situation where it matters most.

## Structure

```
src/
  api.ts          typed REST client + useAsync hook; throws ApiError, never falls back
  types.ts        API payload interfaces mirroring the real server responses
  format.ts       presentation helpers (money, epoch-ms dates, hashes, labels)
  status.tsx      domain → Cloudscape StatusIndicator mapping
  components.tsx  shared error / loading / metric / credential UI
  App.tsx         TopNavigation + AppLayout + SideNavigation shell; hash routing
  main.tsx        React root (imports Cloudscape global styles)
  views/          Overview, Ledger, Spend, Vendor Risk, Forensics
```

### Payload conventions

Two API conventions are easy to get wrong when editing these views:

- **Timestamps are epoch-millisecond numbers**, not ISO strings.
- **Money is integer minor units** (`{ currency, amountMinor }`), never a float.
  Use `formatMoney` so each currency's own exponent is applied.

Collection endpoints also return bare JSON arrays with no envelope and no
pagination metadata.

The UI is built with the **[AWS Cloudscape design system](https://cloudscape.design/)**
(`@cloudscape-design/components`) for an AWS-console look and feel. Navigation is
hash-based (`#/overview`, `#/ledger`, …) — no router dependency.

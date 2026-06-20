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

## Offline Data

Every API call is wrapped in a try/catch and falls back to local sample data in
`src/mocks.ts`, so the SPA renders fully standalone with no server running. When
sample data is shown, a small notice appears at the top of the affected view.

## Structure

```
src/
  api.ts          typed REST client + useAsync hook (with offline fallback)
  types.ts        API payload interfaces
  mocks.ts        local sample data
  format.ts       presentation helpers (currency, dates, hashes)
  status.tsx      domain → Cloudscape StatusIndicator mapping
  App.tsx         TopNavigation + AppLayout + SideNavigation shell; hash routing
  main.tsx        React root (imports Cloudscape global styles)
  views/          Overview, Ledger, Spend, Vendor Risk, Forensics
```

The UI is built with the **[AWS Cloudscape design system](https://cloudscape.design/)**
(`@cloudscape-design/components`) for an AWS-console look and feel. Navigation is
hash-based (`#/overview`, `#/ledger`, …) — no router dependency.

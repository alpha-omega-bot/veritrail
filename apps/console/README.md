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
  App.tsx         hash-based navigation (no router dependency)
  main.tsx        React root
  styles.css      dark theme
  components/      Nav, StatCard, DataTable, Badge, Loading, ErrorBanner
  views/          Overview, Ledger, Spend, Vendor Risk, Forensics
```

Navigation is hash-based (`#/overview`, `#/ledger`, …) — no router dependency.
The app uses only React 18 function components and hooks.

```

```

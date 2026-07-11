# @veritrail/status

A minimal, dependency-free status page for Veritrail. A single static
`index.html` polls `/api/health/ready` every 30 seconds and renders a green /
yellow / red indicator plus a per-component breakdown.

There is no build step — the `public/` directory is the entire artifact.

## Local development

```sh
npm run dev
# serves ./public on http://localhost:4000
```

`npm run build` is a no-op; ship `public/` directly.

## Deploy

Serve the contents of `public/` from any static host (S3 + CloudFront, Netlify,
Vercel static, GitHub Pages, Caddy, nginx, `npx serve`, etc.). No server-side
rendering or environment variables are required.

```sh
# example — any static file server works
npx serve ./apps/status/public -l 4000
```

## Configuring the API host

By default the page polls `https://api.veritrail.io/api/health/ready`. To point
it at a different deployment (staging, self-hosted, etc.), set
`window.VERITRAIL_API` **before** the main script runs by injecting a small
`<script>` tag near the top of `index.html`:

```html
<script>
  window.VERITRAIL_API = 'https://api.staging.veritrail.io';
</script>
```

The page reads:

```js
const apiBaseUrl = window.VERITRAIL_API ?? 'https://api.veritrail.io';
```

so any value you set wins. Trailing slashes on the base URL are tolerated.

Most static hosts let you inject this via an edge function, a build-time
template, or simply by editing `index.html` in place at deploy time.

## Expected `/api/health/ready` shape

The page is forgiving about the response body — missing fields just render as
`—`. It looks for these (all optional except `ready`):

| Field                          | Type      | Meaning                                 |
| ------------------------------ | --------- | --------------------------------------- |
| `ready`                        | `boolean` | Overall readiness — drives the big dot. |
| `ledger.ok`                    | `boolean` | Ledger integrity check passed.          |
| `records.count`                | `number`  | Total records, shown in the components. |
| `error` / `message` / `reason` | `string`  | Human-readable failure detail.          |

Status mapping:

- **Green** — HTTP 2xx, `ready: true`, ledger not explicitly failing.
- **Yellow** — HTTP 2xx but `ready: false` or `ledger.ok: false`.
- **Red** — non-2xx response or network/CORS failure.

CORS: the API must allow `GET` from the status page's origin.

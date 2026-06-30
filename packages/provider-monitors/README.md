# @veritrail/provider-monitors

Provider `MonitorSource` adapters for Veritrail vendor risk monitoring.

This package keeps vendor-specific feeds, network clients, and parsing logic out
of `@veritrail/core` and `@veritrail/vendor-risk`. Bring the adapter that matches
your feed type, configure it with a transform callback, and pass it to
`VendorRiskModule.ingest()`.

## HTTP Status Check

Generic HTTP monitor for custom status APIs. You supply the transform from the
response to vendor signals.

```ts
import { HttpStatusCheckMonitor } from '@veritrail/provider-monitors';

const monitor = new HttpStatusCheckMonitor({
  vendorId: 'ven_anthropic',
  url: 'https://status.anthropic.com/api/v2/summary.json',
  transform: (body) => {
    const data = body as { status: { indicator: string; description: string } };
    if (data.status.indicator === 'none') return [];
    return [
      {
        id: `sig_anthropic_${Date.now()}`,
        vendorId: 'ven_anthropic',
        kind: 'incident',
        severity: data.status.indicator === 'critical' ? 'critical' : 'medium',
        summary: data.status.description,
        source: 'https://status.anthropic.com',
      },
    ];
  },
});

const signals = await monitor.poll();
```

## StatusPage.io Monitor

StatusPage.io-compatible status page parser. Handles the common JSON structure
(status indicator, incidents, components) and maps degradations into signals.

```ts
import { StatusPageMonitor } from '@veritrail/provider-monitors';

const monitor = new StatusPageMonitor({
  vendorId: 'ven_openai',
  url: 'https://status.openai.com/api/v2/summary.json',
});

const signals = await monitor.poll();
// Emits signals for overall status, active incidents, and degraded components
```

## Advisory Feed (RSS/Atom)

RSS or Atom feed parser for CVE advisories, security bulletins, and vendor
security feeds.

```ts
import { AdvisoryFeedMonitor } from '@veritrail/provider-monitors';

const monitor = new AdvisoryFeedMonitor({
  vendorId: 'ven_openssl',
  url: 'https://www.openssl.org/news/vulnerabilities.rss',
  transform: (entries) =>
    entries.map((entry) => ({
      id: `sig_openssl_${Date.now()}`,
      vendorId: 'ven_openssl',
      kind: 'breach',
      severity: entry.title.includes('HIGH') ? 'high' : 'medium',
      summary: entry.title,
      source: entry.link ?? 'https://www.openssl.org',
    })),
});

const signals = await monitor.poll();
```

The feed parser is minimal (regex-based) and dependency-free. For production
deployments with complex feeds, supply a real XML parser in the transform.

## Certificate Expiry

TLS certificate expiry monitor. Connects to a hostname, reads the server
certificate, and emits a signal when it will expire within the configured
threshold (default 30 days).

```ts
import { CertExpiryMonitor } from '@veritrail/provider-monitors';

const monitor = new CertExpiryMonitor({
  vendorId: 'ven_openai',
  hostname: 'api.openai.com',
  warnThresholdMs: 30 * 24 * 60 * 60 * 1000, // 30 days
});

const signals = await monitor.poll();
// Emits a signal if the certificate expires within 30 days
```

## Ingesting into Veritrail

Pass any monitor to `VendorRiskModule.ingest()`:

```ts
import { createVendorRiskModule } from '@veritrail/vendor-risk';

const vendorRisk = createVendorRiskModule(ctx);
const count = await vendorRisk.ingest(monitor);
console.log(`Recorded ${count} signals`);
```

The module validates and records each signal as a `vendor.signal` ledger event.

## Failure Behavior

All adapters throw `ProviderMonitorError` when a fetch fails, a response is
malformed, or a transform callback throws. The vendor-risk module's `ingest()`
logs and skips invalid signals but does not propagate the error, so one bad
signal doesn't halt ingestion of the rest.

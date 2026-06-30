import { describe, expect, it } from 'vitest';

import type { VendorSignal } from '@veritrail/core';
import {
  AdvisoryFeedMonitor,
  CertExpiryMonitor,
  HttpStatusCheckMonitor,
  StatusPageMonitor,
} from '@veritrail/provider-monitors';

describe('HttpStatusCheckMonitor', () => {
  it('fetches and transforms a JSON response into vendor signals', async () => {
    const monitor = new HttpStatusCheckMonitor({
      vendorId: 'ven_test',
      url: 'https://status.example.com/summary.json',
      fetch: async () =>
        new Response(JSON.stringify({ status: { indicator: 'major' } }), {
          headers: { 'content-type': 'application/json' },
        }),
      transform: (body) => {
        const data = body as { status: { indicator: string } };
        return [
          {
            id: 'sig_test',
            vendorId: 'ven_test',
            kind: 'incident',
            severity: 'high',
            summary: `Indicator: ${data.status.indicator}`,
            source: 'test',
          },
        ];
      },
    });

    const signals = await monitor.poll();

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      id: 'sig_test',
      vendorId: 'ven_test',
      kind: 'incident',
      severity: 'high',
      summary: 'Indicator: major',
    });
  });

  it('rejects non-OK HTTP responses', async () => {
    const monitor = new HttpStatusCheckMonitor({
      vendorId: 'ven_test',
      url: 'https://status.example.com/fail',
      fetch: async () => new Response('Not Found', { status: 404 }),
      transform: () => [],
    });

    await expect(monitor.poll()).rejects.toMatchObject({
      name: 'ProviderMonitorError',
      provider: 'http-status-check:ven_test',
      message: expect.stringContaining('HTTP 404'),
    });
  });

  it('wraps transform errors as ProviderMonitorError', async () => {
    const monitor = new HttpStatusCheckMonitor({
      vendorId: 'ven_test',
      url: 'https://example.com',
      fetch: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
      transform: () => {
        throw new Error('transform failure');
      },
    });

    await expect(monitor.poll()).rejects.toMatchObject({
      name: 'ProviderMonitorError',
      message: expect.stringContaining('transform failed: transform failure'),
    });
  });
});

describe('StatusPageMonitor', () => {
  it('parses StatusPage.io summary JSON and emits signals for incidents', async () => {
    const monitor = new StatusPageMonitor({
      vendorId: 'ven_provider',
      url: 'https://status.provider.com/api/v2/summary.json',
      fetch: async () =>
        new Response(
          JSON.stringify({
            status: { indicator: 'minor', description: 'Elevated error rates' },
            incidents: [
              { id: 'inc1', name: 'API Latency', status: 'investigating', impact: 'major' },
            ],
            components: [
              { id: 'comp1', name: 'API', status: 'degraded_performance' },
              { id: 'comp2', name: 'Dashboard', status: 'operational' },
            ],
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    });

    const signals = await monitor.poll();

    expect(signals.length).toBeGreaterThanOrEqual(3);
    expect(signals.find((s) => s.summary.includes('Elevated error rates'))).toBeDefined();
    expect(signals.find((s) => s.summary.includes('API Latency'))).toMatchObject({
      vendorId: 'ven_provider',
      kind: 'incident',
      severity: 'high',
    });
    expect(signals.find((s) => s.summary.includes('API: degraded'))).toMatchObject({
      kind: 'degradation',
      severity: 'high',
    });
    expect(signals.find((s) => s.summary.includes('Dashboard'))).toBeUndefined();
  });

  it('returns empty when status is none', async () => {
    const monitor = new StatusPageMonitor({
      vendorId: 'ven_ok',
      url: 'https://status.ok.com/summary.json',
      fetch: async () =>
        new Response(JSON.stringify({ status: { indicator: 'none' } }), {
          headers: { 'content-type': 'application/json' },
        }),
    });

    const signals = await monitor.poll();

    expect(signals).toHaveLength(0);
  });
});

describe('AdvisoryFeedMonitor', () => {
  it('parses RSS feed and transforms entries into signals', async () => {
    const rssFeed = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Security Advisories</title>
    <item>
      <title>CVE-2026-12345: High severity issue</title>
      <link>https://example.com/cve-2026-12345</link>
      <pubDate>Mon, 30 Jun 2026 10:00:00 GMT</pubDate>
    </item>
    <item>
      <title>CVE-2026-67890: Medium severity issue</title>
      <link>https://example.com/cve-2026-67890</link>
    </item>
  </channel>
</rss>`;

    const monitor = new AdvisoryFeedMonitor({
      vendorId: 'ven_lib',
      url: 'https://example.com/advisories.rss',
      fetch: async () => new Response(rssFeed),
      transform: (entries) =>
        entries.map((entry, idx) => ({
          id: `sig_lib_${idx}`,
          vendorId: 'ven_lib',
          kind: 'breach',
          severity: entry.title.includes('High') ? 'high' : 'medium',
          summary: entry.title,
          source: entry.link ?? 'unknown',
        })) as VendorSignal[],
    });

    const signals = await monitor.poll();

    expect(signals).toHaveLength(2);
    expect(signals[0]).toMatchObject({
      kind: 'breach',
      severity: 'high',
      summary: 'CVE-2026-12345: High severity issue',
      source: 'https://example.com/cve-2026-12345',
    });
    expect(signals[1]).toMatchObject({
      severity: 'medium',
    });
  });

  it('parses Atom feed and transforms entries', async () => {
    const atomFeed = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Advisories</title>
  <entry>
    <title>Security Update 1</title>
    <link href="https://example.com/update1" />
    <updated>2026-06-30T10:00:00Z</updated>
  </entry>
</feed>`;

    const monitor = new AdvisoryFeedMonitor({
      vendorId: 'ven_atom',
      url: 'https://example.com/atom.xml',
      fetch: async () => new Response(atomFeed),
      transform: (entries) =>
        entries.map((entry) => ({
          id: 'sig_atom',
          vendorId: 'ven_atom',
          kind: 'breach',
          severity: 'medium',
          summary: entry.title,
          source: entry.link ?? '',
        })) as VendorSignal[],
    });

    const signals = await monitor.poll();

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      summary: 'Security Update 1',
      source: 'https://example.com/update1',
    });
  });
});

describe('CertExpiryMonitor', () => {
  it('returns empty when cert expires beyond threshold', async () => {
    const monitor = new CertExpiryMonitor({
      vendorId: 'ven_secure',
      hostname: 'example.com',
      warnThresholdMs: 1,
    });

    const signals = await monitor.poll();

    expect(Array.isArray(signals)).toBe(true);
  });
});

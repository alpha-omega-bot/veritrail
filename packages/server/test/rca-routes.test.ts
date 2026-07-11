import { createInMemoryLedger, type Ledger } from '@veritrail/core';
import type { LlmAdapter } from '@veritrail/auto-rca';
import { describe, expect, it } from 'vitest';

import { buildServer } from '../src/app.js';
import { registerRcaRoutes } from '../src/rca-routes.js';

function adapterReturning(text: string, modelId = 'claude-opus-4-7'): LlmAdapter {
  return {
    async call() {
      return { text, modelId, usage: { inputTokens: 10, outputTokens: 7 } };
    },
  };
}

const wellFormedReport = JSON.stringify({
  headline: 'Repeated denied egress to unknown vendor host',
  summary: 'Three blocked egress attempts to api.unknown-vendor.io in one minute.',
  causalContributors: ['Upstream prompt contained an untrusted URL.'],
  confidence: 0.71,
  recommendations: ['Tighten the network.egress allowlist.'],
});

async function buildTestServer(opts: {
  ledger?: Ledger;
  adapter?: LlmAdapter;
  anthropicApiKey?: string;
}) {
  const ledger = opts.ledger ?? createInMemoryLedger();
  const app = await buildServer({ ledger, logger: false });
  registerRcaRoutes(app, {
    ledger,
    ...(opts.adapter !== undefined ? { adapter: opts.adapter } : {}),
    ...(opts.anthropicApiKey !== undefined ? { anthropicApiKey: opts.anthropicApiKey } : {}),
  });
  await app.ready();
  return app;
}

describe('rca routes', () => {
  it('returns 400 when correlationId is missing', async () => {
    const app = await buildTestServer({ adapter: adapterReturning(wellFormedReport) });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/rca/analyze',
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('returns 503 when neither adapter nor anthropicApiKey is configured', async () => {
    const app = await buildTestServer({});
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/rca/analyze',
        payload: { correlationId: 'corr-1' },
      });
      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('UNSUPPORTED');
    } finally {
      await app.close();
    }
  });

  it('returns 200 with a non-empty headline when the adapter produces valid JSON', async () => {
    const app = await buildTestServer({ adapter: adapterReturning(wellFormedReport) });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/rca/analyze',
        payload: { correlationId: 'corr-1', operatorContext: 'pages-on-call investigation' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(typeof body.headline).toBe('string');
      expect(body.headline.length).toBeGreaterThan(0);
      expect(body.metadata.modelId).toBe('claude-opus-4-7');
    } finally {
      await app.close();
    }
  });

  it('returns 502 when the adapter returns unparseable output', async () => {
    const app = await buildTestServer({ adapter: adapterReturning('not json at all') });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/rca/analyze',
        payload: { correlationId: 'corr-1' },
      });
      expect(res.statusCode).toBe(502);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('INTERNAL');
      expect(body.error.message).toMatch(/parseable JSON/);
    } finally {
      await app.close();
    }
  });

  it('queries the ledger for the supplied correlationId before invoking the adapter', async () => {
    const ledger = createInMemoryLedger();
    await ledger.append({
      type: 'note',
      actorId: 'agent-1',
      correlationId: 'corr-trace',
      payload: { text: 'first observation' },
    });
    await ledger.append({
      type: 'note',
      actorId: 'agent-1',
      correlationId: 'corr-trace',
      payload: { text: 'second observation' },
    });
    const seen: unknown[] = [];
    const capturingAdapter: LlmAdapter = {
      async call(request) {
        seen.push(request.user);
        return {
          text: wellFormedReport,
          modelId: 'claude-opus-4-7',
        };
      },
    };
    const app = await buildTestServer({ ledger, adapter: capturingAdapter });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/rca/analyze',
        payload: { correlationId: 'corr-trace' },
      });
      expect(res.statusCode).toBe(200);
      expect(seen).toHaveLength(1);
      expect(String(seen[0])).toContain('corr-trace');
      expect(String(seen[0])).toContain('"eventCount": 2');
    } finally {
      await app.close();
    }
  });
});

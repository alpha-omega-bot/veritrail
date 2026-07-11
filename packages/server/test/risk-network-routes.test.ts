import { createInMemoryLedger, FixedClock } from '@veritrail/core';
import { contributePattern, RECOMMENDED_K_ANON } from '@veritrail/risk-network';
import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerRiskNetworkRoutes } from '../src/risk-network-routes.js';

const ORG_SALT = 'test-network-salt';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function makeApp(): Promise<{
  app: FastifyInstance;
  ledger: ReturnType<typeof createInMemoryLedger>;
}> {
  const clock = new FixedClock(1_700_000_000);
  const ledger = createInMemoryLedger({ clock });
  const app = Fastify({ logger: false });
  registerRiskNetworkRoutes(app, { ledger, orgSalt: ORG_SALT });
  await app.ready();
  return { app, ledger };
}

describe('risk-network HTTP routes', () => {
  it('POST /api/v1/risk-network/contribute hashes patterns and appends one vendor.signal event per contribution', async () => {
    const { app, ledger } = await makeApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/risk-network/contribute',
        payload: {
          patterns: [
            { rawPattern: 'ignore previous', category: 'prompt-injection', orgId: 'org_a' },
            { rawPattern: 'rm -rf /', category: 'unsafe-tool', orgId: 'org_b' },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        contributed: number;
        signals: Array<{ patternHash: string; category: string; contributorIdHash: string }>;
      };
      expect(body.contributed).toBe(2);
      expect(body.signals).toHaveLength(2);
      expect(body.signals[0]!.patternHash).toBe(sha256Hex('ignore previous'));
      expect(body.signals[0]!.category).toBe('prompt-injection');
      expect(body.signals[0]!.contributorIdHash).toBe(sha256Hex(`org_a${ORG_SALT}`));

      const records = await ledger.query({ types: ['vendor.signal'] });
      expect(records).toHaveLength(2);
      for (const record of records) {
        expect(record.event.labels['risk-network']).toBe('1');
      }
    } finally {
      await app.close();
    }
  });

  it('POST /api/v1/risk-network/query returns { bucket: null, k } when the patternHash is unknown', async () => {
    const { app } = await makeApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/risk-network/query',
        payload: { patternHash: sha256Hex('never seen') },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { bucket: null; k: number };
      expect(body.bucket).toBeNull();
      expect(body.k).toBe(RECOMMENDED_K_ANON);
    } finally {
      await app.close();
    }
  });

  it('POST /api/v1/risk-network/query returns an aggregated bucket once k distinct contributors have contributed the same pattern', async () => {
    const { app } = await makeApp();
    try {
      const rawPattern = 'reveal system prompt';
      const patternHash = sha256Hex(rawPattern);
      const orgIds = ['org_1', 'org_2', 'org_3', 'org_4', 'org_5'];
      expect(orgIds.length).toBe(RECOMMENDED_K_ANON);

      for (const orgId of orgIds) {
        const contribute = await app.inject({
          method: 'POST',
          url: '/api/v1/risk-network/contribute',
          payload: {
            patterns: [{ rawPattern, category: 'prompt-injection', orgId }],
          },
        });
        expect(contribute.statusCode).toBe(200);
      }

      const query = await app.inject({
        method: 'POST',
        url: '/api/v1/risk-network/query',
        payload: { patternHash },
      });
      expect(query.statusCode).toBe(200);
      const bucket = JSON.parse(query.body) as {
        patternHash: string;
        category: string;
        contributorCount: number;
        observationCount: number;
      };
      expect(bucket.patternHash).toBe(patternHash);
      expect(bucket.category).toBe('prompt-injection');
      expect(bucket.contributorCount).toBe(RECOMMENDED_K_ANON);
      expect(bucket.observationCount).toBe(RECOMMENDED_K_ANON);
    } finally {
      await app.close();
    }
  });

  it('POST /api/v1/risk-network/query filters buckets below k, even when many observations come from too few contributors', async () => {
    const { app } = await makeApp();
    try {
      const rawPattern = 'low-k pattern';
      const patternHash = sha256Hex(rawPattern);
      const tooFew = Math.max(1, RECOMMENDED_K_ANON - 1);
      const orgIds = Array.from({ length: tooFew }, (_, i) => `org_${i}`);

      for (const orgId of orgIds) {
        for (let i = 0; i < 3; i += 1) {
          const res = await app.inject({
            method: 'POST',
            url: '/api/v1/risk-network/contribute',
            payload: {
              patterns: [{ rawPattern, category: 'unsafe-tool', orgId }],
            },
          });
          expect(res.statusCode).toBe(200);
        }
      }

      const totalSignals = tooFew * 3;
      const records = await app
        .inject({
          method: 'POST',
          url: '/api/v1/risk-network/query',
          payload: { patternHash },
        })
        .then((r) => JSON.parse(r.body) as { bucket: null; k: number });
      expect(records.bucket).toBeNull();
      expect(records.k).toBe(RECOMMENDED_K_ANON);

      // Sanity: signals really were appended; query just suppresses them under k-anon.
      const sample = contributePattern({
        rawPattern,
        category: 'unsafe-tool',
        orgId: orgIds[0]!,
        salt: ORG_SALT,
      });
      expect(sample.patternHash).toBe(patternHash);
      expect(totalSignals).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it('POST /api/v1/risk-network/contribute returns 400 when patterns is missing or an entry is malformed', async () => {
    const { app } = await makeApp();
    try {
      const missing = await app.inject({
        method: 'POST',
        url: '/api/v1/risk-network/contribute',
        payload: {},
      });
      expect(missing.statusCode).toBe(400);
      const missingBody = JSON.parse(missing.body) as { error?: { code?: string } };
      expect(missingBody.error?.code).toBe('VALIDATION');

      const empty = await app.inject({
        method: 'POST',
        url: '/api/v1/risk-network/contribute',
        payload: { patterns: [] },
      });
      expect(empty.statusCode).toBe(400);

      const badCategory = await app.inject({
        method: 'POST',
        url: '/api/v1/risk-network/contribute',
        payload: {
          patterns: [{ rawPattern: 'x', category: 'not-a-category', orgId: 'org_a' }],
        },
      });
      expect(badCategory.statusCode).toBe(400);

      const missingOrg = await app.inject({
        method: 'POST',
        url: '/api/v1/risk-network/contribute',
        payload: {
          patterns: [{ rawPattern: 'x', category: 'other' }],
        },
      });
      expect(missingOrg.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('POST /api/v1/risk-network/query returns 400 when patternHash is missing', async () => {
    const { app } = await makeApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/risk-network/query',
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body) as { error?: { code?: string; message?: string } };
      expect(body.error?.code).toBe('VALIDATION');
      expect(body.error?.message).toMatch(/patternHash/);
    } finally {
      await app.close();
    }
  });
});

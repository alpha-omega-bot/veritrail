import { createInMemoryLedger, FixedClock } from '@veritrail/core';
import { FRAMEWORK_IDS, FRAMEWORK_TEMPLATES } from '@veritrail/compliance';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerComplianceRoutes } from '../src/compliance-routes.js';

async function makeApp() {
  const clock = new FixedClock(5_000);
  const ledger = createInMemoryLedger({ clock });
  const app = Fastify({ logger: false });
  registerComplianceRoutes(app, { ledger });
  await app.ready();
  return { app, ledger };
}

describe('compliance HTTP routes', () => {
  it('GET /api/v1/compliance/frameworks returns all four framework ids', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/compliance/frameworks' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { frameworkIds: string[] };
    expect(body.frameworkIds).toEqual(FRAMEWORK_IDS);
    expect(body.frameworkIds).toHaveLength(4);
    await app.close();
  });

  it('POST /api/v1/compliance/report with no body returns 400', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/compliance/report' });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error?: { code?: string } };
    expect(body.error?.code).toBe('VALIDATION');
    await app.close();
  });

  it('POST /api/v1/compliance/report with invalid frameworkId returns 400', async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/compliance/report',
      payload: { frameworkId: 'not-a-framework' },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('VALIDATION');
    expect(body.error?.message).toMatch(/frameworkId/);
    await app.close();
  });

  it('POST /api/v1/compliance/report with a valid frameworkId returns 200 and Markdown including the framework name', async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/compliance/report',
      payload: { frameworkId: 'soc2-cc7' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      framework: { id: string; name: string; version: string };
      fromMs: number;
      toMs: number;
      evidence: Array<{ controlId: string; satisfied: boolean }>;
      markdown: string;
      scorePercent: number;
    };
    expect(body.framework.id).toBe('soc2-cc7');
    expect(body.framework.name).toBe(FRAMEWORK_TEMPLATES['soc2-cc7'].name);
    expect(typeof body.markdown).toBe('string');
    expect(body.markdown).toContain(FRAMEWORK_TEMPLATES['soc2-cc7'].name);
    expect(body.evidence).toHaveLength(FRAMEWORK_TEMPLATES['soc2-cc7'].controls.length);
    expect(body.fromMs).toBeLessThan(body.toMs);
    expect(typeof body.scorePercent).toBe('number');
    expect(body.scorePercent).toBeGreaterThanOrEqual(0);
    expect(body.scorePercent).toBeLessThanOrEqual(100);
    await app.close();
  });

  it('POST /api/v1/compliance/report rejects an inverted window (fromMs >= toMs)', async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/compliance/report',
      payload: { frameworkId: 'iso-42001', fromMs: 1_000, toMs: 1_000 },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('VALIDATION');
    expect(body.error?.message).toMatch(/fromMs/);
    await app.close();
  });

  it('POST /api/v1/compliance/report honours an explicit window and finds matching evidence', async () => {
    const clock = new FixedClock(5_000);
    const ledger = createInMemoryLedger({ clock });
    const app = Fastify({ logger: false });
    registerComplianceRoutes(app, { ledger });
    await app.ready();

    await ledger.append({
      type: 'action.executed',
      actorId: 'actor-1',
      payload: { actionId: 'act-1', outcome: 'success' },
    });
    await ledger.append({
      type: 'action.failed',
      actorId: 'actor-1',
      payload: { actionId: 'act-1', error: 'boom' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/compliance/report',
      payload: { frameworkId: 'soc2-cc7', fromMs: 1_000, toMs: 10_000 },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      evidence: Array<{ controlId: string; satisfied: boolean; evidenceCount: number }>;
      scorePercent: number;
    };
    const cc72 = body.evidence.find((e) => e.controlId === 'SOC2.CC7.2');
    expect(cc72?.satisfied).toBe(true);
    expect(cc72?.evidenceCount).toBeGreaterThan(0);
    await app.close();
  });
});

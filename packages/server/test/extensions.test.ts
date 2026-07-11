import {
  createInMemoryLedger,
  FixedClock,
  InMemoryAnchorStore,
  SequentialIdGenerator,
} from '@veritrail/core';
import { describe, expect, it } from 'vitest';

import { buildServer } from '../src/app.js';

describe('buildServer extensions wiring', () => {
  it('disables compliance routes by default', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/compliance/frameworks',
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('enables compliance routes when extensions.complianceEnabled is set', async () => {
    const app = await buildServer({ extensions: { complianceEnabled: true } });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/compliance/frameworks',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.frameworkIds)).toBe(true);
    expect(body.frameworkIds.length).toBeGreaterThanOrEqual(4);
    await app.close();
  });

  it('disables receipt routes by default', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/receipt/anchor',
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('enables receipt routes when an AnchorStore is supplied', async () => {
    const ledger = createInMemoryLedger({
      clock: new FixedClock(1_000_000),
      ids: new SequentialIdGenerator(),
    });
    await ledger.append({ type: 'note', actorId: 'a1', payload: { text: 'hi' } });

    const app = await buildServer({
      ledger,
      extensions: { anchorStore: new InMemoryAnchorStore() },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/receipt/anchor',
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(200);
    expect(res.statusCode).toBeLessThan(300);
    const body = JSON.parse(res.body);
    expect(body.headHash).toMatch(/^[0-9a-f]{64}$/);
    await app.close();
  });

  it('passes when no extensions are configured (no-op)', async () => {
    const app = await buildServer();
    expect(typeof app.inject).toBe('function');
    await app.close();
  });
});

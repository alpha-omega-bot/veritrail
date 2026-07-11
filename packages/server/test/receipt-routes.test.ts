import {
  createInMemoryLedger,
  FixedClock,
  InMemoryAnchorStore,
  SequentialIdGenerator,
  type Ledger,
} from '@veritrail/core';
import { generateReceipt, verifyReceipt } from '@veritrail/receipt';
import { describe, expect, it } from 'vitest';

import { buildServer } from '../src/app.js';
import { registerReceiptRoutes } from '../src/receipt-routes.js';

async function setup(options: { events?: number } = {}) {
  const ledger: Ledger = createInMemoryLedger({
    clock: new FixedClock(1_000_000),
    ids: new SequentialIdGenerator(),
  });
  const events = options.events ?? 0;
  for (let i = 0; i < events; i += 1) {
    const res = await ledger.append({
      type: 'note',
      actorId: `agent-${i}`,
      payload: { text: `step-${i}` },
    });
    if (!res.ok) throw new Error(`append failed: ${res.error.message}`);
  }
  const anchorStore = new InMemoryAnchorStore();
  const clock = new FixedClock(2_000_000);
  const ids = new SequentialIdGenerator();
  const app = await buildServer({ ledger });
  registerReceiptRoutes(app, { ledger, anchorStore, clock, ids });
  await app.ready();
  return { app, ledger, anchorStore, clock, ids };
}

describe('receipt HTTP routes', () => {
  it('returns 404 when anchoring an empty ledger', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'POST', url: '/api/v1/receipt/anchor' });
    expect(res.statusCode).toBe(404);
  });

  it('appends, anchors, and generates a valid receipt for the head event', async () => {
    const { app } = await setup({ events: 3 });
    const anchorRes = await app.inject({ method: 'POST', url: '/api/v1/receipt/anchor' });
    expect(anchorRes.statusCode).toBe(201);
    const anchor = JSON.parse(anchorRes.body);
    expect(anchor.seq).toBe(3);

    const genRes = await app.inject({
      method: 'POST',
      url: '/api/v1/receipt/generate',
      payload: { seq: 3 },
    });
    expect(genRes.statusCode).toBe(200);
    const receipt = JSON.parse(genRes.body);
    expect(receipt.event.seq).toBe(3);
    expect(receipt.chain).toEqual([]);
    expect(receipt.anchor.headHash).toBe(anchor.headHash);

    const verify = verifyReceipt(receipt);
    expect(verify.ok).toBe(true);
  });

  it('generates a receipt for an older event with a non-empty chain', async () => {
    const { app } = await setup({ events: 4 });
    await app.inject({ method: 'POST', url: '/api/v1/receipt/anchor' });
    const genRes = await app.inject({
      method: 'POST',
      url: '/api/v1/receipt/generate',
      payload: { seq: 1, projectId: 'proj_demo' },
    });
    expect(genRes.statusCode).toBe(200);
    const receipt = JSON.parse(genRes.body);
    expect(receipt.event.seq).toBe(1);
    expect(receipt.chain).toHaveLength(3);
    expect(receipt.projectId).toBe('proj_demo');
    expect(verifyReceipt(receipt).ok).toBe(true);
  });

  it('returns 400 when generate is given a seq beyond the anchor head', async () => {
    const { app } = await setup({ events: 2 });
    await app.inject({ method: 'POST', url: '/api/v1/receipt/anchor' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/receipt/generate',
      payload: { seq: 99 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when generate is called before any anchor exists', async () => {
    const { app } = await setup({ events: 2 });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/receipt/generate',
      payload: { seq: 1 },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 when generate references an unknown anchorId', async () => {
    const { app } = await setup({ events: 2 });
    await app.inject({ method: 'POST', url: '/api/v1/receipt/anchor' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/receipt/generate',
      payload: { seq: 1, anchorId: 'anc_does_not_exist' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('uses a specific anchorId when supplied', async () => {
    const { app, ledger, anchorStore, clock, ids } = await setup({ events: 2 });

    // First anchor covers seq 2.
    const firstAnchor = await app.inject({ method: 'POST', url: '/api/v1/receipt/anchor' });
    const first = JSON.parse(firstAnchor.body);
    expect(first.seq).toBe(2);

    // Append another event and anchor again so latest() != first.
    const appendRes = await ledger.append({
      type: 'note',
      actorId: 'agent-x',
      payload: { text: 'after' },
    });
    if (!appendRes.ok) throw new Error('append failed');
    const secondAnchor = await app.inject({ method: 'POST', url: '/api/v1/receipt/anchor' });
    const second = JSON.parse(secondAnchor.body);
    expect(second.seq).toBe(3);
    void anchorStore;
    void clock;
    void ids;

    const genRes = await app.inject({
      method: 'POST',
      url: '/api/v1/receipt/generate',
      payload: { seq: 1, anchorId: first.anchorId },
    });
    expect(genRes.statusCode).toBe(200);
    const receipt = JSON.parse(genRes.body);
    expect(receipt.anchor.anchorId).toBe(first.anchorId);
    expect(receipt.anchor.seq).toBe(2);
    expect(receipt.chain).toHaveLength(1);
  });

  it('verifies a valid receipt as ok:true and surfaces the anchored head hash', async () => {
    const { app, ledger, anchorStore, clock, ids } = await setup({ events: 3 });
    await app.inject({ method: 'POST', url: '/api/v1/receipt/anchor' });
    const anchor = await anchorStore.latest();
    if (!anchor) throw new Error('no anchor');
    const receipt = await generateReceipt({ ledger, anchor, seq: 2 });
    void clock;
    void ids;

    const verifyRes = await app.inject({
      method: 'POST',
      url: '/api/v1/receipt/verify',
      payload: { receipt },
    });
    expect(verifyRes.statusCode).toBe(200);
    const body = JSON.parse(verifyRes.body);
    expect(body.ok).toBe(true);
    expect(body.failures).toEqual([]);
    expect(body.anchoredHeadHash).toBe(anchor.headHash);
  });

  it('verifies a tampered receipt as ok:false with failures', async () => {
    const { app, ledger, anchorStore } = await setup({ events: 3 });
    await app.inject({ method: 'POST', url: '/api/v1/receipt/anchor' });
    const anchor = await anchorStore.latest();
    if (!anchor) throw new Error('no anchor');
    const receipt = await generateReceipt({ ledger, anchor, seq: 2 });

    const tampered = {
      ...receipt,
      event: {
        ...receipt.event,
        event: { ...(receipt.event.event as Record<string, unknown>), tampered: true },
      },
    };

    const verifyRes = await app.inject({
      method: 'POST',
      url: '/api/v1/receipt/verify',
      payload: { receipt: tampered },
    });
    expect(verifyRes.statusCode).toBe(200);
    const body = JSON.parse(verifyRes.body);
    expect(body.ok).toBe(false);
    expect(body.failures.length).toBeGreaterThan(0);
    expect(body.anchoredHeadHash).toBeUndefined();
  });

  it('honours trustedAnchorHeadHash when provided', async () => {
    const { app, ledger, anchorStore } = await setup({ events: 2 });
    await app.inject({ method: 'POST', url: '/api/v1/receipt/anchor' });
    const anchor = await anchorStore.latest();
    if (!anchor) throw new Error('no anchor');
    const receipt = await generateReceipt({ ledger, anchor, seq: 1 });

    const mismatch = await app.inject({
      method: 'POST',
      url: '/api/v1/receipt/verify',
      payload: { receipt, trustedAnchorHeadHash: 'a'.repeat(64) },
    });
    expect(JSON.parse(mismatch.body).ok).toBe(false);

    const matching = await app.inject({
      method: 'POST',
      url: '/api/v1/receipt/verify',
      payload: { receipt, trustedAnchorHeadHash: anchor.headHash },
    });
    expect(JSON.parse(matching.body).ok).toBe(true);
  });

  it('returns 400 when verify is called without a receipt body', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/receipt/verify',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});

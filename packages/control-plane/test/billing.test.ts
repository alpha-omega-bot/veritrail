import { createHmac } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import { InMemoryStripeEventDedup, StripeWebhookHandler } from '../src/billing/stripe.js';
import { UsageTracker } from '../src/billing/quotas.js';
import { InMemoryControlPlaneStore } from '../src/memory-store.js';
import type { Organization } from '../src/schema.js';
import { createControlPlane } from '../src/control-plane.js';

function signedHeader(secret: string, body: string, ts: number): string {
  const sig = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  return `t=${ts},v1=${sig}`;
}

describe('StripeWebhookHandler.verifySignature', () => {
  const secret = 'whsec_test';
  const now = 1_700_000_000_000;
  let store: InMemoryControlPlaneStore;
  let handler: StripeWebhookHandler;

  beforeEach(() => {
    store = new InMemoryControlPlaneStore();
    handler = new StripeWebhookHandler({
      store,
      signingSecret: secret,
      priceIdToTier: {
        price_starter: 'starter',
        price_pro: 'pro',
        price_enterprise: 'enterprise',
      },
      clock: () => now,
    });
  });

  it('accepts a freshly-signed payload', () => {
    const body = '{"id":"evt_1"}';
    const ts = Math.floor(now / 1000);
    const header = signedHeader(secret, body, ts);
    expect(handler.verifySignature(body, header)).toBe(true);
  });

  it('rejects an expired signature outside the tolerance window', () => {
    const body = '{"id":"evt_1"}';
    const ts = Math.floor(now / 1000) - 1000;
    const header = signedHeader(secret, body, ts);
    expect(handler.verifySignature(body, header)).toBe(false);
  });

  it('rejects a forged signature with the wrong secret', () => {
    const body = '{"id":"evt_1"}';
    const ts = Math.floor(now / 1000);
    const header = signedHeader('wrong-secret', body, ts);
    expect(handler.verifySignature(body, header)).toBe(false);
  });

  it('rejects a malformed header', () => {
    expect(handler.verifySignature('body', '')).toBe(false);
    expect(handler.verifySignature('body', 'gibberish')).toBe(false);
  });
});

describe('StripeWebhookHandler.handle', () => {
  const secret = 'whsec_test';
  let now: number;
  let store: InMemoryControlPlaneStore;
  let handler: StripeWebhookHandler;

  beforeEach(() => {
    now = 1_700_000_000_000;
    store = new InMemoryControlPlaneStore();
    handler = new StripeWebhookHandler({
      store,
      signingSecret: secret,
      priceIdToTier: { price_pro: 'pro' },
      clock: () => now,
      dedup: new InMemoryStripeEventDedup(),
    });
  });

  it('applies a subscription.created event to the matching org', async () => {
    const cp = createControlPlane({ store, clock: () => now });
    const org = await cp.createOrg({ name: 'Acme', slug: 'acme' });
    const body = JSON.stringify({
      id: 'evt_sub_1',
      type: 'customer.subscription.created',
      data: {
        object: {
          id: 'sub_123',
          customer: 'cus_123',
          status: 'active',
          metadata: { orgId: org.id },
          priceId: 'price_pro',
        },
      },
    });
    const header = signedHeader(secret, body, Math.floor(now / 1000));
    const outcome = await handler.handle(body, header);
    expect(outcome.ok).toBe(true);
    expect(outcome.result?.handled).toBe(true);
    expect(outcome.result?.tier).toBe('pro');
    const updated = await store.getOrgById(org.id);
    expect(updated?.tier).toBe('pro');
    expect(updated?.subscriptionStatus).toBe('active');
    expect(updated?.stripeSubscriptionId).toBe('sub_123');
  });

  it('downgrades to free on subscription.deleted', async () => {
    const cp = createControlPlane({ store, clock: () => now });
    const org = await cp.createOrg({ name: 'Acme', slug: 'acme', tier: 'pro' });
    const body = JSON.stringify({
      id: 'evt_del_1',
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_123', metadata: { orgId: org.id } } },
    });
    const header = signedHeader(secret, body, Math.floor(now / 1000));
    const outcome = await handler.handle(body, header);
    expect(outcome.result?.tier).toBe('free');
    const updated = await store.getOrgById(org.id);
    expect(updated?.tier).toBe('free');
    expect(updated?.subscriptionStatus).toBe('canceled');
  });

  it('drops duplicate events idempotently', async () => {
    const cp = createControlPlane({ store, clock: () => now });
    const org = await cp.createOrg({ name: 'A', slug: 'a' });
    const body = JSON.stringify({
      id: 'evt_dup',
      type: 'customer.subscription.created',
      data: {
        object: {
          id: 'sub_1',
          customer: 'cus_1',
          status: 'active',
          metadata: { orgId: org.id },
          priceId: 'price_pro',
        },
      },
    });
    const header = signedHeader(secret, body, Math.floor(now / 1000));
    await handler.handle(body, header);
    const second = await handler.handle(body, header);
    expect(second.ok).toBe(true);
    expect(second.result?.handled).toBe(false);
    expect(second.result?.reason).toMatch(/duplicate/);
  });

  it('refuses to apply an event with an unknown price', async () => {
    const body = JSON.stringify({
      id: 'evt_unknown_price',
      type: 'customer.subscription.created',
      data: {
        object: {
          id: 'sub_1',
          customer: 'cus_1',
          status: 'active',
          metadata: { orgId: 'org_x' },
          priceId: 'price_phantom',
        },
      },
    });
    const header = signedHeader(secret, body, Math.floor(now / 1000));
    const outcome = await handler.handle(body, header);
    expect(outcome.result?.handled).toBe(false);
    expect(outcome.result?.reason).toMatch(/unknown price/);
  });
});

describe('UsageTracker', () => {
  function fakeOrg(tier: Organization['tier']): Organization {
    return {
      id: 'org_x',
      name: 'X',
      slug: 'x',
      createdAt: 0,
      tier,
      subscriptionStatus: 'active',
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    };
  }

  it('records usage and reports running totals', () => {
    const tracker = new UsageTracker({ flush: async () => {} });
    const org = fakeOrg('pro');
    tracker.record(org, 'proj_1');
    tracker.record(org, 'proj_1');
    expect(tracker.check(org).usage).toBe(2);
  });

  it('hard-stops free-tier orgs after their cap', () => {
    const tracker = new UsageTracker({
      flush: async () => {},
      initial: [{ orgId: 'org_x', projectId: 'proj_1', count: 9_999 }],
    });
    const org = fakeOrg('free');
    expect(tracker.record(org, 'proj_1')).toBe(true); // 10_000
    expect(tracker.record(org, 'proj_1')).toBe(false); // 10_001 — denied
  });

  it('does not hard-stop paid tiers above their cap (overage is metered)', () => {
    const tracker = new UsageTracker({
      flush: async () => {},
      initial: [{ orgId: 'org_x', projectId: 'p', count: 1_000_000 }],
    });
    const org = fakeOrg('pro');
    expect(tracker.record(org, 'p')).toBe(true);
  });

  it('flushes batched counts and resets', async () => {
    const flushed: Array<unknown> = [];
    const tracker = new UsageTracker({
      flush: async (entries) => {
        flushed.push(...entries);
      },
    });
    const org = fakeOrg('pro');
    tracker.record(org, 'p');
    tracker.record(org, 'p');
    await tracker.flush();
    expect(flushed).toHaveLength(1);
    expect((flushed[0] as { count: number }).count).toBe(2);
    expect(tracker.check(org).usage).toBe(0);
  });
});

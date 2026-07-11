import {
  createControlPlane,
  InMemoryControlPlaneStore,
  type ControlPlane,
} from '@veritrail/control-plane';
import { describe, expect, it } from 'vitest';

import { buildServer } from '../src/app.js';
import { registerBillingRoutes, type BillingRoutesOptions } from '../src/billing-routes.js';

async function makeServer(
  override: Partial<Omit<BillingRoutesOptions, 'controlPlane'>> = {},
): Promise<{
  app: Awaited<ReturnType<typeof buildServer>>;
  controlPlane: ControlPlane;
}> {
  const store = new InMemoryControlPlaneStore();
  const controlPlane = createControlPlane({ store });
  const app = await buildServer({});
  registerBillingRoutes(app, {
    controlPlane,
    priceIdForTier:
      override.priceIdForTier ?? ((tier) => (tier === 'pro' ? 'price_pro_123' : null)),
    successUrl: override.successUrl ?? 'https://app.example.com/billing/success',
    cancelUrl: override.cancelUrl ?? 'https://app.example.com/billing/cancel',
    ...(override.stripeSecretKey !== undefined
      ? { stripeSecretKey: override.stripeSecretKey }
      : {}),
    ...(override.fetchImpl !== undefined ? { fetchImpl: override.fetchImpl } : {}),
  });
  await app.ready();
  return { app, controlPlane };
}

async function signUp(
  controlPlane: ControlPlane,
  email: string,
): Promise<{ token: string; orgId: string }> {
  const { token: magicToken } = await controlPlane.issueMagicLink({ email });
  const consumed = await controlPlane.consumeMagicLink(magicToken);
  if (!consumed) throw new Error('magic link consume failed');
  const slug = email
    .split('@')[0]!
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-');
  const org = await controlPlane.createOrg({ name: `${email}'s workspace`, slug });
  await controlPlane.addMember({ orgId: org.id, userId: consumed.user.id, role: 'org:owner' });
  return { token: consumed.sessionToken, orgId: org.id };
}

describe('billing-routes: stripe checkout', () => {
  it('returns 401 when the Authorization header is missing', async () => {
    const { app } = await makeServer({ stripeSecretKey: 'sk_test_abc' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/control/billing/checkout',
      payload: { tier: 'pro' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 503 when authenticated but stripeSecretKey is unset', async () => {
    const { app, controlPlane } = await makeServer();
    const { token } = await signUp(controlPlane, 'alice@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/control/billing/checkout',
      headers: { authorization: `Bearer ${token}` },
      payload: { tier: 'pro' },
    });
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('UNSUPPORTED');
  });

  it('forwards the request to Stripe and returns the checkout url', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fakeFetch: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          id: 'cs_test_1',
          url: 'https://checkout.stripe.com/c/pay/cs_test_1',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const { app, controlPlane } = await makeServer({
      stripeSecretKey: 'sk_test_abc',
      fetchImpl: fakeFetch,
    });
    const { token, orgId } = await signUp(controlPlane, 'bob@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/control/billing/checkout',
      headers: { authorization: `Bearer ${token}` },
      payload: { tier: 'pro' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { url: string };
    expect(body.url).toBe('https://checkout.stripe.com/c/pay/cs_test_1');

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('https://api.stripe.com/v1/checkout/sessions');
    const headers = call.init?.headers as Record<string, string>;
    const expectedBasic = Buffer.from('sk_test_abc:').toString('base64');
    expect(headers['authorization']).toBe(`Basic ${expectedBasic}`);
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded');
    const sentBody = call.init?.body as string;
    const params = new URLSearchParams(sentBody);
    expect(params.get('mode')).toBe('subscription');
    expect(params.get('line_items[0][price]')).toBe('price_pro_123');
    expect(params.get('line_items[0][quantity]')).toBe('1');
    expect(params.get('success_url')).toBe('https://app.example.com/billing/success');
    expect(params.get('cancel_url')).toBe('https://app.example.com/billing/cancel');
    expect(params.get('metadata[orgId]')).toBe(orgId);
  });

  it('returns 400 when the tier has no mapped price id', async () => {
    const fakeFetch: typeof fetch = async () => {
      throw new Error('fetch should not be called for invalid tier');
    };
    const { app, controlPlane } = await makeServer({
      stripeSecretKey: 'sk_test_abc',
      fetchImpl: fakeFetch,
    });
    const { token } = await signUp(controlPlane, 'carol@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/control/billing/checkout',
      headers: { authorization: `Bearer ${token}` },
      payload: { tier: 'enterprise' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when tier is missing from the body', async () => {
    const { app, controlPlane } = await makeServer({ stripeSecretKey: 'sk_test_abc' });
    const { token } = await signUp(controlPlane, 'dan@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/control/billing/checkout',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});

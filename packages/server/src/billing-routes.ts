/**
 * Stripe Checkout session creator route.
 *
 * Replaces the 503 stub for POST /api/v1/control/billing/checkout in
 * control-plane-routes.ts. Mounted additively via `registerBillingRoutes` so
 * the parent server module can opt in without touching the existing
 * control-plane route file.
 *
 * The handler is HTTP-thin: it resolves the bearer session via the control
 * plane, picks the user's first org as the customer-of-record, maps the
 * requested tier to a Stripe price id via the injected `priceIdForTier`
 * callback, and calls `POST https://api.stripe.com/v1/checkout/sessions` with
 * HTTP Basic auth on the secret key. The Stripe API expects
 * `application/x-www-form-urlencoded`, so the body is encoded that way
 * (including the bracketed `line_items[0][...]` and `metadata[...]` keys).
 *
 * `fetchImpl` is injected so tests can stub the Stripe response without
 * touching the network.
 */

import type { ControlPlane } from '@veritrail/control-plane';
import type { FastifyInstance } from 'fastify';

import { replyError } from './http.js';
import { validationError } from '@veritrail/core';

/** Fetch shape compatible with the global `fetch`. */
export type BillingFetchImpl = typeof fetch;

/**
 * Resolve an internal tier id to a Stripe price id, or `null` when the tier
 * is not bookable (free tier, unknown tier, deprecated SKU).
 */
export type PriceIdForTier = (tier: string) => string | null;

/** Options for `registerBillingRoutes`. */
export interface BillingRoutesOptions {
  /** Control plane used for session resolution and store reads. */
  readonly controlPlane: ControlPlane;
  /** Stripe secret key (`sk_*`). When absent, the route responds 503. */
  readonly stripeSecretKey?: string;
  /** Maps a tier identifier to a Stripe price id (or `null` for unsupported). */
  readonly priceIdForTier: PriceIdForTier;
  /** URL Stripe redirects to on successful checkout. */
  readonly successUrl: string;
  /** URL Stripe redirects to when the customer cancels. */
  readonly cancelUrl: string;
  /** Injected `fetch` for tests. Defaults to the global. */
  readonly fetchImpl?: BillingFetchImpl;
}

interface StripeCheckoutSessionResponse {
  readonly url?: string;
  readonly id?: string;
}

/**
 * Mount POST /api/v1/control/billing/checkout on the given Fastify app.
 *
 * Call this AFTER `registerControlPlaneRoutes` so this handler wins via
 * Fastify's last-registered-wins lookup for duplicate routes. The main loop
 * is responsible for ordering.
 */
export function registerBillingRoutes(app: FastifyInstance, opts: BillingRoutesOptions): void {
  const { controlPlane, stripeSecretKey, priceIdForTier, successUrl, cancelUrl } = opts;
  const fetchImpl: BillingFetchImpl = opts.fetchImpl ?? fetch;

  app.post('/api/v1/control/billing/checkout', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      return reply.code(401).send({
        error: { name: 'VeritrailError', code: 'VALIDATION', message: 'authentication required' },
      });
    }
    const token = auth.slice('Bearer '.length).trim();
    if (!token) {
      return reply.code(401).send({
        error: { name: 'VeritrailError', code: 'VALIDATION', message: 'authentication required' },
      });
    }
    const session = await controlPlane.resolveSession(token);
    if (!session) {
      return reply.code(401).send({
        error: { name: 'VeritrailError', code: 'VALIDATION', message: 'authentication required' },
      });
    }

    if (!stripeSecretKey) {
      return reply.code(503).send({
        error: { code: 'UNSUPPORTED', message: 'billing disabled' },
      });
    }

    const body = request.body as { tier?: unknown } | undefined;
    const tier = typeof body?.tier === 'string' ? body.tier : '';
    if (!tier) {
      return replyError(reply, validationError('tier is required'));
    }

    const orgs = await controlPlane.store.listOrgsForUser(session.user.id);
    const org = orgs[0];
    if (!org) {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: 'no org for user' },
      });
    }

    const priceId = priceIdForTier(tier);
    if (!priceId) {
      return replyError(reply, validationError(`tier "${tier}" is not bookable`));
    }

    const form = new URLSearchParams();
    form.set('mode', 'subscription');
    form.set('line_items[0][price]', priceId);
    form.set('line_items[0][quantity]', '1');
    form.set('success_url', successUrl);
    form.set('cancel_url', cancelUrl);
    form.set('metadata[orgId]', org.id);

    const basic = Buffer.from(`${stripeSecretKey}:`).toString('base64');
    let response: Response;
    try {
      response = await fetchImpl('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: {
          authorization: `Basic ${basic}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      });
    } catch (cause) {
      request.log.error({ err: cause }, 'stripe checkout request failed');
      return reply.code(502).send({
        error: { code: 'INTERNAL', message: 'stripe request failed' },
      });
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      request.log.error({ status: response.status, detail }, 'stripe checkout non-2xx');
      return reply.code(502).send({
        error: { code: 'INTERNAL', message: `stripe returned ${response.status}` },
      });
    }

    const parsed = (await response.json().catch(() => ({}))) as StripeCheckoutSessionResponse;
    if (!parsed.url) {
      return reply.code(502).send({
        error: { code: 'INTERNAL', message: 'stripe response missing url' },
      });
    }
    return reply.send({ url: parsed.url });
  });
}

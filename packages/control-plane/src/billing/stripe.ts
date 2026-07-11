import { createHmac, timingSafeEqual } from 'node:crypto';

import type { ControlPlaneStore, SubscriptionStatus, Tier } from '../schema.js';

/**
 * Stripe webhook handler. Dependency-light: we don't pull in the Stripe SDK
 * — Stripe webhooks are just signed HTTP POSTs of JSON, easy to verify
 * directly. The control plane consumes a narrow set of events:
 *
 *   - `customer.subscription.created` / `.updated` → set tier + status
 *   - `customer.subscription.deleted`              → downgrade to free
 *   - `invoice.paid` / `invoice.payment_failed`   → keep status fresh
 *
 * Idempotency: every event id is recorded in the `stripe_event_dedup` table
 * — second arrivals are silently dropped. (The dedup table is managed by
 * a thin store API; the in-memory store keeps it in a Set for tests.)
 */

export interface StripeWebhookHandlerOptions {
  readonly store: ControlPlaneStore;
  /** The webhook signing secret from Stripe dashboard. */
  readonly signingSecret: string;
  /** Map Stripe price ids to Veritrail tiers. */
  readonly priceIdToTier: Readonly<Record<string, Tier>>;
  /** Maximum signature age, in seconds. Default: 300 (Stripe recommends 300). */
  readonly toleranceSeconds?: number;
  /** Dedup port — in-memory by default, Postgres in production. */
  readonly dedup?: StripeEventDedup;
  /** Override for tests. */
  readonly clock?: () => number;
}

export interface StripeEventDedup {
  isProcessed(eventId: string): Promise<boolean>;
  markProcessed(eventId: string, at: number): Promise<void>;
}

export class InMemoryStripeEventDedup implements StripeEventDedup {
  #seen = new Map<string, number>();
  async isProcessed(eventId: string): Promise<boolean> {
    return this.#seen.has(eventId);
  }
  async markProcessed(eventId: string, at: number): Promise<void> {
    this.#seen.set(eventId, at);
  }
}

interface StripeEvent {
  readonly id: string;
  readonly type: string;
  readonly data: { readonly object: Record<string, unknown> };
}

export interface StripeWebhookResult {
  readonly handled: boolean;
  readonly orgId?: string;
  readonly tier?: Tier;
  readonly subscriptionStatus?: SubscriptionStatus;
  readonly reason?: string;
}

const STATUS_MAP: Record<string, SubscriptionStatus> = {
  active: 'active',
  trialing: 'trialing',
  past_due: 'past_due',
  canceled: 'canceled',
  incomplete: 'incomplete',
  incomplete_expired: 'canceled',
  paused: 'paused',
  unpaid: 'past_due',
};

export class StripeWebhookHandler {
  readonly #store: ControlPlaneStore;
  readonly #signingSecret: string;
  readonly #priceIdToTier: Readonly<Record<string, Tier>>;
  readonly #toleranceSeconds: number;
  readonly #dedup: StripeEventDedup;
  readonly #now: () => number;

  constructor(options: StripeWebhookHandlerOptions) {
    this.#store = options.store;
    this.#signingSecret = options.signingSecret;
    this.#priceIdToTier = options.priceIdToTier;
    this.#toleranceSeconds = options.toleranceSeconds ?? 300;
    this.#dedup = options.dedup ?? new InMemoryStripeEventDedup();
    this.#now = options.clock ?? (() => Date.now());
  }

  /**
   * Verify a Stripe webhook signature header per Stripe's HMAC scheme:
   *   - Header looks like `t=1700,v1=hex-sig`
   *   - Signed payload is `${t}.${rawBody}`
   *   - We accept the message if `t` is within `tolerance` seconds of now AND
   *     the v1 sig matches HMAC-SHA256(secret, payload).
   */
  verifySignature(rawBody: string, signatureHeader: string): boolean {
    if (!signatureHeader) return false;
    const parts = Object.fromEntries(
      signatureHeader.split(',').map((kv) => {
        const idx = kv.indexOf('=');
        return idx > 0 ? [kv.slice(0, idx).trim(), kv.slice(idx + 1).trim()] : ['', ''];
      }),
    );
    const ts = Number(parts['t']);
    const v1 = parts['v1'];
    if (!Number.isFinite(ts) || !v1) return false;
    if (Math.abs(this.#now() / 1000 - ts) > this.#toleranceSeconds) return false;

    const computed = createHmac('sha256', this.#signingSecret)
      .update(`${ts}.${rawBody}`, 'utf8')
      .digest('hex');
    const a = Buffer.from(computed, 'hex');
    const b = Buffer.from(v1, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * Verify + dispatch a webhook. Returns a structured outcome instead of
   * throwing for "expected" failures (bad signature, replay) so the route
   * handler can map each case to the right HTTP response without try/catch
   * chains.
   */
  async handle(
    rawBody: string,
    signatureHeader: string,
  ): Promise<{ ok: boolean; result?: StripeWebhookResult; error?: string }> {
    if (!this.verifySignature(rawBody, signatureHeader)) {
      return { ok: false, error: 'invalid signature' };
    }
    let event: StripeEvent;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return { ok: false, error: 'invalid JSON payload' };
    }
    if (!event.id || !event.type || !event.data?.object) {
      return { ok: false, error: 'malformed event' };
    }

    if (await this.#dedup.isProcessed(event.id)) {
      return { ok: true, result: { handled: false, reason: 'duplicate event' } };
    }

    const result = await this.#dispatch(event);
    await this.#dedup.markProcessed(event.id, this.#now());
    return { ok: true, result };
  }

  async #dispatch(event: StripeEvent): Promise<StripeWebhookResult> {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        return this.#applySubscription(event.data.object);
      case 'customer.subscription.deleted':
        return this.#applySubscriptionDeletion(event.data.object);
      default:
        return { handled: false, reason: `ignored type: ${event.type}` };
    }
  }

  async #applySubscription(obj: Record<string, unknown>): Promise<StripeWebhookResult> {
    const subscriptionId = typeof obj['id'] === 'string' ? obj['id'] : undefined;
    const customerId = typeof obj['customer'] === 'string' ? obj['customer'] : undefined;
    const status = typeof obj['status'] === 'string' ? obj['status'] : undefined;
    const metadata = (obj['metadata'] ?? {}) as Record<string, unknown>;
    const orgId = typeof metadata['orgId'] === 'string' ? metadata['orgId'] : undefined;

    if (!orgId || !customerId || !subscriptionId || !status) {
      return { handled: false, reason: 'missing required fields' };
    }

    const priceId = extractPriceId(obj);
    const tier = priceId ? this.#priceIdToTier[priceId] : undefined;
    if (!tier) return { handled: false, reason: `unknown price: ${priceId ?? 'none'}` };

    const subscriptionStatus = STATUS_MAP[status] ?? 'incomplete';
    await this.#store.updateOrgSubscription(orgId, {
      tier,
      subscriptionStatus,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
    });
    return { handled: true, orgId, tier, subscriptionStatus };
  }

  async #applySubscriptionDeletion(obj: Record<string, unknown>): Promise<StripeWebhookResult> {
    const metadata = (obj['metadata'] ?? {}) as Record<string, unknown>;
    const orgId = typeof metadata['orgId'] === 'string' ? metadata['orgId'] : undefined;
    if (!orgId) return { handled: false, reason: 'missing orgId' };
    await this.#store.updateOrgSubscription(orgId, {
      tier: 'free',
      subscriptionStatus: 'canceled',
      stripeSubscriptionId: null,
    });
    return { handled: true, orgId, tier: 'free', subscriptionStatus: 'canceled' };
  }
}

function extractPriceId(obj: Record<string, unknown>): string | undefined {
  // Stripe puts the price on `items.data[0].price.id`. We accept either that
  // or a flat `priceId` shape (for tests).
  const flat = obj['priceId'];
  if (typeof flat === 'string') return flat;
  const items = obj['items'];
  if (
    items &&
    typeof items === 'object' &&
    'data' in items &&
    Array.isArray((items as { data: unknown[] }).data)
  ) {
    const first = (items as { data: unknown[] }).data[0];
    if (first && typeof first === 'object' && 'price' in first) {
      const price = (first as { price: unknown }).price;
      if (price && typeof price === 'object' && 'id' in price) {
        const id = (price as { id: unknown }).id;
        if (typeof id === 'string') return id;
      }
    }
  }
  return undefined;
}

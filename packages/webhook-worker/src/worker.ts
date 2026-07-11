import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { nextAttemptDelay } from './retry.js';
import { signPayload } from './signing.js';
import type { OutboxStore, WebhookEntry } from './outbox.js';

export interface WebhookWorkerOptions {
  readonly store: OutboxStore;
  readonly fetchImpl?: typeof fetch;
  readonly clock?: () => number;
  /** Max entries pulled per poll. Default 50. */
  readonly batchSize?: number;
  /** Hard cap on retries. Default 16 (~24h with the default backoff). */
  readonly maxAttempts?: number;
  /** Poll interval. Default 5000ms. */
  readonly pollIntervalMs?: number;
  /** Per-request timeout. Default 10s. */
  readonly requestTimeoutMs?: number;
  /** DNS resolver override for tests. */
  readonly lookupHostname?: typeof lookup;
}

/**
 * Long-running delivery worker. Spin up one per process; for HA, run several
 * — the outbox store handles row-level claim semantics in production (the
 * in-memory store doesn't, since it's only for tests).
 */
export class WebhookWorker {
  readonly #store: OutboxStore;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #batchSize: number;
  readonly #maxAttempts: number;
  readonly #pollIntervalMs: number;
  readonly #requestTimeoutMs: number;
  readonly #lookupHostname: typeof lookup;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: WebhookWorkerOptions) {
    this.#store = options.store;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#now = options.clock ?? (() => Date.now());
    this.#batchSize = options.batchSize ?? 50;
    this.#maxAttempts = options.maxAttempts ?? 16;
    this.#pollIntervalMs = options.pollIntervalMs ?? 5000;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.#lookupHostname = options.lookupHostname ?? lookup;
  }

  start(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => {
      void this.processBatch();
    }, this.#pollIntervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  async processBatch(): Promise<{ delivered: number; retried: number; failed: number }> {
    const now = this.#now();
    const entries = await this.#store.fetchDue(now, this.#batchSize);
    let delivered = 0;
    let retried = 0;
    let failed = 0;
    await Promise.all(
      entries.map(async (entry) => {
        const outcome = await this.#deliver(entry);
        if (outcome === 'delivered') delivered += 1;
        else if (outcome === 'retried') retried += 1;
        else failed += 1;
      }),
    );
    return { delivered, retried, failed };
  }

  async #deliver(entry: WebhookEntry): Promise<'delivered' | 'retried' | 'failed'> {
    const body = JSON.stringify(entry.payload);
    const { header } = signPayload(entry.secret, body, this.#now());
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#requestTimeoutMs);

    let status = 0;
    let networkError: string | null = null;
    try {
      await assertPublicWebhookDestination(entry.url, this.#lookupHostname);
      const response = await this.#fetch(entry.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-veritrail-signature': header,
          'x-veritrail-event-type': entry.eventType,
        },
        body,
        signal: controller.signal,
        redirect: 'manual',
      });
      status = response.status;
      // Drain the body so the underlying connection can be reused.
      await response.text();
    } catch (err) {
      networkError = err instanceof Error ? err.message : 'unknown network error';
    } finally {
      clearTimeout(timeout);
    }

    const nextAttempts = entry.attempts + 1;
    const now = this.#now();

    if (status >= 200 && status < 300) {
      await this.#store.markDelivered(entry.id, now);
      return 'delivered';
    }
    if (status >= 400 && status < 500) {
      // 4xx: subscriber rejected the payload; never retry.
      await this.#store.markFailed(entry.id, now, `HTTP ${status}`);
      return 'failed';
    }
    if (nextAttempts >= this.#maxAttempts) {
      await this.#store.markFailed(
        entry.id,
        now,
        networkError ?? `HTTP ${status} after ${nextAttempts} attempts`,
      );
      return 'failed';
    }
    const delay = nextAttemptDelay(nextAttempts);
    await this.#store.markRetry(
      entry.id,
      now,
      now + delay,
      nextAttempts,
      networkError ?? `HTTP ${status}`,
    );
    return 'retried';
  }
}

async function assertPublicWebhookDestination(
  rawUrl: string,
  resolver: typeof lookup,
): Promise<void> {
  const url = new URL(rawUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('webhook URL must use http or https');
  if (url.username || url.password) throw new Error('webhook URL credentials are forbidden');
  const hostname = url.hostname.replace('[', '').replace(']', '').toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  )
    throw new Error('webhook URL resolves to a private host');
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await resolver(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicIp(address)))
    throw new Error('webhook URL resolves to a private or reserved address');
}

function isPublicIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number) as [number, number, number];
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  if (family !== 6) return false;
  const lower = address.toLowerCase();
  if (lower.startsWith('::ffff:')) return isPublicIp(lower.slice(7));
  const third = lower.charAt(2);
  return !(
    lower === '::' ||
    lower === '::1' ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    (lower.startsWith('fe') && '89ab'.includes(third)) ||
    lower.startsWith('ff') ||
    lower === '2001:db8::' ||
    lower.startsWith('2001:db8:')
  );
}
